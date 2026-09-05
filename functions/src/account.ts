import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE,
  ACCOUNT_NAME_MESSAGE, ACCOUNT_CITY_MESSAGE,
  type TicketDoc, type EventDoc, type TicketTransferDoc, type TicketOrderDoc, type InviteDoc,
  type UpdateAccountInput, type UpdateAccountResult,
} from "@gatekeep/shared";
import { writeAudit } from "./review.js";
import { reassignShareOnRemoval } from "./payoutShares.js";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { getGeocoder, coarsen, consumeGeocodeBudget, geocoderApiKey } from "./geocode.js";

// Consumes membership invariants (Task 8: never-zero-admins per profile) and
// the users/{uid} tree created by onUserCreated (Task 5).
//
// Known limitation (v1, accepted per task dispatch): the sole-admin check
// below is a plain read, not transactional like removeMember's (Task 8).
// Account deletion is a rare, user-initiated action, so a race between two
// concurrent deletions/removals is an acceptable risk for now rather than a
// reason to add transactional complexity here.

// SP10 Task 13 (spec section 5.3, cross #2): nothing is unwound by
// deletion. Tickets, then transfers, then orders, each with its own
// client-keyed message. The transfer and order scans filter status in
// memory off a single-field query: both are bounded by one user's own
// history, and neither has a (uid, status) composite today.
//
// Branch audit (MEDIUM): the same three questions asked WITHOUT throwing, so
// the onUserDeleted trigger can report what a client-side deletion bypassed.
// Firebase has no blocking delete trigger, so `currentUser.delete()` and the
// console cannot be refused; the alert this feeds is the backstop until the
// "Delete account" user action is disabled in the Identity Platform console
// (README "Manual follow-ups"). Every reason is a caller-facing message
// constant, so the alert detail and the callable's refusal say the same thing.
// Order is load-bearing: assertNothingOutstanding throws the FIRST reason, and
// the callable's own behavior (tickets before transfers before orders) is
// unchanged by this refactor.
export async function listOutstandingObligations(
  db: FirebaseFirestore.Firestore, uid: string, now: number,
): Promise<string[]> {
  const reasons: string[] = [];

  const tickets = await db.collection(`users/${uid}/tickets`).where("status", "in", ["valid", "checked_in"]).get();
  const eventIds = [...new Set(tickets.docs.map((d) => (d.data() as TicketDoc).eventId))];
  for (const eventId of eventIds) {
    const event = (await db.doc(`events/${eventId}`).get()).data() as EventDoc | undefined;
    if (event && event.endsAt > now) { reasons.push(DELETE_ACCOUNT_TICKETS_MESSAGE); break; }
  }

  const [fromSnap, toSnap] = await Promise.all([
    db.collection("transfers").where("fromUid", "==", uid).get(),
    db.collection("transfers").where("toUid", "==", uid).get(),
  ]);
  const offered = [...fromSnap.docs, ...toSnap.docs].some((d) => (d.data() as TicketTransferDoc).status === "offered");
  if (offered) reasons.push(DELETE_ACCOUNT_TRANSFERS_MESSAGE);

  const orders = await db.collection("orders").where("buyerUid", "==", uid).get();
  if (orders.docs.some((d) => (d.data() as TicketOrderDoc).status === "pending")) {
    reasons.push(DELETE_ACCOUNT_ORDERS_MESSAGE);
  }
  return reasons;
}

async function assertNothingOutstanding(db: FirebaseFirestore.Firestore, uid: string, now: number): Promise<void> {
  const reasons = await listOutstandingObligations(db, uid, now);
  if (reasons.length > 0) throw new HttpsError("failed-precondition", reasons[0]);
}

const RETRY_SAFE_MESSAGE = "Account deletion did not complete. It is safe to try again.";

export class CascadePhaseError extends Error {
  readonly phase: string;
  constructor(phase: string) {
    super(`cascadeDeleteUser phase failed: ${phase}`);
    this.phase = phase;
  }
}

async function runPhase(uid: string, phase: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error("cascadeDeleteUser phase failed", { uid, phase }, e);
    throw new CascadePhaseError(phase);
  }
}

// SP10 Task 14 (spec section 5.4, cross #3): everything the account
// callable used to do between its guards and the auth deletion, shared with
// the onUserDeleted trigger so a console or Admin SDK deletion cascades
// identically. Idempotent per phase (re-deleting a deleted doc is a no-op),
// which also makes the trigger's second pass after deleteAccount harmless.
// The sole-admin case is a refusal for the callable and a REPORTED fact for
// the trigger (returned, not logged here): the auth user is already gone by
// the time onDelete runs, so there is nothing left to refuse, and the trigger
// folds it into the one account_deleted_unclean alert an operator will read.
export async function cascadeDeleteUser(
  uid: string, opts: { allowSoleAdmin: boolean },
): Promise<{ soleAdminOf: string[] }> {
  const db = getFirestore();
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0 && !opts.allowSoleAdmin) {
    throw new HttpsError("failed-precondition",
      `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
  }
  // Branch audit (MEDIUM): the allowSoleAdmin case is reported to the CALLER
  // (onUserDeleted) rather than logged here, so the one place that can raise
  // an admin alert about an unclean deletion sees this fact alongside the
  // obligations it gathered before the cascade. A console line alone was not
  // an escalation anybody would ever read.

  // S5: curatorAccess/{uid} first, so a stale marker never outlives the account.
  await runPhase(uid, "curatorAccess", () => Promise.all([
    db.doc(`curatorAccess/${uid}`).delete(),
    db.doc(`curatorAccessRetries/${uid}`).delete(),
  ]));
  // SP5c fix wave (I5): a membership carries a PAYOUT SHARE, and deleting the
  // doc without reassigning it leaves the profile's shares summing to less
  // than 100, which `validatePayoutShares` then refuses on the admins' next
  // save and which `splitCents` would silently under-distribute in the
  // meantime. `removeMember` already moves a leaving member's percent to the
  // band fund and tells the admins; deletion has to do the same. Best-effort
  // per profile: a share that cannot be reassigned must never block the
  // deletion of an account, and it leaves a shares editor an admin can fix.
  // Held shares are deliberately untouched, they are already that person's
  // money and release (or void) on their own paths.
  await runPhase(uid, "memberships", async () => {
    const now = Date.now();
    for (const m of memberships.docs) {
      const profileId = m.ref.parent.parent!.id;
      await reassignShareOnRemoval(db, profileId, uid, now)
        .catch((e) => console.error("cascadeDeleteUser: share reassignment failed", { uid, profileId }, e));
    }
    await Promise.all(memberships.docs.map((m) => m.ref.delete()));
  });
  // Pending invites naming the uid are revoked (sp1 #10 e). Single-field
  // query plus an in-memory status filter, same shape as helpers.ts's
  // fetchPendingInviteId; bounded by MAX_PENDING_INVITES_PER_PROFILE per profile.
  await runPhase(uid, "invites", async () => {
    const snap = await db.collection("invites").where("invitedUid", "==", uid).get();
    const batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      if ((d.data() as InviteDoc).status !== "pending") continue;
      batch.update(d.ref, { status: "revoked" });
      n++;
    }
    if (n > 0) await batch.commit();
  });
  // Offered transfers naming the uid on either side are voided (sp1 #10 f),
  // inventory untouched: the ticket itself never moved for an offer.
  await runPhase(uid, "transfers", async () => {
    const [fromSnap, toSnap] = await Promise.all([
      db.collection("transfers").where("fromUid", "==", uid).get(),
      db.collection("transfers").where("toUid", "==", uid).get(),
    ]);
    const now = Date.now();
    const batch = db.batch();
    let n = 0;
    for (const d of [...fromSnap.docs, ...toSnap.docs]) {
      if ((d.data() as TicketTransferDoc).status !== "offered") continue;
      batch.update(d.ref, { status: "voided", resolvedAt: now });
      n++;
    }
    if (n > 0) await batch.commit();
  });
  await runPhase(uid, "firestore", () => db.recursiveDelete(db.doc(`users/${uid}`)));
  return { soleAdminOf };
}

export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();
  await assertNothingOutstanding(db, uid, Date.now());
  try {
    await cascadeDeleteUser(uid, { allowSoleAdmin: false });
  } catch (e) {
    if (e instanceof HttpsError) throw e; // the sole-admin refusal
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "auth" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  await writeAudit({ actorUid: uid, action: "account_deleted", targetId: uid, detail: "self-service deleteAccount" });
  return { ok: true };
});

// SP11 (spec section 5): the ONLY writer of users/{uid}.displayName,
// .homeCity, and .homeGeo. firestore.rules dropped all three from the
// owner's own update set in the same sub-project, so a client cannot set a
// city without the coarse point that ranks its Discover feed, and cannot set
// a point at all.
//
// displayName is stamped as given (after trim); displayNameLower is left to
// the onUserDocWritten trigger, which is already the single writer of that
// projection. Existing tickets and attendee rows keep the name they
// snapshotted; nothing is backfilled (spec section 3.3), and the account
// editors on both clients say so in their helper copy.
//
// The geocode is charged to consumeGeocodeBudget BEFORE the provider call,
// the same order every other address-resolving callable uses, and only when
// a non-empty city is actually being resolved: a name-only save and a clear
// never touch the budget. A geocoder MISS is not an error: the city text is
// what the fan typed and is worth keeping on screen, so it is stored with
// homeGeo null and reported as { geocoded: false } so the client can say
// ACCOUNT_GEOCODE_MISS_MESSAGE.
export const updateAccount = onCall<UpdateAccountInput>(
  { region: "us-central1", secrets: [geocoderApiKey] }, async (req): Promise<UpdateAccountResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = (req.data ?? {}) as UpdateAccountInput;
    const updates: Record<string, unknown> = {};

    if (input.displayName !== undefined) {
      if (typeof input.displayName !== "string") throw new HttpsError("invalid-argument", ACCOUNT_NAME_MESSAGE);
      const name = input.displayName.trim();
      if (name.length < 1 || name.length > 80) throw new HttpsError("invalid-argument", ACCOUNT_NAME_MESSAGE);
      updates.displayName = name;
    }

    let geocoded: boolean | null = null;
    if (input.homeCity !== undefined) {
      if (input.homeCity !== null && typeof input.homeCity !== "string") {
        throw new HttpsError("invalid-argument", ACCOUNT_CITY_MESSAGE);
      }
      const city = (input.homeCity ?? "").trim();
      if (city.length > 80) throw new HttpsError("invalid-argument", ACCOUNT_CITY_MESSAGE);
      if (city.length === 0) {
        updates.homeCity = null;
        updates.homeGeo = null;
      } else {
        await consumeGeocodeBudget(uid);
        let point: { lat: number; lng: number } | null = null;
        try {
          const hit = await getGeocoder().geocode(city);
          if (hit) point = coarsen(hit);
        } catch (e) {
          // getGeocoder() throws an HttpsError when no provider is configured
          // at all: an operator misconfiguration, not a geocoder miss, so it
          // escapes as itself rather than being reported as { geocoded: false }.
          if (e instanceof HttpsError) throw e;
          // A provider outage must not lose the fan's typed city. Same
          // posture as the miss below: store the text, no point.
          console.error("updateAccount: geocode failed", { uid }, e);
        }
        updates.homeCity = city;
        updates.homeGeo = point;
        geocoded = point !== null;
      }
    }

    if (Object.keys(updates).length === 0) return { ok: true, geocoded: null };
    await getFirestore().doc(`users/${uid}`).update(updates);
    return { ok: true, geocoded };
  });

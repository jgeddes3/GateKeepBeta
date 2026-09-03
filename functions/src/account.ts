import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE,
  type TicketDoc, type EventDoc, type TicketTransferDoc, type TicketOrderDoc, type InviteDoc,
} from "@gatekeep/shared";
import { writeAudit } from "./review.js";

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
async function assertNothingOutstanding(db: FirebaseFirestore.Firestore, uid: string, now: number): Promise<void> {
  const tickets = await db.collection(`users/${uid}/tickets`).where("status", "in", ["valid", "checked_in"]).get();
  const eventIds = [...new Set(tickets.docs.map((d) => (d.data() as TicketDoc).eventId))];
  for (const eventId of eventIds) {
    const event = (await db.doc(`events/${eventId}`).get()).data() as EventDoc | undefined;
    if (event && event.endsAt > now) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TICKETS_MESSAGE);
  }

  const [fromSnap, toSnap] = await Promise.all([
    db.collection("transfers").where("fromUid", "==", uid).get(),
    db.collection("transfers").where("toUid", "==", uid).get(),
  ]);
  const offered = [...fromSnap.docs, ...toSnap.docs].some((d) => (d.data() as TicketTransferDoc).status === "offered");
  if (offered) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TRANSFERS_MESSAGE);

  const orders = await db.collection("orders").where("buyerUid", "==", uid).get();
  if (orders.docs.some((d) => (d.data() as TicketOrderDoc).status === "pending")) {
    throw new HttpsError("failed-precondition", DELETE_ACCOUNT_ORDERS_MESSAGE);
  }
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
// The sole-admin case is a refusal for the callable and a logged fact for
// the trigger: the auth user is already gone by the time onDelete runs.
export async function cascadeDeleteUser(uid: string, opts: { allowSoleAdmin: boolean }): Promise<void> {
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
  if (soleAdminOf.length > 0) {
    if (!opts.allowSoleAdmin) {
      throw new HttpsError("failed-precondition",
        `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
    }
    console.error("cascadeDeleteUser: removing the sole admin; these profiles now have no admin", { uid, soleAdminOf });
  }

  // S5: curatorAccess/{uid} first, so a stale marker never outlives the account.
  await runPhase(uid, "curatorAccess", () => Promise.all([
    db.doc(`curatorAccess/${uid}`).delete(),
    db.doc(`curatorAccessRetries/${uid}`).delete(),
  ]));
  await runPhase(uid, "memberships", () => Promise.all(memberships.docs.map((m) => m.ref.delete())));
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

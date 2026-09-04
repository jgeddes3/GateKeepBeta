import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createHash } from "node:crypto";
import {
  isValidDocId, validatePayoutShares, SHARES_ADMIN_MESSAGE,
  splitCents, payeeKey, shareHeldMessage, formatShareCents,
  type PayoutShare, type StripeProfileDoc,
  type HeldShareDoc, type HeldShareRef, type PayoutPayee, type MemberStripeDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { notifyProfileAdmins, notifyUser } from "./notifications.js";
import { getStripe } from "./stripeClient.js";
import { writeLedger, recordAdminAlert } from "./paymentsCore.js";
import { getMemberStripeDoc, setReleaseHeldSharesHook } from "./memberPayouts.js";

export async function loadShares(db: Firestore, profileId: string): Promise<PayoutShare[] | null> {
  const snap = await db.doc(`profiles/${profileId}/private/stripe`).get();
  const shares = (snap.data() as StripeProfileDoc | undefined)?.shares;
  return shares && shares.length > 0 ? shares : null;
}

async function memberUids(db: Firestore, profileId: string): Promise<Set<string>> {
  const snap = await db.collection(`profiles/${profileId}/members`).get();
  return new Set(snap.docs.map((d) => d.id));
}

// The explicit member read below (not requireProfileAdmin) is what gives an
// admin-only failure the shares-specific SHARES_ADMIN_MESSAGE.
export const setPayoutShares = onCall<{ profileId: string; shares: PayoutShare[] | null }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, shares } = req.data ?? ({} as { profileId: string; shares: null });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    const db = getFirestore();
    const member = await db.doc(`profiles/${profileId}/members/${uid}`).get();
    if (!member.exists || member.data()?.role !== "admin") throw new HttpsError("permission-denied", SHARES_ADMIN_MESSAGE);
    const ref = db.doc(`profiles/${profileId}/private/stripe`);
    if (shares === null) {
      await ref.set({ shares: null, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
      return { ok: true };
    }
    const v = validatePayoutShares(shares, await memberUids(db, profileId));
    if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
    await ref.set({ shares: v.shares, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    return { ok: true };
  });

// removeMember calls this after its transaction: the leaving member's percent
// joins the band fund so the shares still sum to 100.
export async function reassignShareOnRemoval(db: Firestore, profileId: string, uid: string, now: number): Promise<void> {
  const shares = await loadShares(db, profileId);
  if (!shares) return;
  const leaving = shares.find((s) => s.payee.kind === "member" && s.payee.uid === uid);
  if (!leaving) return;
  const rest = shares.filter((s) => s !== leaving);
  const fund = rest.find((s) => s.payee.kind === "profile");
  const next: PayoutShare[] = fund
    ? rest.map((s) => (s === fund ? { payee: s.payee, percent: s.percent + leaving.percent } : s))
    : [...rest, { payee: { kind: "profile" }, percent: leaving.percent }];
  await db.doc(`profiles/${profileId}/private/stripe`).set({ shares: next, sharesUpdatedAt: now, updatedAt: now }, { merge: true });
  try {
    await notifyProfileAdmins(profileId, {
      kind: "system", title: "Payout shares changed",
      body: `A member left, so their ${leaving.percent}% share now goes to the band fund. Review the shares if that is not what you want.`,
    });
  } catch (e) {
    console.error(`reassignShareOnRemoval: notification failed for ${profileId}`, e);
  }
}

// ---------- Task 5: the split-at-settlement engine, held shares, and release ----------

export interface DistributeInput {
  profileId: string; amountCents: number;
  source: { chargeId: string; remainingCents: number } | null;
  purpose: "earnings" | "ticket_settlement";
  ref: HeldShareRef;
  idempotencyBase: string;
  meta: Record<string, string>;
  profileAccountId: string;
  now: number;
}
export interface DistributeLeg { payee: PayoutPayee; amountCents: number; outcome: "transferred" | "held"; transferId: string | null; sourced: boolean }
// SP5c fix round 1: `transferId` prefers the PROFILE leg's transfer id (a
// clawback reverses the profile's own account, never a member's), falling
// back to the first transferred leg only when there is no profile leg to
// point at. `profileCents` is what actually reached the profile's account,
// the amount a clawback may reverse.
export interface DistributeResult { legs: DistributeLeg[]; transferId: string | null; sourcedAny: boolean; heldCents: number; profileCents: number }

function refFields(ref: HeldShareRef) {
  return "bookingId" in ref
    ? { bookingId: ref.bookingId, gigId: ref.gigId, eventId: null, orderId: null }
    : { bookingId: null, gigId: null, eventId: ref.eventId, orderId: ref.orderId };
}

// The one place SP5c money crosses from "profile got paid" to "who inside
// that profile actually gets it". Called by Task 6 (booking settlement) and
// Task 7 (ticket settlement) once the platform-side charge is settled, this
// only moves the RECIPIENT-side money: no shares configured, the whole
// amount goes to the profile's own account (today's pre-SP5c behavior,
// unchanged); shares configured, splitCents divides amountCents (remainder
// to the largest share, never lost), each member leg transfers to that
// member's OWN connected account when it is transfer-ready, or is written to
// heldShares (and the member notified) when it is not.
//
// IDEMPOTENT PER (idempotencyBase, leg): every Stripe call below carries a
// key derived from idempotencyBase, so calling this twice with the same base
// (a settlement retry, a webhook redelivery) replays the same transfers
// rather than moving money twice, and the heldShares doc id
// (`{idempotencyBase}:{uid}`) makes the held branch equally idempotent, a
// second call's .create() hits ALREADY_EXISTS (gRPC 6) and is swallowed.
export async function distributeEarnings(input: DistributeInput): Promise<DistributeResult> {
  // Fix round 1 (Minor 2): a profile-kind leg (the whole amount when there
  // are no shares, or the band-fund share when there are) always resolves
  // `accountId = input.profileAccountId` with no further check, an empty
  // string would otherwise fall into the held branch below and write a
  // nonsensical `heldShares/{base}:undefined` (the held branch's `uid` comes
  // from a member payee, not a profile one). Fail loudly up front instead.
  if (!input.profileAccountId) throw new Error("distributeEarnings: profileAccountId is required");
  const db = getFirestore();
  const stripe = getStripe();
  const shares = await loadShares(db, input.profileId);
  const fits = (cents: number, remaining: number) => input.source !== null && cents <= remaining;
  if (!shares) {
    const sourced = fits(input.amountCents, input.source?.remainingCents ?? 0);
    const t = await stripe.transferToAccount({
      accountId: input.profileAccountId, amountCents: input.amountCents, idempotencyKey: input.idempotencyBase, meta: input.meta,
      ...(sourced ? { sourceChargeId: input.source!.chargeId } : {}),
    });
    return { legs: [{ payee: { kind: "profile" }, amountCents: input.amountCents, outcome: "transferred", transferId: t.id, sourced }], transferId: t.id, sourcedAny: sourced, heldCents: 0, profileCents: input.amountCents };
  }
  const profileName = ((await db.doc(`profiles/${input.profileId}`).get()).data() as ProfileDoc | undefined)?.name ?? "your band";
  let remaining = input.source?.remainingCents ?? 0;
  const legs: DistributeLeg[] = [];
  let heldCents = 0;
  for (const part of splitCents(input.amountCents, shares)) {
    if (part.amountCents <= 0) continue;
    const key = `${input.idempotencyBase}:share:${payeeKey(part.payee)}`;
    let accountId: string | null = null;
    if (part.payee.kind === "profile") accountId = input.profileAccountId;
    else {
      const ms: MemberStripeDoc | null = await getMemberStripeDoc(part.payee.uid);
      accountId = ms?.accountId && ms.transfersEnabled ? ms.accountId : null;
    }
    if (!accountId) {
      // Reachable only for a member payee: a profile-kind leg's accountId is
      // input.profileAccountId, guarded non-empty above, so it never falls
      // into this branch.
      if (part.payee.kind !== "member") throw new Error(`distributeEarnings: unexpected held leg for ${payeeKey(part.payee)}`);
      const uid = part.payee.uid;
      const heldRef = db.doc(`heldShares/${input.idempotencyBase}:${uid}`);
      const held: HeldShareDoc = { profileId: input.profileId, uid, amountCents: part.amountCents, purpose: input.purpose, ref: input.ref, status: "held", createdAt: input.now, releasedAt: null, transferId: null };
      try { await heldRef.create(held); }
      catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
      // stripeId is the heldShares doc's own id (there is no Stripe object for
      // a held share), deterministic per (idempotencyBase, uid) exactly like
      // writeLedger's `late_fee` convention (paymentsCore.ts's doc comment):
      // a share_held row must dedupe the same way the heldShares doc itself
      // does, or a replayed distributeEarnings call (this same base, called
      // again before the member's account is enabled) would double the row.
      await writeLedger({ kind: "share_held", amountCents: part.amountCents, profileId: input.profileId, uid, stripeId: heldRef.id, ...refFields(input.ref), detail: `share held for ${uid} until their payouts are set up`, at: input.now })
        .catch((e) => console.error(`distributeEarnings: share_held ledger row failed for ${key}`, e));
      await notifyUser(uid, { kind: "share_held", refKind: "payouts", title: "Money is waiting for you", body: shareHeldMessage(part.amountCents, profileName) }, `share_held:${key}`)
        .catch((e) => console.error(`distributeEarnings: share_held notification failed for ${key}`, e));
      legs.push({ payee: part.payee, amountCents: part.amountCents, outcome: "held", transferId: null, sourced: false });
      heldCents += part.amountCents;
      continue;
    }
    const sourced = fits(part.amountCents, remaining);
    const t = await stripe.transferToAccount({
      accountId, amountCents: part.amountCents, idempotencyKey: key, meta: { ...input.meta, payee: payeeKey(part.payee) },
      ...(sourced ? { sourceChargeId: input.source!.chargeId } : {}),
    });
    if (sourced) remaining -= part.amountCents;
    const uid = part.payee.kind === "member" ? part.payee.uid : null;
    await writeLedger({ kind: "share_transfer", amountCents: part.amountCents, profileId: input.profileId, uid, stripeId: t.id, sourced, ...refFields(input.ref), detail: `${payeeKey(part.payee)} share of ${input.purpose}${sourced ? ", sourced from the charge" : ", drawn on the platform balance"}`, at: input.now })
      .catch((e) => console.error(`distributeEarnings: share_transfer ledger row failed for ${key}`, e));
    if (uid) {
      await notifyUser(uid, { kind: "share_paid", refKind: "payouts", title: "You were paid", body: `${formatShareCents(part.amountCents)} from ${profileName}.` }, `share_paid:${key}`)
        .catch((e) => console.error(`distributeEarnings: share_paid notification failed for ${key}`, e));
    }
    legs.push({ payee: part.payee, amountCents: part.amountCents, outcome: "transferred", transferId: t.id, sourced });
  }
  const profileCents = legs.filter((l) => l.payee.kind === "profile").reduce((s, l) => s + l.amountCents, 0);
  return {
    legs,
    // Fix round 1 (Critical): the PROFILE leg's transfer id, never a
    // member's, a no-show clawback reverses this exact transfer and must
    // never reach into a member's own account. Falls back to the first
    // transferred leg only when there is no profile leg (or its own
    // transfer failed to land here, unreachable in practice: a profile-kind
    // leg always resolves an accountId and transfers).
    transferId: legs.find((l) => l.payee.kind === "profile" && l.transferId)?.transferId
      ?? legs.find((l) => l.transferId)?.transferId ?? null,
    sourcedAny: legs.some((l) => l.sourced), heldCents, profileCents,
  };
}

// Fix round 2: how long a transactional release claim (below) is honored
// before a later caller is allowed to retry the same doc, protects against a
// crash between the claim write and the terminal status write, not against
// the ordinary double-caller race (that race is closed by the claim itself).
const RELEASE_CLAIM_STALE_MS = 10 * 60 * 1000;

// Transfers every held (or previously failed) share of a user once their
// account can receive transfers. Unsourced by then: the charge is long gone.
export async function releaseHeldShares(uid: string, now: number): Promise<number> {
  const db = getFirestore();
  const ms = await getMemberStripeDoc(uid);
  if (!ms?.accountId || !ms.transfersEnabled) return 0;
  const snap = await db.collection("heldShares").where("uid", "==", uid).where("status", "in", ["held", "failed"]).get();
  let releasedCents = 0;
  // Fix round 1 (Important 1): the doc ids this RUN actually released, not a
  // timestamp. Two independent callers (the account.updated/status-poll sync
  // hook and the onMemberStripeWritten trigger below) can both observe the
  // same "held" -> "ready" transition and both call this function; the
  // Stripe transfer and the ledger row already dedupe on the doc id
  // (`held:${docId}`), but a dedupe key built from `now` differs between the
  // two calls and would let the notification through twice.
  const releasedIds: string[] = [];
  for (const d of snap.docs) {
    // Fix round 2: claim the doc BEFORE touching Stripe. The idempotency key
    // (`held:${docId}`) alone does not make the double-caller race above
    // safe for the TRANSFER itself: both callers can read this doc as
    // "held" before either writes a terminal status, and both then call
    // transferToAccount under the same key. FakeStripe has no mutual
    // exclusion for two concurrent calls sharing a key (see stripeClient.ts's
    // own comment on `idem()`), so both apply the balance change and the
    // held amount is credited twice; real Stripe would instead answer the
    // loser with a 409 conflict, which this loop would otherwise record as a
    // `failed` doc and a `held_share_release_failed` alert for money that
    // already moved. A transactional claim closes both failure modes: only
    // the caller that wins the claim proceeds to transfer.
    let held: HeldShareDoc | null = null;
    try {
      held = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(d.ref);
        const cur = fresh.data() as HeldShareDoc | undefined;
        if (!cur || (cur.status !== "held" && cur.status !== "failed")) return null;
        if (cur.releaseClaimedAt != null && now - cur.releaseClaimedAt < RELEASE_CLAIM_STALE_MS) return null;
        tx.update(d.ref, { releaseClaimedAt: now });
        return cur;
      });
    } catch (e) {
      console.error(`releaseHeldShares: claim failed for ${d.id}`, e);
      continue;
    }
    // Lost the claim (a racer already holds it, or already finished it): not
    // this call's doc to touch. A crash between a winning claim and its
    // terminal write leaves `releaseClaimedAt` in place, and the next sync's
    // claim attempt re-wins it once RELEASE_CLAIM_STALE_MS has passed, then
    // replays the SAME Stripe idempotency key.
    if (!held) continue;
    try {
      const t = await getStripe().transferToAccount({ accountId: ms.accountId, amountCents: held.amountCents, idempotencyKey: `held:${d.id}`, meta: { purpose: "held_share", heldId: d.id, profileId: held.profileId, uid } });
      await d.ref.update({ status: "released", releasedAt: now, transferId: t.id, error: FieldValue.delete(), releaseClaimedAt: FieldValue.delete() });
      await writeLedger({ kind: "share_released", amountCents: held.amountCents, profileId: held.profileId, uid, stripeId: t.id, sourced: false, ...refFields(held.ref), detail: "held share released after payout setup", at: now })
        .catch((e) => console.error(`releaseHeldShares: ledger row failed for ${d.id}`, e));
      releasedCents += held.amountCents;
      releasedIds.push(d.id);
    } catch (e) {
      await d.ref.update({ status: "failed", error: e instanceof Error ? e.message : String(e), releaseClaimedAt: FieldValue.delete() }).catch(() => undefined);
      const shouldLog = await recordAdminAlert({ alertId: `held_share:${d.id}`, kind: "held_share_release_failed", detail: `held share ${d.id} (${held.amountCents}c for ${uid}) could not be transferred: ${e instanceof Error ? e.message : String(e)}; retried on the member's next status sync`, bookingId: null, gigId: null, now });
      if (shouldLog) console.error(`releaseHeldShares: ${d.id} failed`, e);
    }
  }
  if (releasedCents > 0) {
    // Deterministic per the SET of docs released, sorted so the two racing
    // callers (which can observe the same snap.docs in a different order)
    // land on the exact same key and dedupe against each other, not merely
    // against themselves.
    const setKey = createHash("sha1").update(releasedIds.slice().sort().join(",")).digest("hex").slice(0, 16);
    await notifyUser(uid, { kind: "share_released", refKind: "payouts", title: "Held money released", body: `${formatShareCents(releasedCents)} that was waiting for you is now in your balance.` }, `share_released:${uid}:${setKey}`)
      .catch((e) => console.error(`releaseHeldShares: notification failed for ${uid}`, e));
  }
  return releasedCents;
}

// Task 4's two call sites (getMemberPayoutStatus's status-poll path, the
// account.updated member branch in payments.ts) already call
// releaseHeldSharesHook; this registration is what turns that hook from a
// no-op into the real thing, both there AND for this trigger below.
setReleaseHeldSharesHook(releaseHeldShares);

// The webhook-independent path to the same release: fires directly off the
// member's own identity doc flipping transfersEnabled false -> true,
// regardless of which caller wrote it (the account.updated webhook, or
// getMemberPayoutStatus's own sync). Idempotent alongside both of those
// direct calls: the `held:${docId}` Stripe idempotency key and the doc's
// `status` CAS (only "held"/"failed" rows are selected) mean a release that
// already ran, by whichever path got there first, is a no-op here.
export const onMemberStripeWritten = onDocumentWritten("users/{uid}/private/stripe", async (event) => {
  const uid = event.params.uid;
  try {
    const before = event.data?.before.data() as MemberStripeDoc | undefined;
    const after = event.data?.after.data() as MemberStripeDoc | undefined;
    if (after?.transfersEnabled === true && before?.transfersEnabled !== true) await releaseHeldShares(uid, Date.now());
  } catch (e) {
    console.error("releaseHeldShares: trigger failed", uid, e);
  }
});

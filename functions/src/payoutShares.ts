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
import { getStripe, stripeSecretKey } from "./stripeClient.js";
import {
  writeLedger, recordAdminAlert, setMemberSelfDealInstantHold, heldShareRefFields,
  IDEMPOTENCY_WINDOW_MS, isDefiniteStripeRefusalCode, stripeErrorCode,
} from "./paymentsCore.js";
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
  // SP5c final fix wave (I6): a card->cash conversion with the same person on
  // both sides. Booking settlement passes the payment doc's own `selfDeal`;
  // ticket settlement passes false (a fan buying a ticket is never the
  // curator). When true, every member leg that TRANSFERS gets the same
  // instant-payout hold `setSelfDealInstantHold` already stamps on the
  // profile's doc, because the split is what puts self-deal money into member
  // accounts in the first place.
  selfDeal: boolean;
  now: number;
}
export interface DistributeLeg { payee: PayoutPayee; amountCents: number; outcome: "transferred" | "held"; transferId: string | null; sourced: boolean }

// SP5c final fix wave (I3): thrown when a leg fails AFTER at least one leg has
// already transferred. The distinction matters to every caller: a bare Stripe
// refusal on the FIRST leg means no money moved, so a ticket settlement may
// release its claim and stay cancellable; a partial distribution means money
// has already reached member (or profile) accounts, so releasing the claim
// would let a cancel refund buyers on top of transfers that already happened.
// `legs` carries what this call actually did up to the failure, so an alert
// can name the moved legs instead of leaving an operator to reconstruct them.
export class DistributePartialError extends Error {
  readonly legs: DistributeLeg[];
  readonly cause: unknown;
  constructor(cause: unknown, legs: DistributeLeg[]) {
    const moved = legs.filter((l) => l.outcome === "transferred").length;
    super(`distributeEarnings: a leg failed after ${moved} leg(s) had already transferred:`
      + ` ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DistributePartialError";
    this.legs = legs;
    this.cause = cause;
  }
}

// "member:uid123 4501c, profile 500c", for an alert detail. Empty string when
// nothing moved.
export function describeMovedLegs(legs: DistributeLeg[]): string {
  return legs.filter((l) => l.outcome === "transferred")
    .map((l) => `${payeeKey(l.payee)} ${l.amountCents}c`).join(", ");
}
// SP5c fix round 1: `transferId` prefers the PROFILE leg's transfer id (a
// clawback reverses the profile's own account, never a member's), falling
// back to the first transferred leg only when there is no profile leg to
// point at. `profileCents` is what actually reached the profile's account,
// the amount a clawback may reverse.
export interface DistributeResult { legs: DistributeLeg[]; transferId: string | null; sourcedAny: boolean; heldCents: number; profileCents: number }

// The four nullable ledger columns a HeldShareRef flattens to. Defined in
// paymentsCore.ts beside `voidHeldShares`, which needs the same flattening for
// its `share_voided` rows, and imported here rather than kept in two places.
const refFields = heldShareRefFields;

// ---------- Fix wave I2: the FROZEN distribution plan ----------
//
// `distributions/{idempotencyBase}`, server-only (firestore.rules' catch-all
// deny covers it; no client ever reads or writes it).
//
// THE BUG THIS CLOSES: distributeEarnings used to re-read `loadShares` on
// every call, including a RETRY of the same idempotencyBase. A share change
// between a partial distribution and its retry therefore changed the legs
// under a base whose member transfers had already gone out: clearing shares
// mid-retry would send the WHOLE amount to the profile under the bare base
// key (a key nothing had consumed yet), on top of the member legs already
// paid. Freezing the plan the first time a base is seen, and distributing
// from the STORED legs on every later call, makes a base's fan-out immutable
// no matter what the shares say later.
//
// `shared` is load-bearing and not merely descriptive: a no-shares
// distribution transfers under the BARE base key, while a single 100% profile
// share transfers under `{base}:share:profile`. The two produce an identical
// leg list, so without this flag a replay could pick the other key and pay a
// second time.
interface DistributionPlanLeg { payee: PayoutPayee; amountCents: number }
interface DistributionPlanDoc {
  profileId: string; amountCents: number; shared: boolean;
  legs: DistributionPlanLeg[]; createdAt: number;
}

async function freezeDistributionPlan(
  db: Firestore, input: DistributeInput,
): Promise<DistributionPlanDoc> {
  const ref = db.doc(`distributions/${input.idempotencyBase}`);
  const shares = await loadShares(db, input.profileId);
  const planned: DistributionPlanDoc = {
    profileId: input.profileId, amountCents: input.amountCents, shared: shares != null,
    legs: shares
      ? splitCents(input.amountCents, shares)
        .filter((p) => p.amountCents > 0)
        .map((p) => ({ payee: p.payee, amountCents: p.amountCents }))
      : [{ payee: { kind: "profile" }, amountCents: input.amountCents }],
    createdAt: input.now,
  };
  try {
    await ref.create(planned);
    return planned;
  } catch (e) {
    // ALREADY_EXISTS (gRPC 6): this base has been distributed (or attempted)
    // before, so the stored plan is the only truth about its legs.
    if ((e as { code?: number }).code !== 6) throw e;
    const stored = (await ref.get()).data() as DistributionPlanDoc | undefined;
    if (!stored) throw new Error(`distributeEarnings: distribution plan ${input.idempotencyBase} exists but could not be read`);
    return stored;
  }
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
  // The base becomes a `distributions/{base}` doc id below, and a "/" would
  // silently address a nested collection instead. Colons are legal in a doc id
  // (every base in this codebase carries them) and are fine.
  if (!input.idempotencyBase || input.idempotencyBase.includes("/")) {
    throw new Error(`distributeEarnings: idempotencyBase ${JSON.stringify(input.idempotencyBase)} must be non-empty and contain no "/"`);
  }
  const db = getFirestore();
  const stripe = getStripe();
  // Fix wave I2: the legs are frozen on the FIRST call for this base and
  // replayed verbatim afterwards, so a share change between a partial
  // distribution and its retry cannot re-shape (or re-key) the fan-out.
  const plan = await freezeDistributionPlan(db, input);
  const fits = (cents: number, remaining: number) => input.source !== null && cents <= remaining;
  const profileName = plan.legs.some((l) => l.payee.kind === "member")
    ? ((await db.doc(`profiles/${input.profileId}`).get()).data() as ProfileDoc | undefined)?.name ?? "your band"
    : "your band";
  let remaining = input.source?.remainingCents ?? 0;
  const legs: DistributeLeg[] = [];
  let heldCents = 0;
  for (const part of plan.legs) {
    if (part.amountCents <= 0) continue;
    // A no-shares plan keeps the BARE base as its key, byte for byte what the
    // pre-SP5c single transfer used, so existing keys and tests keep meaning.
    const key = plan.shared ? `${input.idempotencyBase}:share:${payeeKey(part.payee)}` : input.idempotencyBase;
    try {
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
        // Fix wave I5: the payee is no longer a member of this profile (they
        // left, or their account was deleted, between the plan being frozen
        // and this leg running). The money is still THEIRS, so it is still
        // held rather than quietly redirected, but nothing will ever surface
        // this row on the profile's shares card, so it gets a durable ticket.
        const stillAMember = (await db.doc(`profiles/${input.profileId}/members/${uid}`).get()).exists;
        if (!stillAMember) {
          await recordAdminAlert({
            alertId: `held_share_orphan:${input.idempotencyBase}:${uid}`, kind: "held_share_release_failed",
            detail: `profile ${input.profileId} holds ${part.amountCents}c for ${uid}, who is no longer a member of it`
              + ` (heldShares/${heldRef.id}). The money is still theirs and releases when their payouts are set up,`
              + " but no shares card will show it; decide by hand whether it should be released or voided",
            bookingId: null, gigId: null, now: input.now,
          }).catch((e) => console.error(`distributeEarnings: held_share_orphan alert failed for ${key}`, e));
        }
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
      const uid = part.payee.kind === "member" ? part.payee.uid : null;
      const t = await stripe.transferToAccount({
        accountId, amountCents: part.amountCents, idempotencyKey: key,
        // Fix wave M5: `uid` travels with the transfer, so the
        // `transfer.reversed` webhook (paymentsSettlement.ts) can record WHOSE
        // money a reversal took back rather than only which profile it belonged to.
        meta: { ...input.meta, payee: payeeKey(part.payee), ...(uid ? { uid } : {}) },
        ...(sourced ? { sourceChargeId: input.source!.chargeId } : {}),
      });
      if (sourced) remaining -= part.amountCents;
      await writeLedger({ kind: "share_transfer", amountCents: part.amountCents, profileId: input.profileId, uid, stripeId: t.id, sourced, ...refFields(input.ref), detail: `${payeeKey(part.payee)} share of ${input.purpose}${sourced ? ", sourced from the charge" : ", drawn on the platform balance"}`, at: input.now })
        .catch((e) => console.error(`distributeEarnings: share_transfer ledger row failed for ${key}`, e));
      if (uid) {
        // Fix wave I6: self-deal money that just landed in a MEMBER's own
        // account gets the same instant-payout hold the profile's account
        // already got. Best-effort inside the helper, exactly like the
        // profile stamp: the transfer has happened either way.
        if (input.selfDeal) await setMemberSelfDealInstantHold(uid, input.now);
        await notifyUser(uid, { kind: "share_paid", refKind: "payouts", title: "You were paid", body: `${formatShareCents(part.amountCents)} from ${profileName}.` }, `share_paid:${key}`)
          .catch((e) => console.error(`distributeEarnings: share_paid notification failed for ${key}`, e));
      }
      legs.push({ payee: part.payee, amountCents: part.amountCents, outcome: "transferred", transferId: t.id, sourced });
    } catch (e) {
      // Fix wave I3: once ANY leg has moved money, the caller must not treat
      // this failure as "nothing happened". Rethrown as-is while nothing has
      // transferred, so a first-leg refusal keeps its Stripe `code` and every
      // existing definite-refusal judgement still works.
      if (legs.some((l) => l.outcome === "transferred")) throw new DistributePartialError(e, legs);
      throw e;
    }
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
  // Fix wave C1: resolved ONCE, before any doc is claimed. `getStripe()`
  // throws when the secret is not bound (a configuration bug), and a throw
  // from inside the loop would have consumed a claim on the doc it was
  // claiming, wedging that share for RELEASE_CLAIM_STALE_MS for no reason.
  const stripe = getStripe();
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
    //
    // FIX WAVE I7, decided inside the SAME transaction as the claim: a doc
    // whose last release attempt is older than Stripe's idempotency window
    // can no longer REPLAY `held:${docId}`, that key is brand new to Stripe
    // now, so a "retry" would be a genuine SECOND transfer for a first
    // attempt whose fate we may not know. Only a DEFINITE refusal (the
    // allowlist in paymentsCore.ts, codes Stripe only returns after refusing
    // to create the transfer) proves nothing moved and may be replayed past
    // the window. Anything else is left for an operator.
    let claim: { verdict: "skip" } | { verdict: "stale" | "go"; doc: HeldShareDoc };
    try {
      claim = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(d.ref);
        const cur = fresh.data() as HeldShareDoc | undefined;
        if (!cur || (cur.status !== "held" && cur.status !== "failed")) return { verdict: "skip" as const };
        if (cur.releaseClaimedAt != null && now - cur.releaseClaimedAt < RELEASE_CLAIM_STALE_MS) return { verdict: "skip" as const };
        const attempted = cur.releaseAttemptedAt;
        if (attempted != null && now - attempted >= IDEMPOTENCY_WINDOW_MS
          && !isDefiniteStripeRefusalCode(cur.releaseErrorCode)) {
          return { verdict: "stale" as const, doc: cur };
        }
        tx.update(d.ref, { releaseClaimedAt: now, releaseAttemptedAt: now });
        return { verdict: "go" as const, doc: cur };
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
    if (claim.verdict === "skip") continue;
    if (claim.verdict === "stale") {
      const shouldLog = await recordAdminAlert({
        alertId: `held_share_stale:${d.id}`, kind: "held_share_release_failed",
        detail: `held share ${d.id} (${claim.doc.amountCents}c for ${uid}) last attempted its release at`
          + ` ${new Date(claim.doc.releaseAttemptedAt!).toISOString()}, longer ago than Stripe's idempotency window,`
          + ` and failed with ${claim.doc.releaseErrorCode ?? "no error code"}, which does not prove the transfer was`
          + " refused. NOT retried: a fresh key would be a second transfer. An operator must check Stripe for a"
          + ` transfer under key held:${d.id} and either finish it there or clear this doc's status by hand`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) console.error(`releaseHeldShares: ${d.id} is past the idempotency window and was not replayed`);
      continue;
    }
    const held = claim.doc;
    try {
      const t = await stripe.transferToAccount({ accountId: ms.accountId, amountCents: held.amountCents, idempotencyKey: `held:${d.id}`, meta: { purpose: "held_share", heldId: d.id, profileId: held.profileId, uid } });
      await d.ref.update({ status: "released", releasedAt: now, transferId: t.id, error: FieldValue.delete(), releaseErrorCode: FieldValue.delete(), releaseClaimedAt: FieldValue.delete() });
      await writeLedger({ kind: "share_released", amountCents: held.amountCents, profileId: held.profileId, uid, stripeId: t.id, sourced: false, ...refFields(held.ref), detail: "held share released after payout setup", at: now })
        .catch((e) => console.error(`releaseHeldShares: ledger row failed for ${d.id}`, e));
      releasedCents += held.amountCents;
      releasedIds.push(d.id);
    } catch (e) {
      await d.ref.update({ status: "failed", error: e instanceof Error ? e.message : String(e), releaseErrorCode: stripeErrorCode(e), releaseClaimedAt: FieldValue.delete() }).catch(() => undefined);
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
//
// FIX WAVE C1: `secrets: [stripeSecretKey]` is MANDATORY here. This trigger
// reaches `getStripe()` through `releaseHeldShares`, and a v2 function that
// does not declare the secret gets no STRIPE_SECRET_KEY in its environment, so
// every release would throw in production. The emulator cannot show it:
// FakeStripe is selected without ever reading the key.
export const onMemberStripeWritten = onDocumentWritten(
  { document: "users/{uid}/private/stripe", secrets: [stripeSecretKey] }, async (event) => {
    const uid = event.params.uid;
    try {
      const before = event.data?.before.data() as MemberStripeDoc | undefined;
      const after = event.data?.after.data() as MemberStripeDoc | undefined;
      if (after?.transfersEnabled === true && before?.transfersEnabled !== true) await releaseHeldShares(uid, Date.now());
    } catch (e) {
      console.error("releaseHeldShares: trigger failed", uid, e);
    }
  });

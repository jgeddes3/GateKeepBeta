/**
 * SP5c Task 4: a person's OWN Express account, status, and cash-out.
 *
 * The musician-half of payments.ts/paymentsPayouts.ts, but keyed on `uid`
 * instead of `profileId`: `users/{uid}/private/stripe` (MemberStripeDoc) is
 * the identity doc, and there is no admin check anywhere in this file, the
 * doc path IS the caller's own uid, so "is this mine" is free.
 *
 * `requestMemberPayout` mirrors `requestPayout` (paymentsPayouts.ts)
 * substitution-for-substitution: same idempotency shape, same three-layer
 * replay guarantee, same instant-fee/hold/minimum rules, just scoped to a
 * user instead of a profile. The four caller-facing PAYOUT_* messages stay
 * defined ONCE, in paymentsPayouts.ts, and are imported here rather than
 * redeclared, so a copy change never has to be made twice.
 *
 * `syncMemberAccountFlags` mirrors `syncStripeAccountFlags` (payments.ts)
 * the same way, and reports whether `transfersEnabled` just flipped
 * false->true, the signal Task 5's `releaseHeldShares` acts on. That
 * function doesn't exist yet, so this file declares a local, overridable
 * hook (`releaseHeldSharesHook`) that Task 5 replaces via
 * `setReleaseHeldSharesHook`; until then it is a no-op.
 *
 * ONE-WAY IMPORT EDGE, on purpose: this file imports the four PAYOUT_*
 * messages and `readPayoutBalances` FROM paymentsPayouts.ts, so
 * paymentsPayouts.ts must never import anything from this file (its
 * `payout.paid`/`payout.failed` handlers read the member's cached account id
 * with an inline Firestore doc read instead of calling `getMemberStripeDoc`
 * here, precisely to keep that edge one-directional).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  computeInstantFeeCents, INSTANT_FEE_MIN_CENTS, INSTANT_FEE_PCT, INSTANT_PAYOUT_MIN_CENTS,
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, PAYOUT_INSTANT_HELD_MESSAGE,
  type PayoutRequestRecord, type MemberStripeDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import {
  getStripe, stripeSecretKey, StripeAccountMissingError, type StripeAccountState,
} from "./stripeClient.js";
import { recordAdminAlert, writeLedger } from "./paymentsCore.js";
import {
  readPayoutBalances,
  PAYOUT_SETUP_REQUIRED_MESSAGE, PAYOUT_OVER_BALANCE_MESSAGE,
  PAYOUT_AMOUNT_TOO_SMALL_MESSAGE, PAYOUT_REQUEST_ID_REUSED_MESSAGE,
} from "./paymentsPayouts.js";

// Same ceiling requestPayout's callable enforces (paymentsPayouts.ts), mirrored
// here rather than exported/imported: a private constant with no message
// attached to it, unlike the four PAYOUT_* strings above.
const MAX_CENTS = 2 ** 45;
// Same shape as paymentsPayouts.ts's own copy: a client-minted id scoping one
// cash-out attempt, part of a Stripe idempotency key and of an adminAlerts doc
// id, so it is bounded and path-separator-free.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ---------- Task 5's hook point (releaseHeldShares does not exist yet) ----------
//
// A local, overridable hook rather than a stub file: Task 5 wires the real
// `releaseHeldShares` in with `setReleaseHeldSharesHook`, and every call site
// in THIS file (and in payments.ts's account.updated handler) already calls
// the hook, so Task 5 needs no further edits here.
export let releaseHeldSharesHook: (uid: string, now: number) => Promise<number> = async () => 0;
export function setReleaseHeldSharesHook(fn: typeof releaseHeldSharesHook) { releaseHeldSharesHook = fn; }

// ---------- the identity doc ----------

export function emptyMemberStripe(now: number): MemberStripeDoc {
  return {
    accountId: null, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    onboardingStartedAt: null, onboardedAt: null, updatedAt: now,
  };
}

export async function getMemberStripeDoc(uid: string): Promise<MemberStripeDoc | null> {
  const snap = await getFirestore().doc(`users/${uid}/private/stripe`).get();
  return (snap.data() as MemberStripeDoc | undefined) ?? null;
}

// Re-reads the account state from Stripe and refreshes the cached gate flags,
// mirrors syncStripeAccountFlags (payments.ts) exactly, but keyed on uid.
// Returns the doc plus whether transfersEnabled flipped false -> true in THIS
// sync, the signal releaseHeldShares (Task 5) acts on: a member's held shares
// only need retrying the moment their account becomes payout-ready, not on
// every poll.
export async function syncMemberAccountFlags(
  uid: string, now: number,
): Promise<{ doc: MemberStripeDoc | null; enabledNow: boolean }> {
  const ms = await getMemberStripeDoc(uid);
  if (!ms?.accountId) return { doc: ms, enabledNow: false };
  let state: StripeAccountState;
  try {
    state = await getStripe().getAccountState(ms.accountId);
  } catch (e) {
    if (e instanceof StripeAccountMissingError) {
      await getFirestore().doc(`users/${uid}/private/stripe`).set(
        { transfersEnabled: false, payoutsEnabled: false, instantEligible: false, updatedAt: now }, { merge: true });
      return { doc: { ...ms, transfersEnabled: false, payoutsEnabled: false, instantEligible: false }, enabledNow: false };
    }
    console.error(`syncMemberAccountFlags: failed to read Stripe account state for user ${uid}`, e);
    return { doc: ms, enabledNow: false };
  }
  const next = {
    transfersEnabled: state.transfersEnabled, payoutsEnabled: state.payoutsEnabled,
    instantEligible: state.instantEligible, onboardedAt: ms.onboardedAt ?? (state.transfersEnabled ? now : null),
  };
  const changed = ms.transfersEnabled !== next.transfersEnabled || ms.payoutsEnabled !== next.payoutsEnabled
    || ms.instantEligible !== next.instantEligible || ms.onboardedAt !== next.onboardedAt;
  if (!changed) return { doc: ms, enabledNow: false };
  await getFirestore().doc(`users/${uid}/private/stripe`).set({ ...next, updatedAt: now }, { merge: true });
  return { doc: { ...ms, ...next, updatedAt: now }, enabledNow: !ms.transfersEnabled && next.transfersEnabled };
}

// Create-then-claim, mirrors payments.ts's claimStripeId, but scoped to
// `users/{uid}/private/stripe` and the single `accountId` field a person's own
// identity doc carries. `onboardingStartedAt` is set only the first time
// (this whole branch only runs while no accountId is cached yet), never
// re-stamped on a later onboarding-link refresh.
async function claimMemberAccountId(uid: string, createdId: string, now: number): Promise<string> {
  const ref = getFirestore().doc(`users/${uid}/private/stripe`);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data() as MemberStripeDoc | undefined;
    if (cur?.accountId) return cur.accountId;
    tx.set(ref, {
      ...(cur ? {} : emptyMemberStripe(now)),
      accountId: createdId, onboardingStartedAt: now, updatedAt: now,
    }, { merge: true });
    return createdId;
  });
}

// Musician half, but for a PERSON: ensures the caller's own Express account
// exists, returns a fresh Stripe-hosted onboarding URL. Mirrors
// createOnboardingLink (payments.ts) exactly, no admin check (the only
// "authority" here is being signed in as the uid the doc path names).
export const createMemberOnboardingLink = onCall<object>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);

    const stripe = getStripe();
    const now = Date.now();
    const existing = await getMemberStripeDoc(uid);
    let accountId = existing?.accountId ?? null;
    if (!accountId) {
      const created = (await stripe.createExpressAccount({ uid })).id;
      accountId = await claimMemberAccountId(uid, created, now);
    }
    const inEmulator = process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST != null;
    const origin = process.env.APP_ORIGIN ?? (inEmulator ? "http://localhost:3000" : null);
    if (!origin) {
      throw new Error("APP_ORIGIN is not configured, refusing to build a Stripe onboarding redirect without a known origin.");
    }
    const link = await stripe.createOnboardingLink(
      accountId, `${origin}/dashboard/payouts/onboarding/return`, `${origin}/dashboard/payouts/onboarding/refresh`);
    return { url: link.url };
  });

// One status surface for a person's own payout setup: onboarding/gate flags,
// the two balance buckets (degradable, exactly as readPayoutBalances already
// is for the profile surface), and heldCents, the sum of this uid's still-
// unreleased heldShares rows (Task 5 writes those; this file only reads and
// sums them). Re-syncs first, and when that sync just flipped transfersEnabled
// on, kicks the held-shares release hook, same trigger account.updated fires
// on the webhook path, so a status poll converges just as fast as the webhook.
export const getMemberPayoutStatus = onCall<object>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);

    const now = Date.now();
    const { doc, enabledNow } = await syncMemberAccountFlags(uid, now);
    const balances = await readPayoutBalances(
      doc ? { accountId: doc.accountId, payoutsEnabled: doc.payoutsEnabled } : null);
    if (enabledNow) await releaseHeldSharesHook(uid, now);

    const heldSnap = await getFirestore().collection("heldShares")
      .where("uid", "==", uid).where("status", "in", ["held", "failed"]).get();
    const heldCents = heldSnap.docs.reduce((sum, d) => sum + ((d.data().amountCents as number | undefined) ?? 0), 0);

    return {
      hasAccount: doc?.accountId != null,
      transfersEnabled: doc?.transfersEnabled ?? false,
      payoutsEnabled: doc?.payoutsEnabled ?? false,
      instantEligible: doc?.instantEligible ?? false,
      availableBalanceCents: balances.availableBalanceCents,
      instantAvailableBalanceCents: balances.instantAvailableBalanceCents,
      heldCents,
    };
  });

// ---------- the callable: a person's own cash-out ----------

export interface RequestMemberPayoutInput {
  amountCents: number; method: "standard" | "instant"; requestId: string;
}
export interface RequestMemberPayoutResult {
  payoutId: string; feeCents: number; netCents: number; replayed: boolean;
}

// Best-effort memo of a COMPLETED request, mirrors rememberPayoutRequest
// (paymentsPayouts.ts) but written to the member's own identity doc.
async function rememberMemberPayoutRequest(uid: string, record: PayoutRequestRecord): Promise<void> {
  await getFirestore().doc(`users/${uid}/private/stripe`)
    .set({ lastPayout: record, updatedAt: record.at }, { merge: true })
    .catch((e) => console.error(`requestMemberPayout: failed to record the payout memo for ${uid}`, e));
}

// Mirrors requestPayout (paymentsPayouts.ts) substitution-for-substitution:
// the doc is `users/{uid}/private/stripe`, the authority is simply being the
// signed-in uid the doc path names (no admin check, this is a person's own
// money, not a profile's), the idempotency keys are `{uid}:payout:{requestId}`
// / `{uid}:payoutfee:{requestId}`, the ledger kinds are `member_payout_standard`
// / `member_payout_instant` with `uid` set and `profileId: null`, and the
// fee-uncollected alert is scoped to `member_payout_fee:{uid}:{requestId}`
// (still kind `payout_fee_uncollected`, the alert schema has no per-scope
// variant, `detail` names the user instead of a profile).
export const requestMemberPayout = onCall<RequestMemberPayoutInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<RequestMemberPayoutResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { amountCents, method, requestId } = req.data ?? ({} as RequestMemberPayoutInput);
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > MAX_CENTS) {
      throw new HttpsError("invalid-argument", "Cash out at least $1, as a whole number of cents.");
    }
    if (method !== "standard" && method !== "instant") {
      throw new HttpsError("invalid-argument", "Method must be standard or instant.");
    }
    // Type-checked before the regex, same reasoning as requestPayout's own
    // check: RegExp.test coerces a non-string to a string first.
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      throw new HttpsError("invalid-argument", "A request id is required (8-64 characters, letters/digits/-/_).");
    }

    const ms = await getMemberStripeDoc(uid);
    if (!ms?.accountId || ms.payoutsEnabled !== true) {
      throw new HttpsError("failed-precondition", PAYOUT_SETUP_REQUIRED_MESSAGE);
    }
    if (method === "instant" && ms.instantEligible !== true) {
      throw new HttpsError("failed-precondition", PAYOUT_INSTANT_INELIGIBLE_MESSAGE);
    }
    if (method === "instant" && amountCents < INSTANT_PAYOUT_MIN_CENTS) {
      throw new HttpsError("invalid-argument", PAYOUT_INSTANT_MIN_MESSAGE);
    }
    if (method === "instant" && ms.instantHoldUntil != null && Date.now() < ms.instantHoldUntil) {
      throw new HttpsError("failed-precondition", PAYOUT_INSTANT_HELD_MESSAGE);
    }

    // LAYER 1 of the three-layer no-double-pay guarantee, see requestPayout's
    // own header comment for the full statement, identical here.
    const memo = ms.lastPayout;
    if (memo && memo.requestId === requestId) {
      if (memo.method !== method || memo.amountCents !== amountCents) {
        throw new HttpsError("invalid-argument", PAYOUT_REQUEST_ID_REUSED_MESSAGE);
      }
      return { payoutId: memo.payoutId, feeCents: memo.feeCents, netCents: memo.netCents, replayed: true };
    }

    const stripe = getStripe();
    const buckets = await stripe.getBalances(ms.accountId);
    const balance = method === "instant" ? buckets.instantAvailableCents : buckets.availableCents;
    if (amountCents > balance) throw new HttpsError("failed-precondition", PAYOUT_OVER_BALANCE_MESSAGE);

    const payoutKey = `${uid}:payout:${requestId}`;
    const now = Date.now();

    if (method === "standard") {
      const po = await stripe.createPayout({
        accountId: ms.accountId, amountCents, instant: false,
        idempotencyKey: payoutKey, meta: { uid, purpose: "member_payout", requestId },
      });
      await writeLedger({
        kind: "member_payout_standard", amountCents, bookingId: null, gigId: null,
        profileId: null, uid, stripeId: po.id, detail: "standard payout (1-3 business days)",
      }).catch((e) => console.error(`requestMemberPayout: member_payout_standard ledger row failed for ${uid}`, e));
      await rememberMemberPayoutRequest(uid, {
        requestId, payoutId: po.id, method, amountCents, feeCents: 0, netCents: amountCents, at: now,
      });
      return { payoutId: po.id, feeCents: 0, netCents: amountCents, replayed: false };
    }

    // Instant: the fee comes out of the requested amount, and moves
    // platform-ward as a separate account debit, exactly as requestPayout's
    // own instant branch.
    const feeCents = computeInstantFeeCents(amountCents, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS);
    if (feeCents >= amountCents) {
      throw new HttpsError("invalid-argument", PAYOUT_AMOUNT_TOO_SMALL_MESSAGE);
    }
    const netCents = amountCents - feeCents;
    const po = await stripe.createPayout({
      accountId: ms.accountId, amountCents: netCents, instant: true,
      idempotencyKey: payoutKey, meta: { uid, purpose: "member_payout", requestId },
    });
    await writeLedger({
      kind: "member_payout_instant", amountCents: netCents, bookingId: null, gigId: null,
      profileId: null, uid, stripeId: po.id, detail: `instant payout (fee ${feeCents})`,
    }).catch((e) => console.error(`requestMemberPayout: member_payout_instant ledger row failed for ${uid}`, e));

    // THE PAYOUT FIRST, THE FEE SECOND, NEVER an unwind, same reasoning as
    // requestPayout: the payout is gone the moment Stripe accepts it, so a
    // failed fee debit is uncollected revenue for an operator to recover, not
    // a reason to fail (or lie about) a call whose money already moved.
    try {
      const debit = await stripe.debitConnectedAccount({
        accountId: ms.accountId, amountCents: feeCents,
        idempotencyKey: `${uid}:payoutfee:${requestId}`,
        meta: { uid, purpose: "member_payout_fee", requestId, payoutId: po.id },
      });
      await writeLedger({
        kind: "account_debit", amountCents: feeCents, bookingId: null, gigId: null,
        profileId: null, uid, stripeId: debit.id, detail: `instant payout fee (${INSTANT_FEE_PCT}%, min ${INSTANT_FEE_MIN_CENTS}c)`,
      }).catch((e) => console.error(`requestMemberPayout: account_debit ledger row failed for ${uid}`, e));
    } catch (e) {
      const detail = `instant payout ${po.id} for user ${uid} paid out ${netCents}c but the ${feeCents}c`
        + " fee could not be debited from the connected account. The payout is NOT unwound; collect the fee by hand"
        + " (or net it off a future payout)";
      const alertId = `member_payout_fee:${uid}:${requestId}`;
      const shouldLog = await recordAdminAlert({
        alertId, kind: "payout_fee_uncollected", detail, bookingId: null, gigId: null, now,
      });
      if (shouldLog) console.error(`requestMemberPayout: ${detail} (see adminAlerts/${alertId})`, e);
    }

    await rememberMemberPayoutRequest(uid, {
      requestId, payoutId: po.id, method, amountCents, feeCents, netCents, at: now,
    });
    return { payoutId: po.id, feeCents, netCents, replayed: false };
  });

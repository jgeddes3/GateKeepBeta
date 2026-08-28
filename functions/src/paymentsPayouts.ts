/**
 * SP5 Task 13 — THE MUSICIAN'S WAY OUT: balance, cash-out, payout webhooks.
 *
 * The only SP5 money that leaves Stripe entirely. Everything else in this
 * codebase moves money BETWEEN Stripe objects (a card to the platform, the
 * platform to a connected account); a payout moves it out to a bank account or
 * a debit card, and that is the one direction nothing can pull back.
 *
 * Three pieces:
 *  - `readPayoutBalances` — the two balance figures `getStripeStatus` surfaces,
 *    with the degraded-status posture Task 4's review established (a Stripe
 *    read failure returns nulls and logs; it never 500s the status surface);
 *  - `requestPayout` — the callable, standard or instant. Instant costs
 *    INSTANT_FEE_PCT (min INSTANT_FEE_MIN_CENTS), taken out of the requested
 *    amount and pulled platform-ward by a separate account debit;
 *  - the `payout.paid` / `payout.failed` webhook handlers, which record the
 *    OUTCOME of a payout this file already recorded the REQUEST of.
 *
 * Registered from index.ts by way of the `requestPayout` export — the same
 * "importing the module is what registers its handlers" arrangement every other
 * SP5 webhook registration relies on (see paymentsWebhook.ts's header).
 *
 * NOT booking-scoped, which is the property that shapes most of the decisions
 * below: there is no booking, no occurrence, no `feePolicy` snapshot and no
 * payment doc to hang state off. The fee comes from the LIVE constants, the
 * ledger rows carry null booking/gig ids, and the one admin alert this file can
 * raise is the only profile-scoped alert in SP5.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  computeInstantFeeCents, isValidDocId, INSTANT_FEE_MIN_CENTS, INSTANT_FEE_PCT, INSTANT_PAYOUT_MIN_CENTS,
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, PAYOUT_INSTANT_HELD_MESSAGE,
  type PayoutRequestRecord, type StripeProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { getStripe, stripeSecretKey } from "./stripeClient.js";
import { getStripeProfileDoc, payoutFeeAlertId, recordAdminAlert, writeLedger } from "./paymentsCore.js";
import { notifyProfileMembers } from "./notifications.js";
import { webhookHandlers } from "./paymentsWebhook.js";

// The same ceiling money.ts's assertCents enforces — mirrored here so a
// malformed amount is refused as invalid-argument by the callable rather than
// thrown as an internal error out of computeInstantFeeCents.
const MAX_CENTS = 2 ** 45;

// Caller-facing refusals, exported for the reason every other SP5 message
// constant is: they are different situations with different fixes, and the web
// keys its inline prompts off them.
//
// PAYOUT_INSTANT_INELIGIBLE_MESSAGE moved to @gatekeep/shared/messages.ts
// (review round 1, the fix round before Task 15) — the Earnings page's
// Instant button tooltip needs this EXACT string, and re-exports it below so
// every existing in-repo import (this file's own callable, functions/test/*)
// keeps resolving from "./paymentsPayouts.js" unchanged. The other three
// below stay local: the web only ever displays them verbatim (a caught
// error), it never pre-empts/mirrors their copy client-side.
export { PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, PAYOUT_INSTANT_HELD_MESSAGE };
export const PAYOUT_SETUP_REQUIRED_MESSAGE = "Finish payout setup first.";
export const PAYOUT_OVER_BALANCE_MESSAGE = "That's more than your available balance.";
export const PAYOUT_AMOUNT_TOO_SMALL_MESSAGE = "Amount is too small for an instant payout.";
// One requestId means ONE cash-out. Reusing it for a different amount or
// method is a client bug, and answering it with the ORIGINAL payout's result
// would tell someone who just switched "standard" to "instant" that their
// instant payout is on its way when a standard one is.
export const PAYOUT_REQUEST_ID_REUSED_MESSAGE =
  "That cash-out has already been sent — start a new one rather than repeating this request.";

// A client-minted id that scopes ONE cash-out attempt. Deliberately narrow
// (the UI mints a UUID per click) because it becomes part of a Stripe
// idempotency key and of an adminAlerts doc id — both of which must be free of
// path separators and bounded in length. 8 chars minimum so a caller cannot
// collapse every request onto one guessable scope.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestPayoutInput {
  profileId: string;
  amountCents: number;
  method: "standard" | "instant";
  requestId: string;
}

export interface RequestPayoutResult {
  payoutId: string;
  feeCents: number;
  netCents: number;
  // True when this call moved no money because `requestId` matched the
  // profile's last completed request — the caller is looking at the ORIGINAL
  // payout's result. The web uses it to say "already sent" rather than
  // reporting a second cash-out.
  //
  // NOT a complete account of "no money moved": a retry that falls through to
  // Stripe's own key replay (layer 2, reached only when the memo write failed
  // and logged) also moves nothing, yet reports `false` — the callable cannot
  // tell a replayed Stripe object from a fresh one. Cosmetic only, and bounded
  // by an event that leaves an error in the logs: the payout is still never
  // made twice, the caller is merely told "sent" instead of "already sent".
  replayed: boolean;
}

// The two balance figures, or nulls when Stripe couldn't be read.
export interface PayoutBalances {
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
}

// Both buckets for one profile, as `getStripeStatus` reports them.
//
// ZERO vs NULL is a real distinction the web renders differently: 0/0 means "we
// know, and it's empty" (no Connect account yet, or payouts not enabled — there
// is no balance to have), while null/null means "we could not ask Stripe right
// now". Task 4's review established this posture for the status surface as a
// whole (syncStripeAccountFlags returns the cached doc rather than throwing on
// a transient Stripe failure): a musician must still be able to see their
// onboarding state during a Stripe blip, so a balance read that fails is
// LOGGED and degraded, never propagated as a 500 that blanks the page.
export async function readPayoutBalances(sp: StripeProfileDoc | null): Promise<PayoutBalances> {
  // `payoutsEnabled !== true` (not `=== false`) for the same fail-closed reason
  // requireCuratorChargeable checks its flags that way: these docs are cast
  // unchecked from Firestore and a partial one must read as "not ready".
  if (!sp?.accountId || sp.payoutsEnabled !== true) {
    return { availableBalanceCents: 0, instantAvailableBalanceCents: 0 };
  }
  try {
    // ONE Stripe round trip for both buckets (getBalances) — this callable is
    // on the critical path of the Earnings page load.
    const b = await getStripe().getBalances(sp.accountId);
    return { availableBalanceCents: b.availableCents, instantAvailableBalanceCents: b.instantAvailableCents };
  } catch (e) {
    console.error(`readPayoutBalances: failed to read Stripe balance for account ${sp.accountId}`, e);
    return { availableBalanceCents: null, instantAvailableBalanceCents: null };
  }
}

// Best-effort memo of a COMPLETED request (see PayoutRequestRecord's own note
// for why it exists). Written after the money has already moved, so a failure
// here must never surface as a payout failure — the worst case is that a retry
// of this same requestId hits the balance check instead of replaying, which
// refuses rather than double-paying.
async function rememberPayoutRequest(profileId: string, record: PayoutRequestRecord): Promise<void> {
  await getFirestore().doc(`profiles/${profileId}/private/stripe`)
    .set({ lastPayout: record, updatedAt: record.at }, { merge: true })
    .catch((e) => console.error(`requestPayout: failed to record the payout memo for ${profileId}`, e));
}

// ---------- the callable ----------
//
// IDEMPOTENCY, and why it is `requestId`-scoped rather than clock-scoped. The
// plan's snippet keyed both Stripe calls on `Date.now()`, which makes every
// retry a NEW key — so a client that retries a call whose response it never
// saw (a dropped connection, a function timeout after the payout was already
// created) gets a SECOND payout. Money out of the platform is the one direction
// with no undo, so the key is scoped to a value the CLIENT controls and repeats
// across a retry:
//   `{profileId}:payout:{requestId}`     — the payout
//   `{profileId}:payoutfee:{requestId}`  — the instant fee's account debit
// A genuine retry therefore replays Stripe's original objects. A NEW cash-out
// is a new requestId (the web mints a UUID per button press).
//
// Reusing one requestId for a DIFFERENT amount or method is a client bug, and
// it is REFUSED rather than either replayed or silently paid: the memo below
// catches it with `PAYOUT_REQUEST_ID_REUSED_MESSAGE`, and past the memo's reach
// (an older requestId) Stripe itself rejects a key reused with different params
// — that one surfaces as an internal error, which is the right shape for "the
// caller did something impossible", not a normal branch.
//
// THE THREE-LAYER GUARANTEE that no retry ever pays twice:
//   1. the `lastPayout` memo — same requestId as the last completed request ⇒
//      the stored result comes straight back, no Stripe call at all;
//   2. Stripe's idempotency key — if the memo is missing (a crash between the
//      payout and the memo write) the key still replays the original payout;
//   3. the available-balance check — a retry that gets past both because the
//      first attempt spent the balance is refused, not paid again.
export const requestPayout = onCall<RequestPayoutInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<RequestPayoutResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, amountCents, method, requestId } = req.data ?? ({} as RequestPayoutInput);
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > MAX_CENTS) {
      throw new HttpsError("invalid-argument", "Cash out at least $1, as a whole number of cents.");
    }
    if (method !== "standard" && method !== "instant") {
      throw new HttpsError("invalid-argument", "Method must be standard or instant.");
    }
    // Type-checked BEFORE the regex: RegExp.test coerces a non-string to a
    // string first, so `12345678` would otherwise sail through (the same trap
    // refreshPaymentMethod's setupIntentId check documents).
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      throw new HttpsError("invalid-argument", "A request id is required (8-64 characters, letters/digits/-/_).");
    }
    // Owner ruling (H2): ADMIN-only. A payout DRAINS the profile's balance out
    // of the platform, so it is a payout-authority action gated like
    // removeMember/transferAdmin — not the any-member content permission.
    // (Members still SEE the balance/status via getStripeStatus.)
    // FUTURE (sub-5c): admin-initiated member payout splits.
    await requireProfileAdmin(profileId, uid);

    const sp = await getStripeProfileDoc(profileId);
    // Fail closed on a partial doc, exactly as the booking gates do.
    if (!sp?.accountId || sp.payoutsEnabled !== true) {
      throw new HttpsError("failed-precondition", PAYOUT_SETUP_REQUIRED_MESSAGE);
    }
    if (method === "instant" && sp.instantEligible !== true) {
      throw new HttpsError("failed-precondition", PAYOUT_INSTANT_INELIGIBLE_MESSAGE);
    }
    // Owner ruling (M4): the $10 instant minimum. A small cash-out isn't worth
    // the 4% instant fee — a standard payout (still >= $1) is the route for
    // smaller amounts. invalid-argument (an amount refusal), and standard is
    // unaffected.
    if (method === "instant" && amountCents < INSTANT_PAYOUT_MIN_CENTS) {
      throw new HttpsError("invalid-argument", PAYOUT_INSTANT_MIN_MESSAGE);
    }
    // Owner ruling (M3): INSTANT payout is HELD while self-deal-funded money is
    // still fresh in this balance (stamped by the forfeit/earnings transfer sites
    // for a `selfDeal` booking). Self-deal is a card->cash conversion path; the
    // hold removes the FAST rail, so a standard payout — which only sends once the
    // funds settle — is the way to withdraw them. Standard payout is unaffected.
    if (method === "instant" && sp.instantHoldUntil != null && Date.now() < sp.instantHoldUntil) {
      throw new HttpsError("failed-precondition", PAYOUT_INSTANT_HELD_MESSAGE);
    }

    // LAYER 1. Ahead of the balance check on purpose: the first attempt already
    // spent the balance, so checking it first would refuse the very retry this
    // memo exists to answer.
    const memo = sp.lastPayout;
    if (memo && memo.requestId === requestId) {
      // A replay must be a replay of the SAME request. Stripe's own keys work
      // this way (a key reused with different params is refused, never
      // replayed), and the memo has the two fields it takes to say so — so a
      // mismatch is refused here, with copy the caller can act on, instead of
      // reaching Stripe and coming back as an opaque internal error.
      if (memo.method !== method || memo.amountCents !== amountCents) {
        throw new HttpsError("invalid-argument", PAYOUT_REQUEST_ID_REUSED_MESSAGE);
      }
      return { payoutId: memo.payoutId, feeCents: memo.feeCents, netCents: memo.netCents, replayed: true };
    }

    const stripe = getStripe();
    // As-built contract #4: the INSTANT bucket is a strict subset of the
    // available one (funds still settling are available but not
    // instant-eligible), so an instant payout must be checked against it, not
    // against the standard balance.
    const buckets = await stripe.getBalances(sp.accountId);
    const balance = method === "instant" ? buckets.instantAvailableCents : buckets.availableCents;
    // The GROSS amount is what leaves the balance either way — the instant fee
    // is debited separately, not deducted from what Stripe pays out of it.
    if (amountCents > balance) throw new HttpsError("failed-precondition", PAYOUT_OVER_BALANCE_MESSAGE);

    const payoutKey = `${profileId}:payout:${requestId}`;
    const now = Date.now();

    if (method === "standard") {
      const po = await stripe.createPayout({
        accountId: sp.accountId, amountCents, instant: false,
        idempotencyKey: payoutKey, meta: { profileId, purpose: "payout", requestId },
      });
      await writeLedger({
        kind: "payout_standard", amountCents, bookingId: null, gigId: null,
        profileId, stripeId: po.id, detail: "standard payout (1-3 business days)",
      }).catch((e) => console.error(`requestPayout: payout_standard ledger row failed for ${profileId}`, e));
      await rememberPayoutRequest(profileId, {
        requestId, payoutId: po.id, method, amountCents, feeCents: 0, netCents: amountCents, at: now,
      });
      return { payoutId: po.id, feeCents: 0, netCents: amountCents, replayed: false };
    }

    // Instant: the fee comes out of the requested amount (the musician asks for
    // X and receives X - fee), and the fee itself moves platform-ward as a
    // separate account debit. The $10 minimum (M4) and self-deal hold (M3) were
    // enforced above, before the memo/balance reads.
    //
    // FEE % FROM THE LIVE CONSTANTS, not a snapshot: a payout is not
    // booking-scoped, so no `feePolicy` applies to it. INSTANT_FEE_PCT is the
    // current product price of the convenience at the moment the musician asks
    // for it — unlike a settlement fee, which is priced by the policy frozen
    // onto the booking at accept.
    const feeCents = computeInstantFeeCents(amountCents, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS);
    // computeInstantFeeCents is total-only by design (see its own comment): the
    // "you'd receive nothing" rule is the CALLER's. At the $1 floor and a 4%
    // rate this bites below $1.01, but it is written against the constants
    // rather than a magic threshold so a rate change can never make it wrong.
    if (feeCents >= amountCents) {
      throw new HttpsError("invalid-argument", PAYOUT_AMOUNT_TOO_SMALL_MESSAGE);
    }
    const netCents = amountCents - feeCents;
    const po = await stripe.createPayout({
      accountId: sp.accountId, amountCents: netCents, instant: true,
      idempotencyKey: payoutKey, meta: { profileId, purpose: "payout", requestId },
    });
    await writeLedger({
      kind: "payout_instant", amountCents: netCents, bookingId: null, gigId: null,
      profileId, stripeId: po.id, detail: `instant payout (fee ${feeCents})`,
    }).catch((e) => console.error(`requestPayout: payout_instant ledger row failed for ${profileId}`, e));

    // THE PAYOUT FIRST, THE FEE SECOND, and NEVER an unwind. An instant payout
    // is gone the moment Stripe accepts it, so if this debit fails there is
    // nothing to reverse — the fee is uncollected platform revenue and an
    // operator recovers it (by hand, or netted off a future payout). Failing
    // the CALL here would be worse than useless: the musician's money has
    // already been sent, and an error telling them otherwise would be a lie
    // that invites a retry.
    try {
      const debit = await stripe.debitConnectedAccount({
        accountId: sp.accountId, amountCents: feeCents,
        idempotencyKey: `${profileId}:payoutfee:${requestId}`,
        meta: { profileId, purpose: "payout_fee", requestId, payoutId: po.id },
      });
      await writeLedger({
        // The DEBIT's own id, not the payout's (the plan sketched the payout
        // id): writeLedger's deterministic `{kind}:{stripeId}` id must name the
        // object the row is actually about, and a replayed request replays this
        // same debit — so the row dedupes on a retry either way.
        kind: "account_debit", amountCents: feeCents, bookingId: null, gigId: null,
        profileId, stripeId: debit.id, detail: `instant payout fee (${INSTANT_FEE_PCT}%, min ${INSTANT_FEE_MIN_CENTS}c)`,
      }).catch((e) => console.error(`requestPayout: account_debit ledger row failed for ${profileId}`, e));
    } catch (e) {
      const detail = `instant payout ${po.id} for profile ${profileId} paid out ${netCents}c but the ${feeCents}c`
        + " fee could not be debited from the connected account — the payout is NOT unwound; collect the fee by hand"
        + " (or net it off a future payout)";
      const alertId = payoutFeeAlertId(profileId, requestId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "payout_fee_uncollected", detail, bookingId: null, gigId: null, now,
      });
      if (shouldLog) console.error(`requestPayout: ${detail} (see adminAlerts/${alertId})`, e);
    }

    // Written whether or not the fee landed: the PAYOUT is what a retry must
    // never repeat, and it happened.
    await rememberPayoutRequest(profileId, {
      requestId, payoutId: po.id, method, amountCents, feeCents, netCents, at: now,
    });
    return { payoutId: po.id, feeCents, netCents, replayed: false };
  });

// ---------- the payout webhooks ----------
//
// Both handlers are LEDGER-AND-NOTIFY ONLY — there is no payout document state
// in this codebase to update. The request-time rows above already record that a
// payout was made; these record what became of it.
//
// `metadata.profileId` is attacker-shaped input in exactly the way every other
// SP5 webhook treats it (the payload is signature-verified, never
// shape-validated), so it is validated before it is used to build a doc path.

// Reads and validates the shared shape of both payout events.
function readPayoutEvent(object: Record<string, unknown>): {
  payoutId: string | null; profileId: string | null; amountCents: number;
} {
  const meta = object.metadata as Record<string, string> | undefined;
  const rawProfileId = meta?.profileId;
  return {
    payoutId: typeof object.id === "string" ? object.id : null,
    profileId: typeof rawProfileId === "string" && isValidDocId(rawProfileId) ? rawProfileId : null,
    amountCents: typeof object.amount === "number" ? object.amount : 0,
  };
}

// M1 (branch audit): a payout is created with `stripeAccount`, so payout.paid/
// payout.failed are CONNECTED-ACCOUNT events and Stripe stamps `event.account`
// with the connected account id. Before trusting one to record money (or notify)
// against the profile its metadata names, pin that top-level account to the
// profile's CACHED connected account. Without it, a forged payout event carrying
// a real profileId but a foreign account could write a money-came-back ledger row
// (or fire a notification) for a profile it does not own. Returns false when the
// account is absent or does not match — the caller then no-ops.
async function eventAccountMatchesProfile(account: string | undefined, profileId: string): Promise<boolean> {
  const sp = await getStripeProfileDoc(profileId);
  return account != null && account === sp?.accountId;
}

// NO LEDGER ROW BY DESIGN. `payout.paid` is the expected outcome of a payout
// this file already wrote a `payout_standard`/`payout_instant` row for at
// request time, so a second row here would double-count every successful
// cash-out in any total derived from the ledger. Registered (rather than left
// to the "unknown type" branch) so the event is visibly accounted for and lands
// its `stripeEvents` audit doc.
webhookHandlers["payout.paid"] = async (object, eventId, account) => {
  const { payoutId, profileId, amountCents } = readPayoutEvent(object);
  // M1: pin the connected account when the event names a profile (see
  // eventAccountMatchesProfile). payout.paid only logs, so a mismatch is a
  // logged no-op — but the same threat model as payout.failed applies, and
  // keeping the guard uniform is what stops it drifting.
  if (profileId && !(await eventAccountMatchesProfile(account, profileId))) {
    console.warn(
      `payout.paid: event.account ${account ?? "none"} does not match the cached account for profile ${profileId} — ignored (event ${eventId})`);
    return;
  }
  console.info(
    `payout.paid: payout ${String(payoutId)} (${amountCents}c) for profile ${String(profileId)} completed — already recorded at request time (event ${eventId})`);
};

// THE ONE THAT WRITES. A failed payout means Stripe could not deliver the money
// (a closed bank account, a debit card that rejected the push) and has returned
// it to the connected account's balance — so the ledger needs a row saying the
// money came BACK, or a `payout_standard` row would stand forever as the last
// word on a payout that never landed.
//
// The musician is told, because nothing else would tell them: their balance
// silently going back up looks like a bug, and the fix (repair the bank details
// in Stripe, then cash out again) is theirs to make.
//
// Deliberately does NOT refund the instant fee for a failed instant payout.
// That is a real (small) unfairness and it is left to an operator on purpose:
// Stripe's own instant-payout fee behaves the same way, the amount is bounded
// by INSTANT_FEE_MIN_CENTS at the low end, and an automatic refund here would
// need a credit path to the connected account that SP5 does not have.
webhookHandlers["payout.failed"] = async (object, eventId, account) => {
  const { payoutId, profileId, amountCents } = readPayoutEvent(object);
  if (!payoutId) {
    console.warn(`payout.failed: payload carries no payout id (event ${eventId})`);
    return;
  }
  // M1 (branch audit): when the event names a profile, pin the connected account
  // BEFORE writing a money-came-back row or notifying — see
  // eventAccountMatchesProfile. A payout with NO usable profileId (an operator's
  // own dashboard payout) has no profile to pin to and still records below with
  // profileId:null, exactly as before.
  if (profileId && !(await eventAccountMatchesProfile(account, profileId))) {
    console.warn(
      `payout.failed: event.account ${account ?? "none"} does not match the cached account for profile ${profileId} — ignored, no ledger row written (event ${eventId})`);
    return;
  }
  const failureCode = typeof object.failure_code === "string" ? object.failure_code : null;
  const failureMessage = typeof object.failure_message === "string" ? object.failure_message : null;

  await writeLedger({
    kind: "payout_failed", amountCents, bookingId: null, gigId: null,
    profileId, stripeId: payoutId,
    detail: `payout failed (${failureCode ?? "no code"}${failureMessage ? `: ${failureMessage}` : ""})`
      + " — funds returned to the connected account's balance",
  }).catch((e) => console.error(`payout.failed: ledger row failed for payout ${payoutId} (event ${eventId})`, e));

  if (!profileId) {
    // No usable profile in the metadata (a payout created outside this
    // callable — an operator's dashboard payout, say). The ledger row above is
    // still the record; there is simply nobody to notify.
    console.warn(
      `payout.failed: payout ${payoutId} carries no valid metadata.profileId — ledger row written, nobody notified (event ${eventId})`);
    return;
  }
  try {
    await notifyProfileMembers(profileId, {
      kind: "system",
      title: "Payout failed",
      body: "Your payout couldn't be completed and the funds are back in your balance — check your bank details, then cash out again.",
    });
  } catch (e) {
    // Best-effort, like every other notification in SP5: the ledger row is the
    // durable record and a failed delivery must not fail the event (which would
    // leave Stripe redelivering it forever).
    console.error(`payout.failed: notification failed for profile ${profileId} (event ${eventId})`, e);
  }
};

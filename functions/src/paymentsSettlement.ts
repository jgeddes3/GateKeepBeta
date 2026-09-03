/**
 * SP5 settlement, everything that happens to ONE occurrence's money AFTER the
 * date has been performed: the true-up-aware pricing, the T+3 charge, the
 * earnings transfer, the dunning ladder, delinquency declaration, and the
 * shared post-charge tail that the sweep, the webhook and `payPastDue` all
 * finish through.
 *
 * It also owns ONE deposit-shaped function, `finalizeDepositPayDue`, which is
 * not a drift: it is payPastDue's other half, its two callers (the callable's
 * fake-Stripe path and the `paydue_deposit` webhook purpose) both live here,
 * and it needs the delinquency lift that is the entire point of that path.
 * The generic deposit executor stays in paymentsCore.
 *
 * WHY THIS IS ITS OWN MODULE (Task 10 review, I1): paymentsCore.ts is the
 * money PRIMITIVES layer, the gates, the ledger, the aggregate, the deposit
 * executor, the alert queue. Settlement is a state machine built ON those
 * primitives, and it is the largest single thing in SP5. Keeping them in one
 * file made the primitives hard to find and made every settlement change read
 * as a change to the shared foundations.
 *
 * IMPORT DIRECTION (do not invert any leg):
 *     paymentsSweep     ->  paymentsSettlement  ->  paymentsCore
 *     payments          ->  paymentsSettlement  ->  paymentsCore
 *     bookingLifecycle  ->  paymentsSettlement  ->  paymentsCore
 * paymentsCore must never import this file: it is imported by bookings.ts and
 * scheduled.ts, neither of which has any business pulling in the settlement
 * machine.
 *
 * THE bookingLifecycle LEG IS TASK 12's, and it is narrow on purpose: that file
 * takes exactly two symbols from here, `clawbackSettledOccurrence` (reportNoShow's
 * post-transfer unwind) and `reopenSettlementForRestore` (removeReliabilityMark's
 * re-run of it), because both are settlement state transitions, and a
 * hand-rolled copy of either inside the lifecycle file would be free to drift
 * from the state machine that has to undo and redo them. It adds no cycle:
 * nothing here imports bookingLifecycle, directly or transitively.
 *
 * LOAD-BEARING SIDE EFFECT: the bottom of this file REGISTERS the
 * `payment_intent.succeeded` handlers for the "settlement", "paydue" and
 * "paydue_deposit" purposes, AND (Task 12) the `transfer.reversed` handler,
 * which is the only SP5 webhook handler whose loss would be SILENT, since it
 * writes no document state and nothing downstream waits on it: a reversal made
 * outside our own flow would simply never be recorded anywhere.
 * Those registrations only exist if this module is actually loaded,
 * and nothing imports it for its side effect alone, it is reached from
 * index.ts transitively, via BOTH `paymentsSweep.ts` (which imports
 * chargeSettlement) and `payments.ts` (which imports settlementMath and
 * finalizeSettlementSuccess for payPastDue). If a future refactor ever removes
 * the last of those import edges, the webhook silently stops finalizing
 * settlements: add an explicit `import "./paymentsSettlement.js";` to index.ts
 * rather than assuming the chain still holds.
 */

import { getFirestore } from "firebase-admin/firestore";
import {
  computeEarningsCents, computeFeeShareCents, computeLateFeeSplit, computeSettlementBaseCents,
  resolveFeePolicy, isValidDocId, SETTLEMENT_RETRY_OFFSETS_MS,
} from "@gatekeep/shared";
import type { BookingRequestDoc, GigDoc, PaymentDoc } from "@gatekeep/shared";
import { getStripe, StripeCardDeclinedError, StripePaymentPendingError } from "./stripeClient.js";
import { notifyProfileMembers } from "./notifications.js";
import { paymentIntentSucceededHandlers, webhookHandlers } from "./paymentsWebhook.js";
import {
  clearDelinquencyIfSettled, declareCuratorDelinquent, getStripeProfileDoc, isFailedPrecondition,
  isUnconfirmedPayDueDeposit, recomputePaymentSummary, recordAdminAlert, resolveDepositPending,
  writeLedger, clawbackAlertId, depositPendingAlertId, depositRacedAlertId, settlementPayoutAlertId,
  settlementPendingAlertId, settlementRacedAlertId, IDEMPOTENCY_WINDOW_MS, setSelfDealInstantHold,
} from "./paymentsCore.js";

// How long `payPastDue` parks a `past_due` occurrence's `nextRetryAt` while the
// curator confirms its on-session intent in the browser. Elements confirms in
// MINUTES (or is abandoned outright), so an hour is a generous cover.
//
// Parking rather than nulling is the whole point (review round 1, defect 3b):
// a null `nextRetryAt` removes the doc from the sweep's step-6 query FOREVER,
// so an abandoned pay-now attempt would silently end dunning for that debt and
// nobody would ever hear about it again. Parked, the sweep re-selects the doc
// an hour later, finds the outstanding intent, and, because the intent is
// still there and might yet capture, ESCALATES rather than charging.
export const PAYDUE_CONFIRM_WINDOW_MS = 60 * 60 * 1000;

// What a settlement charge attempt did, from the sweep's point of view.
// "skipped" covers every "nothing to do / not chargeable yet" outcome so the
// sweep's counters stay honest about what actually moved.
export type SettlementChargeOutcome =
  | "skipped" | "charged" | "declined" | "pending" | "waived";

// WHY the run ended where it did. `outcome` is what the sweep buckets;
// `reason` is the detail neither the outcome nor the caller's own state can
// recover.
//
// ONLY THREE OF THESE ARE READ, and the rest are DIAGNOSTIC-ONLY by design,
// they name the exit in logs and in a debugger, and a future caller that needs
// to branch on one already has it rather than having to re-derive the
// distinction from doc state that has since moved. Do not assume a new
// consumer exists for a value just because it is enumerated here.
//   read: "raced"       -> the sweep's `settlementsRaced` counter (a race
//                          reports `skipped`, so the outcome cannot show it);
//         "delinquent"  -> the sweep's `delinquenciesDeclared` counter (a 4th
//                          decline reports `declined`, like the three before);
//         "already_paid"-> the webhook's info-level replay line.
//   diagnostic-only: not_chargeable, missing_docs, stuck_intent,
//         stuck_charging, no_customer, no_account, gig_missing.
export type SettlementRunReason =
  | "not_chargeable"   // the CAS refused: the settlement is already paid/waived/not_due
  | "missing_docs"     // the payment doc, the booking's frozen terms, or the gig is gone
  | "already_paid"     // idempotent re-entry into the finalize tail (a webhook replay)
  | "raced"            // a concurrent writer moved the doc under this run
  | "stuck_intent"     // an intent id is already outstanding, never re-charged
  | "stuck_charging"   // a charge marker older than Stripe's key window, fate unknown
  | "no_customer"      // the curator has no Stripe customer to charge
  | "no_account"       // the musician has no payout account to transfer to
  | "gig_missing"      // the gig doc vanished, the date can no longer be priced
  | "delinquent";      // this decline exhausted the ladder AND newly flagged the profile

// `outcome` alone can't answer "did the musician get paid this run?",
// "charged" covers a settlement whose earnings happened to be zero, and a
// raced finalize can move money without ever reaching a terminal write. The
// sweep counts `transfersMade` off THIS flag, so the counter only ever
// reports transfers that genuinely fired.
export interface SettlementRunResult {
  outcome: SettlementChargeOutcome;
  transferred: boolean;
  reason?: SettlementRunReason;
}

// Positional on purpose (`transferred` before `reason`): every call site that
// carries a transfer is a success path, and every call site that carries a
// reason is a refusal, the two are almost never both interesting at once.
function ran(
  outcome: SettlementChargeOutcome, transferred = false, reason?: SettlementRunReason,
): SettlementRunResult {
  return reason ? { outcome, transferred, reason } : { outcome, transferred };
}

// Every notification in this file is best-effort: by the time anyone is told,
// the money has already moved (or deliberately not), so a failed delivery must
// never abort, or, worse, silently truncate, the path that produced it. Same
// helper shape paymentsSweep.ts uses, for the same reason.
async function notifySafely(
  profileId: string, note: { kind: "booking"; refId: string; title: string; body: string }, context: string,
): Promise<void> {
  try {
    await notifyProfileMembers(profileId, note);
  } catch (e) {
    console.error(`paymentsSettlement: notification failed (${context})`, e);
  }
}

// Everything one occurrence's settlement owes, derived ENTIRELY from
// server-held state: the booking's FROZEN accepted terms, the occurrence's own
// gig duration, the curator-reported true-up on the payment doc, and the
// booking's fee-policy snapshot. No client input reaches this (spec §4), the
// true-up callable writes only validated integer extras, and everything else
// comes off documents only the server writes.
export interface SettlementMath {
  finalBase: number;      // what the date is finally worth (terms + true-up)
  creditsDeposit: boolean;// does the held/applied deposit slice count against it?
  sliceCredit: number;    // the slice actually credited (0 for a refunded deposit)
  due: number;            // finalBase - sliceCredit; NEGATIVE only in the defensive R8 case
  feeShare: number;       // curator commission on `due` (0 when nothing is due)
  lateFee: number;        // Task 11's delinquency fee, once attached
  chargeTotal: number;    // what the card is charged this run
  earnings: number;       // what the musician receives
}

// Exported so `payPastDue` prices its on-session intent through the EXACT
// function the off-session charge uses. A second, hand-rolled "due + fee + late
// fee" at the callable would be free to drift from this one, and the two have
// to agree to the cent: the callable's intent finalizes the very same doc, and
// finalizeSettlementSuccess re-derives `computedCents`/`feeShareCents` from
// here regardless of what was actually charged.
export function settlementMath(p: PaymentDoc, booking: BookingRequestDoc, gig: GigDoc): SettlementMath {
  // resolveFeePolicy, never a hand-rolled fallback (money.ts's own warning):
  // the accept-time snapshot and the default must not drift apart.
  const feePolicy = resolveFeePolicy(booking.feePolicy);
  const terms = booking.acceptedTerms!;
  const finalBase = computeSettlementBaseCents(booking.structure, terms.amountCents, {
    // THIS occurrence's own duration, an occurrence detached from its series
    // template with an edited duration settles on its own (sp4-rulings).
    durationMinutes: gig.durationMinutes,
    extraMinutes: p.settlement.trueUp?.extraMinutes ?? 0,
    songCount: terms.expectedQuantity,
    extraSongs: p.settlement.trueUp?.extraSongs ?? 0,
  });
  // The deposit only counts against the settlement while it is actually the
  // curator's money sitting in escrow. A `refunded` deposit, the post-clawback
  // restore case (Task 12), has already gone back, so the re-run charges the
  // FULL base with no slice credit.
  const creditsDeposit = p.deposit.status === "applied" || p.deposit.status === "held";
  const sliceCredit = creditsDeposit ? p.deposit.sliceCents : 0;
  const due = finalBase - sliceCredit;
  const feeShare = due > 0 ? computeFeeShareCents(due, feePolicy.curatorFeePct) : 0;
  const lateFee = p.settlement.lateFeeCents ?? 0;   // present only once delinquent (Task 11)
  const earnings = computeEarningsCents(finalBase, feePolicy.musicianFeePct)
    + (p.settlement.lateFeeMusicianCents ?? 0);
  return {
    finalBase, creditsDeposit, sliceCredit, due, feeShare, lateFee,
    chargeTotal: due + feeShare + lateFee, earnings,
  };
}

// The defense-in-depth waive (spec §4): a date that no longer belongs to this
// booking is owed nothing, so the settlement is waived and whatever deposit is
// still outstanding goes back. Deliberately identical in shape to the sweep's
// step-4 waive branch, the only difference is WHEN the linkage broke (before
// scheduling vs. after it).
//
// Rule 3 (a staged accept saga's `unpaid` docs are step 1's alone) needs no
// check here: chargeSettlement only ever reaches this for a `pending`/
// `past_due` settlement, and a staged doc's settlement is `not_due`.
async function waiveUnlinkedSettlement(args: {
  bookingId: string; gigId: string; p: PaymentDoc;
  baseline: FirebaseFirestore.Timestamp; now: number;
}): Promise<SettlementRunResult> {
  const { bookingId, gigId, p, baseline, now } = args;
  const ref = getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`);
  const updates: Record<string, unknown> = {
    "settlement.status": "waived", "settlement.nextRetryAt": null,
    // Terminal write ⇒ no charge is in flight any more (a stale marker from an
    // instance that died mid-charge on an earlier run would otherwise linger).
    "settlement.chargingSince": null,
    updatedAt: now,
  };
  let resolvePending = false;
  if (p.deposit.status === "held" || (p.deposit.status === "unpaid" && p.deposit.intentId != null)) {
    // Held escrow, or an unpaid doc whose birth charge is still in flight,
    // goes back through the pending state, so the executor (here, or the
    // sweep's step 2 on a later run if the refund fails) is what actually
    // moves the money.
    updates["deposit.status"] = "refund_pending";
    resolvePending = true;
  } else if (p.deposit.status === "unpaid") {
    // Never charged and nothing in flight: no money to send back.
    updates["deposit.status"] = "refunded";
    updates["deposit.resolvedAt"] = now;
    updates["deposit.depositNextRetryAt"] = null;
  }
  // Every other deposit status is deliberately untouched: `applied` is Task
  // 12's clawback territory, a `*_pending` doc already has an executor, and a
  // terminal one is done. Only the SETTLEMENT is waived for those.
  try {
    await ref.update(updates, { lastUpdateTime: baseline });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // Someone else moved this doc between the read and here. Nothing was
    // charged on this path, so there is no money to account for, leave their
    // decision standing.
    console.warn(`chargeSettlement: ${bookingId}/${gigId} changed under an unlinked-gig waive, left as the racer wrote it`);
    return ran("skipped", false, "raced");
  }
  if (resolvePending) {
    // The executor owns the aggregate AND the delinquency lift for this path
    // (see resolveDepositPending's tail), one place per path, not two.
    await resolveDepositPending(bookingId, gigId);
  } else {
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`chargeSettlement: summary recompute failed for ${bookingId}`, e));
    // The no-executor path: a never-charged deposit went straight to
    // `refunded` above (or there was no deposit left to move). An obligation
    // was still EXTINGUISHED, including, possibly, the exhausted birth
    // deposit that was gating this curator, so the lift belongs here.
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((e) => console.error(`chargeSettlement: delinquency clear failed for ${p.curatorProfileId}`, e));
  }
  return ran("waived");
}

// THE DUNNING LADDER. Every declined settlement charge lands here.
//
// Rungs 1..3 (SETTLEMENT_RETRY_OFFSETS_MS, +1d, +2d, +2d, so roughly days
// 1/3/5) just schedule the next attempt: the occurrence goes `past_due` with
// the attempt recorded, the curator is told, and the sweep's step 6 picks it
// back up when `nextRetryAt` comes due.
//
// The 4th failure DECLARES DELINQUENCY, which is three separate things:
//  1. a 10% LATE FEE attaches to THIS occurrence (split 7/3, 7 of the 10
//     points to the musician, 3 to the platform), computed on the OUTSTANDING
//     amount at the current true-up state. It is not charged now: it rides the
//     next successful charge of this occurrence, because settlementMath adds
//     `lateFeeCents` to the charge and `lateFeeMusicianCents` to the transfer;
//  2. the CURATOR PROFILE is flagged (declareCuratorDelinquent), which gates
//     every future offerGig/acceptBooking until the debt clears;
//  3. `nextRetryAt` goes NULL, the automatic ladder is over. `payPastDue` is
//     the only exit from here, and the delinquency lifts through
//     clearDelinquencyIfSettled once nothing is past_due any more.
//
// `math` is the SAME figures the failed charge was priced from, passed in
// rather than recomputed: the late fee must be a percentage of the amount the
// card actually refused, and the doc is frozen under our `chargingSince` claim
// for exactly as long as it takes to get here.
//
// `baseline` is the payment doc's updateTime from BEFORE the charge attempt:
// a racer (reportNoShow waiving this very occurrence) must not have a
// `past_due` debt, or a late fee, written back over its waive.
export async function recordSettlementFailure(args: {
  bookingId: string; gigId: string; p: PaymentDoc; booking: BookingRequestDoc; math: SettlementMath;
  baseline: FirebaseFirestore.Timestamp; now: number;
}): Promise<SettlementRunResult> {
  const { bookingId, gigId, p, booking, math, baseline, now } = args;
  const ref = getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`);
  const attempts = p.settlement.attempts + 1;

  // ----- rungs 1..3: schedule the next retry -----
  if (attempts <= SETTLEMENT_RETRY_OFFSETS_MS.length) {
    try {
      await ref.update({
        "settlement.status": "past_due", "settlement.attempts": attempts,
        "settlement.nextRetryAt": now + SETTLEMENT_RETRY_OFFSETS_MS[attempts - 1],
        // A decline is a completed Stripe call: nothing is in flight any more,
        // so the true-up window re-opens for the retry. Deliberately leaves
        // `settlement.intentId` untouched (still null), the outstanding-intent
        // guard in chargeSettlement depends on a declined doc never carrying one.
        "settlement.chargingSince": null,
        updatedAt: now,
      }, { lastUpdateTime: baseline });
    } catch (e) {
      if (!isFailedPrecondition(e)) throw e;
      // No money moved on a decline, so there is nothing to account for, and no
      // dunning to do for a settlement that is no longer owed.
      console.warn(`recordSettlementFailure: ${bookingId}/${gigId} changed under a declined charge, dunning skipped`);
      return ran("skipped", false, "raced");
    }
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`recordSettlementFailure: summary recompute failed for ${bookingId}`, e));
    try {
      await notifyProfileMembers(p.curatorProfileId, {
        kind: "booking", refId: bookingId,
        title: "Payment failed",
        body: "A settlement charge was declined: we'll retry, or pay now from the booking page.",
      });
    } catch (e) {
      console.error(`recordSettlementFailure: notification failed for ${bookingId}/${gigId}`, e);
    }
    return ran("declined");
  }

  // ----- the 4th failure: delinquency -----
  // RE-ENTRY GUARD. `delinquentAt` is the explicit marker, and a second pass
  // through this branch must never recompute a late fee ON TOP of the one
  // already attached (the recomputation would price the fee against an
  // outstanding amount that already includes a fee). Unreachable through the
  // sweep, the write below nulls `nextRetryAt`, so step 6 stops finding this
  // doc, but a Task 12 restore re-run, or an operator re-arming a retry, can
  // route a delinquent doc back through a charge. Such a failure records the
  // attempt and nothing else.
  const alreadyDelinquent = p.settlement.delinquentAt != null;
  const feePolicy = resolveFeePolicy(booking.feePolicy);
  // The OUTSTANDING amount is the debt itself, the charge total MINUS any
  // late fee already riding on it (`math.due` is negative only in the R8
  // below-deposit case, which never charges and so never declines).
  const outstanding = Math.max(0, math.due) + math.feeShare;
  const split = computeLateFeeSplit(outstanding, feePolicy.lateFeePct, feePolicy.lateFeeMusicianPct);

  const updates: Record<string, unknown> = {
    "settlement.status": "past_due", "settlement.attempts": attempts,
    // The ladder is over: no more automatic retries. payPastDue is the exit.
    "settlement.nextRetryAt": null,
    "settlement.chargingSince": null,
    updatedAt: now,
  };
  if (!alreadyDelinquent) {
    updates["settlement.lateFeeCents"] = split.lateFeeCents;
    updates["settlement.lateFeeMusicianCents"] = split.musicianCents;
    // The EXPLICIT delinquency marker recomputePaymentSummary keys on.
    // `lateFeeCents` is MONEY, never a flag, a legitimately-zero late fee (a
    // 0-pct policy snapshot) must not read as "not delinquent".
    updates["settlement.delinquentAt"] = now;
  }
  try {
    await ref.update(updates, { lastUpdateTime: baseline });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    console.warn(`recordSettlementFailure: ${bookingId}/${gigId} changed under a declined charge, delinquency skipped`);
    return ran("skipped", false, "raced");
  }
  if (alreadyDelinquent) {
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`recordSettlementFailure: summary recompute failed for ${bookingId}`, e));
    console.warn(
      `recordSettlementFailure: ${bookingId}/${gigId} was already delinquent, attempt ${attempts} recorded, late fee left as it was`);
    return ran("declined");
  }

  // The profile-level flag. `declareCuratorDelinquent` stamps `delinquentSince`
  // ONCE and reports whether THIS call is what declared it, so the counter and
  // the ladder's "newly delinquent" reason only fire on the transition.
  const declared = await declareCuratorDelinquent(p.curatorProfileId, now);
  await writeLedger({
    kind: "late_fee", amountCents: split.lateFeeCents, bookingId, gigId,
    profileId: p.curatorProfileId,
    // Deterministic pseudo-stripeId: a late fee has no Stripe object of its
    // own, and this path can re-enter, writeLedger's `{kind}:{stripeId}`
    // dedupe needs a stable id to keep the audit row unique rather than
    // minting a fresh random-id row on every re-entry.
    stripeId: `latefee:${bookingId}:${gigId}`,
    detail: `late fee (${feePolicy.lateFeePct}% of ${outstanding}c, ${split.musicianCents}c to the musician)`,
  }).catch((e) => console.error(`recordSettlementFailure: late_fee ledger row failed for ${bookingId}/${gigId}`, e));
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`recordSettlementFailure: summary recompute failed for ${bookingId}`, e));
  // BOTH sides are told, and deliberately different things: the curator owes
  // money and is now gated, the musician is owed money and keeps most of the
  // fee. Wrapped INDEPENDENTLY (review round 1): one try/catch around both
  // would let a failure delivering the curator's notice swallow the musician's
  // entirely, and the musician being told their money is late is the half we
  // least want to lose.
  await notifySafely(p.curatorProfileId, {
    kind: "booking", refId: bookingId,
    title: "Payment overdue",
    body: `A ${feePolicy.lateFeePct}% late fee was added and booking is paused for this profile until it's paid.`,
  }, `delinquency ${bookingId}/${gigId}`);
  await notifySafely(p.musicianProfileId, {
    kind: "booking", refId: bookingId,
    title: "Payment delayed",
    body: "The curator's payment is overdue: a late fee (yours to keep most of) was added. We'll keep collecting.",
  }, `delinquency ${bookingId}/${gigId}`);
  return ran("declined", false, declared ? "delinquent" : undefined);
}

// The doc moved under a settlement whose money ALREADY MOVED. Records
// everything that actually moved, the doc fields, AND the ledger rows,
// which are the append-only audit trail and must never be skipped just
// because the state machine took an exceptional exit, then escalates.
//
// TWO shapes, distinguished by whether the transfer had already fired:
//  - PRE-TRANSFER (the common, benign one): the curator was charged and the
//    occurrence was waived under us, but the musician was never paid. The
//    unwind is unambiguous, refund the charge, so the alert says so.
//  - POST-TRANSFER: money moved in BOTH directions against an occurrence
//    that is now waived. Refunding the curator means clawing back the
//    musician (a transfer reversal, Task 12's machinery), so a human decides.
async function recordRacedSettlement(args: {
  bookingId: string; gigId: string;
  curatorProfileId: string; musicianProfileId: string;
  // The charge that was captured, when one was. `amountCents` is what Stripe
  // actually took (never a recomputed figure, the doc's state has moved).
  charge: { intentId: string; amountCents: number | null } | null;
  transfer: { id: string; amountCents: number } | null;
  racedStatus: string; now: number;
}): Promise<void> {
  const { bookingId, gigId, charge, transfer, racedStatus, now } = args;
  // Merge-only, and deliberately WITHOUT `settlement.status`/`deposit.status`
  //, the racer's terminal decision stands (mirrors the sweep's birth-charge
  // raced path). `transfer.*` is not the racer's field: nothing that waives a
  // settlement writes it, so recording the transfer that genuinely happened
  // adds information rather than overwriting any.
  const updates: Record<string, unknown> = { updatedAt: now, "settlement.chargingSince": null };
  if (charge) updates["settlement.intentId"] = charge.intentId;
  if (transfer) {
    updates["transfer.status"] = "transferred";
    updates["transfer.id"] = transfer.id;
    updates["transfer.amountCents"] = transfer.amountCents;
    updates["transfer.transferredAt"] = now;
  }
  await getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`).update(updates)
    .catch((e) => console.error(`chargeSettlement: failed to record raced settlement money for ${bookingId}/${gigId}`, e));

  // The audit rows for money that genuinely moved. Written on the raced path
  // for exactly the same reason the sweep's raced birth charge writes its
  // own: the ledger records what STRIPE did, independently of what state the
  // doc ended up in, and an operator reconciling this alert reads the ledger.
  if (charge && charge.amountCents != null && charge.amountCents > 0) {
    await writeLedger({
      kind: "settlement_charged", amountCents: charge.amountCents, bookingId, gigId,
      profileId: args.curatorProfileId, stripeId: charge.intentId,
      detail: `settlement charge (occurrence raced to "${racedStatus}")`,
    }).catch((e) => console.error(`chargeSettlement: raced settlement_charged ledger row failed for ${bookingId}/${gigId}`, e));
  }
  if (transfer) {
    await writeLedger({
      kind: "earnings_transfer", amountCents: transfer.amountCents, bookingId, gigId,
      profileId: args.musicianProfileId, stripeId: transfer.id,
      detail: `earnings transfer (occurrence raced to "${racedStatus}")`,
    }).catch((e) => console.error(`chargeSettlement: raced earnings_transfer ledger row failed for ${bookingId}/${gigId}`, e));
  }
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`chargeSettlement: summary recompute failed for ${bookingId}`, e));

  const detail = transfer
    ? `charged ${String(charge?.amountCents ?? "?")}c and transferred ${transfer.amountCents}c, then found the occurrence "${racedStatus}": money moved in BOTH directions and the terminal write was refused; unwinding needs a transfer reversal, not a refund`
    : `charged ${String(charge?.amountCents ?? "?")}c but the occurrence is "${racedStatus}": the curator was charged for a date that is no longer owed and NO transfer was made; refund the intent`;
  const alertId = settlementRacedAlertId(bookingId, gigId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "settlement_raced", detail, bookingId, gigId, now,
  });
  if (shouldLog) {
    console.error(
      `chargeSettlement: ${bookingId}/${gigId}, ${detail}; needs admin attention (see adminAlerts/${alertId})`);
  }
}

// The POST-CHARGE tail of a settlement, shared by three callers:
//  - chargeSettlement's synchronous path (the charge just succeeded, or there
//    was nothing to charge because the deposit covered the whole date);
//  - the `payment_intent.succeeded` webhook, when the charge came back
//    `processing` and finalized out-of-band (as-built contract #7);
//  - Task 11's `payPastDue`, whose on-session intent finalizes the same way.
//
// It transfers the musician's earnings, writes the terminal state, the ledger
// rows and the aggregate, and tells the musician. Safe to call zero, one or
// many times: an already-`paid` doc is a no-op, and the earnings transfer's
// idempotency key is attempt-scoped per occurrence, so a redelivery inside
// Stripe's key window replays the original transfer rather than paying twice.
//
// THE `baseline` CONTRACT (Task 10 review, I4, read this before calling):
// PASS A BASELINE UNLESS THE DOC IS PROVABLY FROZEN FOR THE DURATION OF YOUR
// CHARGE. `baseline` is the CAS baseline the terminal write is held to, and
// its job is to span the whole non-transactional window in which YOUR caller
// could have raced someone else. Concretely:
//  - chargeSettlement passes the write time of its pre-charge claim, so the
//    precondition covers the Stripe call itself, anything that touched the
//    doc while the card was being charged is caught BEFORE the musician is
//    paid;
//  - a webhook/callable caller that has done no prior read has nothing to
//    span: its baseline IS this function's own read, so omitting the argument
//    (which falls back to `pSnap.updateTime`) is correct and the pre-transfer
//    equality check below becomes trivially true.
// Omitting it because "it seemed to work" is the failure mode this note
// exists to prevent: a caller that read the doc, did something slow, and then
// called in with no baseline silently loses the race detection entirely.
export async function finalizeSettlementSuccess(args: {
  bookingId: string; gigId: string; intentId: string | null;
  chargeId?: string | null;
  // What Stripe ACTUALLY took, when the caller knows it (the synchronous path
  // always does; the webhook reads it off `amount_received`). Preferred over
  // any recomputed figure for the audit rows, same "Stripe's own word on the
  // money" rule the deposit webhook handler already follows.
  chargedCents?: number | null;
  now: number; baseline?: FirebaseFirestore.Timestamp;
}): Promise<SettlementRunResult> {
  const { bookingId, gigId, intentId, now } = args;
  const db = getFirestore();
  const ref = db.doc(`bookings/${bookingId}/payments/${gigId}`);
  const [pSnap, bookingSnap, gigSnap] = await Promise.all([
    ref.get(), db.doc(`bookings/${bookingId}`).get(), db.doc(`gigs/${gigId}`).get(),
  ]);
  const p = pSnap.data() as PaymentDoc | undefined;
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  const gig = gigSnap.data() as GigDoc | undefined;
  if (!p || !booking?.acceptedTerms || !gig) {
    // A CAPTURED CHARGE with nothing left to record it against, the payment
    // doc, the booking's frozen terms or the gig went away between the charge
    // and this call (a webhook arriving after a profile-deletion cascade is
    // the realistic route). Never a silent return: this is the same class of
    // problem as a raced settlement (money moved, no state records it), and
    // the amount cannot be re-derived without the terms, so the alert IS the
    // record.
    if (intentId) {
      const detail = `settlement intent ${intentId} succeeded but the occurrence can no longer be priced`
        + ` (payment doc ${p ? "present" : "missing"}, acceptedTerms ${booking?.acceptedTerms ? "present" : "missing"},`
        + ` gig ${gig ? "present" : "missing"}): the charge is unrecorded; reconcile it in Stripe`;
      const alertId = settlementRacedAlertId(bookingId, gigId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "settlement_raced", detail, bookingId, gigId, now,
      });
      if (shouldLog) {
        console.error(
          `finalizeSettlementSuccess: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
      }
    }
    return ran("skipped", false, "missing_docs");
  }
  // Idempotence: a redelivered webhook, or a sweep run racing the webhook that
  // finalized the same intent, must not transfer a second time.
  if (p.settlement.status === "paid") return ran("skipped", false, "already_paid");
  if (p.settlement.status !== "pending" && p.settlement.status !== "past_due") {
    // Waived (or otherwise terminal) under us, and a charge exists for it.
    // Caught BEFORE the transfer, so the musician is never paid for a date
    // that was just un-owed; only the charge is recorded, and the escalation
    // is what gets it refunded.
    if (intentId) {
      await recordRacedSettlement({
        bookingId, gigId, curatorProfileId: p.curatorProfileId, musicianProfileId: p.musicianProfileId,
        charge: { intentId, amountCents: args.chargedCents ?? null },
        transfer: null, racedStatus: p.settlement.status, now,
      });
    }
    return ran("skipped", false, "raced");
  }
  // The OTHER half of the pre-transfer race check: the status test above only
  // catches a racer that changed the settlement's state, but the terminal
  // write below is held to `baseline` and will be refused by ANY intervening
  // write. Detecting that here, rather than discovering it after the
  // transfer, is what keeps a lost race from paying the musician for an
  // occurrence whose terminal record can never be written. Only meaningful
  // when the caller supplied a baseline (the synchronous path); a webhook
  // caller's baseline IS this read, so the comparison is trivially true.
  if (args.baseline && !args.baseline.isEqual(pSnap.updateTime!)) {
    if (intentId) {
      await recordRacedSettlement({
        bookingId, gigId, curatorProfileId: p.curatorProfileId, musicianProfileId: p.musicianProfileId,
        charge: { intentId, amountCents: args.chargedCents ?? null },
        transfer: null, racedStatus: `${p.settlement.status} (concurrently rewritten)`, now,
      });
    } else {
      console.warn(
        `finalizeSettlementSuccess: ${bookingId}/${gigId} was rewritten during a zero-charge settlement, left for the next run`);
    }
    return ran("skipped", false, "raced");
  }

  // M2 (branch audit): close the settlement double-PAY window on the paths that
  // do NOT already hold this doc under a pre-charge claim. chargeSettlement's
  // synchronous path, and the fake-Stripe payPastDue path, stamp their own
  // claim and pass its write time as `baseline`, so the earnings transfer below
  // is spanned by that claim and a redelivery INSIDE Stripe's key window replays
  // the ORIGINAL `earn:{attempts}` transfer rather than making a second one. The
  // WEBHOOK (and real, non-fake payPastDue) path holds NO such claim: left
  // unguarded, a redelivery that lands more than IDEMPOTENCY_WINDOW_MS after the
  // original transfer re-derives the SAME attempt-scoped key past 24h, which
  // Stripe treats as brand new, and pays the musician a SECOND time. So this
  // whole block is gated on `!args.baseline`: only the claim-less caller needs
  // it, and a baseline-passing caller can legitimately arrive with a STALE
  // chargingSince left over from an earlier in-flight charge it is now paying
  // past the window (payPastDue's own past-window rescue), its own fresh
  // baseline governs, and applying the stale terminator to it would wrongly
  // refuse a legitimate pay-now.
  let terminalBaseline = args.baseline;
  if (!args.baseline) {
    const finalizeCharging = p.settlement.chargingSince;
    if (finalizeCharging != null && now - finalizeCharging >= IDEMPOTENCY_WINDOW_MS) {
      // The STALE-CLAIM TERMINATOR, verbatim from chargeSettlement: a claim older
      // than Stripe's window means the original attempt's replay handle is gone,
      // so re-transferring would be a genuine second payout. Refuse + escalate,
      // money may already have moved on the original attempt, which is exactly
      // what `settlement_raced` records. Only ever fires on a late (>24h) webhook
      // redelivery whose original finalize never wrote its terminal state.
      const detail = `settlement finalize for intent ${String(intentId)} arrived under a chargingSince claim from `
        + `${new Date(finalizeCharging).toISOString()}, older than Stripe's idempotency window, the original earnings `
        + "transfer can no longer be replayed by its key, so this delivery was NOT re-transferred (that would pay the "
        + "musician twice); reconcile the transfer in Stripe, then clear settlement.chargingSince";
      const alertId = settlementRacedAlertId(bookingId, gigId);
      const shouldLog = await recordAdminAlert({ alertId, kind: "settlement_raced", detail, bookingId, gigId, now });
      if (shouldLog) {
        console.error(`finalizeSettlementSuccess: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
      }
      return ran("skipped", false, "raced");
    }
    if (finalizeCharging == null) {
      // No claim holds this doc yet (the webhook path, whose caller already did
      // its own fresh read, that read IS pSnap). Stamp one via CAS on that read
      // so the transfer below is spanned exactly as the synchronous path's is,
      // and so the terminal write is held to THIS claim rather than to a
      // pSnap.updateTime that predates it.
      try {
        const wr = await ref.update({ "settlement.chargingSince": now }, { lastUpdateTime: pSnap.updateTime! });
        terminalBaseline = wr.writeTime;
      } catch (e) {
        if (!isFailedPrecondition(e)) throw e;
        console.warn(
          `finalizeSettlementSuccess: ${bookingId}/${gigId} changed before its finalize claim could be stamped, left for the next delivery`);
        return ran("skipped", false, "raced");
      }
    }
    // else: chargingSince set but still within the window (the processing-route
    // webhook's original charge claim), proceed, terminalBaseline stays
    // undefined so the terminal write uses pSnap.updateTime, exactly as before.
  }

  const math = settlementMath(p, booking, gig);
  const musicianStripe = await getStripeProfileDoc(p.musicianProfileId);
  if (math.earnings > 0 && !musicianStripe?.accountId) {
    // Unreachable in normal flow (accept is gated on a payout-ready musician).
    // The settlement is NOT flipped terminal, the musician's money must never
    // be dropped by writing `paid` with no transfer behind it, but the CHARGE
    // that already happened is persisted first, so chargeSettlement's
    // unconditional outstanding-intent guard covers this doc from the very
    // next run and it can never be charged a second time. Recovery is the
    // payment_intent.succeeded webhook for this same intent (which re-enters
    // here and completes once the account exists), or an operator working the
    // `settlement_pending_stuck` alert that guard raises.
    const rescue: Record<string, unknown> = { "settlement.chargingSince": null, updatedAt: now };
    if (intentId) rescue["settlement.intentId"] = intentId;
    await ref.update(rescue)
      .catch((we) => console.error(`finalizeSettlementSuccess: failed to record intent ${String(intentId)} on ${bookingId}/${gigId}`, we));
    console.error(
      `finalizeSettlementSuccess: no Stripe account for ${p.musicianProfileId}, ${bookingId}/${gigId} left unsettled${intentId ? ` with intent ${intentId} recorded` : ""}`);
    // Task 10 review, M1: ESCALATE the null-intent case. With an intent id
    // recorded, the next run's outstanding-intent guard raises
    // `settlement_pending_stuck` and an operator sees it there. With NO intent
    //, a zero-charge settlement whose deposit already covered the whole date,
    // so there is nothing for the guard to catch, the doc simply stays
    // `pending`/`past_due` and every hourly run retries it silently, forever,
    // while the musician is owed money nobody is told about. This row is the
    // only signal that exists for that shape.
    if (!intentId) {
      const detail = `the musician profile ${p.musicianProfileId} has no Stripe payout account, so ${math.earnings}c of`
        + " earnings cannot be transferred; the settlement is left unsettled and retried every run."
        + " Nothing is stuck in Stripe, the fix is the musician finishing (or repairing) Express onboarding";
      const alertId = settlementPayoutAlertId(bookingId, gigId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "settlement_payout_blocked", detail, bookingId, gigId, now,
      });
      if (shouldLog) {
        console.error(
          `finalizeSettlementSuccess: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
      }
    }
    return ran("skipped", false, "no_account");
  }

  // SP10 Task 3 (sp5 #1): a transfer may draw on a charge (source_transaction)
  // ONLY when it fits inside that charge. Stripe caps a sourced transfer at
  // the source charge's amount, cumulatively with every earlier transfer
  // sourced from it. The earnings transfer (98% of the FULL base) never fits
  // inside the settlement charge (65% of the base plus its fee share), so the
  // standard settlement draws on the platform balance; the deposit charge is
  // days old and available by T+3, which is what makes the unsourced transfer
  // safe. A zero-charge settlement (the deposit covered the whole date) draws
  // on the deposit's charge when the doc knows that charge's amount; a legacy
  // doc that does not falls back to the unsourced transfer.
  const sourceCandidate: { id: string; amountCents: number } | null = args.chargeId
    ? { id: args.chargeId, amountCents: args.chargedCents ?? math.chargeTotal }
    : (math.chargeTotal === 0 && p.deposit.chargeId && p.deposit.chargeAmountCents != null)
      ? { id: p.deposit.chargeId, amountCents: p.deposit.chargeAmountCents }
      : null;
  const sourceChargeId = sourceCandidate && math.earnings <= sourceCandidate.amountCents ? sourceCandidate.id : null;
  const transfer = math.earnings > 0
    ? await getStripe().transferToAccount({
      accountId: musicianStripe!.accountId!, amountCents: math.earnings,
      // Attempt-scoped like the charge key: Task 12's restore re-run bumps
      // `settlement.attempts` when it re-opens a clawed-back settlement, and
      // without that the transfer key would silently replay the consumed
      // original and no money would move.
      idempotencyKey: `${bookingId}:${gigId}:earn:${p.settlement.attempts}`,
      meta: { bookingId, gigId, purpose: "earnings" },
      ...(sourceChargeId ? { sourceChargeId } : {}),
    })
    : null;

  // Set when the absorption below is REFUSED because the deposit still carries
  // an intent of unknown fate; escalated after the terminal write lands (there
  // is no point raising a ticket for a write that then loses its race).
  let absorbedIntentBlocked: string | null = null;
  const updates: Record<string, unknown> = {
    "settlement.status": "paid",
    // Never negative: the R8 below-deposit case refunds the difference rather
    // than recording a negative obligation.
    "settlement.computedCents": Math.max(0, math.due),
    "settlement.feeShareCents": math.feeShare,
    "settlement.intentId": intentId ?? p.settlement.intentId ?? null,
    "settlement.nextRetryAt": null,
    // Terminal: nothing is in flight any more.
    "settlement.chargingSince": null,
    updatedAt: now,
  };
  // ONLY when the deposit actually funded part of this settlement. A deposit
  // that was refunded (Task 12's clawback, then a restore re-run) stays
  // `refunded`, "applied" would claim escrow that no longer exists.
  if (math.creditsDeposit) {
    updates["deposit.status"] = "applied";
    updates["deposit.resolvedAt"] = now;
  } else if (p.deposit.status === "unpaid"
    && (p.deposit.intentId == null || isUnconfirmedPayDueDeposit(p.deposit))) {
    // THE SETTLEMENT ABSORBED THE DEPOSIT (review round 2, D1). An `unpaid`
    // deposit contributes no slice credit (settlementMath's `creditsDeposit` is
    // false), so `due` is the FULL base, the curator has just been charged the
    // entire value of the date, deposit included. The deposit obligation is
    // therefore discharged, and saying so is not bookkeeping tidiness:
    // `clearDelinquencyIfSettled` measures deposit debt as "still `unpaid` with
    // an exhausted attempt counter", so a doc left `unpaid` here is a PHANTOM
    // debt that gates the curator forever, for a date they demonstrably paid
    // in full (DepositStatus's closing invariant: `unpaid` is a debt-query
    // answer, not a resting state). `refunded` is the terminal state for "no
    // escrow of ours is outstanding", exactly as both waive branches use it for
    // a never-charged deposit; no money moves, because none ever did.
    //
    // AN UNCONFIRMED PAY-NOW INTENT COUNTS AS NO INTENT (review round 3, I1),
    // through the same shared predicate resolveDepositPending uses: the curator
    // created it and walked away, nothing was ever captured against it, and it
    // is no more a reason to leave a phantom debt standing than an empty field
    // is. Retiring the doc here is what stops "tried to pay, gave up, then the
    // date settled in full" from being a permanent gate.
    updates["deposit.status"] = "refunded";
    updates["deposit.resolvedAt"] = now;
    updates["deposit.depositNextRetryAt"] = null;
  } else if (p.deposit.status === "unpaid") {
    // The remainder: an `unpaid` deposit carrying an intent whose fate we do
    // NOT know, a birth charge left `processing`, or one recorded by a raced
    // path. It is deliberately left alone (that intent can still capture, and
    // declaring the deposit resolved under a live charge would strand real
    // money with nothing recording it), but NOT left silent. The doc now sits
    // in exactly the state clearDelinquencyIfSettled reads as outstanding debt,
    // so falling through quietly would gate the curator with no ticket
    // explaining why and nothing that ever clears it.
    absorbedIntentBlocked = p.deposit.intentId;
  }
  if (transfer) {
    updates["transfer.status"] = "transferred";
    updates["transfer.id"] = transfer.id;
    updates["transfer.amountCents"] = math.earnings;
    updates["transfer.transferredAt"] = now;
  }
  try {
    // M2 (branch audit): held to `terminalBaseline`, args.baseline for a
    // caller that supplied one, else the write time of the chargingSince claim
    // this function just stamped (so the precondition spans the transfer above),
    // falling back to pSnap.updateTime only when neither applies.
    await ref.update(updates, { lastUpdateTime: terminalBaseline ?? pSnap.updateTime! });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // The residual window the pre-transfer check above cannot close: a racer
    // that landed DURING the transfer itself. Money moved in both directions;
    // recordRacedSettlement writes the audit rows and escalates.
    await recordRacedSettlement({
      bookingId, gigId, curatorProfileId: p.curatorProfileId, musicianProfileId: p.musicianProfileId,
      // `chargedCents ?? null`, never the recomputed `math.chargeTotal`: the
      // doc's state has moved under us, so a re-derived figure could disagree
      // with what Stripe actually took, and the interface's rule is that null
      // means "we don't know", which is a truthful audit row's absence rather
      // than a plausible-looking wrong one. All three raced branches agree.
      charge: intentId ? { intentId, amountCents: args.chargedCents ?? null } : null,
      transfer: transfer ? { id: transfer.id, amountCents: math.earnings } : null,
      racedStatus: "waived/rewritten mid-transfer", now,
    });
    return ran("skipped", transfer != null, "raced");
  }

  const chargedCents = args.chargedCents ?? math.chargeTotal;
  if (intentId && chargedCents > 0) {
    await writeLedger({
      kind: "settlement_charged", amountCents: chargedCents, bookingId, gigId,
      profileId: p.curatorProfileId, stripeId: intentId, detail: "settlement charge",
    }).catch((e) => console.error(`finalizeSettlementSuccess: settlement_charged ledger row failed for ${bookingId}/${gigId}`, e));
  }
  if (transfer) {
    await writeLedger({
      kind: "earnings_transfer", amountCents: math.earnings, bookingId, gigId,
      profileId: p.musicianProfileId, stripeId: transfer.id,
      sourced: sourceChargeId != null,
      detail: sourceChargeId
        ? "earnings transfer (net of the musician fee, incl. any late-fee share), sourced from the charge"
        : "earnings transfer (net of the musician fee, incl. any late-fee share), drawn on the platform balance",
    }).catch((e) => console.error(`finalizeSettlementSuccess: earnings_transfer ledger row failed for ${bookingId}/${gigId}`, e));
    // Owner ruling (M3): a self-deal settlement is card->cash to the same person
    //, hold INSTANT payout of the earnings just transferred (standard payout
    // after the funds settle is unaffected). Best-effort tail step, like the rest.
    if (p.selfDeal) await setSelfDealInstantHold(p.musicianProfileId, now);
  }
  if (absorbedIntentBlocked) {
    // The settlement absorbed this deposit's value, but the deposit itself
    // could not be retired because a charge of unknown fate is attached to it.
    // The curator is now gated by a debt that nothing in the system will ever
    // clear on its own, so this is a genuine "a human must look" condition
    // rather than a log line: the operator resolves the intent in Stripe
    // (refund it, the money for this date has already been collected in full
    // by the settlement charge) and clears `deposit.intentId`, after which the
    // next money event lifts the delinquency.
    const detail = `the settlement charged the FULL base (${math.due}c + ${math.feeShare}c fee), absorbing this date's`
      + ` deposit, but the deposit still carries intent ${absorbedIntentBlocked} of unknown outcome, so it could not be`
      + " retired and still reads as outstanding deposit debt. Resolve that intent in Stripe (the date is paid in full"
      + " already), then clear deposit.intentId";
    const alertId = depositPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "deposit_pending_stuck", detail, bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(`finalizeSettlementSuccess: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
    }
  }
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`finalizeSettlementSuccess: summary recompute failed for ${bookingId}`, e));
  // A successful settlement may have been the LAST outstanding obligation of a
  // delinquent curator, but only a query over the whole obligation set can say
  // so, which is why the lifting lives in its own function rather than in the
  // terminal write above. Placed AFTER that write on purpose: the query must
  // not still see THIS doc as `past_due`. Best-effort like every other tail
  // step, the money has already moved, and a profile left flagged one run too
  // long is a gate that re-opens on the next settlement, never a wrong money
  // record.
  await clearDelinquencyIfSettled(p.curatorProfileId, now)
    .catch((e) => console.error(`finalizeSettlementSuccess: delinquency clear failed for ${p.curatorProfileId}`, e));
  try {
    await notifyProfileMembers(p.musicianProfileId, {
      kind: "booking", refId: bookingId,
      title: "You've been paid",
      body: "A settlement landed in your balance, cash out from your Earnings page.",
    });
  } catch (e) {
    // Best-effort: the money has already moved, so a failed delivery must
    // never surface as a settlement failure.
    console.error(`finalizeSettlementSuccess: notification failed for ${bookingId}/${gigId}`, e);
  }
  return ran("charged", transfer != null);
}

// The T+3 (or dunning-retry) settlement move for ONE occurrence: compute the
// final amount from the frozen terms + the curator's true-up + the gig's own
// duration, charge `final − deposit slice` + commission (+ any late fee), then
// transfer the musician's earnings. Returns what happened so the sweep can
// count it.
//
// Safe to call zero, one or many times for the same (bookingId, gigId): the
// CAS at the top acts only on `pending`/`past_due`, and every Stripe key is
// attempt-scoped, so a re-run inside the idempotency window replays rather
// than re-charging.
//
// NEVER GATED ON THE PARENT BOOKING'S STATUS (sweep rule 1). A cancelled,
// expired or completed booking can still own a past-start occurrence that
// legitimately settles, the musician performed that night; only the paperwork
// moved on. The defense-in-depth check is the GIG's own linkage, never
// `booking.status`.
export async function chargeSettlement(
  params: { bookingId: string; gigId: string; now: number },
): Promise<SettlementRunResult> {
  const { bookingId, gigId, now } = params;
  const db = getFirestore();
  const ref = db.doc(`bookings/${bookingId}/payments/${gigId}`);

  // --- PHASE 1: READ ---------------------------------------------------
  // FRESH reads: the sweep hands this function ids, not snapshots, and by the
  // time a doc's turn comes the page it arrived in can be minutes old, and
  // this CHARGES A CARD off what it reads.
  const [pSnap, bookingSnap, gigSnap] = await Promise.all([
    ref.get(), db.doc(`bookings/${bookingId}`).get(), db.doc(`gigs/${gigId}`).get(),
  ]);
  const p = pSnap.data() as PaymentDoc | undefined;
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  const gig = gigSnap.data() as GigDoc | undefined;
  if (!p || !booking?.acceptedTerms) return ran("skipped", false, "missing_docs");

  // --- PHASE 2: REFUSALS (nothing below this block may charge) ---------
  // THE CAS. Anything else, already `paid` (a racer, or the webhook, got
  // here first), `waived`, or `not_due` (its date hasn't been resolved yet),
  // is deliberately untouched.
  if (p.settlement.status !== "pending" && p.settlement.status !== "past_due") {
    return ran("skipped", false, "not_chargeable");
  }

  // THE OUTSTANDING-INTENT TERMINATOR. A settlement that already carries an
  // intent id has a real charge attached to it, one left `processing`, or one
  // that succeeded against a doc a racer moved. It must NEVER be charged
  // again: that intent can still succeed (or already has), so a fresh-key
  // retry, which is exactly what a re-run becomes once Stripe's 24h
  // idempotency window closes (see IDEMPOTENCY_WINDOW_MS), is a real SECOND
  // charge on the curator's card. The ways out are the
  // payment_intent.succeeded webhook finalizing it, or an operator cancelling
  // /refunding the intent in Stripe; either way this loop just waits.
  //
  // UNCONDITIONAL on the settlement status, deliberately. Dunning retries are
  // unaffected because a declined settlement never carries an intent id
  // (recordSettlementFailure writes status/attempts/nextRetryAt and leaves
  // `settlement.intentId` alone). The FIVE writers of that field are:
  //  1. the pending branch below (a charge left `processing`);
  //  2. the terminal `paid` write in finalizeSettlementSuccess;
  //  3. its no-payout-account rescue write, which records the charge on a doc
  //     that STAYS `pending`/`past_due`, the shape this guard then covers;
  //  4. recordRacedSettlement, which can stamp an intent id onto a `past_due`
  //     doc whose `nextRetryAt` is still live, and which a `pending`-only guard
  //     would sail straight past into a second charge;
  //  5. Task 11's `payPastDue`.
  //
  // HOW payPastDue COOPERATES (this task's resolution of the old TODO): it
  // persists its on-session intent id here AND parks `nextRetryAt` one
  // confirmation window out (PAYDUE_CONFIRM_WINDOW_MS) in the same write. The
  // park is what keeps step 6 from charging the card off-session while the
  // curator is confirming in the browser, WITHOUT removing the doc from the
  // sweep's sight permanently, an abandoned attempt therefore comes back
  // here an hour later and gets escalated instead of disappearing. A curator
  // who simply retries gets the SAME intent back (the key is deterministic per
  // attempt), and `payDueIntentId` is what lets payPastDue prove the
  // outstanding intent is its own to replace, an off-session settlement
  // intent is refused instead.
  //
  // THE RESTORE RE-RUN'S OBLIGATIONS TO THIS GUARD (Task 12, now implemented
  // in reopenSettlementForRestore below, this note is the contract it keeps):
  // re-opening a clawed-back settlement must clear `settlement.intentId` AND
  // bump `settlement.attempts`, without the clear this guard refuses the
  // re-run outright, and without the bump its `settle:`/`earn:` keys replay
  // consumed ones and no money moves. It must NOT clear
  // `settlement.payDueIntentId`, and that is deliberate rather than an
  // oversight (traced): the field is only ever READ as a comparison against a
  // live `intentId` (here, and in payPastDue's only-mine-is-replaceable
  // guard), so once `intentId` is null a stale mirror is inert, both readers
  // are gated on `intentId != null` first. Clearing it would in fact be worse
  // than leaving it: the bumped `attempts` gives payPastDue a fresh key, so a
  // post-restore pay-now mints a NEW intent and overwrites both fields
  // together, and until then the stale value is the only surviving record of
  // which intent the pre-clawback attempt used.
  if (p.settlement.intentId != null) {
    // WHOSE intent is it? An ABANDONED PAY-NOW attempt is a different problem
    // from a stuck off-session charge, and it needs a different instruction:
    // payPastDue minted an on-session intent the curator never confirmed, and
    // parked `nextRetryAt` an hour out precisely so this run would find it
    // (see PAYDUE_CONFIRM_WINDOW_MS). The intent is almost certainly dead, but
    // "almost certainly" is not a licence to charge, it can still be
    // confirmed from a tab left open, so this refuses like any other
    // outstanding intent and tells the operator the specific unwind.
    //
    // THE PROPER FIX IS `StripeLike.cancelIntent` (future): with it, this
    // branch could cancel the abandoned intent itself and clear
    // `settlement.intentId`, returning the occurrence to the dunning ladder
    // with no human involved. StripeLike has no cancel surface yet, so the
    // implemented behavior is REFUSE + ESCALATE, the same posture step 2's
    // stale-pending guard takes for its own missing Stripe surface.
    const abandonedPayDue = p.settlement.payDueIntentId != null
      && p.settlement.intentId === p.settlement.payDueIntentId
      && (p.settlement.nextRetryAt == null || now >= p.settlement.nextRetryAt);
    const detail = abandonedPayDue
      ? `"${p.settlement.status}" settlement carries pay-now intent ${p.settlement.intentId}, unconfirmed past its`
        + " confirmation window, abandoned pay-now attempt: cancel the intent in Stripe, then clear"
        + " settlement.intentId to hand the date back to the dunning ladder. NEVER re-charged while it stands"
      : `"${p.settlement.status}" settlement already carries intent ${p.settlement.intentId}, never re-charged; finalize it via the webhook or resolve the intent in Stripe`;
    if (abandonedPayDue) {
      // ...AND GATE, not merely alert (review round 2). Without this, "start a
      // pay-now and walk away" is a way OUT of delinquency: payPastDue parks
      // the retry clock, the ladder stops, and the curator books on. The flag
      // alone is the right sanction, deliberately NO late fee, because the
      // dunning ladder has not been exhausted (recordSettlementFailure owns
      // that, and only on a real 4th decline). Idempotent and
      // `delinquentSince`-preserving, so re-running every hour never re-stamps
      // the clock an operator reads; lifting works exactly as it does for any
      // other debt, once this occurrence is paid or extinguished.
      await declareCuratorDelinquent(p.curatorProfileId, now)
        .catch((e) => console.error(`chargeSettlement: failed to flag ${p.curatorProfileId} over an abandoned pay-now attempt`, e));
    }
    const alertId = settlementPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "settlement_pending_stuck", detail, bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} is "${p.settlement.status}" but holds intent ${p.settlement.intentId}, not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    return ran("pending", false, "stuck_intent");
  }

  // THE STALE-CLAIM TERMINATOR (Task 10 review, I2, the blind spot the guard
  // above cannot see). `chargingSince` set with NO intent id means an instance
  // died between claiming this doc and recording what its Stripe call did.
  // Inside the idempotency window that is harmless: the next run re-derives
  // the SAME attempt-scoped key, so Stripe replays the original outcome rather
  // than charging again, and the claim write below simply overwrites the
  // marker. PAST the window the key is brand new, so the "retry" is a genuine
  // SECOND charge for a first charge whose fate nobody knows, the curator may
  // already have paid.
  //
  // So this refuses, permanently, and hands the occurrence to a human: the
  // answer lives in the Stripe dashboard (was there a charge under that
  // customer for this amount?), and the operator either refunds it and clears
  // `chargingSince`, or records the intent id on the doc so the webhook path
  // finalizes it. Reported as "pending" rather than "declined" because nothing
  // was declined, a charge is (or was) outstanding and its fate is unknown,
  // which is exactly what the "pending" bucket means to the sweep.
  const charging = p.settlement.chargingSince;
  if (charging != null && now - charging >= IDEMPOTENCY_WINDOW_MS) {
    const alertId = settlementPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "settlement_pending_stuck",
      detail: `"${p.settlement.status}" settlement was claimed for a charge at ${new Date(charging).toISOString()}`
        + " and never recorded an intent: the claim is older than Stripe's idempotency window, so a retry would no"
        + " longer replay the original attempt. NOT re-charged: check Stripe for a charge on this customer, then"
        + " either refund it and clear settlement.chargingSince, or record its intent id so the webhook finalizes it",
      bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} has a stale chargingSince (${new Date(charging).toISOString()}) with no intent, not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    return ran("pending", false, "stuck_charging");
  }

  // RATIFIED ORDERING (review round 2, O1): this guard sits BEFORE the
  // unlinked-gig waive, so an occurrence whose gig was reopened while a charge
  // is outstanding is NOT auto-waived and its deposit is NOT auto-refunded.
  // Refunding escrow while a live intent can still land would leave the
  // curator charged for a date the system has already declared owed nothing,
  // the money question outranks the linkage question. The
  // `settlement_pending_stuck` alert above is the discovery route.
  if (!gig) {
    // The gig doc is gone outright (deleteProfile's cascade). Its duration is
    // what prices this date, so there is nothing to charge, and deliberately
    // no automatic waive either: forgiving a real, already-scheduled debt is
    // an operator's call, not this function's. The sweep's step 4 already
    // waives a vanished gig BEFORE scheduling, so reaching here means the doc
    // disappeared afterwards, which is an anomaly worth a log every run.
    console.error(`chargeSettlement: ${bookingId}/${gigId}, the gig doc is gone; cannot price the settlement, left for an operator`);
    // M5 (branch audit): a DURABLE row, not only a per-run log, SP5's "never
    // refuse silently" rule. An unpriceable settlement retried every hour behind
    // nothing but a console line is a musician owed money nobody is told about.
    // Reuses settlementPendingAlertId (one row per occurrence, updated in place);
    // the detail names the real condition, since the kind vocabulary has no
    // "gig vanished" member.
    const gigMissingDetail = "the gig doc has vanished, so this settlement can no longer be priced and is left"
      + ` unresolved, retried every run. Decide the unwind by hand (waive it, or restore the gig) on`
      + ` bookings/${bookingId}/payments/${gigId}`;
    const gigMissingAlertId = settlementPendingAlertId(bookingId, gigId);
    await recordAdminAlert({ alertId: gigMissingAlertId, kind: "settlement_pending_stuck", detail: gigMissingDetail, bookingId, gigId, now })
      .catch((ae) => console.error(`chargeSettlement: failed to record gig-missing alert for ${bookingId}/${gigId}`, ae));
    return ran("skipped", false, "gig_missing");
  }
  // Defense in depth (spec §4): a date that no longer belongs to this booking
  // settles waived. Note this reads the GIG's linkage, never booking.status.
  if (gig.bookingId !== bookingId || gig.status !== "filled") {
    // The read's own updateTime is a sufficient CAS baseline here: no Stripe
    // call precedes this write.
    if (!pSnap.updateTime) return ran("skipped", false, "raced");
    return await waiveUnlinkedSettlement({ bookingId, gigId, p, baseline: pSnap.updateTime, now });
  }

  // --- PHASE 3: CLAIM (persist before the charge) ----------------------
  // The same idiom the sweep's birth deposit uses for `depositAttempts`. Two
  // things this write buys, both about the non-transactional gap the Stripe
  // call opens:
  //   1. it CLOSES THE TRUE-UP WINDOW before the amount is computed,
  //      confirmOccurrenceActuals refuses while `chargingSince` is live, so a
  //      curator cannot add extra minutes to a charge that is already in
  //      flight and have the settlement then record an amount that was never
  //      charged;
  //   2. its write time is the CAS baseline for the terminal write, so the
  //      precondition spans the charge itself. Taking the baseline from the
  //      WRITE (rather than the read) also means the window between reading
  //      and claiming the doc is covered by the write's own precondition.
  //
  // `chargingSince` ONLY, deliberately not `updatedAt` (the same call
  // recomputePaymentSummary makes, and for the same reason: a field that
  // exists to carry a timestamp does not need a second one written beside
  // it, and the CAS baseline comes from `wr.writeTime` either way). It also
  // keeps the sweep's `updatedAt`-as-"first seen in this state" proxy honest
  //, see the enumeration at the top of paymentsSweep.ts, which is only true
  // while nothing incidental bumps that field.
  let baseline: FirebaseFirestore.Timestamp;
  try {
    const wr = await ref.update(
      { "settlement.chargingSince": now },
      { lastUpdateTime: pSnap.updateTime! });
    baseline = wr.writeTime;
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // A racer moved the doc between the read and the claim. Nothing has been
    // charged, so there is nothing to account for, the next run re-reads.
    console.warn(`chargeSettlement: ${bookingId}/${gigId} changed before its charge could be claimed, left for the next run`);
    return ran("skipped", false, "raced");
  }

  // --- PHASE 4: MOVE MONEY ---------------------------------------------
  const math = settlementMath(p, booking, gig);
  // Starts null unconditionally, the outstanding-intent guard above has
  // already proved `p.settlement.intentId` is null by this point, so there is
  // no prior intent to carry forward.
  let intentId: string | null = null;
  let chargeId: string | null = null;
  let chargedCents: number | null = null;

  if (math.due < 0) {
    // R8, the defensive below-deposit rule (spec §4): UNREACHABLE with
    // increase-only true-ups (the slice is a fraction of the base, and the
    // base only grows), so this exists so that a future change which makes it
    // reachable refunds the difference instead of silently charging a negative
    // amount. `lateFee` cannot coexist with it, a late fee only attaches
    // after a failed charge, which requires something to have been due.
    if (p.deposit.intentId) {
      const r = await getStripe().refund({
        intentId: p.deposit.intentId, amountCents: -math.due,
        idempotencyKey: `${bookingId}:${gigId}:settle-down`,
        meta: { bookingId, gigId, purpose: "below_deposit_refund" },
      });
      await writeLedger({
        kind: "refund", amountCents: -math.due, bookingId, gigId,
        profileId: p.curatorProfileId, stripeId: r.id, detail: "below-deposit settlement refund",
      }).catch((e) => console.error(`chargeSettlement: below-deposit refund ledger row failed for ${bookingId}/${gigId}`, e));
    } else {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} settles below its deposit slice but the deposit was never charged, nothing to refund`);
    }
  } else if (math.chargeTotal > 0) {
    const curatorStripe = await getStripeProfileDoc(p.curatorProfileId);
    if (!curatorStripe?.customerId) {
      console.error(`chargeSettlement: curator ${p.curatorProfileId} has no Stripe customer, ${bookingId}/${gigId} not charged`);
      // Release the claim: no charge is in flight, so the true-up window must
      // re-open rather than stay shut until the marker ages out.
      await ref.update({ "settlement.chargingSince": null, updatedAt: now })
        .catch((we) => console.error(`chargeSettlement: failed to clear chargingSince on ${bookingId}/${gigId}`, we));
      // M5 (branch audit): durable escalation, same rule as the gig-missing
      // branch above, a settlement that can never charge (the curator profile
      // has no Stripe customer at all, normally unreachable, since accept is
      // gated on a chargeable curator) must surface as a row an operator works,
      // not just an hourly log line. Reuses settlementPendingAlertId; the detail
      // states the real "no customer to charge" condition.
      const noCustomerDetail = `the curator profile ${p.curatorProfileId} has no Stripe customer, so this settlement`
        + " cannot be charged and is left unresolved, retried every run: the fix is the curator (re)saving a card;"
        + " normally unreachable because accept is gated on a chargeable curator, so this is a genuine anomaly";
      const noCustomerAlertId = settlementPendingAlertId(bookingId, gigId);
      await recordAdminAlert({ alertId: noCustomerAlertId, kind: "settlement_pending_stuck", detail: noCustomerDetail, bookingId, gigId, now })
        .catch((ae) => console.error(`chargeSettlement: failed to record no-customer alert for ${bookingId}/${gigId}`, ae));
      return ran("skipped", false, "no_customer");
    }
    try {
      const r = await getStripe().chargeOffSession({
        customerId: curatorStripe.customerId, amountCents: math.chargeTotal,
        // ATTEMPT-SCOPED (as-built contract #2): both real Stripe and the fake
        // CACHE a decline under its key, so a retry after a decline must carry
        // a different one or it replays the decline forever. A crash between
        // the charge and recording it re-derives the SAME key next run, which
        // is what makes the replay safe.
        idempotencyKey: `${bookingId}:${gigId}:settle:${p.settlement.attempts}`,
        meta: { bookingId, gigId, purpose: "settlement" },
      });
      intentId = r.id;
      chargeId = r.chargeId;
      chargedCents = math.chargeTotal;
    } catch (e) {
      if (e instanceof StripePaymentPendingError) {
        // Not a failure: the intent exists and is settling, and a same-key
        // retry is IMPOSSIBLE for it (the cached `processing` outcome replays
        // forever, as-built contract #7). Persist the handle, leave the
        // settlement exactly as it is, and let payment_intent.succeeded run
        // finalizeSettlementSuccess out-of-band. `chargingSince` stays set on
        // purpose: a charge really is outstanding, and the guard at the top of
        // this function keeps every later run from touching it.
        await ref.update({ "settlement.intentId": e.intentId, updatedAt: now })
          .catch((we) => console.error(`chargeSettlement: failed to record pending intent ${e.intentId} on ${bookingId}/${gigId}`, we));
        return ran("pending", false, "stuck_intent");
      }
      if (e instanceof StripeCardDeclinedError) {
        return await recordSettlementFailure({ bookingId, gigId, p, booking, math, baseline, now });
      }
      throw e;
    }
  }
  // else: a ZERO-charge settlement, the deposit slice covered the whole date
  // exactly. Nothing to charge, but the musician is still owed their earnings,
  // so this falls through to the same tail as a charged one.

  // --- PHASE 5: FINALIZE ------------------------------------------------
  return await finalizeSettlementSuccess({
    bookingId, gigId, intentId, chargeId, chargedCents, now, baseline,
  });
}

// ---------- Task 12: the post-transfer clawback and its re-run ----------

// ONE ticket for every way the clawback can fail to bring the money back, see
// clawbackAlertId's own note in paymentsCore.ts for the full raiser list (this
// file owns three of the four; the restore leg in bookingLifecycle owns the
// fourth) and why they deliberately share a row.
async function raiseClawbackAlert(
  bookingId: string, gigId: string, detail: string, now: number,
): Promise<void> {
  const alertId = clawbackAlertId(bookingId, gigId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "clawback_failed", detail, bookingId, gigId, now,
  });
  if (shouldLog) {
    console.error(`clawbackSettledOccurrence: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
  }
}

// UNWINDS AN OCCURRENCE WHOSE MONEY HAS ALREADY MOVED IN BOTH DIRECTIONS, after
// the curator reports a no-show for it. The rare post-transfer report (spec §4):
// the settlement charged at T+3, the musician was paid, and only then, still
// inside the 14-day reporting window, the curator says the show never happened.
// reportNoShow's own transaction deliberately does NOT touch such a doc (a
// `paid` settlement is a real money record, never an erasure), so this is the
// whole unwind, and it is the exact inverse of finalizeSettlementSuccess:
//
//  1. REVERSE the earnings transfer. Express accounts run with
//     debit_negative_balances, so the reversal is collectible even when the
//     musician has already cashed the money out.
//  2. REFUND the settlement charge, everything that charge carried:
//     `computedCents + feeShareCents + lateFeeCents`, which is exactly the
//     `chargeTotal` settlementMath priced the paying attempt from.
//  3. REFUND THE DEPOSIT, but ONLY when it is `applied`. An applied deposit is
//     escrow that was RELEASED INTO these same economics, the settlement only
//     charged `finalBase − slice`, so leaving the slice (and its fee share)
//     with us would still bill the curator for a date that did not happen. A
//     deposit that already reads `refunded` is the ABSORPTION case, where the
//     settlement charged the FULL base: step 2 has already sent that money
//     back, and a second refund against a deposit intent that is often SHARED
//     across a whole-run accept batch would be a refund of nothing (real Stripe
//     400s; FakeStripe throws "refund exceeds charge").
//
// `settlement.intentId` is deliberately KEPT on the terminal write. It is the
// consumed handle for the charge this refund reverses, and it is the restore
// re-run below, not this function, whose job it is to clear it (see the
// outstanding-intent guard's contract note in chargeSettlement).
//
// NEVER THROWS. reportNoShow calls this AFTER its transaction has committed, so
// there is no caller left to fail: every failure route ends in the durable
// `clawback_failed` row instead, which is the thing an operator actually works.
// That row names each leg's outcome individually ("reversal ✓, settlement refund
// ✓, deposit refund ✗"), and each leg writes its own ledger row the moment its
// Stripe call returns, so a sequence that stops half way still leaves a
// complete audit trail for the money that DID move, and the ticket says exactly
// which part is left (review round 1, M1).
//
// IDEMPOTENT twice over: the CAS below acts only on a `paid` + `transferred`
// doc (so a second run after a successful clawback is a silent no-op), and
// every Stripe key is deterministic per occurrence, so a re-run inside Stripe's
// idempotency window replays the reversal and the refunds rather than issuing
// second ones.
export async function clawbackSettledOccurrence(
  bookingId: string, gigId: string, now: number,
): Promise<void> {
  const ref = getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`);
  const snap = await ref.get();
  const p = snap.data() as PaymentDoc | undefined;
  // No doc (a pre-SP5 booking), or nothing settled to claw back, including a
  // doc THIS function already unwound to `waived`. Silent by design: this is
  // the ordinary "there was no post-transfer money" answer, which is the case
  // for almost every no-show report.
  if (!p) return;
  if (p.settlement.status !== "paid") return;
  if (p.transfer.status !== "transferred" || p.transfer.id == null) {
    // A `paid` settlement with no transfer behind it. Only reachable for a
    // zero-earnings settlement (a $0 base), so it is an anomaly rather than a
    // flow, but the curator HAS been charged for a date they report never
    // happened, and there is no transfer id for the automatic unwind to hang
    // its refunds off, so a human decides rather than this guessing.
    await raiseClawbackAlert(bookingId, gigId,
      `a no-show was reported for a settled occurrence whose transfer is "${p.transfer.status}" with id`
      + ` ${String(p.transfer.id)}: there is nothing to reverse, so the settlement charge (and any applied deposit)`
      + " was NOT automatically refunded; decide the unwind in Stripe", now);
    return;
  }

  // THE STEP LEDGER, hoisted out of the try below (review round 1, M1). Each
  // flag is set the instant its Stripe call returns, so the catch can say
  // EXACTLY how far the unwind got, "reversal ✓, settlement refund ✓, deposit
  // refund ✗" is the difference between an operator knowing what is still owed
  // and having to reconstruct it from the Stripe dashboard.
  const reversedCents = p.transfer.amountCents ?? 0;
  // Exactly what the settlement charge carried, see finalizeSettlementSuccess's
  // terminal write, which persists `computedCents`/`feeShareCents` from the same
  // math the card was charged from, and Task 11's late fee, which rode that
  // charge too.
  const refundTotal = (p.settlement.computedCents ?? 0)
    + (p.settlement.feeShareCents ?? 0) + (p.settlement.lateFeeCents ?? 0);
  const depositRefundCents = p.deposit.sliceCents + p.deposit.feeShareCents;
  const refundsSettlement = p.settlement.intentId != null && refundTotal > 0;
  // ONLY for an `applied` deposit, point 3 of this function's own header.
  const refundsDeposit = p.deposit.status === "applied"
    && p.deposit.intentId != null && depositRefundCents > 0;
  let reversalId: string | null = null;
  let settlementRefundId: string | null = null;
  let depositRefundId: string | null = null;
  let terminalWritten = false;
  const stepReport = (): string => {
    const mark = (needed: boolean, done: boolean): string => (needed ? (done ? "✓" : "✗") : "not needed");
    return `reversal (${reversedCents}c) ${mark(true, reversalId != null)},`
      + ` settlement refund (${refundTotal}c) ${mark(refundsSettlement, settlementRefundId != null)},`
      + ` deposit refund (${depositRefundCents}c) ${mark(refundsDeposit, depositRefundId != null)},`
      + ` doc write ${mark(true, terminalWritten)}`;
  };

  try {
    const stripe = getStripe();
    // FIRST, and on its own key: the musician's side is the half that can fail
    // for a reason outside our control (a reversal Stripe refuses), and
    // discovering that AFTER refunding the curator would leave the platform
    // funding the difference.
    //
    // EVERY LEG WRITES ITS OWN AUDIT ROW IMMEDIATELY (review round 1, M1). The
    // rows used to be batched after the terminal write, which meant a refusal
    // half way through the sequence lost the audit trail for the money that HAD
    // moved, precisely the case where the trail matters most. The ledger
    // records what Stripe did, step by step, independently of where the sequence
    // stopped or what state the doc ended up in.
    reversalId = (await stripe.reverseTransfer({
      transferId: p.transfer.id, idempotencyKey: `${bookingId}:${gigId}:clawback`,
    })).id;
    await writeLedger({
      kind: "transfer_reversal", amountCents: reversedCents, bookingId, gigId,
      profileId: p.musicianProfileId, stripeId: reversalId,
      detail: "no-show clawback, earnings transfer reversed",
    }).catch((e) => console.error(`clawbackSettledOccurrence: transfer_reversal ledger row failed for ${bookingId}/${gigId}`, e));

    if (refundsSettlement) {
      settlementRefundId = (await stripe.refund({
        intentId: p.settlement.intentId!, amountCents: refundTotal,
        idempotencyKey: `${bookingId}:${gigId}:clawback-refund`,
        meta: { bookingId, gigId, purpose: "noshow_clawback" },
      })).id;
      await writeLedger({
        kind: "refund", amountCents: refundTotal, bookingId, gigId,
        profileId: p.curatorProfileId, stripeId: settlementRefundId,
        detail: "no-show clawback, settlement charge refunded (incl. fee share and any late fee)",
      }).catch((e) => console.error(`clawbackSettledOccurrence: settlement refund ledger row failed for ${bookingId}/${gigId}`, e));
    }

    // THE R8 INTERACTION, stated because it is the one shape that reaches here
    // and legitimately fails: an occurrence that settled BELOW its deposit slice
    // has already had the excess refunded against this same intent (the
    // `settle-down` refund), so slice+fee can exceed what that intent still
    // holds and Stripe refuses. That refusal is FAIL-SAFE by construction,
    // nothing is over-refunded, the reversal and settlement rows above already
    // stand, and the alert names the failed step, but such a date's unwind does
    // finish by hand.
    if (refundsDeposit) {
      depositRefundId = (await stripe.refund({
        intentId: p.deposit.intentId!, amountCents: depositRefundCents,
        idempotencyKey: `${bookingId}:${gigId}:clawback-deposit`,
        meta: { bookingId, gigId, purpose: "noshow_clawback_deposit" },
      })).id;
      await writeLedger({
        kind: "refund", amountCents: depositRefundCents, bookingId, gigId,
        profileId: p.curatorProfileId, stripeId: depositRefundId,
        detail: "no-show clawback, applied deposit refunded (incl. fee share)",
      }).catch((e) => console.error(`clawbackSettledOccurrence: deposit refund ledger row failed for ${bookingId}/${gigId}`, e));
    }

    const updates: Record<string, unknown> = {
      // `waived`, not `not_due`: the date was real and was priced, it is the
      // OBLIGATION that has been extinguished, which is exactly what waived
      // means everywhere else in SP5.
      "settlement.status": "waived",
      "settlement.nextRetryAt": null,
      "settlement.chargingSince": null,
      "transfer.status": "reversed",
      updatedAt: now,
    };
    // `transfer.id`/`amountCents`/`transferredAt` are deliberately left as they
    // are: they are the record of the transfer this reversal undid, and the
    // ledger row below keys the reversal off its own Stripe id.
    if (p.deposit.status === "applied") {
      updates["deposit.status"] = "refunded";
      updates["deposit.resolvedAt"] = now;
    }
    let raced = false;
    try {
      await ref.update(updates, { lastUpdateTime: snap.updateTime! });
      terminalWritten = true;
    } catch (e) {
      if (!isFailedPrecondition(e)) throw e;
      // Money has already come back in both directions but the doc moved under
      // us. Deliberately NOT retried and NOT forced: the racer's decision may
      // itself have been a money decision, and a blind overwrite could bury it.
      // Every audit row above is already written, that is the point of writing
      // them per-step, and the alert at the end is what gets the doc reconciled.
      raced = true;
    }

    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`clawbackSettledOccurrence: summary recompute failed for ${bookingId}`, e));
    // An extinguished obligation, exactly like a waive or a refund elsewhere,
    // the settlement is now `waived` and any escrow has gone back, so this may
    // have been the last thing gating a delinquent curator.
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((e) => console.error(`clawbackSettledOccurrence: delinquency clear failed for ${p.curatorProfileId}`, e));

    if (raced) {
      await raiseClawbackAlert(bookingId, gigId,
        `the clawback's money all moved (${stepReport()}) but the occurrence was rewritten concurrently and the terminal`
        + " write was refused: the money is back and the ledger records it, but the payment doc does not say so;"
        + " reconcile it against the ledger rows for this occurrence", now);
    }
  } catch (e) {
    // A Stripe refusal, a transfer already reversed by hand in the dashboard,
    // a refund that exceeds what the intent still holds, an account problem.
    // Nothing partial is rolled back (nothing here CAN be), so the alert states
    // the position STEP BY STEP and a human finishes exactly the part that did
    // not happen. Both intent ids go in it: the operator needs the deposit's as
    // much as the settlement's, since the deposit leg is the one that fails.
    console.error(`clawbackSettledOccurrence: ${bookingId}/${gigId} failed`, e);
    await raiseClawbackAlert(bookingId, gigId,
      `the post-transfer no-show clawback failed: ${e instanceof Error ? e.message : String(e)}. Steps: ${stepReport()}.`
      + ` Handles: transfer ${String(p.transfer.id)}, settlement intent ${String(p.settlement.intentId)},`
      + ` deposit intent ${String(p.deposit.intentId)} (deposit "${p.deposit.status}"). Everything marked ✓ has already`
      + " happened and has its ledger row. Finish only the rest by hand; the occurrence is still recorded as"
      + " paid/transferred either way",
      now).catch((ae) => console.error(`clawbackSettledOccurrence: failed to record the clawback alert for ${bookingId}/${gigId}`, ae));
  }
}

// RE-OPENS a clawed-back (or merely waived) settlement so the ordinary sweep
// settles the date all over again. The other half of Task 12: an admin reversing
// a FALSE no-show report restores the booking to `completed` (SP4's F4), and the
// money the report unwound has to come back the same way, the show did happen,
// so the musician is owed their earnings and the curator owes the date.
//
// Re-driving the EXISTING state machine rather than re-crediting by hand is the
// whole point: the re-run reprices from the frozen terms and the occurrence's
// own duration, charges the card, transfers the earnings and writes the ledger
// rows through exactly the paths that are tested everywhere else.
//
// WHAT IT WRITES, and why each field:
//  - `status: "pending"` + `settleAfter: now`, the sweep's step-5 query is
//    (`pending`, `settleAfter <= now`), so the next hourly run picks it up. No
//    second T+3 wait: the date is long past and its money was already priced
//    once.
//  - `intentId: null` + `attempts + 1`, the outstanding-intent guard's stated
//    contract (see chargeSettlement). The clear is what stops that guard from
//    refusing the re-run over the CONSUMED intent this occurrence's refund was
//    issued against; the bump is what gives the re-run fresh `settle:`/`earn:`
//    idempotency keys, without which Stripe would replay the original charge
//    and transfer and no money would move at all. `payDueIntentId` is
//    deliberately left alone, that guard's note traces why a stale mirror is
//    inert once `intentId` is null.
//    THE COST OF INHERITING THE COUNTER, stated: `attempts` is the dunning
//    ladder's own position, so a re-run starts part way UP it and has
//    correspondingly fewer retries left. In the worst case, an original that
//    had already walked the ladder to delinquency, the re-run's very first
//    decline is its 5th attempt overall, which levies a late fee with no
//    retries at all in front of it. That is accepted rather than fixed:
//    resetting the counter to 0 would hand the re-run the CONSUMED
//    `settle:0`/`earn:0` keys, and a settlement that silently replays a spent
//    charge is a worse failure than one that duns impatiently. Key freshness
//    wins.
//  - `nextRetryAt`/`chargingSince: null`, no ladder rung and no charge in
//    flight; a marker left over from the pre-clawback attempt would otherwise
//    make the re-run look like an instance died mid-charge on it.
//  - `lateFeeCents`/`lateFeeMusicianCents`/`delinquentAt: null`, RULING: the
//    late fee belonged to the settlement that has just been refunded in full.
//    The curator was never late on THIS re-run (its clock starts now), and
//    leaving the fee attached would re-charge a penalty for a delay caused by a
//    report that has since been found false. Clearing `delinquentAt` with it is
//    not tidiness: it is the re-entry guard recordSettlementFailure keys on, so
//    a doc left carrying it could never earn a late fee again even if the
//    re-run's own ladder genuinely exhausted.
//  - `computedCents`/`feeShareCents` are left as they are: they read as history
//    until the re-run's own terminal write overwrites both unconditionally, and
//    nothing consumes them while the settlement is `pending` (recomputePaymentSummary
//    counts them only for a `paid` one).
//  - `transfer.*` is left as it is too, `reversed` with the old transfer's id
//    is the truth until the re-transfer repoints all four fields.
//
// THE DEPOSIT DELIBERATELY STAYS `refunded`. That money went back to the
// curator in the clawback, so it is not escrow any more: settlementMath's
// `creditsDeposit` is false for it, the re-run therefore charges the FULL base
// with no slice credit, and finalizeSettlementSuccess leaves the deposit
// terminal rather than claiming an escrow that no longer exists.
//
// Returns whether it actually re-opened anything, so the caller can log it.
export async function reopenSettlementForRestore(
  bookingId: string, gigId: string, now: number,
): Promise<boolean> {
  const ref = getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`);
  const snap = await ref.get();
  const p = snap.data() as PaymentDoc | undefined;
  if (!p) return false;
  // ONLY a `waived` settlement, which is precisely the state a no-show report
  // leaves the reported date in, whether it was clawed back post-transfer or
  // simply waived before it ever settled. Anything else is left alone: a `paid`
  // one needs no redoing, and a `pending`/`past_due`/`not_due` one is already
  // (or not yet) the sweep's, so re-opening it would only reset its ladder.
  if (p.settlement.status !== "waived") return false;
  try {
    await ref.update({
      "settlement.status": "pending",
      "settlement.settleAfter": now,
      "settlement.intentId": null,
      "settlement.attempts": p.settlement.attempts + 1,
      "settlement.nextRetryAt": null,
      "settlement.chargingSince": null,
      "settlement.lateFeeCents": null,
      "settlement.lateFeeMusicianCents": null,
      "settlement.delinquentAt": null,
      updatedAt: now,
    }, { lastUpdateTime: snap.updateTime! });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // A racer moved this doc between the read and here. No money moves on this
    // path, it only re-arms one, so their decision stands and there is
    // nothing to account for.
    console.warn(`reopenSettlementForRestore: ${bookingId}/${gigId} changed under a restore, left as the racer wrote it`);
    return false;
  }
  // NO paymentSummary recompute: `waived` and `pending` contribute identically
  // to every field of the aggregate (see recomputePaymentSummary's per-status
  // table), the deposit is untouched, and a cleared late fee only ever counted
  // while the settlement was `paid`. The re-run's own terminal write recomputes
  // it when the figures actually change.
  return true;
}

// Registered HERE rather than in paymentsWebhook.ts for the same reason
// payments.ts registers `account.updated` there: this module already imports
// the registry, and index.ts importing it (transitively, via paymentsSweep.ts,
// and from Task 11 also payments.ts) is what guarantees the registration has
// run before the webhook can ever fire. See this file's header for what breaks
// if that import chain is ever severed.
//
// The DEPOSIT half of payPastDue, and the exact counterpart of
// finalizeSettlementSuccess above: it turns a confirmed on-session intent into
// held escrow for an occurrence whose BIRTH deposit exhausted its retry
// schedule. Lives beside the settlement tail (rather than in paymentsCore with
// the other deposit machinery) because both of its callers are here,
// payPastDue's fake-Stripe path and the "paydue_deposit" webhook purpose, and
// because it must reach clearDelinquencyIfSettled, which is exactly the point
// of the whole path.
//
// IDEMPOTENT by CAS: it acts only on a doc still `unpaid` whose deposit either
// carries no intent or carries THIS one. A redelivered webhook, or the webhook
// arriving after the fake path already finalized inline, is a clean no-op,
// never a second `held` write and never a second ledger row (writeLedger's
// `{kind}:{stripeId}` id dedupes that too).
//
// Deliberately does NOT touch the settlement: a deposit paid late is still a
// deposit, and the date it belongs to settles on its own schedule.
//
// THE `reason` DISCRIMINANT (review round 3, I2) mirrors SettlementRunReason's
// job and exists for one caller in particular: the webhook cannot tell a benign
// replay from captured money landing on a doc a racer already claimed, and
// those need opposite handling, an info line versus a ledger row and an alert.
// `outcome` is what a caller acts on; `reason` is why.
export type DepositPayDueReason =
  | "no_doc"           // the payment doc is gone (a profile-deletion cascade)
  | "already_final"    // this same intent already finalized it, a plain replay
  | "not_unpaid"       // a racer moved the doc; any money captured is unaccounted for
  | "intent_mismatch"; // a DIFFERENT intent is outstanding on this deposit
export interface DepositPayDueResult {
  outcome: "held" | "raced" | "skipped";
  reason?: DepositPayDueReason;
}

export async function finalizeDepositPayDue(args: {
  bookingId: string; gigId: string; intentId: string;
  chargeId?: string | null; chargedCents?: number | null; now: number;
}): Promise<DepositPayDueResult> {
  const { bookingId, gigId, intentId, now } = args;
  const ref = getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`);
  const snap = await ref.get();
  const p = snap.data() as PaymentDoc | undefined;
  if (!p) return { outcome: "skipped", reason: "no_doc" };
  if (p.deposit.status !== "unpaid") {
    // TWO very different situations behind one status test, and conflating
    // them is how captured money goes missing:
    //  - the doc already carries THIS intent, so a previous run of this same
    //    finalizer completed it. A pure replay; nothing to do, nothing to say.
    //  - it does NOT, so a racer (a cancellation, a waive, a settlement that
    //    absorbed it) moved the doc between the intent being created and
    //    Stripe confirming it. The escrow this charge was meant to create does
    //    not exist, and the caller has to escalate rather than shrug.
    const mine = p.deposit.intentId === intentId;
    return { outcome: mine ? "skipped" : "raced", reason: mine ? "already_final" : "not_unpaid" };
  }
  if (p.deposit.intentId != null && p.deposit.intentId !== intentId) {
    // Two live charges against one deposit, the same unconsumed-charge signal
    // the settlement handler's mismatch check exists for.
    console.error(
      `finalizeDepositPayDue: ${bookingId}/${gigId} is awaiting intent ${p.deposit.intentId} but ${intentId} succeeded, unconsumed charge, needs reconciliation`);
    return { outcome: "skipped", reason: "intent_mismatch" };
  }
  const amountCents = args.chargedCents ?? (p.deposit.sliceCents + p.deposit.feeShareCents);
  let raced = false;
  try {
    await ref.update({
      "deposit.status": "held", "deposit.intentId": intentId,
      "deposit.chargeId": args.chargeId ?? p.deposit.chargeId ?? null,
      "deposit.chargeAmountCents": amountCents,
      "deposit.chargedAt": now,
      // The retry clock is already null (exhaustion cleared it); written again
      // so a doc rescued from ANY rung of the ladder lands in the same shape.
      "deposit.depositNextRetryAt": null,
      updatedAt: now,
    }, { lastUpdateTime: snap.updateTime! });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // A racer moved the doc during this call, a cancellation marking it
    // `*_pending` is the realistic one. Its decision stands, and the charge is
    // still recorded below so the executor has an intent to refund against.
    raced = true;
    console.warn(`finalizeDepositPayDue: ${bookingId}/${gigId} changed under a pay-now deposit, left as the racer wrote it`);
    await ref.update({
      "deposit.intentId": intentId,
      // The CHARGE ID goes with it (review round 2): the pending executor uses
      // it as a forfeit transfer's `sourceChargeId` (as-built contract #3), and
      // dropping it here would make that transfer draw on the platform's
      // aggregate balance instead of the money this very charge produced.
      "deposit.chargeId": args.chargeId ?? p.deposit.chargeId ?? null,
      "deposit.chargeAmountCents": amountCents,
      "deposit.chargedAt": now, updatedAt: now,
    }).catch((we) => console.error(`finalizeDepositPayDue: failed to record intent ${intentId} on ${bookingId}/${gigId}`, we));
  }
  await writeLedger({
    kind: "deposit_charged", amountCents, bookingId, gigId,
    profileId: p.curatorProfileId, stripeId: intentId, detail: "deposit paid on-session (pay now)",
  }).catch((e) => console.error(`finalizeDepositPayDue: deposit_charged ledger row failed for ${bookingId}/${gigId}`, e));
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`finalizeDepositPayDue: summary recompute failed for ${bookingId}`, e));
  // The whole point: this is the obligation that was gating the curator.
  await clearDelinquencyIfSettled(p.curatorProfileId, now)
    .catch((e) => console.error(`finalizeDepositPayDue: delinquency clear failed for ${p.curatorProfileId}`, e));
  // DISTINCT from "held" on purpose: the money moved but no escrow exists,
  // the racer's `*_pending` marker owns this doc now, and its executor will
  // send the charge back. A caller that reported this as a completed payment
  // would tell the curator their date is secured when it has just been
  // cancelled out from under them.
  return raced ? { outcome: "raced", reason: "not_unpaid" } : { outcome: "held" };
}

// ONE handler, TWO purposes, because the recovery is identical either way:
//  - "settlement" is the recovery half of as-built contract #7,
//    chargeSettlement left an OFF-session intent `processing`, persisted its
//    id, and returned "pending";
//  - "paydue" is `payPastDue`'s ON-session intent, confirmed by the curator in
//    the browser with Elements.
// In both cases Stripe's confirmation is the trigger, and the settlement then
// finishes exactly as the synchronous path would have, transfer, terminal
// write, ledger rows, aggregate, delinquency lift, notification.
const settlementIntentSucceeded = async (object: Record<string, unknown>): Promise<void> => {
  const intentId = object.id as string | undefined;
  const meta = object.metadata as Record<string, string> | undefined;
  const bookingId = meta?.bookingId;
  const gigId = meta?.gigId;
  const purpose = meta?.purpose ?? "settlement";
  // Event payloads are signature-verified but never shape-validated, so
  // metadata is untrusted input, validate before building a doc path from it
  // (mirrors the `deposit` handler's identical guard in bookings.ts).
  if (!intentId || !bookingId || !gigId || !isValidDocId(bookingId) || !isValidDocId(gigId)) {
    console.warn(
      `payment_intent.succeeded (${purpose}): unusable metadata, intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}, gigId=${JSON.stringify(gigId ?? null)}`);
    return;
  }
  const p = (await getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`).get())
    .data() as PaymentDoc | undefined;
  if (!p) return;
  // A DIFFERENT intent than the one this occurrence is waiting on: two live
  // charges exist for one settlement, and this one will never be consumed.
  // Not silently ignorable, it is precisely the stuck-money signal an
  // operator needs (same reasoning as the `deposit` handler's mismatch check).
  if (p.settlement.intentId != null && p.settlement.intentId !== intentId) {
    console.error(
      `payment_intent.succeeded (${purpose}): ${bookingId}/${gigId} is awaiting intent ${p.settlement.intentId} but ${intentId} succeeded, unconsumed charge, needs reconciliation`);
    return;
  }
  // `latest_charge` is the charge behind the intent, when Stripe sends it,
  // it makes the earnings transfer draw on those exact funds (contract #3).
  const latestCharge = typeof object.latest_charge === "string" ? object.latest_charge : null;
  // Stripe's own word on what was actually taken (the deposit handler prefers
  // the same field for the same reason); `amount` is the fallback for a
  // payload that omits it, and null means "we don't know" rather than 0.
  const received = typeof object.amount_received === "number" ? object.amount_received
    : typeof object.amount === "number" ? object.amount : null;
  const result = await finalizeSettlementSuccess({
    bookingId, gigId, intentId, chargeId: latestCharge, chargedCents: received, now: Date.now(),
  });
  // A REPLAY is the expected steady state here, not an anomaly: a redelivered
  // webhook, a sweep run that already finalized this intent synchronously, and
  //, on the fake Stripe the emulator runs, EVERY payPastDue, which finalizes
  // inline and then still sees this event. Logged at info (never error) so the
  // no-op is visible without looking like a fault.
  if (result.reason === "already_paid") {
    console.info(`payment_intent.succeeded (${purpose}): ${bookingId}/${gigId} is already settled, nothing to do`);
  }
};

paymentIntentSucceededHandlers["settlement"] = settlementIntentSucceeded;
paymentIntentSucceededHandlers["paydue"] = settlementIntentSucceeded;

// payPastDue's DEPOSIT half. Separate from the two above because it finalizes a
// deposit, not a settlement, same metadata validation, different tail.
paymentIntentSucceededHandlers["paydue_deposit"] = async (object) => {
  const intentId = object.id as string | undefined;
  const meta = object.metadata as Record<string, string> | undefined;
  const bookingId = meta?.bookingId;
  const gigId = meta?.gigId;
  if (!intentId || !bookingId || !gigId || !isValidDocId(bookingId) || !isValidDocId(gigId)) {
    console.warn(
      `payment_intent.succeeded (paydue_deposit): unusable metadata, intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}, gigId=${JSON.stringify(gigId ?? null)}`);
    return;
  }
  const latestCharge = typeof object.latest_charge === "string" ? object.latest_charge : null;
  const received = typeof object.amount_received === "number" ? object.amount_received
    : typeof object.amount === "number" ? object.amount : null;
  const now = Date.now();
  const result = await finalizeDepositPayDue({
    bookingId, gigId, intentId, chargeId: latestCharge, chargedCents: received, now,
  });
  if (result.outcome === "raced") {
    // CAPTURED MONEY WITH NO ESCROW BEHIND IT. Stripe confirmed this intent
    // after a racer had already claimed the doc, the curator has paid for a
    // deposit that no longer exists. This is the deposit twin of a raced
    // settlement and gets the same treatment, for the same reason: an
    // info-level "needed no finalization" would make a real charge invisible
    // (review round 3, I2).
    //
    // The LEDGER ROW FIRST, from Stripe's own attested amount, the audit trail
    // records what Stripe did, independently of what state the doc ended up in,
    // and it is what an operator reconciling the alert reads. `received` can be
    // null only for a payload that carries neither field, in which case there
    // is no honest figure to write and the alert alone is the record.
    if (received != null && received > 0) {
      await writeLedger({
        kind: "deposit_charged", amountCents: received, bookingId, gigId,
        profileId: null, stripeId: intentId,
        detail: "pay-now deposit captured after the occurrence was claimed elsewhere",
      }).catch((e) => console.error(`paydue_deposit: raced deposit_charged ledger row failed for ${bookingId}/${gigId}`, e));
    }
    const detail = `pay-now deposit intent ${intentId} succeeded${received != null ? ` for ${received}c` : ""} but the`
      + " occurrence had already been claimed elsewhere (cancelled, waived, or settled), so no escrow was created:"
      + " the curator was charged for a deposit that does not exist; refund the intent";
    const alertId = depositRacedAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "deposit_raced", detail, bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(`paydue_deposit: ${bookingId}/${gigId}, ${detail} (see adminAlerts/${alertId})`);
    }
    return;
  }
  if (result.outcome === "skipped") {
    // Benign by construction: a replay of an intent that already finalized
    // this deposit, a doc that is gone, or a different intent's event (which
    // logged its own error inside the finalizer).
    console.info(
      `payment_intent.succeeded (paydue_deposit): ${bookingId}/${gigId} needed no deposit finalization (${String(result.reason)})`);
  }
};

// TASK 12's LEDGER-ONLY HANDLER, and the only SP5 handler that writes no
// document state at all.
//
// Stripe sends `transfer.reversed` for EVERY reversal of one of our transfers,
// which is two populations with one event type:
//  - OUR OWN clawbacks, whose document state clawbackSettledOccurrence has
//    already written synchronously. There is nothing left to do for these, and
//    the DEDUPE is what makes that automatic rather than conditional: both
//    rows key off the REVERSAL's own Stripe id, so writeLedger's deterministic
//    `{kind}:{stripeId}` doc id collapses the webhook's row into the clawback's
//    and logs the suppression at info. The LEDGER needs no ordering assumption,
//    whichever of the two runs second is the no-op. The `transferred` warn
//    below is a different matter and is BEST-EFFORT ONLY: this event can arrive
//    inside the clawback's own window (after its reverseTransfer, before its
//    terminal write), in which case the doc still reads `transferred` and the
//    warn fires for a reversal that was entirely ours. Treat it as a prompt to
//    go and look, never as proof of a foreign reversal.
//  - FOREIGN reversals: an operator reversing a transfer by hand in the Stripe
//    dashboard. Nothing in this codebase knows those happened, so the ledger
//    row IS the record, and the payment doc is deliberately left saying
//    `transferred`, an out-of-band reversal is an operator's decision that
//    this handler must not half-apply by flipping a status while leaving the
//    curator's side of the same occurrence charged. The warn below is the
//    discovery route.
//
// The reversal id comes off the transfer's own `reversals` list (Stripe orders
// it newest-first, and SP5 only ever reverses a transfer in full, once). The
// transfer id is the fallback for a payload that omits the list, a row keyed
// that way cannot dedupe against a clawback's, so it is deliberately the
// unusual shape rather than the default.
webhookHandlers["transfer.reversed"] = async (object, eventId) => {
  const transferId = typeof object.id === "string" ? object.id : null;
  if (!transferId) {
    console.warn(`transfer.reversed: payload carries no transfer id (event ${eventId})`);
    return;
  }
  const meta = object.metadata as Record<string, string> | undefined;
  // Same untrusted-metadata rule as the intent handlers above: a doc path is
  // only ever built from ids that validate.
  const bookingId = meta?.bookingId != null && isValidDocId(meta.bookingId) ? meta.bookingId : null;
  const gigId = meta?.gigId != null && isValidDocId(meta.gigId) ? meta.gigId : null;
  const reversalList = (object.reversals as { data?: unknown } | undefined)?.data;
  const newest = Array.isArray(reversalList) ? reversalList[0] as { id?: unknown } | undefined : undefined;
  const reversalId = typeof newest?.id === "string" ? newest.id : null;
  // Stripe's own word on how much came back; `amount` is the fallback for a
  // full reversal payload that omits the running total.
  const amountCents = typeof object.amount_reversed === "number" ? object.amount_reversed
    : typeof object.amount === "number" ? object.amount : 0;

  // The occurrence, when the transfer carries our metadata, it supplies the
  // ledger row's profileId (whose balance moved) and tells us whether this is a
  // reversal we already know about.
  let musicianProfileId: string | null = null;
  let transferStatus: string | null = null;
  if (bookingId && gigId) {
    const p = (await getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`).get())
      .data() as PaymentDoc | undefined;
    musicianProfileId = p?.musicianProfileId ?? null;
    transferStatus = p?.transfer.status ?? null;
  }

  await writeLedger({
    kind: "transfer_reversal", amountCents, bookingId, gigId,
    profileId: musicianProfileId, stripeId: reversalId ?? transferId,
    detail: `transfer ${transferId} reversed (Stripe event)`,
  }).catch((e) => console.error(`transfer.reversed: ledger row failed for transfer ${transferId} (event ${eventId})`, e));

  if (transferStatus === "transferred") {
    // The doc still records a live transfer for a transfer Stripe says is
    // reversed. USUALLY that means nothing in our own flow did this, the
    // musician's balance has been debited and the curator has NOT been
    // refunded, so an operator has half an unwind to finish. It can also be a
    // benign race against our OWN clawback (see this handler's header): the
    // wording says "check", not "this was foreign", because a warn that
    // overstates its case gets ignored.
    console.warn(
      `transfer.reversed: ${bookingId}/${gigId} still records transfer ${transferId} as "transferred", either this`
      + " reversal originated outside the no-show clawback (a dashboard reversal) or it raced our own clawback's"
      + " terminal write; if the doc is still paid/transferred once things settle, the curator's side of this"
      + " occurrence is untouched and needs a decision");
  }
};

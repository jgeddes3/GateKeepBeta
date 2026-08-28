/**
 * SP5 settlement — everything that happens to ONE occurrence's money AFTER the
 * date has been performed: the true-up-aware pricing, the T+3 charge, the
 * earnings transfer, the dunning ladder, delinquency, and the shared
 * post-charge tail that the sweep, the webhook and `payPastDue` all finish
 * through.
 *
 * WHY THIS IS ITS OWN MODULE (Task 10 review, I1): paymentsCore.ts is the
 * money PRIMITIVES layer — the gates, the ledger, the aggregate, the deposit
 * executor, the alert queue. Settlement is a state machine built ON those
 * primitives, and it is the largest single thing in SP5. Keeping them in one
 * file made the primitives hard to find and made every settlement change read
 * as a change to the shared foundations.
 *
 * IMPORT DIRECTION (do not invert any leg):
 *     paymentsSweep  ->  paymentsSettlement  ->  paymentsCore
 *     payments       ->  paymentsSettlement  ->  paymentsCore
 * paymentsCore must never import this file: it is imported by bookings.ts,
 * bookingLifecycle.ts and scheduled.ts, none of which have any business
 * pulling in the settlement machine.
 *
 * LOAD-BEARING SIDE EFFECT: the bottom of this file REGISTERS the
 * `payment_intent.succeeded` handler for the "settlement" purpose (Task 11
 * adds "paydue" beside it). That registration only exists if this module is
 * actually loaded, and nothing imports it for its side effect alone — it is
 * reached from index.ts transitively, via `paymentsSweep.ts` (which imports
 * chargeSettlement) and, from Task 11 on, `payments.ts` (which imports
 * finalizeSettlementSuccess for payPastDue). If a future refactor ever removes
 * the last of those import edges, the webhook silently stops finalizing
 * settlements: add an explicit `import "./paymentsSettlement.js";` to index.ts
 * rather than assuming the chain still holds.
 */

import { getFirestore } from "firebase-admin/firestore";
import {
  computeEarningsCents, computeFeeShareCents, computeSettlementBaseCents,
  resolveFeePolicy, isValidDocId, SETTLEMENT_RETRY_OFFSETS_MS,
} from "@gatekeep/shared";
import type { BookingRequestDoc, GigDoc, PaymentDoc } from "@gatekeep/shared";
import { getStripe, StripeCardDeclinedError, StripePaymentPendingError } from "./stripeClient.js";
import { notifyProfileMembers } from "./notifications.js";
import { paymentIntentSucceededHandlers } from "./paymentsWebhook.js";
import {
  getStripeProfileDoc, isFailedPrecondition, recomputePaymentSummary,
  recordAdminAlert, resolveDepositPending, writeLedger, IDEMPOTENCY_WINDOW_MS,
} from "./paymentsCore.js";

// What a settlement charge attempt did, from the sweep's point of view.
// "skipped" covers every "nothing to do / not chargeable yet" outcome so the
// sweep's counters stay honest about what actually moved.
export type SettlementChargeOutcome =
  | "skipped" | "charged" | "declined" | "pending" | "waived";

// WHY the run ended where it did. `outcome` is what the sweep counts;
// `reason` is what a CALLER acting on one specific occurrence (payPastDue)
// needs in order to tell "already settled, nothing to do" apart from "refused,
// and here is what a human must fix". The sweep deliberately ignores it for
// its outcome counters — the one exception is `settlementsRaced`, which has no
// other honest source (a race is reported as `skipped`, because from the
// sweep's side nothing was achieved this run).
export type SettlementSkipReason =
  | "not_chargeable"   // the CAS refused: the settlement is already paid/waived/not_due
  | "missing_docs"     // the payment doc, the booking's frozen terms, or the gig is gone
  | "already_paid"     // idempotent re-entry into the finalize tail (a webhook replay)
  | "raced"            // a concurrent writer moved the doc under this run
  | "stuck_intent"     // an intent id is already outstanding — never re-charged
  | "stuck_charging"   // a charge marker older than Stripe's key window — fate unknown
  | "no_customer"      // the curator has no Stripe customer to charge
  | "no_account"       // the musician has no payout account to transfer to
  | "gig_missing";     // the gig doc vanished — the date can no longer be priced

// `outcome` alone can't answer "did the musician get paid this run?" —
// "charged" covers a settlement whose earnings happened to be zero, and a
// raced finalize can move money without ever reaching a terminal write. The
// sweep counts `transfersMade` off THIS flag, so the counter only ever
// reports transfers that genuinely fired.
export interface SettlementRunResult {
  outcome: SettlementChargeOutcome;
  transferred: boolean;
  reason?: SettlementSkipReason;
}

// Positional on purpose (`transferred` before `reason`): every call site that
// carries a transfer is a success path, and every call site that carries a
// reason is a refusal — the two are almost never both interesting at once.
function ran(
  outcome: SettlementChargeOutcome, transferred = false, reason?: SettlementSkipReason,
): SettlementRunResult {
  return reason ? { outcome, transferred, reason } : { outcome, transferred };
}

// The escalation queue's naming contract for this problem (one row per stuck
// occurrence, not one per sweep run) — mirrors paymentsSweep.ts's own
// `stuck-saga:` / `stale-pending:` id builders.
function settlementRacedAlertId(bookingId: string, gigId: string): string {
  return `settlement-raced:${bookingId}:${gigId}`;
}
function settlementPendingAlertId(bookingId: string, gigId: string): string {
  return `settlement-pending:${bookingId}:${gigId}`;
}
function settlementPayoutAlertId(bookingId: string, gigId: string): string {
  return `settlement-payout:${bookingId}:${gigId}`;
}

// Everything one occurrence's settlement owes, derived ENTIRELY from
// server-held state: the booking's FROZEN accepted terms, the occurrence's own
// gig duration, the curator-reported true-up on the payment doc, and the
// booking's fee-policy snapshot. No client input reaches this (spec §4) — the
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

function settlementMath(p: PaymentDoc, booking: BookingRequestDoc, gig: GigDoc): SettlementMath {
  // resolveFeePolicy, never a hand-rolled fallback (money.ts's own warning):
  // the accept-time snapshot and the default must not drift apart.
  const feePolicy = resolveFeePolicy(booking.feePolicy);
  const terms = booking.acceptedTerms!;
  const finalBase = computeSettlementBaseCents(booking.structure, terms.amountCents, {
    // THIS occurrence's own duration — an occurrence detached from its series
    // template with an edited duration settles on its own (sp4-rulings).
    durationMinutes: gig.durationMinutes,
    extraMinutes: p.settlement.trueUp?.extraMinutes ?? 0,
    songCount: terms.expectedQuantity,
    extraSongs: p.settlement.trueUp?.extraSongs ?? 0,
  });
  // The deposit only counts against the settlement while it is actually the
  // curator's money sitting in escrow. A `refunded` deposit — the post-clawback
  // restore case (Task 12) — has already gone back, so the re-run charges the
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
// step-4 waive branch — the only difference is WHEN the linkage broke (before
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
    // Held escrow — or an unpaid doc whose birth charge is still in flight —
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
    // charged on this path, so there is no money to account for — leave their
    // decision standing.
    console.warn(`chargeSettlement: ${bookingId}/${gigId} changed under an unlinked-gig waive — left as the racer wrote it`);
    return ran("skipped", false, "raced");
  }
  if (resolvePending) {
    await resolveDepositPending(bookingId, gigId);
  } else {
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`chargeSettlement: summary recompute failed for ${bookingId}`, e));
  }
  return ran("waived");
}

// STUB — Task 11 owns the real dunning ladder (retries at +1d/+2d/+2d, then
// delinquency: the 10% late fee split 7/3, the profile-level `delinquent`
// flag, `delinquentAt`, and both sides' notifications). What lands here now is
// only the FIRST rung, so a decline is never silently swallowed: the
// occurrence goes `past_due` with one attempt recorded and the first retry
// scheduled, which is exactly what the sweep's step 6 picks back up.
//
// `booking` is unused by the stub and deliberately kept in the signature: the
// real version needs it for the late-fee math (`feePolicy` + `acceptedTerms`),
// so Task 11 replaces a BODY rather than also re-threading a call site.
//
// `baseline` is the payment doc's updateTime from BEFORE the charge attempt:
// a racer (reportNoShow waiving this very occurrence) must not have a
// `past_due` debt written back over its waive.
export async function recordSettlementFailure(args: {
  bookingId: string; gigId: string; p: PaymentDoc; booking: BookingRequestDoc;
  baseline: FirebaseFirestore.Timestamp; now: number;
}): Promise<SettlementRunResult> {
  const { bookingId, gigId, p, booking, baseline, now } = args;
  void booking;   // see the signature note above — Task 11's late-fee math needs it
  const attempts = p.settlement.attempts + 1;
  try {
    await getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`).update({
      "settlement.status": "past_due", "settlement.attempts": attempts,
      "settlement.nextRetryAt": now + SETTLEMENT_RETRY_OFFSETS_MS[0],
      // A decline is a completed Stripe call: nothing is in flight any more,
      // so the true-up window re-opens for the retry. Deliberately leaves
      // `settlement.intentId` untouched (still null) — the H1 guard in
      // chargeSettlement depends on a declined doc never carrying one.
      "settlement.chargingSince": null,
      updatedAt: now,
    }, { lastUpdateTime: baseline });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // No money moved on a decline, so there is nothing to account for — and no
    // dunning to do for a settlement that is no longer owed.
    console.warn(`recordSettlementFailure: ${bookingId}/${gigId} changed under a declined charge — dunning skipped`);
    return ran("skipped", false, "raced");
  }
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`recordSettlementFailure: summary recompute failed for ${bookingId}`, e));
  return ran("declined");
}

// The doc moved under a settlement whose money ALREADY MOVED. Records
// everything that actually moved — the doc fields, AND the ledger rows,
// which are the append-only audit trail and must never be skipped just
// because the state machine took an exceptional exit — then escalates.
//
// TWO shapes, distinguished by whether the transfer had already fired:
//  - PRE-TRANSFER (the common, benign one): the curator was charged and the
//    occurrence was waived under us, but the musician was never paid. The
//    unwind is unambiguous — refund the charge — so the alert says so.
//  - POST-TRANSFER: money moved in BOTH directions against an occurrence
//    that is now waived. Refunding the curator means clawing back the
//    musician (a transfer reversal, Task 12's machinery), so a human decides.
async function recordRacedSettlement(args: {
  bookingId: string; gigId: string;
  curatorProfileId: string; musicianProfileId: string;
  // The charge that was captured, when one was. `amountCents` is what Stripe
  // actually took (never a recomputed figure — the doc's state has moved).
  charge: { intentId: string; amountCents: number | null } | null;
  transfer: { id: string; amountCents: number } | null;
  racedStatus: string; now: number;
}): Promise<void> {
  const { bookingId, gigId, charge, transfer, racedStatus, now } = args;
  // Merge-only, and deliberately WITHOUT `settlement.status`/`deposit.status`
  // — the racer's terminal decision stands (mirrors the sweep's birth-charge
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
    ? `charged ${String(charge?.amountCents ?? "?")}c and transferred ${transfer.amountCents}c, then found the occurrence "${racedStatus}" — money moved in BOTH directions and the terminal write was refused; unwinding needs a transfer reversal, not a refund`
    : `charged ${String(charge?.amountCents ?? "?")}c but the occurrence is "${racedStatus}" — the curator was charged for a date that is no longer owed and NO transfer was made; refund the intent`;
  const alertId = settlementRacedAlertId(bookingId, gigId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "settlement_raced", detail, bookingId, gigId, now,
  });
  if (shouldLog) {
    console.error(
      `chargeSettlement: ${bookingId}/${gigId} — ${detail}; needs admin attention (see adminAlerts/${alertId})`);
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
// THE `baseline` CONTRACT (Task 10 review, I4 — read this before calling):
// PASS A BASELINE UNLESS THE DOC IS PROVABLY FROZEN FOR THE DURATION OF YOUR
// CHARGE. `baseline` is the CAS baseline the terminal write is held to, and
// its job is to span the whole non-transactional window in which YOUR caller
// could have raced someone else. Concretely:
//  - chargeSettlement passes the write time of its pre-charge claim, so the
//    precondition covers the Stripe call itself — anything that touched the
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
  // any recomputed figure for the audit rows — same "Stripe's own word on the
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
    // A CAPTURED CHARGE with nothing left to record it against — the payment
    // doc, the booking's frozen terms or the gig went away between the charge
    // and this call (a webhook arriving after a profile-deletion cascade is
    // the realistic route). Never a silent return: this is the same class of
    // problem as a raced settlement (money moved, no state records it), and
    // the amount cannot be re-derived without the terms, so the alert IS the
    // record.
    if (intentId) {
      const detail = `settlement intent ${intentId} succeeded but the occurrence can no longer be priced`
        + ` (payment doc ${p ? "present" : "missing"}, acceptedTerms ${booking?.acceptedTerms ? "present" : "missing"},`
        + ` gig ${gig ? "present" : "missing"}) — the charge is unrecorded; reconcile it in Stripe`;
      const alertId = settlementRacedAlertId(bookingId, gigId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "settlement_raced", detail, bookingId, gigId, now,
      });
      if (shouldLog) {
        console.error(
          `finalizeSettlementSuccess: ${bookingId}/${gigId} — ${detail} (see adminAlerts/${alertId})`);
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
  // write. Detecting that here — rather than discovering it after the
  // transfer — is what keeps a lost race from paying the musician for an
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
        `finalizeSettlementSuccess: ${bookingId}/${gigId} was rewritten during a zero-charge settlement — left for the next run`);
    }
    return ran("skipped", false, "raced");
  }

  const math = settlementMath(p, booking, gig);
  const musicianStripe = await getStripeProfileDoc(p.musicianProfileId);
  if (math.earnings > 0 && !musicianStripe?.accountId) {
    // Unreachable in normal flow (accept is gated on a payout-ready musician).
    // The settlement is NOT flipped terminal — the musician's money must never
    // be dropped by writing `paid` with no transfer behind it — but the CHARGE
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
      `finalizeSettlementSuccess: no Stripe account for ${p.musicianProfileId} — ${bookingId}/${gigId} left unsettled${intentId ? ` with intent ${intentId} recorded` : ""}`);
    // Task 10 review, M1: ESCALATE the null-intent case. With an intent id
    // recorded, the next run's outstanding-intent guard raises
    // `settlement_pending_stuck` and an operator sees it there. With NO intent
    // — a zero-charge settlement whose deposit already covered the whole date,
    // so there is nothing for the guard to catch — the doc simply stays
    // `pending`/`past_due` and every hourly run retries it silently, forever,
    // while the musician is owed money nobody is told about. This row is the
    // only signal that exists for that shape.
    if (!intentId) {
      const detail = `the musician profile ${p.musicianProfileId} has no Stripe payout account, so ${math.earnings}c of`
        + " earnings cannot be transferred; the settlement is left unsettled and retried every run."
        + " Nothing is stuck in Stripe — the fix is the musician finishing (or repairing) Express onboarding";
      const alertId = settlementPayoutAlertId(bookingId, gigId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "settlement_payout_blocked", detail, bookingId, gigId, now,
      });
      if (shouldLog) {
        console.error(
          `finalizeSettlementSuccess: ${bookingId}/${gigId} — ${detail} (see adminAlerts/${alertId})`);
      }
    }
    return ran("skipped", false, "no_account");
  }

  // As-built contract #3: a transfer backed by a FRESH charge passes that
  // charge's id so it draws on those funds instead of the platform's aggregate
  // available balance (a not-yet-settled charge would otherwise fail
  // `balance_insufficient` in live mode). A zero-charge settlement — the
  // deposit covered the whole date — has no fresh charge, so it falls back to
  // the DEPOSIT's charge, which is the money it is actually consuming.
  const sourceChargeId = args.chargeId ?? (math.chargeTotal > 0 ? null : p.deposit.chargeId);
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
  // `refunded` — "applied" would claim escrow that no longer exists.
  if (math.creditsDeposit) {
    updates["deposit.status"] = "applied";
    updates["deposit.resolvedAt"] = now;
  }
  if (transfer) {
    updates["transfer.status"] = "transferred";
    updates["transfer.id"] = transfer.id;
    updates["transfer.amountCents"] = math.earnings;
    updates["transfer.transferredAt"] = now;
  }
  try {
    await ref.update(updates, { lastUpdateTime: args.baseline ?? pSnap.updateTime! });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // The residual window the pre-transfer check above cannot close: a racer
    // that landed DURING the transfer itself. Money moved in both directions;
    // recordRacedSettlement writes the audit rows and escalates.
    await recordRacedSettlement({
      bookingId, gigId, curatorProfileId: p.curatorProfileId, musicianProfileId: p.musicianProfileId,
      // `chargedCents ?? null`, never the recomputed `math.chargeTotal`: the
      // doc's state has moved under us, so a re-derived figure could disagree
      // with what Stripe actually took — and the interface's rule is that null
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
      detail: "earnings transfer (net of the musician fee, incl. any late-fee share)",
    }).catch((e) => console.error(`finalizeSettlementSuccess: earnings_transfer ledger row failed for ${bookingId}/${gigId}`, e));
  }
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`finalizeSettlementSuccess: summary recompute failed for ${bookingId}`, e));
  // TODO(Task 11): a successful settlement does NOT clear the curator's
  // profile-level `delinquent` flag here — that is
  // `clearDelinquencyIfSettled(p.curatorProfileId, now)`'s job, which can only
  // answer "is EVERYTHING outstanding settled now?" by querying the whole
  // obligation set. Wire it in at exactly this point.
  try {
    await notifyProfileMembers(p.musicianProfileId, {
      kind: "booking", refId: bookingId,
      title: "You've been paid",
      body: "A settlement landed in your balance — cash out from your Earnings page.",
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
// legitimately settles — the musician performed that night; only the paperwork
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
  // time a doc's turn comes the page it arrived in can be minutes old — and
  // this CHARGES A CARD off what it reads.
  const [pSnap, bookingSnap, gigSnap] = await Promise.all([
    ref.get(), db.doc(`bookings/${bookingId}`).get(), db.doc(`gigs/${gigId}`).get(),
  ]);
  const p = pSnap.data() as PaymentDoc | undefined;
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  const gig = gigSnap.data() as GigDoc | undefined;
  if (!p || !booking?.acceptedTerms) return ran("skipped", false, "missing_docs");

  // --- PHASE 2: REFUSALS (nothing below this block may charge) ---------
  // THE CAS. Anything else — already `paid` (a racer, or the webhook, got
  // here first), `waived`, or `not_due` (its date hasn't been resolved yet) —
  // is deliberately untouched.
  if (p.settlement.status !== "pending" && p.settlement.status !== "past_due") {
    return ran("skipped", false, "not_chargeable");
  }

  // THE OUTSTANDING-INTENT TERMINATOR. A settlement that already carries an
  // intent id has a real charge attached to it — one left `processing`, or one
  // that succeeded against a doc a racer moved. It must NEVER be charged
  // again: that intent can still succeed (or already has), so a fresh-key
  // retry — which is exactly what a re-run becomes once Stripe's 24h
  // idempotency window closes (see IDEMPOTENCY_WINDOW_MS) — is a real SECOND
  // charge on the curator's card. The ways out are the
  // payment_intent.succeeded webhook finalizing it, or an operator cancelling
  // /refunding the intent in Stripe; either way this loop just waits.
  //
  // UNCONDITIONAL on the settlement status, deliberately. Dunning retries are
  // unaffected because a declined settlement never carries an intent id
  // (recordSettlementFailure writes status/attempts/nextRetryAt and leaves
  // `settlement.intentId` alone). The THREE writers of that field are: the
  // pending branch below, the terminal `paid` write in
  // finalizeSettlementSuccess, and recordRacedSettlement — and that last one
  // can stamp an intent id onto a `past_due` doc whose `nextRetryAt` is still
  // live, which a `pending`-only guard would sail straight past into a second
  // charge.
  //
  // TODO(Tasks 11/12): two later paths must cooperate with this guard —
  //  - `payPastDue` persists an on-session intent id on a `past_due` doc, so
  //    it must CLEAR that id on a failed/abandoned attempt (or extend this
  //    guard), otherwise step 6's retries are blocked forever;
  //  - the restore re-run must clear `settlement.intentId` AND bump
  //    `settlement.attempts` when it re-opens a clawed-back settlement —
  //    without the clear this guard refuses it, and without the bump its
  //    `settle:`/`earn:` keys replay consumed ones and no money moves.
  if (p.settlement.intentId != null) {
    const alertId = settlementPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "settlement_pending_stuck",
      detail: `"${p.settlement.status}" settlement already carries intent ${p.settlement.intentId} — never re-charged; finalize it via the webhook or resolve the intent in Stripe`,
      bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} is "${p.settlement.status}" but holds intent ${p.settlement.intentId} — not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    return ran("pending", false, "stuck_intent");
  }

  // THE STALE-CLAIM TERMINATOR (Task 10 review, I2 — the blind spot the guard
  // above cannot see). `chargingSince` set with NO intent id means an instance
  // died between claiming this doc and recording what its Stripe call did.
  // Inside the idempotency window that is harmless: the next run re-derives
  // the SAME attempt-scoped key, so Stripe replays the original outcome rather
  // than charging again, and the claim write below simply overwrites the
  // marker. PAST the window the key is brand new, so the "retry" is a genuine
  // SECOND charge for a first charge whose fate nobody knows — the curator may
  // already have paid.
  //
  // So this refuses, permanently, and hands the occurrence to a human: the
  // answer lives in the Stripe dashboard (was there a charge under that
  // customer for this amount?), and the operator either refunds it and clears
  // `chargingSince`, or records the intent id on the doc so the webhook path
  // finalizes it. Reported as "pending" rather than "declined" because nothing
  // was declined — a charge is (or was) outstanding and its fate is unknown,
  // which is exactly what the "pending" bucket means to the sweep.
  const charging = p.settlement.chargingSince;
  if (charging != null && now - charging >= IDEMPOTENCY_WINDOW_MS) {
    const alertId = settlementPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "settlement_pending_stuck",
      detail: `"${p.settlement.status}" settlement was claimed for a charge at ${new Date(charging).toISOString()}`
        + " and never recorded an intent — the claim is older than Stripe's idempotency window, so a retry would no"
        + " longer replay the original attempt. NOT re-charged: check Stripe for a charge on this customer, then"
        + " either refund it and clear settlement.chargingSince, or record its intent id so the webhook finalizes it",
      bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} has a stale chargingSince (${new Date(charging).toISOString()}) with no intent — not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    return ran("pending", false, "stuck_charging");
  }

  // RATIFIED ORDERING (review round 2, O1): this guard sits BEFORE the
  // unlinked-gig waive, so an occurrence whose gig was reopened while a charge
  // is outstanding is NOT auto-waived and its deposit is NOT auto-refunded.
  // Refunding escrow while a live intent can still land would leave the
  // curator charged for a date the system has already declared owed nothing —
  // the money question outranks the linkage question. The
  // `settlement_pending_stuck` alert above is the discovery route.
  if (!gig) {
    // The gig doc is gone outright (deleteProfile's cascade). Its duration is
    // what prices this date, so there is nothing to charge — and deliberately
    // no automatic waive either: forgiving a real, already-scheduled debt is
    // an operator's call, not this function's. The sweep's step 4 already
    // waives a vanished gig BEFORE scheduling, so reaching here means the doc
    // disappeared afterwards, which is an anomaly worth a log every run.
    console.error(`chargeSettlement: ${bookingId}/${gigId} — the gig doc is gone; cannot price the settlement, left for an operator`);
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
  //   1. it CLOSES THE TRUE-UP WINDOW before the amount is computed —
  //      confirmOccurrenceActuals refuses while `chargingSince` is live, so a
  //      curator cannot add extra minutes to a charge that is already in
  //      flight and have the settlement then record an amount that was never
  //      charged;
  //   2. its write time is the CAS baseline for the terminal write, so the
  //      precondition spans the charge itself. Taking the baseline from the
  //      WRITE (rather than the read) also means the window between reading
  //      and claiming the doc is covered by the write's own precondition.
  //
  // `chargingSince` ONLY — deliberately not `updatedAt` (the same call
  // recomputePaymentSummary makes, and for the same reason: a field that
  // exists to carry a timestamp does not need a second one written beside
  // it, and the CAS baseline comes from `wr.writeTime` either way). It also
  // keeps the sweep's `updatedAt`-as-"first seen in this state" proxy honest
  // — see the enumeration at the top of paymentsSweep.ts, which is only true
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
    // charged, so there is nothing to account for — the next run re-reads.
    console.warn(`chargeSettlement: ${bookingId}/${gigId} changed before its charge could be claimed — left for the next run`);
    return ran("skipped", false, "raced");
  }

  // --- PHASE 4: MOVE MONEY ---------------------------------------------
  const math = settlementMath(p, booking, gig);
  // Starts null unconditionally — the outstanding-intent guard above has
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
    // amount. `lateFee` cannot coexist with it — a late fee only attaches
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
        `chargeSettlement: ${bookingId}/${gigId} settles below its deposit slice but the deposit was never charged — nothing to refund`);
    }
  } else if (math.chargeTotal > 0) {
    const curatorStripe = await getStripeProfileDoc(p.curatorProfileId);
    if (!curatorStripe?.customerId) {
      console.error(`chargeSettlement: curator ${p.curatorProfileId} has no Stripe customer — ${bookingId}/${gigId} not charged`);
      // Release the claim: no charge is in flight, so the true-up window must
      // re-open rather than stay shut until the marker ages out.
      await ref.update({ "settlement.chargingSince": null, updatedAt: now })
        .catch((we) => console.error(`chargeSettlement: failed to clear chargingSince on ${bookingId}/${gigId}`, we));
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
        // forever — as-built contract #7). Persist the handle, leave the
        // settlement exactly as it is, and let payment_intent.succeeded run
        // finalizeSettlementSuccess out-of-band. `chargingSince` stays set on
        // purpose: a charge really is outstanding, and the guard at the top of
        // this function keeps every later run from touching it.
        await ref.update({ "settlement.intentId": e.intentId, updatedAt: now })
          .catch((we) => console.error(`chargeSettlement: failed to record pending intent ${e.intentId} on ${bookingId}/${gigId}`, we));
        return ran("pending", false, "stuck_intent");
      }
      if (e instanceof StripeCardDeclinedError) {
        return await recordSettlementFailure({ bookingId, gigId, p, booking, baseline, now });
      }
      throw e;
    }
  }
  // else: a ZERO-charge settlement — the deposit slice covered the whole date
  // exactly. Nothing to charge, but the musician is still owed their earnings,
  // so this falls through to the same tail as a charged one.

  // --- PHASE 5: FINALIZE ------------------------------------------------
  return await finalizeSettlementSuccess({
    bookingId, gigId, intentId, chargeId, chargedCents, now, baseline,
  });
}

// Registered HERE rather than in paymentsWebhook.ts for the same reason
// payments.ts registers `account.updated` there: this module already imports
// the registry, and index.ts importing it (transitively, via paymentsSweep.ts,
// and from Task 11 also payments.ts) is what guarantees the registration has
// run before the webhook can ever fire. See this file's header for what breaks
// if that import chain is ever severed.
//
// This is the recovery half of as-built contract #7: chargeSettlement left an
// intent `processing`, persisted its id, and returned "pending". When Stripe
// confirms it, the settlement finishes exactly as the synchronous path would
// have — transfer, terminal write, ledger, aggregate, notification.
const settlementIntentSucceeded = async (object: Record<string, unknown>): Promise<void> => {
  const intentId = object.id as string | undefined;
  const meta = object.metadata as Record<string, string> | undefined;
  const bookingId = meta?.bookingId;
  const gigId = meta?.gigId;
  const purpose = meta?.purpose ?? "settlement";
  // Event payloads are signature-verified but never shape-validated, so
  // metadata is untrusted input — validate before building a doc path from it
  // (mirrors the `deposit` handler's identical guard in bookings.ts).
  if (!intentId || !bookingId || !gigId || !isValidDocId(bookingId) || !isValidDocId(gigId)) {
    console.warn(
      `payment_intent.succeeded (${purpose}): unusable metadata — intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}, gigId=${JSON.stringify(gigId ?? null)}`);
    return;
  }
  const p = (await getFirestore().doc(`bookings/${bookingId}/payments/${gigId}`).get())
    .data() as PaymentDoc | undefined;
  if (!p) return;
  // A DIFFERENT intent than the one this occurrence is waiting on: two live
  // charges exist for one settlement, and this one will never be consumed.
  // Not silently ignorable — it is precisely the stuck-money signal an
  // operator needs (same reasoning as the `deposit` handler's mismatch check).
  if (p.settlement.intentId != null && p.settlement.intentId !== intentId) {
    console.error(
      `payment_intent.succeeded (${purpose}): ${bookingId}/${gigId} is awaiting intent ${p.settlement.intentId} but ${intentId} succeeded — unconsumed charge, needs reconciliation`);
    return;
  }
  // `latest_charge` is the charge behind the intent, when Stripe sends it —
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
  // webhook, or a sweep run that already finalized this intent synchronously,
  // both land here. Logged at info (never error) so the no-op is visible
  // without looking like a fault.
  if (result.reason === "already_paid") {
    console.info(`payment_intent.succeeded (${purpose}): ${bookingId}/${gigId} is already settled — nothing to do`);
  }
};

paymentIntentSucceededHandlers["settlement"] = settlementIntentSucceeded;

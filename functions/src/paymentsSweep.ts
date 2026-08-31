/**
 * The hourly payments sweep (SP5 Task 9).
 *
 * Every SP5 money path that CANNOT complete inline lands here: a crashed
 * accept saga, a `*_pending` deposit whose executor never ran, a deposit owed
 * by a date the materializer only just created, a settlement that becomes due
 * while nobody is looking, and the expired-booking refund backstop.
 *
 * MONEY MOVES IN EVERY STEP — step 4 is easy to misread as bookkeeping
 * because its headline job is scheduling, but its waive branch refunds a
 * deposit outright, and steps 5/6 charge the settlement and transfer the
 * musician's earnings (inside `chargeSettlement`, paymentsSettlement.ts).
 *
 * Shape follows `runDailySweep`'s philosophy exactly (see scheduled.ts):
 *  - all behavior lives in the exported, clock-injected `runPaymentsSweep`, so
 *    tests drive it directly against emulator-seeded data with no scheduler
 *    emulator config and no wall-clock races;
 *  - each step is independently try/catch'd and counted, so a poisoned doc in
 *    one step never prevents the remaining steps from running;
 *  - each step's per-doc body is ALSO try/catch'd, so one poisoned doc never
 *    starves the others queued behind it;
 *  - every unbounded query is paginated with scheduled.ts's own `paginate`.
 *
 * THREE RULES THIS FILE IS BUILT AROUND — do not "simplify" any of them away:
 *
 *  1. SETTLEMENT SWEEPS NEVER FILTER BY PARENT BOOKING STATUS. A booking that
 *     is cancelled, expired or completed can still own a past-start payment
 *     doc that legitimately settles later (the musician performed that night;
 *     only the booking's paperwork moved on). Steps 4/5/6 therefore query on
 *     settlement fields alone.
 *
 *  2. IDEMPOTENCY KEYS EXPIRE AFTER 24H on real Stripe (as-built contract #5;
 *     FakeStripe's never expire, so the emulator cannot surface this). Past
 *     that window the same key is treated as brand new and would mint a
 *     SECOND charge/refund/transfer. So anything stuck longer than that is
 *     REFUSED, logged, and escalated to `adminAlerts` rather than replayed.
 *
 *  3. A BOOKING WITH `depositChargePending === true` BELONGS TO STEP 1 — no
 *     other step may touch its `unpaid` docs. Those docs are an accept saga's
 *     STAGED set: transaction A wrote them, a charge is in flight against
 *     exactly that set, and step 1's commit accounts the charge against
 *     exactly that set. Charging one (step 3), refunding one (steps 4/7), or
 *     moving one to a terminal state changes the sum step 1 will check and
 *     turns a recoverable saga into an aborted charge or, worse, a double one.
 *     Rule 3 is why steps 3, 4 and 7 each read the marker before acting on an
 *     `unpaid` doc; it does NOT conflict with rule 1, which is about
 *     settlement-side sweeps and the booking's STATUS, not its saga marker.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  SETTLEMENT_DELAY_MS, SETTLEMENT_RETRY_OFFSETS_MS,
  type BookingRequestDoc, type EventDoc, type GigDoc, type PaymentDoc, type TicketOrderDoc,
} from "@gatekeep/shared";
import {
  getStripe, stripeSecretKey, StripeCardDeclinedError, StripePaymentPendingError,
} from "./stripeClient.js";
import {
  clearDelinquencyIfSettled, declareCuratorDelinquent, getStripeProfileDoc, isFailedPrecondition,
  isDepositScheduleExhausted, recomputePaymentSummary, recordAdminAlert, resolveDepositPending,
  writeLedger, depositPendingAlertId, stalePendingAlertId, stuckSagaAlertId,
  IDEMPOTENCY_WINDOW_MS,
} from "./paymentsCore.js";
// Steps 5/6's whole job. Importing it here is ALSO what loads
// paymentsSettlement's `payment_intent.succeeded` registrations from index.ts
// (see that file's header) — do not drop this edge for a lazy import.
import { chargeSettlement } from "./paymentsSettlement.js";
import {
  abortAcceptAfterFailedCommit, commitAcceptAfterCharge, detectSelfDeal, runAcceptPostCommit,
  unstageAccept, type AcceptCommitResult,
} from "./bookings.js";
import { notifyProfileMembers } from "./notifications.js";
import { paginate } from "./scheduled.js";
import { refundOrdersForCancelledEvent } from "./ticketing.js";
import { EVENT_SETTLE_DELAY_MS, ticketSettlementBlockedAlertId } from "./eventsCore.js";

const PAGE_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

// IDEMPOTENCY_WINDOW_MS (paymentsCore.ts) is the Stripe contract; what follows
// is how THIS file measures against it. Both staleness guards below use the
// doc's own `updatedAt` as the "first seen in this state" clock: every
// transition INTO the state being recovered bumps it (transaction A's marker
// write for a saga; the cancellation transaction's `*_pending` write for a
// deposit), so it is a good enough "first seen in this state" proxy without
// adding a dedicated timestamp field to two doc shapes.
//
// The proxy is only honest if nothing ELSE bumps `updatedAt` while the doc
// sits in that state — otherwise a busy doc's clock resets and the guard
// never fires. What keeps it honest:
//  - BOOKING side: while `depositChargePending` is true, every mutating
//    booking callable refuses (acceptBooking's in-txn check; counter/decline/
//    withdrawBooking's, added in this task's review round; cancellation
//    requires `confirmed`). recomputePaymentSummary deliberately does not bump
//    updatedAt. The only writer left is this sweep recording a pending intent
//    id — which moves the booking to the webhook's care and out of this
//    guard's path entirely.
//  - PAYMENT-DOC side: the only sweep write to an already-`*_pending` doc is
//    the raced-cancellation merge in the birth-deposit charge below, which
//    bumps updatedAt for a doc whose refund has not been ISSUED yet — so
//    there is no key in flight for the window to protect, and extending it
//    is correct rather than merely benign. (Birth dunning also bumps
//    updatedAt, but only ever on `unpaid` docs, which this guard never sees.)
//    Task 10's settlement path adds one more writer that is deliberately NOT
//    an updatedAt writer: chargeSettlement's pre-charge claim writes
//    `settlement.chargingSince` alone (it carries its own timestamp, and its
//    CAS baseline is the write result). Keeping it out of `updatedAt` is what
//    lets the enumeration above stay exhaustive.
//  - PAYMENT-DOC side, the TWO CALLABLE writers (Task 10 review M2; Task 11
//    review round 1). Neither can reset the clock on any refund/transfer key
//    this sweep is deciding whether to replay, and in both cases that is
//    structural rather than luck:
//      * `confirmOccurrenceActuals` bumps `updatedAt` every time a curator
//        reports actuals, but refuses unless `settlement.status === "pending"`.
//        The deposit guard only ever looks at `refund_pending`/
//        `forfeit_pending` docs, and a doc whose deposit is `*_pending` has had
//        its settlement waived by whatever set it pending
//        (markDepositsPendingInTx / step 4 / step 7 all do), so it can never
//        also be settlement-`pending`.
//      * `payPastDue` bumps `updatedAt` on both of its paths. Its SETTLEMENT
//        path requires `settlement.status === "past_due"`, and a `past_due`
//        settlement's deposit cannot be `*_pending` either — the same waive
//        coupling holds (every path that marks a deposit pending waives a
//        not-yet-terminal settlement with it, and the ones that don't waive a
//        `past_due` settlement also leave the deposit alone). Its DEPOSIT path
//        writes only to an `unpaid` doc, which is likewise not a state the
//        deposit guard measures.
//    The saga guard reads BOOKINGS, not payment docs, and a staged saga's docs
//    are settlement-`not_due` with no `depositAttempts` at all, so neither
//    callable can reach one.

// Step 7's scan bound. An unwind older than this was either already refunded
// by an earlier run of this step or needs a human — either way, re-scanning
// every expired booking the app has ever had, every hour, forever, is not the
// price of catching it.
const EXPIRED_LOOKBACK_MS = 14 * DAY_MS;

export interface PaymentsSweepReport {
  // --- step 1: stuck accept sagas (bookings flagged depositChargePending) ---
  acceptSagasReconciled: number;   // charge replayed + accept committed + fan-out run
  acceptSagasAborted: number;      // charge replayed, commit impossible, deposit refunded
  acceptSagasDeclined: number;     // the replayed charge declined — staging removed, booking left open
  acceptSagasPending: number;      // intent still `processing` — the webhook finalizes it, not us
  acceptSagasReleased: number;     // marker set with nothing staged — released, nothing was charged
  acceptSagasRacedOut: number;     // a racer (webhook/callable) had already committed this accept
  acceptSagasStale: number;        // >24h staged — NOT replayed (see IDEMPOTENCY_WINDOW_MS)
  // --- step 2: `*_pending` deposits whose post-commit executor never ran ---
  pendingDepositsResolved: number;
  pendingDepositsStale: number;    // >24h pending — NOT re-issued (see IDEMPOTENCY_WINDOW_MS)
  // --- step 3: per-birth deposits for materializer-created occurrences ---
  birthDepositsCharged: number;
  birthDepositsDeclined: number;   // counts every declined ATTEMPT, retries included
  birthDepositsPending: number;    // intent left `processing` — never re-charged, needs admin attention
  // --- step 4: settlements scheduled once their occurrence has ended ---
  settlementsScheduled: number;    // not_due -> pending (the date was performed)
  // not_due -> waived (taken down / reopened / re-owned / gig gone) in step 4,
  // PLUS pending/past_due -> waived in steps 5/6, when the gig's linkage broke
  // after the settlement was already scheduled. One counter: it is the same
  // "this date is owed nothing" outcome either way.
  settlementsWaived: number;
  // --- steps 5/6: settlement charges + past_due retries ---
  settlementsCharged: number;
  settlementsDeclined: number;
  settlementsPending: number;      // charge left `processing` — the webhook finalizes it, not us
  // Occurrences whose settlement was RACED — a concurrent writer (a no-show
  // waive, another finalizer) moved the doc mid-run. Reported as `skipped`
  // outcomes, so this is the only place the sweep looks at
  // SettlementRunResult.reason: a race is invisible in the outcome counters
  // (nothing was achieved this run) yet it is precisely the number an
  // operator wants to see trending, because the post-transfer shape of it
  // parks money in `adminAlerts` (Task 10 review, M4).
  settlementsRaced: number;
  transfersMade: number;           // earnings transfers (one per charged settlement)
  retriesAttempted: number;        // past_due docs handed to chargeSettlement this run
  // --- shared ---
  // Curator profiles newly flagged delinquent this run — counted for BOTH
  // declaring paths (step 3's exhausted birth deposit, and steps 5/6's
  // exhausted settlement ladder), and only on the transition: a profile that
  // was already flagged does not count again.
  delinquenciesDeclared: number;
  expiredRefunds: number;          // step 7: future-dated deposits refunded off an expired booking
  // --- step 8: ticket order expiry (SP6 Task 5) ---
  ticketOrdersExpired: number;         // pending -> expired, tier inventory released
  // The intent could not be confirmed cancelable (most likely: it already
  // succeeded), left "pending" with no write at all, for finalizeTicketOrder
  // or the webhook to complete normally. Not an error: this is the expected
  // shape of "money always wins over expiry".
  ticketOrdersExpiryDeferred: number;
  // --- step 9: retry cancelled-event ticket refunds (SP6 Task 6) ---
  // Orders resolved by THIS retry pass only. cancelEvent's own inline call
  // already resolved the common case, so these are ordinarily 0 and only
  // grow when that inline call left something unresolved (a transient
  // Stripe/Firestore failure, or the pending-order race documented on
  // events.ts's cancelEvent).
  cancelledEventOrdersRefunded: number;
  cancelledEventOrdersPendingExpired: number;
  // --- step 10: T+1 ticket revenue settlement (SP6 Task 7) ---
  // Events flipped "published" -> "completed" this run, whether or not any
  // money moved for them (a zero-revenue event still completes).
  ticketSettlementsCompleted: number;
  // Of those, the subset whose curator actually received a transfer: a
  // strict subset of ticketSettlementsCompleted, never additional to it.
  ticketSettlementsTransferred: number;
  // Curator has no payout-ready Stripe account: left "published" for the
  // next pass (see ticketSettlementBlockedAlertId), never counted above.
  ticketSettlementsBlocked: number;
  // Per-step and per-anomaly failure counts — keyed, not fixed, so a new
  // anomaly gets a name instead of being folded into a neighbour's bucket.
  // NAMING: a per-doc/per-booking key is a SINGULAR noun phrase for the thing
  // that failed (`birthDeposit`, `expiredRefundMark`); a step-level key is the
  // step's own (plural) name plus `Step` (`birthDepositsStep`).
  errors: Record<string, number>;
}

function emptyReport(): PaymentsSweepReport {
  return {
    acceptSagasReconciled: 0, acceptSagasAborted: 0, acceptSagasDeclined: 0, acceptSagasPending: 0,
    acceptSagasReleased: 0, acceptSagasRacedOut: 0, acceptSagasStale: 0,
    pendingDepositsResolved: 0, pendingDepositsStale: 0,
    birthDepositsCharged: 0, birthDepositsDeclined: 0, birthDepositsPending: 0,
    settlementsScheduled: 0, settlementsWaived: 0,
    settlementsCharged: 0, settlementsDeclined: 0, settlementsPending: 0, settlementsRaced: 0,
    transfersMade: 0, retriesAttempted: 0,
    delinquenciesDeclared: 0, expiredRefunds: 0,
    ticketOrdersExpired: 0, ticketOrdersExpiryDeferred: 0,
    cancelledEventOrdersRefunded: 0, cancelledEventOrdersPendingExpired: 0,
    ticketSettlementsCompleted: 0, ticketSettlementsTransferred: 0, ticketSettlementsBlocked: 0,
    errors: {},
  };
}

function bumpError(report: PaymentsSweepReport, key: string): void {
  report.errors[key] = (report.errors[key] ?? 0) + 1;
}

// A payment doc's (bookingId, gigId) taken from its own PATH rather than its
// body. Same reasoning as markDepositsPendingInTx's "doc.id, not p.gigId": the
// path segments are what every executor builds `bookings/{b}/payments/{g}`
// from, so a doc whose stored ids ever disagreed with where it actually lives
// is still acted on where it really is.
interface PaymentLocation { bookingId: string; gigId: string }
function locate(doc: FirebaseFirestore.QueryDocumentSnapshot): PaymentLocation | null {
  const bookingRef = doc.ref.parent.parent;
  if (!bookingRef) {
    // Unreachable: every payments doc lives under bookings/{id}. Guarded
    // rather than asserted because a collection-group query is a wide net.
    console.error(`paymentsSweep: payments doc ${doc.ref.path} has no parent booking — skipped`);
    return null;
  }
  return { bookingId: bookingRef.id, gigId: doc.id };
}

// Every notification in this file is best-effort: the money has already moved
// (or deliberately not) by the time we tell anyone about it, so a failed
// delivery must never abort the step that produced it.
async function notifySafely(
  profileId: string, note: { kind: "booking"; refId: string; title: string; body: string }, context: string,
): Promise<void> {
  try {
    await notifyProfileMembers(profileId, note);
  } catch (e) {
    console.error(`paymentsSweep: notification failed (${context})`, e);
  }
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------
// The sweep has four ABSORBING states — money situations it deliberately
// refuses to act on because acting would risk moving money twice. Refusing is
// correct; refusing SILENTLY is not, and an hourly console.error is not an
// escalation either (it is 24 identical lines a day that nobody is paged on).
//
// So each absorbing branch upserts a durable `adminAlerts` row keyed on the
// underlying PROBLEM (not the run) via paymentsCore's `recordAdminAlert`
// (which lives there, not here, because Task 10's settlement path escalates
// the same way and paymentsCore cannot import this file). The ids below are
// this file's half of that naming contract.

// The id builders live in paymentsCore beside recordAdminAlert (review round 3,
// I3) — every raiser AND every reader shares one vocabulary. See that block for
// why two of the ids are deliberately shared across kinds.

// ---------------------------------------------------------------------------
// Step 1 — RECONCILE stuck accept sagas
// ---------------------------------------------------------------------------
// A booking flagged `depositChargePending` crashed between transaction A
// (stage + mark) and the commit. The recovery is to replay the charge on the
// PERSISTED attempt key — same key ⇒ Stripe hands back the original intent,
// never a second charge — and then run the very same transaction B + post-
// commit tail the callable would have run.

async function reconcileOneAcceptSaga(
  db: FirebaseFirestore.Firestore, bookingRef: FirebaseFirestore.DocumentReference,
  now: number, report: PaymentsSweepReport,
): Promise<void> {
  const bookingId = bookingRef.id;
  // FRESH read, not the paginated query's snapshot: this step charges money
  // off what it reads, and by the time a doc's turn comes the page it arrived
  // in can be minutes and hundreds of docs old. The webhook may have recorded
  // a pending intent, a racer may have committed the accept, an unstage may
  // have released the marker. EVERY guard below runs against this read.
  const booking = (await bookingRef.get()).data() as BookingRequestDoc | undefined;
  if (!booking) return;
  if (booking.depositChargePending !== true) return;   // released since the page was read

  if (booking.status !== "open") {
    // The marker only ever rides an OPEN booking: transaction A sets it, and
    // the commit and every unstage path clear it. Still set on a non-open
    // booking means a write was lost. There is no safe automatic move here —
    // committing is impossible, and refunding could hand back a CONFIRMED
    // booking's real escrow — so it is escalated and left exactly as it is.
    const shouldLog = await recordAdminAlert({
      alertId: stuckSagaAlertId(bookingId), kind: "stuck_saga_marker",
      detail: `booking is "${booking.status}" but still flagged depositChargePending`,
      bookingId, gigId: null, now,
    });
    if (shouldLog) {
      console.error(
        `paymentsSweep: booking ${bookingId} is "${booking.status}" but still flagged depositChargePending — needs admin attention (see adminAlerts/${stuckSagaAlertId(bookingId)})`);
    }
    bumpError(report, "reconcileStuckMarker");
    return;
  }

  // BEFORE the staleness guard, deliberately: a recorded pending intent means
  // chargeOffSession came back `processing`, and a same-key retry is
  // IMPOSSIBLE for it (the cached `processing` outcome replays forever — as-
  // built contract #7). Such a saga is the WEBHOOK's to finish however old it
  // is, so calling it "stale" would raise a permanent alert about a booking
  // nobody should be touching, and would hide it behind an escalation that has
  // no action attached to it.
  if (booking.depositChargeIntentId) {
    report.acceptSagasPending++;
    return;
  }

  // Staleness guard (see IDEMPOTENCY_WINDOW_MS). Past 24h the attempt key is
  // no longer a replay handle — re-charging on it would be a brand-new charge
  // — so this is refused outright and escalated. Adopting the original intent
  // via its `{bookingId, purpose}` metadata is the future enhancement that
  // would let this recover automatically.
  if (booking.updatedAt < now - IDEMPOTENCY_WINDOW_MS) {
    const shouldLog = await recordAdminAlert({
      alertId: stuckSagaAlertId(bookingId), kind: "stale_accept_saga",
      detail: `staged since ${new Date(booking.updatedAt).toISOString()} (>24h) — charge key can no longer be replayed`,
      bookingId, gigId: null, now,
    });
    if (shouldLog) {
      console.error(
        `paymentsSweep: booking ${bookingId} has been staged since ${new Date(booking.updatedAt).toISOString()} (>24h) — refusing to replay an expired idempotency key; needs admin attention (see adminAlerts/${stuckSagaAlertId(bookingId)})`);
    }
    report.acceptSagasStale++;
    return;
  }

  const attempt = booking.depositChargeAttempt;
  if (typeof attempt !== "number") {
    // Transaction A always writes the counter alongside the marker, so this
    // pair cannot occur in normal flow. Without it there is no key to replay
    // on, and inventing one would risk a second charge.
    console.error(
      `paymentsSweep: booking ${bookingId} is staged with no depositChargeAttempt — cannot replay its charge key; needs admin attention`);
    bumpError(report, "reconcileNoAttempt");
    return;
  }

  const paymentsSnap = await db.collection(`bookings/${bookingId}/payments`).get();
  const stagedDocs = paymentsSnap.docs.filter((d) => (d.data() as PaymentDoc).deposit.status === "unpaid");
  const occurrences = stagedDocs.map((d) => ({ gigId: d.id }));
  const totalChargeCents = stagedDocs.reduce((sum, d) => {
    const p = d.data() as PaymentDoc;
    return sum + p.deposit.sliceCents + p.deposit.feeShareCents;
  }, 0);

  if (stagedDocs.length === 0) {
    if (paymentsSnap.docs.some((d) => (d.data() as PaymentDoc).deposit.status === "held")) {
      // Held escrow under a booking that is still `open`: the commit's own
      // transaction writes both, so these cannot legitimately disagree.
      console.error(
        `paymentsSweep: booking ${bookingId} is open+staged but already holds deposits — needs admin attention`);
      bumpError(report, "reconcileHeldOnOpen");
      return;
    }
    // Nothing staged and nothing held ⇒ transaction A's docs were removed by
    // an unstage that then failed to clear the marker (unstageAccept's own
    // documented failure mode). No charge can be outstanding against docs
    // that never survived, so release the marker and let the booking be
    // accepted afresh.
    await unstageAccept(db, bookingId, [], false);
    report.acceptSagasReleased++;
    return;
  }

  const curatorStripe = await getStripeProfileDoc(booking.curatorProfileId);
  if (!curatorStripe?.customerId) {
    console.error(
      `paymentsSweep: booking ${bookingId} is staged but curator ${booking.curatorProfileId} has no Stripe customer — cannot replay the charge`);
    bumpError(report, "reconcileNoCustomer");
    return;
  }

  let intentId: string;
  let chargeId: string | null;
  try {
    const r = await getStripe().chargeOffSession({
      customerId: curatorStripe.customerId, amountCents: totalChargeCents,
      // The PERSISTED attempt (as-built contract #2) — this is the whole
      // point of the counter: same key, same intent, never a second charge.
      idempotencyKey: `${bookingId}:accept:deposit:${attempt}`,
      meta: { bookingId, purpose: "deposit" },
    });
    intentId = r.id;
    chargeId = r.chargeId;
  } catch (e) {
    if (e instanceof StripePaymentPendingError) {
      // Not a failure: the intent exists and is settling. Record it and hand
      // the booking to the webhook, exactly as acceptBooking does.
      await bookingRef.update({ depositChargeIntentId: e.intentId, updatedAt: now })
        .catch((we) => console.error(`paymentsSweep: failed to record pending intent ${e.intentId} on ${bookingId}`, we));
      report.acceptSagasPending++;
      return;
    }
    if (e instanceof StripeCardDeclinedError) {
      // A decline moved NO money, so there is nothing to refund — the staged
      // docs go and the marker is released, leaving the booking open for a
      // clean retry on a fresh attempt key. Same call acceptBooking makes.
      await unstageAccept(db, bookingId, occurrences, false);
      report.acceptSagasDeclined++;
      return;
    }
    throw e;
  }

  // The charge is real (or was, on the original attempt — the replay returns
  // the same intent). Record it before the commit, for the same reason
  // acceptBooking does: the money left the card whether or not the accept goes
  // on to commit. Deterministic ledger id ⇒ the original attempt's row, if it
  // was ever written, is not duplicated.
  await writeLedger({
    kind: "deposit_charged", amountCents: totalChargeCents,
    bookingId, gigId: null, profileId: booking.curatorProfileId, stripeId: intentId,
    detail: `deposit batch (${occurrences.length} occurrence(s), sweep reconciliation)`,
  }).catch((le) => console.error(`paymentsSweep: deposit_charged ledger row failed for ${bookingId}`, le));

  const isSelfDeal = await detectSelfDeal(db, booking.curatorProfileId, booking.musicianProfileId);
  let commit: AcceptCommitResult | null = null;
  let commitError: unknown = null;
  try {
    commit = await commitAcceptAfterCharge({
      bookingId, intentId, chargeId, now, isSelfDeal, expectedChargeCents: totalChargeCents,
    });
  } catch (e) {
    commitError = e;
  }

  if (commit) {
    await runAcceptPostCommit(db, bookingId, commit, now);
    report.acceptSagasReconciled++;
    return;
  }

  // Discriminate exactly as the webhook handler does: an HttpsError is the
  // PERMANENT validation family (gig closed, series moved, F2 guard, $0
  // tripwire) and the accept can never commit; anything else is transient
  // (Firestore contention/infra) and the next hourly run replays the SAME key
  // — no new money — so leave it staged rather than refunding a charge that
  // may still be about to be consumed.
  if (commitError && !(commitError instanceof HttpsError)) {
    console.error(
      `paymentsSweep: transient commit failure for ${bookingId} (intent ${intentId}) — left staged for the next run`, commitError);
    bumpError(report, "reconcileCommit");
    return;
  }

  // commitAcceptAfterCharge contract point 2: `null` means THIS CALL did not
  // commit, NOT that nothing committed. Re-read before refunding — a racer
  // (the webhook, or a concurrent callable) may have committed the very accept
  // this call was completing, and refunding a committed accept's deposit is
  // the worst failure mode in this codebase.
  const after = (await bookingRef.get()).data() as BookingRequestDoc | undefined;
  if (after?.status === "confirmed") {
    console.info(`paymentsSweep: ${bookingId} was confirmed by another writer — nothing to reconcile`);
    report.acceptSagasRacedOut++;
    return;
  }
  if (!after || after.status !== "open" || after.depositChargePending !== true) {
    console.error(
      `paymentsSweep: ${bookingId} left commit in an unexpected state (status=${String(after?.status)}, pending=${String(after?.depositChargePending)}) — not refunding; needs admin attention`);
    bumpError(report, "reconcileUnexpectedState");
    return;
  }

  if (commitError) {
    console.error(
      `paymentsSweep: commit permanently rejected for ${bookingId} (intent ${intentId}) — refunding`, commitError);
  }
  const { refunded } = await abortAcceptAfterFailedCommit({
    bookingId, intentId, attempt, amountCents: totalChargeCents,
    occurrences, curatorProfileId: booking.curatorProfileId,
  });
  if (refunded) {
    report.acceptSagasAborted++;
    return;
  }
  // abortAcceptAfterFailedCommit already logged the refund failure and
  // deliberately left the saga staged so the next run converges (the same
  // attempt key replays the charge, the refund retries under its own key).
  bumpError(report, "reconcileRefund");
}

async function reconcileAcceptSagas(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collection("bookings")
    .where("depositChargePending", "==", true).orderBy(FieldPath.documentId());
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      try {
        await reconcileOneAcceptSaga(db, doc.ref, now, report);
      } catch (e) {
        console.error(`paymentsSweep: accept-saga reconciliation failed for booking ${doc.id}`, e);
        bumpError(report, "reconcile");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2 — RESOLVE stuck `*_pending` deposits
// ---------------------------------------------------------------------------
// The `*_pending` states are the transactional intent-to-move-money written by
// whichever cancellation/no-show path decided it; a crash between that commit
// and its post-commit executor leaves a doc only this step will finish.
//
// Queried on `deposit.status` ALONE — never joined to the parent booking (see
// rule 1). Rule 3 does not apply here either: a `*_pending` doc is by
// definition no longer part of any staging set.

const PENDING_DEPOSIT_STATUSES = ["refund_pending", "forfeit_pending"] as const;

async function resolvePendingDeposits(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  for (const status of PENDING_DEPOSIT_STATUSES) {
    const q = db.collectionGroup("payments")
      .where("deposit.status", "==", status).orderBy("occurrenceStartsAt");
    for await (const page of paginate(q, PAGE_SIZE)) {
      for (const doc of page) {
        const at = locate(doc);
        if (!at) continue;
        try {
          const p = doc.data() as PaymentDoc;
          // Does resolving this doc actually touch Stripe? Only then is there
          // an idempotency key that can expire:
          //  - forfeit_pending ALWAYS transfers (resolveDepositPending's
          //    forfeit branch calls transferToAccount regardless of intentId —
          //    a never-charged deposit still owes the musician its slice), so
          //    it is never exempt;
          //  - refund_pending with NO intentId moves no money at all — it
          //    resolves straight to terminal `refunded` with no Stripe call,
          //    so refusing it would strand a doc forever over a key hazard
          //    that does not exist for it.
          const touchesStripe = status === "forfeit_pending" || p.deposit.intentId != null;
          // Staleness guard (see IDEMPOTENCY_WINDOW_MS). resolveDepositPending
          // is only safe to re-run freely INSIDE the 24h key window; past it,
          // the same key would mint a SECOND refund or a SECOND transfer.
          // Its own doc comment specifies the eventual recovery — look the
          // existing object up by the `{bookingId, gigId, purpose}` metadata
          // every call stamps, and adopt it. That lookup needs a Stripe
          // search/list surface StripeLike does not expose yet, so the
          // implemented behavior for now is REFUSE + ESCALATE (never a blind
          // replay); adding the metadata lookup is the future enhancement.
          if (touchesStripe && p.updatedAt < now - IDEMPOTENCY_WINDOW_MS) {
            const alertId = stalePendingAlertId(at.bookingId, at.gigId);
            const shouldLog = await recordAdminAlert({
              alertId, kind: "stale_pending_deposit",
              detail: `${status} since ${new Date(p.updatedAt).toISOString()} (>24h) — refund/transfer key can no longer be re-issued`,
              bookingId: at.bookingId, gigId: at.gigId, now,
            });
            if (shouldLog) {
              console.error(
                `paymentsSweep: ${at.bookingId}/${at.gigId} has been ${status} since ${new Date(p.updatedAt).toISOString()} (>24h) — refusing to re-issue on an expired idempotency key; needs admin attention (see adminAlerts/${alertId})`);
            }
            report.pendingDepositsStale++;
            continue;
          }
          // One summary recompute per doc: accepted cost, because these are
          // one-off crash recoveries scattered across DIFFERENT bookings — the
          // per-booking batching step 7 does would buy nothing here.
          await resolveDepositPending(at.bookingId, at.gigId);
          // Counted from the doc's ACTUAL post-state, not from "the executor
          // returned": it deliberately leaves a forfeit pending when the
          // musician's Stripe account has gone missing, and calling that
          // "resolved" would hide exactly the case worth watching.
          const post = (await doc.ref.get()).data() as PaymentDoc | undefined;
          if (post && post.deposit.status !== status) report.pendingDepositsResolved++;
        } catch (e) {
          console.error(`paymentsSweep: failed to resolve ${status} deposit ${at.bookingId}/${at.gigId}`, e);
          bumpError(report, "pendingDeposit");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 — BIRTH deposits
// ---------------------------------------------------------------------------
// A whole-run booking's newly materialized occurrence is staged `unpaid` by the
// daily sweep's materializer (no Stripe call in a batch write path) and charged
// individually here, on its own attempt-scoped key.

// The audit tail of a birth charge: the money moved, so both of these run
// regardless of which doc state the charge ended up landing in.
async function recordBirthCharge(
  at: PaymentLocation, curatorProfileId: string, amountCents: number, intentId: string,
): Promise<void> {
  await writeLedger({
    kind: "deposit_charged", amountCents, bookingId: at.bookingId, gigId: at.gigId,
    profileId: curatorProfileId, stripeId: intentId, detail: "birth deposit (materialized occurrence)",
  }).catch((le) => console.error(`paymentsSweep: deposit_charged ledger row failed for ${at.bookingId}/${at.gigId}`, le));
  await recomputePaymentSummary(at.bookingId)
    .catch((e) => console.error(`paymentsSweep: summary recompute failed for ${at.bookingId}`, e));
}

// Records a declined birth-deposit attempt and schedules (or gives up on) the
// next one. A decline is NOT a state change — the doc stays `unpaid`; only the
// attempt counter and the retry clock move.
async function dunBirthDeposit(
  doc: FirebaseFirestore.QueryDocumentSnapshot, at: PaymentLocation, p: PaymentDoc,
  attempts: number, chargeBaseline: FirebaseFirestore.Timestamp, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const nextAttempts = attempts + 1;
  // SETTLEMENT_RETRY_OFFSETS_MS is +1d, +2d, +2d — three retries after the
  // initial attempt. `nextAttempts` indexes the retry it schedules, so the
  // schedule is exhausted once it reaches DEPOSIT_EXHAUSTED_ATTEMPTS.
  const exhausted = isDepositScheduleExhausted(nextAttempts);
  try {
    // Under the SAME precondition the success path uses: a cancellation can
    // land during the (non-transactional) charge attempt on a declined card
    // just as easily as on a successful one, and writing dunning fields over a
    // `*_pending` doc would leave a cancelled date carrying a live retry clock.
    await doc.ref.update({
      "deposit.depositAttempts": nextAttempts,
      "deposit.depositNextRetryAt": exhausted ? null : now + SETTLEMENT_RETRY_OFFSETS_MS[nextAttempts - 1],
      updatedAt: now,
    }, { lastUpdateTime: chargeBaseline });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // The doc left `unpaid` under us. Nothing was charged (this is the decline
    // path), so there is no money to account for — and no dunning to do for a
    // deposit that is no longer owed. No counter, and deliberately NO
    // notifications: telling both sides a payment failed for a date that was
    // just cancelled is a confusing lie.
    console.error(
      `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} changed under a declined charge — dunning skipped`);
    bumpError(report, "birthDepositRaced");
    return;
  }
  report.birthDepositsDeclined++;

  if (exhausted) {
    // Delinquency, and deliberately NO late fee: late fees are a SETTLEMENT
    // concept (spec §4), never a deposit one. The flag gates every future
    // offerGig/acceptBooking for this curator until Task 11's
    // `clearDelinquencyIfSettled` lifts it.
    if (await declareCuratorDelinquent(p.curatorProfileId, now)) report.delinquenciesDeclared++;
  }

  const retryLine = exhausted
    ? "We've stopped retrying — settle it from your dashboard to book again."
    : "We'll try again automatically.";
  await notifySafely(p.curatorProfileId, {
    kind: "booking", refId: at.bookingId,
    title: "Deposit payment failed",
    body: `We couldn't charge the deposit for one of your booked dates. ${retryLine}`,
  }, `birth deposit decline ${at.bookingId}/${at.gigId}`);
  await notifySafely(p.musicianProfileId, {
    kind: "booking", refId: at.bookingId,
    title: "A deposit didn't go through",
    body: "The deposit for one of your booked dates couldn't be collected — we've let the curator know.",
  }, `birth deposit decline ${at.bookingId}/${at.gigId}`);
}

async function chargeOneBirthDeposit(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  at: PaymentLocation, now: number, report: PaymentsSweepReport,
): Promise<void> {
  // FRESH read, and every decision below is made against it — the paginated
  // page this doc arrived in can be hundreds of docs old, and this step
  // CHARGES A CARD off what it reads. Its updateTime also becomes the CAS
  // baseline for the write that records the charge.
  const freshSnap = await doc.ref.get();
  const p = freshSnap.data() as PaymentDoc | undefined;
  if (!p) return;
  // Left `unpaid` since the page was read (a cancellation, or step 2). Not
  // this step's doc any more.
  if (p.deposit.status !== "unpaid") return;

  if (p.deposit.intentId != null) {
    // Unpaid but already carrying an intent: a birth charge that came back
    // `processing` and never resolved, or an on-session pay-now intent the
    // curator has not confirmed. NEVER re-charged — that outstanding intent can
    // still succeed, so a fresh-key retry would be a real double charge.
    //
    // ESCALATED to the durable queue rather than logged bare (review round 2):
    // this is one of the sweep's absorbing states, and an hourly console.error
    // nobody reads is not an escalation — the row is the signal, the log is a
    // convenience, and recordAdminAlert throttles the latter to once a day.
    const alertId = depositPendingAlertId(at.bookingId, at.gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "deposit_pending_stuck",
      detail: `birth deposit is unpaid but holds intent ${p.deposit.intentId} — never re-charged; resolve the intent in Stripe, then clear deposit.intentId`,
      bookingId: at.bookingId, gigId: at.gigId, now,
    });
    if (shouldLog) {
      console.error(
        `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} is unpaid but holds intent ${p.deposit.intentId} — not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    report.birthDepositsPending++;
    return;
  }

  const attempts = p.deposit.depositAttempts ?? 0;

  // TERMINATOR. The retry SCHEDULE is what runs out, and the counter — not the
  // clock — is what says so: exhaustion deliberately clears
  // `depositNextRetryAt` to null (there is no next retry), so a clock-only
  // gate would read null as "due now" and re-charge this doc every hour
  // forever, minting a fresh key and a fresh decline each time. Dunning stops
  // here; the curator's delinquency flag is the standing signal, and Task 11's
  // payPastDue is the way out.
  if (isDepositScheduleExhausted(attempts)) return;

  // Dunning backoff. Filtered in application code rather than by a second
  // composite index: the candidate set is bounded by "future booked dates
  // whose deposit hasn't landed", which is tiny — same trade the daily sweep's
  // track reaper and invite sweep already make for their own age checks.
  const retryAt = p.deposit.depositNextRetryAt;
  if (typeof retryAt === "number" && retryAt > now) return;

  const booking = (await db.doc(`bookings/${at.bookingId}`).get()).data() as BookingRequestDoc | undefined;
  // NOT a violation of rule 1: an unpaid doc under a non-confirmed booking is
  // an accept saga's STAGED doc (transaction A wrote it; its own charge is in
  // flight or about to be), and charging it here — on a key that saga knows
  // nothing about — would double-charge the very accept step 1 exists to
  // reconcile. Rule 1 governs the SETTLEMENT sweeps, which must not care.
  if (!booking || booking.status !== "confirmed") return;
  // Rule 3, the explicit half: even a CONFIRMED booking can be mid-saga
  // (a second accept attempt after an unstage), and its unpaid docs are step
  // 1's alone.
  if (booking.depositChargePending === true) return;

  let chargeBaseline = freshSnap.updateTime;
  // PERSIST the counter BEFORE the attempt it names (as-built contract #2): a
  // crash between the charge and recording its outcome must re-derive the SAME
  // key next run. Absent already means 0, so this write only ever runs once
  // per doc — it makes the doc self-describing rather than relying on the
  // reader's default. Its WriteResult carries the doc's new updateTime, which
  // becomes the CAS baseline (no second read needed).
  if (p.deposit.depositAttempts == null) {
    const wr = await doc.ref.update({ "deposit.depositAttempts": attempts, updatedAt: now });
    chargeBaseline = wr.writeTime;
  }
  // Explicit, because the failure mode is SILENT: `{ lastUpdateTime: undefined }`
  // is not a weaker precondition, it is NO precondition. Only a non-existent
  // doc has no updateTime (already excluded above) — so this can't fire, and
  // if it ever did, refusing to charge is the right answer.
  if (!chargeBaseline) {
    console.error(`paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} has no updateTime — refusing to charge without a CAS baseline`);
    bumpError(report, "birthDepositNoBaseline");
    return;
  }

  const curatorStripe = await getStripeProfileDoc(p.curatorProfileId);
  if (!curatorStripe?.customerId) {
    console.error(
      `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} — curator ${p.curatorProfileId} has no Stripe customer`);
    bumpError(report, "birthDepositNoCustomer");
    return;
  }

  const amountCents = p.deposit.sliceCents + p.deposit.feeShareCents;
  try {
    const r = await getStripe().chargeOffSession({
      customerId: curatorStripe.customerId, amountCents,
      idempotencyKey: `${at.bookingId}:${at.gigId}:deposit:${attempts}`,
      meta: { bookingId: at.bookingId, gigId: at.gigId, purpose: "deposit" },
    });
    // Optimistic precondition — the same hazard step 4's waive branch guards:
    // the charge is a non-transactional gap during which a cancellation can
    // move this deposit to `refund_pending`/`forfeit_pending`. Writing `held`
    // blindly would erase that marker, and with it the executor's entire
    // record that the money is supposed to move back.
    let markedHeld = true;
    try {
      await doc.ref.update({
        "deposit.status": "held", "deposit.intentId": r.id, "deposit.chargeId": r.chargeId,
        "deposit.chargedAt": now, "deposit.depositNextRetryAt": null, updatedAt: now,
      }, { lastUpdateTime: chargeBaseline });
    } catch (ue) {
      if (!isFailedPrecondition(ue)) throw ue;
      markedHeld = false;
      const raced = (await doc.ref.get()).data() as PaymentDoc | undefined;
      if (raced?.deposit.status === "refund_pending" || raced?.deposit.status === "forfeit_pending") {
        // A cancellation won. The money DID move, so record what paid for it —
        // and deliberately NOT the status: the pending marker is now the
        // truth, and step 2's executor needs the intent id (to refund against)
        // and the charge id (as a forfeit transfer's sourceChargeId) that this
        // charge just produced. Without this write the executor would find a
        // `refund_pending` doc with a null intentId and resolve it to
        // `refunded` having sent nothing back.
        await doc.ref.update({
          "deposit.intentId": r.id, "deposit.chargeId": r.chargeId, "deposit.chargedAt": now, updatedAt: now,
        });
        console.error(
          `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} was cancelled (${raced.deposit.status}) while charging intent ${r.id} — recorded the charge and left it for the pending executor`);
      } else {
        // Something else moved it. The charge is real and now unaccounted
        // for — never silently overwritten, always surfaced.
        console.error(
          `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} changed under intent ${r.id} (now ${String(raced?.deposit.status)}) — charge recorded in the ledger only; needs admin attention`);
      }
      bumpError(report, "birthDepositRaced");
    }
    await recordBirthCharge(at, p.curatorProfileId, amountCents, r.id);
    // Counts the deposits that actually became ESCROW. A charge that landed on
    // a doc a cancellation had already claimed is money that moved but escrow
    // that never existed — it is counted in errors.birthDepositRaced instead.
    if (markedHeld) report.birthDepositsCharged++;
    // A charge that lands after a dunning run may have paid off the very debt
    // that flagged this curator. Only a query over the whole obligation set can
    // say so, which is what clearDelinquencyIfSettled is; it no-ops unless the
    // flag is actually set, so the ordinary first-attempt charge pays one read.
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((ce) => console.error(`paymentsSweep: delinquency clear failed for ${p.curatorProfileId}`, ce));
  } catch (e) {
    if (e instanceof StripePaymentPendingError) {
      // The intent exists and is settling. Persist it so the money is never
      // lost track of, leave the doc `unpaid`, and never re-charge (the guard
      // at the top of this function). There is no birth-deposit webhook
      // finaliser yet, so this is surfaced as an error for admin attention.
      await doc.ref.update({ "deposit.intentId": e.intentId, updatedAt: now })
        .catch((we) => console.error(`paymentsSweep: failed to record pending intent ${e.intentId} on ${at.bookingId}/${at.gigId}`, we));
      console.error(
        `paymentsSweep: birth deposit ${at.bookingId}/${at.gigId} left processing on intent ${e.intentId} — needs admin attention`);
      report.birthDepositsPending++;
      return;
    }
    if (e instanceof StripeCardDeclinedError) {
      await dunBirthDeposit(doc, at, p, attempts, chargeBaseline, now, report);
      return;
    }
    throw e;
  }
}

async function chargeBirthDeposits(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  // Future-dated only: a deposit is escrow against a date that hasn't happened
  // yet, so an already-started occurrence has nothing left to secure — its
  // money is settled in full by Task 10 instead (which must therefore treat an
  // uncharged deposit as "nothing to credit", not as an error).
  const q = db.collectionGroup("payments")
    .where("deposit.status", "==", "unpaid")
    .where("occurrenceStartsAt", ">", now)
    .orderBy("occurrenceStartsAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      const at = locate(doc);
      if (!at) continue;
      try {
        await chargeOneBirthDeposit(db, doc, at, now, report);
      } catch (e) {
        console.error(`paymentsSweep: birth deposit failed for ${at.bookingId}/${at.gigId}`, e);
        bumpError(report, "birthDeposit");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4 — RESOLVE due occurrences (schedule the settlement, or waive it)
// ---------------------------------------------------------------------------
// Queried on settlement fields ALONE (rule 1): a cancelled/expired booking's
// past-start date still settles here if it was genuinely performed. The waive
// branch MOVES MONEY (it refunds the deposit), which is why it carries both a
// CAS precondition and rule 3's staged-saga check.

async function resolveDueOccurrence(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  at: PaymentLocation, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const p = doc.data() as PaymentDoc;
  const gig = (await db.doc(`gigs/${at.gigId}`).get()).data() as GigDoc | undefined;

  if (gig) {
    // `durationMinutes` is minutes; the * 60_000 is load-bearing (without it
    // this asks "has it STARTED", which the query already answered).
    const gigEnd = gig.startsAt + gig.durationMinutes * 60_000;
    if (gigEnd > now) return;   // started but not finished — nothing is due yet
    if (gig.bookingId === at.bookingId && gig.status === "filled") {
      // The date stayed booked to THIS booking through to its end: it was
      // performed as far as anything here can know. Settlement opens now and
      // charges after the T+3 actuals window.
      await doc.ref.update({
        "settlement.status": "pending", "settlement.settleAfter": gigEnd + SETTLEMENT_DELAY_MS, updatedAt: now,
      }, { lastUpdateTime: doc.updateTime });
      report.settlementsScheduled++;
      await notifySafely(p.curatorProfileId, {
        kind: "booking", refId: at.bookingId,
        title: `Report actuals for "${gig.title}"`,
        body: "Tell us what actually happened (extra time, extra songs) within 3 days — after that we settle the balance as booked.",
      }, `settlement scheduled ${at.bookingId}/${at.gigId}`);
      return;
    }
  }

  // NOT performed under this booking: taken down, reopened, re-owned by a
  // different booking, or the gig doc is gone outright (deleteProfile's
  // cascade). Nothing is owed for the date, so the settlement is waived and
  // whatever deposit is still outstanding goes back.
  if (p.deposit.status === "unpaid") {
    // Rule 3. An unpaid doc under a booking with the saga marker set is an
    // accept saga's STAGED doc — transaction A wrote it and step 1 owns its
    // money. Resolving it here would delete that doc from the staged set the
    // in-flight charge was sized against, so step 1's commit would find the
    // totals no longer agree and abort an accept whose money already moved.
    const booking = (await db.doc(`bookings/${at.bookingId}`).get()).data() as BookingRequestDoc | undefined;
    if (booking?.depositChargePending === true) {
      console.warn(
        `paymentsSweep: ${at.bookingId}/${at.gigId} is due but its booking has a staged charge — left for step 1`);
      return;
    }
  }

  const updates: Record<string, unknown> = { "settlement.status": "waived", updatedAt: now };
  let resolvePending = false;
  if (p.deposit.status === "held" || (p.deposit.status === "unpaid" && p.deposit.intentId != null)) {
    // Held escrow — or an unpaid doc whose birth charge is still in flight —
    // goes back through the pending state, so the executor (here, or step 2 on
    // a later run if the refund fails) is what actually moves the money.
    updates["deposit.status"] = "refund_pending";
    resolvePending = true;
  } else if (p.deposit.status === "unpaid") {
    // Never charged and nothing in flight: there is no money to send back, so
    // this goes straight to the terminal state with no Stripe call at all.
    updates["deposit.status"] = "refunded";
    updates["deposit.resolvedAt"] = now;
    updates["deposit.depositNextRetryAt"] = null;
  }
  // Every other deposit status is deliberately untouched: `applied` is Task
  // 12's clawback territory, a `*_pending` doc already has an executor, and a
  // terminal one is done. Only the SETTLEMENT is waived for those.

  // Optimistic precondition: this doc was read by a paginated query that may
  // be a few hundred docs old, and a concurrent cancellation could have moved
  // the deposit underneath it. Without this, a stale read could re-open an
  // already-`refunded` deposit into `refund_pending` and refund it twice.
  await doc.ref.update(updates, { lastUpdateTime: doc.updateTime });
  report.settlementsWaived++;

  if (resolvePending) {
    // One summary recompute per doc: accepted cost. Waived occurrences of ONE
    // booking normally arrive on different runs (their dates end days apart),
    // so batching per booking here would almost never have anything to batch.
    // The executor also owns the delinquency lift for this path — one place
    // per path (see resolveDepositPending's tail).
    await resolveDepositPending(at.bookingId, at.gigId);
  } else {
    await recomputePaymentSummary(at.bookingId)
      .catch((e) => console.error(`paymentsSweep: summary recompute failed for ${at.bookingId}`, e));
    // The no-executor path: an `unpaid` deposit went straight to `refunded`
    // just above (or there was nothing left to move). That still EXTINGUISHES
    // the obligation — and an exhausted birth deposit is exactly the kind that
    // gates a curator — so the lift belongs here, where no executor will run.
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((e) => console.error(`paymentsSweep: delinquency clear failed for ${p.curatorProfileId}`, e));
  }
}

async function resolveDueOccurrences(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collectionGroup("payments")
    .where("settlement.status", "==", "not_due")
    .where("occurrenceStartsAt", "<=", now)
    .orderBy("occurrenceStartsAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      const at = locate(doc);
      if (!at) continue;
      try {
        await resolveDueOccurrence(db, doc, at, now, report);
      } catch (e) {
        console.error(`paymentsSweep: due-occurrence resolution failed for ${at.bookingId}/${at.gigId}`, e);
        bumpError(report, "dueOccurrence");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Steps 5 & 6 — CHARGE due settlements, RETRY past_due ones
// ---------------------------------------------------------------------------
// MONEY MOVES HERE. `chargeSettlement` (paymentsSettlement.ts) owns everything about
// one occurrence's settlement — the true-up read, the T+3 charge, the earnings
// transfer, and all of the attempts/nextRetryAt/delinquency bookkeeping. These
// loops only find the due docs, isolate per-doc failures, and count outcomes.
//
// Queried on settlement fields ALONE (rule 1): a cancelled or expired
// booking's past-start occurrence settles here exactly like any other — the
// musician performed that night.

async function runSettlementCharges(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
  spec: { status: "pending" | "past_due"; dueField: "settlement.settleAfter" | "settlement.nextRetryAt";
    countRetry: boolean; errorKey: string },
): Promise<void> {
  const q = db.collectionGroup("payments")
    .where("settlement.status", "==", spec.status)
    .where(spec.dueField, "<=", now)
    .orderBy(spec.dueField);
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      const at = locate(doc);
      if (!at) continue;
      try {
        if (spec.countRetry) report.retriesAttempted++;
        const { outcome, transferred, reason } = await chargeSettlement({ bookingId: at.bookingId, gigId: at.gigId, now });
        if (outcome === "charged") report.settlementsCharged++;
        else if (outcome === "declined") report.settlementsDeclined++;
        else if (outcome === "pending") report.settlementsPending++;
        else if (outcome === "waived") report.settlementsWaived++;
        // Orthogonal to the outcome bucket above, not an alternative to it: a
        // race that landed mid-transfer reports `skipped` WITH `transferred`
        // true, and both facts matter. See settlementsRaced's own note.
        if (reason === "raced") report.settlementsRaced++;
        // The 4th decline of the dunning ladder is still a decline, so it is
        // already counted above; this counts the DELINQUENCY it declared,
        // which the outcome cannot express. Only the transition reports it —
        // recordSettlementFailure sets the reason off declareCuratorDelinquent's
        // own "was it me who declared it" answer, so a profile already flagged
        // by another occurrence is never double-counted.
        if (reason === "delinquent") report.delinquenciesDeclared++;
        // Counted off what actually FIRED, not off the outcome: the earnings
        // transfer happens inside chargeSettlement (it needs the settlement
        // charge's own charge id as its sourceChargeId), and it can both be
        // absent from a "charged" run (zero earnings) and present on one that
        // lost its terminal write. `transferred` is the only honest handle.
        if (transferred) report.transfersMade++;
      } catch (e) {
        console.error(`paymentsSweep: settlement charge failed for ${at.bookingId}/${at.gigId}`, e);
        bumpError(report, spec.errorKey);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 7 — EXPIRED-booking refund backstop
// ---------------------------------------------------------------------------
// unwindBookingsForModeration (profile rejection/deletion cascades) expires a
// confirmed booking without touching its money — deliberately, so the refund
// decision lives in one place. This is that place: expired + a deposit still
// out = refund.
//
// SCOPED TO FUTURE-DATED OCCURRENCES ONLY. A PAST-dated held deposit of an
// expired booking is not a refund: that night's show may well have happened,
// and its money settles through steps 4/5 like any other performed date.
// Refunding it here would take a performed date's escrow back from a musician
// who earned it.

async function refundOneExpiredBooking(
  db: FirebaseFirestore.Firestore, bookingId: string, booking: BookingRequestDoc,
  now: number, report: PaymentsSweepReport,
): Promise<void> {
  // Rule 3. An expired booking that still carries the saga marker has BOTH
  // problems at once: a charge may be in flight against its unpaid docs, and
  // expiring a staged booking should not have been possible in the first
  // place (that is the anomaly step 1 escalates). Refunding here would race a
  // live charge on a set step 1 is still accounting for — so this booking is
  // left entirely alone until a human releases the saga.
  if (booking.depositChargePending === true) {
    const alertId = stuckSagaAlertId(bookingId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "expired_booking_saga_marker",
      detail: "expired booking still flagged depositChargePending — deposits left for step 1 / an operator",
      bookingId, gigId: null, now,
    });
    if (shouldLog) {
      console.error(
        `paymentsSweep: expired booking ${bookingId} still has a staged charge — skipping its deposits (see adminAlerts/${alertId})`);
    }
    bumpError(report, "expiredStagedSaga");
    return;
  }

  // Bounded by occurrences-per-booking (the dates one booking covers), never
  // by the payments collection — same read shape recomputePaymentSummary
  // already makes.
  const paymentsSnap = await db.collection(`bookings/${bookingId}/payments`).get();
  const marked: string[] = [];
  for (const doc of paymentsSnap.docs) {
    const p = doc.data() as PaymentDoc;
    if (p.occurrenceStartsAt <= now) continue;                                    // past dates settle, never refund here
    if (p.deposit.status !== "held" && p.deposit.status !== "unpaid") continue;    // already resolved / applied / pending
    try {
      const updates: Record<string, unknown> = { "deposit.status": "refund_pending", updatedAt: now };
      // A date that will never happen never settles. Guarded to the two
      // "hasn't happened yet" states — a paid/past_due settlement is a real
      // money record and must never be erased (markDepositsPendingInTx makes
      // the identical distinction).
      if (p.settlement.status === "not_due" || p.settlement.status === "pending") {
        updates["settlement.status"] = "waived";
      }
      await doc.ref.update(updates, { lastUpdateTime: doc.updateTime });
      marked.push(doc.id);
    } catch (e) {
      console.error(`paymentsSweep: failed to mark expired-booking deposit ${bookingId}/${doc.id} refund_pending`, e);
      bumpError(report, "expiredRefundMark");
    }
  }
  if (marked.length === 0) return;

  // Executor runs AFTER the markers are committed, exactly like every
  // cancellation path: the marker is the intent, this is the effect, and step
  // 2 finishes anything this loop drops.
  for (const gigId of marked) {
    try {
      // skipRecompute: these are all docs of ONE booking, so the aggregate is
      // recomputed once below instead of once per occurrence.
      await resolveDepositPending(bookingId, gigId, { skipRecompute: true });
      // Counted from the doc's ACTUAL post-state (same reasoning as step 2):
      // a refund that failed leaves the doc `refund_pending` for the next run,
      // and calling that "refunded" would overstate what this run achieved.
      const post = (await db.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc | undefined;
      if (post?.deposit.status === "refunded") report.expiredRefunds++;
    } catch (e) {
      console.error(`paymentsSweep: failed to refund expired-booking deposit ${bookingId}/${gigId}`, e);
      bumpError(report, "expiredRefundResolve");
    }
  }
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`paymentsSweep: summary recompute failed for ${bookingId}`, e));
  // The per-booking tail this loop's `skipRecompute` defers: ONE lift for the
  // whole booking rather than one per refunded occurrence. An expired booking's
  // future dates going back is an extinguished obligation like any other, and
  // any of them could have been the exhausted birth deposit gating this curator.
  await clearDelinquencyIfSettled(booking.curatorProfileId, now)
    .catch((e) => console.error(`paymentsSweep: delinquency clear failed for ${booking.curatorProfileId}`, e));
}

async function refundExpiredBookingDeposits(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collection("bookings")
    .where("status", "==", "expired")
    .where("resolvedAt", ">=", now - EXPIRED_LOOKBACK_MS)
    .orderBy("resolvedAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const bookingDoc of page) {
      try {
        await refundOneExpiredBooking(db, bookingDoc.id, bookingDoc.data() as BookingRequestDoc, now, report);
      } catch (e) {
        console.error(`paymentsSweep: expired-refund backstop failed for booking ${bookingDoc.id}`, e);
        bumpError(report, "expiredRefundBooking");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 8: EXPIRE stale ticket orders (SP6 Task 5)
// ---------------------------------------------------------------------------
// A "pending" ticket order holds its tier inventory (soldCount was
// incremented at createTicketOrder) until either the buyer completes payment
// (completeOrderTx flips it to "paid") or its TTL elapses. This step reclaims
// the latter case.
//
// MONEY ALWAYS WINS OVER EXPIRY, the same SP5 invariant paymentsCore.ts's
// header states for the booking side. The PaymentIntent cancel is attempted
// FIRST, entirely outside any Firestore transaction (Stripe calls never run
// inside one, same rule every other step in this file follows). Only once
// the cancel is CONFIRMED to have left the intent canceled (either because
// this call's own cancelIntent just succeeded, or because a throw from it is
// followed by a retrieveIntentStatus read confirming "canceled", see
// expireOneTicketOrder below) does this step touch Firestore to release the
// inventory and mark the order expired. A throw from cancelIntent that
// cannot be confirmed "canceled" this way (most commonly because the intent
// already succeeded, i.e. money moved) makes NO write at all for that order:
// it is left exactly "pending", so finalizeTicketOrder or the
// payment_intent.succeeded webhook can still complete it normally on the next
// attempt.
//
// THE retrieveIntentStatus FALLBACK EXISTS BECAUSE cancelIntent's OWN THROW
// IS AMBIGUOUS between "already succeeded" and "already canceled" (see its
// doc comment on StripeLike): a prior sweep pass can have its cancelIntent
// call succeed and then crash before the Firestore transaction below
// commits, leaving the order "pending" with an intent that is now, on this
// pass, ALREADY canceled. Treating that ambiguous throw as "always defer"
// would strand such an order pending, with its inventory held, forever.

async function expireOneTicketOrder(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  report: PaymentsSweepReport,
): Promise<void> {
  // FRESH read: this step may cancel a Stripe intent off what it reads here,
  // and the paginated page it arrived in can be minutes (and hundreds of
  // docs) old.
  const freshSnap = await doc.ref.get();
  const order = freshSnap.data() as TicketOrderDoc | undefined;
  if (!order || order.status !== "pending") return; // resolved since the page was read

  if (order.paymentIntentId) {
    try {
      await getStripe().cancelIntent(order.paymentIntentId);
    } catch (e) {
      // The cancel call itself failed. Two distinct causes throw identically
      // here (cancelIntent's own doc comment): the intent already succeeded
      // (money moved), or it was already canceled, most likely by THIS
      // step's own cancelIntent call on a prior pass whose Firestore
      // transaction below then failed to commit (a crash, contention). A
      // canceled intent can NEVER later succeed, so that second case is safe
      // to proceed on; anything else (including a failure to even read the
      // status) must stay deferred, per money always wins over expiry.
      let status: string | undefined;
      try {
        status = (await getStripe().retrieveIntentStatus(order.paymentIntentId)).status;
      } catch (statusError) {
        console.error(
          `paymentsSweep: ticket order ${doc.id} could not confirm intent ${order.paymentIntentId}'s status after a failed cancel, left pending`, statusError);
      }
      if (status !== "canceled") {
        console.info(
          `paymentsSweep: ticket order ${doc.id} expiry deferred, intent ${order.paymentIntentId} could not be confirmed cancelable (status=${status ?? "unknown"}), left pending for finalize/webhook`, e);
        report.ticketOrdersExpiryDeferred++;
        return;
      }
      // Confirmed already canceled: fall through to the same expiry
      // transaction the ordinary cancel-succeeded path runs below.
    }
  }

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const o = snap.data() as TicketOrderDoc | undefined;
      if (!o || o.status !== "pending") return; // raced since the fresh read above
      for (const item of o.items) {
        tx.update(db.doc(`events/${o.eventId}/tiers/${item.tierId}`), {
          soldCount: FieldValue.increment(-item.quantity),
        });
      }
      tx.update(doc.ref, { status: "expired" });
    });
    report.ticketOrdersExpired++;
  } catch (e) {
    console.error(`paymentsSweep: failed to expire ticket order ${doc.id}`, e);
    bumpError(report, "ticketOrderExpire");
  }
}

async function expireTicketOrders(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collection("orders")
    .where("status", "==", "pending")
    .where("expiresAt", "<", now)
    .orderBy("expiresAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      try {
        await expireOneTicketOrder(db, doc, report);
      } catch (e) {
        console.error(`paymentsSweep: ticket order expiry failed for ${doc.id}`, e);
        bumpError(report, "ticketOrderExpire");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 9: RETRY cancelled-event ticket refunds (SP6 Task 6)
// ---------------------------------------------------------------------------
// events.ts's `cancelEvent` callable already ran refundOrdersForCancelledEvent
// once, inline, right after flipping the event to "cancelled". This is that
// same idempotent function's retry backstop, the ticketing equivalent of
// step 7's expired-booking refund backstop, for whatever it could not
// finish: a per-order Stripe/Firestore failure (already escalated to
// adminAlerts by refundOrdersForCancelledEvent itself), or the pending-order
// race documented on cancelEvent (createTicketOrder checks event status
// non-transactionally, so a pending order can be born in the ms-wide window
// right around the cancellation and miss cancelEvent's own pass entirely).
//
// SCOPED to a lookback window off `cancelledAt`, same rationale as step 7's
// EXPIRED_LOOKBACK_MS: an event cancelled longer ago than this and still not
// fully resolved needs a human, not an ever-growing rescan of the whole
// events collection every hour forever.

async function retryCancelledEventRefunds(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collection("events")
    .where("status", "==", "cancelled")
    .where("cancelledAt", ">=", now - EXPIRED_LOOKBACK_MS)
    .orderBy("cancelledAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      try {
        const event = doc.data() as EventDoc;
        const result = await refundOrdersForCancelledEvent(doc.id, event.title, now);
        report.cancelledEventOrdersRefunded += result.ordersRefunded;
        report.cancelledEventOrdersPendingExpired += result.pendingExpired;
        // refundOrdersForCancelledEvent already escalated each individual
        // order failure to adminAlerts (with its own throttled log); this
        // just keeps the step-level error count honest so an operator
        // scanning report.errors sees SOMETHING moved for this event.
        if (result.errors > 0) bumpError(report, "cancelledEventRefund");
      } catch (e) {
        console.error(`paymentsSweep: cancelled-event refund retry failed for event ${doc.id}`, e);
        bumpError(report, "cancelledEventRefund");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 10: SETTLE ticket revenue T+1 (SP6 Task 7)
// ---------------------------------------------------------------------------
// A "published" event whose endsAt is more than EVENT_SETTLE_DELAY_MS (T+1)
// in the past owes its curator the face value of every ticket actually sold:
// summed across the event's "paid" orders as faceTotalCents minus
// refundedFaceCents (Task 6's grace refunds and cancellations both maintain
// that field, so this is a field read, never a join). "cancelled" orders are
// excluded by the "paid" filter alone.
//
// Mirrors SP5's settlement discipline (paymentsSettlement.ts): the Stripe
// transfer happens OUTSIDE any Firestore transaction (an idempotency key
// keyed on the event protects a retry), then the event flips to "completed"
// and the ledger row is written. The event's own status doubles as the CAS:
// a retry whose transfer succeeded but whose completion write then failed
// finds the event still "published" on its next pass and re-enters this same
// path, re-checking "published" immediately before the transfer call so the
// retry replays the SAME idempotency key rather than minting a second one.
//
// A curator with no payout-ready Stripe account gets an escalated adminAlert
// and a notification to finish onboarding; the event is left "published" for
// the next hourly pass rather than wedged or silently dropped.
//
// A zero-revenue event (every ticket free, or every paid ticket refunded
// away) still completes: there is simply nothing to transfer or to ledger.

async function settleOneEvent(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: number, report: PaymentsSweepReport,
): Promise<void> {
  // FRESH read: the paginated page this doc arrived in can be minutes (and
  // hundreds of docs) old, and every decision below is made off this read.
  const freshSnap = await doc.ref.get();
  const event = freshSnap.data() as EventDoc | undefined;
  if (!event || event.status !== "published") return; // resolved since the page was read

  const ordersSnap = await db.collection("orders")
    .where("eventId", "==", doc.id).where("status", "==", "paid").get();
  let faceCents = 0;
  for (const orderDoc of ordersSnap.docs) {
    const order = orderDoc.data() as TicketOrderDoc;
    faceCents += order.faceTotalCents - order.refundedFaceCents;
  }

  if (faceCents > 0) {
    const curatorStripe = await getStripeProfileDoc(event.curatorProfileId);
    if (!curatorStripe?.accountId || curatorStripe.transfersEnabled !== true) {
      const alertId = ticketSettlementBlockedAlertId(doc.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "ticket_settlement_blocked",
        detail: `event ${doc.id} ("${event.title}") owes ${faceCents}c in ticket settlement, but curator `
          + `${event.curatorProfileId} has no payout-ready Stripe account; left "published" for the next sweep pass`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) {
        console.error(
          `paymentsSweep: event ${doc.id} ticket settlement blocked, curator ${event.curatorProfileId} not payout-ready (see adminAlerts/${alertId})`);
      }
      try {
        await notifyProfileMembers(event.curatorProfileId, {
          kind: "ticket", refId: doc.id, title: "Finish payout setup to receive ticket revenue",
          body: `"${event.title}" has ticket revenue ready to settle. Finish Stripe onboarding to receive it.`,
        });
      } catch (e) {
        console.error(`paymentsSweep: ticket settlement blocked notification failed for event ${doc.id}`, e);
      }
      report.ticketSettlementsBlocked++;
      return;
    }

    // RE-CHECK "published" immediately before the Stripe call: this step's
    // own retry contract (see this step's header comment). The read above is
    // now one Stripe-profile lookup old, and this is what makes a retry after
    // a failed completion write land on this exact line again with the SAME
    // idempotency key, curator and amount, so Stripe replays the original
    // transfer instead of minting a second one.
    const reSnap = await doc.ref.get();
    const reEvent = reSnap.data() as EventDoc | undefined;
    if (!reEvent || reEvent.status !== "published") return; // raced since the read above

    const transfer = await getStripe().transferToAccount({
      accountId: curatorStripe.accountId, amountCents: faceCents,
      idempotencyKey: `ticket_settlement:${doc.id}`,
      meta: { purpose: "ticket_settlement", eventId: doc.id },
    });

    await writeLedger({
      kind: "ticket_settlement", amountCents: faceCents, bookingId: null, gigId: null,
      profileId: event.curatorProfileId, stripeId: transfer.id,
      detail: `ticket settlement (T+1) for "${event.title}"`,
      eventId: doc.id, buyerUid: null,
    }).catch((e) => console.error(`paymentsSweep: ticket_settlement ledger row failed for event ${doc.id}`, e));
    report.ticketSettlementsTransferred++;
  }

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const e = snap.data() as EventDoc | undefined;
      if (!e || e.status !== "published") return; // raced
      tx.update(doc.ref, { status: "completed", completedAt: now, updatedAt: now });
    });
    report.ticketSettlementsCompleted++;
  } catch (e) {
    console.error(`paymentsSweep: failed to complete event ${doc.id} after ticket settlement`, e);
    bumpError(report, "ticketSettlementComplete");
  }
}

async function settleTicketRevenue(
  db: FirebaseFirestore.Firestore, now: number, report: PaymentsSweepReport,
): Promise<void> {
  const q = db.collection("events")
    .where("status", "==", "published")
    .where("endsAt", "<", now - EVENT_SETTLE_DELAY_MS)
    .orderBy("endsAt");
  for await (const page of paginate(q, PAGE_SIZE)) {
    for (const doc of page) {
      try {
        await settleOneEvent(db, doc, now, report);
      } catch (e) {
        console.error(`paymentsSweep: ticket settlement failed for event ${doc.id}`, e);
        bumpError(report, "ticketSettlement");
      }
    }
  }
}

// ---------------------------------------------------------------------------

// Every step is isolated: one failing step is logged and counted, and the rest
// still run. Ordering is deliberate — reconciliation first (it can turn staged
// docs into held ones the later steps then see), then the pending executors,
// then charges, then scheduling, then the settlement loops, then the backstop.
export async function runPaymentsSweep(now: number): Promise<PaymentsSweepReport> {
  const db = getFirestore();
  const report = emptyReport();

  const steps: { name: string; run: () => Promise<void> }[] = [
    { name: "reconcile", run: () => reconcileAcceptSagas(db, now, report) },
    { name: "pendingDeposits", run: () => resolvePendingDeposits(db, now, report) },
    { name: "birthDeposits", run: () => chargeBirthDeposits(db, now, report) },
    { name: "dueOccurrences", run: () => resolveDueOccurrences(db, now, report) },
    {
      name: "chargeSettlements",
      run: () => runSettlementCharges(db, now, report, {
        status: "pending", dueField: "settlement.settleAfter", countRetry: false, errorKey: "chargeSettlement",
      }),
    },
    {
      name: "retrySettlements",
      run: () => runSettlementCharges(db, now, report, {
        status: "past_due", dueField: "settlement.nextRetryAt", countRetry: true, errorKey: "retrySettlement",
      }),
    },
    { name: "expiredRefunds", run: () => refundExpiredBookingDeposits(db, now, report) },
    { name: "ticketOrderExpiry", run: () => expireTicketOrders(db, now, report) },
    { name: "cancelledEventRefunds", run: () => retryCancelledEventRefunds(db, now, report) },
    { name: "ticketSettlement", run: () => settleTicketRevenue(db, now, report) },
  ];

  for (const step of steps) {
    try {
      await step.run();
    } catch (e) {
      console.error(`paymentsSweep: step "${step.name}" failed`, e);
      bumpError(report, `${step.name}Step`);
    }
  }

  return report;
}

// Thin wrapper — all logic lives in runPaymentsSweep above so it's directly
// testable with an injected clock (same shape as dailySweep).
//
// HOURLY, not daily: every deadline this sweep enforces (a stuck saga's 24h
// idempotency window, a settlement's T+3 due time, a dunning retry offset) is
// measured in hours or days, and a daily cadence would put up to 24h of drift
// on each of them. `secrets: [stripeSecretKey]` is mandatory — steps 1 and 3
// both reach getStripe(), which fails CLOSED outside the emulator without it.
export const paymentsSweep = onSchedule(
  { schedule: "every 1 hours", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", secrets: [stripeSecretKey] },
  async () => { await runPaymentsSweep(Date.now()); },
);

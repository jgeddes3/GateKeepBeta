/**
 * SP5 money PRIMITIVES — the layer every other payments file builds on:
 *  - the booking money gates and their caller-facing copy;
 *  - the payment-doc factory and the fee-policy snapshot;
 *  - the append-only ledger and the booking-level `paymentSummary` aggregate;
 *  - the DEPOSIT executor (`resolveDepositPending`) and the transactional
 *    intent-to-move-money marker that pairs with it;
 *  - the profile-level delinquency pair — `declareCuratorDelinquent` and
 *    `clearDelinquencyIfSettled`, which is the one place that knows what
 *    "this curator owes nothing" means;
 *  - the adminAlerts escalation queue, INCLUDING the id vocabulary every
 *    raiser and reader shares;
 *  - the small shared predicates the money paths must agree on to the letter
 *    (`isDepositScheduleExhausted`, `isUnconfirmedPayDueDeposit`,
 *    `isFailedPrecondition`) and the Stripe idempotency window they measure
 *    against.
 *
 * Deliberately does NOT own the settlement state machine (the T+3 charge, the
 * dunning ladder, delinquency declaration, payPastDue's finalizers): that
 * lives in `paymentsSettlement.ts`, which imports THIS file. Keep the arrow
 * pointing that way — bookings.ts, bookingLifecycle.ts and scheduled.ts all
 * import this module, and none of them has any business pulling in the
 * settlement machine.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  computeDepositCents, computeExpectedTotalCents, computeFeeShareCents,
  DEFAULT_FEE_POLICY, SETTLEMENT_RETRY_OFFSETS_MS,
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  BOOKING_NOT_CONFIRMABLE_MESSAGE, CARD_DECLINED_MESSAGE, DEPOSIT_PROCESSING_MESSAGE,
  DEPOSIT_RECONCILING_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE,
} from "@gatekeep/shared";
import type {
  AdminAlertDoc, AdminAlertKind, BookingRequestDoc, BudgetStructure, DepositState, DepositStatus,
  FeePolicy, LedgerEntry, PaymentDoc, PaymentSummary, StripeProfileDoc,
} from "@gatekeep/shared";
import { getStripe } from "./stripeClient.js";

// profiles/{profileId}/private/stripe — the payment-identity doc. Shared
// helper so every SP5 callable/handler that needs the cached Stripe identity
// (payments.ts's callables + the account.updated webhook handler) reads it
// the same way, rather than each re-deriving the doc path.
export async function getStripeProfileDoc(profileId: string): Promise<StripeProfileDoc | null> {
  const snap = await getFirestore().doc(`profiles/${profileId}/private/stripe`).get();
  return (snap.data() as StripeProfileDoc | undefined) ?? null;
}

// Task 5 booking gates, Task 6 accept-saga outcomes, and the Task 6
// accept-abort message — moved to @gatekeep/shared/messages.ts (review round
// 1, the fix round before Task 15) so apps/web can import these exact
// strings instead of hand-copying them. Re-exported here so every existing
// in-repo import (this file's own gates below, bookings.ts, gigSeries.ts,
// and functions/test/*) keeps resolving from "./paymentsCore.js" unchanged.
export {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  BOOKING_NOT_CONFIRMABLE_MESSAGE, CARD_DECLINED_MESSAGE, DEPOSIT_PROCESSING_MESSAGE,
  DEPOSIT_RECONCILING_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE,
};

// Every OTHER mutation of an `open` booking (counter / decline / withdraw)
// while an accept saga is staged on it. Distinct from the two accept-path
// messages above because the caller here isn't accepting anything — they're
// being told the booking is briefly frozen, not that their own payment is.
//
// This guard is money-safety, not politeness (SP5 Task 9 review, item 4):
//  - a resolved booking (declined/withdrawn) still carrying the saga marker
//    can never be committed OR safely refunded by the sweep — it lands in the
//    stuck-marker branch and needs a human;
//  - and any such write bumps `updatedAt`, which is precisely the sweep's
//    ">24h staged" proxy — resetting it would keep the expired-key guard from
//    ever firing on a genuinely stranded charge.
export const BOOKING_LOCKED_BY_DEPOSIT_MESSAGE =
  "A deposit payment is processing for this booking — try again in a few minutes.";
// (ACCEPT_ABORTED_REFUNDED_MESSAGE — the charge landed but the accept could
// not be committed and the refund SUCCEEDED — now lives in
// @gatekeep/shared/messages.ts and is re-exported above.)

// Curator-side money gate: saved card + not delinquent. Required before
// offerGig and before acceptBooking (either side accepting lands the deposit
// charge on the CURATOR's card, so acceptBooking always checks the curator
// profile regardless of which side is calling).
export async function requireCuratorChargeable(curatorProfileId: string): Promise<StripeProfileDoc> {
  const sp = await getStripeProfileDoc(curatorProfileId);
  if (!sp?.customerId || !sp.defaultPaymentMethodId) {
    throw new HttpsError("failed-precondition", CURATOR_CARD_REQUIRED_MESSAGE);
  }
  // === true, never truthiness alone on the PERMISSIVE side: these docs are
  // cast unchecked from Firestore — a partial doc must fail CLOSED (Task 4
  // review M8). COPY HAZARD: this line is fail-closed only as a COMPOSITE
  // with the card check above it, not on its own — a doc with `delinquent`
  // absent entirely (undefined !== true) sails straight through THIS check;
  // it's caught only because the card-fields check already threw for any
  // doc that isn't fully populated. Don't lift this line out to somewhere
  // that doesn't have that guarantee already in front of it.
  if (sp.delinquent === true) throw new HttpsError("failed-precondition", CURATOR_DELINQUENT_MESSAGE);
  return sp;
}

// Musician-side money gate: payout-ready Express account. Required before
// applyToGig and re-checked at acceptBooking.
export async function requireMusicianPayoutReady(musicianProfileId: string): Promise<StripeProfileDoc> {
  const sp = await getStripeProfileDoc(musicianProfileId);
  if (!sp?.accountId || sp.transfersEnabled !== true) {   // fail closed on partial docs (Task 4 review M8)
    throw new HttpsError("failed-precondition", MUSICIAN_PAYOUTS_REQUIRED_MESSAGE);
  }
  return sp;
}

// The fee policy SNAPSHOT stamped onto a booking at accept. Deliberately a
// spread of shared's DEFAULT_FEE_POLICY rather than a hand-rolled literal
// over the five fee constants (which is what the plan sketched): money.ts
// already warns that a second hand-rolled copy of the default is exactly how
// the accept-time snapshot and resolveFeePolicy's fallback drift apart. The
// spread also hands back a MUTABLE copy — DEFAULT_FEE_POLICY is frozen, and
// returning it by reference would let a caller's `{...}`-free write blow up
// (or, worse, corrupt every later fallback on a warm instance).
export function currentFeePolicy(): FeePolicy {
  return { ...DEFAULT_FEE_POLICY };
}

// One occurrence of a booking, as staged by the accept saga. `durationMinutes`
// is THAT occurrence's own (an occurrence detached from its series template
// with an edited duration settles on its own duration — sp4-rulings), never
// the initiating gig's.
export interface StagedOccurrence { gigId: string; startsAt: number; durationMinutes: number; }

// Builds one payment doc (bookings/{bookingId}/payments/{gigId}) for one
// occurrence — the money truth for that date. baseCents comes from the
// occurrence's OWN duration (perHour) / the frozen songCount (perSong) /
// the flat amount (perSet); every other field starts at its "nothing has
// happened yet" value. Pure: no Date.now(), no Firestore — the caller stages
// the returned doc inside its own transaction.
export function buildPaymentDoc(params: {
  booking: BookingRequestDoc; bookingId: string; occ: StagedOccurrence;
  amountCents: number; expectedQuantity: number | null; structure: BudgetStructure;
  feePolicy: FeePolicy; selfDeal: boolean; now: number;
}): PaymentDoc {
  const { booking, bookingId, occ, amountCents, expectedQuantity, structure, feePolicy, selfDeal, now } = params;
  const baseCents = computeExpectedTotalCents(structure, amountCents, {
    durationMinutes: occ.durationMinutes, songCount: expectedQuantity ?? undefined,
  });
  const sliceCents = computeDepositCents(baseCents);
  return {
    bookingId, gigId: occ.gigId, occurrenceStartsAt: occ.startsAt,
    curatorProfileId: booking.curatorProfileId, musicianProfileId: booking.musicianProfileId, selfDeal,
    baseCents,
    deposit: {
      sliceCents, feeShareCents: computeFeeShareCents(sliceCents, feePolicy.curatorFeePct),
      intentId: null, chargeId: null, status: "unpaid",
      chargedAt: null, resolvedAt: null, forfeitTransferId: null,
    },
    settlement: {
      status: "not_due", settleAfter: null, computedCents: null, feeShareCents: null,
      trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
      lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
    },
    transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
    createdAt: now, updatedAt: now,
  };
}

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  // The Admin SDK surfaces the underlying gRPC status as a numeric code (6 =
  // ALREADY_EXISTS); the string forms are a defensive fallback, not the
  // expected shape. Mirrors stripeClient.ts's identical helper.
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// Append-only audit row for every money event. Best-effort at call sites that
// run post-commit (a failed ledger write must never fail a committed money
// move — callers wrap in try/catch); the sweep's reconciliation re-derives
// nothing from the ledger, so a lost row is an audit gap, not a money bug.
//
// Doc id is DETERMINISTIC (`{kind}:{stripeId}`) whenever the entry carries a
// stripeId: a re-processed webhook delivery or a saga retry that calls
// writeLedger again for the SAME underlying Stripe object must not duplicate
// the audit row. .create() (not .set()) so a second writer's ALREADY_EXISTS
// is detectable — it's swallowed (logged, not thrown; matches the
// best-effort contract above) rather than silently overwriting the first
// row. Only entries with no stripeId fall back to a random id via .add().
//
// LOAD-BEARING INVARIANT: stripeId must identify the specific Stripe object
// this ROW is about, and be unique per INTENDED row — `kind` is part of the
// doc id too, so two DIFFERENT kinds can safely share a stripeId (e.g. a
// deposit_charged and a later refund both keyed off the same PaymentIntent
// id), but a caller that legitimately needs two DISTINCT rows of the SAME
// kind for the same underlying object must invent its own more specific
// deterministic id — passing the same (kind, stripeId) pair for two
// intentionally-separate rows silently collapses them into one. NO CALL SITE
// THROUGH TASK 11 needs that, and each one is safe for a specific reason:
//  - `deposit_charged` / `settlement_charged` key off the PaymentIntent, which
//    is unique per charge (and per pay-now attempt, since those keys are
//    attempt-scoped);
//  - `refund`, `forfeit_transfer` and `earnings_transfer` key off an object
//    Stripe mints fresh per call, which is what makes the whole-run case safe:
//    several occurrences refund off ONE shared deposit intent, but each gets
//    its own refund object;
//  - `late_fee` (Task 11) has NO Stripe object at all and would otherwise fall
//    back to a random id on every re-entry of the declaring path, so it invents
//    the deterministic `latefee:{bookingId}:{gigId}` — exactly the "more
//    specific id" this note prescribes, and the one example of it so far.
// A future caller that would reuse a (kind, stripeId) pair across two intended
// rows must not pass stripeId bare.
// An empty string is treated the same as null (falls back to
// a random id) — Stripe never issues empty-string ids, so an empty string
// here only ever means "the caller doesn't have one yet."
export async function writeLedger(entry: Omit<LedgerEntry, "at"> & { at?: number }): Promise<void> {
  const db = getFirestore();
  const full: LedgerEntry = { ...entry, at: entry.at ?? Date.now() };
  if (full.stripeId) {
    const ref = db.doc(`ledger/${full.kind}:${full.stripeId}`);
    try {
      await ref.create(full);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      // info, not error: a suppressed duplicate is the deterministic-id
      // design WORKING (a redelivered webhook, a saga retry, the callable and
      // the webhook both recording one charge), not a fault to investigate.
      console.info(`writeLedger: duplicate suppressed for ${full.kind}:${full.stripeId}`);
    }
    return;
  }
  await db.collection("ledger").add(full);
}

// Deposit statuses under which the curator's money is still out (charged and
// not yet refunded) — see the per-status table on recomputePaymentSummary.
const PAID_DEPOSIT_STATUSES = new Set<DepositStatus>([
  "held", "applied", "forfeit_pending", "forfeited", "refund_pending",
]);

// Recomputes bookings/{id}.paymentSummary from the payments subcollection.
// Non-transactional, self-healing aggregate (recompute-from-truth, like
// recomputeReliability) — call after any payment-doc transition; a
// concurrent write racing this read just means the NEXT transition's
// recompute converges again, same as any other self-healing aggregate in
// this codebase. The read is bounded by occurrences-per-booking (how many
// gig dates one booking has), never the whole payments collection.
//
// Per-status contribution (DepositStatus / SettlementStatus / TransferStatus
// — see types.ts):
//   deposit.status:
//     unpaid          -> nothing (not charged yet)
//     held            -> heldCents += sliceCents; paidCents += sliceCents+feeShareCents
//     applied         -> paidCents += sliceCents+feeShareCents (escrow released into
//                        the occurrence's settlement — no longer "held", still curator-paid)
//     refund_pending  -> paidCents += sliceCents+feeShareCents (refund not yet completed)
//     refunded        -> nothing (curator got it back)
//     forfeit_pending -> paidCents += sliceCents+feeShareCents (forfeiture not yet completed)
//     forfeited       -> paidCents += sliceCents+feeShareCents;
//                        transferredCents += sliceCents (a forfeited deposit IS a transfer
//                        to the musician, on top of whatever transfer.status separately says)
//   settlement.status:
//     paid            -> paidCents += computedCents+feeShareCents+lateFeeCents
//     past_due        -> anyPastDue = true; delinquentAt != null -> anyDelinquent = true
//     not_due/pending/waived -> nothing
//   transfer.status:
//     transferred     -> transferredCents += amountCents
//     none/pending/reversed  -> nothing
export async function recomputePaymentSummary(bookingId: string): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection(`bookings/${bookingId}/payments`).get();
  let heldCents = 0, paidCents = 0, transferredCents = 0;
  let anyPastDue = false, anyDelinquent = false;
  for (const doc of snap.docs) {
    const p = doc.data() as PaymentDoc;
    if (p.deposit.status === "held") heldCents += p.deposit.sliceCents;
    if (PAID_DEPOSIT_STATUSES.has(p.deposit.status)) paidCents += p.deposit.sliceCents + p.deposit.feeShareCents;
    if (p.deposit.status === "forfeited") transferredCents += p.deposit.sliceCents;
    if (p.settlement.status === "paid") {
      paidCents += (p.settlement.computedCents ?? 0) + (p.settlement.feeShareCents ?? 0) + (p.settlement.lateFeeCents ?? 0);
    }
    if (p.settlement.status === "past_due") {
      anyPastDue = true;
      if (p.settlement.delinquentAt != null) anyDelinquent = true; // explicit marker <=> delinquency reached
    }
    if (p.transfer.status === "transferred") transferredCents += p.transfer.amountCents ?? 0;
  }
  const summary: PaymentSummary = {
    state: anyDelinquent ? "delinquent" : anyPastDue ? "past_due" : "current",
    heldCents, paidCents, transferredCents,
  };
  // paymentSummary ONLY — deliberately not updatedAt. Bumping updatedAt here
  // would reorder every BookingInbox listing (orderBy(updatedAt)) on every
  // payment tick, even though nothing the inbox actually displays changed.
  await db.doc(`bookings/${bookingId}`).update({ paymentSummary: summary });
}

// ---------- Task 8: cancellation money ----------

// Resolves ONE payment doc's `*_pending` deposit to its terminal state by
// actually moving the money. Runs POST-COMMIT of the cancellation
// transaction that set the pending marker (that marker is the transactional
// intent-to-move-money; this is the effect), so it must be safe to run zero,
// one, or many times:
//   - the doc CAS below (act only on `refund_pending`/`forfeit_pending`)
//     makes a second runner a no-op — Task 9's sweep re-runs exactly the
//     docs still stuck pending after a crash between commit and executor;
//   - the Stripe idempotency keys are per-(booking,gig,purpose), so a
//     double-execute that happens INSIDE Stripe's key window (executor and
//     sweep overlapping) replays the SAME refund/transfer object rather
//     than moving money twice.
//
// LIMIT OF THAT SECOND GUARANTEE (do not overstate it): real Stripe expires
// idempotency keys after 24h (as-built contract #5 — FakeStripe's never
// expire, so the emulator cannot surface this). A doc still `*_pending` more
// than 24h after its first attempt is therefore NOT safe to re-run blindly:
// the same key would be treated as brand new and mint a SECOND refund or a
// SECOND transfer. Task 9's sweep must, for such a doc, first look up the
// existing object by the `{bookingId, gigId, purpose}` metadata stamped on
// every call below (that metadata is the recovery handle, and is why it is
// written) and adopt it if found — or else refuse and log for admin
// attention, exactly as the sweep's >24h `depositChargePending`
// reconciliation guard already does. This function itself is only ever safe
// to call freely within that window.
//
// Never throws for a missing/already-terminal doc — callers log and continue.
//
// `skipRecompute` suppresses the trailing paymentSummary recompute — and, with
// it, the trailing delinquency lift — for a caller that is resolving SEVERAL
// docs of the SAME booking in a loop and will run both itself afterwards. The recompute reads the whole payments
// subcollection and rewrites one aggregate field, so doing it per-doc in a
// loop is N reads to produce N-1 intermediate values nobody observes. Only
// pass it if you actually run the recompute after the loop — the aggregate is
// self-healing, but leaving it stale until the next unrelated payment tick is
// a real (if temporary) reporting error on the booking.
export async function resolveDepositPending(
  bookingId: string, gigId: string, opts: { skipRecompute?: boolean } = {},
): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`bookings/${bookingId}/payments/${gigId}`);
  const snap = await ref.get();
  const p = snap.data() as PaymentDoc | undefined;
  if (!p) return;
  // The CAS. Anything else — already `refunded`/`forfeited` (a racer got
  // here first), still `held`/`unpaid` (nothing asked for a resolution), or
  // `applied` (Task 12's clawback territory) — is deliberately untouched.
  if (p.deposit.status !== "refund_pending" && p.deposit.status !== "forfeit_pending") return;
  const now = Date.now();

  if (p.deposit.status === "refund_pending") {
    // The fee share ALWAYS comes back with the deposit slice on a refund
    // (spec §1) — the platform only ever keeps it on a FORFEIT, and there by
    // simply not refunding it.
    const amountCents = p.deposit.sliceCents + p.deposit.feeShareCents;
    // AN UNCONFIRMED PAY-NOW INTENT IS NOT A CHARGE (review round 2, D2) —
    // see isUnconfirmedPayDueDeposit for what makes `chargedAt` the sound
    // discriminator. Refunding one would be a refund of nothing: FakeStripe
    // throws "refund of unknown intent"/"refund exceeds charge", and real
    // Stripe 400s on a PaymentIntent with no successful charge, so the doc
    // would be stranded `refund_pending` forever by an error that can never
    // resolve.
    //
    // So this resolves terminally with NO Stripe call, exactly as a
    // never-charged deposit does. The intent itself is left dangling; the
    // proper unwind is cancelling it, which needs the same future
    // `StripeLike.cancelIntent` the abandoned-settlement path is waiting on.
    //
    // THE RESIDUAL RISK, stated honestly: that intent CAN still be confirmed
    // by a browser holding its clientSecret, minting a charge for a deposit
    // that has just been refunded away. The webhook finalizer refusing a
    // no-longer-`unpaid` doc is the HAZARD, not the mitigation — a refusal
    // alone would leave captured money with nothing recording it. What makes
    // it safe is that the refusal is not silent: finalizeDepositPayDue reports
    // `not_unpaid`, and the handler treats attested money on that path as a
    // race — ledger row plus a `deposit_raced` alert — so an operator sees the
    // charge and refunds it.
    if (p.deposit.intentId && !isUnconfirmedPayDueDeposit(p.deposit)) {
      // PARTIAL refund against the accept batch's shared intent: a whole-run
      // booking's occurrences all point at ONE intent, and each doc refunds
      // only its own slice+fee of it. Keyed per-(booking,gig) so the
      // occurrences never collide on one key.
      const r = await getStripe().refund({
        intentId: p.deposit.intentId, amountCents,
        idempotencyKey: `${bookingId}:${gigId}:refund`,
        meta: { bookingId, gigId, purpose: "deposit_refund" },
      });
      await ref.update({ "deposit.status": "refunded", "deposit.resolvedAt": now, updatedAt: now });
      await writeLedger({
        kind: "refund", amountCents, bookingId, gigId,
        profileId: p.curatorProfileId, stripeId: r.id, detail: "deposit refund (incl. fee share)",
      }).catch((e) => console.error(`resolveDepositPending: ledger write failed for refund ${bookingId}/${gigId}`, e));
    } else {
      // Never charged: a doc still `unpaid` when the cancellation landed (a
      // webhook-recovery accept whose intent never succeeded, a birth deposit
      // the sweep hadn't charged yet) — or one carrying only an UNCONFIRMED
      // pay-now intent, per the note above. There is no money to send back, so
      // this resolves straight to the terminal state; no Stripe call, and no
      // ledger row for money that never moved.
      await ref.update({
        "deposit.status": "refunded", "deposit.resolvedAt": now,
        "deposit.depositNextRetryAt": null, updatedAt: now,
      });
    }
  } else {
    // 100% of the deposit BASE to the musician — no commission is taken on a
    // forfeit; the platform keeps the curator's fee share by simply not
    // refunding it (see the refund branch above).
    const musicianStripe = await getStripeProfileDoc(p.musicianProfileId);
    if (!musicianStripe?.accountId) {
      // Unreachable in normal flow (accept is gated on a payout-ready
      // musician), so this is a genuine anomaly worth an error log — the doc
      // is LEFT `forfeit_pending` on purpose: Task 9's sweep retries it once
      // the account exists again, and the musician's money is never silently
      // dropped by flipping to a terminal state here.
      console.error(`resolveDepositPending: no Stripe account for forfeit ${bookingId}/${gigId} — left pending for the sweep`);
      // Recompute anyway before bailing: the CALLER'S transaction already
      // moved this doc to `forfeit_pending`, so the booking aggregate is
      // stale whether or not the transfer happened — and the summary counts
      // the `*_pending` states explicitly (see recomputePaymentSummary's
      // per-status table). Skipping it here would leave the deposit
      // reading as still-held escrow for as long as the doc stays stuck.
      if (!opts.skipRecompute) {
        await recomputePaymentSummary(bookingId)
          .catch((e) => console.error(`resolveDepositPending: summary recompute failed for ${bookingId}`, e));
      }
      return;
    }
    const t = await getStripe().transferToAccount({
      accountId: musicianStripe.accountId, amountCents: p.deposit.sliceCents,
      idempotencyKey: `${bookingId}:${gigId}:forfeit`,
      meta: { bookingId, gigId, purpose: "forfeit" },
      // As-built contract #3: a transfer backed by a fresh charge passes the
      // charge id so it draws on THAT charge's funds instead of the
      // platform's aggregate available balance (a not-yet-settled charge
      // would otherwise fail `balance_insufficient` in live mode). Can
      // legitimately be null — a deposit finalized out-of-band by the
      // payment_intent.succeeded webhook need not know its charge id — in
      // which case the transfer simply draws on the platform balance.
      ...(p.deposit.chargeId ? { sourceChargeId: p.deposit.chargeId } : {}),
    });
    await ref.update({
      "deposit.status": "forfeited", "deposit.resolvedAt": now,
      "deposit.forfeitTransferId": t.id, updatedAt: now,
    });
    await writeLedger({
      kind: "forfeit_transfer", amountCents: p.deposit.sliceCents, bookingId, gigId,
      profileId: p.musicianProfileId, stripeId: t.id, detail: "deposit forfeited to musician (100%)",
    }).catch((e) => console.error(`resolveDepositPending: ledger write failed for forfeit ${bookingId}/${gigId}`, e));
  }

  // Best-effort, exactly like every other recompute call site: a failure here
  // leaves a stale aggregate that the next payment transition re-derives
  // (self-healing), never a wrong terminal state on the doc above.
  //
  // THE DELINQUENCY LIFT LIVES HERE, once, for BOTH terminal paths. Reaching
  // this line means the deposit is now `refunded` or `forfeited` — either way
  // that obligation is extinguished, and if it was an exhausted birth deposit
  // it was the very thing gating the curator. Doing it in the executor rather
  // than at each caller is what makes it exhaustive: the cancellation paths,
  // the no-show path, the two waive branches and the sweep's steps 2 and 7 all
  // funnel through here.
  //
  // `skipRecompute` defers BOTH per-booking/per-profile tails — the batching
  // caller (step 7) runs the recompute AND the lift itself, once, after its
  // loop, instead of N times inside it.
  if (!opts.skipRecompute) {
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`resolveDepositPending: summary recompute failed for ${bookingId}`, e));
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((e) => console.error(`resolveDepositPending: delinquency clear failed for ${p.curatorProfileId}`, e));
  }
}

// Marks the given payment docs `*_pending` inside the CALLER'S transaction —
// the atomic "this money is going to move" record that pairs with the
// cancellation write itself, so a crash before the executor above runs leaves
// a doc the sweep can find and finish (rather than a cancelled booking whose
// deposit nobody ever resolves).
//
// `forfeitGigId` names the ONE doc that forfeits (a run-level curator late
// cancel forfeits only the occurrence the window was measured against — plan
// refinement, binding); null ⇒ everything refunds. Only `held`/`unpaid` docs
// are touched: an already-resolved doc, or one whose deposit was `applied`
// into a settlement, is none of a cancellation's business (Task 12 owns the
// clawback of an applied deposit).
//
// Takes DocumentSnapshot (not QueryDocumentSnapshot) so a single-doc caller —
// cancelOccurrence, which reads one payment doc by path — can pass its own
// read straight through; a snapshot for a doc that doesn't exist is skipped,
// which is exactly the pre-SP5-booking no-op both callers want.
//
// Returns the touched gig ids so the caller can run resolveDepositPending on
// each, post-commit.
//
// CALLER OBLIGATIONS (all three are load-bearing):
//  1. WRITE PHASE ONLY. This issues tx.update()s, so every read the caller's
//     transaction needs — including the `paymentDocs` snapshots themselves —
//     must already have happened. Calling it before a later tx.get() makes
//     Firestore reject the whole transaction.
//  2. SAME BOOKING ONLY. The returned ids are bare gig ids, and the caller
//     pairs them back with ITS OWN bookingId to build the
//     `bookings/{bookingId}/payments/{gigId}` path. Passing docs from two
//     different bookings would hand back ids the caller then resolves under
//     the wrong booking — every caller reads its docs from one booking's
//     subcollection, and that is a requirement, not a coincidence.
//  3. A SKIPPED DOC GETS NO SETTLEMENT WAIVE EITHER. The deposit guard gates
//     BOTH writes — a doc whose deposit isn't `held`/`unpaid` keeps its
//     settlement untouched. That coupling is safe here because: a
//     future-dated doc can't be `applied` (a deposit is only applied by
//     settlement, which never runs before the occurrence happens); an
//     already-`*_pending`/terminal doc had its settlement waived by whichever
//     call set it pending; and `paid`/`past_due` settlements must never be
//     erased regardless. A caller that needs the waive DECOUPLED from the
//     deposit decision must do it itself — reportNoShow deliberately does,
//     for the REPORTED (past-dated, possibly already-`applied`) doc, whose
//     show is known not to have happened.
export function markDepositsPendingInTx(
  tx: FirebaseFirestore.Transaction, paymentDocs: FirebaseFirestore.DocumentSnapshot[],
  forfeitGigId: string | null, now: number,
): string[] {
  const touched: string[] = [];
  for (const doc of paymentDocs) {
    const p = doc.data() as PaymentDoc | undefined;
    if (!p) continue;
    if (p.deposit.status !== "held" && p.deposit.status !== "unpaid") continue;
    // doc.id, not p.gigId: the doc id IS the path segment resolveDepositPending
    // is called with, so a doc whose stored gigId ever disagreed with its own
    // path would still be resolved at the path that was actually written.
    const next = doc.id === forfeitGigId ? "forfeit_pending" : "refund_pending";
    const update: { [key: string]: unknown } = { "deposit.status": next, updatedAt: now };
    // A cancelled occurrence never settles. Guarded to the two "hasn't
    // happened yet" settlement states — a `paid`/`past_due` settlement is a
    // real money record and must never be erased by waiving it here.
    if (p.settlement.status === "not_due" || p.settlement.status === "pending") {
      update["settlement.status"] = "waived";
    }
    tx.update(doc.ref, update);
    touched.push(doc.id);
  }
  return touched;
}

// ---------- Task 9: sweep-shared helpers ----------

// How long a Stripe idempotency key stays a REPLAY handle (as-built contract
// #5). Inside this window, re-issuing a call with the same key replays the
// original object — which is what makes every recovery path in SP5 safe to
// re-run. Past it, Stripe treats the key as brand new and the "recovery" would
// mint a SECOND charge/refund/transfer.
//
// Lives here rather than in paymentsSweep.ts because it is a property of the
// Stripe contract, not of the sweep: the sweep measures its two staleness
// guards against it, and releaseStuckSaga (payments.ts) uses the same window
// to decide whether a stuck saga is still the sweep's to fix or an operator's.
// FakeStripe's keys never expire, so the emulator cannot surface any of this.
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// The first `deposit.depositAttempts` value that means "this birth deposit's
// retry schedule is over". SETTLEMENT_RETRY_OFFSETS_MS is the schedule (+1d,
// +2d, +2d — three retries after the initial attempt), so the count runs 1..3
// while retries remain and hits this on the failure that exhausts it.
//
// Named because FOUR places need the same terminator and were each spelling it
// out (review round 3, M5): the sweep's step-3 gate, its dunning writer,
// payPastDue's deposit-mode predicate, and clearDelinquencyIfSettled's debt
// query — which needs the CONSTANT rather than the predicate, because it asks
// Firestore the question as a range filter.
export const DEPOSIT_EXHAUSTED_ATTEMPTS = SETTLEMENT_RETRY_OFFSETS_MS.length + 1;

// Absent means zero: the counter is written lazily (persist-before-charge), so
// a doc that has never been attempted simply has no field.
export function isDepositScheduleExhausted(depositAttempts: number | null | undefined): boolean {
  return (depositAttempts ?? 0) >= DEPOSIT_EXHAUSTED_ATTEMPTS;
}

// A deposit carrying ONLY an on-session intent that was never confirmed.
//
// payPastDue's deposit mode records its intent id BEFORE the curator confirms
// it in the browser, so an `unpaid` doc can reference an intent that nothing
// was ever captured against. `chargedAt` is the discriminator, and it is a
// sound one because it is written ONLY by paths that know money moved (the
// sweep's birth charge, finalizeDepositPayDue) — never by the callable that
// merely creates the intent.
//
// Two callers depend on this being the SAME test (review round 3, I1):
// resolveDepositPending must not issue a refund against it (there is no charge
// to refund — real Stripe 400s), and finalizeSettlementSuccess must be able to
// retire such a deposit when a settlement absorbs it, exactly as it retires one
// with no intent at all. A second, hand-rolled copy of the condition that drifts
// from this one turns either of those into a money bug.
export function isUnconfirmedPayDueDeposit(deposit: DepositState): boolean {
  return deposit.intentId != null
    && deposit.intentId === deposit.payDueIntentId
    && deposit.chargedAt == null;
}

// Flags a curator profile delinquent — the one place that stamps
// `private/stripe.delinquent`, so every declaring path (Task 9's birth-deposit
// dunning, Task 11's settlement dunning) writes the identical shape.
//
// `delinquentSince` is stamped ONCE and never re-stamped: it is the "how long
// has this profile been overdue" clock an operator reads, and a second
// declaration (a different occurrence's deposit failing next week) must not
// silently reset it to look freshly delinquent. Returns whether THIS call is
// what declared it, so the caller only counts/notifies on the transition.
//
// `{ merge: true }` (not update): a curator that has never had a
// private/stripe doc written can still be flagged — the doc is created with
// just these fields, and every reader of it fails CLOSED on partial docs
// (see requireCuratorChargeable's copy-hazard note), so a partial doc here
// gates MORE, never less.
//
// The lifting half is `clearDelinquencyIfSettled` directly below — kept apart
// because declaring is a single-doc fact while lifting is a question about the
// profile's WHOLE obligation set.
export async function declareCuratorDelinquent(profileId: string, now: number): Promise<boolean> {
  const ref = getFirestore().doc(`profiles/${profileId}/private/stripe`);
  const existing = (await ref.get()).data() as StripeProfileDoc | undefined;
  if (existing?.delinquent === true) return false;
  await ref.set({ delinquent: true, delinquentSince: now, updatedAt: now }, { merge: true });
  return true;
}

// Lifts the profile-level `delinquent` flag once the curator owes NOTHING —
// the inverse of declareCuratorDelinquent above, and deliberately its
// neighbour: the two paths that DECLARE delinquency are the settlement dunning
// ladder and the birth-deposit dunning ladder, so the one that LIFTS it has to
// ask about both kinds of debt or the gate becomes one-way.
//
// TWO QUESTIONS, both `limit(1)` — "does ANY debt remain?", never "list it":
//  1. SETTLEMENT debt: any payment doc of any booking of this profile still
//     `past_due` (rungs 1-3 of the ladder count, not just delinquency itself —
//     an unpaid debt is an unpaid debt).
//  2. DEPOSIT debt: any doc whose birth deposit is still `unpaid` after its
//     retry schedule ran out — DEPOSIT_EXHAUSTED_ATTEMPTS, the same terminator
//     every other site uses, asked of Firestore as a range filter rather than
//     through isDepositScheduleExhausted (a query cannot call a predicate).
//
// THE RANGE FILTER IS LOAD-BEARING, not a convenience: Firestore indexes only
// documents that HAVE the field, so `depositAttempts >= n` cannot match a doc
// that never carries it. Every accept-saga STAGED doc is exactly that (the
// field is written only by step 3's own persist-before-charge, on a birth
// deposit it is about to attempt), so rule 3's docs are excluded from this
// query structurally rather than by a second condition someone could later
// drop. A never-dunned birth deposit is excluded the same way.
//
// CALLED WHEREVER AN OBLIGATION IS EXTINGUISHED, not merely paid — a debt that
// is waived, refunded or forfeited is just as gone as one that was settled, and
// a curator left gated over a date nobody owes any more cannot book at all. The
// call sites are: this file's resolveDepositPending tail (every terminal
// refund/forfeit), finalizeSettlementSuccess's tail (every settled date),
// payPastDue's two on-session paths, and the sweep's steps 3, 4 and 7.
//
// Reads the flag FIRST and returns early when it is not set: a curator who was
// never delinquent must not have `delinquent: false` and a fresh `updatedAt`
// written after every single money event, and the early return keeps both
// collection-group queries off the hot path entirely.
export async function clearDelinquencyIfSettled(curatorProfileId: string, now: number): Promise<void> {
  const sp = await getStripeProfileDoc(curatorProfileId);
  if (sp?.delinquent !== true) return;
  const db = getFirestore();
  // Backed by the cg composite index (curatorProfileId, settlement.status).
  const openSettlement = await db.collectionGroup("payments")
    .where("curatorProfileId", "==", curatorProfileId)
    .where("settlement.status", "==", "past_due")
    .limit(1).get();
  if (!openSettlement.empty) return;
  // Backed by the cg composite index
  // (curatorProfileId, deposit.status, deposit.depositAttempts).
  const openDeposit = await db.collectionGroup("payments")
    .where("curatorProfileId", "==", curatorProfileId)
    .where("deposit.status", "==", "unpaid")
    .where("deposit.depositAttempts", ">=", DEPOSIT_EXHAUSTED_ATTEMPTS)
    .limit(1).get();
  if (!openDeposit.empty) return;
  await db.doc(`profiles/${curatorProfileId}/private/stripe`).set(
    { delinquent: false, delinquentSince: null, updatedAt: now }, { merge: true });
}

// A `{ lastUpdateTime: ... }` precondition that lost its race. The Admin SDK
// surfaces the underlying gRPC status as a numeric code (9 =
// FAILED_PRECONDITION); the string forms are a defensive fallback, not the
// expected shape. Mirrors isAlreadyExists above.
//
// Lives here (rather than in paymentsSweep.ts, where Task 9 first wrote it)
// because paymentsSettlement.ts's writes use the identical optimistic-CAS
// idiom, and both of those files import this one, never the other way round.
export function isFailedPrecondition(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 9 || code === "failed-precondition" || code === "FAILED_PRECONDITION";
}

const ALERT_LOG_THROTTLE_MS = 24 * 60 * 60 * 1000;

// ---------- the adminAlerts id vocabulary ----------
//
// EVERY alert id in SP5 is built by one of these functions, and they all
// live here rather than beside their raisers (review round 3, I3). Three
// reasons, and the third is the one that bites:
//  - the ids are DETERMINISTIC per underlying problem, so an hourly sweep
//    updates one row instead of minting 24 a day — which only holds if every
//    raiser of a given problem agrees on the string;
//  - READERS need them too. releaseStuckSaga looks up `stuck-saga:{bookingId}`
//    by id to decide whether the sweep has given up on a booking, and then
//    resolves that same row; a hand-written literal there is a silent coupling
//    to a format defined in another file.
//  - two of these ids are SHARED by more than one raiser on purpose (see the
//    per-id notes), which is a decision that has to be visible in one place to
//    survive.
// Format is `{problem}-{scope}:{ids}`, hyphenated, with the booking id first
// (or, for the one profile-scoped id, the profile id first).

// Step 1's accept-saga problems. ONE id for all three kinds
// (`stuck_saga_marker`, `stale_accept_saga`, `expired_booking_saga_marker`):
// they are the same stuck booking seen from different angles, an operator
// resolves them the same way (releaseStuckSaga), and recordAdminAlert
// deliberately re-logs when the KIND changes on an existing row so the
// transition is still visible.
export function stuckSagaAlertId(bookingId: string): string { return `stuck-saga:${bookingId}`; }
// Step 2: a `*_pending` deposit older than Stripe's key window.
export function stalePendingAlertId(bookingId: string, gigId: string): string {
  return `stale-pending:${bookingId}:${gigId}`;
}
// Step 3: an `unpaid` deposit carrying an unresolved intent.
export function depositPendingAlertId(bookingId: string, gigId: string): string {
  return `deposit-pending:${bookingId}:${gigId}`;
}
// A pay-now deposit whose money was captured against a doc a racer had already
// claimed — escrow that does not exist for a charge that does.
export function depositRacedAlertId(bookingId: string, gigId: string): string {
  return `deposit-raced:${bookingId}:${gigId}`;
}
// A settlement whose money moved but whose terminal write lost a race. SHARED
// with finalizeSettlementSuccess's "can no longer be priced" escalation: both
// mean "money moved against this occurrence and no state records it", which is
// one problem for one operator, not two rows.
export function settlementRacedAlertId(bookingId: string, gigId: string): string {
  return `settlement-raced:${bookingId}:${gigId}`;
}
// A settlement charge whose fate is unknown — an intent left `processing`, an
// abandoned pay-now intent, or a pre-charge claim stale past the key window.
export function settlementPendingAlertId(bookingId: string, gigId: string): string {
  return `settlement-pending:${bookingId}:${gigId}`;
}
// A settlement that cannot pay the musician because they have no payout
// account. Deliberately NOT the pending id: nothing is stuck in Stripe and the
// fix is Express onboarding, not an intent.
export function settlementPayoutAlertId(bookingId: string, gigId: string): string {
  return `settlement-payout:${bookingId}:${gigId}`;
}
// Task 12: this occurrence's money could not be moved back where it belongs.
// FOUR raisers, and deliberately one id, because they are all "the money for
// this date is in the wrong place and a human must finish moving it":
//   1-3. clawbackSettledOccurrence's three failure routes — a Stripe refusal
//        part way through the sequence, a terminal write that lost its race
//        after the money came back, and a `paid` occurrence with no transfer to
//        reverse at all;
//   4.   restoreFalselyReportedBooking's money leg, the mirror image: the
//        booking was restored but its settlement could not be re-opened, so the
//        date will never re-charge. There is no re-drive for that one — see its
//        own comment — which is exactly why it needs a durable row.
// reportNoShow's defensive catch around the clawback raises nothing: the
// clawback never throws, so that catch only ever logs.
export function clawbackAlertId(bookingId: string, gigId: string): string {
  return `clawback:${bookingId}:${gigId}`;
}
// Task 13: an instant payout whose 4% fee could not be debited back off the
// connected account. THE ONLY PROFILE-SCOPED id in this vocabulary (payouts are
// not booking-scoped at all), and scoped to the REQUEST rather than the profile
// so two different uncollected fees are two tickets — the operator recovers each
// one separately, and a replayed request (same requestId) updates the one row it
// already has instead of minting a second.
export function payoutFeeAlertId(profileId: string, requestId: string): string {
  return `payout-fee:${profileId}:${requestId}`;
}

// The durable "a human has to look at this" queue (adminAlerts/{alertId}).
// Every SP5 path that deliberately REFUSES to move money — because moving it
// would risk moving it twice — upserts a row here keyed on the underlying
// PROBLEM (not the run), and throttles its console.error to once per UTC day.
// The row is the signal; the log is a convenience.
//
// Moved here from paymentsSweep.ts in Task 10: paymentsSettlement.ts escalates
// the same way the sweep does (a settlement whose terminal write lost a race
// to a no-show waive), and the import direction only permits sharing in this
// direction.
//
// Returns whether the caller should log this observation.
export async function recordAdminAlert(a: {
  alertId: string; kind: AdminAlertKind; detail: string;
  // Null only for the one profile-scoped kind (`payout_fee_uncollected` —
  // payouts belong to no booking); every other raiser names an occurrence.
  bookingId: string | null; gigId: string | null; now: number;
}): Promise<boolean> {
  const ref = getFirestore().doc(`adminAlerts/${a.alertId}`);
  try {
    const existing = (await ref.get()).data() as AdminAlertDoc | undefined;
    if (!existing) {
      const doc: AdminAlertDoc = {
        kind: a.kind, detail: a.detail, bookingId: a.bookingId, gigId: a.gigId,
        firstSeenAt: a.now, lastSeenAt: a.now, runCount: 1, resolvedAt: null,
      };
      await ref.set(doc);
      return true;
    }
    // `resolvedAt: null` on every recurrence: an operator marking this
    // resolved while the condition still exists must not silence it forever —
    // the next observation reopens the row. `firstSeenAt` is deliberately NOT
    // re-stamped (see AdminAlertDoc): it measures the episode, not the ticket.
    await ref.update({
      kind: a.kind, detail: a.detail, lastSeenAt: a.now,
      runCount: FieldValue.increment(1), resolvedAt: null,
    });
    // Log once per UTC day — OR whenever the KIND changes, however recently we
    // logged. A booking moving from `stuck_saga_marker` to
    // `expired_booking_saga_marker` (or a staged saga aging into
    // `stale_accept_saga`) is the condition genuinely changing shape, which is
    // exactly the transition an operator reading logs needs to see; throttling
    // it away would leave the last line they saw describing the wrong problem.
    return existing.kind !== a.kind
      || Math.floor(existing.lastSeenAt / ALERT_LOG_THROTTLE_MS) !== Math.floor(a.now / ALERT_LOG_THROTTLE_MS);
  } catch (e) {
    // The escalation itself failed. Log UNTHROTTLED — losing the durable row
    // is exactly when the noisy log is worth having.
    console.error(`recordAdminAlert: failed to record admin alert ${a.alertId}`, e);
    return true;
  }
}


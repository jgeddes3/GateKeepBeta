import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  computeDepositCents, computeEarningsCents, computeExpectedTotalCents, computeFeeShareCents,
  computeSettlementBaseCents, resolveFeePolicy, isValidDocId,
  DEFAULT_FEE_POLICY, SETTLEMENT_RETRY_OFFSETS_MS,
} from "@gatekeep/shared";
import type {
  AdminAlertDoc, AdminAlertKind, BookingRequestDoc, BudgetStructure, DepositStatus, FeePolicy,
  GigDoc, LedgerEntry, PaymentDoc, PaymentSummary, StripeProfileDoc,
} from "@gatekeep/shared";
import { getStripe, StripeCardDeclinedError, StripePaymentPendingError } from "./stripeClient.js";
import { notifyProfileMembers } from "./notifications.js";
import { paymentIntentSucceededHandlers } from "./paymentsWebhook.js";

// profiles/{profileId}/private/stripe — the payment-identity doc. Shared
// helper so every SP5 callable/handler that needs the cached Stripe identity
// (payments.ts's callables + the account.updated webhook handler) reads it
// the same way, rather than each re-deriving the doc path.
export async function getStripeProfileDoc(profileId: string): Promise<StripeProfileDoc | null> {
  const snap = await getFirestore().doc(`profiles/${profileId}/private/stripe`).get();
  return (snap.data() as StripeProfileDoc | undefined) ?? null;
}

// Task 5 booking gates. Distinct messages — the web UI keys its two inline
// prompts off them.
export const CURATOR_CARD_REQUIRED_MESSAGE = "Save a payment card before sending offers or booking musicians.";
export const CURATOR_DELINQUENT_MESSAGE = "This profile has an overdue payment — settle it before booking again.";
export const MUSICIAN_PAYOUTS_REQUIRED_MESSAGE = "Finish payout setup before applying to or accepting bookings.";
// Task 5 review #1: the two curator-gate messages above are second-person,
// curator-authored copy ("Save a payment card...") — actionable only by
// someone on the curator side. acceptBooking can be called by EITHER side
// (either direction lands the deposit charge on the curator's card), so a
// musician-side caller who trips the curator gate must never see them; both
// curator-gate failure kinds collapse to this one neutral message for a
// musician-side caller instead. A curator-side caller keeps the specific
// message either way — it names exactly what they need to fix.
export const BOOKING_NOT_CONFIRMABLE_MESSAGE =
  "This booking can't be confirmed right now — the other side needs to update its payment details.";

// Task 6 accept-saga outcomes the CALLER sees. Both are caller-facing copy
// (the web accept button renders them inline), so they live beside the gate
// messages above rather than inside bookings.ts.
//
// DECLINED: definite failure — the staged payment docs are deleted and the
// booking is left `open`, so a retry (after fixing the card) is a clean,
// fresh attempt.
export const CARD_DECLINED_MESSAGE = "Your card was declined — update your payment method and try again.";
// PROCESSING: NOT a failure — the PaymentIntent exists and is still settling.
// The staged docs and depositChargePending stay in place and the
// payment_intent.succeeded webhook completes the accept out-of-band; a retry
// is deliberately refused while that's outstanding (a second charge would be
// a real double charge, since the pending intent can still succeed).
export const DEPOSIT_PROCESSING_MESSAGE =
  "Your payment is processing — the booking will confirm automatically once it completes.";
// The narrow crash window: depositChargePending is set but no intent id was
// ever recorded (the instance died between staging and the charge, or
// between the charge and recording its outcome). Whether money moved is
// UNKNOWN here, so accept refuses rather than re-staging + re-charging on a
// fresh attempt key; Task 9's sweep reconciles using the persisted attempt
// counter (same key ⇒ Stripe replays the original intent, never a second
// charge).
export const DEPOSIT_RECONCILING_MESSAGE =
  "This booking's payment is still being processed — try again in a few minutes.";
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
// The charge landed but the accept could not be committed (the gig/series
// moved underneath it), and the refund SUCCEEDED. Told to the caller in place
// of the raw abort reason so they aren't left wondering whether they were
// charged for a booking that never happened. Only ever used when the refund
// is confirmed — a failed refund must not claim the money came back.
export const ACCEPT_ABORTED_REFUNDED_MESSAGE =
  "The booking could not be confirmed — your deposit charge has been refunded.";

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
// intentionally-separate rows silently collapses them into one. No call site
// through Task 8 needs that: every one keys off an id that is already unique
// per intended row (the PaymentIntent for `deposit_charged`, and — since
// Stripe mints a fresh object per call — the refund id for `refund` and the
// transfer id for `forfeit_transfer`, which is what makes the whole-run case
// safe, where several occurrences refund off ONE shared intent but each gets
// its own refund object). A future caller that would reuse a (kind, stripeId)
// pair across two intended rows must not pass stripeId bare.
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
// `skipRecompute` suppresses the trailing paymentSummary recompute for a
// caller that is resolving SEVERAL docs of the SAME booking in a loop and will
// run one recompute itself afterwards. The recompute reads the whole payments
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
    if (p.deposit.intentId) {
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
      // Never charged (a doc still `unpaid` when the cancellation landed —
      // e.g. a webhook-recovery accept whose intent never succeeded, or a
      // birth deposit the sweep hadn't charged yet). There is no money to
      // send back, so this resolves straight to the terminal state; no
      // Stripe call, and no ledger row for money that never moved.
      await ref.update({ "deposit.status": "refunded", "deposit.resolvedAt": now, updatedAt: now });
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
  if (!opts.skipRecompute) {
    await recomputePaymentSummary(bookingId)
      .catch((e) => console.error(`resolveDepositPending: summary recompute failed for ${bookingId}`, e));
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
// Clearing is deliberately NOT here: Task 11 owns `clearDelinquencyIfSettled`
// (a profile stops being delinquent only once EVERY outstanding obligation is
// settled, which is a query this function has no business running).
export async function declareCuratorDelinquent(profileId: string, now: number): Promise<boolean> {
  const ref = getFirestore().doc(`profiles/${profileId}/private/stripe`);
  const existing = (await ref.get()).data() as StripeProfileDoc | undefined;
  if (existing?.delinquent === true) return false;
  await ref.set({ delinquent: true, delinquentSince: now, updatedAt: now }, { merge: true });
  return true;
}

// A `{ lastUpdateTime: ... }` precondition that lost its race. The Admin SDK
// surfaces the underlying gRPC status as a numeric code (9 =
// FAILED_PRECONDITION); the string forms are a defensive fallback, not the
// expected shape. Mirrors isAlreadyExists above.
//
// Lives here (rather than in paymentsSweep.ts, where Task 9 first wrote it)
// because Task 10's settlement writes use the identical optimistic-CAS idiom
// and paymentsSweep imports paymentsCore, never the other way round.
export function isFailedPrecondition(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 9 || code === "failed-precondition" || code === "FAILED_PRECONDITION";
}

const ALERT_LOG_THROTTLE_MS = 24 * 60 * 60 * 1000;

// The durable "a human has to look at this" queue (adminAlerts/{alertId}).
// Every SP5 path that deliberately REFUSES to move money — because moving it
// would risk moving it twice — upserts a row here keyed on the underlying
// PROBLEM (not the run), and throttles its console.error to once per UTC day.
// The row is the signal; the log is a convenience.
//
// Moved here from paymentsSweep.ts in Task 10: chargeSettlement escalates the
// same way the sweep does (a settlement whose terminal write lost a race to a
// no-show waive), and the import direction only permits sharing in this
// direction.
//
// Returns whether the caller should log this observation.
export async function recordAdminAlert(a: {
  alertId: string; kind: AdminAlertKind; detail: string;
  bookingId: string; gigId: string | null; now: number;
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

// ---------- Task 10: settlement (true-ups, T+3 charge, earnings transfer) ----------

// What a settlement charge attempt did, from the sweep's point of view.
// "skipped" covers every "nothing to do / not chargeable yet" outcome so the
// sweep's counters stay honest about what actually moved.
export type SettlementChargeOutcome =
  | "skipped" | "charged" | "declined" | "pending" | "waived";

// `outcome` alone can't answer "did the musician get paid this run?" —
// "charged" covers a settlement whose earnings happened to be zero, and a
// raced finalize can move money without ever reaching a terminal write. The
// sweep counts `transfersMade` off THIS flag, so the counter only ever
// reports transfers that genuinely fired.
export interface SettlementRunResult {
  outcome: SettlementChargeOutcome;
  transferred: boolean;
}

function ran(outcome: SettlementChargeOutcome, transferred = false): SettlementRunResult {
  return { outcome, transferred };
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

// Everything one occurrence's settlement owes, derived ENTIRELY from
// server-held state: the booking's FROZEN accepted terms, the occurrence's own
// gig duration, the curator-reported true-up on the payment doc, and the
// booking's fee-policy snapshot. No client input reaches this (spec §4) — the
// true-up callable writes only validated integer extras, and everything else
// comes off documents only the server writes.
interface SettlementMath {
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
async function waiveUnlinkedSettlement(
  bookingId: string, gigId: string, p: PaymentDoc,
  baseline: FirebaseFirestore.Timestamp, now: number,
): Promise<SettlementRunResult> {
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
    return ran("skipped");
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
export async function recordSettlementFailure(
  bookingId: string, gigId: string, p: PaymentDoc, booking: BookingRequestDoc,
  baseline: FirebaseFirestore.Timestamp, now: number,
): Promise<SettlementRunResult> {
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
    return ran("skipped");
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
// `baseline` is the CAS baseline the caller wants the terminal write held to.
// The synchronous path passes the updateTime it read BEFORE its Stripe call,
// so the precondition spans the whole non-transactional charge window; a
// webhook caller has no such read and lets this function use its own.
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
    return ran("skipped");
  }
  // Idempotence: a redelivered webhook, or a sweep run racing the webhook that
  // finalized the same intent, must not transfer a second time.
  if (p.settlement.status === "paid") return ran("skipped");
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
    return ran("skipped");
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
    return ran("skipped");
  }

  const math = settlementMath(p, booking, gig);
  const musicianStripe = await getStripeProfileDoc(p.musicianProfileId);
  if (math.earnings > 0 && !musicianStripe?.accountId) {
    // Unreachable in normal flow (accept is gated on a payout-ready musician).
    // The doc is LEFT `pending`/`past_due` on purpose: the sweep re-runs it on
    // the SAME attempt-scoped key, so the charge replays rather than doubling,
    // and the musician's money is never dropped by flipping to a terminal
    // state with no transfer behind it.
    console.error(
      `finalizeSettlementSuccess: no Stripe account for ${p.musicianProfileId} — ${bookingId}/${gigId} left unsettled for the next run`);
    return ran("skipped");
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
      charge: intentId ? { intentId, amountCents: args.chargedCents ?? math.chargeTotal } : null,
      transfer: transfer ? { id: transfer.id, amountCents: math.earnings } : null,
      racedStatus: "waived/rewritten mid-transfer", now,
    });
    return ran("skipped", transfer != null);
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
  // FRESH reads: the sweep hands this function ids, not snapshots, and by the
  // time a doc's turn comes the page it arrived in can be minutes old — and
  // this CHARGES A CARD off what it reads.
  const [pSnap, bookingSnap, gigSnap] = await Promise.all([
    ref.get(), db.doc(`bookings/${bookingId}`).get(), db.doc(`gigs/${gigId}`).get(),
  ]);
  const p = pSnap.data() as PaymentDoc | undefined;
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  const gig = gigSnap.data() as GigDoc | undefined;
  if (!p || !booking?.acceptedTerms) return ran("skipped");
  // THE CAS. Anything else — already `paid` (a racer, or the webhook, got
  // here first), `waived`, or `not_due` (its date hasn't been resolved yet) —
  // is deliberately untouched.
  if (p.settlement.status !== "pending" && p.settlement.status !== "past_due") return ran("skipped");

  // THE OUTSTANDING-INTENT TERMINATOR. A `pending` settlement that already
  // carries an intent id is one whose charge came back `processing` and never
  // resolved. It must NEVER be charged again: that intent can still succeed,
  // so a fresh-key retry (which is exactly what this becomes once Stripe's
  // 24h idempotency window closes — see IDEMPOTENCY_WINDOW_MS) is a real
  // SECOND charge on the curator's card. The only ways out are the
  // payment_intent.succeeded webhook finalizing it, or an operator cancelling
  // /refunding the intent in Stripe; either way this loop just waits.
  //
  // Scoped to `pending` deliberately, so `past_due` dunning retries keep
  // working: a declined settlement never carries an intent id (the decline
  // path in recordSettlementFailure writes status/attempts/nextRetryAt and
  // explicitly leaves `settlement.intentId` alone, and the only writers of
  // that field are this pending branch and the terminal `paid` write).
  //
  // TODO(Task 11): `payPastDue` will persist an intent id on a `past_due`
  // doc, which this guard deliberately does not cover — it must clear
  // `nextRetryAt` (or extend this guard) so the sweep's step 6 cannot charge
  // alongside a live on-session intent.
  if (p.settlement.status === "pending" && p.settlement.intentId != null) {
    const alertId = settlementPendingAlertId(bookingId, gigId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "settlement_pending_stuck",
      detail: `settlement charge left processing on intent ${p.settlement.intentId} — never re-charged; finalize it via the webhook or resolve the intent in Stripe`,
      bookingId, gigId, now,
    });
    if (shouldLog) {
      console.error(
        `chargeSettlement: ${bookingId}/${gigId} is pending but holds intent ${p.settlement.intentId} — not re-charged; needs admin attention (see adminAlerts/${alertId})`);
    }
    return ran("pending");
  }

  if (!gig) {
    // The gig doc is gone outright (deleteProfile's cascade). Its duration is
    // what prices this date, so there is nothing to charge — and deliberately
    // no automatic waive either: forgiving a real, already-scheduled debt is
    // an operator's call, not this function's. The sweep's step 4 already
    // waives a vanished gig BEFORE scheduling, so reaching here means the doc
    // disappeared afterwards, which is an anomaly worth a log every run.
    console.error(`chargeSettlement: ${bookingId}/${gigId} — the gig doc is gone; cannot price the settlement, left for an operator`);
    return ran("skipped");
  }
  // Defense in depth (spec §4): a date that no longer belongs to this booking
  // settles waived. Note this reads the GIG's linkage, never booking.status.
  if (gig.bookingId !== bookingId || gig.status !== "filled") {
    // The read's own updateTime is a sufficient CAS baseline here: no Stripe
    // call precedes this write.
    if (!pSnap.updateTime) return ran("skipped");
    return await waiveUnlinkedSettlement(bookingId, gigId, p, pSnap.updateTime, now);
  }

  // PERSIST BEFORE THE CHARGE (the same idiom the sweep's birth deposit uses
  // for `depositAttempts`). Two things this write buys, both about the
  // non-transactional gap the Stripe call opens:
  //   1. it CLOSES THE TRUE-UP WINDOW before the amount is computed —
  //      confirmOccurrenceActuals refuses while `chargingSince` is live, so a
  //      curator cannot add extra minutes to a charge that is already in
  //      flight and have the settlement then record an amount that was never
  //      charged;
  //   2. its write time is the CAS baseline for the terminal write, so the
  //      precondition spans the charge itself. Taking the baseline from the
  //      WRITE (rather than the read) also means the window between reading
  //      and claiming the doc is covered by the write's own precondition.
  let baseline: FirebaseFirestore.Timestamp;
  try {
    const wr = await ref.update(
      { "settlement.chargingSince": now, updatedAt: now },
      { lastUpdateTime: pSnap.updateTime! });
    baseline = wr.writeTime;
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    // A racer moved the doc between the read and the claim. Nothing has been
    // charged, so there is nothing to account for — the next run re-reads.
    console.warn(`chargeSettlement: ${bookingId}/${gigId} changed before its charge could be claimed — left for the next run`);
    return ran("skipped");
  }

  const math = settlementMath(p, booking, gig);
  let intentId = p.settlement.intentId;
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
      return ran("skipped");
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
        return ran("pending");
      }
      if (e instanceof StripeCardDeclinedError) {
        return await recordSettlementFailure(bookingId, gigId, p, booking, baseline, now);
      }
      throw e;
    }
  }
  // else: a ZERO-charge settlement — the deposit slice covered the whole date
  // exactly. Nothing to charge, but the musician is still owed their earnings,
  // so this falls through to the same tail as a charged one.

  return await finalizeSettlementSuccess({
    bookingId, gigId, intentId, chargeId, chargedCents, now, baseline,
  });
}

// Registered HERE rather than in paymentsWebhook.ts for the same reason
// payments.ts registers `account.updated` there: paymentsCore already imports
// the registry, and index.ts importing this module (transitively, via
// payments.ts and paymentsSweep.ts) is what guarantees the registration has
// run before the webhook can ever fire.
//
// This is the recovery half of as-built contract #7: chargeSettlement left an
// intent `processing`, persisted its id, and returned "pending". When Stripe
// confirms it, the settlement finishes exactly as the synchronous path would
// have — transfer, terminal write, ledger, aggregate, notification.
paymentIntentSucceededHandlers["settlement"] = async (object) => {
  const intentId = object.id as string | undefined;
  const meta = object.metadata as Record<string, string> | undefined;
  const bookingId = meta?.bookingId;
  const gigId = meta?.gigId;
  // Event payloads are signature-verified but never shape-validated, so
  // metadata is untrusted input — validate before building a doc path from it
  // (mirrors the `deposit` handler's identical guard in bookings.ts).
  if (!intentId || !bookingId || !gigId || !isValidDocId(bookingId) || !isValidDocId(gigId)) {
    console.warn(
      `payment_intent.succeeded (settlement): unusable metadata — intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}, gigId=${JSON.stringify(gigId ?? null)}`);
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
      `payment_intent.succeeded (settlement): ${bookingId}/${gigId} is awaiting intent ${p.settlement.intentId} but ${intentId} succeeded — unconsumed charge, needs reconciliation`);
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
  await finalizeSettlementSuccess({
    bookingId, gigId, intentId, chargeId: latestCharge, chargedCents: received, now: Date.now(),
  });
};

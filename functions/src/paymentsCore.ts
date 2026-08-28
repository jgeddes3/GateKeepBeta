import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  computeDepositCents, computeExpectedTotalCents, computeFeeShareCents, DEFAULT_FEE_POLICY,
} from "@gatekeep/shared";
import type {
  BookingRequestDoc, BudgetStructure, DepositStatus, FeePolicy, LedgerEntry, PaymentDoc,
  PaymentSummary, StripeProfileDoc,
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
export async function resolveDepositPending(bookingId: string, gigId: string): Promise<void> {
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
      await recomputePaymentSummary(bookingId)
        .catch((e) => console.error(`resolveDepositPending: summary recompute failed for ${bookingId}`, e));
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
  await recomputePaymentSummary(bookingId)
    .catch((e) => console.error(`resolveDepositPending: summary recompute failed for ${bookingId}`, e));
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

// What a settlement charge attempt did, from the sweep's point of view.
// "skipped" covers every "nothing to do / not chargeable yet" outcome so the
// sweep's counters stay honest about what actually moved.
export type SettlementChargeOutcome = "skipped" | "charged" | "declined";

// STUB — Task 10 implements the body (true-ups, the T+3 charge, the earnings
// transfer, the past_due/attempts/delinquency bookkeeping). It exists NOW,
// with this signature, because Task 9 lands the two sweep loops that call it
// (due settlements + past_due retries): landing the loops against a no-op
// keeps the sweep's step structure, pagination, error isolation and counters
// under test from the start, so Task 10 only has to fill in this function
// rather than also inventing where it gets called from.
//
// Contract for Task 10: must be safe to call zero, one or many times for the
// same (bookingId, gigId) — the sweep re-runs whatever is still due — and must
// own its own attempts/nextRetryAt/delinquency writes (the sweep never touches
// settlement dunning fields itself).
export async function chargeSettlement(
  params: { bookingId: string; gigId: string; now: number },
): Promise<SettlementChargeOutcome> {
  void params;
  return "skipped";
}

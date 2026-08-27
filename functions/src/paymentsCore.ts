import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { DepositStatus, LedgerEntry, PaymentDoc, PaymentSummary, StripeProfileDoc } from "@gatekeep/shared";

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
// intentionally-separate rows silently collapses them into one. None of this
// task's call sites need that; a future one that does must not reuse
// stripeId bare. An empty string is treated the same as null (falls back to
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
      console.error(`writeLedger: duplicate suppressed for ${full.kind}:${full.stripeId}`, e);
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

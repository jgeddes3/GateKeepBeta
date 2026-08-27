import { getFirestore } from "firebase-admin/firestore";
import type { DepositStatus, LedgerEntry, PaymentDoc, PaymentSummary } from "@gatekeep/shared";

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
export async function writeLedger(entry: Omit<LedgerEntry, "at"> & { at?: number }): Promise<void> {
  const db = getFirestore();
  const full: LedgerEntry = { ...entry, at: entry.at ?? Date.now() };
  if (full.stripeId != null) {
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

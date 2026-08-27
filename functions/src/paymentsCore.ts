import { getFirestore } from "firebase-admin/firestore";
import type { LedgerEntry, PaymentDoc, PaymentSummary } from "@gatekeep/shared";

// Append-only audit row for every money event. Best-effort at call sites that
// run post-commit (a failed ledger write must never fail a committed money
// move — callers wrap in try/catch); the sweep's reconciliation re-derives
// nothing from the ledger, so a lost row is an audit gap, not a money bug.
export async function writeLedger(entry: Omit<LedgerEntry, "at"> & { at?: number }): Promise<void> {
  const db = getFirestore();
  const full: LedgerEntry = { ...entry, at: entry.at ?? Date.now() } as LedgerEntry;
  await db.collection("ledger").add(full);
}

// Recomputes bookings/{id}.paymentSummary from the payments subcollection.
// Self-healing aggregate (recompute-from-truth, like recomputeReliability) —
// call after any payment-doc transition. `state` is the max-severity of any
// occurrence: delinquent > past_due > current. Delinquency is decided
// explicitly by the sweep (Task 10) via settlement.delinquentAt — NEVER
// inferred from lateFeeCents, which is money (can legitimately be a
// zero-cents late fee under a 0-pct policy snapshot), not a flag; here
// past_due alone is derived from settlement statuses.
export async function recomputePaymentSummary(bookingId: string): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection(`bookings/${bookingId}/payments`).get();
  let heldCents = 0, paidCents = 0, transferredCents = 0;
  let anyPastDue = false, anyDelinquent = false;
  for (const doc of snap.docs) {
    const p = doc.data() as PaymentDoc;
    if (p.deposit.status === "held" || p.deposit.status === "applied") heldCents += p.deposit.sliceCents;
    if (p.deposit.status === "held" || p.deposit.status === "applied") paidCents += p.deposit.sliceCents + p.deposit.feeShareCents;
    if (p.settlement.status === "paid") paidCents += (p.settlement.computedCents ?? 0) + (p.settlement.feeShareCents ?? 0) + (p.settlement.lateFeeCents ?? 0);
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
  await db.doc(`bookings/${bookingId}`).update({ paymentSummary: summary, updatedAt: Date.now() });
}

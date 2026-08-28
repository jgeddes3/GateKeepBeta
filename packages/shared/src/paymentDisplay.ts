import { SETTLEMENT_RETRY_OFFSETS_MS, type PaymentDoc } from "./types.js";

// SP5 payments — the ONE classifier that turns a PaymentDoc into the state a
// client renders. Pure (no Date.now(), no I/O), so it lives here rather than
// in either client.
//
// WHY IT IS SHARED. Web's PaymentsPanel and mobile's PaymentStatus render the
// same nine states with the same terminal-first precedence, and a divergence
// between them is not cosmetic: it means the same date reads as "Paid" on one
// device and "Past due" on the other, or a curator's only outstanding debt
// goes unnamed on the platform they happen to be holding. Both surfaces
// previously carried their own copy of this ladder, kept in step by comment
// alone. The LABELS stay per-platform (web has actions and inline forms in the
// same rows; mobile is read-only and says "pay on the web") — only the
// classification is shared, because that is the part that must never drift.

// The first `deposit.depositAttempts` value that means "this birth deposit's
// retry schedule is over". SETTLEMENT_RETRY_OFFSETS_MS is the schedule (+1d,
// +2d, +2d — three retries after the initial attempt), so the count runs 1..3
// while retries remain and hits this on the failure that exhausts it.
//
// Defined here, at the same level as the schedule it is derived from, and
// re-exported by functions/src/paymentsCore.ts so every server-side import
// keeps working unchanged (the same treatment messages.ts gave the SP5 copy
// constants). Server callers need it as a CONSTANT, not just a predicate —
// clearDelinquencyIfSettled asks Firestore the question as a range filter.
export const DEPOSIT_EXHAUSTED_ATTEMPTS = SETTLEMENT_RETRY_OFFSETS_MS.length + 1;

export type PaymentRowKind =
  | "forfeited" | "paid" | "refunded" | "waived"
  | "settlementPastDue" | "depositPastDue" | "settlementPending"
  | "depositHeld" | "depositUnpaid";

// Precedence is terminal-first, and the ORDER is load-bearing: a row can only
// ever be in one of these states in steady state, but during the brief windows
// where more than one condition is technically true (a `*_pending` transient
// alongside a settlement that has not moved yet) the first match is the one
// that describes what is actually happening to the money.
//
// Takes the two state blocks rather than a whole PaymentDoc so both clients'
// row types (PaymentDoc & { id }) satisfy it without a cast.
export function paymentRowKind(row: Pick<PaymentDoc, "deposit" | "settlement">): PaymentRowKind {
  if (row.deposit.status === "forfeited" || row.deposit.status === "forfeit_pending") return "forfeited";
  if (row.settlement.status === "paid") return "paid";
  if (row.deposit.status === "refunded" || row.deposit.status === "refund_pending") return "refunded";
  if (row.settlement.status === "waived") return "waived";
  if (row.settlement.status === "past_due") return "settlementPastDue";
  // An exhausted BIRTH deposit — payPastDue's OTHER debt shape: no settlement
  // is past_due yet, but the deposit's own retry schedule ran out and the
  // curator is (or is about to be) delinquent over it. Without a state of its
  // own, a curator whose ONLY debt is a deposit would see nothing anywhere
  // explaining why they are gated out of booking.
  if (row.deposit.status === "unpaid" && (row.deposit.depositAttempts ?? 0) >= DEPOSIT_EXHAUSTED_ATTEMPTS
    && (row.settlement.status === "not_due" || row.settlement.status === "pending")) {
    return "depositPastDue";
  }
  if (row.settlement.status === "pending") return "settlementPending";
  if (row.deposit.status === "held" || row.deposit.status === "applied") return "depositHeld";
  return "depositUnpaid";
}

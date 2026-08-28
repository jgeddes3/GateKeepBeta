import { SETTLEMENT_RETRY_OFFSETS_MS, type DepositStatus, type PaymentDoc } from "./types.js";

// SP5 payments — the shared payment-DISPLAY vocabulary: how a PaymentDoc is
// classified into the state a client renders, and which deposit statuses
// count toward the money totals a client shows. Everything here is pure (no
// Date.now(), no I/O), which is why it can live in shared at all.
//
// WHY IT IS SHARED. Web's PaymentsPanel and mobile's PaymentStatus render the
// same nine states with the same terminal-first precedence, off the same
// totals arithmetic. A divergence between them is not cosmetic: it means the
// same date reads as "Paid" on one device and "Past due" on the other, a
// curator's only outstanding debt goes unnamed on the platform they happen to
// be holding, or the two surfaces quote different "total paid so far" figures
// for one booking. Each surface previously carried its own copy of both the
// ladder and the membership set, kept in step by comment alone.
//
// What stays per-platform: the LABELS. Web's copy is action-bearing ("Past
// due — pay now" sits beside the button that does it); mobile is read-only
// and says where the button lives instead. That difference is deliberate, so
// the strings are NOT shared — only the classification and the accounting,
// which are the parts that must never drift.

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

// Every deposit status meaning "the curator's card was charged for this and
// the money has not come back to them" — the `paidCents` membership test.
// Held/applied are escrow, then escrow released into a settlement;
// forfeit_pending/forfeited still count because the curator paid either way
// and only the DESTINATION changed; refund_pending counts because the refund
// has not completed yet. `unpaid` and `refunded` are the two that do not.
//
// The AUTHORITATIVE definition of this table is the per-status contribution
// list on functions/src/paymentsCore.ts's recomputePaymentSummary — the
// server aggregate every client total must agree with. This set was
// previously written out three times (that function, web's PaymentsPanel,
// mobile's PaymentStatus) and kept in step by comment; it now has one
// definition, which paymentsCore re-exports so its own call site is
// unchanged (Task 16 review round 1).
//
// Typed ReadonlySet so a consumer cannot .add()/.delete() its way into a
// different accounting rule for everyone else on a warm module instance —
// the same concern DEFAULT_FEE_POLICY's Object.freeze addresses, expressed
// the way a Set allows (Object.freeze does not close a Set's mutators).
export const PAID_DEPOSIT_STATUSES: ReadonlySet<DepositStatus> = new Set<DepositStatus>([
  "held", "applied", "forfeit_pending", "forfeited", "refund_pending",
]);

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

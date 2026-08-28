// Shared response shapes for SP5 payments callables — kept out of any one
// component's file (review round 1, Q4) so a later consumer (Task 15's
// PaymentsPanel/delinquency banner, both of which also call getStripeStatus)
// imports the SAME type instead of a second hand-rolled copy.

export interface StripeStatusResult {
  hasCard: boolean; cardBrand: string | null; cardLast4: string | null;
  hasAccount: boolean; transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  delinquent: boolean;
  // As-built correction (Task 13): 0 means "asked, nothing there"; null means
  // "Stripe couldn't be read just now" — MUST render as "balance unavailable",
  // never $0.00.
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
}

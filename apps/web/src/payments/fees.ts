import {
  CURATOR_FEE_PCT, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS,
  computeFeeShareCents, computeInstantFeeCents, computeDepositCents,
} from "@gatekeep/shared";

// Client-side copy/preview helpers — pure math mirroring the server's own
// (money.ts / validation.ts), used ONLY to preview a number before the user
// commits to an action. The server independently recomputes every cent from
// its own frozen state (invariant #1: no client-supplied amounts) — these
// previews can never be the source of truth for what actually gets charged.

// Task 15's accept-preview: "Due now: {total} ({slice} deposit + {fee}
// service fee)".
export function depositChargePreviewCents(expectedTotalCents: number): { sliceCents: number; feeCents: number; totalCents: number } {
  const sliceCents = computeDepositCents(expectedTotalCents);
  const feeCents = computeFeeShareCents(sliceCents, CURATOR_FEE_PCT);
  return { sliceCents, feeCents, totalCents: sliceCents + feeCents };
}

// The Earnings page's instant cash-out fee preview — same constants
// requestPayout prices the ACTUAL fee from (live product price of the
// convenience, not a booking-scoped snapshot — see paymentsPayouts.ts).
export function instantFeePreviewCents(amountCents: number): number {
  return computeInstantFeeCents(amountCents, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS);
}

import {
  CURATOR_FEE_PCT, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS,
  computeFeeShareCents, computeInstantFeeCents, computeDepositCents,
  computeSettlementBaseCents, computeEarningsCents,
  type BudgetStructure, type FeePolicy,
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

// Task 15's TrueUpForm preview: "if you save this report, the musician gets
// an extra $X (you're charged an extra $Y)". Delta-based (the NEW settlement
// base minus the OLD one, both computed the exact same way
// confirmOccurrenceActuals/chargeSettlement do server-side) rather than a
// full recompute of the whole settlement, so the preview stays correct
// whether or not the curator has reported actuals before. Never
// authoritative (see this file's header) — confirmOccurrenceActuals writes
// only the extras, and the real charge is computed fresh at settlement time
// from the booking's frozen terms. Returns null rather than throwing on a
// malformed/out-of-range input (e.g. an occurrence whose durationMinutes
// hasn't loaded yet) — a preview that can't be computed just doesn't render,
// it never crashes the form.
export function trueUpDeltaPreviewCents(
  structure: BudgetStructure, amountCents: number, feePolicy: FeePolicy,
  durationMinutes: number, songCount: number | null,
  from: { extraMinutes: number; extraSongs: number }, to: { extraMinutes: number; extraSongs: number },
): { deltaBaseCents: number; musicianDeltaCents: number; curatorFeeDeltaCents: number } | null {
  try {
    const before = computeSettlementBaseCents(structure, amountCents,
      { durationMinutes, extraMinutes: from.extraMinutes, songCount, extraSongs: from.extraSongs });
    const after = computeSettlementBaseCents(structure, amountCents,
      { durationMinutes, extraMinutes: to.extraMinutes, songCount, extraSongs: to.extraSongs });
    const deltaBaseCents = Math.max(0, after - before);
    return {
      deltaBaseCents,
      musicianDeltaCents: computeEarningsCents(deltaBaseCents, feePolicy.musicianFeePct),
      curatorFeeDeltaCents: computeFeeShareCents(deltaBaseCents, feePolicy.curatorFeePct),
    };
  } catch {
    return null;
  }
}

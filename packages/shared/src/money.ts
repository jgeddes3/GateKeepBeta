import type { BudgetStructure } from "./types.js";
import { computeExpectedTotalCents } from "./validation.js";

// All SP5 money math. Pure, integer-cents, no Date.now() (shared-code rule).
// Rounding law (spec §1): fees charged to the curator round UP, shares paid
// out round DOWN, remainders go to the platform.

const MAX_CENTS = 2 ** 45; // far above MAX_OFFER_AMOUNT_CENTS-derived totals; guards ceil/floor precision

function assertCents(v: number, label: string): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_CENTS) {
    throw new Error(`${label} must be an integer number of cents in [0, 2^45].`);
  }
}

// ceil(base * pct / 100) — the curator-side fee share carried by ONE charge.
export function computeFeeShareCents(baseCents: number, feePct: number): number {
  assertCents(baseCents, "baseCents");
  return Math.ceil(baseCents * feePct / 100);
}

// floor(base * (100 - pct) / 100) — the musician's earnings on a base amount.
export function computeEarningsCents(baseCents: number, musicianFeePct: number): number {
  assertCents(baseCents, "baseCents");
  return Math.floor(baseCents * (100 - musicianFeePct) / 100);
}

export function computeLateFeeSplit(
  outstandingCents: number, lateFeePct: number, lateFeeMusicianPct: number,
): { lateFeeCents: number; musicianCents: number; platformCents: number } {
  assertCents(outstandingCents, "outstandingCents");
  const lateFeeCents = Math.ceil(outstandingCents * lateFeePct / 100);
  const musicianCents = Math.floor(lateFeeCents * lateFeeMusicianPct / lateFeePct);
  return { lateFeeCents, musicianCents, platformCents: lateFeeCents - musicianCents };
}

export function computeInstantFeeCents(
  amountCents: number, instantFeePct: number, minCents: number,
): number {
  assertCents(amountCents, "amountCents");
  return Math.max(minCents, Math.ceil(amountCents * instantFeePct / 100));
}

// The occurrence's FINAL settlement base: frozen amountCents applied to the
// occurrence's own quantities plus increase-only true-ups. Negative/invalid
// true-ups clamp to 0 (defensive — the callable validates before writing).
export function computeSettlementBaseCents(
  structure: BudgetStructure,
  amountCents: number,
  opts: { durationMinutes: number; extraMinutes: number; songCount: number | null; extraSongs: number },
): number {
  assertCents(amountCents, "amountCents");
  const extraMinutes = Number.isInteger(opts.extraMinutes) && opts.extraMinutes > 0 ? opts.extraMinutes : 0;
  const extraSongs = Number.isInteger(opts.extraSongs) && opts.extraSongs > 0 ? opts.extraSongs : 0;
  return computeExpectedTotalCents(structure, amountCents, {
    durationMinutes: opts.durationMinutes + extraMinutes,
    songCount: (opts.songCount ?? 0) + extraSongs,
  });
}

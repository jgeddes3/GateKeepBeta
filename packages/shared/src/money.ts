import type { BudgetStructure, FeePolicy } from "./types.js";
import {
  CURATOR_FEE_PCT, MUSICIAN_FEE_PCT, INSTANT_FEE_PCT, LATE_FEE_PCT, LATE_FEE_MUSICIAN_PCT,
} from "./types.js";
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

// Percentages arrive off the same Firestore docs as the cents amounts but
// were previously ungated here — NaN/Infinity/negative/>100 would silently
// poison the ceil/floor math below instead of throwing at the boundary.
function assertPct(v: number, label: string): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
    throw new Error(`${label} must be an integer percent in [0, 100].`);
  }
}

// ceil(base * pct / 100) — the curator-side fee share carried by ONE charge.
export function computeFeeShareCents(baseCents: number, feePct: number): number {
  assertCents(baseCents, "baseCents");
  assertPct(feePct, "feePct");
  return Math.ceil(baseCents * feePct / 100);
}

// floor(base * (100 - pct) / 100) — the musician's earnings on a base amount.
export function computeEarningsCents(baseCents: number, musicianFeePct: number): number {
  assertCents(baseCents, "baseCents");
  assertPct(musicianFeePct, "musicianFeePct");
  return Math.floor(baseCents * (100 - musicianFeePct) / 100);
}

export function computeLateFeeSplit(
  outstandingCents: number, lateFeePct: number, lateFeeMusicianPct: number,
): { lateFeeCents: number; musicianCents: number; platformCents: number } {
  assertCents(outstandingCents, "outstandingCents");
  assertPct(lateFeePct, "lateFeePct");
  assertPct(lateFeeMusicianPct, "lateFeeMusicianPct");
  // lateFeePct === 0 would divide by zero below (NaN money, which Firestore
  // stores silently) — a zero-pct policy snapshot means "no late fee", full stop.
  if (lateFeePct === 0) return { lateFeeCents: 0, musicianCents: 0, platformCents: 0 };
  // The musician's share is percentage-POINTS of the late fee's own pct
  // (see LATE_FEE_MUSICIAN_PCT's comment in types.ts) — it can never exceed
  // the whole, or the platform share below would go negative.
  if (lateFeeMusicianPct > lateFeePct) {
    throw new Error("lateFeeMusicianPct cannot exceed lateFeePct.");
  }
  const lateFeeCents = Math.ceil(outstandingCents * lateFeePct / 100);
  const musicianCents = Math.floor(lateFeeCents * lateFeeMusicianPct / lateFeePct);
  return { lateFeeCents, musicianCents, platformCents: lateFeeCents - musicianCents };
}

export function computeInstantFeeCents(
  amountCents: number, instantFeePct: number, minCents: number,
): number {
  assertCents(amountCents, "amountCents");
  assertPct(instantFeePct, "instantFeePct");
  assertCents(minCents, "minCents");
  // This function is total-only: it returns the fee, full stop. The CALLER
  // (requestPayout) must refuse the payout when the computed fee would be
  // >= the amount being paid out — that's a business rule about the payout,
  // not a property of the fee arithmetic itself.
  return Math.max(minCents, Math.ceil(amountCents * instantFeePct / 100));
}

// The occurrence's FINAL settlement base: frozen amountCents applied to the
// occurrence's own quantities plus increase-only true-ups. Only the true-up
// EXTRAS clamp defensively to 0 when malformed (the callable validates
// before writing) — durationMinutes/songCount themselves must already be
// sane, so a NaN/negative/fractional duration or a missing perSong count is
// treated as a bug at the call site and throws rather than settling at $0.
export function computeSettlementBaseCents(
  structure: BudgetStructure,
  amountCents: number,
  opts: { durationMinutes: number; extraMinutes: number; songCount: number | null; extraSongs: number },
): number {
  assertCents(amountCents, "amountCents");
  if (!Number.isInteger(opts.durationMinutes) || opts.durationMinutes < 0) {
    throw new Error("durationMinutes must be a non-negative integer.");
  }
  if (structure === "perSong" && opts.songCount == null) {
    throw new Error("perSong settlement requires a songCount");
  }
  const extraMinutes = Number.isInteger(opts.extraMinutes) && opts.extraMinutes > 0 ? opts.extraMinutes : 0;
  const extraSongs = Number.isInteger(opts.extraSongs) && opts.extraSongs > 0 ? opts.extraSongs : 0;
  const result = computeExpectedTotalCents(structure, amountCents, {
    durationMinutes: opts.durationMinutes + extraMinutes,
    songCount: (opts.songCount ?? 0) + extraSongs,
  });
  // A corrupt base must throw HERE, before it's ever written onto a
  // PaymentDoc — not discovered later by whatever reads the doc.
  assertCents(result, "settlementBaseCents");
  return result;
}

// Snapshotted onto the booking at accept (types.ts's FeePolicy). Later tasks
// must read a booking's fee policy through resolveFeePolicy — never
// hand-roll `booking.feePolicy ?? { curatorFeePct: CURATOR_FEE_PCT, ... }`
// at each call site, which risks the fallback drifting from this one.
export const DEFAULT_FEE_POLICY: FeePolicy = {
  curatorFeePct: CURATOR_FEE_PCT,
  musicianFeePct: MUSICIAN_FEE_PCT,
  instantFeePct: INSTANT_FEE_PCT,
  lateFeePct: LATE_FEE_PCT,
  lateFeeMusicianPct: LATE_FEE_MUSICIAN_PCT,
};

export function resolveFeePolicy(feePolicy: FeePolicy | null | undefined): FeePolicy {
  return feePolicy ?? DEFAULT_FEE_POLICY;
}

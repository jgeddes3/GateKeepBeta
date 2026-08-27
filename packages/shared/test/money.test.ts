import { describe, it, expect } from "vitest";
import {
  computeFeeShareCents, computeEarningsCents, computeLateFeeSplit,
  computeInstantFeeCents, computeSettlementBaseCents, computeDepositCents,
  DEFAULT_FEE_POLICY, resolveFeePolicy,
} from "../src/index.js";

describe("computeFeeShareCents", () => {
  it("rounds up", () => {
    expect(computeFeeShareCents(35000, 11)).toBe(3850);
    expect(computeFeeShareCents(1, 11)).toBe(1);        // ceil(0.11)
    expect(computeFeeShareCents(0, 11)).toBe(0);
  });
  it("rejects overflow-scale inputs", () => {
    expect(() => computeFeeShareCents(Number.MAX_SAFE_INTEGER, 11)).toThrow();
    expect(() => computeFeeShareCents(-1, 11)).toThrow();
    expect(() => computeFeeShareCents(1.5, 11)).toThrow();
  });
  it("accepts exactly the MAX_CENTS boundary and rejects one cent over", () => {
    expect(() => computeFeeShareCents(2 ** 45, 11)).not.toThrow();
    expect(() => computeFeeShareCents(2 ** 45 + 1, 11)).toThrow();
  });
  it("rejects a malformed pct", () => {
    expect(() => computeFeeShareCents(1000, NaN)).toThrow();
  });
});

describe("computeEarningsCents", () => {
  it("floors the musician's 98%", () => {
    expect(computeEarningsCents(100000, 2)).toBe(98000);
    expect(computeEarningsCents(101, 2)).toBe(98);      // floor(98.98)
    expect(computeEarningsCents(1, 2)).toBe(0);
  });
  it("rejects a malformed pct", () => {
    expect(() => computeEarningsCents(1000, 150)).toThrow();
  });
  it("invariant: floor/ceil law sandwich holds across a deterministic sweep", () => {
    for (let i = 0; i < 1000; i++) {
      const base = (i * 9973 + 17) % 5_000_000;
      const earnings = computeEarningsCents(base, 2);
      const feeShare = computeFeeShareCents(base, 2);
      expect(earnings).toBeLessThanOrEqual(base);
      expect(earnings + feeShare).toBeGreaterThanOrEqual(base);
    }
  });
});

describe("computeLateFeeSplit", () => {
  it("splits 7/3 with floor to musician, remainder to platform", () => {
    const s = computeLateFeeSplit(72150, 10, 7);
    expect(s.lateFeeCents).toBe(7215);
    expect(s.musicianCents).toBe(5050);                 // floor(7215*0.7)=5050.5 -> 5050
    expect(s.platformCents).toBe(2165);
    expect(s.musicianCents + s.platformCents).toBe(s.lateFeeCents);
  });
  it("a 0% late fee policy yields all zeros, not NaN", () => {
    expect(computeLateFeeSplit(72150, 0, 0)).toEqual({ lateFeeCents: 0, musicianCents: 0, platformCents: 0 });
  });
  it("rejects a musician share larger than the whole late fee", () => {
    expect(() => computeLateFeeSplit(1000, 10, 12)).toThrow();
  });
  it("invariant: musician + platform always reconstitutes the late fee across a deterministic sweep", () => {
    for (let i = 0; i < 1000; i++) {
      const outstanding = (i * 7919 + 3) % 1_000_000;
      const s = computeLateFeeSplit(outstanding, 10, 7);
      expect(s.musicianCents + s.platformCents).toBe(s.lateFeeCents);
      expect(s.musicianCents).toBeGreaterThanOrEqual(0);
      expect(s.platformCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("computeInstantFeeCents", () => {
  it("4% with a $1 minimum", () => {
    expect(computeInstantFeeCents(134720, 4, 100)).toBe(5389); // ceil(5388.8)
    expect(computeInstantFeeCents(1000, 4, 100)).toBe(100);    // 40 -> min
  });
});

describe("computeSettlementBaseCents", () => {
  it("perHour uses the occurrence's own duration plus true-up minutes", () => {
    // 15000 c/hr * 120min/60 = 30000
    expect(computeSettlementBaseCents("perHour", 15000, { durationMinutes: 90, extraMinutes: 30, songCount: null, extraSongs: 0 })).toBe(30000);
    expect(computeSettlementBaseCents("perHour", 15000, { durationMinutes: 90, extraMinutes: 0, songCount: null, extraSongs: 0 })).toBe(22500);
  });
  it("perSong true-up adds songs", () => {
    expect(computeSettlementBaseCents("perSong", 500, { durationMinutes: 0, extraMinutes: 0, songCount: 20, extraSongs: 5 })).toBe(12500);
  });
  it("perSet is flat and ignores true-ups", () => {
    expect(computeSettlementBaseCents("perSet", 40000, { durationMinutes: 90, extraMinutes: 60, songCount: null, extraSongs: 9 })).toBe(40000);
  });
  it("never lower than the no-true-up expected value (increase-only)", () => {
    expect(computeSettlementBaseCents("perHour", 15000, { durationMinutes: 90, extraMinutes: -60, songCount: null, extraSongs: 0 })).toBe(22500);
  });
  it("rejects a NaN/negative/fractional durationMinutes", () => {
    expect(() => computeSettlementBaseCents("perHour", 15000, { durationMinutes: NaN, extraMinutes: 0, songCount: null, extraSongs: 0 })).toThrow();
    expect(() => computeSettlementBaseCents("perHour", 15000, { durationMinutes: -1, extraMinutes: 0, songCount: null, extraSongs: 0 })).toThrow();
    expect(() => computeSettlementBaseCents("perHour", 15000, { durationMinutes: 90.5, extraMinutes: 0, songCount: null, extraSongs: 0 })).toThrow();
  });
  it("rejects a null songCount for perSong", () => {
    expect(() => computeSettlementBaseCents("perSong", 500, { durationMinutes: 0, extraMinutes: 0, songCount: null, extraSongs: 0 })).toThrow();
  });
});

describe("deposit + fee worked example from the spec", () => {
  it("$1,000 gig: 388.50 at accept, 721.50 at settle, musician 980", () => {
    const base = 100_000;
    const slice = computeDepositCents(base);            // 35000
    expect(slice).toBe(35000);
    expect(slice + computeFeeShareCents(slice, 11)).toBe(38850);
    const settleBase = base - slice;                    // 65000
    expect(settleBase + computeFeeShareCents(settleBase, 11)).toBe(72150);
    expect(computeEarningsCents(base, 2)).toBe(98000);
  });
});

describe("resolveFeePolicy", () => {
  it("falls back to DEFAULT_FEE_POLICY when absent", () => {
    expect(resolveFeePolicy(undefined)).toBe(DEFAULT_FEE_POLICY);
    expect(resolveFeePolicy(null)).toBe(DEFAULT_FEE_POLICY);
  });
  it("returns the booking's own snapshot when present", () => {
    const snapshot = { curatorFeePct: 9, musicianFeePct: 3, instantFeePct: 5, lateFeePct: 8, lateFeeMusicianPct: 6 };
    expect(resolveFeePolicy(snapshot)).toBe(snapshot);
  });
});

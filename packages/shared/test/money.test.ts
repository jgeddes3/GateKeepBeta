import { describe, it, expect } from "vitest";
import {
  computeFeeShareCents, computeEarningsCents, computeLateFeeSplit,
  computeInstantFeeCents, computeSettlementBaseCents, computeDepositCents,
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
});

describe("computeEarningsCents", () => {
  it("floors the musician's 98%", () => {
    expect(computeEarningsCents(100000, 2)).toBe(98000);
    expect(computeEarningsCents(101, 2)).toBe(98);      // floor(98.98)
    expect(computeEarningsCents(1, 2)).toBe(0);
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
    expect(computeSettlementBaseCents("perHour", 15000, { durationMinutes: 90, extraMinutes: -60 as never, songCount: null, extraSongs: 0 })).toBe(22500);
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

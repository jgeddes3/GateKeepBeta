import { describe, it, expect } from "vitest";
import {
  depositChargePreviewCents, instantFeePreviewCents, trueUpDeltaPreviewCents,
  DEFAULT_FEE_POLICY,
} from "../src/index.js";

describe("depositChargePreviewCents", () => {
  // Spec worked example ($1,000 gig): deposit $350, curator fee share 11% of
  // the slice = $38.50, due-now total $388.50.
  it("matches the spec worked example", () => {
    expect(depositChargePreviewCents(100_000)).toEqual(
      { sliceCents: 35_000, feeCents: 3_850, totalCents: 38_850 });
  });
});

describe("instantFeePreviewCents", () => {
  it("4% with the $1 floor", () => {
    expect(instantFeePreviewCents(25_000)).toBe(1_000); // 4% of $250
    expect(instantFeePreviewCents(1_000)).toBe(100);    // 4% would be 40c -> $1 floor
  });
});

describe("trueUpDeltaPreviewCents", () => {
  it("perHour delta is the new base minus the old", () => {
    // $100/hr, 60-minute gig, no prior report -> +30 extra minutes.
    const d = trueUpDeltaPreviewCents("perHour", 10_000, DEFAULT_FEE_POLICY, 60, null,
      { extraMinutes: 0, extraSongs: 0 }, { extraMinutes: 30, extraSongs: 0 });
    expect(d).not.toBeNull();
    expect(d!.deltaBaseCents).toBe(5_000);
    expect(d!.musicianDeltaCents).toBe(4_900);  // 98%, floor
    expect(d!.curatorFeeDeltaCents).toBe(550);  // 11%, ceil
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(trueUpDeltaPreviewCents("perHour", -1, DEFAULT_FEE_POLICY, 60, null,
      { extraMinutes: 0, extraSongs: 0 }, { extraMinutes: 30, extraSongs: 0 })).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  genreTargetId, parseGenreTarget, deriveEventGenres, tierProjection, haversineMeters, distanceLabel,
  FOLLOW_LIMIT_MESSAGE, SHOW_POST_MAX_CHARS, DECK_PAGE_SIZE,
} from "../src/index.js";

describe("genre targets", () => {
  it("round-trips a known genre", () => {
    expect(genreTargetId("jazz")).toBe("genre:jazz");
    expect(parseGenreTarget("genre:jazz")).toBe("jazz");
  });
  it("rejects unknown genres and non-genre ids", () => {
    expect(parseGenreTarget("genre:polka")).toBeNull();
    expect(parseGenreTarget("abc123")).toBeNull();
  });
});

describe("deriveEventGenres", () => {
  it("unions lineup genres in first-seen order, capped at 5", () => {
    expect(deriveEventGenres([["rock", "indie"], ["indie", "jazz"], ["soul", "blues", "pop"]], null))
      .toEqual(["rock", "indie", "jazz", "soul", "blues"]);
  });
  it("prefers curator genres when set", () => {
    expect(deriveEventGenres([["rock"]], ["jazz"])).toEqual(["jazz"]);
  });
  it("is empty for an external-only lineup with no curator genres", () => {
    expect(deriveEventGenres([], undefined)).toEqual([]);
  });
});

describe("tierProjection", () => {
  it("finds the cheapest tier and a free flag", () => {
    expect(tierProjection([{ priceCents: 2500 }, { priceCents: 0 }])).toEqual({ priceFromCents: 0, hasFreeTier: true });
    expect(tierProjection([{ priceCents: 2500 }, { priceCents: 1200 }])).toEqual({ priceFromCents: 1200, hasFreeTier: false });
    expect(tierProjection([])).toEqual({ priceFromCents: null, hasFreeTier: false });
  });
});

describe("distance", () => {
  it("measures roughly 1.6 km per 0.01 degree of latitude", () => {
    const m = haversineMeters({ lat: 30.27, lng: -97.74 }, { lat: 30.28, lng: -97.74 });
    expect(m).toBeGreaterThan(1050); expect(m).toBeLessThan(1170);
  });
  it("labels distances", () => {
    expect(distanceLabel(50)).toBe("nearby");
    expect(distanceLabel(1931)).toBe("about 1.2 mi");
    expect(distanceLabel(19312)).toBe("about 12 mi");
  });
});

describe("constants", () => {
  it("exports the shared caps and strings", () => {
    expect(SHOW_POST_MAX_CHARS).toBe(280);
    expect(DECK_PAGE_SIZE).toBe(20);
    expect(FOLLOW_LIMIT_MESSAGE).toMatch(/maximum/);
  });
});

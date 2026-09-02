import { describe, it, expect } from "vitest";
import { rankDeck, interleaveByKind, scoreCandidate, mulberry32, type DeckCandidate } from "../src/discoverRank.js";

const now = 1_800_000_000_000;
const day = 24 * 3600 * 1000;
const c = (id: string, kind: DeckCandidate["kind"], over: Partial<DeckCandidate> = {}): DeckCandidate =>
  ({ id, kind, genres: [], startsAt: null, distanceMeters: null, followedBoost: false, ...over });

describe("scoreCandidate", () => {
  const ctx = { followedGenres: new Set(["jazz"]), now, hasLocation: true, rand: () => 0 };
  it("rewards genre overlap, follow boost, soonness, and distance", () => {
    expect(scoreCandidate(c("a", "artist", { genres: ["jazz"] }), ctx)).toBeCloseTo(3 + 0.5);
    expect(scoreCandidate(c("a", "artist", { genres: ["rock"] }), ctx)).toBeCloseTo(0.5);
    expect(scoreCandidate(c("s", "show", { startsAt: now + day, followedBoost: true, distanceMeters: 0 }), ctx))
      .toBeCloseTo(2 + 2 * (1 - 1 / 30) + 1.5);
    expect(scoreCandidate(c("s", "show", { startsAt: now + 29 * day, distanceMeters: 40_000 }), ctx)).toBeCloseTo(2 * (1 / 30));
  });
  it("ignores distance without a location", () => {
    expect(scoreCandidate(c("v", "venue", { distanceMeters: 0 }), { ...ctx, hasLocation: false })).toBeCloseTo(0.5);
  });
});

describe("rankDeck", () => {
  const pool = [
    c("show-soon", "show", { startsAt: now + day, genres: ["jazz"] }),
    c("show-late", "show", { startsAt: now + 25 * day }),
    c("artist-jazz", "artist", { genres: ["jazz"] }),
    c("artist-rock", "artist", { genres: ["rock"] }),
    c("venue-a", "venue"), c("venue-b", "venue"),
    c("show-followed", "show", { startsAt: now + 10 * day, followedBoost: true }),
  ];
  const ctx = { followedGenres: new Set(["jazz"]), now, hasLocation: false, seed: 7 };
  it("is deterministic for a seed and differs across seeds", () => {
    const a = rankDeck(pool, ctx, 20).map((x) => x.id);
    const b = rankDeck([...pool].reverse(), ctx, 20).map((x) => x.id);
    expect(a).toEqual(b);
    // Ruling: assert at least one of seeds 1..20 (excluding the seed under test, 7) differs
    // from seed 7, rather than a single other seed, to remove a small flake chance from
    // picking one seed that happens to collide.
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1).filter((s) => s !== 7);
    const differs = seeds.some((s) => !rankDeck(pool, { ...ctx, seed: s }, 20).map((x) => x.id).every((id, i) => id === a[i]));
    expect(differs).toBe(true);
  });
  it("puts a followed genre show ahead of an unmatched late show and respects the page size", () => {
    const ids = rankDeck(pool, ctx, 20).map((x) => x.id);
    expect(ids.indexOf("show-soon")).toBeLessThan(ids.indexOf("show-late"));
    expect(rankDeck(pool, ctx, 3)).toHaveLength(3);
  });
});

describe("interleaveByKind", () => {
  it("never runs more than two of a kind when an alternative exists", () => {
    const out = interleaveByKind([c("1", "show"), c("2", "show"), c("3", "show"), c("4", "artist"), c("5", "show"), c("6", "venue")]);
    for (let i = 2; i < out.length; i++) {
      expect(out[i].kind === out[i - 1].kind && out[i].kind === out[i - 2].kind).toBe(false);
    }
    expect(out).toHaveLength(6);
  });
  it("falls back to runs when only one kind remains", () => {
    expect(interleaveByKind([c("1", "show"), c("2", "show"), c("3", "show")]).map((x) => x.id)).toEqual(["1", "2", "3"]);
  });
  it("mulberry32 is stable", () => {
    const r = mulberry32(42); const first = r();
    expect(mulberry32(42)()).toBe(first);
  });
});

import { describe, it, expect } from "vitest";
import { scoreResult, compareRanked, type Ranked } from "../src/searchRank.js";
import { normalizeWords, buildTokens, type SearchIndexDoc } from "@gatekeep/shared";

function doc(overrides: Partial<SearchIndexDoc> = {}): SearchIndexDoc {
  const words = normalizeWords("Night Owls");
  return {
    kind: "show", sourceId: "a", handle: null, title: "Night Owls", subtitle: "", words, tokens: buildTokens(words),
    genres: ["rock"], city: null, cityLower: null, neighborhood: null, geo: null, startsAt: null, endsAt: null,
    priceFromCents: null, hasFreeTier: false, budgetMinCents: null, budgetMaxCents: null, actSize: null,
    hasAudio: false, busyDays: [], relatedProfileIds: ["cur1"], followerCount: 0, imagePath: null, updatedAt: 0, ...overrides,
  };
}
const HOUR = 60 * 60 * 1000;
const ctx = (over: Partial<Parameters<typeof scoreResult>[2]> = {}) => ({
  now: 1_000_000_000_000, hasLocation: false, followedProfiles: new Set<string>(), followedGenres: new Set<string>(), queryWords: [] as string[], ...over,
});

describe("scoreResult", () => {
  it("scores whole-word matches 3 and prefix matches 1", () => {
    expect(scoreResult(doc(), null, ctx({ queryWords: ["night", "ow"] }))).toBeCloseTo(4 + 0, 5);
  });
  it("adds soonness for shows and gigs, decaying over 30 days", () => {
    const now = 1_000_000_000_000;
    expect(scoreResult(doc({ startsAt: now + 1 }), null, ctx({ now }))).toBeCloseTo(2, 3);
    expect(scoreResult(doc({ startsAt: now + 360 * HOUR }), null, ctx({ now }))).toBeCloseTo(1, 3);
    expect(scoreResult(doc({ startsAt: now + 2000 * HOUR }), null, ctx({ now }))).toBeCloseTo(0, 3);
    expect(scoreResult(doc({ kind: "artist", startsAt: null }), null, ctx({ now }))).toBe(0);
  });
  it("adds distance only with a location, capped at 20 km", () => {
    expect(scoreResult(doc(), 0, ctx({ hasLocation: true }))).toBeCloseTo(1.5, 5);
    expect(scoreResult(doc(), 10_000, ctx({ hasLocation: true }))).toBeCloseTo(0.75, 5);
    expect(scoreResult(doc(), 50_000, ctx({ hasLocation: true }))).toBeCloseTo(0, 5);
    expect(scoreResult(doc(), 0, ctx({ hasLocation: false }))).toBe(0);
  });
  it("adds log followers for artists and venues, capped at 2", () => {
    expect(scoreResult(doc({ kind: "artist", followerCount: 9 }), null, ctx())).toBeCloseTo(1, 5);
    expect(scoreResult(doc({ kind: "venue", followerCount: 1_000_000 }), null, ctx())).toBeCloseTo(2, 5);
    expect(scoreResult(doc({ kind: "show", followerCount: 9 }), null, ctx())).toBe(0);
  });
  it("adds follow boosts and the audio boost", () => {
    expect(scoreResult(doc(), null, ctx({ followedProfiles: new Set(["cur1"]) }))).toBe(2);
    expect(scoreResult(doc(), null, ctx({ followedGenres: new Set(["rock"]) }))).toBe(1);
    expect(scoreResult(doc({ kind: "artist", hasAudio: true }), null, ctx())).toBe(0.5);
    expect(scoreResult(doc({ kind: "show", hasAudio: true }), null, ctx())).toBe(0);
  });
});

describe("compareRanked", () => {
  const r = (score: number, startsAt: number | null, title: string, id: string): Ranked =>
    ({ doc: doc({ startsAt, title, sourceId: id }), distanceMeters: null, score });
  it("sorts by score desc, then soonest, then title, then id, deterministically", () => {
    const list = [r(1, 5, "b", "2"), r(2, 9, "z", "9"), r(1, 5, "a", "1"), r(1, null, "a", "0"), r(1, 5, "a", "0")];
    const ids = [...list].sort(compareRanked).map((x) => x.doc.sourceId);
    expect(ids).toEqual(["9", "0", "1", "2", "0"].slice(0, 5));
    expect([...list].sort(compareRanked).map((x) => x.doc.sourceId)).toEqual(ids);
  });
});

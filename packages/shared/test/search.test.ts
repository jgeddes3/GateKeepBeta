import { describe, it, expect } from "vitest";
import {
  normalizeWords, buildTokens, queryWords, dayKeyInLaunchZone, launchZoneDayStartMs, launchZoneNextDayStartMs,
  addDaysToDayKey, whenWindow, matchesText, matchesFilters, matchesSavedSearch, savedSearchLabel,
  validateSearchInput, validateSavedSearchInput, kindForFace, refKindForKind,
  SEARCH_MAX_TOKENS, type SearchIndexDoc,
} from "../src/index.js";

function doc(overrides: Partial<SearchIndexDoc> = {}): SearchIndexDoc {
  const words = normalizeWords("The Night Owls at Mohawk");
  return {
    kind: "show", sourceId: "ev1", handle: null, title: "The Night Owls", subtitle: "Mohawk",
    words, tokens: buildTokens(words), genres: ["rock", "indie"], city: "Austin", cityLower: "austin",
    neighborhood: "Red River", geo: { lat: 30.27, lng: -97.74 }, startsAt: 1_800_000_000_000, endsAt: 1_800_010_000_000,
    priceFromCents: 0, hasFreeTier: true, ageRestriction: "all_ages", budgetMinCents: null, budgetMaxCents: null, actSize: null,
    hasAudio: false, busyDays: [], relatedProfileIds: ["cur1", "mus1"], followerCount: 0, imagePath: null,
    updatedAt: 1, ...overrides,
  };
}

describe("normalizeWords", () => {
  it("lowercases, strips accents and punctuation, drops one-char words, dedupes", () => {
    expect(normalizeWords("Émilie's  R&B! Night (2)")).toEqual(["emilie", "night"]);
    expect(normalizeWords("Rock rock ROCK")).toEqual(["rock"]);
  });
  it("keeps at most 40 words", () => {
    const text = Array.from({ length: 60 }, (_, i) => `w${i + 10}`).join(" ");
    expect(normalizeWords(text)).toHaveLength(40);
  });
  it("keeps non-Latin letters as words instead of dropping them (spec: split on non letter/digit)", () => {
    expect(normalizeWords("Оркестр Ночных Сов")).toEqual(["оркестр", "ночных", "сов"]);
    // The accent-strip step (NFD + combining-mark removal) also strips a
    // Greek tonos the same way it strips a Latin acute accent.
    expect(normalizeWords("Ελληνικό Συγκρότημα")).toEqual(["ελληνικο", "συγκροτημα"]);
  });
});

describe("buildTokens", () => {
  it("emits prefixes from 2 to 12 chars per word", () => {
    expect(buildTokens(["owls"])).toEqual(["ow", "owl", "owls"]);
    expect(buildTokens(["abcdefghijklmnop"])).toEqual([
      "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "abcdefghi", "abcdefghij", "abcdefghijk", "abcdefghijkl",
    ]);
  });
  it("dedupes across words and caps at 150, trimming the longest words last", () => {
    expect(buildTokens(["night", "nightly"])).toEqual(["ni", "nig", "nigh", "night", "nightl", "nightly"]);
    const words = Array.from({ length: 40 }, (_, i) => `abcdefghijk${String.fromCharCode(97 + (i % 26))}${i}`);
    const tokens = buildTokens(words);
    expect(tokens.length).toBeLessThanOrEqual(SEARCH_MAX_TOKENS);
    expect(tokens).toContain("ab");
  });
});

describe("queryWords", () => {
  it("truncates each word to 12 chars and keeps at most 10 words", () => {
    expect(queryWords("Abcdefghijklmnop")).toEqual(["abcdefghijkl"]);
    expect(queryWords(Array.from({ length: 15 }, (_, i) => `word${i}`).join(" "))).toHaveLength(10);
    expect(queryWords("  a  ")).toEqual([]);
  });
});

describe("day helpers", () => {
  it("keys a UTC instant by the launch zone's calendar date", () => {
    // 2026-03-08T04:30Z is 2026-03-07 23:30 in New York (before spring forward).
    expect(dayKeyInLaunchZone(Date.UTC(2026, 2, 8, 4, 30))).toBe("2026-03-07");
    expect(dayKeyInLaunchZone(Date.UTC(2026, 2, 8, 5, 30))).toBe("2026-03-08");
  });
  it("finds the zone midnight for a date and the next day's midnight across DST", () => {
    const start = launchZoneDayStartMs("2026-03-08")!;
    expect(dayKeyInLaunchZone(start)).toBe("2026-03-08");
    expect(dayKeyInLaunchZone(start - 1)).toBe("2026-03-07");
    const next = launchZoneNextDayStartMs("2026-03-08")!;
    expect(next - start).toBe(23 * 60 * 60 * 1000);
    expect(launchZoneDayStartMs("2026-02-30")).toBeNull();
    expect(launchZoneDayStartMs("")).toBeNull();
  });
  it("adds days to a key", () => {
    expect(addDaysToDayKey("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("whenWindow", () => {
  const wed = Date.UTC(2026, 8, 2, 16, 0); // Wed 2026-09-02 12:00 New York
  const sat = Date.UTC(2026, 8, 5, 16, 0); // Sat 2026-09-05 12:00 New York
  const sun = Date.UTC(2026, 8, 6, 16, 0); // Sun 2026-09-06 12:00 New York
  it("tonight runs to the end of today", () => {
    const w = whenWindow("tonight", wed);
    expect(w.start).toBe(wed);
    expect(w.end).toBe(launchZoneNextDayStartMs("2026-09-02"));
  });
  it("weekend on a Wednesday is the coming Friday 17:00 through Sunday", () => {
    const w = whenWindow("weekend", wed);
    expect(w.start).toBe(launchZoneDayStartMs("2026-09-04")! + 17 * 60 * 60 * 1000);
    expect(w.end).toBe(launchZoneNextDayStartMs("2026-09-06"));
  });
  it("weekend on a Saturday or Sunday starts now", () => {
    expect(whenWindow("weekend", sat).start).toBe(sat);
    expect(whenWindow("weekend", sat).end).toBe(launchZoneNextDayStartMs("2026-09-06"));
    expect(whenWindow("weekend", sun).start).toBe(sun);
    expect(whenWindow("weekend", sun).end).toBe(launchZoneNextDayStartMs("2026-09-06"));
  });
  it("month is 30 days and any is open-ended", () => {
    expect(whenWindow("month", wed)).toEqual({ start: wed, end: wed + 30 * 24 * 60 * 60 * 1000 });
    expect(whenWindow("any", wed)).toEqual({ start: wed, end: null });
  });
});

describe("matching", () => {
  it("text requires every query word to be a prefix of some doc word", () => {
    const d = doc();
    expect(matchesText(d, queryWords("night owl"))).toBe(true);
    expect(matchesText(d, queryWords("night hawks"))).toBe(false);
    expect(matchesText(d, [])).toBe(true);
  });
  it("applies each filter", () => {
    const now = 1_799_990_000_000;
    expect(matchesFilters(doc(), { genres: ["indie"] }, now)).toBe(true);
    expect(matchesFilters(doc(), { genres: ["jazz"] }, now)).toBe(false);
    expect(matchesFilters(doc({ hasFreeTier: false }), { freeOnly: true }, now)).toBe(false);
    expect(matchesFilters(doc({ kind: "gig", budgetMaxCents: 50_000 }), { budgetMinCents: 40_000 }, now)).toBe(true);
    expect(matchesFilters(doc({ kind: "gig", budgetMaxCents: null }), { budgetMinCents: 1 }, now)).toBe(false);
    expect(matchesFilters(doc({ kind: "artist", actSize: "band" }), { actSize: "solo" }, now)).toBe(false);
    expect(matchesFilters(doc({ kind: "artist" }), { city: " AUSTIN " }, now)).toBe(true);
    expect(matchesFilters(doc({ kind: "artist", hasAudio: false }), { hasAudio: true }, now)).toBe(false);
    expect(matchesFilters(doc({ kind: "artist", busyDays: ["2026-09-12"] }), { availableOn: "2026-09-12" }, now)).toBe(false);
    expect(matchesFilters(doc({ kind: "artist", busyDays: ["2026-09-12"] }), { availableOn: "2026-09-13" }, now)).toBe(true);
    expect(matchesFilters(doc({ startsAt: now + 40 * 24 * 60 * 60 * 1000 }), { when: "month" }, now)).toBe(false);
    expect(matchesFilters(doc(), { nearMe: true }, now)).toBe(true); // distance is the callable's job
  });
  it("matchesSavedSearch combines text and filters and ignores nearMe", () => {
    const now = 1_799_990_000_000;
    expect(matchesSavedSearch(doc(), { kind: "show", q: "owls", filters: { genres: ["rock"], nearMe: true } }, now)).toBe(true);
    expect(matchesSavedSearch(doc(), { kind: "gig", q: "owls", filters: {} }, now)).toBe(false);
    expect(matchesSavedSearch(doc(), { kind: "show", q: "hawks", filters: {} }, now)).toBe(false);
  });
});

describe("savedSearchLabel", () => {
  it("quotes the query and lists filters", () => {
    expect(savedSearchLabel("fan", "night owls", { when: "weekend", genres: ["rock"], freeOnly: true }))
      .toBe("\"night owls\" · This weekend · Rock · Free");
    expect(savedSearchLabel("musician_gigs", "", { budgetMinCents: 25_000 })).toBe("Budget from $250");
    expect(savedSearchLabel("curator", "", { actSize: "band", city: "Austin", hasAudio: true, availableOn: "2026-09-12" }))
      .toBe("Band · Austin · Has audio · Free on Sat, Sep 12");
  });
});

describe("validateSearchInput", () => {
  const good = { face: "fan", q: "owls", filters: { when: "weekend" }, location: null, page: 0, includePins: false };
  it("accepts a well-formed input", () => {
    const v = validateSearchInput(good);
    expect(v.ok).toBe(true);
  });
  it("rejects bad faces, long queries, bad pages, foreign filters, and bad locations", () => {
    expect(validateSearchInput({ ...good, face: "admin" }).ok).toBe(false);
    expect(validateSearchInput({ ...good, q: "x".repeat(81) }).ok).toBe(false);
    expect(validateSearchInput({ ...good, page: -1 }).ok).toBe(false);
    expect(validateSearchInput({ ...good, page: 51 }).ok).toBe(false);
    expect(validateSearchInput({ ...good, filters: { actSize: "band" } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, filters: { genres: ["polka"] } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, filters: { genres: ["rock", "indie", "pop", "jazz", "soul", "blues"] } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, location: undefined }).ok).toBe(false);
    expect(validateSearchInput({ ...good, location: { lat: "1", lng: 2 } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, location: { lat: 91, lng: 2 } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, face: "curator", filters: { availableOn: "12/09/2026" } }).ok).toBe(false);
    expect(validateSearchInput({ ...good, face: "musician_gigs", filters: { budgetMinCents: -1 } }).ok).toBe(false);
  });
  it("validateSavedSearchInput needs a query or a filter and forces nearMe off", () => {
    expect(validateSavedSearchInput({ face: "fan", q: "", filters: { nearMe: true } }).ok).toBe(false);
    const v = validateSavedSearchInput({ face: "fan", q: "", filters: { freeOnly: true, nearMe: true } });
    expect(v.ok && v.input.filters.nearMe).toBe(false);
    expect(validateSavedSearchInput({ face: "fan", q: "", filters: { when: "any" } }).ok).toBe(false);
    expect(validateSavedSearchInput({ face: "fan", q: "", filters: { genres: [] } }).ok).toBe(false);
  });
  // curator has no "nearMe" entry in FACE_FILTER_KEYS, so a save must not
  // stamp one into the stored filters (or a later re-save of that exact
  // doc would fail validateFilters), but restoring an older doc that does
  // carry a literal `nearMe: false` must still round-trip cleanly.
  it("omits nearMe entirely for a face without it, but tolerates a stored nearMe:false on restore", () => {
    const saved = validateSavedSearchInput({ face: "curator", q: "", filters: { actSize: "duo" } });
    expect(saved.ok && saved.input.filters).toEqual({ actSize: "duo" });
    expect(saved.ok && "nearMe" in saved.input.filters).toBe(false);
    const restored = validateSavedSearchInput({ face: "curator", q: "", filters: { actSize: "duo", nearMe: false } });
    expect(restored.ok && restored.input.filters).toEqual({ actSize: "duo" });
    const bad = validateSavedSearchInput({ face: "curator", q: "", filters: { actSize: "duo", nearMe: true } });
    expect(bad.ok).toBe(false);
  });
});

describe("face and kind mapping", () => {
  it("maps faces to kinds and kinds to ref kinds", () => {
    expect(kindForFace("fan")).toBe("show");
    expect(kindForFace("musician_gigs")).toBe("gig");
    expect(kindForFace("musician_venues")).toBe("venue");
    expect(kindForFace("curator")).toBe("artist");
    expect(refKindForKind("show")).toBe("event");
    expect(refKindForKind("gig")).toBe("gig");
    expect(refKindForKind("artist")).toBe("profile");
    expect(refKindForKind("venue")).toBe("profile");
  });
});

describe("allAges filter", () => {
  it("keeps all-ages shows and drops 18+ and 21+ when set, and is a no-op when unset", () => {
    const allAges = doc({ ageRestriction: "all_ages" });
    const eighteen = doc({ ageRestriction: "18_plus" });
    const twentyOne = doc({ ageRestriction: "21_plus" });
    expect(matchesFilters(allAges, { allAges: true }, Date.now())).toBe(true);
    expect(matchesFilters(eighteen, { allAges: true }, Date.now())).toBe(false);
    expect(matchesFilters(twentyOne, { allAges: true }, Date.now())).toBe(false);
    for (const d of [allAges, eighteen, twentyOne]) {
      expect(matchesFilters(d, {}, Date.now())).toBe(true);
      expect(matchesFilters(d, { allAges: false }, Date.now())).toBe(true);
    }
  });
  it("validates on the fan face only, and labels a saved search", () => {
    const ok = validateSearchInput({ face: "fan", q: "", filters: { allAges: true }, location: null, page: 0, includePins: false });
    expect(ok.ok).toBe(true);
    const bad = validateSearchInput({ face: "curator", q: "", filters: { allAges: true }, location: null, page: 0, includePins: false });
    expect(bad.ok).toBe(false);
    expect(savedSearchLabel("fan", "owls", { allAges: true })).toBe('"owls" · All ages only');
  });
});

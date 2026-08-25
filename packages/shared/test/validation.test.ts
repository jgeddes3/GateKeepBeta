import { describe, it, expect } from "vitest";
import {
  validateHandle, validateProfileDraft, RESERVED_HANDLES,
  validatePortfolioUpdate, validateBookingUpdate, validateTrackCreate,
  GENRES, GIG_TYPES, MAX_TRACKS, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES,
  ACT_SIZES, AVAILABILITY_PATTERNS, TRACK_STATUSES,
} from "../src/index";
import type { ProfileDraftInput } from "../src/index";

describe("validateHandle", () => {
  it("accepts lowercase letters, digits, underscores, 3-30 chars", () => {
    expect(validateHandle("midnight_owls9")).toEqual({ ok: true });
  });
  it("rejects reserved handles", () => {
    expect(validateHandle("admin").ok).toBe(false);
    expect(RESERVED_HANDLES).toContain("gatekeep");
  });
  it("rejects uppercase, spaces, symbols, short, long", () => {
    for (const bad of ["Ab", "has space", "sym!bol", "ab", "a".repeat(31)]) {
      expect(validateHandle(bad).ok).toBe(false);
    }
  });
  it("rejects non-string input at runtime, even though Array.includes would not coerce it", () => {
    // Untrusted onCall payloads aren't guaranteed to match the compile-time
    // type, so simulate a malicious/malformed caller with a type assertion.
    expect(validateHandle(["admin"] as unknown as string).ok).toBe(false);
    expect(validateHandle(123 as unknown as string).ok).toBe(false);
    expect(validateHandle(null as unknown as string).ok).toBe(false);
    expect(validateHandle(undefined as unknown as string).ok).toBe(false);
  });
});

describe("validateProfileDraft", () => {
  it("accepts a valid musician band draft", () => {
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: "The Midnight Owls", handle: "midnight_owls" })
    ).toEqual({ ok: true });
  });
  it("rejects subtype not belonging to type", () => {
    expect(validateProfileDraft({ type: "musician", subtype: "venue", name: "X", handle: "xxx" }).ok).toBe(false);
  });
  it("rejects empty or >80 char names", () => {
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "", handle: "abc" }).ok).toBe(false);
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "a".repeat(81), handle: "abc" }).ok).toBe(false);
  });
  it("rejects non-string fields at runtime (untrusted onCall payload shapes)", () => {
    expect(
      validateProfileDraft({ type: ["musician"], subtype: "band", name: "X", handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: 5, name: "X", handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: null, handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: "X", handle: 123 } as unknown as ProfileDraftInput).ok
    ).toBe(false);
  });
});

describe("validatePortfolioUpdate", () => {
  const ok = { profileId: "p1", bio: "We play soul.", genres: [GENRES[0]], externalLinks: [] };
  it("accepts a valid update", () => {
    expect(validatePortfolioUpdate(ok).ok).toBe(true);
  });
  it("rejects a bio over 2000 chars", () => {
    expect(validatePortfolioUpdate({ ...ok, bio: "x".repeat(2001) }).ok).toBe(false);
  });
  it("rejects zero or >3 genres and unknown genres", () => {
    expect(validatePortfolioUpdate({ ...ok, genres: [] }).ok).toBe(false);
    expect(validatePortfolioUpdate({ ...ok, genres: [GENRES[0], GENRES[1], GENRES[2], GENRES[3]] }).ok).toBe(false);
    expect(validatePortfolioUpdate({ ...ok, genres: ["polka-metal-fusion-invalid"] }).ok).toBe(false);
  });
  it("enforces link domains per kind, https only, and the 8-link cap", () => {
    const link = (kind: string, url: string) =>
      validatePortfolioUpdate({ ...ok, externalLinks: [{ kind: kind as never, url }] });
    expect(link("spotify", "https://open.spotify.com/artist/abc").ok).toBe(true);
    expect(link("spotify", "https://evil.example/artist/abc").ok).toBe(false);
    expect(link("youtube", "https://youtu.be/xyz").ok).toBe(true);
    expect(link("instagram", "https://www.instagram.com/band").ok).toBe(true);
    expect(link("website", "https://ourband.example").ok).toBe(true);
    expect(link("website", "http://ourband.example").ok).toBe(false);
    const nine = Array.from({ length: 9 }, () => ({ kind: "website" as const, url: "https://x.example" }));
    expect(validatePortfolioUpdate({ ...ok, externalLinks: nine }).ok).toBe(false);
  });
  it("rejects non-string/malformed runtime payloads (untrusted onCall data)", () => {
    expect(validatePortfolioUpdate({ profileId: "p1", bio: 42 } as never).ok).toBe(false);
    expect(validatePortfolioUpdate({ profileId: "p1", externalLinks: [{ kind: "spotify" }] } as never).ok).toBe(false);
  });
  it("rejects spotify-lookalike hosts (subdomain suffix, userinfo trick, homograph) and accepts an uppercase scheme", () => {
    const link = (kind: string, url: string) =>
      validatePortfolioUpdate({ ...ok, externalLinks: [{ kind: kind as never, url }] });
    expect(link("spotify", "https://open.spotify.com.evil.example/x").ok).toBe(false);
    expect(link("spotify", "https://open.spotify.com@evil.example/x").ok).toBe(false);
    expect(link("spotify", "https://opеn.spotify.com/x").ok).toBe(false); // е is Cyrillic "е", not Latin "e"
    expect(link("spotify", "HTTPS://OPEN.SPOTIFY.COM/artist/a").ok).toBe(true); // regex has /i — uppercase scheme+host are fine
  });
  it("rejects the 'Nothing to update' case when bio/genres/externalLinks are all omitted", () => {
    expect(validatePortfolioUpdate({ profileId: "p1" }).ok).toBe(false);
  });
  it("rejects duplicate genres", () => {
    expect(validatePortfolioUpdate({ ...ok, genres: [GENRES[0], GENRES[0]] }).ok).toBe(false);
  });
  it("rejects duplicate links", () => {
    const dup = [
      { kind: "website" as const, url: "https://x.example" },
      { kind: "website" as const, url: "https://x.example" },
    ];
    expect(validatePortfolioUpdate({ ...ok, externalLinks: dup }).ok).toBe(false);
  });
  it("rejects an invalid profileId (empty, or containing a path separator)", () => {
    expect(validatePortfolioUpdate({ profileId: "", bio: "hi" }).ok).toBe(false);
    expect(validatePortfolioUpdate({ profileId: "p1/members/attacker", bio: "hi" }).ok).toBe(false);
  });
});

describe("validateBookingUpdate", () => {
  const ok = {
    profileId: "p1",
    rates: { perHour: { amountCents: 15000, note: null }, perSong: null, perSet: { amountCents: 60000, note: "3 x 45min" } },
    preferences: { gigTypes: [GIG_TYPES[0]], travelRadiusKm: 50, actSize: "band" as const,
      typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends" as const },
  };
  it("accepts a valid update", () => { expect(validateBookingUpdate(ok).ok).toBe(true); });
  it("accepts all-null rates and empty preferences (musician may fill in later)", () => {
    expect(validateBookingUpdate({ profileId: "p1",
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [], travelRadiusKm: null, actSize: null,
        typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null } }).ok).toBe(true);
  });
  it("rejects non-integer, zero, negative, or absurd amounts", () => {
    for (const amountCents of [0, -5, 12.5, 100_000_001]) {
      expect(validateBookingUpdate({ ...ok,
        rates: { ...ok.rates, perHour: { amountCents, note: null } } }).ok).toBe(false);
    }
  });
  it("rejects unknown gig types and out-of-range radius/set minutes", () => {
    expect(validateBookingUpdate({ ...ok, preferences: { ...ok.preferences, gigTypes: ["yacht-rave"] } }).ok).toBe(false);
    expect(validateBookingUpdate({ ...ok, preferences: { ...ok.preferences, travelRadiusKm: -1 } }).ok).toBe(false);
    expect(validateBookingUpdate({ ...ok, preferences: { ...ok.preferences, typicalSetMinutes: 5000 } }).ok).toBe(false);
  });
  it("rejects too many gig types and duplicate gig types", () => {
    const tooMany = Array.from({ length: GIG_TYPES.length + 1 }, () => GIG_TYPES[0]);
    expect(validateBookingUpdate({ ...ok, preferences: { ...ok.preferences, gigTypes: tooMany } }).ok).toBe(false);
    expect(validateBookingUpdate({
      ...ok, preferences: { ...ok.preferences, gigTypes: [GIG_TYPES[0], GIG_TYPES[0]] },
    }).ok).toBe(false);
  });
  it("treats an omitted rate (undefined, not present in the payload) the same as explicit null", () => {
    expect(validateBookingUpdate({ profileId: "p1", rates: {} as never, preferences: ok.preferences }).ok).toBe(true);
  });
  it("treats an omitted rate note (undefined) the same as explicit null", () => {
    expect(validateBookingUpdate({
      ...ok, rates: { ...ok.rates, perHour: { amountCents: 100 } as never },
    }).ok).toBe(true);
  });
  it("rejects an invalid profileId (empty, or containing a path separator)", () => {
    expect(validateBookingUpdate({ ...ok, profileId: "" }).ok).toBe(false);
    expect(validateBookingUpdate({ ...ok, profileId: "p1/x" }).ok).toBe(false);
  });
});

describe("validateTrackCreate", () => {
  const ok = { profileId: "p1", title: "Midnight Line", startSec: 42,
    sizeBytes: 8_000_000, contentType: "audio/mpeg" };
  it("accepts a valid create", () => { expect(validateTrackCreate(ok).ok).toBe(true); });
  it("rejects empty/long titles", () => {
    expect(validateTrackCreate({ ...ok, title: "  " }).ok).toBe(false);
    expect(validateTrackCreate({ ...ok, title: "x".repeat(81) }).ok).toBe(false);
  });
  it("rejects negative startSec and non-numeric startSec", () => {
    expect(validateTrackCreate({ ...ok, startSec: -1 }).ok).toBe(false);
    expect(validateTrackCreate({ ...ok, startSec: "0" as never }).ok).toBe(false);
  });
  it("rejects oversized files and non-audio content types", () => {
    expect(validateTrackCreate({ ...ok, sizeBytes: MAX_AUDIO_UPLOAD_BYTES + 1 }).ok).toBe(false);
    expect(validateTrackCreate({ ...ok, contentType: "video/mp4" }).ok).toBe(false);
  });
  it("checks the length bound against the trimmed title, not the raw string", () => {
    const padded = "  " + "x".repeat(80) + "  "; // trims to exactly 80
    expect(validateTrackCreate({ ...ok, title: padded }).ok).toBe(true);
    expect(validateTrackCreate({ ...ok, title: "x".repeat(81) }).ok).toBe(false);
  });
  it("rejects an invalid profileId (empty, or containing a path separator)", () => {
    expect(validateTrackCreate({ ...ok, profileId: "" }).ok).toBe(false);
    expect(validateTrackCreate({ ...ok, profileId: "p1/x" }).ok).toBe(false);
  });
});

describe("constants", () => {
  it("locks the product caps from the spec", () => {
    expect(MAX_TRACKS).toBe(10);
    expect(MAX_CLIP_SECONDS).toBe(30);
  });
  it("derives the runtime allowlist arrays that back the ActSize/AvailabilityPattern/TrackStatus unions", () => {
    expect(ACT_SIZES).toEqual(["solo", "duo", "band"]);
    expect(AVAILABILITY_PATTERNS).toEqual(["weekends", "weeknights", "anytime", "limited"]);
    expect(TRACK_STATUSES).toEqual(["processing", "pending_review", "approved", "rejected", "failed"]);
  });
});

describe("never throws on hostile payloads (defensive runtime guards)", () => {
  // Each of these previously either threw (prototype-chain `in` lookup) or
  // silently validated as ok (missing array/length/id checks). All must now
  // fail cleanly — no uncaught exception, ok: false.
  const hostileCases: Array<{ name: string; run: () => { ok: boolean } }> = [
    {
      name: "link kind 'constructor' (prototype-chain lookup bypass)",
      run: () => validatePortfolioUpdate({ profileId: "p1", externalLinks: [{ kind: "constructor" as never, url: "https://x.example" }] }),
    },
    {
      name: "link kind 'toString'",
      run: () => validatePortfolioUpdate({ profileId: "p1", externalLinks: [{ kind: "toString" as never, url: "https://x.example" }] }),
    },
    {
      name: "link kind '__proto__'",
      run: () => validatePortfolioUpdate({ profileId: "p1", externalLinks: [{ kind: "__proto__" as never, url: "https://x.example" }] }),
    },
    {
      name: "booking rates as an array",
      run: () => validateBookingUpdate({
        profileId: "p1",
        rates: [] as never,
        preferences: { gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null },
      }),
    },
    {
      name: "booking preferences as null",
      run: () => validateBookingUpdate({
        profileId: "p1",
        rates: { perHour: null, perSong: null, perSet: null },
        preferences: null as never,
      }),
    },
    {
      name: "portfolio genres as a plain object",
      run: () => validatePortfolioUpdate({ profileId: "p1", genres: {} as never }),
    },
    {
      name: "track startSec as NaN",
      run: () => validateTrackCreate({ profileId: "p1", title: "T", startSec: NaN, sizeBytes: 1000, contentType: "audio/mpeg" }),
    },
    {
      name: "profileId containing a path separator",
      run: () => validatePortfolioUpdate({ profileId: "a/b", bio: "hi" }),
    },
  ];
  for (const { name, run } of hostileCases) {
    it(`does not throw and reports ok:false — ${name}`, () => {
      let result: { ok: boolean } | undefined;
      expect(() => { result = run(); }).not.toThrow();
      expect(result?.ok).toBe(false);
    });
  }
});

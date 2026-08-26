import { describe, it, expect, vi } from "vitest";
import {
  validateHandle, validateProfileDraft, RESERVED_HANDLES,
  validatePortfolioUpdate, validateBookingUpdate, validateTrackCreate,
  validateLookingFor, validateGigContent, validateBudget, validateRecurrence,
  computeExpectedTotalCents, computeDepositCents, validateOfferInput, validateBookingVisibility,
  GENRES, GIG_TYPES, MAX_TRACKS, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES,
  ACT_SIZES, AVAILABILITY_PATTERNS, TRACK_STATUSES,
  GIG_STATUSES, SERIES_STATUSES, SERIES_CADENCES, FILL_MODES,
  MAX_OPEN_GIGS_PER_PROFILE, MAX_ACTIVE_SERIES_PER_PROFILE, MAX_PENDING_CURATOR_PROFILES,
  RESUBMIT_COOLDOWN_MS, SERIES_MATERIALIZE_WEEKS,
  BOOKING_STATUSES, MAX_BOOKING_THREAD_ENTRIES, MAX_OFFER_NOTE_LENGTH, MAX_CANCEL_REASON_LENGTH,
  MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE, MAX_OFFER_AMOUNT_CENTS, MAX_OFFER_SONG_COUNT, DEPOSIT_PERCENT,
  CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS, MAX_RELIABILITY_MARKS,
  NO_SHOW_REPORT_WINDOW_DAYS,
} from "../src/index";
import type {
  ProfileDraftInput, LookingFor, GigWants, ProfileDoc, CuratorDetails, BookingVisibility,
} from "../src/index";

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
  it("accepts query/fragment/explicit-port URL shapes and whitespace padding, and rejects the host:port@ userinfo trick", () => {
    const link = (kind: string, url: string) =>
      validatePortfolioUpdate({ ...ok, externalLinks: [{ kind: kind as never, url }] });
    expect(link("spotify", "https://open.spotify.com?si=1").ok).toBe(true);
    expect(link("spotify", "https://open.spotify.com#x").ok).toBe(true);
    expect(link("spotify", "https://open.spotify.com:443/artist/a").ok).toBe(true);
    expect(link("spotify", "  https://open.spotify.com/artist/a  ").ok).toBe(true);
    expect(link("spotify", "https://open.spotify.com:80@evil.example/").ok).toBe(false);
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
  // SP4: BookingUpdateInput now carries a required `visibility` — this
  // literal is the backfill default (all rates + preferences "curators",
  // i.e. pre-SP4 exposure), reused everywhere below that needs a legal one.
  const okVisibility: BookingVisibility = {
    perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
  };
  const ok = {
    profileId: "p1",
    rates: { perHour: { amountCents: 15000, note: null }, perSong: null, perSet: { amountCents: 60000, note: "3 x 45min" } },
    preferences: { gigTypes: [GIG_TYPES[0]], travelRadiusKm: 50, actSize: "band" as const,
      typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends" as const },
    visibility: okVisibility,
  };
  it("accepts a valid update", () => { expect(validateBookingUpdate(ok).ok).toBe(true); });
  it("accepts all-null rates and empty preferences (musician may fill in later)", () => {
    expect(validateBookingUpdate({ profileId: "p1",
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [], travelRadiusKm: null, actSize: null,
        typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null },
      visibility: okVisibility }).ok).toBe(true);
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
    expect(validateBookingUpdate({
      profileId: "p1", rates: {} as never, preferences: ok.preferences, visibility: okVisibility,
    }).ok).toBe(true);
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
  it("delegates to validateBookingVisibility — rejects a garbage visibility payload", () => {
    expect(validateBookingUpdate({ ...ok, visibility: { perHour: "public" } as never }).ok).toBe(false);
  });
  it("treats preferences with all scalar fields omitted (undefined, not just explicit null) as valid", () => {
    expect(validateBookingUpdate({
      profileId: "p1",
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [] } as never,
      visibility: okVisibility,
    }).ok).toBe(true);
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
        visibility: { perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators" },
      }),
    },
    {
      name: "booking preferences as null",
      run: () => validateBookingUpdate({
        profileId: "p1",
        rates: { perHour: null, perSong: null, perSet: null },
        preferences: null as never,
        visibility: { perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators" },
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

// ---------- Sub-project 3: curator gigs ----------

describe("validateLookingFor", () => {
  const ok: LookingFor = { genres: [GENRES[0]], actSizes: [ACT_SIZES[0]], notes: null };
  it("accepts a valid looking-for", () => {
    expect(validateLookingFor(ok).ok).toBe(true);
  });
  it("requires at least one genre", () => {
    expect(validateLookingFor({ ...ok, genres: [] }).ok).toBe(false);
  });
  it("rejects an unknown genre", () => {
    expect(validateLookingFor({ ...ok, genres: ["polka-metal-fusion-invalid"] }).ok).toBe(false);
  });
  it("requires at least one act size", () => {
    expect(validateLookingFor({ ...ok, actSizes: [] }).ok).toBe(false);
  });
  it("rejects an unknown act size", () => {
    expect(validateLookingFor({ ...ok, actSizes: ["orchestra"] as never }).ok).toBe(false);
  });
  it("S1: rejects an oversized genres array (longer than GENRES itself) even if every element is valid", () => {
    const oversized = Array.from({ length: GENRES.length + 1 }, (_, i) => GENRES[i % GENRES.length]);
    expect(validateLookingFor({ ...ok, genres: oversized }).ok).toBe(false);
  });
  it("S1: rejects duplicate genres", () => {
    expect(validateLookingFor({ ...ok, genres: [GENRES[0], GENRES[0]] }).ok).toBe(false);
  });
  it("S1: rejects an oversized actSizes array (longer than ACT_SIZES itself) even if every element is valid", () => {
    const oversized = Array.from({ length: ACT_SIZES.length + 1 }, (_, i) => ACT_SIZES[i % ACT_SIZES.length]);
    expect(validateLookingFor({ ...ok, actSizes: oversized as never }).ok).toBe(false);
  });
  it("S1: rejects duplicate act sizes", () => {
    expect(validateLookingFor({ ...ok, actSizes: [ACT_SIZES[0], ACT_SIZES[0]] }).ok).toBe(false);
  });
  it("accepts notes at exactly 500 chars and rejects 501", () => {
    expect(validateLookingFor({ ...ok, notes: "x".repeat(500) }).ok).toBe(true);
    expect(validateLookingFor({ ...ok, notes: "x".repeat(501) }).ok).toBe(false);
  });
  it("accepts null notes", () => {
    expect(validateLookingFor({ ...ok, notes: null }).ok).toBe(true);
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateLookingFor(null as never).ok).toBe(false);
    expect(validateLookingFor([] as never).ok).toBe(false);
    expect(validateLookingFor({ ...ok, genres: "rock" as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, genres: 5 as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, genres: [5] as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, actSizes: null as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, actSizes: {} as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, notes: 42 as never }).ok).toBe(false);
    expect(validateLookingFor({ ...ok, notes: [] as never }).ok).toBe(false);
  });
});

describe("validateGigContent", () => {
  const ok = {
    title: "Friday Night Sessions",
    description: "A weekly open mic for local acts.",
    wants: { genres: [GENRES[0]], actSizes: [ACT_SIZES[0]] } satisfies GigWants,
    durationMinutes: 60,
    provisions: { hasPA: true, hasBackline: false, notes: null },
  };
  it("accepts valid gig content", () => {
    expect(validateGigContent(ok).ok).toBe(true);
  });
  it("accepts a title at exactly 80 chars and rejects 81", () => {
    expect(validateGigContent({ ...ok, title: "x".repeat(80) }).ok).toBe(true);
    expect(validateGigContent({ ...ok, title: "x".repeat(81) }).ok).toBe(false);
  });
  it("rejects an empty (or whitespace-only) title", () => {
    expect(validateGigContent({ ...ok, title: "" }).ok).toBe(false);
    expect(validateGigContent({ ...ok, title: "   " }).ok).toBe(false);
  });
  it("accepts a description at exactly 2000 chars and rejects 2001", () => {
    expect(validateGigContent({ ...ok, description: "x".repeat(2000) }).ok).toBe(true);
    expect(validateGigContent({ ...ok, description: "x".repeat(2001) }).ok).toBe(false);
  });
  it("delegates wants element validation to the looking-for rules", () => {
    expect(validateGigContent({ ...ok, wants: { genres: [], actSizes: [ACT_SIZES[0]] } }).ok).toBe(false);
    expect(validateGigContent({ ...ok, wants: { genres: [GENRES[0]], actSizes: [] } }).ok).toBe(false);
    expect(validateGigContent({ ...ok, wants: { genres: ["nonsense-genre"], actSizes: [ACT_SIZES[0]] } as never }).ok).toBe(false);
  });
  it("S1: delegates the oversized/duplicate-array caps to the looking-for rules for wants.genres and wants.actSizes", () => {
    const oversizedGenres = Array.from({ length: GENRES.length + 1 }, (_, i) => GENRES[i % GENRES.length]);
    expect(validateGigContent({ ...ok, wants: { genres: oversizedGenres, actSizes: [ACT_SIZES[0]] } }).ok).toBe(false);
    expect(validateGigContent({ ...ok, wants: { genres: [GENRES[0], GENRES[0]], actSizes: [ACT_SIZES[0]] } }).ok).toBe(false);
    const oversizedActSizes = Array.from({ length: ACT_SIZES.length + 1 }, (_, i) => ACT_SIZES[i % ACT_SIZES.length]);
    expect(validateGigContent({ ...ok, wants: { genres: [GENRES[0]], actSizes: oversizedActSizes as never } }).ok).toBe(false);
    expect(validateGigContent({ ...ok, wants: { genres: [GENRES[0]], actSizes: [ACT_SIZES[0], ACT_SIZES[0]] } }).ok).toBe(false);
  });
  it("accepts duration boundaries 15 and 720, rejects 14 and 721", () => {
    expect(validateGigContent({ ...ok, durationMinutes: 15 }).ok).toBe(true);
    expect(validateGigContent({ ...ok, durationMinutes: 14 }).ok).toBe(false);
    expect(validateGigContent({ ...ok, durationMinutes: 720 }).ok).toBe(true);
    expect(validateGigContent({ ...ok, durationMinutes: 721 }).ok).toBe(false);
  });
  it("rejects a non-integer duration", () => {
    expect(validateGigContent({ ...ok, durationMinutes: 60.5 }).ok).toBe(false);
  });
  it("accepts provisions notes at exactly 500 chars and rejects 501", () => {
    expect(validateGigContent({ ...ok, provisions: { ...ok.provisions, notes: "x".repeat(500) } }).ok).toBe(true);
    expect(validateGigContent({ ...ok, provisions: { ...ok.provisions, notes: "x".repeat(501) } }).ok).toBe(false);
  });
  it("accepts null hasPA/hasBackline and rejects non-boolean values", () => {
    expect(validateGigContent({ ...ok, provisions: { ...ok.provisions, hasPA: null, hasBackline: null } }).ok).toBe(true);
    expect(validateGigContent({ ...ok, provisions: { ...ok.provisions, hasPA: "yes" as never } }).ok).toBe(false);
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateGigContent(null as never).ok).toBe(false);
    expect(validateGigContent([] as never).ok).toBe(false);
    expect(validateGigContent({ ...ok, title: 5 as never }).ok).toBe(false);
    expect(validateGigContent({ ...ok, description: [] as never }).ok).toBe(false);
    expect(validateGigContent({ ...ok, wants: null as never }).ok).toBe(false);
    expect(validateGigContent({ ...ok, durationMinutes: "60" as never }).ok).toBe(false);
    expect(validateGigContent({ ...ok, provisions: [] as never }).ok).toBe(false);
    expect(validateGigContent({ ...ok, provisions: null as never }).ok).toBe(false);
  });
});

describe("validateBudget", () => {
  const ok = { minCents: 5000, maxCents: 20000, structure: "perHour" as const };
  it("accepts a valid budget", () => {
    expect(validateBudget(ok).ok).toBe(true);
  });
  it("accepts minCents at 0 and maxCents at exactly 5,000,000", () => {
    expect(validateBudget({ ...ok, minCents: 0 }).ok).toBe(true);
    expect(validateBudget({ ...ok, minCents: 0, maxCents: 5_000_000 }).ok).toBe(true);
  });
  it("rejects maxCents over 5,000,000", () => {
    expect(validateBudget({ ...ok, maxCents: 5_000_001 }).ok).toBe(false);
  });
  it("rejects minCents greater than maxCents", () => {
    expect(validateBudget({ ...ok, minCents: 20001 }).ok).toBe(false);
  });
  it("rejects negative cents", () => {
    expect(validateBudget({ ...ok, minCents: -1 }).ok).toBe(false);
    expect(validateBudget({ ...ok, maxCents: -1, minCents: -5 }).ok).toBe(false);
  });
  it("rejects non-integer cents", () => {
    expect(validateBudget({ ...ok, minCents: 100.5 }).ok).toBe(false);
    expect(validateBudget({ ...ok, maxCents: 200.5 }).ok).toBe(false);
  });
  it("accepts each budget structure literal", () => {
    expect(validateBudget({ ...ok, structure: "perHour" }).ok).toBe(true);
    expect(validateBudget({ ...ok, structure: "perSong" }).ok).toBe(true);
    expect(validateBudget({ ...ok, structure: "perSet" }).ok).toBe(true);
  });
  it("rejects an unknown structure", () => {
    expect(validateBudget({ ...ok, structure: "perGig" as never }).ok).toBe(false);
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateBudget(null as never).ok).toBe(false);
    expect(validateBudget([] as never).ok).toBe(false);
    expect(validateBudget({ ...ok, minCents: "0" as never }).ok).toBe(false);
    expect(validateBudget({ ...ok, maxCents: null as never }).ok).toBe(false);
    expect(validateBudget({ ...ok, structure: 1 as never }).ok).toBe(false);
    expect(validateBudget({ ...ok, structure: null as never }).ok).toBe(false);
  });
});

describe("validateRecurrence", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1000;
  const ok = { weekday: 3, hour: 19, minute: 30, cadence: "weekly" as const, endDate: now + dayMs };
  it("accepts a valid recurrence", () => {
    expect(validateRecurrence(ok, now).ok).toBe(true);
  });
  it("accepts weekday boundaries 0 and 6, rejects 7 and -1", () => {
    expect(validateRecurrence({ ...ok, weekday: 0 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, weekday: 6 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, weekday: 7 }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, weekday: -1 }, now).ok).toBe(false);
  });
  it("accepts hour boundaries 0 and 23, rejects -1 and 24", () => {
    expect(validateRecurrence({ ...ok, hour: 0 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, hour: 23 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, hour: -1 }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, hour: 24 }, now).ok).toBe(false);
  });
  it("accepts minute boundaries 0 and 59, rejects -1 and 60", () => {
    expect(validateRecurrence({ ...ok, minute: 0 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, minute: 59 }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, minute: -1 }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, minute: 60 }, now).ok).toBe(false);
  });
  it("accepts every cadence in the enum and rejects an unknown one", () => {
    expect(validateRecurrence({ ...ok, cadence: "weekly" }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, cadence: "biweekly" }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, cadence: "monthly" }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, cadence: "daily" as never }, now).ok).toBe(false);
  });
  it("accepts a null endDate", () => {
    expect(validateRecurrence({ ...ok, endDate: null }, now).ok).toBe(true);
  });
  it("accepts an endDate in the future and rejects one in the past, relative to the injected now", () => {
    expect(validateRecurrence({ ...ok, endDate: now + dayMs }, now).ok).toBe(true);
    expect(validateRecurrence({ ...ok, endDate: now - dayMs }, now).ok).toBe(false);
  });
  it("rejects an endDate exactly equal to now (must be strictly future)", () => {
    expect(validateRecurrence({ ...ok, endDate: now }, now).ok).toBe(false);
  });
  it("never calls Date.now() — behavior depends only on the injected now", () => {
    const spy = vi.spyOn(Date, "now");
    validateRecurrence(ok, now);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateRecurrence(null as never, now).ok).toBe(false);
    expect(validateRecurrence([] as never, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, weekday: "3" as never }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, hour: null as never }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, minute: [] as never }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, cadence: 1 as never }, now).ok).toBe(false);
    expect(validateRecurrence({ ...ok, endDate: "tomorrow" as never }, now).ok).toBe(false);
  });
});

describe("ProfileDoc.curator", () => {
  it("accepts a curator profile with CuratorDetails seeded (compile-time + runtime shape check)", () => {
    const curator: CuratorDetails = {
      about: "A neighborhood listening room.",
      lookingFor: { genres: [GENRES[0]], actSizes: [ACT_SIZES[0]], notes: null },
      amenities: { capacity: 80, hasPA: true, hasBackline: false, indoorOutdoor: "indoor", notes: null },
      advertisingInterest: true,
      location: { address: "123 Main St", city: "Portland", neighborhood: "Alberta", geo: null },
      photoPaths: [],
    };
    const profile: ProfileDoc = {
      type: "curator", subtype: "venue", name: "The Alberta Room", handle: "the_alberta_room",
      status: "draft", rejectionReason: null, createdAt: 0, updatedAt: 0, curator, publicBooking: null,
    };
    expect(profile.curator?.about).toBe("A neighborhood listening room.");
  });
});

describe("sub-3 gig/curator constants", () => {
  it("derives the runtime allowlist arrays that back the new status/cadence/fill-mode unions", () => {
    expect(GIG_STATUSES).toEqual(["draft", "open", "filled", "closed", "cancelled", "taken_down"]);
    expect(SERIES_STATUSES).toEqual(["active", "paused", "ended"]);
    expect(SERIES_CADENCES).toEqual(["weekly", "biweekly", "monthly"]);
    expect(FILL_MODES).toEqual(["per_occurrence", "whole_run"]);
  });
  it("locks the product caps from the spec", () => {
    expect(MAX_OPEN_GIGS_PER_PROFILE).toBe(50);
    expect(MAX_ACTIVE_SERIES_PER_PROFILE).toBe(10);
    expect(MAX_PENDING_CURATOR_PROFILES).toBe(1);
    expect(RESUBMIT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(SERIES_MATERIALIZE_WEEKS).toBe(8);
  });
});

describe("never throws on hostile payloads — sub-3 validators", () => {
  const hostileCases: Array<{ name: string; run: () => { ok: boolean } }> = [
    {
      name: "validateLookingFor genres as a plain object",
      run: () => validateLookingFor({ genres: {} as never, actSizes: [ACT_SIZES[0]], notes: null }),
    },
    {
      name: "validateGigContent provisions as an array",
      run: () => validateGigContent({
        title: "T", description: "D",
        wants: { genres: [GENRES[0]], actSizes: [ACT_SIZES[0]] },
        durationMinutes: 30, provisions: [] as never,
      }),
    },
    {
      name: "validateBudget structure as 'constructor' (prototype-chain lookup bypass)",
      run: () => validateBudget({ minCents: 0, maxCents: 100, structure: "constructor" as never }),
    },
    {
      name: "validateRecurrence as null",
      run: () => validateRecurrence(null as never, Date.parse("2026-08-26T00:00:00.000Z")),
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

// ---------- Sub-project 4: booking flow ----------

describe("computeExpectedTotalCents", () => {
  it("perHour: ceils amountCents * durationMinutes / 60 (90min at a rate yielding 13500)", () => {
    expect(computeExpectedTotalCents("perHour", 9000, { durationMinutes: 90 })).toBe(13500);
  });
  it("perSong: amountCents * songCount (12 songs at 800/song)", () => {
    expect(computeExpectedTotalCents("perSong", 800, { songCount: 12 })).toBe(9600);
  });
  it("perSet: returns amountCents unchanged, ignoring opts", () => {
    expect(computeExpectedTotalCents("perSet", 50000, {})).toBe(50000);
    expect(computeExpectedTotalCents("perSet", 50000, { durationMinutes: 90, songCount: 12 })).toBe(50000);
  });
  it("treats a missing durationMinutes/songCount as 0, not NaN or a throw", () => {
    expect(computeExpectedTotalCents("perHour", 9000, {})).toBe(0);
    expect(computeExpectedTotalCents("perSong", 800, {})).toBe(0);
  });
  it("perHour rounds a fractional cents-per-minute result UP (ceil, never down)", () => {
    // 1000 * 7 / 60 = 116.66... -> ceil to 117
    expect(computeExpectedTotalCents("perHour", 1000, { durationMinutes: 7 })).toBe(117);
  });
});

describe("computeDepositCents", () => {
  it("ceils 35% of the expected total (13500 -> 4725)", () => {
    expect(computeDepositCents(13500)).toBe(4725);
  });
  it("rounds up on odd cents (101 -> 35.35 -> 36)", () => {
    expect(computeDepositCents(101)).toBe(36);
  });
  it("returns 0 for a 0 expected total", () => {
    expect(computeDepositCents(0)).toBe(0);
  });
});

describe("validateOfferInput", () => {
  const perHourOk = { amountCents: 6000, expectedQuantity: null, note: null };
  const perSongOk = { amountCents: 800, expectedQuantity: 12, note: null };
  const perSetOk = { amountCents: 50000, expectedQuantity: null, note: null };
  it("accepts a valid offer for each structure", () => {
    expect(validateOfferInput("perHour", perHourOk)).toBeNull();
    expect(validateOfferInput("perSong", perSongOk)).toBeNull();
    expect(validateOfferInput("perSet", perSetOk)).toBeNull();
  });
  it("accepts an omitted (undefined) expectedQuantity/note the same as explicit null on perHour/perSet", () => {
    expect(validateOfferInput("perHour", { amountCents: 6000 } as never)).toBeNull();
    expect(validateOfferInput("perSet", { amountCents: 6000 } as never)).toBeNull();
  });
  it("rejects non-integer, zero, negative, and absurd amountCents", () => {
    for (const amountCents of [0, -5, 12.5, "100" as never]) {
      expect(validateOfferInput("perSet", { ...perSetOk, amountCents })).not.toBeNull();
    }
  });
  it("accepts amountCents at exactly MAX_OFFER_AMOUNT_CENTS and rejects one cent over", () => {
    expect(validateOfferInput("perSet", { ...perSetOk, amountCents: MAX_OFFER_AMOUNT_CENTS })).toBeNull();
    expect(validateOfferInput("perSet", { ...perSetOk, amountCents: MAX_OFFER_AMOUNT_CENTS + 1 })).not.toBeNull();
  });
  it("accepts a note at exactly MAX_OFFER_NOTE_LENGTH chars and rejects one over (281)", () => {
    expect(validateOfferInput("perSet", { ...perSetOk, note: "x".repeat(MAX_OFFER_NOTE_LENGTH) })).toBeNull();
    expect(validateOfferInput("perSet", { ...perSetOk, note: "x".repeat(281) })).not.toBeNull();
  });
  it("rejects a non-string note", () => {
    expect(validateOfferInput("perSet", { ...perSetOk, note: 42 as never })).not.toBeNull();
  });
  it("perSong requires an integer expectedQuantity 1-MAX_OFFER_SONG_COUNT", () => {
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: 1 })).toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: MAX_OFFER_SONG_COUNT })).toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: 0 })).not.toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: MAX_OFFER_SONG_COUNT + 1 })).not.toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: 1.5 })).not.toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: "12" as never })).not.toBeNull();
  });
  it("perSong rejects a missing (undefined) or null expectedQuantity — it's required", () => {
    expect(validateOfferInput("perSong", { amountCents: 800, note: null } as never)).not.toBeNull();
    expect(validateOfferInput("perSong", { ...perSongOk, expectedQuantity: null })).not.toBeNull();
  });
  it("perSet rejects a non-null expectedQuantity (server ignores this field for perSet)", () => {
    expect(validateOfferInput("perSet", { ...perSetOk, expectedQuantity: 3 })).not.toBeNull();
  });
  it("perHour rejects a non-null expectedQuantity (server derives this field for perHour)", () => {
    expect(validateOfferInput("perHour", { ...perHourOk, expectedQuantity: 3 })).not.toBeNull();
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateOfferInput("perSet", null as never)).not.toBeNull();
    expect(validateOfferInput("perSet", [] as never)).not.toBeNull();
    expect(validateOfferInput("perSet", "not an object" as never)).not.toBeNull();
  });
});

describe("validateBookingVisibility", () => {
  const ok: BookingVisibility = { perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators" };
  it("accepts every legal combination of rate/preferences visibility", () => {
    expect(validateBookingVisibility(ok)).toBe(true);
    expect(validateBookingVisibility({ perHour: "private", perSong: "private", perSet: "private", preferences: "curators" })).toBe(true);
    expect(validateBookingVisibility({ perHour: "curators", perSong: "private", perSet: "curators", preferences: "public" })).toBe(true);
    expect(validateBookingVisibility({ perHour: "private", perSong: "curators", perSet: "private", preferences: "public" })).toBe(true);
  });
  it("rejects a missing key", () => {
    const { preferences: _preferences, ...missingPreferences } = ok;
    expect(validateBookingVisibility(missingPreferences)).toBe(false);
  });
  it("rejects an extra key even when the four required keys are all valid", () => {
    expect(validateBookingVisibility({ ...ok, extra: "x" })).toBe(false);
  });
  it("rejects a swapped-in alien key: exactly 4 own keys, but one required key (preferences) is missing", () => {
    // Same key COUNT as a valid object (so the length check alone can't
    // catch it) — this is the only input shape that reaches (and exercises)
    // the hasOwnProperty loop's own reject branch.
    const { preferences: _preferences, ...rest } = ok;
    expect(validateBookingVisibility({ ...rest, alien: "curators" })).toBe(false);
  });
  it('rejects "public" on a rate field (rates are never public — spec decision 4)', () => {
    expect(validateBookingVisibility({ ...ok, perHour: "public" })).toBe(false);
  });
  it('rejects "private" on preferences (not a legal PrefsVisibility value)', () => {
    expect(validateBookingVisibility({ ...ok, preferences: "private" })).toBe(false);
  });
  it("rejects an unknown/garbage value on any field", () => {
    expect(validateBookingVisibility({ ...ok, perSong: "constructor" })).toBe(false);
  });
  it("rejects malformed types at runtime (untrusted onCall payload shapes)", () => {
    expect(validateBookingVisibility(null)).toBe(false);
    expect(validateBookingVisibility(undefined)).toBe(false);
    expect(validateBookingVisibility([])).toBe(false);
    expect(validateBookingVisibility("curators")).toBe(false);
    expect(validateBookingVisibility(42)).toBe(false);
  });
});

describe("sub-4 booking constants", () => {
  it("derives the runtime allowlist array backing the BookingStatus union", () => {
    expect(BOOKING_STATUSES).toEqual(["open", "confirmed", "completed", "declined", "withdrawn",
      "superseded", "expired", "cancelled_by_curator", "cancelled_by_musician"]);
  });
  it("locks the product caps from the spec", () => {
    expect(MAX_BOOKING_THREAD_ENTRIES).toBe(50);
    expect(MAX_OFFER_NOTE_LENGTH).toBe(280);
    expect(MAX_CANCEL_REASON_LENGTH).toBe(500);
    expect(MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE).toBe(25);
    expect(MAX_OFFER_AMOUNT_CENTS).toBe(10_000_000);
    expect(MAX_OFFER_SONG_COUNT).toBe(500);
    expect(DEPOSIT_PERCENT).toBe(35);
    expect(CURATOR_FORFEIT_WINDOW_HOURS).toBe(72);
    expect(MUSICIAN_MARK_WINDOW_HOURS).toBe(24);
    expect(MAX_RELIABILITY_MARKS).toBe(200);
    expect(NO_SHOW_REPORT_WINDOW_DAYS).toBe(14);
  });
});

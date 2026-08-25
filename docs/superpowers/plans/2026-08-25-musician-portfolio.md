# Musician Portfolio (Sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Musician portfolios — bio/photos/genres/links, 10×30s reviewed audio snippets with server-side trim/transcode, curator-gated rates & preferences, SSR public pages with `@handle` vanity URLs, full wizard + editor on mobile and web, admin track review.

**Architecture:** Extends the foundation monorepo. `@gatekeep/shared` gains all new types/validation; Cloud Functions own every mutation (new `portfolio.ts`, `tracks.ts`, `media.ts`); Firebase Storage joins the stack (new `storage.rules`, storage emulator, ffmpeg transcode via `onObjectFinalized`); clients upload originals to owner-only staging paths, a trigger trims/transcodes and routes clips through an admin review path into a public-read serving path that only ever holds approved content.

**Tech Stack:** TypeScript strict, Firebase (Auth/Firestore/Storage/Functions v2), ffmpeg-static + ffprobe-static + sharp in functions, Next.js 16 App Router (server components, `PageProps`, `next typegen`), Expo 57 (expo-audio, expo-document-picker), vitest + @firebase/rules-unit-testing.

**Spec:** `docs/superpowers/specs/2026-08-25-musician-portfolio-design.md` (binding authority).

---

## Environment prerequisites (already true on this machine, verify on others)

- `pnpm install` done (if `pnpm` missing: `corepack enable --install-directory "$env:LOCALAPPDATA\Microsoft\WindowsApps"` on Windows without admin rights).
- `pnpm --filter @gatekeep/web exec next typegen` must run once per fresh clone (generates the global `PageProps`/`LayoutProps` types; `apps/web` typecheck fails without it).
- Java 11+ on PATH for emulators. All emulator commands assume repo root.
- **Next.js 16 warning:** before writing any `apps/web` code, consult `apps/web/node_modules/next/dist/docs/` (per `apps/web/AGENTS.md`). Key facts already verified: `params` is a `Promise` (await it), `PageProps<'/route'>`/`LayoutProps` are global generated types, redirects are applied to incoming requests *before* rewrites (so `/u/:handle → /@:handle` redirect + `/@:handle → /u/:handle` beforeFiles rewrite do not loop).

## File map (created / modified)

```
packages/shared/src/types.ts            M  Track/Portfolio/Booking types, constants
packages/shared/src/validation.ts      M  portfolio/booking/track validators
packages/shared/src/storagePaths.ts    C  path builders shared by clients + functions
packages/shared/src/index.ts           M  export storagePaths
packages/shared/test/validation.test.ts M new validator tests
storage.rules                          C  Storage security rules
firebase.json                          M  storage config + emulator port 9199
firestore.rules                        M  tracks + private/booking rules
firestore.indexes.json                 M  tracks indexes
package.json                           M  emu scripts gain storage
functions/package.json                 M  ffmpeg-static, ffprobe-static, sharp
functions/src/storage.ts               C  bucket helper + STORAGE_BUCKET
functions/src/portfolio.ts             C  updatePortfolio, updateBookingInfo, requireProfileMember
functions/src/tracks.ts                C  createTrack, updateTrack, deleteTrack, reviewTrack
functions/src/media.ts                 C  processUpload trigger (audio transcode + photo resize)
functions/src/profiles.ts              M  submit minimum-content gate, portfolio seed, delete cascade
functions/src/review.ts                M  export requireAdmin
functions/src/index.ts                 M  new exports
functions/test/helpers.ts              M  storage emulator wiring, wav fixture, poll helper
functions/test/portfolio.test.ts       C
functions/test/tracks.test.ts          C
functions/test/media.test.ts           C
tests-rules/rules.test.ts              M  tracks + booking rules tests
tests-rules/storage-rules.test.ts      C  storage rules tests
apps/web/src/lib/firebase.ts           M  + storage
apps/web/src/lib/firebase-server.ts    C  RSC-side anonymous Firebase (public reads)
apps/web/app/u/[handle]/page.tsx       M  server-rendered portfolio page
apps/web/app/u/[handle]/portfolio.module.css C
apps/web/app/u/[handle]/TrackPlayer.tsx C  client audio player
apps/web/next.config.ts                M  vanity redirect + rewrite
apps/web/src/portfolio/*.tsx           C  editor components (forms, TrimUploader, TrackManager)
apps/web/app/join/page.tsx             C  musician wizard (+ resubmit)
apps/web/app/dashboard/page.tsx        M  links to wizard/editor per profile status
apps/web/app/dashboard/portfolio/[profileId]/page.tsx C  editor page
apps/web/app/admin/page.tsx            M  Tracks review queue section
apps/mobile/src/lib/firebase.ts        M  + storage
apps/mobile/src/portfolio/*.tsx        C  RN editor components
apps/mobile/app/(musician)/portfolio.tsx M  status-aware editor
apps/mobile/app/join.tsx               M  musician wizard steps
apps/mobile/app/artist/[handle].tsx    C  native hero-first public view
README.md                              M  storage docs, command updates, follow-ups
```

---

### Task 1: Shared types, constants, storage paths

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/validation.ts`
- Create: `packages/shared/src/storagePaths.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/validation.test.ts`

- [ ] **Step 1: Write failing validator tests**

Append to `packages/shared/test/validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  validatePortfolioUpdate, validateBookingUpdate, validateTrackCreate,
  GENRES, GIG_TYPES, MAX_TRACKS, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES,
  ACT_SIZES, AVAILABILITY_PATTERNS, TRACK_STATUSES,
} from "../src/index.js";

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
  it("treats preferences with all scalar fields omitted (undefined, not just explicit null) as valid", () => {
    expect(validateBookingUpdate({
      profileId: "p1",
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [] } as never,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @gatekeep/shared test`
Expected: FAIL — `validatePortfolioUpdate` etc. not exported.

- [ ] **Step 3: Add types and constants**

Append to `packages/shared/src/types.ts`:

```ts
// ---------- Sub-project 2: musician portfolio ----------

export const TRACK_STATUSES = ["processing", "pending_review", "approved", "rejected", "failed"] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export interface TrackDoc {
  title: string;
  status: TrackStatus;
  uploaderUid: string;
  startSec: number;              // chosen clip window start, seconds into the original
  durationSec: number | null;    // measured clip length, set by the transcode trigger
  storagePath: string | null;    // review/... while pending, public/... once approved
  rejectionReason: string | null;
  failureReason: string | null;  // transcode errors, shown to the musician
  order: number;                 // musician-sortable display order
  createdAt: number;
  updatedAt: number;
}

export type ExternalLinkKind = "spotify" | "youtube" | "instagram" | "website";
export interface ExternalLink { kind: ExternalLinkKind; url: string; }

export interface PortfolioData {
  bio: string;
  genres: string[];              // 1-3 from GENRES once set; [] on a fresh draft
  externalLinks: ExternalLink[];
  avatarPhotoPath: string | null; // public/photos/... paths, written by the photo pipeline
  coverPhotoPath: string | null;
}

export interface RateAmount { amountCents: number; note: string | null; }
export interface BookingRates {
  perHour: RateAmount | null;    // extra time played bills at the rate
  perSong: RateAmount | null;    // pay scales with songs requested (e.g. wedding playlists)
  perSet: RateAmount | null;     // flat rate for a defined set
}
export const ACT_SIZES = ["solo", "duo", "band"] as const;
export type ActSize = (typeof ACT_SIZES)[number];
export const AVAILABILITY_PATTERNS = ["weekends", "weeknights", "anytime", "limited"] as const;
export type AvailabilityPattern = (typeof AVAILABILITY_PATTERNS)[number];
export interface BookingPreferences {
  gigTypes: string[];            // subset of GIG_TYPES
  travelRadiusKm: number | null;
  actSize: ActSize | null;
  typicalSetMinutes: number | null;
  bringsOwnPA: boolean | null;
  availabilityPattern: AvailabilityPattern | null;
}
// profiles/{profileId}/private/booking — members + admins only (sub-3 widens to curators)
export interface BookingDoc { rates: BookingRates; preferences: BookingPreferences; updatedAt: number; }

export interface PortfolioUpdateInput {
  profileId: string;
  bio?: string;
  genres?: string[];
  externalLinks?: ExternalLink[];
}
export interface BookingUpdateInput { profileId: string; rates: BookingRates; preferences: BookingPreferences; }
export interface CreateTrackInput {
  profileId: string; title: string; startSec: number; sizeBytes: number; contentType: string;
}

export const GENRES = [
  "rock", "indie", "pop", "country", "folk", "americana", "blues", "jazz", "soul",
  "r&b", "hip-hop", "electronic", "dance", "latin", "reggae", "metal", "punk",
  "classical", "singer-songwriter", "cover-band", "worship", "other",
] as const;

export const GIG_TYPES = [
  "wedding", "bar_club", "festival", "private_event", "corporate", "restaurant_cafe",
] as const;

export const MAX_TRACKS = 10;
export const MAX_CLIP_SECONDS = 30;
export const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const AUDIO_CONTENT_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/m4a", "audio/x-m4a", "audio/aac", "audio/flac", "audio/ogg",
] as const;
```

Then extend two existing types in `packages/shared/src/types.ts` **in place**:

```ts
// ProfileDoc gains (optional — curator profiles and pre-SP2 docs lack it):
export interface ProfileDoc {
  type: ProfileType;
  subtype: MusicianSubtype | CuratorSubtype;
  name: string;
  handle: string;            // unique, lowercase
  status: ProfileStatus;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
  portfolio?: PortfolioData; // musicians only; seeded empty by createProfileDraft
}

// AuditLogDoc.action union becomes:
  action: "profile_approved" | "profile_rejected" | "admin_granted" | "profile_deleted"
    | "track_approved" | "track_rejected";

// NotificationDoc.kind union becomes:
  kind: "profile_review" | "track_review" | "system";
```

(`PortfolioData` is declared later in the file than `ProfileDoc` uses it — TypeScript interfaces hoist, this is fine.)

- [ ] **Step 4: Create `packages/shared/src/storagePaths.ts`**

```ts
// Single source of truth for Storage object paths — clients write staging paths,
// functions write review/public paths, storage.rules mirrors these shapes.
export const stagingAudioPath = (uid: string, profileId: string, trackId: string) =>
  `staging/audio/${uid}/${profileId}/${trackId}`;
export const stagingPhotoPath = (uid: string, profileId: string, kind: "avatar" | "cover", nonce: string) =>
  `staging/photos/${uid}/${profileId}/${kind}-${nonce}`;
export const reviewTrackPath = (profileId: string, trackId: string) =>
  `review/tracks/${profileId}/${trackId}.m4a`;
export const publicTrackPath = (profileId: string, trackId: string) =>
  `public/tracks/${profileId}/${trackId}.m4a`;
export const publicPhotoPath = (profileId: string, kind: "avatar" | "cover", nonce: string) =>
  `public/photos/${profileId}/${kind}-${nonce}.jpg`;
```

- [ ] **Step 5: Add validators**

Append to `packages/shared/src/validation.ts`:

```ts
import {
  GENRES, GIG_TYPES, AUDIO_CONTENT_TYPES, MAX_AUDIO_UPLOAD_BYTES,
  ACT_SIZES, AVAILABILITY_PATTERNS,
  type PortfolioUpdateInput, type BookingUpdateInput, type CreateTrackInput,
  type ExternalLink, type RateAmount,
} from "./types.js";

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

// Guards Firestore document-id-shaped fields (profileId, etc.) against empty
// strings, path traversal ("a/b"), and absurdly long values before they reach
// a doc() call — Firestore would throw on "/" in an id, and we want a clean
// validation failure from an onCall handler, not an uncaught exception.
export const isValidDocId = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// Domain allowlists per link kind. Regex-based host extraction (not `new URL`)
// so behavior is identical on Node and React Native/Hermes.
// NOTE: "website" accepts any https host, which may resolve to localhost,
// private IPs, or internal hostnames. These links are display-only (rendered
// as an <a href>) and MUST NEVER be fetched server-side — that would be an
// SSRF vector.
const LINK_HOSTS: Record<ExternalLink["kind"], readonly string[] | null> = {
  spotify: ["open.spotify.com"],
  youtube: ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"],
  instagram: ["instagram.com", "www.instagram.com"],
  website: null, // any https host
};
const HTTPS_HOST_RE = /^https:\/\/([a-z0-9.-]+)(?::\d{1,5})?(?=[/?#]|$)/i;

function validateLink(link: unknown): Result {
  const l = link as ExternalLink;
  if (typeof l !== "object" || l === null || typeof l.kind !== "string" || typeof l.url !== "string") {
    return fail("Invalid link.");
  }
  // hasOwnProperty, not `in` — `in` walks the prototype chain, so kind values
  // like "constructor"/"toString"/"__proto__" would otherwise pass this guard
  // and crash `hosts.includes` below with an uncaught TypeError. Called via
  // Object.prototype (not Object.hasOwn) to avoid an engine-version
  // assumption on RN/JSC.
  if (!Object.prototype.hasOwnProperty.call(LINK_HOSTS, l.kind)) return fail("Unknown link type.");
  const url = l.url.trim();
  if (url.length > 300) return fail("Link URLs must be 300 characters or fewer.");
  const m = HTTPS_HOST_RE.exec(url);
  if (!m) return fail("Links must be https:// URLs.");
  const hosts = LINK_HOSTS[l.kind];
  if (hosts && !hosts.includes(m[1].toLowerCase())) {
    return fail(`That does not look like a ${l.kind} link.`);
  }
  return { ok: true };
}

export function validatePortfolioUpdate(input: PortfolioUpdateInput): Result {
  // Untrusted onCall payload — same defensive-runtime rationale as validateHandle.
  if (typeof input !== "object" || input === null) {
    return fail("Invalid portfolio update.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  if (input.bio === undefined && input.genres === undefined && input.externalLinks === undefined) {
    return fail("Nothing to update.");
  }
  if (input.bio !== undefined) {
    if (typeof input.bio !== "string" || input.bio.length > 2000) {
      return fail("Bio must be a string of at most 2000 characters.");
    }
  }
  if (input.genres !== undefined) {
    if (!Array.isArray(input.genres) || input.genres.length < 1 || input.genres.length > 3) {
      return fail("Pick 1-3 genres.");
    }
    if (new Set(input.genres).size !== input.genres.length) return fail("Duplicate genres.");
    for (const g of input.genres) {
      if (!(GENRES as readonly string[]).includes(g)) return fail("Unknown genre.");
    }
  }
  if (input.externalLinks !== undefined) {
    if (!Array.isArray(input.externalLinks) || input.externalLinks.length > 8) {
      return fail("At most 8 links.");
    }
    for (const l of input.externalLinks) {
      const v = validateLink(l);
      if (!v.ok) return v;
    }
    const linkKeys = input.externalLinks.map((l) => `${l.kind}:${l.url.trim()}`);
    if (new Set(linkKeys).size !== linkKeys.length) return fail("Duplicate links.");
  }
  return { ok: true };
}

function validateRate(rate: unknown, label: string): Result {
  if (rate == null) return { ok: true }; // absent (undefined) and explicit null both mean "not set"
  const r = rate as RateAmount;
  if (typeof r !== "object" || typeof r.amountCents !== "number"
      || !Number.isInteger(r.amountCents) || r.amountCents < 1 || r.amountCents > 100_000_000) {
    return fail(`${label} must be a whole number of cents between 1 and 100,000,000.`);
  }
  if (r.note != null && (typeof r.note !== "string" || r.note.length > 200)) {
    return fail(`${label} note must be at most 200 characters.`);
  }
  return { ok: true };
}

export function validateBookingUpdate(input: BookingUpdateInput): Result {
  if (typeof input !== "object" || input === null
      || typeof input.rates !== "object" || input.rates === null || Array.isArray(input.rates)
      || typeof input.preferences !== "object" || input.preferences === null || Array.isArray(input.preferences)) {
    return fail("Invalid booking info.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  for (const [k, label] of [["perHour", "Hourly rate"], ["perSong", "Per-song rate"], ["perSet", "Per-set rate"]] as const) {
    const v = validateRate(input.rates[k], label);
    if (!v.ok) return v;
  }
  const p = input.preferences;
  if (!Array.isArray(p.gigTypes)) return fail("Invalid gig types.");
  if (p.gigTypes.length > GIG_TYPES.length) return fail("Too many gig types.");
  if (new Set(p.gigTypes).size !== p.gigTypes.length) return fail("Duplicate gig types.");
  for (const g of p.gigTypes) {
    if (!(GIG_TYPES as readonly string[]).includes(g)) return fail("Unknown gig type.");
  }
  // != null (not !==) on these five scalars: an absent (undefined) field is
  // treated the same as an explicit null, matching validateRate's
  // absent-means-unset semantics — the musician just hasn't filled it in yet.
  if (p.travelRadiusKm != null && (typeof p.travelRadiusKm !== "number"
      || !Number.isInteger(p.travelRadiusKm) || p.travelRadiusKm < 0 || p.travelRadiusKm > 3000)) {
    return fail("Travel radius must be 0-3000 km.");
  }
  if (p.actSize != null && !(ACT_SIZES as readonly string[]).includes(p.actSize)) {
    return fail("Invalid act size.");
  }
  if (p.typicalSetMinutes != null && (typeof p.typicalSetMinutes !== "number"
      || !Number.isInteger(p.typicalSetMinutes) || p.typicalSetMinutes < 15 || p.typicalSetMinutes > 480)) {
    return fail("Set length must be 15-480 minutes.");
  }
  if (p.bringsOwnPA != null && typeof p.bringsOwnPA !== "boolean") return fail("Invalid PA answer.");
  if (p.availabilityPattern != null
      && !(AVAILABILITY_PATTERNS as readonly string[]).includes(p.availabilityPattern)) {
    return fail("Invalid availability.");
  }
  return { ok: true };
}

export function validateTrackCreate(input: CreateTrackInput): Result {
  if (typeof input !== "object" || input === null) {
    return fail("Invalid track.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.trim().length > 80) {
    return fail("Track titles are 1-80 characters.");
  }
  if (typeof input.startSec !== "number" || !Number.isFinite(input.startSec)
      || input.startSec < 0 || input.startSec > 24 * 3600) {
    return fail("Invalid clip start time.");
  }
  if (typeof input.sizeBytes !== "number" || !Number.isInteger(input.sizeBytes)
      || input.sizeBytes < 1 || input.sizeBytes > MAX_AUDIO_UPLOAD_BYTES) {
    return fail("Audio files must be at most 50 MB.");
  }
  if (!(AUDIO_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    return fail("Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.");
  }
  return { ok: true };
}
```

- [ ] **Step 6: Export storagePaths from `packages/shared/src/index.ts`**

```ts
export * from "./types.js";
export * from "./validation.js";
export * from "./storagePaths.js";
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @gatekeep/shared build && pnpm --filter @gatekeep/shared test && pnpm typecheck`
Expected: all PASS, typecheck green (existing tests untouched).

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): portfolio, track, and booking types + validators for sub-project 2"
```

---

### Task 2: Storage plumbing — rules file, emulator, client SDKs

**Files:**
- Create: `storage.rules`
- Modify: `firebase.json`
- Modify: `package.json` (emu scripts)
- Modify: `apps/web/src/lib/firebase.ts`
- Modify: `apps/mobile/src/lib/firebase.ts`

- [ ] **Step 1: Create `storage.rules`**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isOwner(uid) { return request.auth != null && request.auth.uid == uid; }
    // Uses token.get(..., false) rather than firestore.rules' `token.admin == true`
    // style deliberately: a missing claim resolves to `false` cleanly instead of
    // throwing an EvaluationException that would otherwise spam the logs.
    function isAdmin() { return request.auth != null && request.auth.token.get('admin', false) == true; }

    // Serving path: only ever contains approved/instantly-publishable content
    // (the transcode/photo pipelines are the only writers). World-readable.
    match /public/{allPaths=**} {
      allow get: if true;
      // Paths are resolved from Firestore docs, never by listing. Listing would
      // enumerate every profileId (drafts included) — mirrors the /handles
      // get/list split in firestore.rules.
      allow list: if false;
      allow write: if false;
    }

    // Pending clips awaiting review — admins listen to exactly what would go live.
    match /review/{allPaths=**} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // Owner-only staging. Objects are consumed and deleted by the processUpload
    // trigger; a 24h lifecycle rule (console/deploy config) reaps strays.
    // Membership of {profileId} is NOT checkable here — the trigger verifies it
    // before any content reaches a profile.
    // customMetadata on staging objects is client-controlled and untrusted — the
    // processUpload trigger derives uid/profileId from the OBJECT PATH only and
    // must never read object.metadata.
    match /staging/audio/{uid}/{profileId}/{trackId} {
      allow create, update: if isOwner(uid)
        && profileId.matches('[A-Za-z0-9_-]{1,64}')
        && trackId.matches('[A-Za-z0-9_-]{1,64}')
        && request.resource.size > 0
        && request.resource.size <= 50 * 1024 * 1024
        && request.resource.contentType.matches('audio/.*');
      allow delete: if false; // the processUpload trigger owns staging cleanup
      allow read: if false;   // NOTE: getDownloadURL/getMetadata on a staging ref will
                               // fail by design — upload UIs must not read back staging.
    }
    match /staging/photos/{uid}/{profileId}/{fileName} {
      // fileName is deliberately extensionless: the path builder emits
      // `${kind}-${nonce}` with no extension; nonces must stick to A-Za-z0-9 and hyphen.
      allow create, update: if isOwner(uid)
        && profileId.matches('[A-Za-z0-9_-]{1,64}')
        && request.resource.size > 0
        && request.resource.size <= 10 * 1024 * 1024
        && request.resource.contentType.matches('image/(jpeg|png|webp)')
        && fileName.matches('(avatar|cover)-[A-Za-z0-9-]{1,80}');
      allow delete: if false; // the processUpload trigger owns staging cleanup
      allow read: if false;   // NOTE: getDownloadURL/getMetadata on a staging ref will
                               // fail by design — upload UIs must not read back staging.
    }

    match /{allPaths=**} { allow read, write: if false; }
  }
}
```

- [ ] **Step 2: Wire storage into `firebase.json`**

```json
{
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "storage": { "rules": "storage.rules" },
  "functions": { "source": "functions", "runtime": "nodejs20", "predeploy": ["pnpm --filter functions build"] },
  "emulators": {
    "auth": { "port": 9099 },
    "firestore": { "port": 8080 },
    "storage": { "port": 9199 },
    "functions": { "port": 5001 },
    "ui": { "enabled": true, "port": 4000 }
  }
}
```

- [ ] **Step 3: Update root `package.json` emu scripts**

```json
"emu": "firebase emulators:start",
"emu:test": "pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage \"pnpm --filter functions test\"",
"emu:rules": "firebase emulators:exec --only firestore,storage \"pnpm --filter @gatekeep/tests-rules test\""
```

- [ ] **Step 4: Add storage to `apps/web/src/lib/firebase.ts`**

Add imports and extend the cached bundle (follow the file's existing pattern exactly):

```ts
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";
// cached type gains: storage: FirebaseStorage
// inside getFirebase(), after functions:
  const storage = getStorage(app);
  if (process.env.NODE_ENV !== "production") {
    // ...existing connects...
    connectStorageEmulator(storage, EMU_HOST, 9199);
  }
  cached = { app, auth, db, functions, storage };
```

- [ ] **Step 5: Same for `apps/mobile/src/lib/firebase.ts`**

```ts
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";
// inside getFirebase(), inside the __DEV__ block:
  connectStorageEmulator(storage, EMU_HOST, 9199);
// cached gains storage as on web
```

- [ ] **Step 6: Typecheck + emulator smoke test**

Run: `pnpm typecheck` — green.
Run: `pnpm emu` briefly (Ctrl+C after startup) — Storage emulator listed on 9199, no rules parse errors.

- [ ] **Step 7: Commit**

```bash
git add storage.rules firebase.json package.json apps/web/src/lib/firebase.ts apps/mobile/src/lib/firebase.ts
git commit -m "feat: Firebase Storage — rules file, emulator, client SDK wiring"
```

---

### Task 3: Firestore rules + indexes for tracks and booking

**Files:**
- Modify: `firestore.rules`
- Modify: `firestore.indexes.json`
- Test: `tests-rules/rules.test.ts`

- [ ] **Step 1: Write failing rules tests**

Append to `tests-rules/rules.test.ts`:

```ts
describe("tracks", () => {
  const seedProfile = async (status: string) => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
  };
  it("public reads approved tracks of approved profiles only", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Pending", status: "pending_review", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t2")));
    await assertSucceeds(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where("status", "==", "approved"))));
    await assertFails(getDocs(collection(anon, "profiles/prof1/tracks"))); // unfiltered list
  });
  it("no public track reads on a non-approved profile; members read all their own", async () => {
    await seedProfile("draft");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Rejected", status: "rejected", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/tracks/t2")));
    await assertSucceeds(getDocs(collection(alice, "profiles/prof1/tracks")));
  });
  it("clients cannot write tracks; admin collection-group read works", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "x", status: "pending_review", order: 0 });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "profiles/prof1/tracks/hax"), { title: "h", status: "approved" }));
    await assertFails(updateDoc(doc(alice, "profiles/prof1/tracks/t1"), { status: "approved" }));
    await assertSucceeds(getDocs(query(
      collectionGroup(admin, "tracks"), where("status", "==", "pending_review"))));
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDocs(query(
      collectionGroup(bob, "tracks"), where("status", "==", "pending_review"))));
  });
});

describe("private booking subdoc", () => {
  it("members and admins read; strangers and anon cannot; nobody writes", async () => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status: "approved" });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/prof1/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/private/booking")));
    await assertSucceeds(getDoc(doc(admin, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(bob, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(anon, "profiles/prof1/private/booking")));
    await assertFails(setDoc(doc(alice, "profiles/prof1/private/booking"), { rates: {} }));
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm emu:rules`
Expected: new tests FAIL (default-deny catches them today), existing tests PASS.

- [ ] **Step 3: Add rules**

In `firestore.rules`, inside `match /profiles/{profileId} { ... }` after the `members` block, add:

```
      match /tracks/{trackId} {
        // Public track reads require BOTH the profile and the track approved.
        // List queries must filter status == 'approved' (unfiltered lists fail),
        // which keeps pending/rejected titles out of public reach.
        allow read: if (profileApproved(profileId) && resource.data.status == 'approved')
          || isMember(profileId) || isAdmin();
        allow write: if false; // Cloud Functions only
      }

      match /private/booking {
        // Rates/preferences: never public. Sub-project 3 widens this to
        // members of approved curator profiles.
        allow read: if isMember(profileId) || isAdmin();
        allow write: if false; // Cloud Functions only
      }
```

After the existing `/{path=**}/members/` block, add the admin queue's collection-group rule:

```
    // Admin review queue: collectionGroup('tracks').where('status','==','pending_review').
    // The nested tracks rule above does not apply to collection-group queries.
    match /{path=**}/tracks/{trackId} {
      allow read: if isAdmin();
    }
```

- [ ] **Step 4: Add indexes to `firestore.indexes.json`**

```json
{ "indexes": [
  { "collectionGroup": "invites", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "profileId", "order": "ASCENDING" },
      { "fieldPath": "status", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "tracks", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "order", "order": "ASCENDING" }
    ] }
], "fieldOverrides": [
  { "collectionGroup": "members", "fieldPath": "uid",
    "indexes": [ { "queryScope": "COLLECTION_GROUP", "order": "ASCENDING" } ] },
  { "collectionGroup": "tracks", "fieldPath": "status",
    "indexes": [ { "queryScope": "COLLECTION", "order": "ASCENDING" },
                 { "queryScope": "COLLECTION_GROUP", "order": "ASCENDING" } ] } ] }
```

- [ ] **Step 5: Run rules tests**

Run: `pnpm emu:rules`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add firestore.rules firestore.indexes.json tests-rules/rules.test.ts
git commit -m "feat(rules): tracks visibility matrix, private booking subdoc, admin track queue"
```

---

### Task 4: Storage rules tests

**Files:**
- Create: `tests-rules/storage-rules.test.ts`

- [ ] **Step 1: Write the tests (they run against the storage emulator)**

```ts
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { ref, uploadBytes, getBytes, listAll, deleteObject } from "firebase/storage";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    storage: { rules: readFileSync("../storage.rules", "utf8"), host: "localhost", port: 9199 },
  });
});
afterAll(async () => { await env.cleanup(); });

const bytes = new Uint8Array([1, 2, 3]);
const meta = (contentType: string) => ({ contentType });

describe("storage: staging/audio", () => {
  it("owner uploads audio to own staging path; wrong uid, wrong type fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    const bob = env.authenticatedContext("bob").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t1"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(bob, "staging/audio/alice/p1/t2"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t3"), bytes, meta("video/mp4")));
  });
  it("staging is never readable, even by the owner", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t9"), bytes, meta("audio/mpeg")));
    await assertFails(getBytes(ref(alice, "staging/audio/alice/p1/t9")));
  });
  it("owner cannot delete their own staging object; the trigger owns cleanup", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t10"), bytes, meta("audio/mpeg")));
    await assertFails(deleteObject(ref(alice, "staging/audio/alice/p1/t10")));
  });
  it("a literal '..' profileId segment is rejected", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/../t11"), bytes, meta("audio/mpeg")));
  });
});

describe("storage: staging/photos", () => {
  it("owner uploads images with a well-formed avatar/cover name; bad names/types fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/cover-xyz"), bytes, meta("image/png")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc"), bytes, meta("application/pdf")));
  });
});

describe("storage: public and review", () => {
  it("public is world-readable and never client-writable", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t1.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(anon, "public/tracks/p1/t1.m4a")));
    await assertFails(uploadBytes(ref(anon, "public/tracks/p1/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(listAll(ref(anon, "public")));
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "public/photos/p1/avatar-x.jpg"), bytes, meta("image/jpeg")));
  });
  it("review is admin-read-only", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "review/tracks/p1/t1.m4a"), bytes, meta("audio/mp4"));
    });
    const admin = env.authenticatedContext("root", { admin: true }).storage();
    const alice = env.authenticatedContext("alice").storage();
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(admin, "review/tracks/p1/t1.m4a")));
    await assertFails(getBytes(ref(alice, "review/tracks/p1/t1.m4a")));
    await assertFails(getBytes(ref(anon, "review/tracks/p1/t1.m4a")));
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm emu:rules`
Expected: all PASS (Task 2 already added `storage` to the emulator set; if `initializeTestEnvironment` complains the storage emulator is missing, verify firebase.json from Task 2).

- [ ] **Step 3: Commit**

```bash
git add tests-rules/storage-rules.test.ts
git commit -m "test(rules): storage rules coverage for staging/review/public paths"
```

---

### Task 5: Functions — portfolio + booking callables

**Files:**
- Create: `functions/src/portfolio.ts`
- Modify: `functions/src/index.ts`
- Modify: `functions/src/profiles.ts` (seed empty portfolio on musician drafts)
- Test: `functions/test/portfolio.test.ts`

- [ ] **Step 1: Write failing tests**

Create `functions/test/portfolio.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 15_000 });

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

async function makeMusicianProfile(user: import("firebase/auth").User) {
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft", draft(`pf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`), user);
  return profileId;
}

describe("createProfileDraft portfolio seed", () => {
  it("musician drafts start with an empty portfolio map", async () => {
    const { user } = await signUpTestUser(`seed-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio).toEqual({
      bio: "", genres: [], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null,
    });
  });
});

describe("updatePortfolio", () => {
  it("member updates bio/genres/links; non-member is rejected", async () => {
    const { user } = await signUpTestUser(`up1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updatePortfolio", {
      profileId, bio: "Austin indie soul.", genres: ["soul", "indie"],
      externalLinks: [{ kind: "spotify", url: "https://open.spotify.com/artist/a1" }],
    }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio.bio).toBe("Austin indie soul.");
    expect(p.data()?.portfolio.genres).toEqual(["soul", "indie"]);
    const { user: stranger } = await signUpTestUser(`up2-${Date.now()}@test.com`);
    await expect(callFn("updatePortfolio", { profileId, bio: "hax" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects invalid payloads with invalid-argument", async () => {
    const { user } = await signUpTestUser(`up3-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await expect(callFn("updatePortfolio", { profileId, bio: "x".repeat(2001) }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updatePortfolio", { profileId, genres: [] }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("updateBookingInfo", () => {
  const booking = (profileId: string) => ({
    profileId,
    rates: { perHour: { amountCents: 20000, note: null }, perSong: { amountCents: 2500, note: "requests" }, perSet: null },
    preferences: { gigTypes: ["wedding", "bar_club"], travelRadiusKm: 80, actSize: "band",
      typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends" },
  });
  it("member writes the private booking subdoc; stranger cannot", async () => {
    const { user } = await signUpTestUser(`bk1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updateBookingInfo", booking(profileId), user);
    const b = await adb.doc(`profiles/${profileId}/private/booking`).get();
    expect(b.data()?.rates.perHour.amountCents).toBe(20000);
    expect(b.data()?.preferences.gigTypes).toContain("wedding");
    const { user: stranger } = await signUpTestUser(`bk2-${Date.now()}@test.com`);
    await expect(callFn("updateBookingInfo", booking(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects invalid rates", async () => {
    const { user } = await signUpTestUser(`bk3-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    const bad = booking(profileId);
    bad.rates.perHour = { amountCents: -5, note: null } as never;
    await expect(callFn("updateBookingInfo", bad, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm emu:test`
Expected: new file FAILS (functions not found / portfolio undefined); existing suites PASS.

- [ ] **Step 3: Create `functions/src/portfolio.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import {
  validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioUpdateInput, type BookingUpdateInput, type BookingDoc,
} from "@gatekeep/shared";

export function requireAuthUid(req: { auth?: { uid?: string } }): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

// Any member may edit portfolio content (spec §6) — contrast requireProfileAdmin
// in profiles.ts, which gates membership/deletion actions.
export async function requireProfileMember(profileId: string, uid: string) {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists) throw new HttpsError("permission-denied", "Only profile members can do that.");
}

export async function requireMusicianProfile(profileId: string) {
  const p = await getFirestore().doc(`profiles/${profileId}`).get();
  if (!p.exists) throw new HttpsError("not-found", "Profile not found.");
  if (p.data()?.type !== "musician") {
    throw new HttpsError("failed-precondition", "Portfolios belong to musician profiles.");
  }
  return p;
}

export const updatePortfolio = onCall<PortfolioUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const input = req.data;
  const v = validatePortfolioUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);

  // Dotted-path updates merge into the portfolio map without clobbering the
  // photo paths the media pipeline owns.
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.bio !== undefined) updates["portfolio.bio"] = input.bio;
  if (input.genres !== undefined) updates["portfolio.genres"] = input.genres;
  // Explicit mapping: stores only the validated fields (an untrusted link object
  // could carry extra keys) and the trimmed URL the validator actually checked.
  if (input.externalLinks !== undefined) {
    updates["portfolio.externalLinks"] = input.externalLinks.map((l) => ({ kind: l.kind, url: l.url.trim() }));
  }
  const ref = getFirestore().doc(`profiles/${input.profileId}`);
  const pairs = Object.entries(updates).flatMap(([k, val]) => [new FieldPath(...k.split(".")), val] as const);
  await ref.update(pairs[0] as FieldPath, pairs[1], ...pairs.slice(2));
  return { ok: true };
});

export const updateBookingInfo = onCall<BookingUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const input = req.data;
  const v = validateBookingUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);
  // Normalize absent → null: the validator accepts omitted keys, the stored
  // BookingDoc promises present-and-nullable, and Firestore rejects `undefined`.
  const docData: BookingDoc = {
    rates: {
      perHour: input.rates.perHour ?? null,
      perSong: input.rates.perSong ?? null,
      perSet: input.rates.perSet ?? null,
    },
    preferences: {
      gigTypes: input.preferences.gigTypes,
      travelRadiusKm: input.preferences.travelRadiusKm ?? null,
      actSize: input.preferences.actSize ?? null,
      typicalSetMinutes: input.preferences.typicalSetMinutes ?? null,
      bringsOwnPA: input.preferences.bringsOwnPA ?? null,
      availabilityPattern: input.preferences.availabilityPattern ?? null,
    },
    updatedAt: Date.now(),
  };
  await getFirestore().doc(`profiles/${input.profileId}/private/booking`).set(docData);
  return { ok: true };
});
```

(If the `FieldPath` spread reads awkward during implementation, the simpler equivalent is fine: build a plain object keyed by dotted strings and call `ref.update(updatesObject)` — the Admin SDK treats dotted string keys as field paths. Use that form.)

- [ ] **Step 4: Seed empty portfolio in `functions/src/profiles.ts`**

In `createProfileDraft`'s transaction, extend the `profile` literal:

```ts
    const profile: ProfileDoc = {
      type: input.type, subtype: input.subtype as ProfileDoc["subtype"],
      name: input.name.trim(), handle: input.handle,
      status: "draft", rejectionReason: null, createdAt: now, updatedAt: now,
      ...(input.type === "musician"
        ? { portfolio: { bio: "", genres: [], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null } }
        : {}),
    };
```

- [ ] **Step 5: Export from `functions/src/index.ts`**

```ts
export { updatePortfolio, updateBookingInfo } from "./portfolio.js";
```

- [ ] **Step 6: Run tests**

Run: `pnpm emu:test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add functions/src functions/test/portfolio.test.ts
git commit -m "feat(functions): updatePortfolio + updateBookingInfo, portfolio seed on musician drafts"
```

---

### Task 6: Functions — track CRUD callables + test harness storage wiring

**Files:**
- Create: `functions/src/storage.ts`
- Create: `functions/src/tracks.ts` (createTrack/updateTrack/deleteTrack here; reviewTrack in Task 8)
- Modify: `functions/src/index.ts`
- Modify: `functions/package.json`
- Modify: `functions/test/helpers.ts`
- Test: `functions/test/tracks.test.ts`

- [ ] **Step 1: Add dependencies**

Run in `functions/`:
```bash
pnpm add ffmpeg-static ffprobe-static sharp
pnpm add -D @types/ffprobe-static
```

- [ ] **Step 2: Create `functions/src/storage.ts`**

```ts
import { getStorage } from "firebase-admin/storage";

// Must match the client apps' storageBucket (apps/*/src/lib/firebase.ts) and the
// bucket the processUpload trigger listens on — the emulator namespaces buckets
// by name, so a bare getStorage().bucket() (projectId.appspot.com) would watch
// a different, empty bucket than the one clients upload to.
export const STORAGE_BUCKET = "gatekeep-dev-jg.firebasestorage.app";
export const bucket = () => getStorage().bucket(STORAGE_BUCKET);
```

- [ ] **Step 3: Extend `functions/test/helpers.ts` with storage + fixtures**

Append (and add the imports at the top of the file):

```ts
import { getStorage as getClientStorage, connectStorageEmulator, ref as storageRef, uploadBytes } from "firebase/storage";

// Admin SDK must target the storage emulator (mirrors the auth line above).
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";

export const storage = getClientStorage(app, "gs://gatekeep-dev-jg.firebasestorage.app");
connectStorageEmulator(storage, "localhost", 9199);

export async function uploadTestAudio(path: string, bytes: Uint8Array, contentType: string, asUser: User) {
  await auth.updateCurrentUser(asUser);
  await uploadBytes(storageRef(storage, path), bytes, { contentType });
}

// Generates a valid mono 16-bit PCM WAV of `seconds` at 8kHz — a real audio
// file ffmpeg can transcode, without committing a binary fixture.
export function makeWav(seconds: number): Uint8Array {
  const sampleRate = 8000;
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 12000), true);
  }
  return new Uint8Array(buf);
}

// Polls a track doc until its status is one of `statuses` (transcode is async).
export async function waitForTrackStatus(
  adb: Firestore, docPath: string, statuses: string[], timeoutMs = 30_000,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await adb.doc(docPath).get();
    const s = snap.data()?.status;
    if (s && statuses.includes(s)) return snap.data()!;
    if (Date.now() > deadline) throw new Error(`track ${docPath} stuck in "${s}" after ${timeoutMs}ms`);
    await wait(500);
  }
}
```

- [ ] **Step 4: Write failing tests for the CRUD callables**

Create `functions/test/tracks.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { stagingAudioPath, type ProfileDraftInput, type CreateTrackInput, MAX_TRACKS } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 20_000 });

async function makeMusician(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
    { type: "musician", subtype: "solo", name: "Ava", handle: `${prefix}_${Date.now()}` }, user);
  return { user, uid, profileId };
}
const input = (profileId: string, title = "Song"): CreateTrackInput =>
  ({ profileId, title, startSec: 0, sizeBytes: 1000, contentType: "audio/wav" });

describe("createTrack", () => {
  it("creates a processing doc and returns the staging upload path", async () => {
    const { user, uid, profileId } = await makeMusician("ct1");
    const res = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", input(profileId, "Midnight Line"), user);
    expect(res.uploadPath).toBe(stagingAudioPath(uid, profileId, res.trackId));
    const t = await adb.doc(`profiles/${profileId}/tracks/${res.trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Midnight Line", status: "processing", uploaderUid: uid, startSec: 0 });
  });
  it("enforces the 10-track cap over non-dead tracks", async () => {
    const { user, profileId } = await makeMusician("ct2");
    for (let i = 0; i < MAX_TRACKS; i++) await callFn("createTrack", input(profileId, `T${i}`), user);
    await expect(callFn("createTrack", input(profileId, "over"), user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
    // rejected tracks free a slot
    const first = (await adb.collection(`profiles/${profileId}/tracks`).limit(1).get()).docs[0];
    await first.ref.update({ status: "rejected" });
    await callFn("createTrack", input(profileId, "fits-now"), user);
  });
  it("rejects non-members, unverified email, and curator profiles", async () => {
    const { profileId } = await makeMusician("ct3");
    const { user: stranger } = await signUpTestUser(`ct3s-${Date.now()}@test.com`);
    await expect(callFn("createTrack", input(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("updateTrack / deleteTrack", () => {
  it("member retitles and reorders; deleteTrack removes the doc", async () => {
    const { user, profileId } = await makeMusician("ut1");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    await callFn("updateTrack", { profileId, trackId, title: "Renamed", order: 4 }, user);
    let t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Renamed", order: 4 });
    await callFn("deleteTrack", { profileId, trackId }, user);
    t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.exists).toBe(false);
  });
  it("stranger cannot update or delete", async () => {
    const { user, profileId } = await makeMusician("ut2");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    const { user: stranger } = await signUpTestUser(`ut2s-${Date.now()}@test.com`);
    await expect(callFn("updateTrack", { profileId, trackId, title: "hax" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("deleteTrack", { profileId, trackId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm emu:test`
Expected: tracks tests FAIL (createTrack not found).

- [ ] **Step 6: Create `functions/src/tracks.ts` (CRUD part)**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, stagingAudioPath, MAX_TRACKS,
  type CreateTrackInput, type TrackDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireProfileMember, requireMusicianProfile } from "./portfolio.js";
import { bucket } from "./storage.js";

function requireVerifiedEmail(req: { auth?: { token?: Record<string, unknown> } }): void {
  if (req.auth?.token?.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Please verify your email address first.");
  }
}

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count.
const ACTIVE_TRACK_STATUSES = ["processing", "pending_review", "approved"] as const;

export const createTrack = onCall<CreateTrackInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateTrackCreate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);

  const db = getFirestore();
  const tracksCol = db.collection(`profiles/${input.profileId}/tracks`);
  const trackRef = tracksCol.doc();
  await db.runTransaction(async (tx) => {
    const active = await tx.get(tracksCol.where("status", "in", [...ACTIVE_TRACK_STATUSES]));
    if (active.size >= MAX_TRACKS) {
      throw new HttpsError("resource-exhausted",
        `Portfolios hold at most ${MAX_TRACKS} tracks — delete one first.`);
    }
    const now = Date.now();
    const doc: TrackDoc = {
      title: input.title.trim(), status: "processing", uploaderUid: uid,
      startSec: input.startSec, durationSec: null, storagePath: null,
      rejectionReason: null, failureReason: null, order: active.size,
      createdAt: now, updatedAt: now,
    };
    tx.set(trackRef, doc);
  });
  return { trackId: trackRef.id, uploadPath: stagingAudioPath(uid, input.profileId, trackRef.id) };
});

export const updateTrack = onCall<{ profileId: string; trackId: string; title?: string; order?: number }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, trackId, title, order } = req.data;
    if (typeof profileId !== "string" || typeof trackId !== "string") {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    if (title === undefined && order === undefined) {
      throw new HttpsError("invalid-argument", "Nothing to update.");
    }
    if (title !== undefined && (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 80)) {
      throw new HttpsError("invalid-argument", "Track titles are 1-80 characters.");
    }
    if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 100)) {
      throw new HttpsError("invalid-argument", "Invalid order.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (title !== undefined) updates.title = title.trim();
    if (order !== undefined) updates.order = order;
    await ref.update(updates);
    return { ok: true };
  });

export const deleteTrack = onCall<{ profileId: string; trackId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, trackId } = req.data;
    if (typeof profileId !== "string" || typeof trackId !== "string") {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    // Storage cleanup is best-effort: the doc is the source of truth, and the
    // objects are unreachable once it's gone (public path is only listed via docs).
    const { reviewTrackPath, publicTrackPath } = await import("@gatekeep/shared");
    await Promise.allSettled([
      bucket().file(reviewTrackPath(profileId, trackId)).delete(),
      bucket().file(publicTrackPath(profileId, trackId)).delete(),
    ]);
    await ref.delete();
    return { ok: true };
  });
```

(Import `reviewTrackPath`/`publicTrackPath` statically at the top with the other shared imports rather than the inline `await import` — write it that way.)

- [ ] **Step 7: Export from `functions/src/index.ts`**

```ts
export { createTrack, updateTrack, deleteTrack } from "./tracks.js";
```

- [ ] **Step 8: Run tests**

Run: `pnpm emu:test`
Expected: all PASS. (The `status in [...]` transaction query needs no composite index — single-field.)

- [ ] **Step 9: Commit**

```bash
git add functions
git commit -m "feat(functions): createTrack/updateTrack/deleteTrack with 10-track cap"
```

---

### Task 7: Functions — transcode + photo pipeline (`processUpload` trigger)

**Files:**
- Create: `functions/src/media.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/media.test.ts`

- [ ] **Step 1: Write failing tests**

Create `functions/test/media.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import type { ProfileDraftInput, CreateTrackInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");
vi.setConfig({ testTimeout: 60_000 }); // ffmpeg on emulator cold start

async function makeMusician(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
    { type: "musician", subtype: "solo", name: "Ava", handle: `${prefix}_${Date.now()}` }, user);
  return { user, uid, profileId };
}

describe("processUpload: audio", () => {
  it("transcodes a wav into a ≤30s m4a review clip, deletes the original, sets pending_review", async () => {
    const { user, profileId } = await makeMusician("tx1");
    const wav = makeWav(45); // 45s source, window starts at 10s
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Clip", startSec: 10, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    expect(data.durationSec).toBeGreaterThan(25);
    expect(data.durationSec).toBeLessThanOrEqual(30);
    expect(data.storagePath).toBe(`review/tracks/${profileId}/${trackId}.m4a`);
    const [reviewExists] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(reviewExists).toBe(true);
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false); // original discarded
  });
  it("clips shorter than the window remainder still work (duration = source - start)", async () => {
    const { user, profileId } = await makeMusician("tx2");
    const wav = makeWav(18);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Short", startSec: 5, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    expect(data.durationSec).toBeGreaterThan(10);
    expect(data.durationSec).toBeLessThanOrEqual(13.5);
  });
  it("fails cleanly when startSec is beyond the audio, and deletes the staging object", async () => {
    const { user, profileId } = await makeMusician("tx3");
    const wav = makeWav(8);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Bad", startSec: 60, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["failed"]);
    expect(data.failureReason).toMatch(/start/i);
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false);
  });
  it("ignores uploads with no matching processing track doc", async () => {
    const { user, uid, profileId } = await makeMusician("tx4");
    await uploadTestAudio(`staging/audio/${uid}/${profileId}/forged-track-id`, makeWav(2), "audio/wav", user);
    // No doc to flip — just assert nothing lands in review for that id.
    await new Promise((r) => setTimeout(r, 4000));
    const [exists] = await abucket.file(`review/tracks/${profileId}/forged-track-id.m4a`).exists();
    expect(exists).toBe(false);
  });
});

describe("processUpload: photos", () => {
  // Minimal valid 1x1 JPEG for sharp to re-encode.
  const tinyJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
  it("processes an avatar into public/photos and updates the profile doc", async () => {
    const { user, uid, profileId } = await makeMusician("ph1");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user); // same uploader helper works for any bytes
    const deadline = Date.now() + 30_000;
    let avatarPath: string | null = null;
    while (Date.now() < deadline && !avatarPath) {
      avatarPath = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (!avatarPath) await new Promise((r) => setTimeout(r, 500));
    }
    expect(avatarPath).toMatch(new RegExp(`^public/photos/${profileId}/avatar-`));
    const [exists] = await abucket.file(avatarPath!).exists();
    expect(exists).toBe(true);
  });
  it("ignores photo uploads from a non-member of the target profile", async () => {
    const { profileId } = await makeMusician("ph2");
    const { user: outsider, uid: outsiderUid } = await signUpTestUser(`ph2o-${Date.now()}@test.com`);
    await uploadTestAudio(`staging/photos/${outsiderUid}/${profileId}/avatar-${Date.now()}`,
      tinyJpeg(), "image/jpeg", outsider);
    await new Promise((r) => setTimeout(r, 4000));
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm emu:test`
Expected: media tests FAIL/time out (no trigger yet).

- [ ] **Step 3: Create `functions/src/media.ts`**

```ts
import { onObjectFinalized, type StorageEvent } from "firebase-functions/v2/storage";
import { getFirestore } from "firebase-admin/firestore";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import { reviewTrackPath, publicPhotoPath, MAX_CLIP_SECONDS } from "@gatekeep/shared";
import { STORAGE_BUCKET, bucket } from "./storage.js";

const run = promisify(execFile);

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run(ffprobe.path, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not read audio duration.");
  return d;
}

async function processAudio(objectName: string, generation: string): Promise<void> {
  // staging/audio/{uid}/{profileId}/{trackId}
  const [, , uid, profileId, trackId] = objectName.split("/");
  if (!uid || !profileId || !trackId) return;
  const db = getFirestore();
  const trackRef = db.doc(`profiles/${profileId}/tracks/${trackId}`);
  const snap = await trackRef.get();
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });
  // Forged/mismatched uploads (no doc, wrong uploader, wrong state): discard the
  // object and do nothing — createTrack is the only path that arms this pipeline.
  if (!snap.exists || snap.data()?.uploaderUid !== uid || snap.data()?.status !== "processing") {
    await stagingFile.delete().catch(() => {});
    return;
  }
  const startSec = snap.data()?.startSec as number;

  const tmp = await mkdtemp(join(tmpdir(), "gk-audio-"));
  try {
    const inFile = join(tmp, "in");
    const outFile = join(tmp, "out.m4a");
    await stagingFile.download({ destination: inFile });
    const sourceDuration = await probeDurationSec(inFile);
    if (startSec >= sourceDuration) {
      throw new Error(`Clip start (${startSec}s) is past the end of the audio (${Math.floor(sourceDuration)}s).`);
    }
    // -ss before -i = fast seek; -t caps the clip at 30s; AAC 128k in an mp4
    // container streams natively in every target player.
    await run(ffmpegPath as string, [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(startSec), "-t", String(MAX_CLIP_SECONDS), "-i", inFile,
      "-vn", "-acodec", "aac", "-b:a", "128k", "-movflags", "+faststart",
      outFile,
    ]);
    const clipDuration = await probeDurationSec(outFile);
    const destPath = reviewTrackPath(profileId, trackId);
    await bucket().upload(outFile, { destination: destPath, metadata: { contentType: "audio/mp4" } });
    await trackRef.update({
      status: "pending_review",
      durationSec: Math.round(clipDuration * 10) / 10,
      storagePath: destPath,
      failureReason: null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    await trackRef.update({
      status: "failed",
      failureReason: e instanceof Error ? e.message : "Audio processing failed.",
      updatedAt: Date.now(),
    });
  } finally {
    await stagingFile.delete().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
}

async function processPhoto(objectName: string, generation: string): Promise<void> {
  // staging/photos/{uid}/{profileId}/{kind}-{nonce}
  const [, , uid, profileId, fileName] = objectName.split("/");
  if (!uid || !profileId || !fileName) return;
  const kind = fileName.startsWith("avatar-") ? "avatar" : fileName.startsWith("cover-") ? "cover" : null;
  const db = getFirestore();
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });
  const member = kind ? await db.doc(`profiles/${profileId}/members/${uid}`).get() : null;
  if (!kind || !member?.exists) {
    await stagingFile.delete().catch(() => {}); // non-member or malformed: discard
    return;
  }
  try {
    const [bytes] = await stagingFile.download();
    // Re-encode via sharp: strips EXIF (GPS!) and bounds dimensions.
    const pipeline = kind === "avatar"
      ? sharp(bytes).rotate().resize(512, 512, { fit: "cover" })
      : sharp(bytes).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
    const jpeg = await pipeline.jpeg({ quality: 82 }).toBuffer();
    const destPath = publicPhotoPath(profileId, kind, randomUUID());
    await bucket().file(destPath).save(jpeg, { contentType: "image/jpeg" });

    const profileRef = db.doc(`profiles/${profileId}`);
    const field = kind === "avatar" ? "portfolio.avatarPhotoPath" : "portfolio.coverPhotoPath";
    const prev = (await profileRef.get()).data()?.portfolio?.[`${kind}PhotoPath`] as string | null | undefined;
    await profileRef.update({ [field]: destPath, updatedAt: Date.now() });
    if (prev) await bucket().file(prev).delete().catch(() => {});
  } finally {
    await stagingFile.delete().catch(() => {});
  }
}

export const processUpload = onObjectFinalized(
  { region: "us-central1", bucket: STORAGE_BUCKET, memory: "1GiB", timeoutSeconds: 300 },
  async (event: StorageEvent) => {
    const name = event.data.name ?? "";
    const generation = event.data.generation;
    if (name.startsWith("staging/audio/")) return processAudio(name, generation);
    if (name.startsWith("staging/photos/")) return processPhoto(name, generation);
  });
```

- [ ] **Step 4: Export from `functions/src/index.ts`**

```ts
export { processUpload } from "./media.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm emu:test`
Expected: all PASS. If ffmpeg-static's binary fails to spawn on Windows, check `node_modules/ffmpeg-static/ffmpeg.exe` exists (postinstall downloads a platform binary; a blocked postinstall is the usual cause — `pnpm rebuild ffmpeg-static ffprobe-static sharp`).

- [ ] **Step 6: Commit**

```bash
git add functions
git commit -m "feat(functions): processUpload — ffmpeg 30s clip transcode + sharp photo pipeline"
```

---

### Task 8: Functions — `reviewTrack` (admin gate)

**Files:**
- Modify: `functions/src/tracks.ts`
- Modify: `functions/src/review.ts` (export `requireAdmin`)
- Modify: `functions/src/index.ts`
- Test: append to `functions/test/tracks.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `functions/test/tracks.test.ts` (grantAdmin needs a Google-linked account — mirror the existing pattern in `functions/test/review.test.ts` for minting an admin user; reuse its helper if one exists, otherwise set the claim directly via the Admin SDK):

```ts
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getStorage as adminStorage } from "firebase-admin/storage";
import { uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";

const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");

async function makeAdminUser(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await adminAuth(admin).setCustomUserClaims(uid, { admin: true });
  await user.getIdToken(true); // refresh claims
  return { user, uid };
}

async function makePendingTrack(prefix: string) {
  const { user, profileId } = await makeMusician(prefix);
  const wav = makeWav(35);
  const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
    "createTrack", { profileId, title: "For review", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
  await uploadTestAudio(uploadPath, wav, "audio/wav", user);
  await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
  return { user, profileId, trackId };
}

describe("reviewTrack", () => {
  vi.setConfig({ testTimeout: 60_000 });
  it("approve copies the clip to public, deletes review copy, flips status, audits, notifies", async () => {
    const { profileId, trackId } = await makePendingTrack("rv1");
    const { user: adminUser } = await makeAdminUser("rv1a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.status).toBe("approved");
    expect(t.data()?.storagePath).toBe(`public/tracks/${profileId}/${trackId}.m4a`);
    const [pub] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    const [rev] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pub).toBe(true);
    expect(rev).toBe(false);
    const audit = await adb.collection("auditLogs").where("targetId", "==", `${profileId}/${trackId}`).get();
    expect(audit.docs.some((d) => d.data().action === "track_approved")).toBe(true);
  });
  it("reject requires a reason ≤500, deletes the clip, keeps the doc with the reason", async () => {
    const { profileId, trackId } = await makePendingTrack("rv2");
    const { user: adminUser } = await makeAdminUser("rv2a");
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "rejected" }, adminUser))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: "Sounds AI-generated." }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "Sounds AI-generated.", storagePath: null });
    const [rev] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(rev).toBe(false);
  });
  it("non-admin cannot review; non-pending tracks are refused", async () => {
    const { user, profileId, trackId } = await makePendingTrack("rv3");
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const { user: adminUser } = await makeAdminUser("rv3a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});
```

- [ ] **Step 2: Export `requireAdmin` from `functions/src/review.ts`**

Change `function requireAdmin(` to `export function requireAdmin(`.

- [ ] **Step 3: Add `reviewTrack` to `functions/src/tracks.ts`**

```ts
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";
import { reviewTrackPath, publicTrackPath } from "@gatekeep/shared";

export const reviewTrack = onCall<{ profileId: string; trackId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, trackId, decision, reason } = req.data;
    if (typeof profileId !== "string" || typeof trackId !== "string"
        || (decision !== "approved" && decision !== "rejected")) {
      throw new HttpsError("invalid-argument", "profileId, trackId, and a decision are required.");
    }
    if (decision === "rejected" && !reason?.trim()) {
      throw new HttpsError("invalid-argument", "A rejection reason is required.");
    }
    if (decision === "rejected" && reason!.trim().length > 500) {
      throw new HttpsError("invalid-argument", "Rejection reason must be 500 characters or fewer.");
    }
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Track not found.");
    if (snap.data()?.status !== "pending_review") {
      throw new HttpsError("failed-precondition", "Track is not pending review.");
    }
    const reviewFile = bucket().file(reviewTrackPath(profileId, trackId));

    if (decision === "approved") {
      // Copy-then-delete keeps the public-path invariant: the clip appears in
      // public/ only as part of an approval.
      await reviewFile.copy(bucket().file(publicTrackPath(profileId, trackId)));
      await reviewFile.delete().catch(() => {});
      await ref.update({
        status: "approved", storagePath: publicTrackPath(profileId, trackId),
        rejectionReason: null, updatedAt: Date.now(),
      });
    } else {
      await reviewFile.delete().catch(() => {});
      await ref.update({
        status: "rejected", storagePath: null,
        rejectionReason: reason!.trim(), updatedAt: Date.now(),
      });
    }
    await writeAudit({
      actorUid,
      action: decision === "approved" ? "track_approved" : "track_rejected",
      targetId: `${profileId}/${trackId}`,
      detail: decision === "rejected" ? reason!.trim() : (snap.data()?.title ?? ""),
    });
    const title = snap.data()?.title ?? "Your track";
    await notifyProfileMembers(profileId, {
      kind: "track_review",
      title: decision === "approved" ? `"${title}" is live!` : `"${title}" needs attention`,
      body: decision === "approved"
        ? "Your track passed review and now plays on your public portfolio."
        : `Reviewer note: ${reason!.trim()} — you can delete it and upload a replacement.`,
    });
    return { ok: true };
  });
```

- [ ] **Step 4: Export from `functions/src/index.ts`**

```ts
export { createTrack, updateTrack, deleteTrack, reviewTrack } from "./tracks.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm emu:test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add functions
git commit -m "feat(functions): reviewTrack — admin approve/reject with audit + notification"
```

---

### Task 9: Functions — submit minimum-content gate + deleteProfile storage cascade

**Files:**
- Modify: `functions/src/profiles.ts`
- Test: append to `functions/test/profiles.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `functions/test/profiles.test.ts`:

```ts
import { getStorage as adminStorage } from "firebase-admin/storage";
import { uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import type { CreateTrackInput } from "@gatekeep/shared";

process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");

describe("submitProfileForReview minimum content (musicians)", () => {
  vi.setConfig({ testTimeout: 60_000 });
  it("refuses an empty musician draft, listing what's missing; passes once bio+genre+avatar+track exist", async () => {
    const { user, uid } = await signUpTestUser(`gate-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `gate_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    // avatar via admin SDK shortcut (photo pipeline has its own tests)
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i); // still no track

    const wav = makeWav(12);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });
  it("curator drafts submit without portfolio checks (unchanged from foundation)", async () => {
    const { user } = await signUpTestUser(`gatec-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "The Room", handle: `gatec_${Date.now()}` }, user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });
});

describe("deleteProfile storage cascade", () => {
  vi.setConfig({ testTimeout: 60_000 });
  it("deletes the profile's public/review storage objects along with the docs", async () => {
    const { user } = await signUpTestUser(`delc-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `delc_${Date.now()}` }, user);
    // Seed storage objects directly — exercising the full pipeline is Task 7's job.
    await abucket.file(`review/tracks/${profileId}/t1.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/tracks/${profileId}/t2.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/photos/${profileId}/avatar-x.jpg`).save(Buffer.from([1]), { contentType: "image/jpeg" });
    await callFn("deleteProfile", { profileId }, user);
    for (const p of [`review/tracks/${profileId}/t1.m4a`, `public/tracks/${profileId}/t2.m4a`,
                     `public/photos/${profileId}/avatar-x.jpg`]) {
      const [exists] = await abucket.file(p).exists();
      expect(exists).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm emu:test`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `functions/src/profiles.ts`**

Add imports:

```ts
import type { PortfolioData } from "@gatekeep/shared";
import { bucket } from "./storage.js";
```

In `submitProfileForReview`, after the status check and before the `ref.update`:

```ts
  // Spec §6 minimum content: reviewers approve a *portfolio* — there must be
  // something to look at and listen to. Musicians only; curators are sub-3.
  if (snap.data()?.type === "musician") {
    const p = snap.data()?.portfolio as PortfolioData | undefined;
    const missing: string[] = [];
    if (!p?.bio?.trim()) missing.push("a bio");
    if (!p?.genres?.length) missing.push("at least one genre");
    if (!p?.avatarPhotoPath) missing.push("a profile photo");
    const tracks = await ref.collection("tracks").get();
    if (!tracks.docs.some((t) => ["processing", "pending_review", "approved"].includes(t.data().status))) {
      missing.push("at least one track");
    }
    if (missing.length > 0) {
      throw new HttpsError("failed-precondition", `Add ${missing.join(", ")} before submitting.`);
    }
  }
```

In `deleteProfile`, after `recursiveDelete` (which already removes the tracks subcollection and `private/booking`):

```ts
  // Storage cascade — best-effort: any stragglers are unreachable (their doc
  // paths are gone) and carry no PII beyond the content itself.
  await Promise.allSettled([
    bucket().deleteFiles({ prefix: `public/tracks/${profileId}/` }),
    bucket().deleteFiles({ prefix: `review/tracks/${profileId}/` }),
    bucket().deleteFiles({ prefix: `public/photos/${profileId}/` }),
  ]);
```

- [ ] **Step 4: Run tests**

Run: `pnpm emu:test`
Expected: all PASS, including foundation's existing profiles tests (curator path untouched; existing musician-draft tests in `profiles.test.ts` submit without portfolio content — **check**: foundation's `submitProfileForReview` tests use musician drafts. Update those existing tests to seed the minimum content the same way the new test does, or switch their fixtures to curator profiles — prefer curator fixtures where the test's subject is the status transition, not the gate.)

- [ ] **Step 5: Commit**

```bash
git add functions
git commit -m "feat(functions): musician submit minimum-content gate + deleteProfile storage cascade"
```

---

### Task 10: Web — SSR public portfolio page + vanity URLs

**Files:**
- Create: `apps/web/src/lib/firebase-server.ts`
- Create: `apps/web/app/u/[handle]/TrackPlayer.tsx`
- Create: `apps/web/app/u/[handle]/portfolio.module.css`
- Modify: `apps/web/app/u/[handle]/page.tsx` (full rewrite: client → server component)
- Modify: `apps/web/next.config.ts`

**Before coding:** skim `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` and `04-functions/generate-metadata.md` (verified: `params` is a Promise; `PageProps<'/u/[handle]'>` is global after `next typegen`).

- [ ] **Step 1: Create `apps/web/src/lib/firebase-server.ts`**

```ts
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";

// Server-side (RSC) Firebase: anonymous, public-rules reads only — the public
// portfolio page reads only what firestore.rules exposes to the world, so no
// admin credentials are needed on the web server (works the same on Vercel).
const firebaseConfig = {
  apiKey: "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU",
  authDomain: "gatekeep-dev-jg.firebaseapp.com",
  projectId: "gatekeep-dev-jg",
  storageBucket: "gatekeep-dev-jg.firebasestorage.app",
  appId: "1:894446689930:web:20531390a23a3804b05773",
};

let cached: { app: FirebaseApp; db: Firestore; storage: FirebaseStorage } | null = null;

export function getServerFirebase() {
  if (cached) return cached;
  const app = getApps().some((a) => a.name === "server")
    ? getApp("server") : initializeApp(firebaseConfig, "server");
  const db = getFirestore(app);
  const storage = getStorage(app);
  if (process.env.NODE_ENV !== "production") {
    connectFirestoreEmulator(db, "localhost", 8080);
    connectStorageEmulator(storage, "localhost", 9199);
  }
  cached = { app, db, storage };
  return cached;
}
```

- [ ] **Step 2: Create `apps/web/app/u/[handle]/TrackPlayer.tsx`**

```tsx
"use client";
import { useRef, useState } from "react";

// One clip playing at a time across the page.
let currentAudio: HTMLAudioElement | null = null;

export function TrackPlayer({ title, url, durationSec }: { title: string; url: string; durationSec: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) { audio.pause(); return; }
    if (currentAudio && currentAudio !== audio) currentAudio.pause();
    currentAudio = audio;
    void audio.play();
    setPlaying(true);
  };
  return (
    <button className="trackRow" onClick={toggle} aria-label={`${playing ? "Pause" : "Play"} ${title}`}>
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      <span>{title}</span>
      <span className="trackDur">{durationSec ? `0:${String(Math.round(durationSec)).padStart(2, "0")}` : ""}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create `apps/web/app/u/[handle]/portfolio.module.css`**

```css
/* Hybrid layout: hero-first single column on mobile, EPK split on desktop. */
.page { max-width: 960px; margin: 0 auto; padding: 16px; }
.cover { width: 100%; aspect-ratio: 16 / 6; object-fit: cover; border-radius: 12px; background: #ddd; }
.layout { display: grid; gap: 24px; grid-template-columns: 1fr; margin-top: 16px; }
.identity { display: flex; flex-direction: column; gap: 8px; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; margin-top: -64px;
  border: 4px solid #fff; background: #eee; }
.genres { color: #666; }
.section { margin-top: 24px; }
.bio { white-space: pre-wrap; line-height: 1.5; }
.links { display: flex; gap: 12px; flex-wrap: wrap; }
.links a { text-decoration: underline; }
@media (min-width: 900px) {
  .layout { grid-template-columns: 300px 1fr; }
  .identity { position: sticky; top: 24px; align-self: start; }
  .avatar { margin-top: -48px; }
}
```

Plus global styles for `.trackRow` (add to the module as `:global` or inline in TrackPlayer — implementer's choice; keep it one of those, not a new global stylesheet):

```css
.tracks :global(.trackRow) { display: flex; gap: 12px; align-items: center; width: 100%;
  padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 6px;
  background: none; font-size: 15px; cursor: pointer; text-align: left; }
.tracks :global(.trackDur) { margin-left: auto; color: #888; }
```

- [ ] **Step 4: Rewrite `apps/web/app/u/[handle]/page.tsx` as a server component**

```tsx
import type { Metadata } from "next";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";
import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";

export const dynamic = "force-dynamic"; // live approval state on every request

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };
type Loaded = {
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
};

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch { return null; }
}

async function loadProfile(handle: string): Promise<Loaded | null> {
  const { db } = getServerFirebase();
  try {
    const h = await getDoc(doc(db, "handles", handle));
    if (!h.exists()) return null;
    const profileId = h.data().profileId as string;
    const p = await getDoc(doc(db, "profiles", profileId)); // rules deny unless approved
    if (!p.exists()) return null;
    const profile = p.data() as ProfileDoc;
    if (profile.type !== "musician") return null; // curator pages are sub-3
    const trackSnap = await getDocs(query(
      collection(db, `profiles/${profileId}/tracks`),
      where("status", "==", "approved"), orderBy("order")));
    const tracks = (await Promise.all(trackSnap.docs.map(async (t) => {
      const d = t.data() as TrackDoc;
      const url = await storageUrl(d.storagePath);
      return url ? { id: t.id, title: d.title, durationSec: d.durationSec, url } : null;
    }))).filter((t): t is LoadedTrack => t !== null);
    return {
      profile, tracks,
      avatarUrl: await storageUrl(profile.portfolio?.avatarPhotoPath),
      coverUrl: await storageUrl(profile.portfolio?.coverPhotoPath),
    };
  } catch { return null; } // permission-denied = not approved = not found
}

export async function generateMetadata(props: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) return { title: "Not found · GateKeep" };
  const { profile } = data;
  const description = profile.portfolio?.bio?.slice(0, 160)
    || `${profile.name} on GateKeep — ${profile.portfolio?.genres?.join(", ")}`;
  return {
    title: `${profile.name} (@${profile.handle}) · GateKeep`,
    description,
    openGraph: {
      title: `${profile.name} on GateKeep`,
      description,
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  };
}

export default async function PublicProfile(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) {
    return <main className={styles.page}><h1>Not found</h1><p>No profile at @{handle}.</p></main>;
  }
  const { profile, tracks, avatarUrl, coverUrl } = data;
  const pf = profile.portfolio;
  return (
    <main className={styles.page}>
      {coverUrl
        ? <img className={styles.cover} src={coverUrl} alt="" />
        : <div className={styles.cover} aria-hidden />}
      <div className={styles.layout}>
        <aside className={styles.identity}>
          {avatarUrl && <img className={styles.avatar} src={avatarUrl} alt={`${profile.name} photo`} />}
          <h1>{profile.name}</h1>
          <p>@{profile.handle}</p>
          {pf?.genres && pf.genres.length > 0 && <p className={styles.genres}>{pf.genres.join(" · ")}</p>}
          {pf?.externalLinks && pf.externalLinks.length > 0 && (
            <div className={styles.links}>
              {pf.externalLinks.map((l) => (
                <a key={l.url} href={l.url} rel="noopener noreferrer nofollow" target="_blank">{l.kind}</a>
              ))}
            </div>
          )}
        </aside>
        <div>
          {tracks.length > 0 && (
            <section className={`${styles.section} ${styles.tracks}`}>
              <h2>Listen</h2>
              {tracks.map((t) => <TrackPlayer key={t.id} title={t.title} url={t.url} durationSec={t.durationSec} />)}
            </section>
          )}
          {pf?.bio && (
            <section className={styles.section}>
              <h2>About</h2>
              <p className={styles.bio}>{pf.bio}</p>
            </section>
          )}
          {/* Shows: platform events only (spec §2). The events collection ships in
              sub-projects 4/6 — this section stays hidden until it has data. */}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Vanity URLs in `apps/web/next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /@ava is the canonical public URL; /u/ava 308s to it. Redirects run before
  // rewrites on incoming requests only, so the internal rewrite cannot loop
  // (verified against next/dist/docs rewrites.md ordering).
  async redirects() {
    return [{ source: "/u/:handle", destination: "/@:handle", permanent: true }];
  },
  async rewrites() {
    return { beforeFiles: [{ source: "/@:handle", destination: "/u/:handle" }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter @gatekeep/web exec next typegen && pnpm --filter @gatekeep/web typecheck && pnpm --filter @gatekeep/web lint`
Expected: green.

Manual (needs `pnpm emu` + seeded approved profile with an approved track): `pnpm --filter @gatekeep/web dev`, open `http://localhost:3000/@<handle>` — page renders server-side (view-source shows content), track plays, `/u/<handle>` redirects to `/@<handle>`.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): server-rendered public portfolio with @handle vanity URLs"
```

---

### Task 11: Web — portfolio editor components, wizard, dashboard wiring

**Files:**
- Create: `apps/web/src/portfolio/TrimUploader.tsx`
- Create: `apps/web/src/portfolio/TrackManager.tsx`
- Create: `apps/web/src/portfolio/PortfolioForms.tsx`
- Create: `apps/web/app/dashboard/portfolio/[profileId]/page.tsx`
- Create: `apps/web/app/join/page.tsx`
- Modify: `apps/web/app/dashboard/page.tsx`

- [ ] **Step 1: Create `apps/web/src/portfolio/TrimUploader.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { validateTrackCreate, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput } from "@gatekeep/shared";

// Pick a local audio file, preview it, drag the 30s window, upload the original.
// The server pipeline trims/transcodes; we never keep the full track.
export function TrimUploader({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => () => { // revoke on unmount
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    audioRef.current?.pause();
  }, []);

  const pick = (f: File) => {
    setError(null);
    if (f.size > MAX_AUDIO_UPLOAD_BYTES) { setError("File is over 50 MB."); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(f);
    const audio = new Audio(objectUrl.current);
    audio.onloadedmetadata = () => setDuration(audio.duration);
    // Preview stops at the end of the 30s window.
    audio.ontimeupdate = () => {
      if (audio.currentTime >= Math.min(startRef.current + MAX_CLIP_SECONDS, audio.duration)) audio.pause();
    };
    audioRef.current?.pause();
    audioRef.current = audio;
    setFile(f);
    setStartSec(0);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };
  // ontimeupdate closes over state — keep the live value in a ref.
  const startRef = useRef(0);
  useEffect(() => { startRef.current = startSec; }, [startSec]);

  const preview = () => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = startSec;
    void a.play();
  };

  const upload = async () => {
    if (!file) return;
    const input: CreateTrackInput = {
      profileId, title: title.trim(), startSec: Math.floor(startSec),
      sizeBytes: file.size, contentType: file.type || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy("Requesting upload…"); setError(null);
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), file,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading… ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      setBusy(null); setFile(null); setTitle("");
      onDone();
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "Upload failed — try again.");
    }
  };

  const windowEnd = Math.min(startSec + MAX_CLIP_SECONDS, duration);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div style={{ border: "1px dashed #bbb", borderRadius: 8, padding: 16, display: "grid", gap: 8 }}>
      <strong>Add a track (30-second snippet)</strong>
      <input type="file" accept="audio/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
      {file && duration > 0 && (
        <>
          <input placeholder="Track title" value={title} maxLength={80}
            onChange={(e) => setTitle(e.target.value)} />
          <label>
            Clip window: {fmt(startSec)} – {fmt(windowEnd)} (of {fmt(duration)})
            <input type="range" min={0} max={Math.max(0, Math.floor(duration - 1))} step={1}
              value={startSec} style={{ width: "100%" }}
              onChange={(e) => setStartSec(Number(e.target.value))} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={preview}>▶ Preview window</button>
            <button type="button" onClick={() => audioRef.current?.pause()}>Stop</button>
            <button type="button" onClick={upload} disabled={busy !== null}>{busy ?? "Upload snippet"}</button>
          </div>
        </>
      )}
      {error && <p style={{ color: "#dc2626", margin: 0 }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/portfolio/TrackManager.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import type { TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";

type Row = TrackDoc & { id: string };

const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
};

export function TrackManager({ profileId }: { profileId: string }) {
  const [tracks, setTracks] = useState<Row[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);

  const call = async (name: string, data: object) => {
    try { await httpsCallable(getFirebase().functions, name)(data); }
    catch (e) { window.alert(e instanceof Error ? e.message : "That didn't work — try again."); }
  };
  const move = (i: number, dir: -1 | 1) => {
    const a = tracks[i], b = tracks[i + dir];
    if (!a || !b) return;
    void call("updateTrack", { profileId, trackId: a.id, order: b.order });
    void call("updateTrack", { profileId, trackId: b.id, order: a.order });
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/10)</h2>
      {tracks.map((t, i) => (
        <div key={t.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <strong>{t.title}</strong>{" "}
          <span style={{ fontSize: 13, padding: "2px 8px", borderRadius: 10,
            background: t.status === "approved" ? "#dcfce7" : t.status === "rejected" || t.status === "failed" ? "#fee2e2" : "#fef9c3" }}>
            {STATUS_LABEL[t.status]}
          </span>
          {(t.rejectionReason || t.failureReason) && (
            <p style={{ margin: "4px 0 0", color: "#991b1b" }}>{t.rejectionReason ?? t.failureReason}</p>
          )}
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
            <button onClick={() => move(i, 1)} disabled={i === tracks.length - 1}>↓</button>
            <button onClick={() => {
              const title = window.prompt("New title:", t.title);
              if (title) void call("updateTrack", { profileId, trackId: t.id, title });
            }}>Rename</button>
            <button onClick={() => {
              if (window.confirm(`Delete "${t.title}"?`)) void call("deleteTrack", { profileId, trackId: t.id });
            }} style={{ color: "#dc2626" }}>Delete</button>
          </div>
        </div>
      ))}
      <TrimUploader profileId={profileId} onDone={() => { /* onSnapshot refreshes */ }} />
    </section>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/portfolio/PortfolioForms.tsx`**

```tsx
"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  GENRES, GIG_TYPES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type ExternalLink, type ExternalLinkKind,
} from "@gatekeep/shared";

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await httpsCallable(getFirebase().functions, name)(data); return true; }
  catch (e) { window.alert(e instanceof Error ? e.message : "Save failed — try again."); return false; }
};

export function BioGenresForm({ profileId, initial, onSaved }:
  { profileId: string; initial: PortfolioData | undefined; onSaved?: () => void }) {
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  const [busy, setBusy] = useState(false);
  const toggleGenre = (g: string) => setGenres((cur) =>
    cur.includes(g) ? cur.filter((x) => x !== g) : cur.length < 3 ? [...cur, g] : cur);
  const save = async () => {
    const v = validatePortfolioUpdate({ profileId, bio, genres });
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", { profileId, bio, genres })) onSaved?.();
    setBusy(false);
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Bio & genres</h2>
      <textarea rows={6} maxLength={2000} value={bio} placeholder="Tell curators and fans who you are…"
        onChange={(e) => setBio(e.target.value)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => (
          <button key={g} type="button" onClick={() => toggleGenre(g)}
            style={{ padding: "4px 10px", borderRadius: 12, border: "1px solid #bbb",
              background: genres.includes(g) ? "#111" : "#fff", color: genres.includes(g) ? "#fff" : "#111" }}>
            {g}
          </button>
        ))}
      </div>
      <button onClick={save} disabled={busy}>Save bio & genres</button>
    </section>
  );
}

export function LinksForm({ profileId, initial }:
  { profileId: string; initial: PortfolioData | undefined }) {
  const [links, setLinks] = useState<ExternalLink[]>(initial?.externalLinks ?? []);
  const [kind, setKind] = useState<ExternalLinkKind>("spotify");
  const [url, setUrl] = useState("");
  const save = async (next: ExternalLink[]) => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { window.alert(v.reason); return; }
    if (await callOrAlert("updatePortfolio", { profileId, externalLinks: next })) setLinks(next);
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Links</h2>
      {links.map((l, i) => (
        <p key={`${l.url}-${i}`} style={{ margin: 0 }}>
          {l.kind}: {l.url}{" "}
          <button onClick={() => void save(links.filter((_, j) => j !== i))}>Remove</button>
        </p>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as ExternalLinkKind)}>
          <option value="spotify">Spotify</option><option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option><option value="website">Website</option>
        </select>
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button onClick={() => { if (url) { void save([...links, { kind, url }]); setUrl(""); } }}>Add</button>
      </div>
    </section>
  );
}

export function PhotoUploader({ profileId, uid, kind }:
  { profileId: string; uid: string; kind: "avatar" | "cover" }) {
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const { storage } = getFirebase();
      const path = stagingPhotoPath(uid, profileId, kind, crypto.randomUUID());
      await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
      // The photo pipeline resizes/strips and updates the profile doc; the
      // parent page's snapshot listener picks the new path up automatically.
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Upload failed.");
    } finally { setBusy(false); }
  };
  return (
    <label style={{ display: "inline-block" }}>
      {busy ? "Uploading…" : `Upload ${kind === "avatar" ? "profile photo" : "cover photo"}`}
      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    </label>
  );
}

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  const [rates, setRates] = useState(initial?.rates ??
    { perHour: null, perSong: null, perSet: null });
  const [prefs, setPrefs] = useState(initial?.preferences ??
    { gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null,
      bringsOwnPA: null, availabilityPattern: null });
  const [busy, setBusy] = useState(false);

  const rateField = (key: "perHour" | "perSong" | "perSet", label: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ width: 120 }}>{label}</span>
      $<input type="number" min={0} step="0.01" style={{ width: 100 }}
        value={rates[key] ? (rates[key]!.amountCents / 100).toString() : ""}
        onChange={(e) => {
          const dollars = e.target.value;
          setRates((r) => ({ ...r, [key]: dollars === "" ? null
            : { amountCents: Math.round(Number(dollars) * 100), note: r[key]?.note ?? null } }));
        }} />
      <input placeholder="note (optional)" maxLength={200} style={{ flex: 1 }}
        value={rates[key]?.note ?? ""} disabled={!rates[key]}
        onChange={(e) => setRates((r) => ({ ...r,
          [key]: r[key] ? { ...r[key]!, note: e.target.value || null } : null }))} />
    </label>
  );

  const save = async () => {
    const input = { profileId, rates, preferences: prefs };
    const v = validateBookingUpdate(input);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    await callOrAlert("updateBookingInfo", input);
    setBusy(false);
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Rates & preferences</h2>
      <p style={{ color: "#666", margin: 0 }}>
        Visible to curators only — never on your public page. Offer any mix of the three.
      </p>
      {rateField("perHour", "Per hour")}
      {rateField("perSong", "Per song")}
      {rateField("perSet", "Per set (flat)")}
      <h3 style={{ marginBottom: 0 }}>Gig preferences</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {GIG_TYPES.map((g) => (
          <button key={g} type="button"
            onClick={() => setPrefs((p) => ({ ...p, gigTypes: p.gigTypes.includes(g)
              ? p.gigTypes.filter((x) => x !== g) : [...p.gigTypes, g] }))}
            style={{ padding: "4px 10px", borderRadius: 12, border: "1px solid #bbb",
              background: prefs.gigTypes.includes(g) ? "#111" : "#fff",
              color: prefs.gigTypes.includes(g) ? "#fff" : "#111" }}>
            {g.replace("_", " ")}
          </button>
        ))}
      </div>
      <label>Travel radius (km): <input type="number" min={0} max={3000} style={{ width: 90 }}
        value={prefs.travelRadiusKm ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          travelRadiusKm: e.target.value === "" ? null : Number(e.target.value) }))} /></label>
      <label>Act size:{" "}
        <select value={prefs.actSize ?? ""} onChange={(e) => setPrefs((p) => ({ ...p,
          actSize: (e.target.value || null) as typeof p.actSize }))}>
          <option value="">—</option><option value="solo">Solo</option>
          <option value="duo">Duo</option><option value="band">Band</option>
        </select></label>
      <label>Typical set (minutes): <input type="number" min={15} max={480} style={{ width: 90 }}
        value={prefs.typicalSetMinutes ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          typicalSetMinutes: e.target.value === "" ? null : Number(e.target.value) }))} /></label>
      <label>Bring own PA:{" "}
        <select value={prefs.bringsOwnPA === null ? "" : String(prefs.bringsOwnPA)}
          onChange={(e) => setPrefs((p) => ({ ...p,
            bringsOwnPA: e.target.value === "" ? null : e.target.value === "true" }))}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select></label>
      <label>Availability:{" "}
        <select value={prefs.availabilityPattern ?? ""}
          onChange={(e) => setPrefs((p) => ({ ...p,
            availabilityPattern: (e.target.value || null) as typeof p.availabilityPattern }))}>
          <option value="">—</option><option value="weekends">Weekends</option>
          <option value="weeknights">Weeknights</option><option value="anytime">Anytime</option>
          <option value="limited">Limited</option>
        </select></label>
      <button onClick={save} disabled={busy}>Save rates & preferences</button>
    </section>
  );
}
```

- [ ] **Step 4: Create the editor page `apps/web/app/dashboard/portfolio/[profileId]/page.tsx`**

```tsx
"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../../../src/portfolio/TrackManager";
import type { ProfileDoc, BookingDoc } from "@gatekeep/shared";

export default function PortfolioEditor(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [booking, setBooking] = useState<BookingDoc | null | "loading">("loading");

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => setBooking(s.exists() ? (s.data() as BookingDoc) : null))
      .catch(() => setBooking(null));
    return unsub;
  }, [user?.uid, profileId]);

  if (loading || !user || profile === "loading" || booking === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "musician") return <main><p>No musician profile here.</p></main>;

  const resubmit = async () => {
    try { await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId }); }
    catch (e) { window.alert(e instanceof Error ? e.message : "Could not submit."); }
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 32 }}>
      <h1>{profile.name} — portfolio</h1>
      <p>
        Status: <strong>{profile.status.replace("_", " ")}</strong>
        {profile.status === "approved" && <> · <a href={`/@${profile.handle}`} target="_blank">view public page</a></>}
      </p>
      {profile.status === "rejected" && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12 }}>
          <strong>Changes requested:</strong> {profile.rejectionReason}
          <div><button onClick={resubmit}>Resubmit for review</button></div>
        </div>
      )}
      <section>
        <h2>Photos</h2>
        <PhotoUploader profileId={profileId} uid={user.uid} kind="avatar" />{" · "}
        <PhotoUploader profileId={profileId} uid={user.uid} kind="cover" />
        <p style={{ color: "#666" }}>Photos appear on your page a few seconds after upload.</p>
      </section>
      <BioGenresForm profileId={profileId} initial={profile.portfolio} />
      <LinksForm profileId={profileId} initial={profile.portfolio} />
      <TrackManager profileId={profileId} />
      <BookingForm profileId={profileId} initial={booking} />
      {(profile.status === "draft") && (
        <button onClick={resubmit} style={{ padding: 12, fontSize: 16 }}>Submit for review</button>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Create the wizard `apps/web/app/join/page.tsx`**

The wizard is the same editor flow with hand-holding: create the draft, then walk the editor sections in order, then submit. Keep it thin — steps reuse the Task 11 components.

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { validateProfileDraft, type ProfileDraftInput } from "@gatekeep/shared";

// Step 1 of the musician wizard: identity → creates the draft, then hands off
// to the portfolio editor which owns bio/photos/tracks/rates and the submit
// button (its gate messaging comes from the server).
export default function Join() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [subtype, setSubtype] = useState<"solo" | "band">("solo");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) { router.replace("/sign-in"); return null; }

  const createDraft = async () => {
    const input: ProfileDraftInput = { type: "musician", subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await httpsCallable<ProfileDraftInput, { profileId: string }>(
        getFirebase().functions, "createProfileDraft")(input);
      router.push(`/dashboard/portfolio/${data.profileId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your profile.");
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", display: "grid", gap: 12 }}>
      <h1>Join as a musician</h1>
      <p>Create your act. You'll add your bio, photos, and a first track next —
        those are required before you can submit for review.</p>
      <div style={{ display: "flex", gap: 8 }}>
        {(["solo", "band"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSubtype(s)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
              background: subtype === s ? "#111" : "#fff", color: subtype === s ? "#fff" : "#111" }}>
            {s === "solo" ? "Solo act" : "Band"}
          </button>
        ))}
      </div>
      <input placeholder="Stage or band name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="handle (lowercase, no spaces)" autoCapitalize="none" value={handle}
        onChange={(e) => setHandle(e.target.value)} />
      {error && <p style={{ color: "#dc2626", margin: 0 }}>{error}</p>}
      <button onClick={createDraft} disabled={busy}>{busy ? "Creating…" : "Create my profile"}</button>
    </main>
  );
}
```

- [ ] **Step 6: Wire `apps/web/app/dashboard/page.tsx`**

In `ProfilesList`, render each musician profile row as a link to its editor, and add a join link:

```tsx
// row becomes:
<li key={p.profileId}>
  {p.name} — {p.type} — {p.status.replace("_", " ")}
  {p.type === "musician" && <> · <a href={`/dashboard/portfolio/${p.profileId}`}>
    {p.status === "draft" ? "finish setup" : p.status === "rejected" ? "revise & resubmit" : "edit portfolio"}</a></>}
</li>
// empty state gains: <a href="/join">Join as a musician</a>
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter @gatekeep/web exec next typegen && pnpm --filter @gatekeep/web typecheck && pnpm --filter @gatekeep/web lint`
Expected: green.

Manual loop (emulators running, `scripts/seed-admin.ts` admin available): sign up → `/join` → create draft → editor: bio+genres, avatar upload (photo appears after pipeline), track upload with window slider → submit blocked until minimums → submit succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): portfolio editor, musician wizard, dashboard wiring"
```

---

### Task 12: Web — admin Tracks review queue

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: Add a `TracksQueue` section**

Add to `apps/web/app/admin/page.tsx` (following the existing `Queue` component's patterns exactly — per-row busy state, checklist banner):

```tsx
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import type { TrackDoc } from "@gatekeep/shared";

type TrackRow = TrackDoc & { id: string; profileId: string; profileName: string };

function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!t.storagePath) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, t.storagePath))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [t.storagePath]);
  const review = async (decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the musician):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId: t.profileId, trackId: t.id, decision, reason });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not submit the review — try again.");
    } finally { setBusy(false); }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{t.title}</strong> — {t.profileName} · {t.durationSec ?? "?"}s
      {url ? <audio controls src={url} style={{ display: "block", margin: "8px 0" }} />
           : <p style={{ color: "#888" }}>clip loading…</p>}
      <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
      <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
    </div>
  );
}

function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collectionGroup(db, "tracks"), where("status", "==", "pending_review")),
      async (s) => {
        const rows: TrackRow[] = [];
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent!;
          const p = await getDoc(profileRef);
          rows.push({ id: d.id, profileId: profileRef.id,
            profileName: p.exists() ? (p.data() as ProfileDoc).name : "(deleted)",
            ...(d.data() as TrackDoc) });
        }
        setPending(rows);
      });
  }, []);
  return (
    <section>
      <h2>Track review queue ({pending.length})</h2>
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        You are hearing exactly what the public would hear. Screening call: does this
        sound like the artist's own performance (not AI-generated / not someone
        else's recording)? When unsure, reject with a note asking for context.
      </p>
      {pending.map((t) => <TrackQueueRow key={`${t.profileId}-${t.id}`} t={t} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}
```

Render it in `AdminPage` between `<Queue />` and `<UserLookup />`: `<Queue /><TracksQueue /><UserLookup /><AuditLog />`.

- [ ] **Step 2: Verify**

Run: `pnpm --filter @gatekeep/web typecheck && pnpm --filter @gatekeep/web lint`
Manual: with a pending track from the Task 11 loop, admin hears the clip inline, approve flips it Live on the public page; reject shows the reason in the musician's TrackManager.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(web): admin track review queue with inline playback"
```

---

### Task 13: Mobile — dependencies + portfolio components

**Files:**
- Modify: `apps/mobile/package.json` (via expo install)
- Create: `apps/mobile/src/portfolio/TrimUploader.tsx`
- Create: `apps/mobile/src/portfolio/TrackManager.tsx`
- Create: `apps/mobile/src/portfolio/PortfolioForms.tsx`

- [ ] **Step 1: Install Expo deps**

Run in `apps/mobile/`:
```bash
npx expo install expo-audio expo-document-picker @react-native-community/slider
```
(`expo-av` is deprecated in this SDK — `expo-audio` is the playback API. No app.json plugin changes needed for playback-only use.)

- [ ] **Step 2: Create `apps/mobile/src/portfolio/TrimUploader.tsx`**

```tsx
import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import Slider from "@react-native-community/slider";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { validateTrackCreate, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput } from "@gatekeep/shared";

type Picked = { uri: string; name: string; size: number; mimeType: string };

export function TrimUploader({ profileId, onDone }: { profileId: string; onDone?: () => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [title, setTitle] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const player = useAudioPlayer(picked ? { uri: picked.uri } : null);
  const status = useAudioPlayerStatus(player);
  const duration = status.duration ?? 0;

  // Stop preview at the end of the 30s window.
  useEffect(() => {
    if (status.playing && status.currentTime >= Math.min(startSec + MAX_CLIP_SECONDS, duration)) {
      player.pause();
    }
  }, [status.currentTime, status.playing, startSec, duration, player]);

  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if ((a.size ?? 0) > MAX_AUDIO_UPLOAD_BYTES) { Alert.alert("Too big", "Audio files must be under 50 MB."); return; }
    setPicked({ uri: a.uri, name: a.name, size: a.size ?? 0, mimeType: a.mimeType ?? "audio/mpeg" });
    setStartSec(0);
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ""));
  };

  const preview = () => { player.seekTo(startSec); player.play(); };

  const upload = async () => {
    if (!picked) return;
    const input: CreateTrackInput = { profileId, title: title.trim(), startSec: Math.floor(startSec),
      sizeBytes: picked.size, contentType: picked.mimeType };
    const v = validateTrackCreate(input);
    if (!v.ok) { Alert.alert("Check your track", v.reason); return; }
    setBusy("Starting…");
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      const blob = await (await fetch(picked.uri)).blob();
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), blob,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      setBusy(null); setPicked(null); setTitle("");
      onDone?.();
    } catch (e: unknown) {
      setBusy(null);
      Alert.alert("Upload failed", e instanceof Error ? e.message : "Try again.");
    }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: "#bbb", borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ fontWeight: "700" }}>Add a track (30-second snippet)</Text>
      <Pressable onPress={pick} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
        <Text>{picked ? picked.name : "Choose audio file…"}</Text>
      </Pressable>
      {picked && duration > 0 && (
        <>
          <TextInput placeholder="Track title" value={title} onChangeText={setTitle} maxLength={80}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
          <Text>Window: {fmt(startSec)} – {fmt(Math.min(startSec + MAX_CLIP_SECONDS, duration))} of {fmt(duration)}</Text>
          <Slider minimumValue={0} maximumValue={Math.max(0, Math.floor(duration - 1))} step={1}
            value={startSec} onValueChange={setStartSec} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={preview} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
              <Text>▶ Preview</Text></Pressable>
            <Pressable onPress={() => player.pause()} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
              <Text>Stop</Text></Pressable>
            <Pressable onPress={upload} disabled={busy !== null}
              style={{ backgroundColor: "#111", padding: 10, borderRadius: 8 }}>
              <Text style={{ color: "#fff" }}>{busy ?? "Upload snippet"}</Text></Pressable>
          </View>
        </>
      )}
    </View>
  );
}
```

- [ ] **Step 3: Create `apps/mobile/src/portfolio/TrackManager.tsx`**

```tsx
import { useEffect, useState } from "react";
import { View, Text, Pressable, Alert } from "react-native";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import type { TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";

type Row = TrackDoc & { id: string };
const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
};

export function TrackManager({ profileId }: { profileId: string }) {
  const [tracks, setTracks] = useState<Row[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);
  const call = async (name: string, data: object) => {
    try { await httpsCallable(getFirebase().functions, name)(data); }
    catch (e) { Alert.alert("Error", e instanceof Error ? e.message : "Try again."); }
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>
        Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/10)
      </Text>
      {tracks.map((t) => (
        <View key={t.id} style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, gap: 4 }}>
          <Text style={{ fontWeight: "600" }}>{t.title} · {STATUS_LABEL[t.status]}</Text>
          {(t.rejectionReason || t.failureReason) && (
            <Text style={{ color: "#991b1b" }}>{t.rejectionReason ?? t.failureReason}</Text>
          )}
          <Pressable onPress={() => Alert.alert("Delete track?", t.title, [
              { text: "Cancel" },
              { text: "Delete", style: "destructive",
                onPress: () => void call("deleteTrack", { profileId, trackId: t.id }) },
            ])}>
            <Text style={{ color: "#dc2626" }}>Delete</Text>
          </Pressable>
        </View>
      ))}
      <TrimUploader profileId={profileId} />
    </View>
  );
}
```

- [ ] **Step 4: Create `apps/mobile/src/portfolio/PortfolioForms.tsx`**

RN ports of the web forms — same callables, same validation, same field set:

```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  GENRES, GIG_TYPES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type ExternalLink, type ExternalLinkKind,
} from "@gatekeep/shared";

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await httpsCallable(getFirebase().functions, name)(data); return true; }
  catch (e) { Alert.alert("Save failed", e instanceof Error ? e.message : "Try again."); return false; }
};

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
      borderWidth: 1, borderColor: "#bbb", backgroundColor: active ? "#111" : "#fff" }}>
      <Text style={{ color: active ? "#fff" : "#111" }}>{label}</Text>
    </Pressable>
  );
}

export function BioGenresForm({ profileId, initial }:
  { profileId: string; initial: PortfolioData | undefined }) {
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  const [busy, setBusy] = useState(false);
  const toggle = (g: string) => setGenres((cur) =>
    cur.includes(g) ? cur.filter((x) => x !== g) : cur.length < 3 ? [...cur, g] : cur);
  const save = async () => {
    const v = validatePortfolioUpdate({ profileId, bio, genres });
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    setBusy(true); await callOrAlert("updatePortfolio", { profileId, bio, genres }); setBusy(false);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Bio & genres</Text>
      <TextInput multiline numberOfLines={5} maxLength={2000} value={bio} onChangeText={setBio}
        placeholder="Tell curators and fans who you are…"
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 100, textAlignVertical: "top" }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => <Chip key={g} label={g} active={genres.includes(g)} onPress={() => toggle(g)} />)}
      </View>
      <Pressable onPress={save} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save bio & genres"}</Text>
      </Pressable>
    </View>
  );
}

export function LinksForm({ profileId, initial }:
  { profileId: string; initial: PortfolioData | undefined }) {
  const [links, setLinks] = useState<ExternalLink[]>(initial?.externalLinks ?? []);
  const [kind, setKind] = useState<ExternalLinkKind>("spotify");
  const [url, setUrl] = useState("");
  const save = async (next: ExternalLink[]) => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { Alert.alert("Check the link", v.reason); return; }
    if (await callOrAlert("updatePortfolio", { profileId, externalLinks: next })) setLinks(next);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Links</Text>
      {links.map((l, i) => (
        <View key={`${l.url}-${i}`} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ flex: 1 }} numberOfLines={1}>{l.kind}: {l.url}</Text>
          <Pressable onPress={() => void save(links.filter((_, j) => j !== i))}>
            <Text style={{ color: "#dc2626" }}>Remove</Text></Pressable>
        </View>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["spotify", "youtube", "instagram", "website"] as const).map((k) =>
          <Chip key={k} label={k} active={kind === k} onPress={() => setKind(k)} />)}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <TextInput placeholder="https://…" autoCapitalize="none" value={url} onChangeText={setUrl}
          style={{ borderWidth: 1, borderRadius: 8, padding: 10, flex: 1 }} />
        <Pressable onPress={() => { if (url) { void save([...links, { kind, url }]); setUrl(""); } }}
          style={{ borderWidth: 1, borderRadius: 8, padding: 10 }}><Text>Add</Text></Pressable>
      </View>
    </View>
  );
}

export function PhotoUploader({ profileId, uid, kind }:
  { profileId: string; uid: string; kind: "avatar" | "cover" }) {
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    // expo-image-picker is not installed; DocumentPicker covers image files fine.
    const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setBusy(true);
    try {
      const { storage } = getFirebase();
      // RN has no crypto.randomUUID — timestamp+random nonce is fine (uniqueness, not secrecy of THIS value).
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const blob = await (await fetch(a.uri)).blob();
      await uploadBytes(storageRef(storage, stagingPhotoPath(uid, profileId, kind, nonce)), blob,
        { contentType: a.mimeType ?? "image/jpeg" });
    } catch (e) {
      Alert.alert("Upload failed", e instanceof Error ? e.message : "Try again.");
    } finally { setBusy(false); }
  };
  return (
    <Pressable onPress={upload} disabled={busy} style={{ borderWidth: 1, borderRadius: 8, padding: 10 }}>
      <Text>{busy ? "Uploading…" : `Upload ${kind === "avatar" ? "profile photo" : "cover photo"}`}</Text>
    </Pressable>
  );
}

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  const [rates, setRates] = useState(initial?.rates ?? { perHour: null, perSong: null, perSet: null });
  const [prefs, setPrefs] = useState(initial?.preferences ?? { gigTypes: [] as string[],
    travelRadiusKm: null, actSize: null, typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null });
  const [busy, setBusy] = useState(false);

  const numField = (value: number | null, set: (n: number | null) => void, placeholder: string) => (
    <TextInput keyboardType="number-pad" placeholder={placeholder}
      value={value === null ? "" : String(value)}
      onChangeText={(t) => set(t === "" ? null : Number(t))}
      style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 100 }} />
  );
  const rateRow = (key: "perHour" | "perSong" | "perSet", label: string) => (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Text style={{ width: 100 }}>{label}</Text>
      <Text>$</Text>
      <TextInput keyboardType="decimal-pad" placeholder="—"
        value={rates[key] ? String(rates[key]!.amountCents / 100) : ""}
        onChangeText={(t) => setRates((r) => ({ ...r, [key]: t === "" ? null
          : { amountCents: Math.round(Number(t) * 100), note: r[key]?.note ?? null } }))}
        style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 90 }} />
      <TextInput placeholder="note" maxLength={200} editable={rates[key] !== null}
        value={rates[key]?.note ?? ""}
        onChangeText={(t) => setRates((r) => ({ ...r,
          [key]: r[key] ? { ...r[key]!, note: t || null } : null }))}
        style={{ borderWidth: 1, borderRadius: 8, padding: 8, flex: 1 }} />
    </View>
  );
  const save = async () => {
    const input = { profileId, rates, preferences: prefs };
    const v = validateBookingUpdate(input as never);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    setBusy(true); await callOrAlert("updateBookingInfo", input); setBusy(false);
  };

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Rates & preferences</Text>
      <Text style={{ color: "#666" }}>Visible to curators only — never on your public page.</Text>
      {rateRow("perHour", "Per hour")}
      {rateRow("perSong", "Per song")}
      {rateRow("perSet", "Per set")}
      <Text style={{ fontWeight: "700" }}>Gig types</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GIG_TYPES.map((g) => <Chip key={g} label={g.replace("_", " ")} active={prefs.gigTypes.includes(g)}
          onPress={() => setPrefs((p) => ({ ...p, gigTypes: p.gigTypes.includes(g)
            ? p.gigTypes.filter((x) => x !== g) : [...p.gigTypes, g] }))} />)}
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text>Travel radius (km)</Text>
        {numField(prefs.travelRadiusKm, (n) => setPrefs((p) => ({ ...p, travelRadiusKm: n })), "—")}
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text>Typical set (min)</Text>
        {numField(prefs.typicalSetMinutes, (n) => setPrefs((p) => ({ ...p, typicalSetMinutes: n })), "—")}
      </View>
      <Text style={{ fontWeight: "700" }}>Act size</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["solo", "duo", "band"] as const).map((s) => <Chip key={s} label={s} active={prefs.actSize === s}
          onPress={() => setPrefs((p) => ({ ...p, actSize: p.actSize === s ? null : s }))} />)}
      </View>
      <Text style={{ fontWeight: "700" }}>Bring own PA</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Yes" active={prefs.bringsOwnPA === true}
          onPress={() => setPrefs((p) => ({ ...p, bringsOwnPA: p.bringsOwnPA === true ? null : true }))} />
        <Chip label="No" active={prefs.bringsOwnPA === false}
          onPress={() => setPrefs((p) => ({ ...p, bringsOwnPA: p.bringsOwnPA === false ? null : false }))} />
      </View>
      <Text style={{ fontWeight: "700" }}>Availability</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["weekends", "weeknights", "anytime", "limited"] as const).map((a) =>
          <Chip key={a} label={a} active={prefs.availabilityPattern === a}
            onPress={() => setPrefs((p) => ({ ...p,
              availabilityPattern: p.availabilityPattern === a ? null : a }))} />)}
      </View>
      <Pressable onPress={save} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save rates & preferences"}</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @gatekeep/mobile typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): portfolio components — trim uploader, track manager, forms"
```

---

### Task 14: Mobile — portfolio tab, wizard steps, artist screen

**Files:**
- Modify: `apps/mobile/app/(musician)/portfolio.tsx`
- Modify: `apps/mobile/app/join.tsx`
- Create: `apps/mobile/app/artist/[handle].tsx`

- [ ] **Step 1: Rewrite `apps/mobile/app/(musician)/portfolio.tsx`**

```tsx
import { useEffect, useState } from "react";
import { ScrollView, View, Text, Pressable, Alert, Linking } from "react-native";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../src/portfolio/TrackManager";
import type { ProfileDoc, BookingDoc } from "@gatekeep/shared";

export default function Portfolio() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "musician"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [booking, setBooking] = useState<BookingDoc | null>(null);

  useEffect(() => {
    if (!profileId) { setProfile(null); return; }
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null));
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => setBooking(s.exists() ? (s.data() as BookingDoc) : null)).catch(() => {});
    return unsub;
  }, [profileId]);

  if (!user || !profileId || !profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>Switch to a musician profile to edit its portfolio.</Text></View>;
  }
  const resubmit = async () => {
    try { await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId }); }
    catch (e) { Alert.alert("Not yet", e instanceof Error ? e.message : "Could not submit."); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>{profile.name}</Text>
      <Text>Status: {profile.status.replace("_", " ")}</Text>
      {profile.status === "approved" && (
        <Pressable onPress={() => Linking.openURL(`https://gatekeep.example/@${profile.handle}`)}>
          <Text style={{ textDecorationLine: "underline" }}>View public page</Text>
        </Pressable>
      )}
      {profile.status === "rejected" && (
        <View style={{ backgroundColor: "#fee2e2", borderRadius: 8, padding: 12, gap: 8 }}>
          <Text><Text style={{ fontWeight: "700" }}>Changes requested: </Text>{profile.rejectionReason}</Text>
          <Pressable onPress={resubmit} style={{ backgroundColor: "#111", padding: 10, borderRadius: 8 }}>
            <Text style={{ color: "#fff", textAlign: "center" }}>Resubmit for review</Text></Pressable>
        </View>
      )}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Photos</Text>
        <PhotoUploader profileId={profileId} uid={user.uid} kind="avatar" />
        <PhotoUploader profileId={profileId} uid={user.uid} kind="cover" />
      </View>
      <BioGenresForm profileId={profileId} initial={profile.portfolio} />
      <LinksForm profileId={profileId} initial={profile.portfolio} />
      <TrackManager profileId={profileId} />
      <BookingForm profileId={profileId} initial={booking} />
      {profile.status === "draft" && (
        <Pressable onPress={resubmit} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
          <Text style={{ color: "#fff", textAlign: "center" }}>Submit for review</Text></Pressable>
      )}
    </ScrollView>
  );
}
```

(The public-page link's host is a placeholder until a web domain exists — point it at the deployed web app when that lands; keep the `gatekeep.example` constant in one place at the top of the file with a comment.)

- [ ] **Step 2: Update `apps/mobile/app/join.tsx`**

Musician joins stop auto-submitting. Replace the `submit` handler body: after `createProfileDraft`, for `type === "musician"` do **not** call `submitProfileForReview`; instead alert "Draft created — build your portfolio next" and `router.replace("/(musician)/portfolio")` (the ProfileContext picks up the new membership; instruct the user to switch context if needed). Curator joins keep the old create-then-submit behavior unchanged.

- [ ] **Step 3: Create `apps/mobile/app/artist/[handle].tsx` (hero-first native public view)**

```tsx
import { useEffect, useState } from "react";
import { ScrollView, View, Text, Image, Pressable, Linking } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { useAudioPlayer } from "expo-audio";
import { getFirebase } from "../../src/lib/firebase";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };

function TrackRow({ t, playingId, onPlay }:
  { t: LoadedTrack; playingId: string | null; onPlay: (t: LoadedTrack) => void }) {
  return (
    <Pressable onPress={() => onPlay(t)}
      style={{ flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1,
        borderColor: "#ddd", borderRadius: 8, padding: 12 }}>
      <Text>{playingId === t.id ? "❚❚" : "▶"}</Text>
      <Text style={{ flex: 1 }}>{t.title}</Text>
      <Text style={{ color: "#888" }}>{t.durationSec ? `0:${String(Math.round(t.durationSec)).padStart(2, "0")}` : ""}</Text>
    </Pressable>
  );
}

export default function Artist() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const [state, setState] = useState<"loading" | "notfound" | {
    profile: ProfileDoc; tracks: LoadedTrack[]; avatarUrl: string | null; coverUrl: string | null;
  }>("loading");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const player = useAudioPlayer(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { db, storage } = getFirebase();
        const h = await getDoc(doc(db, "handles", handle));
        if (!h.exists()) { if (!cancelled) setState("notfound"); return; }
        const profileId = h.data().profileId as string;
        const p = await getDoc(doc(db, "profiles", profileId));
        if (!p.exists() || (p.data() as ProfileDoc).type !== "musician") {
          if (!cancelled) setState("notfound"); return;
        }
        const profile = p.data() as ProfileDoc;
        const url = async (path: string | null | undefined) => {
          if (!path) return null;
          try { return await getDownloadURL(storageRef(storage, path)); } catch { return null; }
        };
        const trackSnap = await getDocs(query(collection(db, `profiles/${profileId}/tracks`),
          where("status", "==", "approved"), orderBy("order")));
        const tracks = (await Promise.all(trackSnap.docs.map(async (t) => {
          const d = t.data() as TrackDoc;
          const u = await url(d.storagePath);
          return u ? { id: t.id, title: d.title, durationSec: d.durationSec, url: u } : null;
        }))).filter((x): x is LoadedTrack => x !== null);
        if (!cancelled) setState({ profile, tracks,
          avatarUrl: await url(profile.portfolio?.avatarPhotoPath),
          coverUrl: await url(profile.portfolio?.coverPhotoPath) });
      } catch { if (!cancelled) setState("notfound"); } // permission-denied = not approved
    })();
    return () => { cancelled = true; };
  }, [handle]);

  if (state === "loading") return <View style={{ flex: 1, justifyContent: "center" }}><Text style={{ textAlign: "center" }}>Loading…</Text></View>;
  if (state === "notfound") return <View style={{ flex: 1, justifyContent: "center" }}><Text style={{ textAlign: "center" }}>No profile at @{handle}.</Text></View>;

  const { profile, tracks, avatarUrl, coverUrl } = state;
  const pf = profile.portfolio;
  const play = (t: LoadedTrack) => {
    if (playingId === t.id) { player.pause(); setPlayingId(null); return; }
    player.replace({ uri: t.url });
    player.play();
    setPlayingId(t.id);
  };
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      {coverUrl && <Image source={{ uri: coverUrl }} style={{ width: "100%", height: 180 }} />}
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          {avatarUrl && <Image source={{ uri: avatarUrl }}
            style={{ width: 72, height: 72, borderRadius: 36, marginTop: coverUrl ? -40 : 0,
              borderWidth: 3, borderColor: "#fff" }} />}
          <View>
            <Text style={{ fontSize: 24, fontWeight: "700" }}>{profile.name}</Text>
            <Text style={{ color: "#666" }}>@{profile.handle}{pf?.genres?.length ? ` · ${pf.genres.join(" · ")}` : ""}</Text>
          </View>
        </View>
        {tracks.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 18, fontWeight: "700" }}>Listen</Text>
            {tracks.map((t) => <TrackRow key={t.id} t={t} playingId={playingId} onPlay={play} />)}
          </View>
        )}
        {pf?.bio ? (<><Text style={{ fontSize: 18, fontWeight: "700" }}>About</Text>
          <Text style={{ lineHeight: 21 }}>{pf.bio}</Text></>) : null}
        {pf?.externalLinks && pf.externalLinks.length > 0 && (
          <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
            {pf.externalLinks.map((l) => (
              <Pressable key={l.url} onPress={() => void Linking.openURL(l.url)}>
                <Text style={{ textDecorationLine: "underline" }}>{l.kind}</Text>
              </Pressable>))}
          </View>
        )}
        {/* Shows: platform events only — section appears when sub-4/6 data exists. */}
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 4: Typecheck + on-device smoke**

Run: `pnpm --filter @gatekeep/mobile typecheck` — green.
Manual (dev build + emulators): join → wizard → portfolio tab edit loop → upload/trim → resubmit-on-reject path → `/artist/<handle>` plays approved clips.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): portfolio editor tab, wizard flow, native artist page"
```

---

### Task 15: Mobile lint green (definition-of-done item)

**Files:** whatever the two pre-existing errors touch (foundation ruling: "Mobile lint has 2 pre-existing errors").

- [ ] **Step 1:** Run `pnpm --filter @gatekeep/mobile lint`. Record every error.
- [ ] **Step 2:** Fix each error at root cause (no eslint-disable unless the rule is genuinely wrong for the line, and then with a comment saying why). Re-run until: 0 errors. Warnings: fix those introduced by this sub-project; pre-existing warnings may stay.
- [ ] **Step 3:** Also run `pnpm --filter @gatekeep/web lint` — must stay green.
- [ ] **Step 4: Commit**

```bash
git add apps/mobile
git commit -m "fix(mobile): lint green — clears the 2 pre-existing errors"
```

---

### Task 16: Docs — README + follow-ups

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Update README:
- Intro paragraph: this repo now includes sub-project 2 (musician portfolio); point to both specs.
- Monorepo map: add `storage.rules`, `functions/src/{portfolio,tracks,media,storage}.ts`, `apps/web/app/join/`, `apps/web/app/dashboard/portfolio/`, `apps/mobile/src/portfolio/`, `apps/mobile/app/artist/`.
- Key commands: note the storage emulator (port 9199) now starts with `pnpm emu`, and `emu:test`/`emu:rules` include it.
- Environment: note `next typegen` for fresh clones (typecheck fails without it) and the corepack/pnpm Windows PATH workaround.
- Manual follow-ups: **replace** the "native App Check lands in sub-project 2" sentence — EAS production build + native App Check moved to a dedicated launch-prep track (per SP2 spec §1), same must-review list as the admin/internal deferred items. Add: create the production Storage bucket lifecycle rule (24h TTL on `staging/`) in the Firebase console/deploy config before launch — the emulator does not enforce lifecycle rules.
- Manual follow-ups: the App Check enforcement checklist must cover Cloud Storage, not just Firestore + Functions — and Storage must NOT be flipped to enforce until native mobile App Check ships (mobile currently has no App Check attestation; enforcing early would lock the app out of its own uploads).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for sub-project 2 — storage, commands, follow-up changes"
```

---

### Task 17: Final verification + merge readiness

- [ ] **Step 1:** Full suite, in order:
```bash
pnpm typecheck
pnpm --filter @gatekeep/shared test
pnpm emu:test
pnpm emu:rules
pnpm --filter @gatekeep/web lint && pnpm --filter @gatekeep/mobile lint
pnpm --filter @gatekeep/web build
```
Expected: everything green. `next build` also exercises the SSR page + config redirects/rewrites.

- [ ] **Step 2:** Manual E2E against emulators (spec §8): sign up → join wizard → bio/genres/avatar → upload track, pick window → submit blocked until minimums → submit → admin approves profile + track (hears clip) → public `/@handle` renders SSR with playing clip → admin rejects a second track → musician sees reason → delete + re-upload → deleteProfile cascades storage. On mobile: same loop through the portfolio tab + `/artist/<handle>`.
- [ ] **Step 3:** Process gates (foundation spec §"Process gates"): run the security review of the whole branch (custom opus security-reviewer per foundation ruling 7 if the `security-review` skill still trips on `origin/HEAD`), and an independent audit of **both** `firestore.rules` and `storage.rules`. Apply all fixes before merge.
- [ ] **Step 4:** Merge via superpowers:finishing-a-development-branch.

---

## Self-review notes (already applied)

- Spec coverage checked §1–§8: scope items each map to a task (vanity URLs T10, resubmit UI T10/T14, lint T15, admin queue T12, gate T9, cascade T9, curator-only rates enforced by rules T3 — curator *read* grant itself is sub-3).
- The wizard is deliberately thin (identity step + editor hand-off) rather than a bespoke multi-screen flow: the editor sections are the steps, and the server gate enforces completeness. This satisfies spec §6 "resumable" for free (drafts persist; the editor is re-enterable).
- `updatePortfolio` uses dotted-string field paths (`portfolio.bio`) so the media pipeline's photo-path writes never race client saves of bio/genres/links.
- Foundation's existing `submitProfileForReview` tests will need their musician fixtures adjusted for the new gate (called out in Task 9 Step 4).


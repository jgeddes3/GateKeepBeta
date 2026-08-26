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
functions/src/guards.ts                 C  requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile
functions/src/storage.ts               C  bucket helper + STORAGE_BUCKET
functions/src/portfolio.ts             C  updatePortfolio, updateBookingInfo
functions/src/tracks.ts                C  createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack
functions/src/media.ts                 C  processUpload trigger (audio transcode + photo resize)
functions/src/profiles.ts              M  submit minimum-content gate, portfolio seed, delete cascade
functions/src/members.ts               M  verified-email gate on respondToInvite
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
apps/web/app/u/[handle]/not-found.tsx  C  generic 404 UI (real HTTP 404 via notFound())
apps/web/app/u/[handle]/portfolio.module.css C
apps/web/app/u/[handle]/TrackPlayer.tsx C  client audio player
apps/web/app/globals.css               M  drop the body copy of overflow-x: hidden
apps/web/app/layout.tsx                M  metadataBase for relative canonical/OG URLs
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
      collection(anon, "profiles/prof1/tracks"), where("status", "==", "approved"), orderBy("order"))));
    await assertFails(getDocs(collection(anon, "profiles/prof1/tracks"))); // unfiltered list
  });
  it("no public track reads on a non-approved profile; members read all their own", async () => {
    await seedProfile("draft");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Rejected", status: "rejected", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
    // Even the production-shaped filtered+ordered list query must fail here —
    // the profile itself is not approved, so no list shape helps.
    await assertFails(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where("status", "==", "approved"), orderBy("order"))));
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
    // Admins get elevated read, never write — writes stay Cloud Functions only.
    await assertFails(setDoc(doc(admin, "profiles/prof1/tracks/hax2"), { title: "h", status: "approved" }));
    await assertSucceeds(getDocs(query(
      collectionGroup(admin, "tracks"), where("status", "==", "pending_review"))));
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDocs(query(
      collectionGroup(bob, "tracks"), where("status", "==", "pending_review"))));
  });
  it("membership does not leak across profiles", async () => {
    await seedProfile("approved"); // prof1 / alice, as the existing helper does
    await seed("profiles/prof2", { type: "musician", name: "B", handle: "b", status: "approved" });
    await seed("profiles/prof2/tracks/p", { title: "SECRET", status: "pending_review", order: 0 });
    await seed("profiles/prof2/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "profiles/prof2/tracks/p")));
    await assertFails(getDocs(collection(alice, "profiles/prof2/tracks")));
    await assertFails(getDoc(doc(alice, "profiles/prof2/private/booking")));
  });
});

describe("private booking subdoc", () => {
  it("members and admins read; strangers and anon cannot; nobody writes", async () => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status: "approved" });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/prof1/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    // A sibling doc under private/ — pins that the rule is scoped to the
    // literal `booking` doc id, not a wildcard over all of private/.
    await seed("profiles/prof1/private/secrets", { apiKey: "nope" });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/private/booking")));
    await assertSucceeds(getDoc(doc(admin, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(bob, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(anon, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(alice, "profiles/prof1/private/secrets")));
    await assertFails(getDoc(doc(admin, "profiles/prof1/private/secrets")));
    await assertFails(setDoc(doc(alice, "profiles/prof1/private/booking"), { rates: {} }));
    await assertFails(setDoc(doc(admin, "profiles/prof1/private/booking"), { rates: {} }));
  });
});
```

(`orderBy` must be imported alongside the existing `query`/`where` import.)

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
        // Read-free checks first — profileApproved() is a billed get() — so
        // member/admin reads short-circuit before paying for it.
        allow read: if isAdmin() || isMember(profileId)
          || (profileApproved(profileId) && resource.data.status == 'approved');
        allow write: if false; // Cloud Functions only
      }

      match /private/booking {
        // Rates/preferences: never public. Sub-project 3 widens this to
        // members of approved curator profiles.
        allow read: if isMember(profileId) || isAdmin();
        allow write: if false; // Cloud Functions only
      }
```

Also reorder the existing `members` block's `get` clause for the same read-free-first
reason (profileApproved() moves last):

```
      match /members/{memberUid} {
        // self-read clause serves the collection-group "my profiles" query.
        // Ordered read-free/cheap checks first — profileApproved() is a
        // billed get() — so the common non-admin, non-approved-profile
        // paths short-circuit before paying for it.
        allow get: if isAdmin() || isMember(profileId)
          || (signedIn() && request.auth.uid == resource.data.uid) || profileApproved(profileId);
        ...
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

The `tracks.status` fieldOverride below (COLLECTION + COLLECTION_GROUP) replaces
the default single-field index Firestore would otherwise auto-create for that
field — it does not add ordering by `status` on its own; the admin queue's
`orderBy` (if any is ever added) would need its own composite entry, so don't
add `orderBy("status", "desc")` to a query without adding the matching index
back here first.

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
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { ref, uploadBytes, getBytes, getDownloadURL, listAll, deleteObject } from "firebase/storage";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    storage: { rules: readFileSync("../storage.rules", "utf8"), host: "localhost", port: 9199 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearStorage(); });

const bytes = new Uint8Array([1, 2, 3]);
const meta = (contentType: string) => ({ contentType });

describe("storage: staging/audio", () => {
  it("owner uploads audio to own staging path; wrong uid, wrong type, zero-byte fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    const bob = env.authenticatedContext("bob").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t1"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(bob, "staging/audio/alice/p1/t2"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t3"), bytes, meta("video/mp4")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t4"), new Uint8Array(0), meta("audio/mpeg")));
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
  it("retrying an upload (create then update) to the same staging path is allowed", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg"))); // retry = update
  });
  it("a literal '..' profileId or trackId segment, or a dot-containing profileId, is rejected", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/../t11"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/.."), bytes, meta("audio/mpeg")));
    // "bad.id" fails the profileId char class regardless of whether the SDK
    // normalizes ".." segments before the request reaches the rules engine.
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/bad.id/t1"), bytes, meta("audio/mpeg")));
  });
});

describe("storage: staging/photos", () => {
  it("owner uploads images with a well-formed avatar/cover name; bad names/types fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/cover-xyz"), bytes, meta("image/png")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-webp1"), bytes, meta("image/webp")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc"), bytes, meta("application/pdf")));
  });
  it("owner cannot delete a staging photo either; the trigger owns cleanup", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-del1"), bytes, meta("image/jpeg")));
    await assertFails(deleteObject(ref(alice, "staging/photos/alice/p1/avatar-del1")));
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
  it("review reads are admin-only", async () => {
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
  it("review and public are pipeline-only, even for admins", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/pz/t.m4a"), bytes, meta("audio/mp4"));
    });
    const admin = env.authenticatedContext("root", { admin: true }).storage();
    // Admin context is required: rules are default-deny, so a non-admin assertion
    // cannot tell `write: if false` from `write: if isAdmin()`.
    await assertFails(uploadBytes(ref(admin, "review/tracks/pz/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(uploadBytes(ref(admin, "public/tracks/pz/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(deleteObject(ref(admin, "public/tracks/pz/t.m4a")));
  });
  it("regression guard: public getDownloadURL works", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t2.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    // The app's real read path — must survive any future tightening of the get/list split.
    await assertSucceeds(getDownloadURL(ref(anon, "public/tracks/p1/t2.m4a")));
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
git commit -m "test(rules): mutation-killing storage cases — admin write denial, trackId pattern, webp/zero-byte"
```

---

### Task 5: Functions — portfolio + booking callables

**Files:**
- Create: `functions/src/guards.ts` (requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile)
- Create: `functions/src/portfolio.ts`
- Modify: `functions/src/members.ts` (verified-email gate on `respondToInvite`)
- Modify: `functions/src/index.ts`
- Modify: `functions/src/profiles.ts` (seed empty portfolio on musician drafts)
- Test: `functions/test/portfolio.test.ts`
- Test: `functions/test/members.test.ts` (unverified invitee case)

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

- [ ] **Step 3: Create `functions/src/guards.ts`**

Shared onCall guards used by portfolio.ts (and, from Task 6 on, tracks.ts).
`profiles.ts`/`members.ts` keep their own local `requireAuth`/`requireVerifiedEmail`
copies for now — consolidating those is deferred to sub-project 3 — except that
`members.ts` gains one new call site (Step 4a below) reusing its existing local copy.

```ts
import { HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type DocumentSnapshot } from "firebase-admin/firestore";

export function requireAuthUid(req: { auth?: { uid?: string } }): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

export function requireVerifiedEmail(req: { auth?: { token?: Record<string, unknown> } }): void {
  if (req.auth?.token?.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Please verify your email address first.");
  }
}

// Any member may edit portfolio content (spec §6) — contrast requireProfileAdmin
// in profiles.ts, which gates membership/deletion actions.
export async function requireProfileMember(profileId: string, uid: string): Promise<void> {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists) throw new HttpsError("permission-denied", "Only profile members can do that.");
}

export async function requireMusicianProfile(profileId: string): Promise<DocumentSnapshot> {
  const p = await getFirestore().doc(`profiles/${profileId}`).get();
  if (!p.exists) throw new HttpsError("not-found", "Profile not found.");
  if (p.data()?.type !== "musician") {
    throw new HttpsError("failed-precondition", "Portfolios belong to musician profiles.");
  }
  return p;
}
```

- [ ] **Step 4: Create `functions/src/portfolio.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioUpdateInput, type BookingUpdateInput, type BookingDoc, type RateAmount, type PortfolioData,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";

// Strips any extra/untrusted keys off a rate object and normalizes an
// absent (undefined) rate the same as an explicit null. Without this, a
// member could persist arbitrary extra keys/nested JSON into
// private/booking by reference — and `note` could end up absent from the
// stored doc even though RateAmount promises it present-and-nullable.
const rate = (r: RateAmount | null | undefined): RateAmount | null =>
  r == null ? null : { amountCents: r.amountCents, note: r.note ?? null };

export const updatePortfolio = onCall<PortfolioUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validatePortfolioUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate — parallelizing makes rejection order
  // nondeterministic and would leak profile existence/type to non-members
  await requireProfileMember(input.profileId, uid);
  const snap = await requireMusicianProfile(input.profileId);

  // Dotted-string-keys form: the Admin SDK treats dotted string keys in a
  // plain object passed to update() as field paths, so this merges into the
  // portfolio map without clobbering the photo paths the media pipeline owns.
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.bio !== undefined) updates["portfolio.bio"] = input.bio.trim();
  if (input.genres !== undefined) updates["portfolio.genres"] = input.genres;
  // Explicit mapping: stores only the validated fields (an untrusted link object
  // could carry extra keys) and the trimmed URL the validator actually checked.
  if (input.externalLinks !== undefined) {
    updates["portfolio.externalLinks"] = input.externalLinks.map((l) => ({ kind: l.kind, url: l.url.trim() }));
  }

  // Legacy data: profiles created before the portfolio seed (this task) may
  // lack the portfolio map entirely, or hold only a partial map (e.g. the
  // media pipeline wrote avatarPhotoPath before any updatePortfolio call
  // ever ran). Backfill is field-wise, not map-level, so a partial legacy
  // map still ends up complete — and photo paths are only null-defaulted
  // when genuinely absent, never clobbered.
  const pf = snap.data()?.portfolio as Partial<PortfolioData> | undefined;
  if (input.bio === undefined && pf?.bio === undefined) updates["portfolio.bio"] = "";
  if (input.genres === undefined && pf?.genres === undefined) updates["portfolio.genres"] = [];
  if (input.externalLinks === undefined && pf?.externalLinks === undefined) updates["portfolio.externalLinks"] = [];
  if (pf?.avatarPhotoPath === undefined) updates["portfolio.avatarPhotoPath"] = null;
  if (pf?.coverPhotoPath === undefined) updates["portfolio.coverPhotoPath"] = null;

  await getFirestore().doc(`profiles/${input.profileId}`).update(updates);
  return { ok: true };
});

export const updateBookingInfo = onCall<BookingUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateBookingUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate — parallelizing makes rejection order
  // nondeterministic and would leak profile existence/type to non-members
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);
  // Normalize absent → null and strip untrusted extra keys via `rate()`:
  // the validator accepts omitted keys, the stored BookingDoc promises
  // present-and-nullable, and Firestore rejects `undefined`.
  const docData: BookingDoc = {
    rates: {
      perHour: rate(input.rates.perHour),
      perSong: rate(input.rates.perSong),
      perSet: rate(input.rates.perSet),
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
  // full-doc last-write-wins between members is accepted for v1; a delete
  // racing this write can recreate an orphaned booking doc — accepted,
  // mirrors account.ts's documented-race precedent
  await getFirestore().doc(`profiles/${input.profileId}/private/booking`).set(docData);
  return { ok: true };
});
```

- [ ] **Step 4a: Gate `respondToInvite` on verified email in `functions/src/members.ts`**

Closes a pre-existing gap: an unverified pre-registered account could otherwise
accept an invite and immediately edit content. `members.ts` already defines a
local `requireVerifiedEmail` (used by `inviteMember`) — reuse it rather than
duplicating; add one call at the top of `respondToInvite`:

```ts
export const respondToInvite = onCall<{ inviteId: string; accept: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    requireVerifiedEmail(req);
    const { inviteId, accept } = req.data;
    // ...unchanged...
```

- [ ] **Step 4b: Seed empty portfolio in `functions/src/profiles.ts`**

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
- Create: `functions/src/tracks.ts` (createTrack/updateTrack/deleteTrack/reorderTracks here; reviewTrack in Task 8)
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
// env override so a future prod deploy can't silently write to the dev bucket.
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "gatekeep-dev-jg.firebasestorage.app";
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
  adb: Firestore, docPath: string, statuses: string[], timeoutMs = 45_000,
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
  it("rejects a non-member with permission-denied", async () => {
    const { profileId } = await makeMusician("ct3");
    const { user: stranger } = await signUpTestUser(`ct3s-${Date.now()}@test.com`);
    await expect(callFn("createTrack", input(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  // Split from a single overclaiming test during code review: the original
  // title promised unverified-email and curator-profile coverage it didn't
  // actually exercise. See functions/test/tracks.test.ts for the full cases
  // (unverified member via an admin-SDK-seeded membership doc, and a curator
  // profile via createProfileDraft), plus a concurrent-create regression test
  // that seeds 8 active tracks and fires 6 parallel createTrack calls to
  // confirm the transaction serializes to exactly 2 fulfilled + 4
  // resource-exhausted (never 11 tracks).
});

describe("updateTrack / deleteTrack", () => {
  // updateTrack is title-only — order lives on reorderTracks now (see below);
  // a lone updateTrack("order") writer would race a concurrent reorderTracks
  // transaction and silently reintroduce duplicate order values.
  it("member retitles; deleteTrack removes the doc", async () => {
    const { user, profileId } = await makeMusician("ut1");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    await callFn("updateTrack", { profileId, trackId, title: "Renamed" }, user);
    let t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Renamed" });
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

describe("reorderTracks", () => {
  it("normalizes order 0..n-1 for the given sequence, then heals unmentioned tracks in their prior relative order", async () => {
    const { user, profileId } = await makeMusician("rt1");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { trackId } = await callFn<CreateTrackInput, { trackId: string }>(
        "createTrack", input(profileId, `T${i}`), user);
      ids.push(trackId);
    }
    const [t0, t1, t2] = ids;
    await callFn("reorderTracks", { profileId, trackIds: [t2, t0, t1] }, user); // → order 0,1,2
    // A later partial/stale list — only [t1] — puts t1 first; t2/t0 keep
    // their prior relative order (t2 before t0) rather than resetting.
    await callFn("reorderTracks", { profileId, trackIds: [t1] }, user); // → t1, t2, t0
  });
  // See functions/test/tracks.test.ts for the full suite, including a
  // duplicate-order healing case: reject the highest-order track (it drops
  // out of the active-track max used by createTrack's order calc, but its
  // own order field is untouched), create a replacement (which can reuse
  // that same order number), then confirm reorderTracks renormalizes every
  // track in the collection — active or not — back to unique 0..n-1. Also a
  // 21-doc case (10 active + 11 dead, seeded via the admin SDK) confirming
  // the 200-id bound comfortably clears real-world reject/create churn.
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm emu:test`
Expected: tracks tests FAIL (createTrack not found).

- [ ] **Step 6: Create `functions/src/tracks.ts` (CRUD part)**

Note (reviewed, accepted): `uploaderUid` on track docs is world-readable once a track is approved. This matches the existing posture (member docs of approved profiles are already `get`-able) and the trigger needs it; do not "fix" it silently — any change is a product decision.

Note (code review, applied): the first-cut version of this file had two bugs
and a missing feature, fixed in the snippet below —
1. `order: active.size` reused order numbers after a delete-then-add cycle
   (the deleted track's slot number gets handed to the next create, but nothing
   guarantees uniqueness against a track that was merely rejected, not
   deleted — see the `reorderTracks` duplicate-order-healing test). Fixed by
   computing `max(existing ACTIVE orders) + 1` instead of counting. Note this
   max is only over active docs, so a reject-then-create can still collide
   with a dead (rejected/failed) doc's leftover order value — accepted,
   since `reorderTracks` heals it on the next reorder.
2. The planned web `TrackManager.move()` UI would have done its reordering as
   two sequential `updateTrack({ order })` calls per swap — non-atomic (a
   crash/reload between the two calls leaves two tracks with the same order),
   and a no-op on ties. Replaced with a dedicated `reorderTracks` callable
   that renormalizes the whole list to 0..n-1 in one transaction.
3. `updateTrack`/`deleteTrack` used plain `typeof` checks instead of
   `isValidDocId`, and neither gated on verified email (every other mutating
   callable in this codebase does). Both fixed. `updateTrack` also lost its
   `order` parameter (subsumed by `reorderTracks`) and its pre-`get()`
   existence check, which had a TOCTOU gap against a racing `deleteTrack` —
   it now lets `update()` itself throw NOT_FOUND (gRPC code 5) and maps that
   to `HttpsError("not-found", ...)`.

Note (second review pass, applied): `reorderTracks`'s id-count bound was
originally 20, matching `MAX_TRACKS`-ish intuition — but the list it validates
is every doc in the collection (the web `TrackManager` sends `tracks.map(t =>
t.id)` for its full onSnapshot result, not just the 10 active ones), and
rejected/failed docs persist by design. Ordinary reject-then-create churn can
reach 21+ docs over a profile's lifetime, so the bound is now 200 (comfortably
under Firestore's 500-writes-per-transaction limit) with its own error
message, split out from the other (non-empty/unique/valid-id) checks.

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, isValidDocId, stagingAudioPath, reviewTrackPath, publicTrackPath, MAX_TRACKS,
  type CreateTrackInput, type TrackDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";
import { bucket } from "./storage.js";

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count. Exported (Task 8 hardening)
// so Task 9's submit minimum-content gate can import it instead of
// re-hardcoding the list.
export const ACTIVE_TRACK_STATUSES = ["processing", "pending_review", "approved"] as const;

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
      rejectionReason: null, failureReason: null,
      // Max ACTIVE order + 1, not active.size — delete-then-add otherwise
      // produces duplicate order values once a track has ever been removed.
      // The max is only over active docs, so a reject-then-create can still
      // collide with a dead (rejected/failed) doc's leftover order value —
      // accepted, since reorderTracks heals it on the next reorder (see the
      // duplicate-order-healing test).
      order: Math.max(-1, ...active.docs.map((d) => (d.data().order as number) ?? -1)) + 1,
      createdAt: now, updatedAt: now,
    };
    tx.set(trackRef, doc);
  });
  return { trackId: trackRef.id, uploadPath: stagingAudioPath(uid, input.profileId, trackRef.id) };
});

export const updateTrack = onCall<{ profileId: string; trackId: string; title?: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackId, title } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)) {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    if (title === undefined) {
      throw new HttpsError("invalid-argument", "Nothing to update.");
    }
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 80) {
      throw new HttpsError("invalid-argument", "Track titles are 1-80 characters.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    try {
      await ref.update({ title: title.trim(), updatedAt: Date.now() });
    } catch (err) {
      // Firestore's NOT_FOUND status maps to gRPC code 5 — thrown by update()
      // against a missing doc instead of a separate pre-read, since a plain
      // get()-then-update() has a TOCTOU gap (the doc can vanish between the
      // two calls, e.g. a racing deleteTrack).
      if ((err as { code?: number }).code === 5) {
        throw new HttpsError("not-found", "Track not found.");
      }
      throw err;
    }
    return { ok: true };
  });

export const deleteTrack = onCall<{ profileId: string; trackId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackId } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)) {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    // Storage cleanup is best-effort: a transcode in flight when the doc is
    // deleted can still write a review clip afterwards — Task 7's trigger
    // must re-check the doc after transcoding and remove its own output if
    // the doc is gone (see plan Task 7).
    await Promise.allSettled([
      bucket().file(reviewTrackPath(profileId, trackId)).delete(),
      bucket().file(publicTrackPath(profileId, trackId)).delete(),
    ]);
    await ref.delete();
    return { ok: true };
  });

export const reorderTracks = onCall<{ profileId: string; trackIds: string[] }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackIds } = req.data;
    if (!isValidDocId(profileId) || !Array.isArray(trackIds) || trackIds.length < 1
        || !trackIds.every((t) => isValidDocId(t))
        || new Set(trackIds).size !== trackIds.length) {
      throw new HttpsError("invalid-argument", "A profile id and a list of unique track ids are required.");
    }
    // The reordered list spans every doc in the collection, not just the 10
    // active ones — rejected/failed tracks persist by design (for the reason
    // display), so ordinary reject-then-create churn can reach 21+ docs over
    // a profile's lifetime. 200 stays comfortably clear of Firestore's
    // 500-writes-per-transaction limit.
    if (trackIds.length > 200) {
      throw new HttpsError("invalid-argument", "Too many tracks to reorder at once.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    // Normalizes order to 0..n-1 in one transaction: the given ids first (in the
    // given order), then any unmentioned tracks in their current order. Also
    // heals any duplicate order values left by historic delete-then-add.
    await db.runTransaction(async (tx) => {
      const col = db.collection(`profiles/${profileId}/tracks`);
      const all = await tx.get(col);
      const byId = new Map(all.docs.map((d) => [d.id, d]));
      const mentioned = trackIds.filter((id) => byId.has(id));
      const mentionedSet = new Set(mentioned);
      const rest = all.docs
        .filter((d) => !mentionedSet.has(d.id))
        .sort((a, b) => ((a.data().order ?? 0) - (b.data().order ?? 0)) || a.id.localeCompare(b.id))
        .map((d) => d.id);
      [...mentioned, ...rest].forEach((id, i) => {
        const d = byId.get(id)!;
        if (d.data().order !== i) tx.update(d.ref, { order: i, updatedAt: Date.now() });
      });
    });
    return { ok: true };
  });
```

- [ ] **Step 7: Export from `functions/src/index.ts`**

```ts
export { createTrack, updateTrack, deleteTrack, reorderTracks } from "./tracks.js";
```

- [ ] **Step 8: Run tests**

Run: `pnpm emu:test`
Expected: all PASS. (The `status in [...]` transaction query needs no composite index — single-field.)

- [ ] **Step 9: Commit**

```bash
git add functions
git commit -m "feat(functions): createTrack/updateTrack/deleteTrack with 10-track cap"
```

Note: a code review pass after this task landed found the `order`-reuse bug,
the non-atomic reorder shape, and the missing verified-email/isValidDocId
gates described above — landed as a follow-up commit,
`fix(functions): reorderTracks normalizer, monotonic order, id validation, verified-email gates`.
The snippets above already reflect the fixed, shipped code.

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
import sharp from "sharp";
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
    const stagingPath = `staging/audio/${uid}/${profileId}/forged-track-id`;
    await uploadTestAudio(stagingPath, makeWav(2), "audio/wav", user);
    // No doc to flip — just assert nothing lands in review for that id.
    await new Promise((r) => setTimeout(r, 4000));
    const [exists] = await abucket.file(`review/tracks/${profileId}/forged-track-id.m4a`).exists();
    expect(exists).toBe(false);
    const [stagingExists] = await abucket.file(stagingPath).exists();
    expect(stagingExists).toBe(false); // forged staging object discarded too
  });
  it("ignores an upload whose object-path uid doesn't match the track doc's uploaderUid, even from a fellow member", async () => {
    const { user: userA, profileId } = await makeMusician("tx5a");
    const { user: userB, uid: uidB } = await signUpTestUser(`tx5b-${Date.now()}@test.com`);
    // B is a genuine member of the same profile — this isn't the
    // "non-member" rejection path, it's specifically the uploaderUid guard:
    // a fellow member still can't hijack another member's track slot by
    // uploading under their own uid segment into someone else's trackId.
    await adb.doc(`profiles/${profileId}/members/${uidB}`)
      .set({ uid: uidB, role: "member", label: "", joinedAt: Date.now() });
    const wav = makeWav(10);
    const { trackId } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Mismatch", startSec: 1, sizeBytes: wav.byteLength, contentType: "audio/wav" }, userA);
    const mismatchedPath = `staging/audio/${uidB}/${profileId}/${trackId}`;
    await uploadTestAudio(mismatchedPath, wav, "audio/wav", userB);
    await new Promise((r) => setTimeout(r, 4000));
    const doc = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(doc.data()?.status).toBe("processing");
    const [stagingExists] = await abucket.file(mismatchedPath).exists();
    expect(stagingExists).toBe(false);
    const [reviewExists] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(reviewExists).toBe(false);
  });
  it("holds the delete-during-transcode invariant: no review or staging object survives a track doc deleted immediately after upload", async () => {
    const { user, profileId } = await makeMusician("tx6");
    const wav = makeWav(20);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Race", startSec: 2, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    // Delete the track doc immediately — this races the trigger under
    // either interleaving (before it even reads the doc, mid-transcode, or
    // after the review upload but before the status write). The invariant
    // under test — no review object AND no staging object ever survive —
    // must hold no matter which interleaving actually happens.
    await adb.doc(`profiles/${profileId}/tracks/${trackId}`).delete();
    const reviewPath = `review/tracks/${profileId}/${trackId}.m4a`;
    const deadline = Date.now() + 15_000;
    let reviewGone = false;
    let stagingGone = false;
    while (Date.now() < deadline && !(reviewGone && stagingGone)) {
      reviewGone = !(await abucket.file(reviewPath).exists())[0];
      stagingGone = !(await abucket.file(uploadPath).exists())[0];
      if (!(reviewGone && stagingGone)) await new Promise((r) => setTimeout(r, 500));
    }
    expect(reviewGone).toBe(true);
    expect(stagingGone).toBe(true);
  });
  it("ignores a re-upload to the same staging path after the track already reached pending_review", async () => {
    const { user, profileId } = await makeMusician("tx7");
    const wav1 = makeWav(20);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Stable", startSec: 2, sizeBytes: wav1.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav1, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    const reviewPath = `review/tracks/${profileId}/${trackId}.m4a`;
    const [beforeMeta] = await abucket.file(reviewPath).getMetadata();
    const beforeGeneration = beforeMeta.generation;

    // Re-upload different bytes to the same (already-consumed) staging path.
    const wav2 = makeWav(9);
    await uploadTestAudio(uploadPath, wav2, "audio/wav", user);
    await new Promise((r) => setTimeout(r, 4000));

    const after = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(after.data()?.status).toBe("pending_review");
    const [afterMeta] = await abucket.file(reviewPath).getMetadata();
    expect(afterMeta.generation).toBe(beforeGeneration); // review clip untouched
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false); // the re-upload is still discarded
  });
});

describe("processUpload: photos", () => {
  // Minimal valid 1x1 JPEG for sharp to re-encode.
  const tinyJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
  // Same 1x1 image, 3 bytes longer — decodes fine but trips libjpeg's
  // "extraneous bytes" warning, as many real phone encoders do; pins
  // failOn:"error" tolerance (media.ts must not reject on this).
  const warnJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));

  // Shared poll helper for tests that just need the eventual value of one
  // portfolio photo field.
  async function waitForPortfolioField(
    profileId: string, field: "avatarPhotoPath" | "coverPhotoPath", timeoutMs = 30_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.[field] ?? null;
      if (v) return v as string;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`portfolio.${field} not set for profile ${profileId} after ${timeoutMs}ms`);
  }

  it("processes an avatar into public/photos, updates the profile doc, and upscales a tiny source to exactly 512x512", async () => {
    const { user, uid, profileId } = await makeMusician("ph1");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    // tinyJpeg is a 1x1 source — this doubles as the small-source case:
    // avatars deliberately upscale (no withoutEnlargement) because 512x512
    // is a fixed-size contract the rest of the app relies on.
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user); // same uploader helper works for any bytes
    const deadline = Date.now() + 30_000;
    let avatarPath: string | null = null;
    while (Date.now() < deadline && !avatarPath) {
      avatarPath = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (!avatarPath) await new Promise((r) => setTimeout(r, 500));
    }
    expect(avatarPath).toMatch(new RegExp(`^public/photos/${profileId}/avatar-`));
    const [bytes] = await abucket.file(avatarPath!).download();
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });
  it("ignores photo uploads from a non-member of the target profile", async () => {
    const { profileId } = await makeMusician("ph2");
    const { user: outsider, uid: outsiderUid } = await signUpTestUser(`ph2o-${Date.now()}@test.com`);
    await uploadTestAudio(`staging/photos/${outsiderUid}/${profileId}/avatar-${Date.now()}`,
      tinyJpeg(), "image/jpeg", outsider);
    await new Promise((r) => setTimeout(r, 4000));
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
  });
  it("processes a warning-tripping-but-valid cover JPEG successfully", async () => {
    const { user, uid, profileId } = await makeMusician("ph3");
    const path = `staging/photos/${uid}/${profileId}/cover-${Date.now()}`;
    await uploadTestAudio(path, warnJpeg(), "image/jpeg", user);
    const coverPath = await waitForPortfolioField(profileId, "coverPhotoPath");
    expect(coverPath).toMatch(new RegExp(`^public/photos/${profileId}/cover-`));
    const [exists] = await abucket.file(coverPath).exists();
    expect(exists).toBe(true);
  });
  it("strips EXIF metadata from an uploaded avatar", async () => {
    const { user, uid, profileId } = await makeMusician("ph4");
    const withExifJpeg = await sharp(Buffer.from(tinyJpeg()))
      .withExif({ IFD0: { ImageDescription: "gps-ish" } })
      .jpeg()
      .toBuffer();
    const srcMeta = await sharp(withExifJpeg).metadata();
    expect(srcMeta.exif).toBeDefined(); // sanity: the fixture really does carry EXIF before upload
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, withExifJpeg, "image/jpeg", user);
    const avatarPath = await waitForPortfolioField(profileId, "avatarPhotoPath");
    const [bytes] = await abucket.file(avatarPath).download();
    const outMeta = await sharp(bytes).metadata();
    expect(outMeta.exif).toBeUndefined();
  });
  it("deletes the old public photo when a new one replaces it", async () => {
    const { user, uid, profileId } = await makeMusician("ph5");
    await uploadTestAudio(`staging/photos/${uid}/${profileId}/avatar-${Date.now()}-a`, tinyJpeg(), "image/jpeg", user);
    const firstPath = await waitForPortfolioField(profileId, "avatarPhotoPath");
    const [firstExists] = await abucket.file(firstPath).exists();
    expect(firstExists).toBe(true);

    await uploadTestAudio(`staging/photos/${uid}/${profileId}/avatar-${Date.now()}-b`, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let secondPath: string | null = null;
    while (Date.now() < deadline && !secondPath) {
      const cur = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (cur && cur !== firstPath) secondPath = cur;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(secondPath).not.toBeNull();
    const [secondExists] = await abucket.file(secondPath!).exists();
    expect(secondExists).toBe(true);
    const [firstStillExists] = await abucket.file(firstPath).exists();
    expect(firstStillExists).toBe(false); // superseded photo cleaned up
  });
  it("holds the delete-during-photo-processing invariant: no public photo survives a profile doc deleted before the upload lands", async () => {
    const { user, uid, profileId } = await makeMusician("ph6");
    // Delete only the top-level profile doc (not a full recursiveDelete) so
    // the members subcollection survives — the trigger's membership check
    // still passes. Deleting BEFORE the upload (rather than racing it
    // afterward) makes profileRef.update() deterministically hit a missing
    // doc every run, instead of depending on upload/trigger timing: an
    // earlier version of this test deleted after uploading and asserted
    // public/photos/{profileId}/ was empty via a poll — that's vacuously
    // true at iteration 0 (nothing has been written yet) and would have
    // gone undetected as a false pass if the trigger ever won the race.
    await adb.doc(`profiles/${profileId}`).delete();
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    // Poll until staging is gone — that's the trigger's finally block
    // running, proof the whole pipeline (including the post-write cleanup)
    // has actually completed, not just that nothing has happened yet.
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true);
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import { reviewTrackPath, publicPhotoPath, isValidDocId, MAX_CLIP_SECONDS } from "@gatekeep/shared";
import { STORAGE_BUCKET, bucket } from "./storage.js";

const run = promisify(execFile);

// A subprocess run against untrusted input (ffprobe/ffmpeg on a user-supplied
// file) that never returns would otherwise tie up the trigger until the
// 300s function timeout kills it mid-cleanup, leaving the track stuck in
// "processing" with no failureReason. Bounding it converts a hang into a
// clean "failed" status well before that cap.
const SUBPROCESS_TIMEOUT_MS = 120_000;

// ffmpeg-static's own types/index.d.ts declares `export default: string | null`,
// but under this package's NodeNext + "type":"module" setup TS resolves the
// default import as the whole CJS module namespace instead (a known
// ffmpeg-static/NodeNext interop quirk) — the runtime value is still the raw
// string (or null) per Node's CJS/ESM interop, so assert the real type here
// rather than trust the inferred one.
const ffmpegPath = ffmpegPathRaw as unknown as string | null;

// Every best-effort storage cleanup in this module goes through here instead
// of a bare `.catch(() => {})` — a cleanup that silently fails (quota, a
// permissions drift, an emulator hiccup) previously left no trace anywhere.
// Still non-fatal: logging, never rethrowing, so a cleanup failure can never
// turn into a stuck/duplicate-processed object.
function logDeleteFailure(phase: string, path: string) {
  return (e: unknown) => console.error(`processUpload: ${phase} cleanup failed`, path, e);
}

// Thrown only for conditions with a controlled, safe-to-display message (no
// file paths, no ffmpeg/ffprobe stderr) — every other error in processAudio
// collapses to a generic failureReason so raw error text (which can carry
// local tmp paths or 100KB+ of subprocess stderr) never lands in a
// member-readable track doc.
class ClipValidationError extends Error {} // bad input from the musician (the clip window)
class ServerConfigError extends Error {}   // this deployment is broken, not the musician's upload

// ffmpeg-static's default export is `string | null` — null when the package
// has no prebuilt binary for this platform/arch. Fail loudly (and only) at
// first use, inside processAudio's try/catch, so a missing binary surfaces
// as a normal "failed" track rather than crashing every export in this
// module at deploy time. Thrown as ServerConfigError (not
// ClipValidationError): this is a deployment problem, not something wrong
// with the musician's upload, so it gets its own safe, accurate message
// instead of collapsing into the generic "file may be corrupt" reason.
function requireFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new ServerConfigError("Audio processing is temporarily unavailable — try again later.");
  }
  return ffmpegPath;
}

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run(ffprobe.path, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { timeout: SUBPROCESS_TIMEOUT_MS });
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not read audio duration.");
  return d;
}

// generation is typed number in firebase-functions but arrives as a string at
// runtime (GCS serializes int64 as JSON string) — accept both, coerce at use.
async function processAudio(objectName: string, generation: string | number): Promise<void> {
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });

  // staging/audio/{uid}/{profileId}/{trackId} — validated defensively (not
  // just trusted from storage.rules) before any of it is used to build
  // Firestore paths.
  const segments = objectName.split("/");
  const [, , uid, profileId, trackId] = segments;
  if (segments.length !== 5 || !isValidDocId(uid) || !isValidDocId(profileId) || !isValidDocId(trackId)) {
    await stagingFile.delete().catch(logDeleteFailure("malformed staging audio path", objectName));
    return;
  }

  const db = getFirestore();
  const trackRef = db.doc(`profiles/${profileId}/tracks/${trackId}`);

  // tmp/uploadedReviewPath are declared here (not inside the try) so the
  // shared finally below can always see them. The try now starts BEFORE the
  // Firestore guard read: a throwing read (network blip, emulator hiccup)
  // previously skipped the finally entirely and leaked the staging object
  // forever — now any exception from this point on still runs the cleanup.
  let tmp: string | null = null;
  let uploadedReviewPath: string | null = null;
  try {
    const snap = await trackRef.get();
    const data = snap.data();
    // Forged/mismatched uploads (no doc, wrong uploader, wrong state, or a
    // malformed startSec): discard the object and do nothing — createTrack
    // is the only path that arms this pipeline, and it always writes a
    // numeric startSec, so a non-number here means a corrupt/tampered doc,
    // not a real in-flight upload worth reporting back to the musician.
    if (!snap.exists || data?.uploaderUid !== uid || data?.status !== "processing"
        || typeof data?.startSec !== "number") {
      return;
    }
    const startSec = data.startSec;

    tmp = await mkdtemp(join(tmpdir(), "gk-audio-"));
    const inFile = join(tmp, "in");
    const outFile = join(tmp, "out.m4a");
    try {
      await stagingFile.download({ destination: inFile });
    } catch (err) {
      // NOTE: this is a STORAGE error — @google-cloud/storage ApiError carries
      // HTTP codes (404), unlike the Firestore gRPC code 5 checked elsewhere
      // in this file. Do not "fix" this back to 5.
      if ((err as { code?: number }).code === 404) {
        // Generation-pinned reads 404 only when the object no longer
        // exists — and the only thing that ever deletes a staging/audio
        // object is this trigger itself (storage.rules makes staging
        // deletes trigger-only). A 404 here means a prior/duplicate
        // delivery of this same event already consumed and cleaned up
        // this exact generation — Cloud Functions storage triggers are
        // at-least-once, so a second delivery racing (or arriving after)
        // the first is expected, not an error. Writing "failed" here would
        // risk clobbering whatever terminal status that other invocation
        // already reached (or is about to reach), so just log and stop —
        // no track-doc write at all.
        console.error("processUpload: staging object already consumed by another delivery", objectName, err);
        return;
      }
      throw err;
    }
    const sourceDuration = await probeDurationSec(inFile);
    if (startSec >= sourceDuration) {
      throw new ClipValidationError(
        `Clip start (${startSec}s) is past the end of the audio (${Math.floor(sourceDuration)}s).`);
    }
    if (sourceDuration - startSec < 1) {
      throw new ClipValidationError("Clip window is too close to the end of the audio.");
    }
    // -ss before -i = fast seek to the clip start. -t here is an INPUT
    // option (it precedes -i, so it bounds how much of the input is read
    // from that seek point) rather than an output duration cap — for a
    // straight single-stream re-encode like this the practical effect is
    // the same either way: the clip tops out at MAX_CLIP_SECONDS. -map
    // 0:a:0 pins the first audio stream explicitly (some containers carry
    // embedded cover art as a "video" stream ffmpeg would otherwise try to
    // touch). AAC 128k in an mp4 container streams natively everywhere.
    await run(requireFfmpegPath(), [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(startSec), "-t", String(MAX_CLIP_SECONDS), "-i", inFile,
      "-vn", "-map", "0:a:0", "-acodec", "aac", "-b:a", "128k", "-movflags", "+faststart",
      outFile,
    ], { timeout: SUBPROCESS_TIMEOUT_MS });
    const clipDuration = await probeDurationSec(outFile);
    const destPath = reviewTrackPath(profileId, trackId);
    await bucket().upload(outFile, { destination: destPath, metadata: { contentType: "audio/mp4" } });
    uploadedReviewPath = destPath;

    // A transcode can take several seconds — long enough for deleteTrack to
    // race it and remove the doc mid-flight. Re-read before writing
    // pending_review; if the doc is gone or someone else already moved it
    // off "processing" (e.g. deleteTrack ran), the upload above is now
    // orphaned — delete it and bail without writing. This narrows the race
    // to the few milliseconds between this read and the update() below,
    // not closes it outright; any residual orphan in that window is reaped
    // by deleteTrack's/deleteProfile's own best-effort storage cleanup.
    const postSnap = await trackRef.get();
    if (!postSnap.exists || postSnap.data()?.status !== "processing") {
      await bucket().file(destPath).delete().catch(logDeleteFailure("orphaned review (race)", destPath));
      return;
    }

    await trackRef.update({
      status: "pending_review",
      durationSec: Math.round(clipDuration * 10) / 10,
      storagePath: destPath,
      failureReason: null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error("processUpload: audio processing failed", objectName, e);
    const failureReason = (e instanceof ClipValidationError || e instanceof ServerConfigError
      ? e.message
      : "Audio processing failed — the file may be corrupt or unsupported."
    ).slice(0, 500);
    if (uploadedReviewPath) {
      await bucket().file(uploadedReviewPath).delete()
        .catch(logDeleteFailure("orphaned review (failed after upload)", uploadedReviewPath));
    }
    try {
      // Same status guard as the success path above: only write "failed" if
      // the doc is still there and still "processing" — never blindly
      // overwrite a doc that deleteTrack (or a second trigger invocation)
      // already moved on from.
      const failSnap = await trackRef.get();
      if (failSnap.exists && failSnap.data()?.status === "processing") {
        await trackRef.update({ status: "failed", failureReason, updatedAt: Date.now() });
      }
    } catch (err) {
      // gRPC code 5 (NOT_FOUND): the doc vanished between the guard-read
      // above and this update — expected under the same delete race,
      // nothing to log. Anything else is unexpected; log it but still
      // swallow rather than rethrow — storage-trigger retry is off, so
      // rethrowing here buys nothing and would just strand the doc in
      // "processing" forever with staging already deleted.
      if ((err as { code?: number }).code !== 5) {
        console.error("processUpload: failed-status write failed", objectName, err);
      }
    }
  } finally {
    await stagingFile.delete().catch(logDeleteFailure("staging (audio, finally)", objectName));
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

// Mirrors storage.rules' staging/photos filename pattern — validated here
// too (not just trusted from the rules) before it's used to pick a Firestore
// field or an output path.
const PHOTO_FILENAME_RE = /^(avatar|cover)-[A-Za-z0-9-]{1,80}$/;

async function processPhoto(objectName: string, generation: string | number): Promise<void> {
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });

  // staging/photos/{uid}/{profileId}/{kind}-{nonce}
  const segments = objectName.split("/");
  const [, , uid, profileId, fileName] = segments;
  const nameMatch = typeof fileName === "string" ? PHOTO_FILENAME_RE.exec(fileName) : null;
  if (segments.length !== 5 || !isValidDocId(uid) || !isValidDocId(profileId) || !nameMatch) {
    await stagingFile.delete().catch(logDeleteFailure("malformed staging photo path", objectName));
    return;
  }
  const kind = nameMatch[1] as "avatar" | "cover";
  const db = getFirestore();

  try {
    // Membership is derived from the OBJECT PATH's {uid}/{profileId}
    // segments, never from object.metadata (client-controlled and
    // untrusted — see storage.rules' note on staging paths). The read is
    // inside this try/finally (not before it) so a throwing read still
    // triggers the staging cleanup below, instead of leaking the object.
    const member = await db.doc(`profiles/${profileId}/members/${uid}`).get();
    if (!member.exists) {
      return; // non-member or malformed: discard, no further processing
    }

    const [bytes] = await stagingFile.download();
    // Re-encode via sharp: strips EXIF (GPS!) and bounds dimensions.
    // failOn: "error" (sharp's default is "warning", the strictest level) —
    // real-world phone/app JPEG encoders commonly emit warning-level defects
    // (e.g. libjpeg's "extraneous bytes before marker") on otherwise-valid
    // photos; the default "warning" level would reject those uploads.
    // "error" still rejects truncated/genuinely corrupt data, just not mere
    // warnings. limitInputPixels bounds decompression-bomb-style inputs.
    const sharpOpts = { failOn: "error" as const, limitInputPixels: 50_000_000 };
    // Avatars intentionally do NOT set withoutEnlargement — the 512x512
    // output is a contract the rest of the app relies on (fixed-size crop
    // targets), so a tiny source still gets upscaled to fill it. Covers use
    // withoutEnlargement since they're display-only and any size up to
    // 1600x1600 is fine.
    const pipeline = kind === "avatar"
      ? sharp(bytes, sharpOpts).rotate().resize(512, 512, { fit: "cover" })
      : sharp(bytes, sharpOpts).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
    const jpeg = await pipeline.jpeg({ quality: 82 }).toBuffer();
    const destPath = publicPhotoPath(profileId, kind, randomUUID());
    await bucket().file(destPath).save(jpeg, { contentType: "image/jpeg" });

    const profileRef = db.doc(`profiles/${profileId}`);
    const field = kind === "avatar" ? "portfolio.avatarPhotoPath" : "portfolio.coverPhotoPath";
    const prev = (await profileRef.get()).data()?.portfolio?.[`${kind}PhotoPath`] as string | null | undefined;
    try {
      await profileRef.update({ [field]: destPath, updatedAt: Date.now() });
    } catch (err) {
      // Profile can be deleted mid-flight too (deleteProfile's
      // recursiveDelete races this trigger) — gRPC code 5 (NOT_FOUND).
      // There's no live doc to point at destPath any more, so the
      // freshly-written public object would otherwise survive as an orphan
      // even after the profile is gone; clean it up regardless of the
      // error's cause. Same swallow-not-rethrow reasoning as the audio
      // failure path — only log when the cause wasn't the expected
      // "doc is gone" case.
      await bucket().file(destPath).delete().catch(logDeleteFailure("orphaned public photo", destPath));
      if ((err as { code?: number }).code !== 5) {
        console.error("processUpload: profile photo update failed", objectName, err);
      }
      return;
    }
    if (prev) {
      await bucket().file(prev).delete().catch(logDeleteFailure("old photo", prev));
    }
  } finally {
    await stagingFile.delete().catch(logDeleteFailure("staging (photo, finally)", objectName));
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

> **Post-review revision:** this section documents the FINAL shipped code
> after TWO quality-review passes hardened the naive first cut (see
> "Quality-review hardening" and "Quality-review hardening (pass 2)" below the
> original steps). The steps below are kept in their original TDD order but
> their code blocks now show the final, byte-exact implementation — not the
> version that first went green.

**Files:**
- Modify: `functions/src/tracks.ts`
- Modify: `functions/src/review.ts` (export `requireAdmin`)
- Modify: `functions/src/index.ts`
- Modify: `functions/src/storage.ts` (export `logDeleteFailure`, moved here from `media.ts` so `reviewTrack` can reuse the same logged-catch pattern)
- Modify: `functions/src/media.ts` (imports `logDeleteFailure` instead of defining it locally — behavior unchanged)
- Modify: `functions/test/helpers.ts` (export `makeAdminUser`, lifted out of this task's test file so `review.test.ts` can share it too)
- Modify: `functions/test/review.test.ts` (drops its local `makeAdminUser` copy for the shared one)
- Test: append to `functions/test/tracks.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `functions/test/tracks.test.ts` (imports `makeAdminUser` from `./helpers` instead of defining it locally):

```ts
async function makePendingTrack(prefix: string) {
  const { user, uid, profileId } = await makeMusician(prefix);
  const wav = makeWav(35);
  const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
    "createTrack", { profileId, title: "For review", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
  await uploadTestAudio(uploadPath, wav, "audio/wav", user);
  await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
  return { user, uid, profileId, trackId };
}

describe("reviewTrack", () => {
  it("approve copies the clip to public, deletes review copy, flips status, audits, notifies", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv1");
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
    // Pins the notification path: notifyProfileMembers writes an inbox
    // notification for every member (the sole musician member here).
    const notifs = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifs.empty).toBe(false);
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
  it("non-admin cannot review; a second 'approved' decision is refused (already approved, not pending)", async () => {
    const { user, profileId, trackId } = await makePendingTrack("rv3");
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const { user: adminUser } = await makeAdminUser("rv3a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("reject also works on an already-approved track (retroactive takedown, spec §6): public object removed, storagePath cleared, audit records the prior state, musician notified", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv4");
    const { user: adminUser, uid: adminUid } = await makeAdminUser("rv4a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    const [pubBefore] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubBefore).toBe(true);
    await callFn("reviewTrack",
      { profileId, trackId, decision: "rejected", reason: "Copyright complaint." }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "Copyright complaint.", storagePath: null });
    const [pubAfter] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubAfter).toBe(false);
    const audit = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data().actorUid).toBe(adminUid);
    expect(audit.docs[0].data().detail).toMatch(/^\[was approved\]/);
    // Pins that a takedown's notification fires at claim time (right after
    // the transaction, alongside the audit) rather than after storage
    // cleanup — see reviewTrack's comment on that ordering: it exists so a
    // storage-cleanup failure (HttpsError "unavailable") can't swallow the
    // notification the way it could when notification lived at the very
    // end. Reproducing that exact storage failure isn't practical against
    // the real Storage emulator (the Admin SDK bypasses storage.rules, and
    // there's no supported way to force a non-404 delete error), so this
    // instead confirms the notification exists for the ordinary success
    // path at the new call site.
    const notifs = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifs.docs.some((d) => /removed from your portfolio/.test(d.data().title as string))).toBe(true);
  });
  it("approve fails cleanly when the review clip is already gone: failed-precondition, doc rolled back to pending_review", async () => {
    const { profileId, trackId } = await makePendingTrack("rv5");
    const { user: adminUser } = await makeAdminUser("rv5a");
    // Simulates storage/doc drift (e.g. a prior partial failure, or a
    // hand-edited emulator state) — the doc says pending_review but the
    // review object backing it is gone.
    await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).delete();
    let err: unknown;
    try {
      await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "functions/failed-precondition" });
    expect((err as Error).message).toMatch(/review clip is missing/i);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.status).toBe("pending_review");
  });
  it("accepts a rejection reason of exactly 500 characters (checked/stored trimmed); 501 is invalid-argument", async () => {
    const { profileId, trackId } = await makePendingTrack("rv6");
    const { user: adminUser } = await makeAdminUser("rv6a");
    const padded = "  " + "x".repeat(500) + "  "; // trims to exactly 500
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: padded }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.rejectionReason).toBe("x".repeat(500));

    const { profileId: p2, trackId: t2 } = await makePendingTrack("rv6b");
    await expect(callFn("reviewTrack", { profileId: p2, trackId: t2, decision: "rejected", reason: "x".repeat(501) }, adminUser))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("rejecting an already-rejected track is an idempotent retry: storage re-attempted, no duplicate audit/notification", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv7");
    const { user: adminUser } = await makeAdminUser("rv7a");
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: "First reason." }, adminUser);

    // Simulates storage drift after the first reject (e.g. a stray copy that
    // landed here despite the doc already saying "rejected") — the retry
    // must still find and remove it, proving the retry re-attempts storage
    // work rather than short-circuiting on "already rejected".
    await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).save(Buffer.from([9]), { contentType: "audio/mp4" });

    const auditBefore = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    const notifsBefore = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();

    const res = await callFn<{ profileId: string; trackId: string; decision: "rejected"; reason: string },
      { ok: boolean }>("reviewTrack", { profileId, trackId, decision: "rejected", reason: "First reason." }, adminUser);
    expect(res.ok).toBe(true);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "First reason.", storagePath: null });

    // Storage work was re-attempted: the stray public object is gone.
    const [pubExists] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubExists).toBe(false);

    const auditAfter = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    expect(auditAfter.size).toBe(auditBefore.size); // no duplicate audit row
    const notifsAfter = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifsAfter.size).toBe(notifsBefore.size); // no duplicate notification
  });
});
```

The test file's top also changes: the local `makeAdminUser` function is deleted, `makeAdminUser` is added to the `./helpers` import, the now-unused `getAuth as adminAuth` import is dropped, and the file-level `vi.setConfig({ testTimeout: 20_000 })` becomes `60_000` (the reviewTrack tests upload and wait on a real ffmpeg transcode via `makePendingTrack`, same as `media.test.ts`) — the block's own nested `vi.setConfig` is removed rather than duplicated.

`functions/test/helpers.ts` gains (placed after `signUpUnverifiedTestUser`, using the file's existing `getAdminAuth`/`adminAppInstance`):

```ts
// Signs up a fresh test user and grants the `admin` custom claim directly via
// the Admin SDK — bypasses grantAdmin's Google-linked-account-only rule,
// which is fine for tests (every review-flow test needs an admin caller
// without wiring up a fake Google OAuth provider). Centralized here so
// review.test.ts and tracks.test.ts share one implementation.
export async function makeAdminUser(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await getAdminAuth(adminAppInstance).setCustomUserClaims(uid, { admin: true });
  await user.getIdToken(true); // refresh claims
  return { user, uid };
}
```

`functions/test/review.test.ts` drops its own local `makeAdminUser()` (no-arg) function, imports the shared one from `./helpers`, and every call site becomes `makeAdminUser("admin")` (its `getAuth as adminAuth` import stays — `grantAdmin`'s own tests still use it directly for `importUsers`/`getUser`).

- [ ] **Step 2: Export `requireAdmin` from `functions/src/review.ts`**

Change `function requireAdmin(` to `export function requireAdmin(`.

- [ ] **Step 3: Add `reviewTrack` to `functions/src/tracks.ts`**

First, move the storage-cleanup logger out of `media.ts` into `functions/src/storage.ts` (it was private to `processUpload`; `reviewTrack` needs the same logged-catch pattern):

```ts
// functions/src/storage.ts — appended after `bucket`
// Every best-effort storage cleanup across the media/tracks pipelines goes
// through here instead of a bare `.catch(() => {})` — a cleanup that
// silently fails (quota, a permissions drift, an emulator hiccup) would
// otherwise leave no trace anywhere. Still non-fatal: logging, never
// rethrowing, so a cleanup failure can never turn into a stuck/duplicate
// object. Originally private to media.ts (processUpload); moved here so
// tracks.ts's reviewTrack can reuse the same logged-catch pattern — `source`
// identifies the caller (e.g. "processUpload", "reviewTrack") so the log
// line doesn't misattribute a cleanup to the wrong pipeline.
export function logDeleteFailure(source: string, phase: string, path: string) {
  return (e: unknown) => console.error(`${source}: ${phase} cleanup failed`, path, e);
}
```

In `media.ts`: delete the local `logDeleteFailure` definition (and its now-redundant leading comment) and add it to the existing `./storage.js` import: `import { STORAGE_BUCKET, bucket, logDeleteFailure } from "./storage.js";`. Every one of its 8 call sites (`.catch(logDeleteFailure(...))`) gains a leading `"processUpload"` source argument — otherwise unchanged, behavior identical, only the definition moved and the signature gained a parameter.

Then, in `functions/src/tracks.ts`:

```ts
import { bucket, logDeleteFailure } from "./storage.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count. Exported so Task 9's submit
// minimum-content gate can import it instead of re-hardcoding the list.
export const ACTIVE_TRACK_STATUSES = ["processing", "pending_review", "approved"] as const;

export const reviewTrack = onCall<{ profileId: string; trackId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, trackId, decision, reason } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)
        || (decision !== "approved" && decision !== "rejected")) {
      throw new HttpsError("invalid-argument", "profileId, trackId, and a decision are required.");
    }
    if (decision === "rejected" && !reason?.trim()) {
      throw new HttpsError("invalid-argument", "A rejection reason is required.");
    }
    if (decision === "rejected" && reason!.trim().length > 500) {
      throw new HttpsError("invalid-argument", "Rejection reason must be 500 characters or fewer.");
    }

    const db = getFirestore();
    const ref = db.doc(`profiles/${profileId}/tracks/${trackId}`);

    // Claims the decision (flips status/storagePath/rejectionReason) inside a
    // transaction BEFORE any storage work, so two concurrent reviews of the
    // same track can't both pass their precondition check and both go on to
    // touch storage. Whichever transaction commits first claims the track;
    // Firestore silently retries the loser's read against the now-updated
    // doc, so it sees the new status and fails its own precondition check.
    // The Functions emulator serializes concurrent invocations of the same
    // callable, so this race is untestable there — the transaction itself is
    // the guarantee, deliberately with no accompanying test.
    const prior = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Track not found.");
      const data = snap.data() as TrackDoc;
      if (decision === "approved" && data.status !== "pending_review") {
        throw new HttpsError("failed-precondition", "Track is not pending review.");
      }
      // Reject also accepts "approved" (retroactive takedown, spec §6) AND a
      // second "rejected" (idempotent retry — lets an admin re-run a
      // takedown whose storage cleanup failed the first time; see the
      // "unavailable" throw below).
      if (decision === "rejected" && data.status !== "pending_review"
          && data.status !== "approved" && data.status !== "rejected") {
        throw new HttpsError("failed-precondition", "Track is not reviewable.");
      }
      if (decision === "approved") {
        tx.update(ref, {
          status: "approved", storagePath: publicTrackPath(profileId, trackId),
          rejectionReason: null, updatedAt: Date.now(),
        });
      } else {
        tx.update(ref, {
          status: "rejected", storagePath: null,
          rejectionReason: reason!.trim(), updatedAt: Date.now(),
        });
      }
      return data;
    });

    // Reject's decision is final the instant the transaction above commits —
    // unlike approve (which can still be rolled back below if the copy
    // fails), nothing downstream undoes "rejected". Write the audit AND
    // notify the musician right here, unconditionally-once at claim time —
    // not gated on the storage outcome below. This used to live at the very
    // end, alongside approve's notification, but the storage-cleanup step
    // below can throw HttpsError("unavailable", ...) when the public delete
    // fails for a non-404 reason (see that throw's comment) — that aborts
    // the call before ever reaching a post-storage notification block, so a
    // takedown whose first storage attempt failed would silently never
    // notify the musician, even on a successful retry (the retry's `prior`
    // is already "rejected" by then, which is exactly the idempotency guard
    // below and correctly suppresses a second notification). Firing both
    // here instead — before any storage work — means the musician always
    // hears about a reject exactly once, regardless of how storage cleanup
    // goes. Both are guarded on prior.status !== "rejected" so an idempotent
    // reject-from-rejected retry doesn't produce a duplicate audit row or
    // tell the musician twice.
    if (decision === "rejected" && prior.status !== "rejected") {
      await writeAudit({
        actorUid,
        action: "track_rejected",
        // Detail records the prior status too — a takedown trail (was
        // "approved" and live, vs. a routine first-time reject from
        // "pending_review") is worth more to an auditor than the reason alone.
        detail: `[was ${prior.status}] ${reason!.trim()}`,
        targetId: `${profileId}/${trackId}`,
      });
      const rejectTitle = prior.title ?? "Your track";
      const wasApproved = prior.status === "approved";
      await notifyProfileMembers(profileId, {
        kind: "track_review",
        title: wasApproved ? `"${rejectTitle}" was removed from your portfolio` : `"${rejectTitle}" needs attention`,
        body: wasApproved
          ? `Reviewer note: ${reason!.trim()} — this track is no longer on your public page. You can delete it and upload a replacement.`
          : `Reviewer note: ${reason!.trim()} — you can delete it and upload a replacement.`,
      });
    }

    const reviewFile = bucket().file(reviewTrackPath(profileId, trackId));
    const publicFile = bucket().file(publicTrackPath(profileId, trackId));

    if (decision === "approved") {
      try {
        // Copy-then-delete keeps the public-path invariant: the clip appears
        // in public/ only as part of an approval that already committed.
        await reviewFile.copy(publicFile);
      } catch (err) {
        // The Firestore claim above already committed "approved" — if the
        // copy itself fails, roll the doc back to pending_review inside its
        // own transaction, and only if it's still OUR claim: a concurrent
        // reject (often the very thing that deleted the review clip and
        // made this copy fail) may have already taken the track down, and
        // that decision must stand rather than being clobbered back to
        // pending_review by a plain unconditional update.
        await db.runTransaction(async (tx) => {
          const s = await tx.get(ref);
          // Only roll back OUR claim. If another admin has since taken the
          // track down — often the very thing that deleted the clip and
          // made the copy fail — their decision stands.
          if (!s.exists || s.data()?.status !== "approved") return;
          tx.update(ref, { status: "pending_review", storagePath: prior.storagePath ?? null, updatedAt: Date.now() });
        }).catch((e) => console.error("reviewTrack: approve rollback failed", `${profileId}/${trackId}`, e));
        // @google-cloud/storage surfaces a missing source object as an
        // ApiError with HTTP code 404 (unlike Firestore's gRPC code 5 used
        // elsewhere) — the review clip was already gone (a race, or a prior
        // partial failure that already consumed it). That's a recoverable
        // admin action (reject + ask for a re-upload), not a server error.
        if ((err as { code?: number }).code === 404) {
          throw new HttpsError("failed-precondition",
            "The review clip is missing — reject this track and ask the musician to re-upload.");
        }
        throw err;
      }
      await reviewFile.delete()
        .catch(logDeleteFailure("reviewTrack", "review copy after approve", reviewTrackPath(profileId, trackId)));
    } else {
      const [reviewResult, publicResult] = await Promise.allSettled([reviewFile.delete(), publicFile.delete()]);
      if (reviewResult.status === "rejected" && (reviewResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reviewTrack", "reject: review delete", reviewTrackPath(profileId, trackId))(reviewResult.reason);
      }
      if (publicResult.status === "rejected" && (publicResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reviewTrack", "reject: public delete", publicTrackPath(profileId, trackId))(publicResult.reason);
      }
      // A pending track's public object shouldn't exist, so its delete 404s
      // harmlessly. If the public delete fails for any OTHER reason — for
      // ANY prior status, not just a retroactive takedown from "approved" —
      // the object may still exist and be publicly reachable even though
      // the doc says "rejected"; surface that to the admin as a retryable
      // failure instead of quietly reporting success. The audit row for
      // this decision is already written above; the transactional claim
      // accepts reject-from-rejected, so a second reviewTrack("rejected")
      // call safely re-attempts the same delete without duplicating it.
      if (publicResult.status === "rejected" && (publicResult.reason as { code?: number })?.code !== 404) {
        throw new HttpsError("unavailable",
          "Takedown incomplete — the public clip could not be removed. Try again.");
      }
    }

    // Storage work finishes asynchronously after the transactional claim
    // committed — a concurrent review of the SAME track (e.g. another admin
    // rejects it while this approve's copy is still in flight) can move the
    // status again before we get here, or deleteTrack/deleteProfile's
    // cascade can remove the doc entirely. Re-read and require the status to
    // still match what THIS call claimed, not just that the doc exists — an
    // existence-only check would let a superseded approve still write its
    // audit/notification and leave the public object it just copied behind
    // as the only trace of a decision that no longer stands.
    const postSnap = await ref.get();
    const stillOurs = postSnap.exists && postSnap.data()?.status === decision;
    if (!stillOurs) {
      if (decision === "approved") {
        await publicFile.delete()
          .catch(logDeleteFailure("reviewTrack", "superseded public (post-review race)", publicTrackPath(profileId, trackId)));
      }
      // Only approve's audit/notify are skipped here — the other admin's
      // decision stands. Reject's already fired unconditionally above,
      // before this re-read, so there's nothing to skip for it.
      return { ok: true };
    }

    // Reject's audit + notification already ran (right after the
    // transaction, above, unconditionally-once at claim time — see the
    // comment there for why). Approve's are gated here instead because
    // approve — unlike reject — can still be superseded by a concurrent
    // reject between the copy finishing and this re-read; the `stillOurs`
    // check above already returned early without audit/notify if so.
    if (decision === "approved") {
      await writeAudit({
        actorUid,
        action: "track_approved",
        detail: prior.title ?? "",
        targetId: `${profileId}/${trackId}`,
      });
      await notifyProfileMembers(profileId, {
        kind: "track_review",
        title: `"${prior.title ?? "Your track"}" is live!`,
        body: "Your track passed review and now plays on your public portfolio.",
      });
    }
    return { ok: true };
  });
```

(`getFirestore`, `HttpsError`, `isValidDocId`, `reviewTrackPath`, `publicTrackPath`, and the `TrackDoc` type were already imported at the top of `tracks.ts` by Task 6.)

- [ ] **Step 4: Export from `functions/src/index.ts`**

```ts
export { createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack } from "./tracks.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm emu:test`
Expected: all PASS (9 test files, 89 tests once this task's 7 `reviewTrack` cases land).

- [ ] **Step 6: Commit**

```bash
git add functions
git commit -m "feat(functions): reviewTrack — admin approve/reject with audit + notification"
```

#### Quality-review hardening (folded into the Step 3/Step 1 code above)

A review pass on the first cut found three gaps, closed in a single follow-up
commit (`fix(functions): transactional review claim, recoverable approve
failures, takedown integrity`) — the code blocks above already reflect the
fix, not the original:

1. **TOCTOU between the read-then-write precondition check and storage work.**
   The original code did a plain `get()`, checked `status`, then did storage
   work, then `update()` — two concurrent `reviewTrack` calls on the same
   track could both pass the precondition check before either wrote. Fixed by
   moving the read-check-write into a Firestore transaction that runs BEFORE
   any storage I/O and returns the prior doc data; storage work (and any
   rollback) happens after the claim has already committed.
2. **Approve had no failure path.** `reviewFile.copy(publicFile)` was
   unguarded — a failed copy (e.g. the review clip already gone) left the doc
   permanently `approved` with no object behind it, and the caller got an
   opaque 500. Fixed by wrapping the copy in try/catch: on any failure the
   transactional claim is rolled back to `pending_review` (restoring the
   prior `storagePath`), and a missing-source (HTTP 404) collapses to a
   specific, actionable `failed-precondition`.
3. **Reject could silently under-deliver on a retroactive takedown.** The
   original reject path used `Promise.allSettled` and never inspected the
   results — if the PUBLIC object's delete failed (not 404) after an
   already-approved track was rejected, the doc would say "rejected" while
   the clip stayed live, with nothing surfaced to the admin. Fixed by
   inspecting both delete results, logging non-404 failures, and throwing
   `unavailable` specifically when the previously-live public object failed
   to delete — recoverable because the transactional claim now also accepts
   reject-from-rejected as an idempotent retry.

**Accepted product decision (v1):** a retroactive takedown (`reviewTrack`
`rejected` on a previously `approved` track) can drop an approved *profile*
below the submit-time minimum-content bar that Task 9 adds (e.g. rejecting a
musician's only track leaves zero tracks). The profile itself stays
`approved`/public regardless — the minimum-content gate in Task 9 only runs
at submit time, not continuously. Re-enforcing it on every track mutation is
out of scope for this sub-project; noted here for whoever picks up curator
discovery/quality signals later.

#### Quality-review hardening (pass 2 — folded into the Step 3/Step 1 code above)

A second review pass on pass 1's transactional design found the transaction
closed the precondition race but re-introduced two narrower ones around it,
plus a reporting-integrity gap — all three closed in one follow-up commit
(`fix(functions): status-aware post-guard, transactional rollback, takedown
audit integrity`):

A. **The post-storage guard was existence-aware, not status-aware.** It only
   checked `postSnap.exists`, so a concurrent reject that took the track down
   *while an approve's copy was still in flight* left the just-copied public
   object stranded — `stillOurs` still passed (the doc existed), so approve's
   audit/notification fired over a decision that no longer stood. Fixed by
   comparing `postSnap.data()?.status === decision`: any status other than
   the one this call itself claimed means someone else's decision has since
   taken over, so the call cleans up its own orphaned public object (if it
   wrote one) and returns early without writing audit/notification.
B. **The approve rollback was a regression, not a fix.** Pass 1 rolled a
   failed copy back with a bare `ref.update(...)` — unconditional, so it
   could stomp a *concurrent reject* that had already taken the track down
   for an unrelated reason (e.g. the very reject whose delete of the review
   clip is what made this copy 404 in the first place), resurrecting a
   rejected track back to `pending_review`. Fixed by moving the rollback into
   its own transaction that re-reads the doc and only writes if
   `status === "approved"` still — i.e., only ever reverts this call's own
   claim, never someone else's.
C. **Takedown audit/notification integrity.** Three related gaps: (1) reject
   audits were written only after the post-storage guard passed, so an admin
   could reject a track, have deleteTrack race the doc away before the
   re-read, and the takedown would leave no audit trail at all even though it
   happened — fixed by writing reject's audit immediately after the
   transaction commits (the decision is final there; approve's audit stays
   gated on the post-guard since approve alone can still be undone). (2) the
   `unavailable` throw on a failed public-object delete was gated on
   `prior.status === "approved"`, so a failed delete against a *pending*
   track's public object (which shouldn't exist, but could via storage drift)
   silently reported success — fixed by dropping that gate: any non-404
   public-delete failure now throws, regardless of prior status. (3) an
   idempotent reject-from-rejected retry re-notified the member and (before
   fix 1 above) could have double-audited — fixed by suppressing the
   notification whenever `prior.status === decision`, and guarding the reject
   audit on `prior.status !== "rejected"`.

Minor cleanup in the same commit: `logDeleteFailure` (in `storage.ts`) gained
a leading `source` parameter so a `reviewTrack` cleanup no longer logs under
the misleading `"processUpload:"` prefix; the approve-rollback catch uses a
plain `console.error` (it's a doc write, not a storage delete, so it doesn't
route through `logDeleteFailure`); and `rv7`'s test was strengthened to seed
a stray object at the public path before the retry and assert it gets
cleaned up (proving the retry re-attempts storage work) while also asserting
no duplicate audit row or notification is produced.

#### Quality-review hardening (pass 3 — folded into the Step 3/Step 1 code above)

A review pass during Task 12 (the admin Takedowns panel that actually
exercises the retroactive-takedown path end-to-end) found a notification
could be lost across a takedown retry — closed in the same commit as Task
12's web fixes (`fix(web,functions): admin queue race guards, clip-error
states, takedown notification integrity`):

D. **A takedown whose first storage attempt failed never notified the
   musician, even after a successful retry.** Reject's notification lived at
   the very end of the function, alongside approve's, gated on
   `prior.status !== decision`. But the storage-cleanup step can throw
   `HttpsError("unavailable", ...)` when the public object's delete fails for
   a non-404 reason (pass 2's fix C.2) — that throw aborts the call before
   ever reaching the end-of-function notification block. On retry, the
   transaction's `prior.status` is now `"rejected"` (the first attempt's
   claim already committed it), so the retry's own idempotency guard
   (`prior.status !== decision` — now `false`) suppresses the notification a
   *second* time, except there was never a first time: the musician is never
   told at all. Fixed by moving reject's notification to fire alongside its
   audit, immediately after the transaction commits and before any storage
   work — the same `prior.status !== "rejected"` guard that already gated
   the audit now gates the notification too, so it's unconditional-once at
   claim time and can't be lost to a downstream storage failure. Approve's
   notification stays where it was (gated on the post-storage `stillOurs`
   guard), since approve — unlike reject — really can still be undone after
   the claim commits.

   Reproducing the exact `unavailable` storage failure in a test wasn't
   practical: the whole `functions/test` suite drives real callables against
   the Functions/Firestore/Storage emulators over HTTP (no in-process
   mocking of `bucket()`), and the Admin SDK bypasses `storage.rules`
   entirely, so there's no supported way to force a non-404 delete error
   from a test. `rv4`'s test (the retroactive-takedown case) was instead
   strengthened to assert a notification exists after an ordinary successful
   takedown, pinning that the new call site still fires correctly; the
   reordering itself is provably safe by inspection (reject's decision is
   already final the instant its transaction commits, per the standing
   comment on that transaction — nothing downstream can un-reject it, so
   nothing downstream should gate telling the musician about it either).

---

### Task 9: Functions — submit minimum-content gate + deleteProfile storage cascade

**Files:**
- Modify: `functions/src/profiles.ts`
- Test: append to `functions/test/profiles.test.ts`

**As-built note:** the snippets below are the final shape (post quality-review
fixes) — `LISTENABLE_TRACK_STATUSES` (not `ACTIVE_TRACK_STATUSES`), `force:
true` on the storage cascade, `Intl.ListFormat` for the gate message, and the
`firebase-admin/storage`/helpers imports live at the top of
`functions/test/profiles.test.ts`, not mid-file. The original TDD-draft
snippets have been replaced in place rather than kept as a stale historical
record.

- [ ] **Step 1: Write failing tests**

Append to `functions/test/profiles.test.ts` (imports/env-var setup folded
into the file's existing top-of-file block — `uploadTestAudio`, `makeWav`,
`waitForTrackStatus` added to the existing `./helpers` import;
`getStorage as adminStorage` and `abucket` added alongside the existing
`adb`; `FIREBASE_STORAGE_EMULATOR_HOST` set alongside `FIRESTORE_EMULATOR_HOST`):

```ts
describe("submitProfileForReview minimum content (musicians)", () => {
  it("refuses an empty musician draft, listing what's missing; passes once bio+genre+avatar+track exist", async () => {
    const { user } = await signUpTestUser(`gate-${Date.now()}@test.com`);
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
  }, 60_000); // per-test timeout for the slow gate test, not a file-wide vi.setConfig bump

  it("lists all four missing items when nothing has been filled in", async () => {
    const { user } = await signUpTestUser(`gatem-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Empty", handle: `gatem_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/bio.*genre.*photo.*track/i);
  });

  it("a track stuck in 'processing' (upload never completed) does not satisfy the gate", async () => {
    const { user } = await signUpTestUser(`gatep-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Stalled", handle: `gatep_${Date.now()}` }, user);
    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    // createTrack writes the doc (status: "processing") before any bytes are
    // uploaded — abandon it here. LISTENABLE_TRACK_STATUSES excludes
    // "processing", so this must not satisfy the gate.
    await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: 1000, contentType: "audio/wav" }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i);
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
  }, 60_000);

  it("does not touch another profile's storage objects — negative control on the prefix sweep", async () => {
    const { user } = await signUpTestUser(`delcn-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava2", handle: `delcn_${Date.now()}` }, user);
    const { profileId: otherProfileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Bystander", handle: `delcn2_${Date.now()}` }, user);
    const survivor = `public/tracks/${otherProfileId}/t9.m4a`;
    await abucket.file(survivor).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await callFn("deleteProfile", { profileId }, user);
    const [exists] = await abucket.file(survivor).exists();
    expect(exists).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm emu:test`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `functions/src/profiles.ts`**

Add imports:

```ts
import type { PortfolioData } from "@gatekeep/shared";
import { bucket, logDeleteFailure } from "./storage.js";
```

Add a module-level constant, distinct from tracks.ts's `ACTIVE_TRACK_STATUSES`
(slot-occupancy — a `processing` track still counts against the 10-track
cap). This gate cares about actually-uploaded, listenable content:
`createTrack` writes the doc *before* the client uploads bytes, so a
`processing` track can be an abandoned upload with nothing behind it — that
must not satisfy the gate:

```ts
const LISTENABLE_TRACK_STATUSES = ["pending_review", "approved"] as const;
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
    // This read (and the status check above) is not transactional with the
    // ref.update below — a deleteTrack racing this call could remove the
    // one qualifying track between the query and the update. That leaves
    // the profile pending_review with no listenable content, which
    // self-heals: an admin rejects it as empty and the musician resubmits.
    // Accepted rather than wrapping the whole gate in a transaction.
    const tracksSnap = await ref.collection("tracks")
      .where("status", "in", [...LISTENABLE_TRACK_STATUSES]).limit(1).get();
    if (tracksSnap.empty) missing.push("at least one track");
    if (missing.length > 0) {
      const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing);
      throw new HttpsError("failed-precondition", `Add ${list} before submitting.`);
    }
  }
```

In `deleteProfile`, after `recursiveDelete` (which already removes the tracks subcollection and `private/booking`):

```ts
  // Storage cascade — best-effort. force: true is required: without it,
  // deleteFiles aborts the ENTIRE prefix sweep on the first per-object
  // error, silently abandoning every remaining object in that prefix; with
  // it, deletion continues past individual failures and collects them
  // instead. staging/audio/{uid}/... and staging/photos/{uid}/... are
  // deliberately NOT swept here even though every {uid} is technically
  // reachable — a members subcollection query, run before recursiveDelete
  // removes it, would enumerate them — but the processUpload trigger always
  // deletes its own staging object in a `finally` on every path (success,
  // validation failure, or a crash-recovery retry), so a residual staging
  // object means the trigger never fired at all, not that this cascade
  // missed it. Those are backstopped by the Storage bucket's 24h lifecycle
  // rule on staging/, which is a LAUNCH BLOCKER follow-up (not yet
  // configured — see README).
  const cascadeTargets = [
    `public/tracks/${profileId}/`,
    `review/tracks/${profileId}/`,
    `public/photos/${profileId}/`,
  ];
  const results = await Promise.allSettled(
    cascadeTargets.map((prefix) => bucket().deleteFiles({ prefix, force: true })));
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    // force: true's rejection reason is an ARRAY of per-object errors
    // (@google-cloud/storage batches them), not a single Error — log each
    // one individually rather than dumping the array as one opaque entry.
    const errors = Array.isArray(r.reason) ? r.reason : [r.reason];
    for (const e of errors) {
      logDeleteFailure("deleteProfile", `storage cascade (${cascadeTargets[i]})`, cascadeTargets[i])(e);
    }
  });
```

**Race-closing note (added post Task-8 hardening):** this storage cascade and
Task 8's `reviewTrack` post-storage-guard are a matched pair. Without the
guard, a `reviewTrack("approved")` that's mid-copy when `deleteProfile` runs
here could land a new object in `public/tracks/{profileId}/` *after* this
`deleteFiles({ prefix: ... })` sweep already ran, orphaning it forever (the
doc — and thus every other cleanup path that keys off it — is already gone).
`reviewTrack`'s post-storage guard (re-read the track doc; if it no longer
exists, delete the public object it just wrote) closes that specific
approve-after-delete window from the other side. Neither half is sufficient
alone: this cascade handles tracks that were already public before the
delete; the guard handles one that lands mid-flight during it.

- [ ] **Step 4: Run tests**

Run: `pnpm emu:test`
Expected: all PASS, including foundation's existing profiles tests (curator path untouched; existing musician-draft tests in `profiles.test.ts` submit without portfolio content — **check**: foundation's `submitProfileForReview` tests use musician drafts. Update those existing tests to seed the minimum content the same way the new test does, or switch their fixtures to curator profiles — prefer curator fixtures where the test's subject is the status transition, not the gate. **As-built:** `profiles.test.ts`'s "moves draft to pending_review..." and "rejects re-submitting..." tests switched to a `curatorDraft()` fixture; `notifications.test.ts`'s three review-notification tests (approve/reject/multi-member fan-out) switched from musician to curator drafts for the same reason — their subject is notification behavior, not the gate.)

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
- Create: `apps/web/app/u/[handle]/not-found.tsx` (generic 404 UI for `notFound()`)
- Modify: `apps/web/app/u/[handle]/page.tsx` (full rewrite: client → server component)
- Modify: `apps/web/app/globals.css` (drop `overflow-x: hidden` from `body`, keep on `html`)
- Modify: `apps/web/app/layout.tsx` (`metadataBase`, needed for relative canonical/OG URLs)
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
  // FIREBASE_EMULATORS=1 lets `next start` (a production build) still target
  // the emulators locally — useful for testing the production bundle without
  // pointing it at real Firebase.
  if (process.env.NODE_ENV !== "production" || process.env.FIREBASE_EMULATORS === "1") {
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
import { useEffect, useRef, useState } from "react";

// One clip playing at a time across the page.
let currentAudio: HTMLAudioElement | null = null;

// null → no measured duration yet (still show nothing); 0 is a real
// (if degenerate) duration and must render "0:00", not be treated as falsy.
function formatDuration(durationSec: number | null): string {
  if (durationSec === null) return "";
  return `${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, "0")}`;
}

export function TrackPlayer({ title, url, durationSec }: { title: string; url: string; durationSec: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Unmount cleanup: stop playback and release the module-level "now
  // playing" pointer so a departed track can't block the next one.
  useEffect(() => () => {
    audioRef.current?.pause();
    if (currentAudio === audioRef.current) currentAudio = null;
  }, []);

  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) { audio.pause(); return; }
    if (currentAudio && currentAudio !== audio) currentAudio.pause();
    currentAudio = audio;
    audio.play().catch(() => setPlaying(false));
    setPlaying(true);
  };
  return (
    <button className="trackRow" onClick={toggle} aria-pressed={playing} aria-label={`${playing ? "Pause" : "Play"} ${title}`}>
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      <span>{title}</span>
      <span className="trackDur">{formatDuration(durationSec)}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create `apps/web/app/u/[handle]/portfolio.module.css`**

```css
/* Hybrid layout: hero-first single column on mobile, EPK split on desktop.
   Colors derive from the --foreground/--background tokens in globals.css so
   the page follows light/dark scheme instead of hardcoding a light palette. */
.page { max-width: 960px; margin: 0 auto; padding: 16px; }
.cover { width: 100%; aspect-ratio: 16 / 6; object-fit: cover; border-radius: 12px;
  background: color-mix(in srgb, var(--foreground) 12%, var(--background)); }
.layout { display: grid; gap: 24px; grid-template-columns: 1fr; margin-top: 16px; }
.identity { display: flex; flex-direction: column; gap: 8px; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; margin-top: -64px;
  border: 4px solid var(--background);
  background: color-mix(in srgb, var(--foreground) 10%, var(--background)); }
/* opacity (not a fixed gray) so it tracks --foreground across schemes and
   still clears WCAG AA (4.5:1) text contrast against --background in both. */
.genres { color: var(--foreground); opacity: 0.72; }
.section { margin-top: 24px; }
.bio { white-space: pre-wrap; line-height: 1.5; }
.links { display: flex; gap: 12px; flex-wrap: wrap; }
.links a { text-decoration: underline; }
.empty { color: var(--foreground); opacity: 0.72; margin-top: 24px; }
@media (min-width: 900px) {
  .layout { grid-template-columns: 300px 1fr; }
  .identity { position: sticky; top: 24px; align-self: start; }
  .avatar { margin-top: -48px; }
}
```

Plus global styles for `.trackRow` (add to the module as `:global` or inline in TrackPlayer — implementer's choice; keep it one of those, not a new global stylesheet):

```css
.tracks :global(.trackRow) { display: flex; gap: 12px; align-items: center; width: 100%;
  padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--foreground) 20%, var(--background));
  border-radius: 8px; margin-bottom: 6px; background: none; color: inherit; font: inherit;
  font-size: 15px; cursor: pointer; text-align: left; }
.tracks :global(.trackDur) { margin-left: auto; color: var(--foreground); opacity: 0.72; }
```

Also remove `overflow-x: hidden` from the shared `html, body` rule in `apps/web/app/globals.css` —
keep it on `html` only. A second copy on `body` silently breaks `position: sticky` in any
descendant (this page's sticky `.identity` sidebar included), and `html`'s copy already propagates.

- [ ] **Step 4: Rewrite `apps/web/app/u/[handle]/page.tsx` as a server component**

```tsx
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";
import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";

// Takedowns/approvals need to propagate within about a minute, and this page
// can't be gated behind App Check (it's plain SSR, no client attestation) —
// so ISR bounds repeat Firestore/Storage reads to once per handle per
// revalidate window instead of `force-dynamic`'s unbounded per-request reads.
// (A flood of distinct/random handles still costs one cold render each —
// this caps *repeat* hits on the same handle, not a broad crawl.)
export const revalidate = 60;
// Required for `revalidate` to take effect on a dynamic-params route: without
// this, Next treats the route as fully dynamic (no caching, revalidate is a
// no-op) per generate-static-params.md ("you must return an empty array ...
// in order to revalidate (ISR) paths at runtime"). An empty array means no
// paths are prerendered at build time; each handle is rendered (and cached)
// on its first request instead. Verified: without this, `next build` marks
// the route `ƒ` (fully dynamic); with it, `●` (SSG, ISR-eligible), and a
// second request to the same handle comes back `x-nextjs-cache: HIT`.
export function generateStaticParams() {
  return [];
}

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };
type Loaded = {
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
};

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch (e) {
    // Swallowed to null on purpose (a missing/racing object shouldn't 500 the
    // whole page), but a Storage-wide outage would otherwise silently empty
    // every avatar/cover/track URL with no signal anywhere — log it.
    console.warn("storageUrl failed", path, e);
    return null;
  }
}

// cache() dedupes this per-request across generateMetadata and the page body —
// both call loadProfile(handle) with the same argument, so React's per-request
// cache means the Firestore/Storage reads only actually happen once.
const loadProfile = cache(async (rawHandle: string): Promise<Loaded | null> => {
  const handle = rawHandle.toLowerCase(); // handles are stored lowercase
  try {
    const { db } = getServerFirebase();
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
    const [tracks, avatarUrl, coverUrl] = await Promise.all([
      Promise.all(trackSnap.docs.map(async (t) => {
        const d = t.data() as TrackDoc;
        const url = await storageUrl(d.storagePath);
        return url ? { id: t.id, title: d.title, durationSec: d.durationSec, url } : null;
      })).then((rows) => rows.filter((t): t is LoadedTrack => t !== null)),
      storageUrl(profile.portfolio?.avatarPhotoPath),
      storageUrl(profile.portfolio?.coverPhotoPath),
    ]);
    return { profile, tracks, avatarUrl, coverUrl };
  } catch (e) {
    // Duck-typed, not `e instanceof FirestoreError`: FirebaseError's own
    // constructor runs `Object.setPrototypeOf(this, FirebaseError.prototype)`
    // (an ES5-target workaround in @firebase/util, still present in the
    // built SDK) which clobbers the prototype chain of every subclass
    // instance — so a real FirestoreError never passes `instanceof
    // FirestoreError`, only `instanceof FirebaseError`. Trusting that check
    // would send every FirestoreError down the "rethrow as 500" path below,
    // including permission-denied ones — turning "not approved" into a
    // 404-vs-500 enumeration oracle for handle existence.
    //
    // permission-denied = the profile/track isn't approved (rules deny the
    // read) — that's a legitimate "not found" from the public's point of
    // view. not-found only fires if a doc vanishes between reads. Anything
    // else (offline, a missing index, a backend outage) is a real failure —
    // surface it as a truthful 500, not a silent "Not found" 200.
    const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
    if (code === "permission-denied" || code === "not-found") return null;
    console.error("portfolio load failed", handle, e);
    throw e;
  }
});

export async function generateMetadata(props: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  // The page component calls notFound() for the same null case, which
  // renders not-found.tsx's own `metadata` (its title) instead of whatever
  // this function returns — so only robots survives here in practice; keep
  // it anyway as a fallback for any caller that resolves metadata without
  // rendering the page (e.g. a metadata-only route consumer).
  if (!data) return { robots: { index: false } };
  const { profile } = data;
  const pf = profile.portfolio;
  const description = pf?.bio?.slice(0, 160)
    || [`${profile.name} on GateKeep`, pf?.genres?.length ? pf.genres.join(", ") : null]
      .filter(Boolean).join(" — ");
  return {
    title: `${profile.name} (@${profile.handle}) · GateKeep`,
    description,
    alternates: { canonical: `/@${profile.handle}` },
    openGraph: {
      title: `${profile.name} on GateKeep`,
      description,
      url: `/@${profile.handle}`,
      type: "profile",
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  };
}

export default async function PublicProfile(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) notFound(); // real HTTP 404 — data resolves before anything streams
  const { profile, tracks, avatarUrl, coverUrl } = data;
  const pf = profile.portfolio;
  // Defense in depth: links are validated https-only at write time
  // (validatePortfolioUpdate), but never trust stored data to render an
  // <a href> unchecked.
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
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
          {links.length > 0 && (
            <div className={styles.links}>
              {links.map((l) => (
                <a key={`${l.kind}:${l.url}`} href={l.url} rel="noopener noreferrer nofollow" target="_blank">{l.kind}</a>
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
          {tracks.length === 0 && !pf?.bio && (
            <p className={styles.empty}>This artist hasn&apos;t added content yet.</p>
          )}
          {/* Shows: platform events only (spec §2). The events collection ships in
              sub-projects 4/6 — this section stays hidden until it has data. */}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4b: Create `apps/web/app/u/[handle]/not-found.tsx`**

Rendered when `loadProfile()` returns `null` and the page calls `notFound()` — handle doesn't
exist, the profile isn't approved, or it's not a musician profile. Deliberately generic: never
confirms or denies that a draft exists at this handle. `notFound()` injects
`<meta name="robots" content="noindex">` automatically, but NOT a title — this segment's own
`metadata` export is what actually renders once `notFound()` throws (page.tsx's
`generateMetadata` return value never reaches the response for that request), so the title has
to live here.

```tsx
import type { Metadata } from "next";
import styles from "./portfolio.module.css";

export const metadata: Metadata = { title: "Not found · GateKeep" };

export default function NotFound() {
  return (
    <main className={styles.page}>
      <h1>Not found</h1>
      <p>No profile at that handle.</p>
    </main>
  );
}
```

- [ ] **Step 4c: Add a safe `metadataBase` fallback to the root layout**

`alternates.canonical` and `openGraph.url` above are relative paths (`/@handle`) — resolving
those to absolute URLs needs `metadataBase` set somewhere in the tree. Do NOT hardcode a
`http://localhost:3000` fallback: that would ship a canonical/og:url pointing at localhost in
production if `NEXT_PUBLIC_SITE_URL` is ever left unset. Instead fall back to Vercel's own
auto-populated `VERCEL_PROJECT_PRODUCTION_URL` env var, and omit `metadataBase` entirely (not a
guessed URL) if neither is set — verified empirically: `generateMetadata`'s relative
`alternates.canonical`/`openGraph.url` degrade gracefully to relative `<link>`/`<meta>` values
when `metadataBase` is absent (browsers/crawlers resolve those against the current origin; no
build error was observed for this ISR/runtime-rendered route). Add to `apps/web/app/layout.tsx`:

```ts
// NEXT_PUBLIC_SITE_URL is the explicit override (set it once a production
// domain exists); VERCEL_PROJECT_PRODUCTION_URL is Vercel's own env var,
// available automatically on Vercel deployments without any config. If
// neither is set, metadataBase is omitted entirely rather than falling back
// to a localhost URL — a missing canonical/og:url is invisible, but a
// canonical link pointing at http://localhost:3000 would ship broken SEO/
// share metadata into production.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: "GateKeep",
  description: "Find the music. Book the night.",
};
```

- [ ] **Step 4d: Fix `overflow-x: hidden` in `apps/web/app/globals.css`**

The existing `html, body { max-width: 100vw; overflow-x: hidden; }` rule breaks
`position: sticky` on any descendant once both elements carry `overflow-x: hidden` (`html`'s
copy already propagates). Split it so only `html` keeps `overflow-x: hidden`, and fold
`max-width: 100vw` into the existing `body { ... }` rule below rather than adding a second
`body` block:

```css
html {
  max-width: 100vw;
  overflow-x: hidden;
}

body {
  /* max-width: 100vw folded in here — no overflow-x: hidden (inherited from html). */
  max-width: 100vw;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--foreground);
  background: var(--background);
  font-family: Arial, Helvetica, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
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
Expected: green (0 errors — the two `@next/next/no-img-element` warnings on the avatar/cover
`<img>` tags are expected and fine; Storage download URLs aren't eligible for `next/image`
without a configured remote pattern).

Manual (needs `pnpm emu` + seeded approved profile with an approved track): `pnpm --filter @gatekeep/web dev`, open `http://localhost:3000/@<handle>` — page renders server-side (view-source shows content), track plays, `/u/<handle>` redirects to `/@<handle>`. Also check: `/@<MixedCaseHandle>` resolves the same profile (handles are lowercased before the Firestore lookup), and a nonexistent handle (`/@doesnotexist`) returns a true HTTP 404 (`curl -s -o /dev/null -w "%{http_code}"`), not a 200 with "not found" text in the body.

Also seed a **`pending_review`** (not `approved`) profile and request its handle — firestore.rules
denies the public read (`permission-denied`), which must still resolve to a real HTTP 404, not a
500. This is the case the duck-typed error narrowing in `loadProfile`'s catch exists for; a 500
here instead of a 404 is a live enumeration oracle (free handle = 404, taken-but-unapproved
handle = 500) and was caught exactly this way in review.

To verify the ISR/cache-HIT behavior specifically, use a production build rather than `next dev`
(dev always renders fresh): `pnpm --filter @gatekeep/web build`, confirm the route table shows
`● /u/[handle]` ("SSG ... uses generateStaticParams") rather than `ƒ`, then
`FIREBASE_EMULATORS=1 pnpm --filter @gatekeep/web start` and `curl -sD - http://localhost:3000/@<handle>`
twice — first response `x-nextjs-cache: MISS` with `Cache-Control: s-maxage=60, ...`, second
response `x-nextjs-cache: HIT`.

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

**Handoff from Task 9 (server gate — `functions/src/profiles.ts`):**
`submitProfileForReview` now rejects a musician submit unless the profile has
a bio, at least one genre, an avatar photo, AND at least one track whose
status is `pending_review` or `approved` — explicitly NOT `processing` (a
track doc that's still transcoding, or whose upload was abandoned, does not
count). If this task's "Submit for review" button implements any client-side
disable/lock state ahead of clicking submit (the current step snippets below
render the button unconditionally on `status === "draft"` and surface the
server's rejection message via `window.alert`), that lock must mirror the
server gate exactly: bio non-empty, ≥1 genre, avatar set, AND ≥1 track in
`pending_review`/`approved` — which means waiting for a just-uploaded track's
transcode to finish (poll or listen for status leaving `processing`) before
the lock releases, not merely confirming the upload request succeeded.
Getting this wrong in either direction is a real UX bug: locking on
`processing` alone lets the button unlock before there's anything to
review; not polling at all leaves the button clickable through a doomed
submit with no feedback until the round-trip fails. Also see Task 14's
handoff note — this same lock must be replicated on mobile, not just web.

**Delete-draft affordance:** `deleteProfile` (built in Task 9's foundation
work, before this plan) has zero client call sites as of this task —
foundation-rulings.md names it the intended cleanup path for an
orphaned/unwanted draft, but nothing in either app surfaces it yet. This
wizard (and/or the editor page, for a draft that's gone stale) should offer
a "delete this draft" action wired to `deleteProfile`, so a musician who
bails partway through onboarding isn't stuck with a permanent handle-holding
draft and no way to release it short of an admin/support action. See Task
14's handoff note — mobile needs the same affordance.

- [ ] **Step 1: Create `apps/web/src/portfolio/TrimUploader.tsx`**

Final code, post TWO rounds of quality-review fixes: decode-error handling,
an empty-vs-known-bad content-type distinction (empty is let through — some
OSes report "" for legit m4a/flac — but a non-empty unrecognized type is
still rejected), a `duration < 1` reject, stale-metadata reset, a clamped
clip window with a "whole file" fallback under 30s (also covering a
computed slider max of exactly 0), a re-pickable file input, mid-upload
failure cleanup via `deleteTrack`, and — the second round's Important
finding — the try block now closes immediately after `await task` resolves,
with the success-path side effects (including the caller-supplied `onDone`)
running OUTSIDE the try/catch:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  validateTrackCreate, AUDIO_CONTENT_TYPES, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput,
} from "@gatekeep/shared";

const UNREADABLE_MSG = "Couldn't read that audio file — try mp3, wav, m4a, aac, flac, or ogg.";
const UNSUPPORTED_MSG = "Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.";

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
  // ontimeupdate closes over state — keep the live value in a ref so the
  // handler (registered once per file, in pick()) always sees the current
  // slider position instead of the value at the time it was attached.
  const startRef = useRef(0);
  useEffect(() => { startRef.current = startSec; }, [startSec]);

  useEffect(() => () => { // revoke on unmount
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    audioRef.current?.pause();
  }, []);

  const pick = (f: File) => {
    setError(null);
    // Reset stale metadata from any previously picked file immediately —
    // otherwise a leftover `duration` from the last file renders a window
    // slider against the WRONG file's length until (if ever) this file's
    // onloadedmetadata fires.
    setDuration(0);
    // Reject only a KNOWN-bad type — a non-empty MIME type outside the
    // allowlist (e.g. "video/mp4", "text/plain"). An EMPTY f.type is let
    // through on purpose: some OSes/browsers report "" for legitimate but
    // less common containers (m4a, flac) instead of a proper audio/* MIME
    // type, and the server doesn't trust this field either way — ffmpeg
    // sniffs the actual container/codec from the bytes server-side. `pick`
    // is only a cheap client-side triage; gating on "empty" specifically
    // would reject real files this allowlist is supposed to accept. (See
    // upload() below, which falls back to "audio/mpeg" as a generic-but-
    // sniffable contentType for the empty case.)
    if (f.type && !(AUDIO_CONTENT_TYPES as readonly string[]).includes(f.type)) {
      setError(UNSUPPORTED_MSG);
      return;
    }
    if (f.size > MAX_AUDIO_UPLOAD_BYTES) { setError("File is over 50 MB."); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(f);
    const audio = new Audio(objectUrl.current);
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      // A file can pass the content-type check above yet still be
      // corrupt/unplayable (or report a nonsensical duration) — don't let
      // that silently produce a near-0-length or NaN clip window. `< 1`,
      // not `<= 0`: a sub-1-second "clip" isn't practically previewable or
      // trimmable either, so it's treated the same as unreadable.
      if (!Number.isFinite(d) || d < 1) { setError(UNREADABLE_MSG); return; }
      setDuration(d);
    };
    audio.onerror = () => setError(UNREADABLE_MSG);
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
      // file.type can legitimately be "" (see pick()'s comment above) — fall
      // back to a generic-but-sniffable contentType rather than sending an
      // empty string the server would reject outright; ffmpeg determines
      // the real container/codec from the bytes regardless of this value.
      sizeBytes: file.size, contentType: file.type || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy("Requesting upload…"); setError(null);
    // Tracked outside the try so the catch below can tell "createTrack
    // itself failed" (created stays null — nothing to clean up) apart from
    // "the track doc exists but the storage upload after it failed" (created
    // is set — the doc must be cleaned up, or it lingers as a dead
    // "Processing…" row with nothing behind it).
    let created: { trackId: string; uploadPath: string } | null = null;
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      created = data;
      // uploadPath comes straight from createTrack's response — never
      // reconstructed client-side, so the client and server always agree on
      // the staging object path even if stagingAudioPath's shape changes.
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), file,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading… ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      // The try closes HERE, right after the upload itself resolves — the
      // success-path side effects below run OUTSIDE the try/catch on
      // purpose. onDone() is a callback supplied by the parent; if it (or
      // anything else down here) were to throw while still inside the try,
      // the catch below would see `created` set and delete the track this
      // upload just successfully finished, mistaking a downstream error for
      // an upload failure.
    } catch (e) {
      setBusy(null);
      console.error(e); // the alert below is deliberately generic — keep the real error in the console
      if (created) {
        try {
          await httpsCallable(getFirebase().functions, "deleteTrack")({ profileId, trackId: created.trackId });
          setError("Upload failed — try again.");
        } catch {
          // Best-effort cleanup itself failed — tell the musician exactly
          // what's left behind instead of a generic message that leaves a
          // dead "Processing…" row unexplained.
          setError("Upload failed — delete the stuck 'Processing…' entry below and try again.");
        }
      } else {
        setError(e instanceof Error ? e.message : "Upload failed — try again.");
      }
      return;
    }
    setBusy(null); setFile(null); setTitle("");
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
    onDone();
  };

  const windowEnd = Math.min(startSec + MAX_CLIP_SECONDS, duration);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const sliderMax = Math.max(0, Math.floor(duration - MAX_CLIP_SECONDS));
  // Also covers the case where duration is JUST over 30s (e.g. 30.4s): the
  // slider's max would compute to 0 — a degenerate range with nowhere to
  // drag — so treat that the same as "whole file" instead of rendering a
  // slider that can't move.
  const wholeFileUsed = duration > 0 && (duration <= MAX_CLIP_SECONDS || sliderMax === 0);
  return (
    <div style={{ border: "1px dashed #bbb", borderRadius: 8, padding: 16, display: "grid", gap: 8 }}>
      <strong>Add a track (30-second snippet)</strong>
      <input type="file" accept={AUDIO_CONTENT_TYPES.join(",")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allows re-picking the same file after an error/removal
          if (f) pick(f);
        }} />
      {file && duration > 0 && (
        <>
          <input placeholder="Track title" value={title} maxLength={80}
            onChange={(e) => setTitle(e.target.value)} />
          {wholeFileUsed ? (
            <p style={{ margin: 0 }}>Whole file will be used (30 seconds or less)</p>
          ) : (
            <label>
              Clip window: {fmt(startSec)} – {fmt(windowEnd)} (of {fmt(duration)})
              <input type="range" min={0} max={sliderMax} step={1}
                value={startSec} style={{ width: "100%" }}
                onChange={(e) => setStartSec(Number(e.target.value))} />
            </label>
          )}
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

Final code, post quality-review fix pass (an in-flight `busy` lock across
move/rename/delete, `MAX_TRACKS` instead of a hardcoded `10`, and a trimmed,
empty-safe rename prompt):

```tsx
"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { MAX_TRACKS, type TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";

type Row = TrackDoc & { id: string };

const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
};

export function TrackManager({ profileId }: { profileId: string }) {
  const [tracks, setTracks] = useState<Row[]>([]);
  // Single flag, not per-row: reorderTracks affects TWO rows at once (the
  // swapped pair), so a per-row lock wouldn't stop a second click from
  // racing the first move's still-in-flight call against a still-stale
  // `tracks` array. Locking every action button while ANY call is in
  // flight is simpler and fully covers that.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);

  const call = async (name: string, data: object) => {
    setBusy(true);
    try { await httpsCallable(getFirebase().functions, name)(data); }
    catch (e) { window.alert(e instanceof Error ? e.message : "That didn't work — try again."); }
    finally { setBusy(false); }
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy || !tracks[i] || !tracks[i + dir]) return;
    // A single reorderTracks call with the whole reordered id list, not two
    // sequential updateTrack({ order }) calls — updateTrack no longer takes
    // an order field (reorderTracks owns ordering, atomically), and two
    // separate calls would be non-atomic (a reload between them leaves two
    // tracks sharing an order) and a no-op on ties.
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void call("reorderTracks", { profileId, trackIds: ids });
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/{MAX_TRACKS})</h2>
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
            <button onClick={() => move(i, -1)} disabled={busy || i === 0}>↑</button>
            <button onClick={() => move(i, 1)} disabled={busy || i === tracks.length - 1}>↓</button>
            <button disabled={busy} onClick={() => {
              const title = window.prompt("New title:", t.title)?.trim();
              if (title) void call("updateTrack", { profileId, trackId: t.id, title });
            }}>Rename</button>
            <button disabled={busy} onClick={() => {
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

Final code, post TWO rounds of quality-review fixes: `BioGenresForm` omits
`genres` from the payload entirely when none are picked yet (a bio-only
save has to work), and — second round — blocks the save with an explicit
message if genres were previously set and the musician deselects all of
them (silently omitting would leave the OLD value in place while looking
saved); `LinksForm` clears its url input only on success and gets a busy
lock; `PhotoUploader` takes the current photo path as a prop (not a
boolean), enforces the 10MB client-side cap, uses a visually-hidden (not
`display:none`) file input for keyboard focus with an `e.target.value = ""`
reset so the same file can be re-picked after a failure, shows a
"Processing…" state that persists until the path prop itself changes, and —
second round's Important finding — bounds that wait to 60s (some pipeline
failures never write anything back to the doc at all, which would otherwise
deadlock the control permanently) with a "still processing, try a smaller
one" fallback hint; `BookingForm` keeps rate inputs as raw strings
(converting to cents only in `save()`), rejects a `$0` rate client-side, and
adds `step`+a rounding note to the radius/minutes inputs:

```tsx
"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  GENRES, GIG_TYPES, MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type ExternalLink, type ExternalLinkKind, type RateAmount,
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
    if (genres.length === 0 && (initial?.genres?.length ?? 0) > 0) {
      // Genres were saved before and the musician has now deselected all of
      // them. The omit-when-empty branch below exists for the never-set-yet
      // case (a bio-only save while onboarding); reusing it here would
      // silently no-op — validatePortfolioUpdate rejects an explicit [], so
      // omitting the key just leaves the OLD genres in place server-side —
      // which looks to the musician like their change was saved (the chips
      // show empty) when it wasn't. Block it with an explicit message
      // instead.
      window.alert("Keep at least one genre — it's required for review.");
      return;
    }
    // Omit genres entirely (rather than sending []) when none are picked
    // yet — a bio-only save has to work while a musician is still filling
    // in the rest of the form; validatePortfolioUpdate (and the server)
    // both treat an omitted field as "leave it alone", but an explicit []
    // fails the 1-3-genres check.
    const payload = genres.length > 0 ? { profileId, bio, genres } : { profileId, bio };
    const v = validatePortfolioUpdate(payload);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", payload)) onSaved?.();
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
  const [busy, setBusy] = useState(false);
  const save = async (next: ExternalLink[]): Promise<boolean> => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { window.alert(v.reason); return false; }
    setBusy(true);
    const ok = await callOrAlert("updatePortfolio", { profileId, externalLinks: next });
    if (ok) setLinks(next);
    setBusy(false);
    return ok;
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Links</h2>
      {links.map((l, i) => (
        <p key={`${l.kind}-${l.url}-${i}`} style={{ margin: 0 }}>
          {l.kind}: {l.url}{" "}
          <button disabled={busy} onClick={() => void save(links.filter((_, j) => j !== i))}>Remove</button>
        </p>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as ExternalLinkKind)}>
          <option value="spotify">Spotify</option><option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option><option value="website">Website</option>
        </select>
        <input placeholder="https://…" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy} onClick={async () => {
          if (!url) return;
          // Clear the input only once the save actually succeeds — clearing
          // unconditionally (as before) silently threw away what the
          // musician typed on a validation failure or a network error.
          if (await save([...links, { kind, url }])) setUrl("");
        }}>Add</button>
      </div>
    </section>
  );
}

// Off-screen but still in the layout/tab order (unlike display:none, which
// pulls the element out of tab order entirely) — the visible label text
// stays clickable via <label>/<input> association, but keyboard users can
// still Tab to and activate the file input directly.
const VISUALLY_HIDDEN_INPUT: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", whiteSpace: "nowrap", border: 0, opacity: 0,
};

export function PhotoUploader({ profileId, uid, kind, currentPath }:
  { profileId: string; uid: string; kind: "avatar" | "cover"; currentPath: string | null }) {
  const [busy, setBusy] = useState(false);
  // The pipeline rewrites the profile doc's avatar/coverPhotoPath a few
  // seconds after the storage upload lands — we don't know its eventual
  // value client-side, so instead we keep showing "Processing…" until the
  // `currentPath` PROP itself moves. `baseline` tracks the last path we've
  // actually seen; when it disagrees with the incoming prop we're mid-render
  // with fresh data, so we adjust state right here (not in a useEffect —
  // this is React's documented "adjust state while rendering" escape hatch
  // for resetting state when a prop changes: since it runs synchronously
  // before commit, React just re-renders once more with the corrected
  // state instead of committing a stale frame first). This also closes the
  // double-upload race: while awaiting, the input is disabled instead of
  // sitting idle and inviting a second upload before the first has landed.
  const [awaiting, setAwaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [baseline, setBaseline] = useState(currentPath);
  if (currentPath !== baseline) {
    setBaseline(currentPath);
    if (awaiting) setAwaiting(false);
    if (timedOut) setTimedOut(false);
  }
  // Bounds the wait: some failures never write ANYTHING back to the profile
  // doc (an oversized/corrupt image the resize step rejects outright before
  // ever reaching a write, for instance), so `currentPath` would never move
  // and `awaiting` — and the disabled input — would otherwise deadlock
  // permanently. This is a legitimate useEffect (subscribing to an external
  // timer and calling setState from ITS callback, not synchronously in the
  // effect body), unlike the render-time adjustment above.
  useEffect(() => {
    if (!awaiting) return;
    const t = setTimeout(() => { setAwaiting(false); setTimedOut(true); }, 60_000);
    return () => clearTimeout(t);
  }, [awaiting]);

  const upload = async (f: File) => {
    if (f.size > MAX_PHOTO_UPLOAD_BYTES) { window.alert("Photos must be under 10 MB."); return; }
    setBusy(true);
    setTimedOut(false); // a fresh attempt supersedes any earlier timeout hint
    try {
      const { storage } = getFirebase();
      const path = stagingPhotoPath(uid, profileId, kind, crypto.randomUUID());
      await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
      setAwaiting(true);
      // The photo pipeline resizes/strips and updates the profile doc; the
      // parent page's snapshot listener feeds the new path back in as
      // `currentPath`, which the render-time check above picks up and
      // flips `awaiting` back to false.
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Upload failed.");
    } finally { setBusy(false); }
  };
  const processing = awaiting;
  return (
    <>
      <label style={{ display: "inline-block" }}>
        {busy ? "Uploading…" : processing ? "Processing…" : `Upload ${kind === "avatar" ? "profile photo" : "cover photo"}`}
        {currentPath && !processing && <span style={{ color: "#16a34a" }}> ✓</span>}
        <input type="file" accept="image/jpeg,image/png,image/webp" style={VISUALLY_HIDDEN_INPUT} disabled={busy || processing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // allows re-picking the same file (e.g. after a failed upload)
            if (f) void upload(f);
          }} />
      </label>
      {timedOut && (
        <span style={{ display: "block", color: "#92400e", fontSize: 12 }}>
          Still processing — if your photo doesn&apos;t appear, try a smaller one.
        </span>
      )}
    </>
  );
}

type RateKey = "perHour" | "perSong" | "perSet";
type RateInput = { amount: string; note: string | null };
const rateInputFrom = (r: RateAmount | null | undefined): RateInput =>
  r ? { amount: (r.amountCents / 100).toString(), note: r.note ?? null } : { amount: "", note: null };

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  // Raw strings, not derived cents: converting dollars -> cents -> back to a
  // display string on every keystroke (the old approach) fights the user
  // mid-entry — e.g. typing "1.50" round-trips through 150 cents and
  // re-renders as "1.5", dropping the trailing zero and disrupting the
  // cursor. Conversion now happens exactly once, in save().
  const [rateInputs, setRateInputs] = useState<Record<RateKey, RateInput>>({
    perHour: rateInputFrom(initial?.rates.perHour),
    perSong: rateInputFrom(initial?.rates.perSong),
    perSet: rateInputFrom(initial?.rates.perSet),
  });
  const [prefs, setPrefs] = useState(initial?.preferences ??
    { gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null,
      bringsOwnPA: null, availabilityPattern: null });
  const [busy, setBusy] = useState(false);

  const rateField = (key: RateKey, label: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ width: 120 }}>{label}</span>
      $<input type="number" min={0} step="0.01" style={{ width: 100 }}
        value={rateInputs[key].amount}
        onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: e.target.value } }))} />
      <input placeholder="note (optional)" maxLength={200} style={{ flex: 1 }}
        value={rateInputs[key].note ?? ""} disabled={rateInputs[key].amount.trim() === ""}
        onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: e.target.value || null } }))} />
    </label>
  );

  const save = async () => {
    const rates: { perHour: RateAmount | null; perSong: RateAmount | null; perSet: RateAmount | null } =
      { perHour: null, perSong: null, perSet: null };
    for (const key of ["perHour", "perSong", "perSet"] as const) {
      const raw = rateInputs[key].amount.trim();
      if (raw === "") continue; // stays null — field left blank on purpose
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        window.alert("Rates must be more than $0, or leave the field blank.");
        return;
      }
      rates[key] = { amountCents: Math.round(dollars * 100), note: rateInputs[key].note || null };
    }
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
      <label>Travel radius (km): <input type="number" min={0} max={3000} step={1} style={{ width: 90 }}
        value={prefs.travelRadiusKm ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          travelRadiusKm: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))} />
        <span style={{ color: "#666", fontSize: 12 }}> (whole numbers only)</span></label>
      <label>Act size:{" "}
        <select value={prefs.actSize ?? ""} onChange={(e) => setPrefs((p) => ({ ...p,
          actSize: (e.target.value || null) as typeof p.actSize }))}>
          <option value="">—</option><option value="solo">Solo</option>
          <option value="duo">Duo</option><option value="band">Band</option>
        </select></label>
      <label>Typical set (minutes): <input type="number" min={15} max={480} step={1} style={{ width: 90 }}
        value={prefs.typicalSetMinutes ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          typicalSetMinutes: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))} />
        <span style={{ color: "#666", fontSize: 12 }}> (whole numbers only)</span></label>
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

Final code, post quality-review fix pass: a `missingForSubmit()` helper that
mirrors `submitProfileForReview`'s gate exactly (own tracks subscription,
not borrowed from `TrackManager`) with an `Intl.ListFormat` missing-items
hint matching the server's message construction; a "Delete this profile"
affordance for `draft`/`rejected`; `key={profileId}` on the three
`initial`-seeded forms so an in-app navigation between two profiles' editors
(same route/component, different params — this does NOT remount) can't leak
one profile's form state onto another's; and a render-time (not
`useEffect`) reset of `booking` back to `"loading"` on a profileId change,
paired with a `cancelled` guard on the booking `getDoc` so a slow fetch for
the OLD profileId can't overwrite the new one's state after the fact:

```tsx
"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, getDoc, collection, query, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../../../src/portfolio/TrackManager";
import type { ProfileDoc, BookingDoc, TrackDoc } from "@gatekeep/shared";

type TrackRow = TrackDoc & { id: string };

// Mirrors functions/src/profiles.ts's submitProfileForReview gate EXACTLY:
// bio, >=1 genre, an avatar photo, AND >=1 track that's actually listenable
// (status pending_review or approved). A still-transcoding "processing"
// track deliberately does NOT count — see the server's
// LISTENABLE_TRACK_STATUSES, which excludes it because createTrack writes
// the doc before the client finishes uploading bytes, so "processing" can
// be an abandoned upload with nothing behind it. Getting this out of sync
// with the server is a real UX bug in either direction: locking on
// "processing" alone lets the button unlock before there's anything to
// review; not checking tracks at all leaves it clickable through a doomed
// submit with no feedback until the round-trip fails.
function missingForSubmit(profile: ProfileDoc, tracks: TrackRow[]): string[] {
  const missing: string[] = [];
  const pf = profile.portfolio;
  if (!pf?.bio?.trim()) missing.push("a bio");
  if (!pf?.genres?.length) missing.push("at least one genre");
  if (!pf?.avatarPhotoPath) missing.push("a profile photo");
  const hasListenableTrack = tracks.some((t) => t.status === "pending_review" || t.status === "approved");
  if (!hasListenableTrack) {
    missing.push(tracks.some((t) => t.status === "processing")
      ? "a track that's finished processing (still transcoding — this can take a minute)"
      : "at least one track");
  }
  return missing;
}

export default function PortfolioEditor(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [booking, setBooking] = useState<BookingDoc | null | "loading">("loading");
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Resets `booking` back to "loading" the instant profileId changes — an
  // in-app navigation from profile A's editor to profile B's (same
  // route/component, different params) does NOT remount this page, so
  // without this, B's first render(s) would show A's still-cached booking
  // data. Adjusted during render (React's documented pattern for resetting
  // state when a prop/param changes — https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
  // not in a useEffect: this runs synchronously before commit, so React
  // re-renders once more with the reset state instead of painting a stale
  // frame first.
  const [bookingProfileId, setBookingProfileId] = useState(profileId);
  if (profileId !== bookingProfileId) {
    setBookingProfileId(profileId);
    setBooking("loading");
  }

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
    // `cancelled` guards against a stale WRITE (as opposed to the stale
    // READ the render-time reset above handles): without it, navigating
    // from profile A's editor to profile B's can let A's getDoc resolve
    // AFTER B's effect has already started, overwriting B's freshly-reset
    // booking state with A's data.
    let cancelled = false;
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as BookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; unsub(); };
  }, [user, profileId]);
  // Own subscription, separate from TrackManager's below: the submit-lock
  // gate below needs live track statuses at THIS level (to enable/disable
  // the button and render the missing-items hint) independent of
  // TrackManager's own list UI — listening for a track's status leaving
  // "processing" without polling.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [user, profileId]);

  // `booking === "loading"` is load-bearing here, not just a nicety: the
  // render-time reset above sets `booking` back to "loading" the instant
  // profileId changes, but React commits that state change to the DOM on
  // the SAME render pass unless something short-circuits it. This early
  // return is what actually keeps that reset from being purely cosmetic —
  // without it, profile A's already-loaded `profile`/`tracks` state (and
  // the forms below) would render through the gap between the reset and B's
  // getDoc resolving, showing A's rates/preferences under profile B's
  // name/status for a beat. Do not drop this condition as "redundant" with
  // the render-time reset alone.
  if (loading || !user || profile === "loading" || booking === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "musician") return <main><p>No musician profile here.</p></main>;

  const missing = missingForSubmit(profile, tracks);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";

  const submit = async () => {
    setSubmitBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId });
    } catch (e) {
      // The server's failed-precondition message is user-ready — surface it
      // verbatim. This is the backstop for a race the client gate's snapshot
      // hasn't caught up to yet (e.g. a track flips out of pending_review
      // between renders), not the primary UX (the button is disabled while
      // `missing` is non-empty).
      window.alert(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const deleteDraft = async () => {
    const ok = window.confirm(
      `Delete "${profile.name}"? This permanently deletes the profile, its tracks, and its photos, ` +
      `and releases the handle @${profile.handle}. This can't be undone.`);
    if (!ok) return;
    setDeleteBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      router.push("/dashboard");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not delete this profile.");
      setDeleteBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 32 }}>
      <h1>{profile.name} — portfolio</h1>
      <p>
        Status: <strong>{profile.status.replace("_", " ")}</strong>
        {profile.status === "approved" && (
          <> · <a href={`/@${profile.handle}`} target="_blank" rel="noopener noreferrer">view public page</a></>
        )}
      </p>
      {profile.status === "rejected" && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12 }}>
          <strong>Changes requested:</strong> {profile.rejectionReason ?? "(no reason provided)"}
        </div>
      )}
      <section>
        <h2>Photos</h2>
        <p>
          <PhotoUploader profileId={profileId} uid={user.uid} kind="avatar" currentPath={profile.portfolio?.avatarPhotoPath ?? null} />
          {" · "}
          <PhotoUploader profileId={profileId} uid={user.uid} kind="cover" currentPath={profile.portfolio?.coverPhotoPath ?? null} />
        </p>
        <p style={{ color: "#666" }}>Photos appear on your page a few seconds after upload.</p>
      </section>
      {/* Keyed by profileId: these forms seed their local state from `initial`
          only once, on mount (see PortfolioForms.tsx). Without the key, an
          in-app navigation from one profile's editor to another's (same
          route/component, different params) would reuse these instances and
          leave the FIRST profile's bio/links/rates showing — and editable —
          on top of the second profile's data until a full reload. */}
      <BioGenresForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <LinksForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <TrackManager profileId={profileId} />
      <BookingForm key={profileId} profileId={profileId} initial={booking} />
      {showSubmit && (
        <section style={{ display: "grid", gap: 8, borderTop: "1px solid #eee", paddingTop: 24 }}>
          <button onClick={submit} disabled={!canSubmit || submitBusy} style={{ padding: 12, fontSize: 16 }}>
            {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
          </button>
          {!canSubmit && (
            <p style={{ color: "#92400e", margin: 0 }}>
              {/* Same construction as the server's failed-precondition message
                  (functions/src/profiles.ts) — "a bio, at least one genre, and
                  a profile photo" instead of a raw comma join, so the client
                  hint reads identically to what the server would say if this
                  lock were somehow bypassed. */}
              Add {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing)} before submitting.
            </p>
          )}
          <button onClick={deleteDraft} disabled={deleteBusy}
            style={{ color: "#dc2626", justifySelf: "start", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 12px" }}>
            {deleteBusy ? "Deleting…" : "Delete this profile"}
          </button>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Create the wizard `apps/web/app/join/page.tsx`**

The wizard is the same editor flow with hand-holding: create the draft, then walk the editor sections in order, then submit. Keep it thin — steps reuse the Task 11 components.

Final code, post quality-review fix pass: the sign-in redirect moved from
render into a `useEffect` (matching the editor page's auth guard exactly —
calling `router.replace` directly in the render body updates router state
while a different component is mid-render, which React 19 and Strict Mode
both flag), rendering `null` while unauthenticated instead:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { validateProfileDraft, type ProfileDraftInput } from "@gatekeep/shared";

// Step 1 of the musician wizard: identity → creates the draft, then hands off
// to the portfolio editor which owns bio/photos/tracks/rates and the submit
// button (its gate messaging comes from the server). Musician-only — curator
// onboarding is sub-project 3. Deliberately does NOT auto-submit: the editor
// is where the required minimums (bio, genre, avatar, a listenable track) get
// filled in, and its submit button is locked until the server's gate is
// satisfied.
export default function Join() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // Mirrors the editor page's auth guard exactly: the redirect is a side
  // effect, not something to trigger during render.
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  const [subtype, setSubtype] = useState<"solo" | "band">("solo");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) return null; // redirecting via the effect above

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
      // Server errors are user-ready here too — e.g. "That handle is taken."
      // or the unsubmitted-drafts cap ("finish or delete an existing draft
      // first"), which points a stuck user at the editor's delete-draft
      // affordance.
      setError(e instanceof Error ? e.message : "Could not create your profile.");
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", display: "grid", gap: 12 }}>
      <a href="/dashboard" style={{ color: "#666", fontSize: 14 }}>← Dashboard</a>
      <h1>Join as a musician</h1>
      <p>Create your act. You&apos;ll add your bio, photos, and a first track next —
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
  {p.type === "musician" && (
    <> · <a href={`/dashboard/portfolio/${p.profileId}`}>
      {p.status === "draft" ? "finish setup" : p.status === "rejected" ? "revise & resubmit" : "edit portfolio"}
    </a></>
  )}
</li>
// empty state:
{profiles.length === 0 && <p>None yet — <a href="/join">join as a musician</a>, or from the mobile app.</p>}
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

> **Post-review revision:** this section documents the FINAL shipped code
> after a quality-review pass hardened the first cut (see "Quality-review
> hardening" below the original steps). The steps below are kept in their
> original order but their code blocks now show the final, byte-exact
> implementation — not the version that first went green.

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: Add a `TracksQueue` section**

Add to `apps/web/app/admin/page.tsx` (following the existing `Queue` component's patterns exactly — per-row busy state, checklist banner):

```tsx
import { useEffect, useState, useRef } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs, doc,
  type DocumentReference,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import type { TrackDoc } from "@gatekeep/shared";

type TrackRow = Row<TrackDoc> & { profileId: string; profileName: string };

// Owns the Approve/Reject actions for exactly one pending track — same
// per-row-busy-state rationale as QueueRow above. Also resolves and plays the
// review clip inline (spec §6: admin listens before approving), via
// getDownloadURL on the track's review/... storagePath — admins can read any
// review clip under storage.rules. url is three-state: null while resolving
// (loading placeholder), "error" if getDownloadURL rejects (e.g. the object
// is missing — surfaced as an explicit dead-end rather than an infinite
// "clip loading…", since nothing will ever move it out of that state), or
// the resolved string. storagePath is typed nullable on TrackDoc (other
// statuses can have no file yet); the transcode trigger only ever writes
// status:"pending_review" and storagePath together in the same update, so in
// practice every row here has one, but the effect still guards against a
// falsy path rather than assuming that invariant.
function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!t.storagePath) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, t.storagePath))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => {
        console.error("TrackQueueRow: getDownloadURL failed", t.storagePath, e);
        if (!cancelled) setUrl("error");
      });
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{t.title}</strong> — {t.profileName} · {t.durationSec ?? "?"}s
      {t.storagePath == null
        ? <p style={{ color: "#888" }}>No clip on file.</p>
        : url === "error"
          ? <p style={{ color: "#b00020" }}>Clip unavailable — reject and ask the musician to re-upload.</p>
          : url
            ? <audio controls preload="none" src={url} style={{ display: "block", margin: "8px 0" }} />
            : <p style={{ color: "#888" }}>clip loading…</p>}
      <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
      <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
    </div>
  );
}

// Pending-track review queue (spec §6). collectionGroup('tracks') mirrors
// Queue's flat collection query above, but tracks live under
// profiles/{profileId}/tracks — collectionGroup + the admin CG-read rule and
// fieldOverride index (already in place) is what makes a single
// cross-profile "everything pending" listener possible. Bounded with
// limit(100), same reasoning as AuditLog's limit(50): an admin listener
// should never fan out unboundedly. This intentionally doesn't order by
// createdAt (i.e. isn't FIFO-oldest-first) — collectionGroup + an equality
// filter + orderBy on a different field needs its own composite index,
// which doesn't exist yet; deferred until the queue realistically nears
// this cap and ordering starts to matter.
//
// Each snapshot also resolves the parent profile doc for its name
// (deleted-profile-safe, same "(deleted)" fallback the mobile/web
// dashboards use elsewhere) — batched via Promise.all over the *unique*
// profile ids in this snapshot (several pending tracks routinely share a
// profile), not one sequential getDoc per track. Two race guards on top of
// that N+1 resolution, since it's async work hanging off a listener that
// can fire again before it finishes: `cancelled` (composed into the
// cleanup, same convention as UserProfiles below) for unmount, and a
// monotonic `seq` token so a slower, older snapshot's resolution can never
// finish after and repaint over a newer one's already-committed state.
function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    let cancelled = false;
    let seq = 0;
    const unsubscribe = onSnapshot(
      query(collectionGroup(db, "tracks"), where("status", "==", "pending_review"), limit(100)),
      async (s) => {
        const mySeq = ++seq;
        const profileRefs = new Map<string, DocumentReference>();
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          profileRefs.set(profileRef.id, profileRef);
        }
        const nameEntries = await Promise.all(
          Array.from(profileRefs.values()).map(async (profileRef) => {
            const p = await getDoc(profileRef);
            return [profileRef.id, p.exists() ? (p.data() as ProfileDoc).name : "(deleted)"] as const;
          }),
        );
        if (cancelled || mySeq !== seq) return;
        const names = new Map(nameEntries);
        const rows: TrackRow[] = [];
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          rows.push({
            id: d.id,
            profileId: profileRef.id,
            profileName: names.get(profileRef.id) ?? "(deleted)",
            ...(d.data() as TrackDoc),
          });
        }
        setPending(rows);
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return (
    <section>
      <h2>Track review queue ({pending.length})</h2>
      {/* Screening guidance per spec §6: admins hear exactly what the public would. */}
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        You are hearing exactly what the public would hear. Screening call: does this
        sound like the artist&apos;s own performance (not AI-generated / not someone
        else&apos;s recording)? When unsure, reject with a note asking for context.
      </p>
      {pending.map((t) => <TrackQueueRow key={`${t.profileId}-${t.id}`} t={t} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}
```

- [ ] **Step 1b: Add a `TakedownsPanel` section**

`reviewTrack` (Task 8) accepts `decision: "rejected"` on an already-`approved`
track as a retroactive takedown (spec §6: "admins can retroactively
unpublish"), but as of Task 8 that path is backend-only — nothing in the
admin UI can reach it, since `TracksQueue` above only ever lists
`pending_review` tracks. Below the pending queue, a small handle-lookup
panel: type a profile's `@handle`, see its currently-`approved` tracks, and
remove one with a reason (same `reviewTrack` call, `decision: "rejected"`).
Same `handles/{handle} -> profileId` indirection the public `/u/[handle]`
route uses, and handles are stored lowercase there too.

```tsx
function TakedownsPanel() {
  const [handle, setHandle] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Row<TrackDoc>[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Track ids whose most recent removal attempt committed the reject
  // server-side but then hit reviewTrack's "unavailable" (public clip
  // couldn't be deleted) — see the remove() catch below for why these stay
  // in `tracks` and get a visible marker instead of disappearing.
  const [incompleteIds, setIncompleteIds] = useState<Set<string>>(new Set());
  // Guards lookup() the same way TracksQueue's `seq` guards its snapshot
  // handler: the Enter-key handler and the Look-up button both call
  // lookup(), and disabling on lookupBusy narrows but doesn't fully close
  // the window for a second call to start before React commits the first's
  // setLookupBusy(true) (both can read the same stale closure mid-event). A
  // ref (not state — needs to be readable synchronously the instant a
  // response resolves) means a slower, superseded lookup's response can
  // never overwrite a newer one's already-displayed results.
  const lookupSeq = useRef(0);

  const lookup = async () => {
    const h = handle.trim().toLowerCase();
    if (!h) return;
    const mySeq = ++lookupSeq.current;
    setLookupBusy(true);
    // Clear any previous handle's results up front, so a failed lookup (or a
    // slow one) never leaves a stale profile's tracks on screen under a new
    // handle in the input.
    setProfileId(null);
    setTracks([]);
    setIncompleteIds(new Set());
    try {
      const { db } = getFirebase();
      const handleDoc = await getDoc(doc(db, "handles", h));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      if (!handleDoc.exists()) { window.alert("No profile with that handle."); return; }
      const pid = (handleDoc.data() as { profileId: string }).profileId;
      const snap = await getDocs(query(
        collection(db, `profiles/${pid}/tracks`), where("status", "==", "approved"), orderBy("order")));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      setProfileId(pid);
      setTracks(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) })));
    } catch (e) {
      if (mySeq === lookupSeq.current) {
        window.alert(e instanceof Error ? e.message : "Could not look up that handle — try again.");
      }
    } finally {
      if (mySeq === lookupSeq.current) setLookupBusy(false);
    }
  };

  const remove = async (trackId: string) => {
    if (!profileId) return;
    const reason = window.prompt(
      "Takedown reason (shown to the musician) — this removes the track from their live profile immediately:",
    ) ?? "";
    if (!reason) return;
    setBusyId(trackId);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId, trackId, decision: "rejected", reason });
      setTracks((ts) => ts.filter((t) => t.id !== trackId));
      setIncompleteIds((ids) => { const next = new Set(ids); next.delete(trackId); return next; });
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/unavailable") {
        // reviewTrack already committed "rejected" before throwing this —
        // the decision is final at the transaction, storage cleanup runs
        // after (see that function's comments) — so the public object may
        // still be reachable even though the doc says rejected. Don't
        // filter the row out: a fresh lookup queries status=="approved",
        // which this doc no longer matches, so re-looking-up would just
        // silently drop the row and hide an incomplete takedown. Mark it
        // instead, so the admin sees it needs a retry rather than assuming
        // it's still an ordinary live track.
        setIncompleteIds((ids) => new Set(ids).add(trackId));
      } else {
        window.alert(e instanceof Error ? e.message : "Could not remove the track — try again.");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <h2>Takedowns</h2>
      <p>Retroactively remove a live track from an approved profile (spec §6).</p>
      <input
        placeholder="@handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !lookupBusy) void lookup(); }}
      />{" "}
      <button disabled={lookupBusy} onClick={lookup}>{lookupBusy ? "Looking up…" : "Look up"}</button>
      {tracks.map((t) => (
        <div key={t.id} style={{ border: "1px solid #ddd", padding: 12, marginTop: 8 }}>
          <strong>{t.title}</strong> · {t.durationSec ?? "?"}s
          {incompleteIds.has(t.id) && (
            <p style={{ color: "#b00020", margin: "4px 0" }}>
              Removal incomplete — retry. (The track is already off review, but the public
              clip may still be reachable.)
            </p>
          )}
          <div>
            <button disabled={busyId === t.id} onClick={() => remove(t.id)}>
              {busyId === t.id ? "Removing…" : incompleteIds.has(t.id) ? "Retry removal…" : "Remove…"}
            </button>
          </div>
        </div>
      ))}
      {profileId && tracks.length === 0 && <p>No approved tracks.</p>}
    </section>
  );
}
```

Render it in `AdminPage` between `<Queue />` and `<UserLookup />`, after `TracksQueue`: `<Queue /><TracksQueue /><TakedownsPanel /><UserLookup /><AuditLog />`.

- [ ] **Step 2: Verify**

Run: `pnpm --filter @gatekeep/web exec next typegen && pnpm --filter @gatekeep/web typecheck && pnpm --filter @gatekeep/web lint && pnpm --filter @gatekeep/web build`
Manual: with a pending track from the Task 11 loop, admin hears the clip inline, approve flips it Live on the public page; reject shows the reason in the musician's TrackManager.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(web): admin track review queue with inline playback"
```

#### Quality-review hardening (folded into the Step 1/Step 1b code above)

A review pass on the first cut found five gaps, closed in a single follow-up
commit (`fix(web,functions): admin queue race guards, clip-error states,
takedown notification integrity`) — the code blocks above already reflect the
fix, not the original:

1. **TracksQueue's snapshot handler had no unmount/staleness guards and did a
   sequential N+1 profile lookup.** The original `onSnapshot` callback awaited
   one `getDoc` per track in a `for` loop with no `cancelled` flag and no
   protection against out-of-order completion — a slower, older snapshot's
   resolution could finish after a newer one and repaint stale state over it,
   and an unmounted component's listener could still call `setPending`. Fixed
   by adding the same `cancelled` convention `UserProfiles` already uses
   (composed into the `onSnapshot` cleanup alongside `unsubscribe`), a
   monotonic `seq` token so only the latest snapshot's resolution can commit,
   and replacing the sequential per-track lookups with `Promise.all` over the
   *unique* profile ids in the snapshot (a `Map` cache keyed by profileId).
   Also replaced the non-null-asserted `d.ref.parent.parent!` with the same
   defensive `if (!profileRef) continue` `UserProfiles` uses.
2. **TrackQueueRow's clip URL had no error state.** `getDownloadURL` failures
   collapsed `url` back to `null`, which the row rendered as a permanent
   "clip loading…" with no way out. Fixed by making `url` three-state
   (`string | null | "error"`), logging the failure via `console.error`, and
   rendering a distinct "Clip unavailable — reject and ask the musician to
   re-upload." message on error.
3. **TakedownsPanel's Enter-key handler ignored the busy lock, and `lookup()`
   had no protection against out-of-order responses.** Fixed by gating the
   Enter handler on `!lookupBusy` and adding a `useRef`-backed `lookupSeq`
   token (same rationale as TracksQueue's `seq`) so a slower, superseded
   lookup's response can never overwrite a newer one's already-displayed
   results. Also: a removal that hits reviewTrack's `unavailable` throw (the
   decision is already committed "rejected" server-side; only the public
   object's delete failed) used to leave the row looking like an ordinary
   still-live approved track. Fixed by tracking those track ids in an
   `incompleteIds` set, keeping the row in `tracks` instead of hiding it
   (hiding it via a fresh lookup would just silently drop it — the doc no
   longer matches `status=="approved"`), and marking it "Removal incomplete —
   retry."
4. **The CG pending-track query was unbounded.** Fixed with `limit(100)`,
   matching `AuditLog`'s `limit(50)` — with a comment noting FIFO
   (oldest-pending-first) ordering would need its own composite index on the
   `tracks` collectionGroup, deliberately deferred.
5. **Cross-cutting: `functions/src/tracks.ts`'s `reviewTrack` could lose a
   takedown notification across a retry.** See Task 8's "Quality-review
   hardening (pass 3)" for the fix — reject's notification moved to fire
   alongside its audit, at claim time, instead of at the end of the function
   where a storage-cleanup failure could abort the call before ever reaching
   it.

Also `preload="none"` on the review-clip `<audio>` element — an admin
scrolling the queue shouldn't eagerly fetch every clip's audio before
choosing to play one.

---

### Task 13: Mobile — dependencies + portfolio components

**Files:**
- Modify: `apps/mobile/package.json` (via expo install)
- Create: `apps/mobile/src/portfolio/TrimUploader.tsx`
- Create: `apps/mobile/src/portfolio/TrackManager.tsx`
- Create: `apps/mobile/src/portfolio/PortfolioForms.tsx`

**DO NOT COPY from web — Task 11's quality-review fix pass found these bugs
in the web components below; the RN ports in this task must NOT repeat
them.** Web's components have already been rewritten with the fixes; the
snippets in Task 11 above reflect the corrected code. When porting the same
logic here, translate the FIX, not the original mistake:
- **Render-phase `router.replace`.** Never call a navigation redirect
  directly in a component's render body (web's `join/page.tsx` did this
  before its fix). Do it in a `useEffect` gated on the auth-loaded
  condition, and render nothing (or a loading state) while it's pending.
- **Unkeyed child-form seeding.** `BioGenresForm`/`LinksForm`/`BookingForm`
  seed local state from an `initial` prop only once, on mount
  (`useState(initial?.x ?? default)`). Expo Router's stack navigator reuses
  screen instances across param changes exactly like Next's App Router
  does — switching the active profile context without a full remount will
  leak the PREVIOUS profile's bio/links/rates into the new one unless these
  forms are explicitly re-keyed by `profileId` (`key={profileId}` on each,
  same as the web editor page does).
- **`crypto.randomUUID` for nonces.** React Native/Hermes has no
  `crypto.randomUUID`. `PhotoUploader`'s nonce must use the
  `${Date.now()}-${Math.floor(Math.random() * 1e9)}` pattern already
  specified in Step 4 below (uniqueness, not secrecy, is all that's
  needed) — do not port web's `crypto.randomUUID()` call as-is.
- **Try-block boundary around a successful upload.** Web's
  `TrimUploader.upload()` originally kept the post-upload success side
  effects (clearing local state, revoking the object URL, and calling the
  parent-supplied `onDone()` callback) INSIDE the same `try` that awaited
  the storage upload. That's a trap: if `onDone()` — a callback the PARENT
  controls, not this component — threw for any reason, the `catch` block
  would see the "track doc was created" flag set and delete the track that
  had JUST finished uploading successfully, mistaking a downstream/unrelated
  error for an upload failure. Fixed by closing the `try` immediately after
  the upload itself resolves and moving every success-path side effect
  OUTSIDE the try/catch. Any RN port of `TrimUploader`'s `upload()` (or
  `PhotoUploader`'s) must keep that same boundary — do not fold the
  post-upload cleanup back inside the try "for symmetry" with the
  request/upload calls above it.
- **`display:none`-equivalent file inputs.** Not applicable to RN's
  `Pressable`-triggered `DocumentPicker` flow the same way (there's no
  native `<input type="file">` to hide), but if any web accessibility
  pattern gets ported by habit, remember RN has no DOM — use
  `accessibilityRole`/`accessibilityLabel` on `Pressable`, not a CSS
  visibility trick.
- **`Intl.ListFormat` for the missing-items hint.** `Intl.ListFormat`
  requires full-ICU data; Hermes (RN's default JS engine) ships without it
  unless the app explicitly enables `hermes.icu` bundling. Verify
  `Intl.ListFormat` actually works on-device before porting the web
  editor's missing-items hint verbatim — if it's unavailable or unverified,
  fall back to a plain `missing.join(", ")` (still correct, just less
  polished prose) rather than crashing or silently no-op'ing.

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

**Handoff from Task 9 (server gate — `functions/src/profiles.ts`), mirrors
the Task 11 note:** `submitProfileForReview` rejects a musician submit
unless bio, ≥1 genre, avatar, AND ≥1 track with status `pending_review` or
`approved` are all present — `processing` (still transcoding, or an
abandoned upload) does not count. Any client-side submit-lock/disable state
this task adds to the portfolio tab must mirror that exactly, which means
waiting for a track's status to leave `processing` before the lock
releases, not just confirming the upload call succeeded. Keep mobile and
web (Task 11) in sync on this — a lock that's looser on one platform than
the other means musicians get a different (and confusing) submit
experience depending which app they used.

**MUST FIX — mobile join is currently broken for musicians.** As of
foundation, `apps/mobile/app/join.tsx` calls `createProfileDraft` and
`submitProfileForReview` back-to-back in one flow for every profile type,
musician included. That was fine pre-SP2 (there was no portfolio content to
gate on), but Task 9's minimum-content gate means that auto-submit will now
ALWAYS fail with `failed-precondition` for a brand-new musician draft (no
bio/genre/avatar/track exists yet at the moment of creation) — the join flow
is broken for musicians until this task lands. This task MUST rewrite
`join.tsx` so a musician draft, after `createProfileDraft`, routes straight
into the portfolio tab / wizard steps to collect the minimum content instead
of auto-submitting (mirroring the web wizard's Task 11 `createDraft` →
`router.push` handoff, not a create-then-submit call). Curator joins are
unaffected (no gate) and can keep the existing create-then-submit behavior.

**Delete-draft affordance (both wizards):** same as the Task 11 note —
`deleteProfile` has zero client call sites today; foundation-rulings.md
names it the orphaned-draft cleanup path. The mobile wizard/portfolio tab
needs a "delete this draft" action wired to `deleteProfile` alongside web's,
so a musician who abandons onboarding partway through isn't stuck holding a
handle with no self-service way to release it.

**DO NOT COPY from web — Task 11's quality-review fix pass found these bugs
in web's editor page/components; the `(musician)/portfolio.tsx` tab in this
task must NOT repeat them.** Web's page has already been rewritten with the
fixes; the Task 11 snippets above reflect the corrected code:
- **Render-phase `router.replace`.** Web's `join/page.tsx` originally called
  `router.replace("/sign-in")` directly in the render body when
  unauthenticated — fixed to a `useEffect` gated on the auth-loaded
  condition. Any auth guard added to the portfolio tab or `join.tsx` here
  must do the same: redirect from an effect, never from render.
- **Unkeyed child-form seeding.** `BioGenresForm`/`LinksForm`/`BookingForm`
  seed local state from an `initial` prop only once, on mount. Expo
  Router's stack navigator reuses screen instances across a profile-context
  switch exactly like Next's App Router reuses the editor page across a
  `profileId` change — this is even MORE routine on mobile, where switching
  the active profile context (not a full app restart) is the normal way a
  multi-profile musician moves between profiles. Without re-keying these
  forms by `profileId` (`key={profileId}` on each, same as web), the
  PREVIOUS profile's bio/links/rates will leak onto the newly-selected
  profile's form until the tab is force-remounted.
- **`crypto.randomUUID` for nonces.** RN/Hermes has no `crypto.randomUUID`.
  Step 4 of Task 13 already specifies the correct
  `${Date.now()}-${Math.floor(Math.random() * 1e9)}` nonce pattern for
  `PhotoUploader` — use that, not a ported `crypto.randomUUID()` call.
- **Try-block boundary around a successful upload.** Same trap as Task 13's
  note on `TrimUploader.upload()`: the post-upload success side effects
  (including any parent-supplied "done" callback) must run OUTSIDE the try
  that awaits the upload, not inside it — otherwise a throw from that
  callback gets mistaken for an upload failure and deletes the track that
  just succeeded. `TrimUploader.tsx` itself is created once in Task 13 and
  reused here by the portfolio tab; if this task touches or duplicates any
  of that upload-then-callback logic (e.g. wiring its own completion
  handling around `TrackManager`/`TrimUploader`), keep the same boundary.
- **`Intl.ListFormat` for the missing-items hint.** If this tab's
  submit-lock (see the handoff note above) renders a missing-items hint
  mirroring web's, verify `Intl.ListFormat` is actually available under
  Hermes (it needs full-ICU data, not enabled by default) before porting
  web's `new Intl.ListFormat("en", { style: "long", type: "conjunction"
  })` call — fall back to a plain `missing.join(", ")` if unverified.

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
- Environment variables table: add a row for `NEXT_PUBLIC_SITE_URL` (app: web; purpose: absolute
  base URL for the public portfolio page's canonical link + OpenGraph `og:url`/images — see
  `apps/web/app/layout.tsx`'s `metadataBase`; default when unset: falls back to Vercel's
  `VERCEL_PROJECT_PRODUCTION_URL` if present, else `metadataBase` is omitted and those URLs
  render relative instead of absolute — never a hardcoded localhost fallback).
- Manual follow-ups: **replace** the "native App Check lands in sub-project 2" sentence — EAS production build + native App Check moved to a dedicated launch-prep track (per SP2 spec §1), same must-review list as the admin/internal deferred items. Add: create the production Storage bucket lifecycle rule (24h TTL on `staging/`) in the Firebase console/deploy config before launch — the emulator does not enforce lifecycle rules.
- Manual follow-ups: the App Check enforcement checklist must cover Cloud Storage, not just Firestore + Functions — and Storage must NOT be flipped to enforce until native mobile App Check ships (mobile currently has no App Check attestation; enforcing early would lock the app out of its own uploads).
- Manual follow-ups: abandoned `processing` tracks (created via `createTrack` but never uploaded, or stuck if the transcode trigger never fires) hold one of the 10 cap slots indefinitely until a member manually deletes them; consider a scheduled cleanup sweep (e.g. delete `processing` tracks older than 24h) in a later sub-project.
- Manual follow-ups (public portfolio page, from Task 10 quality review):
  - Store resolved Storage download URLs on the profile/track docs at write time (photo/media
    pipeline) instead of calling `getDownloadURL` on every SSR render — removes the per-render
    Storage round trips `loadProfile` does today (perf follow-up, not correctness).
  - Split a public route group (`app/(public)/u/[handle]`) without `AuthProvider` in its layout —
    the public portfolio page currently ships the full client-side auth bundle (~1.2MB JS) it
    never uses.
  - Add `sitemap.ts`/`robots.ts` once internal links to `/@handle` pages exist elsewhere in the
    app (nothing links to them yet, so a sitemap would be premature).
  - Wire server-side Sentry (`instrumentation.ts`) once DSNs exist — mirrors the existing
    client-side `instrumentation-client.ts` no-op-until-configured pattern.
- Manual follow-ups (web polish, from Task 11's quality review):
  - Replace `window.alert`/`confirm`/`prompt` throughout the portfolio editor/wizard with a
    shared feedback primitive (toast/modal component) — the native browser dialogs work but
    block the main thread, can't be styled, and don't match the rest of the app's UI.
  - `TrimUploader`/`PhotoUploader` uploads have no cancel button and no `beforeunload` guard —
    a musician who navigates away or closes the tab mid-upload loses no data server-side (the
    doc stays in "processing"/gets cleaned up per the failure-path fix), but gets no warning
    that leaving will interrupt it.
  - Accessibility pass across the editor/wizard: `aria-pressed` on the genre/gig-type/link-kind
    toggle buttons (currently conveyed by color only), explicit `<label htmlFor>`/`id` pairings
    or wrapping `<form>` elements instead of bare inputs, and a focus-visible audit.
  - Save actions (`BioGenresForm`, `LinksForm`, `BookingForm`) have no success confirmation —
    only failures alert; a save that succeeds gives no positive feedback beyond the button
    returning to its idle label. Pair with the shared feedback primitive above.
  - Stale `processing` tracks (created via `createTrack` but never uploaded, or abandoned
    mid-upload before the client-side cleanup in `TrimUploader`'s catch block can run — e.g. the
    tab closes mid-upload) still need a server-side reaper, not just the client-side best-effort
    `deleteTrack` cleanup added in Task 11's fix pass. Same bucket as the staging-bucket 24h
    lifecycle rule already tracked above as a launch blocker — both are "abandoned upload
    cleanup" follow-ups and should probably ship together.
  - `deleteProfile` (the "Delete this profile" button) is currently offered only for
    `draft`/`rejected` profiles, matching `submitProfileForReview`'s allowed source statuses —
    a musician cannot self-service-delete an `approved` or `pending_review` profile from the
    editor. This is a conscious ruling (recorded here, not an oversight): a live/under-review
    profile has curator-facing consequences (broken links, an in-flight review) that a bare
    confirm-dialog delete shouldn't short-circuit. Revisit if support requests show this is a
    real gap — likely wants an admin-mediated or cool-down-gated path rather than the same
    one-click confirm used for a never-published draft.

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

- [ ] **Step 2:** Manual E2E against emulators (spec §8): sign up → join wizard → bio/genres/avatar → upload track, pick window → submit blocked until minimums → submit → admin approves profile + track (hears clip) → public `/@handle` renders SSR with playing clip → admin rejects a second track → musician sees reason → delete + re-upload → deleteProfile cascades storage. On mobile: same loop through the portfolio tab + `/artist/<handle>`. Include: click-to-play a real approved track's `TrackPlayer` button on `/@handle` in an actual browser (a headless/curl smoke test can confirm the audio URL and markup but can't verify playback starts/stops correctly).
- [ ] **Step 3:** Process gates (foundation spec §"Process gates"): run the security review of the whole branch (custom opus security-reviewer per foundation ruling 7 if the `security-review` skill still trips on `origin/HEAD`), and an independent audit of **both** `firestore.rules` and `storage.rules`. Apply all fixes before merge.
- [ ] **Step 4:** Merge via superpowers:finishing-a-development-branch.

---

## Self-review notes (already applied)

- Spec coverage checked §1–§8: scope items each map to a task (vanity URLs T10, resubmit UI T10/T14, lint T15, admin queue T12, gate T9, cascade T9, curator-only rates enforced by rules T3 — curator *read* grant itself is sub-3).
- The wizard is deliberately thin (identity step + editor hand-off) rather than a bespoke multi-screen flow: the editor sections are the steps, and the server gate enforces completeness. This satisfies spec §6 "resumable" for free (drafts persist; the editor is re-enterable).
- `updatePortfolio` uses dotted-string field paths (`portfolio.bio`) so the media pipeline's photo-path writes never race client saves of bio/genres/links.
- Foundation's existing `submitProfileForReview` tests will need their musician fixtures adjusted for the new gate (called out in Task 9 Step 4).


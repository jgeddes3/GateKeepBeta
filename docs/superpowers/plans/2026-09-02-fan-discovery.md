# Sub-project 7: Fan Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-ranked swipe deck on mobile (shows, artists, venues, every card with audio), Shows | Artists lists on web and mobile, following of artists, venues, and genres, four follower notifications, and short musician show posts, all on the public data sub-projects 2 through 6 already publish.

**Architecture:** New `follows`, `showPosts`, and `discover` function modules beside the sub-6 event modules. Follows are top-level `follows/{uid}_{targetId}` docs written only by callables; fan-out pages `follows` by `targetId` and writes notifications under create-if-absent dedupe keys. Events gain server-derived `genres`, `priceFromCents`, and `hasFreeTier`. `getDiscoverDeck` assembles and ranks about 20 cards per call from three candidate queries and resolves each card's preview track path server-side; clients build public storage URLs directly. Web ships a signed-in `/discover`, follow buttons, posts, a landing fan section, and an admin posts panel. Mobile ships the deck (FlatList paging, one expo-audio player, expo-location), lists, a Following screen, a venue screen, and the post composer.

**Tech Stack:** Firebase (Firestore, Functions node 20, emulator suite), Next.js 16 (App Router, RSC discipline), Expo SDK 57 + expo-audio + expo-location (new), packages/shared.

**Spec:** `docs/superpowers/specs/2026-09-02-fan-discovery-design.md` (the binding authority; conflicts resolve against it)

## Global Constraints

- **No em dashes anywhere**: code, comments, copy, docs, commit messages. Use commas, colons, periods.
- `DESIGN.md` (repo root) is binding on every surface; antislop + antislop-ui + antislop-copywriting skills bind UI and copy. Icons: Phosphor duotone ONLY via `apps/web/src/ui/icons.tsx` / `apps/mobile/src/ui/icons.tsx`. No lucide, no Inter/Geist/Space Grotesk, no glass on cards, no invented numbers in copy.
- **Zero behavior change to sub-5 money paths and sub-6 ticket money paths.** Every touch to `events.ts`, `tracks.ts`, `notifications.ts` is additive: no existing test changes its assertion.
- Firestore stays default-deny; every shipped client query must be rules-provable with equality pins. Clients never write `follows`, `events`, `events/*/posts`, `profiles`, `users/*/notifications` (beyond the existing `read` flag).
- User-facing status/error strings that clients branch on live in `packages/shared/src/messages.ts` and are compared with `===`.
- The fan's device location is request-scoped: passed to `getDiscoverDeck`, never written to Firestore or local storage.
- The genre picker never appears on the event screen or inside the buy flow.
- Web RSC boundary rule: server files never import VALUES from `"use client"` modules. Verify every new or changed web route with a live page load, not just build.
- Test runs are FOREGROUND, single blocking calls with a 600000ms timeout. Never background `pnpm emu:test`.
- Gates at the end (and per task where named): `pnpm typecheck` 5/5, shared tests (158 + new), `pnpm emu:test` (704 + new, needs Java on PATH + `FUNCTIONS_DISCOVERY_TIMEOUT=60`), `pnpm emu:rules` (103 + new), web lint 0 + `pnpm --filter @gatekeep/web build`, mobile lint 0 new, `pnpm --filter @gatekeep/mobile exec expo export --platform ios --no-bytecode` bundles.
- Run tests from the repo root. `pnpm emu:test` runs everything; there is no single-file emulator script, so run the full suite.

---

## File map (who owns what)

- `packages/shared/src/types.ts`, `messages.ts`, `discover.ts` (new): types, strings, pure helpers (genre targets, event genre derivation, tier projection, haversine, distance label). Task 1.
- `firestore.rules`, `firestore.indexes.json`, `tests-rules/discovery.rules.test.ts` (new). Task 2.
- `functions/src/eventsCore.ts`, `functions/src/events.ts` (event projections), `functions/test/discoverFixtures.ts` (new shared fixtures), `functions/test/eventsDiscovery.test.ts`. Task 3.
- `functions/src/notifications.ts` (dedupeKey), `functions/src/follows.ts` (new: follow callables + `notifyFollowers`), `functions/test/follows.test.ts`. Task 4.
- `functions/src/events.ts` (publish/update hooks), `functions/src/tracks.ts` (new music hook), `functions/test/followsFanout.test.ts`. Task 5.
- `functions/src/showPosts.ts` (new), `functions/test/showPosts.test.ts`. Task 6.
- `functions/src/discoverRank.ts` (new, pure), `functions/src/discover.ts` (new callable), `functions/test/discoverRank.test.ts`, `functions/test/discover.test.ts`. Task 7.
- `functions/src/index.ts`: export new callables as they appear (Tasks 4, 6, 7).
- Web: `apps/web/src/discover/*` (hooks, FollowButton, lists, GenrePicker), `app/discover/*`, shell nav + redirect. Task 8.
- Web: follow buttons and posts on `/u/[handle]` and `/e/[eventId]`, post-purchase prompt, dashboard followers, admin panel, notification links. Task 9.
- Web: landing `FanStorySection` + hero CTA. Task 10.
- Mobile: `apps/mobile/src/discover/*` (follows hook, FollowButton, lists, GenrePicker, storage URL helper), `app/(fan)/following.tsx`, `app/venue/[handle].tsx`, post-purchase prompt, notification deep links. Task 11.
- Mobile: `apps/mobile/src/discover/DeckScreen.tsx` + cards + audio + location, Discover tab wiring, expo-location dep. Task 12.
- Mobile: show posts on the event screen and the artist page's upcoming shows. Task 13.
- `README.md`, `docs/superpowers/HANDOFF.md`, `scripts/seed-test-discovery.ts`. Task 14.

---

### Task 1: Shared foundations (types, messages, pure discovery helpers)

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/discover.ts`
- Test: `packages/shared/test/discover.test.ts`

**Interfaces (Produces, used by every later task):**

```ts
// types.ts additions. Place the follow/post/deck block after the SP6 section.
export type FollowTargetType = "musician" | "curator" | "genre";
export interface FollowDoc {
  uid: string;
  targetId: string;                 // profileId, or "genre:<name>" (name from GENRES)
  targetType: FollowTargetType;
  createdAt: number;
}
export const MAX_FOLLOWS_PER_USER = 500;

export type ShowPostStatus = "live" | "removed";
export interface ShowPostDoc {
  eventId: string;
  musicianProfileId: string;
  authorUid: string;
  text: string;                     // 1..SHOW_POST_MAX_CHARS after trim
  createdAt: number;
  status: ShowPostStatus;
  removedBy?: "author" | "admin";
  removedAt?: number;
}
export const SHOW_POST_MAX_CHARS = 280;
export const SHOW_POST_MAX_PER_EVENT = 3;
export const SHOW_POST_MIN_INTERVAL_MS = 10 * 60 * 1000;

export const DECK_PAGE_SIZE = 20;
export const DECK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DECK_MAX_EXCLUDE_IDS = 200;
export type DeckPreview = { trackPath: string; startSec: number; durationSec: number; artistName: string } | null;
export type DeckNextShow = { eventId: string; title: string; venueName: string; startsAt: number } | null;
export type DeckCard =
  | { kind: "show"; id: string; eventId: string; title: string; startsAt: number; endsAt: number;
      venueName: string; neighborhood: string | null; distanceMeters: number | null; posterPath: string | null;
      lineupNames: string[]; curatorProfileId: string; curatorHandle: string | null;
      priceFromCents: number | null; hasFreeTier: boolean;
      latestPost: { text: string; artistName: string } | null; genres: string[]; preview: DeckPreview }
  | { kind: "artist"; id: string; profileId: string; handle: string; name: string; subtype: MusicianSubtype;
      genres: string[]; coverPhotoPath: string | null; avatarPhotoPath: string | null;
      nextShow: DeckNextShow; preview: DeckPreview }
  | { kind: "venue"; id: string; profileId: string; handle: string; name: string; neighborhood: string | null;
      distanceMeters: number | null; photoPath: string | null; genres: string[];
      nextShow: DeckNextShow; preview: DeckPreview };
export interface GetDiscoverDeckInput {
  location?: { lat: number; lng: number };
  excludeIds?: string[];
  seed?: number;
}
export interface GetDiscoverDeckResult { cards: DeckCard[]; seed: number; }
```

Also in `types.ts`, edit in place:
- `NotificationDoc.kind`: append `| "show_announced" | "new_music" | "show_rescheduled" | "show_post"` and extend the `refId` comment: "SP7: eventId for show_announced / show_rescheduled / show_post; the artist's profileId for new_music."
- `EventDoc`: add (after `lineupMusicianProfileIds`):
  ```ts
  // SP7: server-derived discovery projections. Absent on pre-SP7 docs: readers
  // treat absence as [] / null / false. genres = curatorGenres when set, else
  // the union of lineup booking acts' portfolio.genres (max 5).
  genres?: string[];
  curatorGenres?: string[];
  priceFromCents?: number | null;
  hasFreeTier?: boolean;
  ```
- `ProfileDoc`: add `followerCount?: number; // SP7, server-maintained by followTarget/unfollowTarget; absent means 0`
- `UserDoc`: add `genrePickerSeenAt?: number; // SP7, stamped by markGenrePickerSeen`

```ts
// messages.ts additions (exact strings; clients === on these)
export const FOLLOW_LIMIT_MESSAGE = "You are following the maximum number of artists, venues, and genres.";
export const SHOW_POST_LIMIT_MESSAGE = "You have already posted three times about this show.";
export const SHOW_POST_RATE_MESSAGE = "Give it ten minutes before posting again.";
export const SHOW_POST_EVENT_CLOSED_MESSAGE = "This show has ended, so posts are closed.";
```

```ts
// packages/shared/src/discover.ts (new, pure, no Firebase imports)
import { GENRES } from "./types.js";

export const GENRE_TARGET_PREFIX = "genre:";
export function genreTargetId(genre: string): string { return `${GENRE_TARGET_PREFIX}${genre}`; }
/** Returns the genre name when targetId is a well-formed genre target, else null. */
export function parseGenreTarget(targetId: string): string | null {
  if (!targetId.startsWith(GENRE_TARGET_PREFIX)) return null;
  const g = targetId.slice(GENRE_TARGET_PREFIX.length);
  return (GENRES as readonly string[]).includes(g) ? g : null;
}

export const MAX_EVENT_GENRES = 5;
/** Curator-set genres win; otherwise the union of the lineup's genres, first seen first, capped. */
export function deriveEventGenres(actGenres: string[][], curatorGenres: string[] | null | undefined): string[] {
  if (curatorGenres && curatorGenres.length > 0) return curatorGenres.slice(0, MAX_EVENT_GENRES);
  const out: string[] = [];
  for (const list of actGenres) for (const g of list) {
    if (!out.includes(g)) out.push(g);
    if (out.length >= MAX_EVENT_GENRES) return out;
  }
  return out;
}

/** Cheapest tier price and whether any tier is free. Empty input means "no tiers yet". */
export function tierProjection(tiers: Array<{ priceCents: number }>): { priceFromCents: number | null; hasFreeTier: boolean } {
  if (tiers.length === 0) return { priceFromCents: null, hasFreeTier: false };
  let min = Infinity; let free = false;
  for (const t of tiers) { if (t.priceCents < min) min = t.priceCents; if (t.priceCents === 0) free = true; }
  return { priceFromCents: min, hasFreeTier: free };
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6_371_000;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** "about 0.3 mi" / "about 1.2 mi" / "about 12 mi". Under 0.1 mi reads "nearby". */
export function distanceLabel(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return "nearby";
  if (miles < 10) return `about ${miles.toFixed(1)} mi`;
  return `about ${Math.round(miles)} mi`;
}
```

Add `export * from "./discover.js";` to `packages/shared/src/index.ts`.

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/discover.test.ts` (vitest, same imports style as `validation.test.ts`):

```ts
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
```

- [ ] **Step 2: Run to verify failure**: `pnpm --filter @gatekeep/shared test` fails on missing exports.
- [ ] **Step 3: Implement** the additions above exactly.
- [ ] **Step 4: Run** `pnpm --filter @gatekeep/shared test` (158 + 11 pass) and `pnpm typecheck` (5/5; `NotificationDoc.kind` widening must not break any switch in functions or apps, it is a union extension only).
- [ ] **Step 5: Commit**: `feat(shared): sub-7 follow, post, deck types and discovery helpers`

---

### Task 2: Firestore rules and indexes for follows and posts

**Files:**
- Modify: `firestore.rules` (new section after the SP6 `transfers` block), `firestore.indexes.json`
- Test: `tests-rules/discovery.rules.test.ts` (new; harness copied from `events.rules.test.ts` lines 1-43)

**Rules to add** (inside the top-level `match /databases/{database}/documents`):

```
    // ---------- Sub-project 7: fan discovery ----------
    // follows/{uid}_{targetId}: owner-read only (get + list pinned on uid),
    // callable-only writes (followTarget/unfollowTarget). The doc's own
    // uid field is the truth for list queries; the id is a convenience.
    match /follows/{followId} {
      allow read: if signedIn() && resource.data.uid == request.auth.uid;
      allow write: if false; // Cloud Functions only
    }

    // events/{eventId}/posts/{postId}: a musician's show note. Public when
    // the parent event is public AND the post is live; the event's curator
    // members, the author profile's members, and admin see all (removed
    // posts stay for moderation history). Callable-only writes.
    match /events/{eventId}/posts/{postId} {
      allow read: if isAdmin()
        || (resource.data.status == 'live'
            && get(/databases/$(database)/documents/events/$(eventId)).data.status in ['published', 'completed'])
        || isMember(get(/databases/$(database)/documents/events/$(eventId)).data.curatorProfileId)
        || isMember(resource.data.musicianProfileId);
      allow write: if false; // Cloud Functions only
    }
```

Note: `isMember()` short-circuits on `signedIn()`, so the anonymous public read path pays only the one event `get()`.

**Indexes to append** to `firestore.indexes.json` `indexes` array (same JSON shape as the existing entries):

```json
  { "collectionGroup": "events", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "genres", "arrayConfig": "CONTAINS" },
      { "fieldPath": "startsAt", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "events", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "hasFreeTier", "order": "ASCENDING" },
      { "fieldPath": "startsAt", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "profiles", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "type", "order": "ASCENDING" },
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "name", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "profiles", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "type", "order": "ASCENDING" },
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "portfolio.genres", "arrayConfig": "CONTAINS" },
      { "fieldPath": "name", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "profiles", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "type", "order": "ASCENDING" },
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "updatedAt", "order": "DESCENDING" }
    ] },
  { "collectionGroup": "profiles", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "type", "order": "ASCENDING" },
      { "fieldPath": "subtype", "order": "ASCENDING" },
      { "fieldPath": "status", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "follows", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "uid", "order": "ASCENDING" },
      { "fieldPath": "targetType", "order": "ASCENDING" },
      { "fieldPath": "createdAt", "order": "DESCENDING" }
    ] },
  { "collectionGroup": "posts", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "createdAt", "order": "DESCENDING" }
    ] }
```

- [ ] **Step 1: Write the failing rules tests** in `tests-rules/discovery.rules.test.ts`. Harness: copy lines 1-43 of `events.rules.test.ts` verbatim (imports, `env`, `seed`), then:

```ts
const seedFollow = (uid: string, targetId: string, targetType = "musician") =>
  seed(`follows/${uid}_${targetId}`, { uid, targetId, targetType, createdAt: 1 });
const seedEvent = (id: string, status = "published", curatorProfileId = "prof1") =>
  seed(`events/${id}`, { curatorProfileId, title: "T", description: "", status, startsAt: 1, endsAt: 2,
    location: { venueName: "V", neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
    posterPath: null, maxTicketsPerBuyer: 8, lineup: [], lineupMusicianProfileIds: [], gigId: null, createdAt: 1, updatedAt: 1 });
const seedPost = (eventId: string, postId: string, status = "live", musicianProfileId = "mus1") =>
  seed(`events/${eventId}/posts/${postId}`, { eventId, musicianProfileId, authorUid: "musowner", text: "See you there", createdAt: 1, status });

describe("follows", () => {
  it("owner can get and list their own follows; others cannot", async () => {
    await seedFollow("bob", "mus1");
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(bob, "follows/bob_mus1")));
    await assertSucceeds(getDocs(query(collection(bob, "follows"), where("uid", "==", "bob"))));
    const carol = env.authenticatedContext("carol").firestore();
    await assertFails(getDoc(doc(carol, "follows/bob_mus1")));
    await assertFails(getDocs(query(collection(carol, "follows"), where("uid", "==", "bob"))));
    await assertFails(getDocs(query(collection(carol, "follows"), where("targetId", "==", "mus1"))));
  });
  it("nobody writes follows from a client, not even admin", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(setDoc(doc(bob, "follows/bob_mus2"), { uid: "bob", targetId: "mus2", targetType: "musician", createdAt: 1 }));
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(root, "follows/bob_mus2"), { uid: "bob", targetId: "mus2", targetType: "musician", createdAt: 1 }));
  });
});

describe("show posts", () => {
  beforeEach(async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/mus1/members/musowner", { uid: "musowner", role: "admin" });
  });
  it("anyone reads a live post on a published event, including anonymous", async () => {
    await seedEvent("ev1"); await seedPost("ev1", "p1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev1/posts/p1")));
    await assertSucceeds(getDocs(query(collection(anon, "events/ev1/posts"), where("status", "==", "live"))));
  });
  it("a removed post is hidden from the public but visible to the author profile, curator members, and admin", async () => {
    await seedEvent("ev1"); await seedPost("ev1", "p1", "removed");
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("root", { admin: true }).firestore(), "events/ev1/posts/p1")));
  });
  it("a live post on a draft event is not public", async () => {
    await seedEvent("ev2", "draft"); await seedPost("ev2", "p1");
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "events/ev2/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "events/ev2/posts/p1")));
  });
  it("no client writes posts", async () => {
    await seedEvent("ev1");
    await assertFails(setDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p9"),
      { eventId: "ev1", musicianProfileId: "mus1", authorUid: "musowner", text: "hi", createdAt: 1, status: "live" }));
    await seedPost("ev1", "p1");
    await assertFails(updateDoc(doc(env.authenticatedContext("root", { admin: true }).firestore(), "events/ev1/posts/p1"), { status: "removed" }));
    await assertFails(deleteDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p1")));
  });
});

describe("discovery list queries stay provable", () => {
  it("published events by genre and by free flag list anonymously", async () => {
    await seedEvent("ev1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDocs(query(collection(anon, "events"), where("status", "==", "published"), where("genres", "array-contains", "jazz"))));
    await assertSucceeds(getDocs(query(collection(anon, "events"), where("status", "==", "published"), where("hasFreeTier", "==", true))));
    await assertFails(getDocs(query(collection(anon, "events"), where("genres", "array-contains", "jazz"))));
  });
  it("approved musicians by genre list anonymously; unpinned profile lists fail", async () => {
    await seed("profiles/mus1", { type: "musician", subtype: "solo", name: "A", handle: "a", status: "approved", portfolio: { genres: ["jazz"] } });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDocs(query(collection(anon, "profiles"), where("type", "==", "musician"), where("status", "==", "approved"), where("portfolio.genres", "array-contains", "jazz"))));
    await assertFails(getDocs(query(collection(anon, "profiles"), where("type", "==", "musician"))));
  });
});
```

- [ ] **Step 2: Run** `pnpm emu:rules` (Java on PATH) and confirm the new file fails on the missing rules.
- [ ] **Step 3: Add the rules and indexes** exactly as above.
- [ ] **Step 4: Run** `pnpm emu:rules`: 103 + 8 pass, none of the existing 103 change.
- [ ] **Step 5: Commit**: `feat(rules): follows and show posts collections, discovery indexes`

---

### Task 3: Event discovery projections (genres, price, free flag)

**Files:**
- Modify: `functions/src/eventsCore.ts` (add `validateCuratorGenres`), `functions/src/events.ts` (`CreateEventInput`/`UpdateEventInput` gain `curatorGenres?: string[]`; `createEvent`, `updateEvent`, `setEventTiers` write projections)
- Create: `functions/test/discoverFixtures.ts` (shared fixtures for Tasks 3 to 7), `functions/test/eventsDiscovery.test.ts`

**Interfaces:**
- Consumes: `deriveEventGenres`, `tierProjection` (Task 1).
- Produces: `computeEventGenres(db, lineup, curatorGenres)` exported from `events.ts` (Task 7 does not need it, but Task 5 reads `event.genres`); events now carry `genres`, `curatorGenres`, `priceFromCents`, `hasFreeTier`.

`eventsCore.ts` addition:

```ts
import { GENRES } from "@gatekeep/shared";
// Untrusted onCall payload: optional, 1..3 distinct known genres when present.
export function validateCuratorGenres(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) {
    throw new HttpsError("invalid-argument", "Pick 1-3 genres.");
  }
  const seen = new Set<string>();
  for (const g of input) {
    if (typeof g !== "string" || !(GENRES as readonly string[]).includes(g) || seen.has(g)) {
      throw new HttpsError("invalid-argument", "Unknown or repeated genre.");
    }
    seen.add(g);
  }
  return [...seen];
}
```

`events.ts` additions:

```ts
import { deriveEventGenres, tierProjection, type ProfileDoc } from "@gatekeep/shared";
import { validateCuratorGenres } from "./eventsCore.js";

// Reads each booking act's profile once and derives the event's genres.
export async function computeEventGenres(
  db: Firestore, lineup: EventAct[], curatorGenres: string[] | undefined,
): Promise<string[]> {
  if (curatorGenres && curatorGenres.length > 0) return deriveEventGenres([], curatorGenres);
  const ids = [...new Set(lineup.filter((a): a is Extract<EventAct, { kind: "booking" }> => a.kind === "booking")
    .map((a) => a.musicianProfileId))];
  const snaps = await Promise.all(ids.map((id) => db.doc(`profiles/${id}`).get()));
  const actGenres = snaps.map((s) => ((s.data() as ProfileDoc | undefined)?.portfolio?.genres ?? []));
  return deriveEventGenres(actGenres, null);
}
```

- In `CreateEventInput` and `UpdateEventInput` add `curatorGenres?: string[];`.
- In `createEvent`: after `validateSourceInput(input.source);` add `const curatorGenres = validateCuratorGenres(input.curatorGenres);`. After `verifyLineupBookingActs(...)` add `const genres = await computeEventGenres(db, input.lineup, curatorGenres);`. In the `event` literal add `genres, curatorGenres: curatorGenres ?? [], priceFromCents: null, hasFreeTier: false,`.
- In `updateEvent`: same validation line after `validateLineupIdentity`; after `verifyLineupBookingActs` compute `genres`; in the `eventRef.update({...})` add `genres, curatorGenres: curatorGenres ?? [],`.
- In `setEventTiers`, replace `tx.update(eventRef, { updatedAt: Date.now() });` with:
  ```ts
  const projection = tierProjection(input.tiers.map((t) => ({ priceCents: t.priceCents })));
  tx.update(eventRef, { updatedAt: Date.now(), ...projection });
  ```
  (`input.tiers` is the full post-upsert tier set by construction: omitted tiers are deleted for drafts and refused for published events, so the payload equals the final set.)

**Fixtures** `functions/test/discoverFixtures.ts`: copy `makeApprovedCuratorProfile`, `makeApprovedMusicianProfile`, `gigContent`, `makeFilledGig`, `eventContent`, `makeDraftEvent`, `addTiers` from `functions/test/events.test.ts` lines 18-113 verbatim, exported, with the same `adb`/`stub` module setup (lines 10-13). Add:

```ts
export async function addTiersAndPublish(profileId: string, eventId: string, user: User, tiers: Record<string, unknown>[]) {
  await addTiers(profileId, eventId, user, tiers);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, user);
}
export async function tierIdByName(eventId: string, name: string): Promise<string> {
  const snap = await adb.collection(`events/${eventId}/tiers`).where("name", "==", name).get();
  if (snap.docs.length !== 1) throw new Error(`expected one tier named ${name}`);
  return snap.docs[0].id;
}
export async function makeFan(prefix: string) { return signUpTestUser(`${prefix}-${Date.now()}@test.com`); }
export async function buyFreeTicket(eventId: string, tierId: string, user: User): Promise<string> {
  const { orderId } = await callFn<Record<string, unknown>, { orderId: string; clientSecret: string | null }>(
    "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, user);
  return orderId;
}
/** A published event whose lineup is a REAL booking act (so lineupMusicianProfileIds is non-empty). */
export async function makePublishedBookingEvent(prefix: string, tiers: Record<string, unknown>[] = [
  { name: "General", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null },
]) {
  const { curator, musician, bookingId } = await makeFilledGig(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
    curatorProfileId: curator.profileId, source: { kind: "standalone" },
    ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
  }, curator.owner.user);
  await addTiersAndPublish(curator.profileId, eventId, curator.owner.user, tiers);
  return { curator, musician, eventId };
}
```

- [ ] **Step 1: Write the failing tests** `functions/test/eventsDiscovery.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeDraftEvent, makeFilledGig, eventContent, addTiers, makePublishedBookingEvent } from "./discoverFixtures";
import type { EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

describe("event discovery projections", () => {
  it("derives genres from a booking act's portfolio and starts with no price projection", async () => {
    const { eventId } = await makePublishedBookingEvent("pg1", [
      { name: "GA", priceCents: 1500, capacity: 10, saleStartsAt: null, saleEndsAt: null },
      { name: "Free", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null },
    ]);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["rock"]);
    expect(ev.curatorGenres).toEqual([]);
    expect(ev.priceFromCents).toBe(0);
    expect(ev.hasFreeTier).toBe(true);
  });
  it("curator genres override derivation and are validated", async () => {
    const { curator, musician, bookingId } = await makeFilledGig("pg2");
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" }, curatorGenres: ["jazz", "soul"],
      ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
    }, curator.owner.user);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["jazz", "soul"]);
    await expect(callFn("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" }, curatorGenres: ["polka"], ...eventContent(),
    }, curator.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("external-only lineups get empty genres; setEventTiers keeps the projection current", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pg3");
    let ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual([]); expect(ev.priceFromCents).toBeNull(); expect(ev.hasFreeTier).toBe(false);
    await addTiers(profileId, eventId, owner.user, [{ name: "GA", priceCents: 2500, capacity: 5, saleStartsAt: null, saleEndsAt: null }]);
    ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.priceFromCents).toBe(2500); expect(ev.hasFreeTier).toBe(false);
  });
  it("updateEvent recomputes genres when the curator sets them", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pg4");
    await callFn("updateEvent", { curatorProfileId: profileId, eventId, curatorGenres: ["blues"], ...eventContent() }, owner.user);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["blues"]);
  });
});
```

- [ ] **Step 2: Run** `pnpm emu:test` (foreground, 600000ms): the new file fails on undefined fields.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `pnpm emu:test`: 704 + 4 pass, all existing events tests unchanged (they do not assert on the absence of the new fields; if one uses `toEqual` on a whole event doc, extend the expectation with the new fields rather than weakening it).
- [ ] **Step 5: Commit**: `feat(events): genres, price, and free-tier discovery projections`

---

### Task 4: Follow callables and the follower fan-out helper

**Files:**
- Modify: `functions/src/notifications.ts` (`dedupeKey`), `functions/src/index.ts`
- Create: `functions/src/follows.ts`
- Test: `functions/test/follows.test.ts`

**Interfaces (Produces):**

```ts
// notifications.ts: signature change is additive (third param optional)
export async function notifyUser(
  uid: string, note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey?: string,
): Promise<boolean>   // true when a doc was written (and push attempted), false when the key already existed

// follows.ts
export const followTarget = onCall<{ targetId: string; targetType: FollowTargetType }>(...)      // -> { ok: true }
export const unfollowTarget = onCall<{ targetId: string }>(...)                                   // -> { ok: true }
export const markGenrePickerSeen = onCall<Record<string, never>>(...)                             // -> { ok: true }
export function followDocId(uid: string, targetId: string): string                                // `${uid}_${targetId}`
export async function notifyFollowers(
  targetIds: string[], note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey: string, extraUids?: string[],
): Promise<number>   // number of notifications written
```

`notifications.ts` change (keep the push block as is):

```ts
export async function notifyUser(uid: string, note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey?: string): Promise<boolean> {
  const db = getFirestore();
  const full: NotificationDoc = { ...note, read: false, createdAt: Date.now() };
  const col = db.collection(`users/${uid}/notifications`);
  if (dedupeKey) {
    // create() fails with ALREADY_EXISTS (gRPC 6) when a prior fan-out wrote
    // this key: leave that doc untouched (no re-surfacing, no second push).
    try { await col.doc(dedupeKey).create(full); }
    catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }
  } else {
    await col.add(full);
  }
  // ... existing push tokens block unchanged ...
  return true;
}
```

`follows.ts`:

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  isValidDocId, parseGenreTarget, MAX_FOLLOWS_PER_USER, FOLLOW_LIMIT_MESSAGE,
  type FollowDoc, type FollowTargetType, type ProfileDoc, type NotificationDoc,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { notifyUser } from "./notifications.js";

export function followDocId(uid: string, targetId: string): string { return `${uid}_${targetId}`; }

function validateTargetId(targetId: unknown): string {
  if (typeof targetId !== "string") throw new HttpsError("invalid-argument", "A target is required.");
  if (parseGenreTarget(targetId) !== null) return targetId;
  if (!isValidDocId(targetId)) throw new HttpsError("invalid-argument", "A target is required.");
  return targetId;
}

export const followTarget = onCall<{ targetId: string; targetType: FollowTargetType }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const targetId = validateTargetId(req.data?.targetId);
    const targetType = req.data?.targetType;
    if (targetType !== "musician" && targetType !== "curator" && targetType !== "genre") {
      throw new HttpsError("invalid-argument", "Unknown target type.");
    }
    const isGenre = parseGenreTarget(targetId) !== null;
    if (isGenre !== (targetType === "genre")) throw new HttpsError("invalid-argument", "Target and type disagree.");

    const db = getFirestore();
    const followRef = db.doc(`follows/${followDocId(uid, targetId)}`);
    const profileRef = isGenre ? null : db.doc(`profiles/${targetId}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(followRef);
      if (existing.exists) return; // idempotent
      if (profileRef) {
        const p = await tx.get(profileRef);
        const data = p.data() as ProfileDoc | undefined;
        // "not-found" for missing, wrong-type, AND unapproved: never confirm a
        // draft/pending profile's existence to a stranger.
        if (!p.exists || !data || data.type !== targetType || data.status !== "approved") {
          throw new HttpsError("not-found", "That profile is not available.");
        }
      }
      const count = await tx.get(db.collection("follows").where("uid", "==", uid).count());
      if (count.data().count >= MAX_FOLLOWS_PER_USER) throw new HttpsError("failed-precondition", FOLLOW_LIMIT_MESSAGE);
      const follow: FollowDoc = { uid, targetId, targetType, createdAt: Date.now() };
      tx.set(followRef, follow);
      if (profileRef) tx.update(profileRef, { followerCount: FieldValue.increment(1) });
    });
    return { ok: true };
  });

export const unfollowTarget = onCall<{ targetId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const targetId = validateTargetId(req.data?.targetId);
  const db = getFirestore();
  const followRef = db.doc(`follows/${followDocId(uid, targetId)}`);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(followRef);
    if (!existing.exists) return; // idempotent
    const follow = existing.data() as FollowDoc;
    tx.delete(followRef);
    if (follow.targetType !== "genre") {
      const profileRef = db.doc(`profiles/${targetId}`);
      const p = await tx.get(profileRef);
      // Floor at zero: a profile whose counter never existed (pre-SP7) must not go negative.
      if (p.exists) tx.update(profileRef, { followerCount: Math.max(0, ((p.data() as ProfileDoc).followerCount ?? 0) - 1) });
    }
  });
  return { ok: true };
});

export const markGenrePickerSeen = onCall<Record<string, never>>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  await getFirestore().doc(`users/${uid}`).set({ genrePickerSeenAt: Date.now() }, { merge: true });
  return { ok: true };
});

const FANOUT_PAGE = 200;
const FANOUT_BATCH = 50;

// Unions every follower of every target (plus extraUids), then notifies each
// once under dedupeKey. Pages follows by targetId so a popular target never
// loads into memory at once; a crash mid-run leaves some fans unnotified
// rather than double-notified, and a retry is safe by the key.
export async function notifyFollowers(
  targetIds: string[], note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey: string, extraUids: string[] = [],
): Promise<number> {
  const db = getFirestore();
  const uids = new Set<string>(extraUids);
  for (const targetId of [...new Set(targetIds)]) {
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let q = db.collection("follows").where("targetId", "==", targetId).orderBy("__name__").limit(FANOUT_PAGE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      for (const d of snap.docs) uids.add((d.data() as FollowDoc).uid);
      if (snap.docs.length < FANOUT_PAGE) break;
      last = snap.docs[snap.docs.length - 1];
    }
  }
  let written = 0;
  const all = [...uids];
  for (let i = 0; i < all.length; i += FANOUT_BATCH) {
    const results = await Promise.all(all.slice(i, i + FANOUT_BATCH).map((uid) => notifyUser(uid, note, dedupeKey)));
    written += results.filter(Boolean).length;
  }
  return written;
}
```

`index.ts`: `export { followTarget, unfollowTarget, markGenrePickerSeen } from "./follows.js";`

- [ ] **Step 1: Write the failing tests** `functions/test/follows.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile, makeApprovedCuratorProfile, makeFan } from "./discoverFixtures";
import { FOLLOW_LIMIT_MESSAGE, type FollowDoc, type ProfileDoc, type UserDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

describe("followTarget / unfollowTarget", () => {
  it("follows an approved musician, bumps the counter, and is idempotent", async () => {
    const m = await makeApprovedMusicianProfile("fo1m");
    const fan = await makeFan("fo1f");
    await callFn("followTarget", { targetId: m.profileId, targetType: "musician" }, fan.user);
    await callFn("followTarget", { targetId: m.profileId, targetType: "musician" }, fan.user);
    const f = (await adb.doc(`follows/${fan.uid}_${m.profileId}`).get()).data() as FollowDoc;
    expect(f).toMatchObject({ uid: fan.uid, targetId: m.profileId, targetType: "musician" });
    expect(((await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc).followerCount).toBe(1);
    await callFn("unfollowTarget", { targetId: m.profileId }, fan.user);
    await callFn("unfollowTarget", { targetId: m.profileId }, fan.user);
    expect((await adb.doc(`follows/${fan.uid}_${m.profileId}`).get()).exists).toBe(false);
    expect(((await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc).followerCount).toBe(0);
  });
  it("follows a venue and a genre", async () => {
    const v = await makeApprovedCuratorProfile("fo2v", "venue");
    const fan = await makeFan("fo2f");
    await callFn("followTarget", { targetId: v.profileId, targetType: "curator" }, fan.user);
    await callFn("followTarget", { targetId: "genre:jazz", targetType: "genre" }, fan.user);
    expect((await adb.doc(`follows/${fan.uid}_genre:jazz`).get()).exists).toBe(true);
  });
  it("refuses unknown genres, type mismatches, unapproved profiles, and anonymous calls", async () => {
    const fan = await makeFan("fo3f");
    await expect(callFn("followTarget", { targetId: "genre:polka", targetType: "genre" }, fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    const m = await makeApprovedMusicianProfile("fo3m");
    await expect(callFn("followTarget", { targetId: m.profileId, targetType: "curator" }, fan.user)).rejects.toMatchObject({ code: "functions/not-found" });
    const draft = await signUpTestUser(`fo3d-${Date.now()}@test.com`);
    const { profileId } = await callFn<Record<string, unknown>, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Draft", handle: `fo3d_${Date.now()}` }, draft.user);
    await expect(callFn("followTarget", { targetId: profileId, targetType: "musician" }, fan.user)).rejects.toMatchObject({ code: "functions/not-found" });
    await expect(callFn("followTarget", { targetId: m.profileId, targetType: "musician" })).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });
  it("enforces the follow cap with the shared message", async () => {
    const fan = await makeFan("fo4f");
    // Seed 500 follow docs directly (the cap counts docs, not their validity).
    const batch = adb.batch();
    for (let i = 0; i < 500; i++) batch.set(adb.doc(`follows/${fan.uid}_seed${i}`), { uid: fan.uid, targetId: `seed${i}`, targetType: "musician", createdAt: 1 });
    await batch.commit();
    await expect(callFn("followTarget", { targetId: "genre:jazz", targetType: "genre" }, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: FOLLOW_LIMIT_MESSAGE });
  });
  it("markGenrePickerSeen stamps the user doc", async () => {
    const fan = await makeFan("fo5f");
    await callFn("markGenrePickerSeen", {}, fan.user);
    expect(((await adb.doc(`users/${fan.uid}`).get()).data() as UserDoc).genrePickerSeenAt).toBeTypeOf("number");
  });
});

describe("notifyUser dedupeKey", () => {
  it("writes once per key and leaves the first doc untouched", async () => {
    const { notifyUser } = await import("../src/notifications.js");
    const fan = await makeFan("nd1f");
    const first = await notifyUser(fan.uid, { kind: "system", title: "A", body: "one" }, "key:1");
    const second = await notifyUser(fan.uid, { kind: "system", title: "B", body: "two" }, "key:1");
    expect(first).toBe(true); expect(second).toBe(false);
    const doc = (await adb.doc(`users/${fan.uid}/notifications/key:1`).get()).data();
    expect(doc?.title).toBe("A");
  });
});
```

(`functions/test` already imports built `../src/*.js` modules in other files, e.g. `StubGeocoder`; the dynamic import above follows that precedent.)

- [ ] **Step 2: Run** `pnpm emu:test`: new file fails (callables missing).
- [ ] **Step 3: Implement** as above; export from `index.ts`.
- [ ] **Step 4: Run** `pnpm emu:test`: 708 + 6 pass; `notifications.test.ts` unchanged.
- [ ] **Step 5: Commit**: `feat(functions): follow callables, follower fan-out, dedupe keys`

---

### Task 5: Fan-out hooks (show announced, on the bill, reschedule, new music)

**Files:**
- Modify: `functions/src/events.ts` (`publishEvent`, `updateEvent`), `functions/src/tracks.ts` (`reviewTrack` approved branch)
- Create: `functions/src/announce.ts` (note builders shared by both hooks)
- Test: `functions/test/followsFanout.test.ts`

**Interfaces (Produces):**

```ts
// announce.ts
export function announceTargets(event: EventDoc): string[]           // curatorProfileId + lineupMusicianProfileIds + genre targets
export function formatShowDate(ms: number): string                   // "Fri, Sep 12" in LAUNCH_TIMEZONE
export function showAnnouncedNote(eventId: string, event: EventDoc): Omit<NotificationDoc, "read" | "createdAt">
export function onTheBillNote(eventId: string, event: EventDoc): Omit<NotificationDoc, "read" | "createdAt">
export function showRescheduledNote(eventId: string, event: EventDoc, newStartsAt: number): Omit<NotificationDoc, "read" | "createdAt">
export function newMusicNote(profileId: string, artistName: string, trackTitle: string): Omit<NotificationDoc, "read" | "createdAt">
```

```ts
// functions/src/announce.ts
import { genreTargetId, LAUNCH_TIMEZONE, type EventDoc, type NotificationDoc } from "@gatekeep/shared";

type Note = Omit<NotificationDoc, "read" | "createdAt">;

export function formatShowDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
}
function billing(event: EventDoc): string {
  const names = event.lineup.map((a) => a.name.trim()).filter(Boolean);
  return names.length > 0 ? names.slice(0, 3).join(", ") + (names.length > 3 ? " and more" : "") : event.title;
}
function venue(event: EventDoc): string { return event.location.venueName ?? event.location.city; }

export function announceTargets(event: EventDoc): string[] {
  return [event.curatorProfileId, ...event.lineupMusicianProfileIds, ...(event.genres ?? []).map(genreTargetId)];
}
export function showAnnouncedNote(eventId: string, event: EventDoc): Note {
  return { kind: "show_announced", refId: eventId, title: "Show announced",
    body: `${billing(event)} at ${venue(event)}, ${formatShowDate(event.startsAt)}.` };
}
export function onTheBillNote(eventId: string, event: EventDoc): Note {
  return { kind: "show_announced", refId: eventId, title: "You're on the bill",
    body: `${event.title} at ${venue(event)}, ${formatShowDate(event.startsAt)}, is live. Post about it from the event page.` };
}
export function showRescheduledNote(eventId: string, event: EventDoc, newStartsAt: number): Note {
  return { kind: "show_rescheduled", refId: eventId, title: "Show rescheduled",
    body: `${billing(event)} at ${venue(event)} moved to ${formatShowDate(newStartsAt)}.` };
}
export function newMusicNote(profileId: string, artistName: string, trackTitle: string): Note {
  return { kind: "new_music", refId: profileId, title: `New from ${artistName}`, body: `"${trackTitle}" is up. Tap to listen.` };
}
```

`publishEvent` hook: after `await eventRef.update({ status: "published", updatedAt: Date.now() });` add:

```ts
  const published: EventDoc = { ...event, status: "published" };
  await notifyFollowers(announceTargets(published), showAnnouncedNote(input.eventId, published), `announce:${input.eventId}`);
  for (const musicianProfileId of published.lineupMusicianProfileIds) {
    const members = await db.collection(`profiles/${musicianProfileId}/members`).get();
    await Promise.all(members.docs.map((m) => notifyUser(m.id, onTheBillNote(input.eventId, published), `bill:${input.eventId}`)));
  }
```

`updateEvent` hook: after the `eventRef.update({...})` call add:

```ts
  if (event.status === "published") {
    const updated: EventDoc = { ...event, ...{ title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt,
      lineup: input.lineup, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(input.lineup), genres } };
    const added = updated.lineupMusicianProfileIds.filter((id) => !event.lineupMusicianProfileIds.includes(id));
    if (added.length > 0) {
      await notifyFollowers(added, showAnnouncedNote(input.eventId, updated), `announce:${input.eventId}`);
      for (const musicianProfileId of added) {
        const members = await db.collection(`profiles/${musicianProfileId}/members`).get();
        await Promise.all(members.docs.map((m) => notifyUser(m.id, onTheBillNote(input.eventId, updated), `bill:${input.eventId}`)));
      }
    }
    if (input.startsAt !== event.startsAt) {
      const attendees = await db.collection(`events/${input.eventId}/attendees`).where("status", "in", ["valid", "checked_in"]).get();
      const holders = [...new Set(attendees.docs.map((a) => (a.data() as AttendeeDoc).ownerUid))];
      await notifyFollowers(announceTargets(updated), showRescheduledNote(input.eventId, updated, input.startsAt),
        `resched:${input.eventId}:${input.startsAt}`, holders);
      // Re-arm the 24h reminder when the show moved back out of its window.
      if (event.reminderSentAt !== undefined && input.startsAt - Date.now() > EVENT_REMINDER_WINDOW_MS) {
        await eventRef.update({ reminderSentAt: FieldValue.delete() });
      }
    }
  }
```

Import `EVENT_REMINDER_WINDOW_MS` from wherever `scheduled.ts` defines it (grep; if it is module-private, export it from `eventsCore.ts` as `export const EVENT_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;` and make `scheduled.ts` import that). Import `FieldValue` from `firebase-admin/firestore`, `AttendeeDoc` from shared, `notifyFollowers` from `./follows.js`, `notifyUser` from `./notifications.js`.

`reviewTrack` hook: inside `if (decision === "approved") {` after the existing `notifyProfileMembers(...)` call (tracks.ts line 340-344) add:

```ts
      const profileSnap = await db.doc(`profiles/${profileId}`).get();
      const artistName = (profileSnap.data() as ProfileDoc | undefined)?.name ?? "An artist you follow";
      await notifyFollowers([profileId], newMusicNote(profileId, artistName, prior.title ?? "New track"), `track:${trackId}`);
```

- [ ] **Step 1: Write the failing tests** `functions/test/followsFanout.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser } from "./helpers";
import {
  adb, makeFan, makeFilledGig, eventContent, addTiersAndPublish, makePublishedBookingEvent, tierIdByName, buyFreeTicket,
} from "./discoverFixtures";
import type { NotificationDoc, EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const notes = async (uid: string) =>
  (await adb.collection(`users/${uid}/notifications`).get()).docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) }));

describe("show announced fan-out", () => {
  it("notifies venue, artist, and genre followers once, and lineup members once, with dedupe keys", async () => {
    const { curator, musician, bookingId } = await makeFilledGig("fa1");
    const venueFan = await makeFan("fa1v"); const artistFan = await makeFan("fa1a"); const genreFan = await makeFan("fa1g"); const allFan = await makeFan("fa1all");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, venueFan.user);
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, artistFan.user);
    await callFn("followTarget", { targetId: "genre:rock", targetType: "genre" }, genreFan.user);
    for (const t of [[curator.profileId, "curator"], [musician.profileId, "musician"], ["genre:rock", "genre"]] as const) {
      await callFn("followTarget", { targetId: t[0], targetType: t[1] }, allFan.user);
    }
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" },
      ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
    }, curator.owner.user);
    await addTiersAndPublish(curator.profileId, eventId, curator.owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);

    for (const fan of [venueFan, artistFan, genreFan, allFan]) {
      const n = await notes(fan.uid);
      const announced = n.filter((x) => x.kind === "show_announced");
      expect(announced).toHaveLength(1);
      expect(announced[0].id).toBe(`announce:${eventId}`);
      expect(announced[0].refId).toBe(eventId);
      expect(announced[0].title).toBe("Show announced");
    }
    const bill = (await notes(musician.owner.uid)).filter((x) => x.id === `bill:${eventId}`);
    expect(bill).toHaveLength(1); expect(bill[0].title).toBe("You're on the bill");
  });

  it("adding a lineup artist to a published event notifies only the new artist's followers; existing docs are untouched", async () => {
    const { curator, musician, eventId } = await makePublishedBookingEvent("fa2");
    const venueFan = await makeFan("fa2v");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, venueFan.user);
    // Second act with its own follower, added after publish.
    const second = await makeFilledGig("fa2b");
    const secondFan = await makeFan("fa2s");
    await callFn("followTarget", { targetId: second.musician.profileId, targetType: "musician" }, secondFan.user);
    // Move the second act's booking under the FIRST curator is impossible (booking ownership), so
    // use an updated lineup on the second curator's own event instead:
    const { eventId: ev2 } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: second.curator.profileId, source: { kind: "standalone" },
      ...eventContent({ lineup: [{ kind: "external", name: "Opener" }] }),
    }, second.curator.owner.user);
    await addTiersAndPublish(second.curator.profileId, ev2, second.curator.owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    expect((await notes(secondFan.uid)).filter((x) => x.kind === "show_announced")).toHaveLength(0);
    const ev = (await adb.doc(`events/${ev2}`).get()).data() as EventDoc;
    await callFn("updateEvent", { curatorProfileId: second.curator.profileId, eventId: ev2,
      title: ev.title, description: ev.description, startsAt: ev.startsAt, endsAt: ev.endsAt,
      lineup: [{ kind: "external", name: "Opener" }, { kind: "booking", bookingId: second.bookingId, musicianProfileId: second.musician.profileId, name: "Headliner" }],
    }, second.curator.owner.user);
    const after = (await notes(secondFan.uid)).filter((x) => x.kind === "show_announced");
    expect(after).toHaveLength(1); expect(after[0].id).toBe(`announce:${ev2}`);
    // The first event's venue follower got nothing new from the second event.
    expect((await notes(venueFan.uid)).filter((x) => x.id === `announce:${ev2}`)).toHaveLength(0);
    void musician; void eventId;
  });

  it("a reschedule reaches followers and ticket holders and re-arms the reminder", async () => {
    const { curator, eventId } = await makePublishedBookingEvent("fa3");
    const fan = await makeFan("fa3f"); const holder = await makeFan("fa3h");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, fan.user);
    await buyFreeTicket(eventId, await tierIdByName(eventId, "General"), holder.user);
    await adb.doc(`events/${eventId}`).update({ reminderSentAt: Date.now() });
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    const newStart = ev.startsAt + 3 * 24 * 3600 * 1000;
    await callFn("updateEvent", { curatorProfileId: curator.profileId, eventId,
      title: ev.title, description: ev.description, startsAt: newStart, endsAt: newStart + 3 * 3600 * 1000, lineup: ev.lineup,
    }, curator.owner.user);
    for (const u of [fan, holder]) {
      const r = (await notes(u.uid)).filter((x) => x.kind === "show_rescheduled");
      expect(r).toHaveLength(1); expect(r[0].id).toBe(`resched:${eventId}:${newStart}`);
    }
    expect(((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).reminderSentAt).toBeUndefined();
  });
});

describe("new music fan-out", () => {
  it("notifies an artist's followers when a track is approved", async () => {
    const { musician } = await makeFilledGig("nm1");
    const fan = await makeFan("nm1f");
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    await adb.doc(`profiles/${musician.profileId}/tracks/pending1`).set({
      title: "Second Song", status: "pending_review", uploaderUid: musician.owner.uid, startSec: 0, durationSec: 20,
      storagePath: `review/tracks/${musician.profileId}/pending1.m4a`, rejectionReason: null, failureReason: null, order: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    // The review clip must exist in the storage emulator for approve's copy to succeed.
    const { uploadTestAudio, makeWav } = await import("./helpers");
    await uploadTestAudio(`review/tracks/${musician.profileId}/pending1.m4a`, makeWav(1), "audio/mp4", (await makeAdminUser("nm1adm")).user);
    const admin = await makeAdminUser("nm1a");
    await callFn("reviewTrack", { profileId: musician.profileId, trackId: "pending1", decision: "approved" }, admin.user);
    const n = (await notes(fan.uid)).filter((x) => x.kind === "new_music");
    expect(n).toHaveLength(1); expect(n[0].id).toBe("track:pending1"); expect(n[0].refId).toBe(musician.profileId);
  });
});
```

If the storage upload to `review/...` is refused by `storage.rules` for a client (it is admin-read, write `false`), write the object with the Admin SDK bucket instead: `getStorage(adminApp).bucket("gatekeep-dev-jg.firebasestorage.app").file(path).save(Buffer.from(makeWav(1)), { contentType: "audio/mp4" })`. Check how `tracks.test.ts` gets a review clip in place and copy that exactly.

- [ ] **Step 2: Run** `pnpm emu:test`: new file fails.
- [ ] **Step 3: Implement** the hooks and `announce.ts`.
- [ ] **Step 4: Run** `pnpm emu:test`: 714 + 4 pass; every existing `events.test.ts`, `ticketing*.test.ts`, `tracks.test.ts` assertion unchanged.
- [ ] **Step 5: Commit**: `feat(functions): follower fan-out on publish, lineup change, reschedule, new music`

---

### Task 6: Show posts callables

**Files:**
- Create: `functions/src/showPosts.ts`
- Modify: `functions/src/index.ts`, `packages/shared/src/types.ts` (`AuditLogDoc.action` gains `| "show_post_removed"`)
- Test: `functions/test/showPosts.test.ts`

**Interfaces (Produces):**

```ts
export const createShowPost = onCall<{ eventId: string; musicianProfileId: string; text: string }>(...)  // -> { postId: string }
export const removeShowPost = onCall<{ eventId: string; postId: string }>(...)                            // -> { ok: true }
```

```ts
// functions/src/showPosts.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, SHOW_POST_MAX_CHARS, SHOW_POST_MAX_PER_EVENT, SHOW_POST_MIN_INTERVAL_MS,
  SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE,
  type EventDoc, type ShowPostDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireProfileMember } from "./guards.js";
import { notifyFollowers } from "./follows.js";
import { writeAudit } from "./review.js";

function isAdminReq(req: { auth?: { token?: Record<string, unknown> } }): boolean {
  return req.auth?.token?.admin === true;
}

export const createShowPost = onCall<{ eventId: string; musicianProfileId: string; text: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(musicianProfileId)) throw new HttpsError("invalid-argument", "An event and a profile are required.");
    const text = typeof req.data?.text === "string" ? req.data.text.trim() : "";
    if (text.length < 1 || text.length > SHOW_POST_MAX_CHARS) {
      throw new HttpsError("invalid-argument", `Posts are 1-${SHOW_POST_MAX_CHARS} characters.`);
    }
    await requireProfileMember(musicianProfileId, uid);

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const postsRef = eventRef.collection("posts");
    const now = Date.now();
    const postId = await db.runTransaction(async (tx) => {
      const ev = await tx.get(eventRef);
      if (!ev.exists) throw new HttpsError("not-found", "Event not found.");
      const event = ev.data() as EventDoc;
      if (event.status !== "published" || event.endsAt <= now) {
        throw new HttpsError("failed-precondition", SHOW_POST_EVENT_CLOSED_MESSAGE);
      }
      if (!event.lineupMusicianProfileIds.includes(musicianProfileId)) {
        throw new HttpsError("permission-denied", "This profile is not on the lineup.");
      }
      const mine = await tx.get(postsRef.where("musicianProfileId", "==", musicianProfileId).where("status", "==", "live"));
      if (mine.size >= SHOW_POST_MAX_PER_EVENT) throw new HttpsError("failed-precondition", SHOW_POST_LIMIT_MESSAGE);
      const latest = mine.docs.reduce((max, d) => Math.max(max, (d.data() as ShowPostDoc).createdAt), 0);
      if (now - latest < SHOW_POST_MIN_INTERVAL_MS) throw new HttpsError("failed-precondition", SHOW_POST_RATE_MESSAGE);
      const ref = postsRef.doc();
      const post: ShowPostDoc = { eventId, musicianProfileId, authorUid: uid, text, createdAt: now, status: "live" };
      tx.set(ref, post);
      return ref.id;
    });

    const profile = (await db.doc(`profiles/${musicianProfileId}`).get()).data() as ProfileDoc | undefined;
    const event = (await eventRef.get()).data() as EventDoc;
    await notifyFollowers([musicianProfileId], {
      kind: "show_post", refId: eventId,
      title: `${profile?.name ?? "An artist you follow"} on ${event.title}`,
      body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    }, `post:${postId}`);
    return { postId };
  });

export const removeShowPost = onCall<{ eventId: string; postId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const { eventId, postId } = req.data ?? {};
  if (!isValidDocId(eventId) || !isValidDocId(postId)) throw new HttpsError("invalid-argument", "An event and a post are required.");
  const db = getFirestore();
  const ref = db.doc(`events/${eventId}/posts/${postId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Post not found.");
  const post = snap.data() as ShowPostDoc;
  const admin = isAdminReq(req);
  if (!admin) await requireProfileMember(post.musicianProfileId, uid);
  if (post.status === "removed") return { ok: true }; // idempotent
  await ref.update({ status: "removed", removedBy: admin ? "admin" : "author", removedAt: Date.now() });
  if (admin) {
    await writeAudit({ actorUid: uid, action: "show_post_removed", targetId: `${eventId}/${postId}`, detail: post.text.slice(0, 200) });
  }
  return { ok: true };
});
```

Note: a member who is also admin removes as admin (audit trail). `requireProfileMember` throws `permission-denied` for non-members, which is the right answer for a stranger.

`index.ts`: `export { createShowPost, removeShowPost } from "./showPosts.js";`

- [ ] **Step 1: Write the failing tests** `functions/test/showPosts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser } from "./helpers";
import { adb, makeFan, makePublishedBookingEvent } from "./discoverFixtures";
import {
  SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE, type ShowPostDoc, type NotificationDoc,
} from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

describe("createShowPost", () => {
  it("a lineup member posts; followers get one show_post notification", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp1");
    const fan = await makeFan("sp1f");
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    const { postId } = await callFn<Record<string, unknown>, { postId: string }>("createShowPost",
      { eventId, musicianProfileId: musician.profileId, text: "  Doors at 8, we go on at 9.  " }, musician.owner.user);
    const post = (await adb.doc(`events/${eventId}/posts/${postId}`).get()).data() as ShowPostDoc;
    expect(post).toMatchObject({ eventId, musicianProfileId: musician.profileId, authorUid: musician.owner.uid, status: "live", text: "Doors at 8, we go on at 9." });
    const n = (await adb.collection(`users/${fan.uid}/notifications`).get()).docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) }));
    const posts = n.filter((x) => x.kind === "show_post");
    expect(posts).toHaveLength(1); expect(posts[0].id).toBe(`post:${postId}`); expect(posts[0].refId).toBe(eventId);
  });
  it("refuses non-members, non-lineup profiles, empty and overlong text", async () => {
    const { curator, musician, eventId } = await makePublishedBookingEvent("sp2");
    const stranger = await makeFan("sp2s");
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "hi" }, stranger.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: curator.profileId, text: "hi" }, curator.owner.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "   " }, musician.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "x".repeat(281) }, musician.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("rate-limits, caps at three live posts, and closes after the show ends", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp3");
    const post = (text: string) => callFn<Record<string, unknown>, { postId: string }>("createShowPost", { eventId, musicianProfileId: musician.profileId, text }, musician.owner.user);
    const first = await post("one");
    await expect(post("two")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_RATE_MESSAGE });
    // Age the first post past the interval, then fill the cap.
    await adb.doc(`events/${eventId}/posts/${first.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    const second = await post("two");
    await adb.doc(`events/${eventId}/posts/${second.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    await post("three");
    await adb.collection(`events/${eventId}/posts`).get().then((s) => Promise.all(s.docs.map((d) => d.ref.update({ createdAt: Date.now() - 11 * 60 * 1000 }))));
    await expect(post("four")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_LIMIT_MESSAGE });
    // Removing one live post frees a slot.
    await callFn("removeShowPost", { eventId, postId: first.postId }, musician.owner.user);
    await post("four");
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - 1000 });
    await expect(post("five")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_EVENT_CLOSED_MESSAGE });
  });
});

describe("removeShowPost", () => {
  it("author removes as author; admin removes as admin with an audit row; strangers cannot", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp4");
    const mk = () => callFn<Record<string, unknown>, { postId: string }>("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "hello" }, musician.owner.user);
    const a = await mk();
    await adb.doc(`events/${eventId}/posts/${a.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    const b = await mk();
    const stranger = await makeFan("sp4s");
    await expect(callFn("removeShowPost", { eventId, postId: a.postId }, stranger.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("removeShowPost", { eventId, postId: a.postId }, musician.owner.user);
    expect((await adb.doc(`events/${eventId}/posts/${a.postId}`).get()).data()).toMatchObject({ status: "removed", removedBy: "author" });
    const admin = await makeAdminUser("sp4a");
    await callFn("removeShowPost", { eventId, postId: b.postId }, admin.user);
    expect((await adb.doc(`events/${eventId}/posts/${b.postId}`).get()).data()).toMatchObject({ status: "removed", removedBy: "admin" });
    const audit = await adb.collection("auditLogs").where("action", "==", "show_post_removed").where("targetId", "==", `${eventId}/${b.postId}`).get();
    expect(audit.size).toBe(1);
    await callFn("removeShowPost", { eventId, postId: b.postId }, admin.user); // idempotent
  });
});
```

- [ ] **Step 2: Run** `pnpm emu:test`: fails on missing callables.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm emu:test`: 718 + 4 pass.
- [ ] **Step 5: Commit**: `feat(functions): show posts with caps, rate limit, author and admin removal`

---

### Task 7: The deck (pure ranking + `getDiscoverDeck`)

**Files:**
- Create: `functions/src/discoverRank.ts` (pure), `functions/src/discover.ts` (callable)
- Modify: `functions/src/index.ts`
- Test: `functions/test/discoverRank.test.ts` (pure, no emulator state), `functions/test/discover.test.ts`

**Interfaces (Produces):**

```ts
// discoverRank.ts
export type DeckCandidate = {
  id: string; kind: "show" | "artist" | "venue"; genres: string[];
  startsAt: number | null; distanceMeters: number | null; followedBoost: boolean;
};
export function mulberry32(seed: number): () => number;
export function scoreCandidate(c: DeckCandidate, ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; rand: () => number }): number;
export function rankDeck(candidates: DeckCandidate[], ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; seed: number }, pageSize: number): DeckCandidate[];
export function interleaveByKind<T extends { kind: string }>(sorted: T[], maxRun?: number): T[];
// discover.ts
export const getDiscoverDeck = onCall<GetDiscoverDeckInput>(...)  // -> GetDiscoverDeckResult
```

```ts
// functions/src/discoverRank.ts
import { DECK_WINDOW_MS } from "@gatekeep/shared";

export type DeckCandidate = {
  id: string; kind: "show" | "artist" | "venue"; genres: string[];
  startsAt: number | null; distanceMeters: number | null; followedBoost: boolean;
};

// Small seeded PRNG so a given seed reproduces a deck order (tests, and paging
// under one seed across calls).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const DISTANCE_FULL_METERS = 20_000;

export function scoreCandidate(
  c: DeckCandidate, ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; rand: () => number },
): number {
  const overlap = c.genres.filter((g) => ctx.followedGenres.has(g)).length;
  const genre = c.genres.length > 0 ? 3 * (overlap / c.genres.length) : 0;
  const boost = c.followedBoost ? 2 : 0;
  const soon = c.startsAt === null ? 0.5 : 2 * (1 - clamp01((c.startsAt - ctx.now) / DECK_WINDOW_MS));
  const dist = ctx.hasLocation && c.distanceMeters !== null ? 1.5 * (1 - clamp01(c.distanceMeters / DISTANCE_FULL_METERS)) : 0;
  return genre + boost + soon + dist + ctx.rand();
}

// Stable sort by score desc, then interleave so no kind runs more than maxRun.
export function rankDeck(
  candidates: DeckCandidate[], ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; seed: number }, pageSize: number,
): DeckCandidate[] {
  const rand = mulberry32(ctx.seed);
  // Score in id order so the PRNG draw per candidate is deterministic regardless of input order.
  const scored = [...candidates].sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({ c, s: scoreCandidate(c, { ...ctx, rand }) }))
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .map((x) => x.c);
  return interleaveByKind(scored).slice(0, pageSize);
}

export function interleaveByKind<T extends { kind: string }>(sorted: T[], maxRun = 2): T[] {
  const out: T[] = []; const pool = [...sorted];
  while (pool.length > 0) {
    const run = out.length >= maxRun && out.slice(-maxRun).every((x) => x.kind === out[out.length - 1].kind)
      ? out[out.length - 1].kind : null;
    let idx = 0;
    if (run !== null) { const alt = pool.findIndex((x) => x.kind !== run); idx = alt === -1 ? 0 : alt; }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
```

```ts
// functions/src/discover.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  DECK_PAGE_SIZE, DECK_WINDOW_MS, DECK_MAX_EXCLUDE_IDS, haversineMeters, parseGenreTarget,
  type DeckCard, type DeckPreview, type DeckNextShow, type EventDoc, type ProfileDoc, type FollowDoc, type TrackDoc,
  type ShowPostDoc, type GetDiscoverDeckInput, type GetDiscoverDeckResult, type MusicianSubtype,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { rankDeck, type DeckCandidate } from "./discoverRank.js";

const EVENT_LIMIT = 100; const ARTIST_LIMIT = 150; const VENUE_LIMIT = 100;
type Geo = { lat: number; lng: number };

function validateInput(data: unknown): { location: Geo | null; excludeIds: Set<string>; seed: number } {
  const d = (data ?? {}) as GetDiscoverDeckInput;
  let location: Geo | null = null;
  if (d.location !== undefined) {
    const { lat, lng } = d.location as Geo;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpsError("invalid-argument", "Invalid location.");
    }
    location = { lat, lng };
  }
  const excludeIds = new Set<string>();
  if (d.excludeIds !== undefined) {
    if (!Array.isArray(d.excludeIds) || d.excludeIds.length > DECK_MAX_EXCLUDE_IDS
        || d.excludeIds.some((x) => typeof x !== "string" || x.length > 80)) {
      throw new HttpsError("invalid-argument", "Invalid exclude list.");
    }
    for (const x of d.excludeIds) excludeIds.add(x);
  }
  const seed = typeof d.seed === "number" && Number.isInteger(d.seed) && d.seed >= 0
    ? d.seed : Math.floor(Math.random() * 2 ** 31);
  return { location, excludeIds, seed };
}

async function firstApprovedTrack(db: Firestore, profileId: string): Promise<{ track: TrackDoc } | null> {
  const snap = await db.collection(`profiles/${profileId}/tracks`).where("status", "==", "approved").orderBy("order").limit(1).get();
  if (snap.empty) return null;
  return { track: snap.docs[0].data() as TrackDoc };
}
async function previewFor(db: Firestore, profileIds: string[], nameOf: (id: string) => string): Promise<DeckPreview> {
  for (const id of profileIds) {
    const hit = await firstApprovedTrack(db, id);
    if (hit && hit.track.storagePath) {
      return { trackPath: hit.track.storagePath, startSec: hit.track.startSec, durationSec: hit.track.durationSec ?? 0, artistName: nameOf(id) };
    }
  }
  return null;
}

export const getDiscoverDeck = onCall<GetDiscoverDeckInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const { location, excludeIds, seed } = validateInput(req.data);
  const db = getFirestore();
  const now = Date.now();

  const followsSnap = await db.collection("follows").where("uid", "==", uid).limit(500).get();
  const followedProfiles = new Set<string>(); const followedGenres = new Set<string>();
  for (const d of followsSnap.docs) {
    const f = d.data() as FollowDoc;
    const g = parseGenreTarget(f.targetId);
    if (g) followedGenres.add(g); else followedProfiles.add(f.targetId);
  }

  const [eventsSnap, artistsSnap, venuesSnap] = await Promise.all([
    db.collection("events").where("status", "==", "published").where("startsAt", ">=", now)
      .where("startsAt", "<=", now + DECK_WINDOW_MS).orderBy("startsAt").limit(EVENT_LIMIT).get(),
    db.collection("profiles").where("type", "==", "musician").where("status", "==", "approved")
      .orderBy("updatedAt", "desc").limit(ARTIST_LIMIT).get(),
    db.collection("profiles").where("type", "==", "curator").where("subtype", "==", "venue")
      .where("status", "==", "approved").limit(VENUE_LIMIT).get(),
  ]);
  const events = eventsSnap.docs.map((d) => ({ id: d.id, ev: d.data() as EventDoc }));
  const artists = artistsSnap.docs.map((d) => ({ id: d.id, p: d.data() as ProfileDoc }));
  const venues = venuesSnap.docs.map((d) => ({ id: d.id, p: d.data() as ProfileDoc }));

  // Earliest upcoming show per artist and per venue, from the same event window.
  const nextByArtist = new Map<string, { id: string; ev: EventDoc }>();
  const nextByVenue = new Map<string, { id: string; ev: EventDoc }>();
  for (const e of events) {
    if (!nextByVenue.has(e.ev.curatorProfileId)) nextByVenue.set(e.ev.curatorProfileId, e);
    for (const mid of e.ev.lineupMusicianProfileIds) if (!nextByArtist.has(mid)) nextByArtist.set(mid, e);
  }
  const dist = (geo: Geo | null | undefined): number | null => (location && geo ? haversineMeters(location, geo) : null);

  const candidates: DeckCandidate[] = [];
  for (const e of events) {
    if (excludeIds.has(e.id)) continue;
    const boost = followedProfiles.has(e.ev.curatorProfileId) || e.ev.lineupMusicianProfileIds.some((m) => followedProfiles.has(m));
    candidates.push({ id: e.id, kind: "show", genres: e.ev.genres ?? [], startsAt: e.ev.startsAt, distanceMeters: dist(e.ev.location.geo), followedBoost: boost });
  }
  for (const a of artists) {
    if (excludeIds.has(a.id) || followedProfiles.has(a.id)) continue;
    const next = nextByArtist.get(a.id);
    candidates.push({ id: a.id, kind: "artist", genres: a.p.portfolio?.genres ?? [], startsAt: next?.ev.startsAt ?? null,
      distanceMeters: next ? dist(next.ev.location.geo) : null, followedBoost: false });
  }
  for (const v of venues) {
    if (excludeIds.has(v.id) || followedProfiles.has(v.id)) continue;
    const next = nextByVenue.get(v.id);
    candidates.push({ id: v.id, kind: "venue", genres: v.p.curator?.lookingFor?.genres ?? [], startsAt: next?.ev.startsAt ?? null,
      distanceMeters: dist(v.p.curator?.location?.geo), followedBoost: false });
  }

  const page = rankDeck(candidates, { followedGenres, now, hasLocation: location !== null, seed }, DECK_PAGE_SIZE);

  // Resolve the page's supporting docs (curator handles for shows, previews, latest posts): bounded by the page size.
  const eventById = new Map(events.map((e) => [e.id, e.ev]));
  const artistById = new Map(artists.map((a) => [a.id, a.p]));
  const venueById = new Map(venues.map((v) => [v.id, v.p]));
  const profileName = async (id: string): Promise<{ name: string; handle: string | null }> => {
    const known = artistById.get(id) ?? venueById.get(id);
    if (known) return { name: known.name, handle: known.handle ?? null };
    const s = await db.doc(`profiles/${id}`).get();
    const p = s.data() as ProfileDoc | undefined;
    return { name: p?.name ?? "", handle: p?.handle ?? null };
  };

  const cards: DeckCard[] = await Promise.all(page.map(async (c): Promise<DeckCard> => {
    if (c.kind === "show") {
      const ev = eventById.get(c.id)!;
      const curator = await profileName(ev.curatorProfileId);
      const nameOf = (id: string) => ev.lineup.find((a) => a.kind === "booking" && a.musicianProfileId === id)?.name ?? "";
      const [preview, postSnap] = await Promise.all([
        previewFor(db, ev.lineupMusicianProfileIds, nameOf),
        db.collection(`events/${c.id}/posts`).where("status", "==", "live").orderBy("createdAt", "desc").limit(1).get(),
      ]);
      const post = postSnap.empty ? null : (postSnap.docs[0].data() as ShowPostDoc);
      return { kind: "show", id: c.id, eventId: c.id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt,
        venueName: ev.location.venueName ?? curator.name, neighborhood: ev.location.neighborhood, distanceMeters: c.distanceMeters,
        posterPath: ev.posterPath, lineupNames: ev.lineup.map((a) => a.name), curatorProfileId: ev.curatorProfileId, curatorHandle: curator.handle,
        priceFromCents: ev.priceFromCents ?? null, hasFreeTier: ev.hasFreeTier ?? false,
        latestPost: post ? { text: post.text, artistName: nameOf(post.musicianProfileId) } : null,
        genres: ev.genres ?? [], preview };
    }
    if (c.kind === "artist") {
      const p = artistById.get(c.id)!;
      const next = nextByArtist.get(c.id);
      const nextShow: DeckNextShow = next ? { eventId: next.id, title: next.ev.title, venueName: next.ev.location.venueName ?? "", startsAt: next.ev.startsAt } : null;
      return { kind: "artist", id: c.id, profileId: c.id, handle: p.handle, name: p.name, subtype: p.subtype as MusicianSubtype,
        genres: p.portfolio?.genres ?? [], coverPhotoPath: p.portfolio?.coverPhotoPath ?? null, avatarPhotoPath: p.portfolio?.avatarPhotoPath ?? null,
        nextShow, preview: await previewFor(db, [c.id], () => p.name) };
    }
    const p = venueById.get(c.id)!;
    const next = nextByVenue.get(c.id);
    const nextShow: DeckNextShow = next ? { eventId: next.id, title: next.ev.title, venueName: p.name, startsAt: next.ev.startsAt } : null;
    const preview = next
      ? await previewFor(db, next.ev.lineupMusicianProfileIds, (id) => next.ev.lineup.find((a) => a.kind === "booking" && a.musicianProfileId === id)?.name ?? "")
      : null;
    return { kind: "venue", id: c.id, profileId: c.id, handle: p.handle, name: p.name, neighborhood: p.curator?.location?.neighborhood ?? null,
      distanceMeters: c.distanceMeters, photoPath: p.curator?.photoPaths?.[0] ?? null, genres: p.curator?.lookingFor?.genres ?? [], nextShow, preview };
  }));

  const result: GetDiscoverDeckResult = { cards, seed };
  return result;
});
```

`index.ts`: `export { getDiscoverDeck } from "./discover.js";`

- [ ] **Step 1: Write the pure tests** `functions/test/discoverRank.test.ts` (imports `../src/discoverRank.js`; runs inside `emu:test` like `eventsCore.test.ts` but touches no emulator):

```ts
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
    const other = rankDeck(pool, { ...ctx, seed: 99 }, 20).map((x) => x.id);
    expect(other).not.toEqual(a); // seven candidates and a unit random term: a collision is astronomically unlikely
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
```

- [ ] **Step 2: Write the emulator tests** `functions/test/discover.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeFan, makePublishedBookingEvent, makeApprovedMusicianProfile, makeApprovedCuratorProfile } from "./discoverFixtures";
import type { GetDiscoverDeckResult } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const deck = (user: import("firebase/auth").User, data: Record<string, unknown> = {}) =>
  callFn<Record<string, unknown>, GetDiscoverDeckResult>("getDiscoverDeck", data, user);

describe("getDiscoverDeck", () => {
  it("requires auth and validates input", async () => {
    await expect(deck(undefined as never)).rejects.toMatchObject({ code: "functions/unauthenticated" });
    const fan = await makeFan("dk0");
    await expect(deck(fan.user, { location: { lat: 200, lng: 0 } })).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(deck(fan.user, { excludeIds: new Array(201).fill("x") })).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("returns show, artist, and venue cards with previews, excludes followed targets, and pages by excludeIds", async () => {
    const { curator, musician, eventId } = await makePublishedBookingEvent("dk1", [
      { name: "GA", priceCents: 1200, capacity: 10, saleStartsAt: null, saleEndsAt: null },
    ]);
    const fan = await makeFan("dk1f");
    const first = await deck(fan.user, { seed: 5 });
    expect(first.seed).toBe(5);
    const show = first.cards.find((c) => c.kind === "show" && c.id === eventId);
    expect(show).toBeDefined();
    if (show?.kind === "show") {
      expect(show.preview?.trackPath).toBe("public/tracks/seed/demo.m4a");
      expect(show.priceFromCents).toBe(1200); expect(show.hasFreeTier).toBe(false);
      expect(show.curatorHandle).toBeTruthy(); expect(show.lineupNames).toEqual(["The Act"]);
      expect(show.distanceMeters).toBeNull();
    }
    const artist = first.cards.find((c) => c.kind === "artist" && c.id === musician.profileId);
    expect(artist).toBeDefined();
    if (artist?.kind === "artist") {
      expect(artist.preview?.trackPath).toBe("public/tracks/seed/demo.m4a");
      expect(artist.nextShow?.eventId).toBe(eventId);
    }
    const venue = first.cards.find((c) => c.kind === "venue" && c.id === curator.profileId);
    expect(venue).toBeDefined();
    if (venue?.kind === "venue") { expect(venue.preview?.artistName).toBe("The Act"); expect(venue.nextShow?.eventId).toBe(eventId); }

    // Following the artist and venue removes their cards but keeps the show.
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, fan.user);
    const second = await deck(fan.user, { seed: 5 });
    expect(second.cards.some((c) => c.kind === "artist" && c.id === musician.profileId)).toBe(false);
    expect(second.cards.some((c) => c.kind === "venue" && c.id === curator.profileId)).toBe(false);
    expect(second.cards.some((c) => c.kind === "show" && c.id === eventId)).toBe(true);

    const third = await deck(fan.user, { seed: 5, excludeIds: [eventId] });
    expect(third.cards.some((c) => c.id === eventId)).toBe(false);
  });

  it("orders nearer venues first when a location is given and reports distances", async () => {
    // Two venues 0 km and ~11 km from the fan; seedCuratorGateContent puts every venue at 30.27/-97.74,
    // so move the second one by hand.
    const near = await makeApprovedCuratorProfile("dk2n", "venue");
    const far = await makeApprovedCuratorProfile("dk2f", "venue");
    await adb.doc(`profiles/${far.profileId}`).update({ "curator.location.geo": { lat: 30.37, lng: -97.74 } });
    const fan = await makeFan("dk2fan");
    const res = await deck(fan.user, { seed: 1, location: { lat: 30.27, lng: -97.74 } });
    const venues = res.cards.filter((c) => c.kind === "venue" && (c.id === near.profileId || c.id === far.profileId));
    expect(venues.length).toBe(2);
    const nearCard = venues.find((c) => c.id === near.profileId)!; const farCard = venues.find((c) => c.id === far.profileId)!;
    if (nearCard.kind === "venue" && farCard.kind === "venue") {
      expect(nearCard.distanceMeters).toBeLessThan(100);
      expect(farCard.distanceMeters).toBeGreaterThan(10_000);
    }
    expect(res.cards.indexOf(nearCard)).toBeLessThan(res.cards.indexOf(farCard));
  });

  it("interleaves kinds and caps at the page size", async () => {
    for (let i = 0; i < 4; i++) await makeApprovedMusicianProfile(`dk3m${i}`);
    const fan = await makeFan("dk3f");
    const res = await deck(fan.user, { seed: 3 });
    expect(res.cards.length).toBeLessThanOrEqual(20);
    for (let i = 2; i < res.cards.length; i++) {
      expect(res.cards[i].kind === res.cards[i - 1].kind && res.cards[i].kind === res.cards[i - 2].kind).toBe(false);
    }
  });
});
```

Note: the emulator database accumulates profiles and events from every other test file in the run (no per-file clear), so assertions above look for specific ids rather than counting cards. The distance ordering test compares two venues that both fall inside the first page only if fewer than 20 higher-scoring candidates exist; if that proves flaky in the full run, raise the far venue's separation and assert on `distanceMeters` values only, then ledger the change.

- [ ] **Step 3: Run** `pnpm emu:test`: both new files fail.
- [ ] **Step 4: Implement** `discoverRank.ts`, `discover.ts`, export.
- [ ] **Step 5: Run** `pnpm emu:test`: 722 + 12 pass. `pnpm typecheck` 5/5.
- [ ] **Step 6: Commit**: `feat(functions): getDiscoverDeck with seeded ranking, previews, and distances`

---

### Task 8: Web `/discover`, follow hook, genre picker, nav and redirect

**Files:**
- Create: `apps/web/src/discover/useFollows.ts`, `FollowButton.tsx`, `GenrePicker.tsx`, `ShowsList.tsx`, `ArtistsList.tsx`, `discoverQueries.ts`, `apps/web/app/discover/page.tsx`, `apps/web/app/discover/DiscoverClient.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx` (`navItemsFor`), `apps/web/src/marketing/SignedInRedirect.tsx`

**Interfaces (Produces, reused by Task 9):**

```ts
// useFollows.ts ("use client")
export type FollowState = { targets: Set<string>; loading: boolean; genres: string[] };
export function useFollows(uid: string | null): FollowState;                       // onSnapshot on follows where uid ==
export async function follow(targetId: string, targetType: FollowTargetType): Promise<void>;   // httpsCallable followTarget
export async function unfollow(targetId: string): Promise<void>;
// FollowButton.tsx ("use client")
export function FollowButton({ targetId, targetType, label }: { targetId: string; targetType: FollowTargetType; label?: string }): JSX.Element;
// GenrePicker.tsx ("use client")
export function GenrePicker({ open, onClose, preselected }: { open: boolean; onClose: () => void; preselected?: string[] }): JSX.Element;
export function useGenrePickerGate(uid: string | null): { shouldShow: boolean; markSeen: () => Promise<void> };
// discoverQueries.ts (plain module, no "use client": imported by client components only)
export type ShowRow = { id: string } & EventDoc;
export type ArtistRow = { id: string } & ProfileDoc;
export type DateFilter = "any" | "today" | "week" | "weekend";
export function dateWindow(filter: DateFilter, now: number): { from: number; to: number | null };  // LAUNCH_TIMEZONE-aware, weekend = Fri 17:00 to Sun 23:59
export function showsQuery(db: Firestore, opts: { genre: string | null; free: boolean; now: number }): Query;
export function artistsQuery(db: Firestore, opts: { genre: string | null }): Query;
```

Behavior:
- `FollowButton`: renders "Follow" (secondary, `IconPlus`) or "Following" (ghost, `IconCheck`); signed-out click routes to `/sign-in?next=<current path>` (reuse `isSafeNext` from the sub-6 sign-in split); optimistic toggle with rollback and the error shown inline via `err.message` (`=== FOLLOW_LIMIT_MESSAGE` keeps the exact text, anything else shows "Could not update. Try again.").
- `showsQuery`: `collection("events")`, `where("status","==","published")`, `where("startsAt",">=",now)`, optional `where("genres","array-contains",genre)`, optional `where("hasFreeTier","==",true)`, `orderBy("startsAt")`, `limit(60)`. Genre and free cannot both be pinned (no index): when both are chosen, query by genre and filter `hasFreeTier` client-side, documented in the code.
- `artistsQuery`: `collection("profiles")`, `where("type","==","musician")`, `where("status","==","approved")`, optional `where("portfolio.genres","array-contains",genre)`, `orderBy("name")`, `limit(60)`.
- `DiscoverClient`: `Tabs` (`apps/web/src/ui/tabs.tsx`) with "Shows" and "Artists"; Shows has chips (Button `size="sm"` toggles, `aria-pressed`) Today / This week / Weekend / Free plus a genre `Select`; date filters apply client-side over the 60-row window using `dateWindow`. Rows: Shows use the `UpcomingEventRow` pattern from `CuratorProfile.tsx` (date chip, title, `gigLocationLabel`, "from $12" via `formatCents` if one exists in `paymentDisplay.ts`, else `` `$${(cents/100).toFixed(2)}` ``, or "Free"), linking to `/e/[eventId]`; Artists rows show avatar (`usePosterUrl`-style hook or `getDownloadURL` per row, mirroring `MusicianBrowse.tsx`), name, subtype `Badge`, genres, and a `FollowButton`.
- `app/discover/page.tsx`: same gate as `app/tickets/page.tsx` (redirect to `/sign-in` when signed out, skeleton while loading), metadata title "Discover". Opens `GenrePicker` when `useGenrePickerGate(uid).shouldShow` (no genre follows and `users/{uid}.genrePickerSeenAt` unset; read the user doc once).
- `GenrePicker`: `Dialog` with the 22 `GENRES` as toggle chips, "Done" (calls `follow` for each selected genre then `markGenrePickerSeen`), "Skip" (only `markGenrePickerSeen`). Copy: title "What do you listen to?", body "Pick a few and the feed leans that way. You can change this any time." No genre pre-checked unless `preselected`.
- `navItemsFor`: add `const discover: NavItem = { label: "Discover", href: "/discover", icon: IconCompass };` (add `IconCompass` to `icons.tsx` from Phosphor `Compass`) and place it first for the generic context and right after Dashboard for musician and curator contexts.
- `SignedInRedirect`: use `useMyProfiles(user?.uid ?? null)` and route to `/discover` when the list is empty after the first snapshot; to `/dashboard` otherwise. Since `useMyProfiles` returns `[]` before the first snapshot, gate on a local "resolved" flag: subscribe the same way and only redirect once the snapshot has arrived (copy the `onSnapshot(collectionGroup("members"))` pattern from `useMyProfiles.ts` with a `resolved` state; do not import the hook if it cannot report resolution).

- [ ] **Step 1: Implement** the files above.
- [ ] **Step 2: Verify**: `pnpm --filter @gatekeep/web lint` 0, `pnpm --filter @gatekeep/web build`, then with emulators + seed (`scripts/seed-test-accounts.ts`, `scripts/seed-test-event.ts`) load `/discover` signed in as test-fan: the Shows tab lists the seeded event, the genre picker appears once and not again after Skip, Follow on the seeded artist flips to Following and a `follows/{uid}_{profileId}` doc exists in the emulator UI; `/` signed in as test-fan lands on `/discover`, as test-curator on `/dashboard`.
- [ ] **Step 3: Commit**: `feat(web): signed-in discover lists, following, genre picker, nav`

---

### Task 9: Web follow buttons, posts, post-purchase prompt, admin panel, notification links

**Files:**
- Modify: `apps/web/app/u/[handle]/MusicianProfile.tsx`, `CuratorProfile.tsx`, `apps/web/app/e/[eventId]/EventPageClient.tsx`, `apps/web/src/events/BuyTicketsFlow.tsx`, `apps/web/app/dashboard/page.tsx`, `apps/web/app/admin/page.tsx`
- Create: `apps/web/src/discover/ShowPosts.tsx` (`"use client"`)

**Interfaces (Consumes):** `FollowButton`, `GenrePicker`, `useFollows` (Task 8); callables `createShowPost`, `removeShowPost` (Task 6).

```ts
// ShowPosts.tsx exports
export function ShowPostsForAct({ eventId, musicianProfileId, artistName, endsAt }: { eventId: string; musicianProfileId: string; artistName: string; endsAt: number }): JSX.Element;
// Renders live posts (query events/{eventId}/posts where status == "live" and musicianProfileId == X, orderBy createdAt desc, limit 3;
// needs no extra index beyond (status, createdAt) because the musicianProfileId equality is applied client-side after the
// status-pinned query, documented in code) and, when the signed-in user is a member of musicianProfileId (one getDoc on
// profiles/{id}/members/{uid}), a composer: Textarea maxLength 280 with a live counter "120 / 280", Post button, and a
// Delete on each own post. Errors: message === SHOW_POST_LIMIT_MESSAGE | SHOW_POST_RATE_MESSAGE | SHOW_POST_EVENT_CLOSED_MESSAGE
// shown verbatim, else "Could not post. Try again."
export function LatestPostLine({ eventId, musicianProfileId }: { eventId: string; musicianProfileId: string }): JSX.Element | null;
// One quoted line, the newest live post by that act on that event, for profile-page event rows.
```

Changes:
- `MusicianProfile.tsx` hero (lines 130-143): add `<FollowButton targetId={data.profileId} targetType="musician" />` beside the badges. Upcoming events rows: append `<LatestPostLine eventId={row.eventId} musicianProfileId={data.profileId} />` and, for members, the composer via `<ShowPostsForAct ... />` inside a collapsible "Post about this show" (`details`/`summary` styled per DESIGN.md) so the public page stays quiet for non-members. Both are client components; `MusicianProfile` is a server component, so import them as components only (no values), per the RSC rule.
- `CuratorProfile.tsx` hero (lines 226-240): `<FollowButton targetId={data.profileId} targetType="curator" label="Follow venue" />` when `isVenue`, plain "Follow" otherwise.
- `EventPageClient.tsx`: venue card gets `<FollowButton targetId={event.curatorProfileId} targetType="curator" label="Follow venue" />`; each lineup act with a profile gets `<FollowButton targetId={act.profileId} targetType="musician" />` and `<ShowPostsForAct eventId={eventId} musicianProfileId={act.profileId} artistName={act.name} endsAt={event.endsAt} />`. Check `EventPageLineupEntry` carries the profile id; if it only carries `handle`, extend `resolveLineup` in `app/e/[eventId]/page.tsx` to include `profileId` (server-side, additive).
- `BuyTicketsFlow.tsx` "done" + "paid" branch: after "View your tickets", render `<PostPurchaseGenrePrompt eventGenres={event.genres ?? []} />` (new small client component in `GenrePicker.tsx`): shows "Want more shows like this?" with a "Pick genres" button only when `useGenrePickerGate(uid).shouldShow`; opens `GenrePicker` with `preselected={eventGenres}`; dismiss calls `markSeen`. Never rendered in any other phase.
- `dashboard/page.tsx`: profile rows show `{followerCount ?? 0} followers` (read from the profile doc already fetched); notification rows: `href` for `show_announced`, `show_rescheduled`, `show_post` = `/e/${refId}`; for `new_music` resolve `/u/${handle}` via one `getDoc(profiles/{refId})` in a tiny `useProfileHandle(refId)` hook (cache in a `useRef` map).
- `admin/page.tsx`: new `ShowPostsPanel` after `TakedownsPanel`: `collectionGroup("posts")` requires a rule; instead query recent events (`events where status == "published" orderBy startsAt limit 50`) then their live posts in parallel, flatten, sort by `createdAt` desc, show 50 rows (artist, event title, text, time) with Remove calling `removeShowPost`. Heading "Show posts". Admin reads pass through the admin clauses already in the rules.

- [ ] **Step 1: Implement**.
- [ ] **Step 2: Verify**: lint 0, build, live loads of `/u/testmusician`, `/u/testvenue`, `/e/<seeded event>` signed out (follow buttons route to sign-in, no console errors), signed in as test-musician (composer appears on the seeded event only if that event's lineup contains the musician profile: use `scripts/seed-test-discovery.ts` from Task 14 or create one through the curator UI with a booking act), and `/admin` as an admin claim user shows the panel. Post-purchase prompt: buy the seeded free tier as test-fan with zero genre follows and confirm the prompt appears once.
- [ ] **Step 3: Commit**: `feat(web): follow buttons, show posts, post-purchase genre prompt, admin posts panel`

---

### Task 10: Web landing fan story and hero path

**Files:**
- Modify: `apps/web/src/marketing/LandingSections.tsx` (add `FanStorySection`), `apps/web/src/marketing/LandingHero.tsx` (`HeroCopy`), `apps/web/app/page.tsx` (insert the section between `CuratorStorySection` and `HowItWorksSection`)

`FanStorySection` uses `AudienceSection` with:
- heading: "Hear the room before you buy the ticket."
- paragraphs: ["Every artist on GateKeep has real recordings hosted here, so a show listing plays you the band, not a poster. Swipe through who is playing near you, follow the ones you like, and get told when they book a night.", "Tickets live in the app. No printouts, no third-party resale, no surprise fees at the door."]
- ctaLabel: "Find a show"; the CTA `Link` must point at `/discover` (add an optional `ctaHref` prop to `AudienceSection`, default `/sign-in`, so the two existing sections are untouched).
- imageSrc: `/marketing/discover-shows.jpg` (add a 1568x380 placeholder JPG under `apps/web/public/marketing/` built the same way the existing marketing images were, or reuse `find-gigs-browse.jpg` with a TODO-free comment naming the replacement the owner owes; alt text describes the Shows list).
- `reverse` false (the curator section above is reversed, so this alternates).

`HeroCopy`: add a third control after "I book talent": `<Button asChild variant="link" size="lg" className="text-gk-text"><Link href="/discover">Find a show</Link></Button>`. Keep the two existing buttons byte-identical.

- [ ] **Step 1: Implement** (copy passes antislop-copywriting: no invented numbers, no "seamless", no em dashes).
- [ ] **Step 2: Verify**: lint, build, live load `/` signed out in both themes: the new section renders between the venue story and How it works; the hero shows three paths.
- [ ] **Step 3: Commit**: `feat(web): landing fan story and find-a-show path`

---

### Task 11: Mobile follows, lists, genre picker, Following screen, venue screen, prompts, deep links

**Files:**
- Create: `apps/mobile/src/discover/useFollows.ts`, `FollowButton.tsx`, `GenrePickerSheet.tsx`, `ShowsList.tsx`, `ArtistsList.tsx`, `discoverQueries.ts`, `storageUrl.ts`, `apps/mobile/app/(fan)/following.tsx`, `apps/mobile/app/venue/[handle].tsx`
- Modify: `apps/mobile/src/shell/AccountScreen.tsx` (a "Following" row linking to `/(fan)/following`), `apps/mobile/src/shell/NotificationsList.tsx` (deep links), `apps/mobile/app/event/[eventId].tsx` (post-purchase prompt in the `phase === "done" && orderStatus === "paid"` branch), `apps/mobile/app/(fan)/_layout.tsx` (register `following` with `href: null` so it is not a tab)

**Interfaces (Produces, used by Tasks 12 and 13):**

```ts
// storageUrl.ts: public URL for a world-gettable storage path, no getDownloadURL round trip.
export function publicStorageUrl(path: string): string;
// `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media` in production, and the
// emulator host form when getFirebase().storage is connected to the emulator (read the bucket from getFirebase().storage.app.options.storageBucket;
// detect the emulator the same way src/lib/firebase.ts decides to connect to it). Verify a seeded track plays from this URL on a device or
// via `curl` against the emulator before relying on it; if the emulator refuses tokenless reads, fall back to getDownloadURL there only.
// useFollows.ts
export function useFollows(uid: string | null): { targets: Set<string>; genres: string[]; loading: boolean };
export async function follow(targetId: string, targetType: FollowTargetType): Promise<void>;
export async function unfollow(targetId: string): Promise<void>;
// FollowButton.tsx
export function FollowButton({ targetId, targetType, label, compact }: { targetId: string; targetType: FollowTargetType; label?: string; compact?: boolean }): JSX.Element;
// GenrePickerSheet.tsx
export function GenrePickerSheet({ visible, onClose, preselected }: { visible: boolean; onClose: () => void; preselected?: string[] }): JSX.Element;
export function useGenrePickerGate(uid: string | null): { shouldShow: boolean; markSeen: () => Promise<void> };
export function PostPurchaseGenrePrompt({ eventGenres }: { eventGenres: string[] }): JSX.Element | null;
// ShowsList.tsx / ArtistsList.tsx: full-screen lists with the same filters as web (Chip primitives), each row pushes /event/[eventId] or /artist/[handle].
export function ShowsList(): JSX.Element;
export function ArtistsList(): JSX.Element;
```

Behavior mirrors Task 8 on the 9B primitives (`Chip`, `Card`, `Button`, `Sheet`, `Skeleton`, `ErrorBanner`, `Text`, Phosphor icons; empty states composed inline like `(fan)/index.tsx` lines 96-102). `FollowButton` is `Button variant="secondary" title="Follow"` / `variant="ghost" title="Following"`, optimistic with rollback, error via `ErrorBanner`. Genre picker copy identical to web (byte-match). `following.tsx`: three sections from `useFollows` plus profile names resolved by `getDoc(profiles/{id})` per target (cached), each row with Unfollow, "Edit genres" button opening the sheet preselected. `venue/[handle].tsx`: resolve `handles/{handle}` then `profiles/{id}` (type must be `curator`, else not-found), photos (`curator.photoPaths` through `publicStorageUrl`), name, subtype chip, about, `location.neighborhood` and `city`, "Upcoming events" (`events where curatorProfileId == id, status == published, startsAt >= now orderBy startsAt`, index exists from sub-6), `FollowButton`. `NotificationsList.onPress`: `show_announced | show_rescheduled | show_post` push `/event/[eventId]` with `refId`; `new_music` resolves the handle via `getDoc(profiles/{refId})` then pushes `/artist/[handle]`.

- [ ] **Step 1: Implement**.
- [ ] **Step 2: Verify**: `pnpm --filter @gatekeep/mobile lint` (0 new), `pnpm typecheck`, `pnpm --filter @gatekeep/mobile exec expo export --platform ios --no-bytecode` bundles. Screens are device-only beyond that; the owner smoke covers them.
- [ ] **Step 3: Commit**: `feat(mobile): follows, discover lists, genre picker, following and venue screens`

---

### Task 12: Mobile swipe deck

**Files:**
- Create: `apps/mobile/src/discover/DeckScreen.tsx`, `DeckCards.tsx` (`ShowCard`, `ArtistCard`, `VenueCard`), `useDeckAudio.ts`, `useDeckLocation.ts`, `deckPrefs.ts` (AsyncStorage: `mute`, `locationPromptSeen`)
- Modify: `apps/mobile/app/(fan)/index.tsx` (renders `DeckScreen`; the "Your upcoming shows" list moves into the List view's Shows tab header so nothing is lost), `apps/mobile/package.json` (`expo-location`, `@react-native-async-storage/async-storage` if not already present), `apps/mobile/app.json` (`ios.infoPlist.NSLocationWhenInUseUsageDescription: "GateKeep shows venues and shows close to you."`, `plugins` gains `["expo-location", { "locationWhenInUsePermission": "GateKeep shows venues and shows close to you." }]`)

**Interfaces (Consumes):** `getDiscoverDeck` (Task 7), `DeckCard` (Task 1), `FollowButton`, `publicStorageUrl`, `ShowsList`, `ArtistsList`, `GenrePickerSheet`, `useGenrePickerGate` (Task 11), `distanceLabel`, `formatEventFullDate` (sub-6 `src/events/eventDisplay.ts`).

```ts
// useDeckAudio.ts
export function useDeckAudio(): { bind: (card: DeckCard | null) => void; muted: boolean; toggleMute: () => void; stop: () => void };
// One useAudioPlayer(null) instance. bind(card): if card.preview is null, pause and clear; otherwise player.replace(publicStorageUrl(preview.trackPath)),
// player.seekTo(preview.startSec), player.play(). muted -> player.muted = true; persisted via deckPrefs. stop() pauses. Wrap every player
// call in try/catch and mark the card silent on failure (state kept in a ref keyed by card id). Stop on useFocusEffect blur and on AppState
// background (AppState.addEventListener("change")).
// useDeckLocation.ts
export function useDeckLocation(): { location: { lat: number; lng: number } | null; promptVisible: boolean; allow: () => Promise<void>; dismiss: () => Promise<void>; enable: () => Promise<void> };
// First open (deckPrefs.locationPromptSeen unset): promptVisible true. allow(): Location.requestForegroundPermissionsAsync(); on granted,
// Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }) once, set location. dismiss(): mark seen only. enable(): the
// "Turn on location" link path: request again, and if permanently denied, Linking.openSettings() (same fallback ScannerScreen uses).
// Position lives in component state only.
```

`DeckScreen`:
- State: `cards: DeckCard[]`, `seed`, `loading`, `error`, `shownIds: string[]` (cap 200, oldest dropped), `view: "deck" | "list"`.
- Fetch: `httpsCallable(getFirebase().functions, "getDiscoverDeck")({ location, excludeIds: shownIds, seed })`; append cards; when `viewableIndex >= cards.length - 5` and not loading, fetch the next page. Pull-to-refresh: new seed, clear cards and shownIds.
- FlatList: `pagingEnabled`, `snapToInterval={cardHeight}` where `cardHeight` is the list's measured layout height, `decelerationRate="fast"`, `showsVerticalScrollIndicator={false}`, `getItemLayout`, `onViewableItemsChanged` with `viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}` (held in a `useRef` so the reference is stable) calling `audio.bind(card)` and pushing the id into `shownIds`.
- Overlay controls (top corners, above the card, not glass): "List" (`IconListBullets`, add to icons.tsx) switching `view`; mute toggle (`IconSpeakerHigh` / `IconSpeakerSlash`, add both).
- Sheets: `GenrePickerSheet` when the gate says so (after the location prompt closes, never both at once); location prompt `Sheet` with title "Show what's close", body "Allow location and the deck ranks nearby rooms and shows first. Nothing is stored.", buttons Allow / Not now.
- Empty deck: `IconMusicNotes` + "Nothing to show yet" + "Follow a few genres and check back, or turn on location." with the "Turn on location" link when no permission. Error: `ErrorBanner` + Retry.
- `view === "list"`: a segmented pair of `Chip`s "Shows" | "Artists" over `ShowsList` / `ArtistsList`, and a "Deck" control to return; `audio.stop()` on entering the list.

`DeckCards.tsx` (each fills the page, `Card` surface, image on top with `PhotoScrim` over the image only, text block below; poster/cover/photo via `publicStorageUrl`, `PhotoPlaceholder` when null):
- `ShowCard`: title (`Text variant="display"`), `formatEventFullDate(startsAt)` + time, venue line `IconMapPin` `{venueName}, {neighborhood}` + `distanceLabel(distanceMeters)` when non-null, lineup names joined with ", ", latest post as `"{text}"` with `artistName` in `meta`, price `Badge` ("Free" / "from $12"), buttons `Button title="Tickets"` (push `/event/[eventId]`) and `FollowButton targetId={curatorProfileId} targetType="curator" label="Follow venue" compact`.
- `ArtistCard`: cover (avatar fallback), name, subtype `Badge`, genre `Badge`s, "Next: {venueName}, {date}" when `nextShow`, `FollowButton`, a "No preview yet" `meta` line when `preview === null`; `Pressable` on the image and name pushes `/artist/[handle]`.
- `VenueCard`: photo, name, neighborhood + distance, "Next up: {title}, {date}" when `nextShow`, `FollowButton label="Follow venue"`, tap pushes `/venue/[handle]`.

- [ ] **Step 1: Add dependencies**: `pnpm --filter @gatekeep/mobile add expo-location` (and async-storage if missing), update `app.json`.
- [ ] **Step 2: Implement** the files.
- [ ] **Step 3: Verify**: mobile lint 0 new, typecheck, `expo export --platform ios --no-bytecode` bundles. Confirm `publicStorageUrl` against the emulator with `curl` on a seeded public path (`scripts/seed-test-discovery.ts`, Task 14, seeds one).
- [ ] **Step 4: Commit**: `feat(mobile): swipe deck with per-card audio and nearby ranking`

---

### Task 13: Mobile show posts (event screen and artist page)

**Files:**
- Create: `apps/mobile/src/discover/ShowPosts.tsx` (`ShowPostsForAct`, `LatestPostLine`, `PostComposerSheet`)
- Modify: `apps/mobile/app/event/[eventId].tsx` (lineup rows), `apps/mobile/app/artist/[handle].tsx` (new "Upcoming shows" section from the `lineupMusicianProfileIds` events query; posts per row)

**Interfaces (Consumes):** `createShowPost`, `removeShowPost` (Task 6), `useProfileContext().myProfiles` (membership = `myProfiles.some((p) => p.profileId === musicianProfileId)`), messages from Task 1.

Behavior mirrors Task 9's web component: live posts (max 3) under each lineup act that has a profile (`LineupEntry` in the event screen gains `profileId: string | null`, additive to `resolveLineup`), composer sheet (`Sheet` + `TextArea` + counter "120 / 280" + `Button title="Post"`) for members, Delete on own posts, errors compared with `===` against the three post messages and shown via `ErrorBanner`, otherwise "Could not post. Try again.". Artist page: add an "Upcoming shows" section (query `events where lineupMusicianProfileIds array-contains profileId, status == published, startsAt >= now orderBy startsAt limit 20`; index from sub-6) above the gigs-based Shows sections, each row title + date + `gigLocationLabel`, pushes `/event/[eventId]`, with `LatestPostLine` and, for members, a "Post about this show" button opening the composer.

- [ ] **Step 1: Implement**.
- [ ] **Step 2: Verify**: lint, typecheck, expo export.
- [ ] **Step 3: Commit**: `feat(mobile): show posts on the event screen and artist page`

---

### Task 14: Seed script, docs, final gates

**Files:**
- Create: `scripts/seed-test-discovery.ts`
- Modify: `README.md` (sub-7 launch checklist + smoke checklist), `docs/superpowers/HANDOFF.md` (7 done, NEXT = 8 Search, gate counts), `firestore.indexes.json` (no change; verify deployed shape)

`scripts/seed-test-discovery.ts` (copy the sign-in pattern from `scripts/seed-test-event.ts`): as admin SDK, give `@testmusician` an approved track doc `profiles/{id}/tracks/seed-demo` with `storagePath: "public/tracks/{id}/seed-demo.m4a"` and upload a short generated WAV transcoded by the emulator? No: the storage emulator will not transcode; instead upload `functions/test`'s `makeWav(8)` bytes to that path with `contentType: "audio/mp4"` through the Admin bucket (players tolerate a WAV payload for a smoke), and print a warning that real audio needs a real upload. Then sign in as test-curator and create a second published event whose lineup is a booking act: this requires a real filled gig, so the script runs the same chain `makeFilledGig` does (`createGig`, `publishGig`, sign in as test-musician for `applyToGig`, back to curator for `acceptBooking`, which needs `makeMoneyReady`'s FakeStripe shortcuts: replicate them with the Admin SDK exactly as `helpers.ts` lines 73-91 do). Finally, as test-fan, `followTarget` on `genre:rock`. Print the event id and the deck-preview path. Document the invocation in README beside the other seed scripts.

README additions:
- "Sub-project 7 launch checklist": deploy the 8 new composite indexes (list them) and confirm they build; new EAS dev build (expo-location joined the native deps); the marketing image owed for the fan section.
- "Sub-project 7 smoke checklist": web: `/discover` lists and filters, follow/unfollow on `/u` pages and `/e`, genre picker once, post-purchase prompt after a free order with no genre follows, posts by a lineup member on `/e`, admin Remove, landing section in both themes, signed-in redirect for a profile-less user. Mobile: deck opens on Discover, audio swaps on swipe, mute persists across relaunch, location Allow shows distances and Not now does not, permanently denied opens Settings from the empty state, List flips to Shows | Artists and back, Follow from every card kind, Following screen unfollow, venue screen, notification taps deep-link (announced, rescheduled, post, new music), composer caps (3 per event, 10 minutes), both themes.

- [ ] **Step 1: Write the seed script** and run it against the emulators; run `curl` on the printed public path.
- [ ] **Step 2: Update README and HANDOFF** (no em dashes).
- [ ] **Step 3: Full gates**, each in the foreground: `pnpm typecheck` (5/5), `pnpm --filter @gatekeep/shared test` (169), `pnpm emu:test` (734), `pnpm emu:rules` (111), `pnpm --filter @gatekeep/web lint` + `build`, `pnpm --filter @gatekeep/mobile lint`, `expo export --platform ios --no-bytecode`. Record the exact counts in the ledger.
- [ ] **Step 4: Commit**: `docs: sub-project 7 seed script, smoke checklist, handoff`

---

## Self-review notes (writing-plans checklist, run once)

- Spec coverage: decisions 1 to 10 map to Tasks 8/11/12 (lists + deck), 4 (targets), 5 (notifications), 6/9/13 (posts), 8 (web signed-in), 10 (landing), 8/11 + 9 (genre picker and post-purchase), 12 (audio, location), 7 (engine). Data model: Task 1 (types), 2 (rules/indexes), 3 (projections). Fan-out and dedupe: Tasks 4, 5. Venue screen and "on the bill": Tasks 11 and 5. Testing section: Tasks 1 to 7 carry the tests; web and mobile verification steps carry the live loads and exports. Out of scope items have no task.
- Placeholders: none; every code step has the code or an exact anchor (file, line range, existing symbol).
- Type consistency: `FollowTargetType`, `FollowDoc`, `ShowPostDoc`, `DeckCard`, `DeckPreview`, `DeckNextShow`, `GetDiscoverDeckInput/Result` defined in Task 1 and consumed by name in Tasks 4 to 13; `notifyFollowers(targetIds, note, dedupeKey, extraUids)` defined in Task 4 and called with that shape in Tasks 5 and 6; `announceTargets`/`*Note` builders in Task 5's `announce.ts`; `publicStorageUrl`, `FollowButton`, `useGenrePickerGate`, `ShowsList`, `ArtistsList` defined in Task 11 and consumed in Tasks 12 and 13.

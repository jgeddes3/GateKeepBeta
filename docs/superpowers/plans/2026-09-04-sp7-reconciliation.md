# Sub-project 11: SP7 Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five gaps the 2026-09-01 audit's SP7 brief left open: a share affordance with links that open the app, a distance-aware Discover on web with a home-city fallback on both platforms, an editable fan account, doors time and age restriction on events, and curator-tagged artists on events that are not tied to a booking.

**Architecture:** One new callable file (`eventArtistTags.ts`) owns the tag lifecycle and is the only writer of `tagged` lineup acts; `updateAccount` joins `account.ts` and is the only writer of `displayName`, `homeCity`, and the server-coarsened `homeGeo` (the client rule loses those keys). Doors and age ride the existing `validateEventInput` plus the existing full-replace `createEvent`/`updateEvent` payloads and the existing search-index event trigger. Clients gain one shared Share component per platform, a mobile handle resolver screen for incoming `/u/` links, two env-gated well-known route handlers on web, and an account editor on each platform.

**Tech Stack:** pnpm monorepo; `packages/shared` (TypeScript, vitest); `functions` (Firebase Functions v2, firebase-admin 12, Node 22, vitest against the emulator suite); `apps/web` (Next.js 16, React 19, Tailwind 4, Radix primitives, Phosphor `/ssr` icons); `apps/mobile` (Expo SDK 57, expo-router typed routes, React Compiler, `phosphor-react-native`); `tests-rules` (`@firebase/rules-unit-testing`). No new dependencies on either client.

**Spec:** `docs/superpowers/specs/2026-09-04-sp7-reconciliation-design.md` (binding authority; every ruling below argues from it).

## Global Constraints

- **No em dashes anywhere** (U+2014): code, comments, copy, docs, tests, commit messages, reports. CI's last step fails a push containing one. Use commas, colons, or parentheses.
- `DESIGN.md` (repo root) binds every visual decision; the antislop, antislop-ui, and antislop-copywriting skills bind UI and copy work. No lucide icons, no Inter/Geist/Space Grotesk, no bento grids, **no invented numbers**, no fake testimonials.
- Icons: web imports only through `apps/web/src/ui/icons.tsx` (Phosphor `/ssr`, duotone); mobile only through `apps/mobile/src/ui/icons.tsx` (`phosphor-react-native`, duotone). Add new icons there, never import Phosphor elsewhere.
- **Copy is exactly the spec's section 6 strings**, no paraphrase. Share button label "Share"; web fallback toast "Link copied"; "Use my location"; "Ranked near {homeCity}"; mobile sheet line "Or set a home city under Account."; "Display name" with "Shown on tickets you buy from now on."; "Home city" with "Used to rank shows near you when your location is off."; success "Saved."; geocoder miss "We could not place that city; ranking will not use it."; "Display name must be 1 to 80 characters."; "Home city must be 80 characters or fewer."; "Doors must be before the start time and within 12 hours of it."; "Pick an age restriction."; "Doors {time}"; badges "18+" and "21+"; notification title "You were tagged on a lineup" and body "{curatorName} tagged you on {eventTitle}."; banner "You were tagged on this lineup"; buttons "Accept" and "Decline"; editor statuses "Pending", "Accepted", "Declined"; picker "Tag a GateKeep artist"; errors "That artist is already on the lineup.", "Only approved artists can be tagged.", "This tag has already been answered."
- **Money paths are not touched by this sub-project.** Nothing here calls Stripe, writes `ledger`, `payments`, `orders`, `heldShares`, or `distributions`, or changes settlement, refunds, or payouts. If a task looks like it needs a money file, stop and escalate.
- Two sweeps exist, so never write a bare "step N": always `dailySweep step N` (nine steps) or `paymentsSweep step N` (eleven steps). This sub-project adds **no** sweep step to either.
- Every Firestore write from a client goes through a callable. Both clients call callables through `callFn` (`src/lib/callable.ts`), which retries once on a stale verify-email claim.
- Shared code is imported as `@gatekeep/shared`; inside `packages/shared` use relative `./x.js` imports. `functions` imports its own modules with `.js` extensions.
- Notification fan-out stays post-commit and best-effort inside `try { } catch (e) { console.error(...) }` (`sp7-rulings.md` ruling 3), and every dedupe key is create-if-absent through `notifyUser`'s third argument (ruling 2).
- Firestore transactions read before they write (`sp7-rulings.md` ruling 4).
- The search index is server-only; nothing leaves it except through `SearchResult`/`SearchPin` (`sp8-rulings.md` ruling 3). Filter semantics live once, in shared `matchesFilters` (ruling 4). Steer emulator search tests with unique tokens, never with caps (ruling 5).
- No new composite index is expected. Task 6's step 1 re-checks every query in this plan against `firestore.indexes.json` before any code is written.
- Commit after every task with a conventional message (`feat:`, `fix:`, `test:`, `docs:`) plus the session's attribution trailer.
- Emulator runs: one file at a time, from the worktree root, as
  `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/<file>"`,
  with Java on PATH (`C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin`) and `FUNCTIONS_DISCOVERY_TIMEOUT=60`. Check port 8080 is free first (`netstat -ano | findstr :8080`); never kill another session's run and never start `firebase emulators:start` by hand. A full `pnpm emu:test` exceeds the tool's 600 s foreground limit; the controller runs it through the detached runner. Never pipe the Firebase CLI to `head` (EPIPE orphans the Firestore emulator).
- A fresh worktree needs an untracked `functions/.secret.local` (copy from the main checkout) and `pnpm --filter @gatekeep/web exec next typegen` before web typecheck.
- Tests import shared fixtures from `functions/test/helpers.ts`, `functions/test/discoverFixtures.ts`, and `functions/test/payoutFixtures.ts`, never from another test file. A missing helper is created in a fixtures file by the task that needs it, and a fixture never calls `expect` itself.
- Client tasks carry no browser or device tests (owner-owed). Their gates are typecheck, lint, build (web) or `expo export --no-bytecode` (mobile).
- Gates before merge: `pnpm typecheck` (5/5), shared tests, web tests, `pnpm emu:test`, `pnpm emu:rules`, web lint (0 errors) + build, mobile lint (0 new warnings) + `expo export --no-bytecode`.

---

## File structure

**Shared (`packages/shared/src`)**
- `types.ts`: `AgeRestriction` + `AGE_RESTRICTIONS`, `TaggedActStatus`, the `tagged` `EventAct` variant, `UserDoc.homeGeo`, `EventDoc.doorsAt`/`ageRestriction`, `NotificationDoc.kind` gains `artist_tag`, `UpdateAccountInput`/`UpdateAccountResult`, `DOORS_MAX_BEFORE_START_MS`.
- `search.ts`: `SearchIndexDoc.ageRestriction`, `SearchFilters.allAges`, `FACE_FILTER_KEYS.fan`, `validateFilters`, `matchesFilters`, `savedSearchLabel`.
- `messages.ts`: the sub-11 message block. `notificationHref.ts`: the `artist_tag` branch.

**Backend (`functions/src`)**
- `eventArtistTags.ts` (new): `tagEventArtist`, `untagEventArtist`, `respondToArtistTag`, `reconcileTaggedActs`, `notifyPendingTags`.
- `account.ts`: `updateAccount`. `eventsCore.ts`: doors and age validation, the `tagged` act shape. `events.ts`: the two write paths, `deriveLineupMusicianProfileIds`, `publishEvent`'s tag notification. `announce.ts`: `artistTagNote`. `searchIndex.ts`: the show projection's `ageRestriction`. `index.ts`: exports.

**Rules and indexes**: `firestore.rules`, `tests-rules/reconciliation.rules.test.ts`. No index change.

**Web (`apps/web`)**
- `src/share/ShareButton.tsx`; `app/well-known/apple-app-site-association/route.ts`; `app/well-known/assetlinks.json/route.ts`; `next.config.ts`.
- `src/account/AccountCard.tsx`; `app/dashboard/page.tsx`.
- `src/discover/useHomeGeo.ts`, `src/discover/RankedShows.tsx`, `src/discover/ShowsList.tsx`, `app/discover/DiscoverClient.tsx`.
- `src/events/ArtistPicker.tsx`, `src/events/EventEditor.tsx`, `src/events/eventDisplay.ts`.
- `app/e/[eventId]/page.tsx`, `app/e/[eventId]/EventPageClient.tsx`, `src/events/ArtistTagBanner.tsx`, `src/seo/jsonLd.ts`, `app/u/[handle]/page.tsx`, `src/search/FilterBar.tsx`.

**Mobile (`apps/mobile`)**
- `app.json`; `app/_layout.tsx`; `app/u/[handle].tsx` (new resolver); `app/e/[eventId].tsx` (new redirect); `src/share/ShareButton.tsx`.
- `src/account/EditAccountSheet.tsx`, `src/shell/AccountScreen.tsx`; `src/discover/useHomeGeo.ts`, `src/discover/DeckScreen.tsx`, `src/discover/LocationPromptSheet.tsx`.
- `app/(curator)/events/event/[eventId].tsx`, `src/events/EventDetailsFields.tsx`, `src/events/LineupEditor.tsx`, `src/events/ArtistPickerSheet.tsx`.
- `app/event/[eventId].tsx`, `app/artist/[handle].tsx`, `app/venue/[handle].tsx`, `src/search/FilterChips.tsx`.

**Docs**: `README.md`, `docs/superpowers/HANDOFF.md`.

---

### Task 1: Shared types, messages, filter, and notification route

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/search.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/notificationHref.ts`
- Test: `packages/shared/test/search.test.ts` (append), `packages/shared/test/notificationHref.test.ts` (append)

**Interfaces:**
- Produces (every later task imports these from `@gatekeep/shared`): `AgeRestriction`, `AGE_RESTRICTIONS`, `AGE_RESTRICTION_LABEL`, `TaggedActStatus`, the `tagged` `EventAct` variant, `UserDoc.homeGeo`, `EventDoc.doorsAt`, `EventDoc.ageRestriction`, `DOORS_MAX_BEFORE_START_MS`, `UpdateAccountInput`, `UpdateAccountResult`, `SearchFilters.allAges`, `SearchIndexDoc.ageRestriction`, `ACCOUNT_NAME_MESSAGE`, `ACCOUNT_CITY_MESSAGE`, `ACCOUNT_SAVED_MESSAGE`, `ACCOUNT_NAME_HELP`, `ACCOUNT_CITY_HELP`, `ACCOUNT_GEOCODE_MISS_MESSAGE`, `EVENT_DOORS_MESSAGE`, `EVENT_AGE_MESSAGE`, `ARTIST_TAG_DUPLICATE_MESSAGE`, `ARTIST_TAG_UNAPPROVED_MESSAGE`, `ARTIST_TAG_ANSWERED_MESSAGE`, `ARTIST_TAG_UNKNOWN_MESSAGE`, `SHARE_LINK_COPIED_MESSAGE`, `HOME_CITY_PROMPT_LINE`, `ARTIST_TAG_BANNER_TITLE`, `notificationHref("artist_tag", eventId, platform)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/search.test.ts`:

```ts
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
```

The existing `doc()` helper at the top of that file must gain `ageRestriction: "all_ages"` to its base literal so every prior case still type-checks. `savedSearchLabel` is already imported there; add `matchesFilters` and `validateSearchInput` to the import list if the file does not already carry them.

Append to `packages/shared/test/notificationHref.test.ts`:

```ts
  it("routes artist_tag to the event page on both platforms", () => {
    expect(notificationHref("artist_tag", "ev1", "web")).toBe("/e/ev1");
    expect(notificationHref("artist_tag", "ev1", "mobile")).toBe("/event/ev1");
    expect(notificationHref("artist_tag", null, "web")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @gatekeep/shared test`
Expected: FAIL on the unknown `allAges` filter key, the missing `ageRestriction` field, and `notificationHref` returning null for `artist_tag`.

- [ ] **Step 3: Types**

In `packages/shared/src/types.ts`, add above `UserDoc`:

```ts
// SP11: an event's door policy. Absent on every pre-SP11 event doc, which
// reads as "all_ages" everywhere (EventDoc.ageRestriction below).
export const AGE_RESTRICTIONS = ["all_ages", "18_plus", "21_plus"] as const;
export type AgeRestriction = (typeof AGE_RESTRICTIONS)[number];
export const AGE_RESTRICTION_LABEL: Record<AgeRestriction, string> = {
  all_ages: "All ages", "18_plus": "18+", "21_plus": "21+",
};
// SP11: doors may not open more than this far before the start time.
export const DOORS_MAX_BEFORE_START_MS = 12 * 60 * 60 * 1000;
```

`UserDoc` gains, after `homeCity`:

```ts
  // SP11: the coarsened (two decimal) centre of homeCity, geocoded and
  // written ONLY by updateAccount. Never client-writable (firestore.rules
  // drops it, along with displayName and homeCity, from the owner update
  // set). null when the city could not be geocoded, or when there is no
  // homeCity; absent on every pre-SP11 doc and read as null.
  homeGeo?: { lat: number; lng: number } | null;
```

`EventAct` becomes:

```ts
// SP11: a curator-tagged GateKeep artist on a standalone event. `name` is
// the musician profile's display name snapshotted at tag time; `status` is
// server-owned (only eventArtistTags.ts writes it). A tagged act renders as
// a plain name to the public until it is "accepted".
export type TaggedActStatus = "pending" | "accepted" | "declined";
export type EventAct =
  | { kind: "booking"; bookingId: string; musicianProfileId: string; name: string }
  | { kind: "external"; name: string }
  | {
    kind: "tagged"; musicianProfileId: string; name: string;
    status: TaggedActStatus; taggedAt: number; respondedAt: number | null;
  };
```

`EventDoc` gains, after `lineupMusicianProfileIds`:

```ts
  // SP11: optional door time (epoch ms), before startsAt and within
  // DOORS_MAX_BEFORE_START_MS of it. Absent on pre-SP11 docs, read as null.
  doorsAt?: number | null;
  // SP11: absent on pre-SP11 docs, read as "all_ages".
  ageRestriction?: AgeRestriction;
```

Update `lineupMusicianProfileIds`'s own comment to read "booking acts and ACCEPTED tagged acts" so the projection's contract is written down where it is declared.

`NotificationDoc.kind` gains `| "artist_tag"`, with the comment line:

```ts
  // SP11: "artist_tag" is a curator tagging this musician profile on an
  // event lineup; refId is the eventId, and it routes to the event page.
```

Add at the end of the SP11 block:

```ts
export interface UpdateAccountInput { displayName?: string; homeCity?: string | null }
// `geocoded` is true when a homeGeo was written, false when the geocoder
// missed (the city text is stored, homeGeo is null), and null when this call
// did not touch homeCity at all.
export interface UpdateAccountResult { ok: true; geocoded: boolean | null }
```

- [ ] **Step 4: Search filter**

In `packages/shared/src/search.ts`:

- `SearchFilters` gains `allAges?: boolean;` after `freeOnly`.
- `FACE_FILTER_KEYS.fan` becomes `["when", "genres", "freeOnly", "allAges", "nearMe"]`.
- `SearchIndexDoc` gains `ageRestriction: AgeRestriction;` after `hasFreeTier`, and the import line becomes `import { GENRES, ACT_SIZES, LAUNCH_TIMEZONE, type ActSize, type AgeRestriction } from "./types.js";`.
- `validateFilters`'s boolean case becomes:

```ts
      case "freeOnly": case "allAges": case "nearMe": case "hasAudio":
        if (typeof value !== "boolean") return fail(`Filter "${key}" must be true or false.`);
        filters[key as "freeOnly" | "allAges" | "nearMe" | "hasAudio"] = value; break;
```

- `matchesFilters` gains, immediately after the `freeOnly` line:

```ts
  if (filters.allAges && doc.ageRestriction !== "all_ages") return false;
```

- `savedSearchLabel` gains, immediately after the `freeOnly` line:

```ts
  if (allowed.includes("allAges") && filters.allAges) parts.push("All ages only");
```

- [ ] **Step 5: Messages and the notification route**

Append to `packages/shared/src/messages.ts`:

```ts
// ---------- Sub-project 11 SP7 reconciliation ----------
export const ACCOUNT_NAME_MESSAGE = "Display name must be 1 to 80 characters.";
export const ACCOUNT_CITY_MESSAGE = "Home city must be 80 characters or fewer.";
export const ACCOUNT_SAVED_MESSAGE = "Saved.";
export const ACCOUNT_NAME_HELP = "Shown on tickets you buy from now on.";
export const ACCOUNT_CITY_HELP = "Used to rank shows near you when your location is off.";
export const ACCOUNT_GEOCODE_MISS_MESSAGE = "We could not place that city; ranking will not use it.";
export const EVENT_DOORS_MESSAGE = "Doors must be before the start time and within 12 hours of it.";
export const EVENT_AGE_MESSAGE = "Pick an age restriction.";
export const ARTIST_TAG_DUPLICATE_MESSAGE = "That artist is already on the lineup.";
export const ARTIST_TAG_UNAPPROVED_MESSAGE = "Only approved artists can be tagged.";
export const ARTIST_TAG_ANSWERED_MESSAGE = "This tag has already been answered.";
// Refusal for an updateEvent payload inventing a tagged act the server has
// never seen: tags are created only by tagEventArtist.
export const ARTIST_TAG_UNKNOWN_MESSAGE = "Tag artists from the lineup editor.";
export const ARTIST_TAG_BANNER_TITLE = "You were tagged on this lineup";
export const SHARE_LINK_COPIED_MESSAGE = "Link copied";
export const HOME_CITY_PROMPT_LINE = "Or set a home city under Account.";
```

In `packages/shared/src/notificationHref.ts`, extend the existing three-event-kind branch and its comment:

```ts
  // SP11: artist_tag carries the eventId in refId and opens the event page,
  // where the tagged artist's admins see the accept and decline banner.
  if (kind === "show_announced" || kind === "show_rescheduled" || kind === "show_post" || kind === "artist_tag") {
    return refId ? (platform === "web" ? `/e/${refId}` : `/event/${refId}`) : null;
  }
```

- [ ] **Step 6: Run, typecheck, build, commit**

Run: `pnpm --filter @gatekeep/shared test` (PASS, every prior case too), then `pnpm typecheck` and `pnpm --filter @gatekeep/shared build`.

```bash
git add packages/shared
git commit -m "feat(shared): doors, age restriction, tagged lineup acts, homeGeo, the allAges filter, and sub-11 messages"
```

---

### Task 2: Rules and the rules matrix

**Files:**
- Modify: `firestore.rules`
- Test: `tests-rules/reconciliation.rules.test.ts` (new)

**Interfaces:**
- Produces: the `users/{uid}` owner update set narrowed to `['photoUrl']`, which is what makes `updateAccount` (Task 3) the only writer of `displayName`, `homeCity`, and `homeGeo`.

- [ ] **Step 1: Write the failing rules test**

Create `tests-rules/reconciliation.rules.test.ts`:

```ts
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, setDoc, updateDoc } from "firebase/firestore";

// Sub-project 11 rules matrix: the users/{uid} owner update keeps photoUrl
// and loses displayName, homeCity, and homeGeo (updateAccount owns all
// three); events stay callable-only, tagged lineup acts included.

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

const seedUser = () => seed("users/bob", {
  displayName: "Bob", email: "bob@test.com", photoUrl: null,
  homeCity: "Austin", homeGeo: { lat: 30.27, lng: -97.74 }, createdAt: 1,
});

describe("users/{uid} owner update", () => {
  it("still writes photoUrl", async () => {
    await seedUser();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(updateDoc(doc(bob, "users/bob"), { photoUrl: "https://example.com/a.jpg" }));
    await assertSucceeds(updateDoc(doc(bob, "users/bob"), { photoUrl: null }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { photoUrl: "http://example.com/a.jpg" }));
  });
  it("cannot write displayName, homeCity, or homeGeo, alone or alongside photoUrl", async () => {
    await seedUser();
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(updateDoc(doc(bob, "users/bob"), { displayName: "Bobby" }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeCity: "Dallas" }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeCity: null }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeGeo: { lat: 1, lng: 2 } }));
    await assertFails(updateDoc(doc(bob, "users/bob"),
      { photoUrl: "https://example.com/a.jpg", displayName: "Bobby" }));
    const carol = env.authenticatedContext("carol").firestore();
    await assertFails(updateDoc(doc(carol, "users/bob"), { photoUrl: "https://example.com/a.jpg" }));
  });
});

describe("events with a tagged lineup act", () => {
  it("stay world-readable when published and client-unwritable", async () => {
    await seed("events/ev1", {
      curatorProfileId: "cur1", title: "Tagged night", status: "published",
      lineup: [{ kind: "tagged", musicianProfileId: "mus1", name: "The Act", status: "pending", taggedAt: 1, respondedAt: null }],
      lineupMusicianProfileIds: [], startsAt: 2, endsAt: 3,
      ageRestriction: "18_plus", doorsAt: 1,
    });
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(updateDoc(doc(bob, "events/ev1"), {
      lineup: [{ kind: "tagged", musicianProfileId: "mus1", name: "The Act", status: "accepted", taggedAt: 1, respondedAt: 2 }],
    }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm emu:rules`
Expected: FAIL, the three "cannot write" assertions succeed today because `displayName` and `homeCity` are still in the allowed set.

- [ ] **Step 3: Narrow the rule**

In `firestore.rules`, replace the whole `users/{uid}` `allow update` block with:

```
      // Created by Cloud Functions; the owner may update photoUrl only.
      // SP11: displayName, homeCity, and homeGeo left this set. All three
      // are written exclusively by the updateAccount callable, which trims
      // and length-checks the name and the city and is the only thing that
      // may geocode a city into homeGeo (server-coarsened to two decimals).
      // A client that could still write homeCity would leave homeGeo
      // pointing at a city the user no longer lives in.
      allow update: if isOwner(uid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['photoUrl'])
        && (request.resource.data.get('photoUrl', null) == null
            || (request.resource.data.get('photoUrl', null) is string
                && request.resource.data.get('photoUrl', null).matches('^https://.*')
                && request.resource.data.get('photoUrl', null).size() <= 500));
      allow create, delete: if false;
```

- [ ] **Step 4: Run and commit**

Run: `pnpm emu:rules`
Expected: PASS, the previous total plus 3.

```bash
git add firestore.rules tests-rules/reconciliation.rules.test.ts
git commit -m "feat: narrow the users owner update to photoUrl, add the sub-11 rules matrix"
```

---

### Task 3: `updateAccount`

**Files:**
- Modify: `functions/src/account.ts`, `functions/src/index.ts`
- Test: `functions/test/updateAccount.test.ts` (new)

**Interfaces:**
- Consumes: `requireAuthUid`, `requireVerifiedEmail` from `./guards.js`; `getGeocoder`, `coarsen`, `consumeGeocodeBudget`, `geocoderApiKey` from `./geocode.js`; `ACCOUNT_NAME_MESSAGE`, `ACCOUNT_CITY_MESSAGE`, `UpdateAccountInput`, `UpdateAccountResult` from shared (Task 1).
- Produces: the callable `updateAccount(UpdateAccountInput): UpdateAccountResult`, exported from `functions/src/index.ts`. Tasks 9 and 13 call it; Tasks 8 and 13 read the `homeGeo` it writes.

- [ ] **Step 1: Write the failing test**

Create `functions/test/updateAccount.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";
import type { UpdateAccountResult, UserDoc, GetDiscoverDeckInput, GetDiscoverDeckResult } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

const userDoc = async (uid: string) => (await adb.doc(`users/${uid}`).get()).data() as UserDoc;

describe("updateAccount", () => {
  it("saves a name and a geocoded city, coarsens the point, and clears both", async () => {
    const u = await signUpTestUser(`ua1-${Date.now()}@test.com`);
    const res = await callFn<object, UpdateAccountResult>(
      "updateAccount", { displayName: "  Bobby Tables  ", homeCity: "Austin, TX" }, u.user);
    expect(res).toMatchObject({ ok: true, geocoded: true });
    const after = await userDoc(u.uid);
    expect(after.displayName).toBe("Bobby Tables");
    expect(after.homeCity).toBe("Austin, TX");
    expect(after.homeGeo).not.toBeNull();
    // coarsen() rounds to two decimals, so 100 * value is a whole number.
    expect(Number.isInteger(Math.round(after.homeGeo!.lat * 100))).toBe(true);
    expect(after.homeGeo!.lat).toBe(Math.round(after.homeGeo!.lat * 100) / 100);
    expect(after.homeGeo!.lng).toBe(Math.round(after.homeGeo!.lng * 100) / 100);

    // A name-only save leaves the city and the point alone.
    expect(await callFn<object, UpdateAccountResult>("updateAccount", { displayName: "Bob" }, u.user))
      .toMatchObject({ ok: true, geocoded: null });
    const nameOnly = await userDoc(u.uid);
    expect(nameOnly.displayName).toBe("Bob");
    expect(nameOnly.homeGeo).toEqual(after.homeGeo);

    // null clears both; "" does the same.
    expect(await callFn<object, UpdateAccountResult>("updateAccount", { homeCity: null }, u.user))
      .toMatchObject({ ok: true, geocoded: null });
    const cleared = await userDoc(u.uid);
    expect(cleared.homeCity).toBeNull();
    expect(cleared.homeGeo).toBeNull();
  });

  it("refuses a blank or overlong name and an overlong city, and refuses signed-out callers", async () => {
    const u = await signUpTestUser(`ua2-${Date.now()}@test.com`);
    await expect(callFn("updateAccount", { displayName: "   " }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Display name must be 1 to 80 characters." });
    await expect(callFn("updateAccount", { displayName: "x".repeat(81) }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { displayName: 5 }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { homeCity: "x".repeat(81) }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Home city must be 80 characters or fewer." });
    await expect(callFn("updateAccount", { homeCity: 5 }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { displayName: "Nobody" })).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("charges the geocode budget only when it geocodes, and refuses past the daily ceiling", async () => {
    const u = await signUpTestUser(`ua3-${Date.now()}@test.com`);
    const dateKey = new Date().toISOString().slice(0, 10);
    await callFn("updateAccount", { homeCity: "Austin, TX" }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()).toMatchObject({ date: dateKey, count: 1 });
    await callFn("updateAccount", { displayName: "No geocode here" }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()?.count).toBe(1);
    await callFn("updateAccount", { homeCity: null }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()?.count).toBe(1);
    await adb.doc(`geocodeBudgets/${u.uid}`).set({ date: dateKey, count: 50 });
    await expect(callFn("updateAccount", { homeCity: "Dallas, TX" }, u.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });

  it("hands the stored homeGeo straight to getDiscoverDeck", async () => {
    const u = await signUpTestUser(`ua4-${Date.now()}@test.com`);
    await callFn("updateAccount", { homeCity: "Austin, TX" }, u.user);
    const homeGeo = (await userDoc(u.uid)).homeGeo!;
    const deck = await callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>(
      "getDiscoverDeck", { location: homeGeo }, u.user);
    expect(Array.isArray(deck.cards)).toBe(true);
    for (const card of deck.cards) {
      if (card.kind === "show" || card.kind === "venue") {
        expect(card.distanceMeters === null || typeof card.distanceMeters === "number").toBe(true);
      }
    }
    await expect(callFn("getDiscoverDeck", { location: { lat: 200, lng: 0 } }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/updateAccount.test.ts"`
Expected: FAIL with "NOT_FOUND" / "not-found" for the `updateAccount` callable.

- [ ] **Step 3: Implement**

In `functions/src/account.ts`, add the imports:

```ts
import {
  ACCOUNT_NAME_MESSAGE, ACCOUNT_CITY_MESSAGE,
  type UpdateAccountInput, type UpdateAccountResult,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { getGeocoder, coarsen, consumeGeocodeBudget, geocoderApiKey } from "./geocode.js";
```

(the existing `@gatekeep/shared` import in this file gains the two message constants and the two types rather than a second import statement.)

Add at the end of the file:

```ts
// SP11 (spec section 5): the ONLY writer of users/{uid}.displayName,
// .homeCity, and .homeGeo. firestore.rules dropped all three from the
// owner's own update set in the same sub-project, so a client cannot set a
// city without the coarse point that ranks its Discover feed, and cannot set
// a point at all.
//
// displayName is stamped as given (after trim); displayNameLower is left to
// the onUserDocWritten trigger, which is already the single writer of that
// projection. Existing tickets and attendee rows keep the name they
// snapshotted; nothing is backfilled (spec section 3.3), and the account
// editors on both clients say so in their helper copy.
//
// The geocode is charged to consumeGeocodeBudget BEFORE the provider call,
// the same order every other address-resolving callable uses, and only when
// a non-empty city is actually being resolved: a name-only save and a clear
// never touch the budget. A geocoder MISS is not an error: the city text is
// what the fan typed and is worth keeping on screen, so it is stored with
// homeGeo null and reported as { geocoded: false } so the client can say
// ACCOUNT_GEOCODE_MISS_MESSAGE.
export const updateAccount = onCall<UpdateAccountInput>(
  { region: "us-central1", secrets: [geocoderApiKey] }, async (req): Promise<UpdateAccountResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = (req.data ?? {}) as UpdateAccountInput;
    const updates: Record<string, unknown> = {};

    if (input.displayName !== undefined) {
      if (typeof input.displayName !== "string") throw new HttpsError("invalid-argument", ACCOUNT_NAME_MESSAGE);
      const name = input.displayName.trim();
      if (name.length < 1 || name.length > 80) throw new HttpsError("invalid-argument", ACCOUNT_NAME_MESSAGE);
      updates.displayName = name;
    }

    let geocoded: boolean | null = null;
    if (input.homeCity !== undefined) {
      if (input.homeCity !== null && typeof input.homeCity !== "string") {
        throw new HttpsError("invalid-argument", ACCOUNT_CITY_MESSAGE);
      }
      const city = (input.homeCity ?? "").trim();
      if (city.length > 80) throw new HttpsError("invalid-argument", ACCOUNT_CITY_MESSAGE);
      if (city.length === 0) {
        updates.homeCity = null;
        updates.homeGeo = null;
      } else {
        await consumeGeocodeBudget(uid);
        let point: { lat: number; lng: number } | null = null;
        try {
          const hit = await getGeocoder().geocode(city);
          if (hit) point = coarsen(hit);
        } catch (e) {
          // A provider outage must not lose the fan's typed city. Same
          // posture as the miss below: store the text, no point.
          console.error("updateAccount: geocode failed", { uid }, e);
        }
        updates.homeCity = city;
        updates.homeGeo = point;
        geocoded = point !== null;
      }
    }

    if (Object.keys(updates).length === 0) return { ok: true, geocoded: null };
    await getFirestore().doc(`users/${uid}`).update(updates);
    return { ok: true, geocoded };
  });
```

In `functions/src/index.ts` change the account export line to:

```ts
export { deleteAccount, updateAccount } from "./account.js";
```

- [ ] **Step 4: Run the test and its neighbours**

Run the command from Step 2 again: PASS.
Then run `test/account.test.ts` (or whichever file covers `deleteAccount`: `grep -l deleteAccount functions/test/*.ts`) with the same command shape: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add functions/src/account.ts functions/src/index.ts functions/test/updateAccount.test.ts
git commit -m "feat(functions): updateAccount writes display name, home city, and the coarsened home point"
```

---

### Task 4: Doors and age on events

**Files:**
- Modify: `functions/src/eventsCore.ts`, `functions/src/events.ts`
- Test: `functions/test/eventFields.test.ts` (new)

**Interfaces:**
- Consumes: `AgeRestriction`, `AGE_RESTRICTIONS`, `DOORS_MAX_BEFORE_START_MS`, `EVENT_DOORS_MESSAGE`, `EVENT_AGE_MESSAGE` from shared (Task 1).
- Produces: `validateEventInput` accepting `doorsAt?: number | null` and `ageRestriction?: AgeRestriction`; `CreateEventInput` and `UpdateEventInput` carrying both; `EventDoc.doorsAt`/`ageRestriction` persisted by both write paths. Task 5 extends the same validator with the `tagged` act kind; Task 6 projects `ageRestriction` into the search index; Tasks 10, 11, 14, and 15 send and render both fields.

- [ ] **Step 1: Write the failing test**

Create `functions/test/eventFields.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeApprovedCuratorProfile, eventContent, addTiersAndPublish } from "./discoverFixtures";
import type { EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const HOUR = 3_600_000;
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;

describe("doors and age on createEvent", () => {
  it("stores both, defaults age to all_ages and doors to null, and refuses bad values", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ef1", "venue");
    const base = eventContent();
    const startsAt = base.startsAt as number;

    const created = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" }, ...base,
      doorsAt: startsAt - HOUR, ageRestriction: "21_plus",
    }, owner.user);
    expect(await event(created.eventId)).toMatchObject({ doorsAt: startsAt - HOUR, ageRestriction: "21_plus" });

    const plain = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base }, owner.user);
    expect(await event(plain.eventId)).toMatchObject({ doorsAt: null, ageRestriction: "all_ages" });

    for (const doorsAt of [startsAt, startsAt + 1, startsAt - 13 * HOUR, "soon", 1.5]) {
      await expect(callFn("createEvent",
        { curatorProfileId: profileId, source: { kind: "standalone" }, ...base, doorsAt }, owner.user))
        .rejects.toMatchObject({
          code: "functions/invalid-argument",
          message: "Doors must be before the start time and within 12 hours of it.",
        });
    }
    // The 12-hour bound is inclusive at exactly 12 hours.
    const edge = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" }, ...base, doorsAt: startsAt - 12 * HOUR,
    }, owner.user);
    expect((await event(edge.eventId)).doorsAt).toBe(startsAt - 12 * HOUR);

    await expect(callFn("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base, ageRestriction: "18" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Pick an age restriction." });
  });
});

describe("doors and age on updateEvent", () => {
  it("saves both, clears doors with null, and a doors-only change does not reschedule", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ef2", "venue");
    const base = eventContent();
    const startsAt = base.startsAt as number;
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base }, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);

    const payload = {
      curatorProfileId: profileId, eventId,
      title: base.title, description: base.description, startsAt, endsAt: base.endsAt,
      lineup: base.lineup,
    };
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - 2 * HOUR, ageRestriction: "18_plus" }, owner.user);
    expect(await event(eventId)).toMatchObject({ doorsAt: startsAt - 2 * HOUR, ageRestriction: "18_plus" });

    // A doors-only edit must not tell followers or ticket holders the show moved.
    const before = await adb.collection(`users/${owner.uid}/notifications`).get();
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - 3 * HOUR, ageRestriction: "18_plus" }, owner.user);
    const after = await adb.collection(`users/${owner.uid}/notifications`).get();
    expect(after.size).toBe(before.size);
    expect(after.docs.some((d) => d.id === `resched:${eventId}:${startsAt}`)).toBe(false);

    await callFn("updateEvent", { ...payload, doorsAt: null }, owner.user);
    expect(await event(eventId)).toMatchObject({ doorsAt: null, ageRestriction: "all_ages" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/eventFields.test.ts"`
Expected: FAIL, `doorsAt` and `ageRestriction` are absent on the stored doc and the bad values are accepted.

- [ ] **Step 3: Validate in `eventsCore.ts`**

Widen the import and the signature of `validateEventInput`:

```ts
import {
  DEFAULT_TICKET_FEE_POLICY, GENRES, AGE_RESTRICTIONS, DOORS_MAX_BEFORE_START_MS,
  EVENT_DOORS_MESSAGE, EVENT_AGE_MESSAGE,
  type AgeRestriction, type EventAct, type TicketFeePolicy, type TicketOrderItem, type TicketTierDoc,
} from "@gatekeep/shared";

export function validateEventInput(input: {
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[];
  doorsAt?: number | null; ageRestriction?: AgeRestriction;
}): void {
```

Add, immediately after the `maxTicketsPerBuyer` block at the end of the function:

```ts
  // SP11: doors is optional (absent or null means "not published"), a whole
  // number of ms strictly before startsAt and no more than
  // DOORS_MAX_BEFORE_START_MS ahead of it. One message for every failure
  // shape: a fan-facing form has one field here, so splitting "not a number"
  // from "too early" would only make the client match two strings.
  if (input.doorsAt !== undefined && input.doorsAt !== null) {
    const doorsAt = input.doorsAt;
    if (typeof doorsAt !== "number" || !Number.isInteger(doorsAt)
        || doorsAt >= input.startsAt || input.startsAt - doorsAt > DOORS_MAX_BEFORE_START_MS) {
      throw new HttpsError("invalid-argument", EVENT_DOORS_MESSAGE);
    }
  }
  if (input.ageRestriction !== undefined
      && !(AGE_RESTRICTIONS as readonly string[]).includes(input.ageRestriction)) {
    throw new HttpsError("invalid-argument", EVENT_AGE_MESSAGE);
  }
```

- [ ] **Step 4: Persist in `events.ts`**

Add `doorsAt?: number | null; ageRestriction?: AgeRestriction;` to both `CreateEventInput` and `UpdateEventInput`, and add `type AgeRestriction` to this file's shared import list.

In `createEvent`, the `event` literal gains, after `gigId, createdAt: now, updatedAt: now,`:

```ts
      doorsAt: input.doorsAt ?? null, ageRestriction: input.ageRestriction ?? "all_ages",
```

In `updateEvent`, the `eventRef.update({ ... })` call gains, after `posterPath, updatedAt: Date.now(),`:

```ts
    // Full-replace, like every other field on this callable: an omitted
    // doorsAt clears the door time and an omitted ageRestriction returns the
    // event to all ages, so the editors on both clients always resend both.
    doorsAt: input.doorsAt ?? null, ageRestriction: input.ageRestriction ?? "all_ages",
```

Nothing else in `updateEvent` changes: the `rescheduled` predicate already compares `startsAt` at minute granularity only (`sp7-rulings.md` ruling 15), so a doors-only edit fires no fan-out, which is exactly the spec's rule and what Step 1's test asserts.

- [ ] **Step 5: Run the new file and the events suites**

Run the Step 2 command for `test/eventFields.test.ts`: PASS.
Then run, one at a time with the same command shape, `test/events.test.ts` and `test/eventsCore.test.ts` (confirm the real names with `ls functions/test | grep -i event`): PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add functions/src/eventsCore.ts functions/src/events.ts functions/test/eventFields.test.ts
git commit -m "feat(functions): optional doors time and an age restriction on events"
```

---

### Task 5: Artist tags on standalone events

**Files:**
- Create: `functions/src/eventArtistTags.ts`
- Modify: `functions/src/eventsCore.ts`, `functions/src/events.ts`, `functions/src/announce.ts`, `functions/src/index.ts`
- Test: `functions/test/eventArtistTags.test.ts` (new)

**Interfaces:**
- Consumes: `requireAuthUid`, `requireVerifiedEmail`, `requireProfileMember` from `./guards.js`; `requireProfileAdmin` from `./profiles.js`; `notifyProfileAdmins` from `./notifications.js`; `notifyFollowers` from `./follows.js`; `showAnnouncedNote` from `./announce.js`; the four `ARTIST_TAG_*` messages and `TaggedActStatus` from shared (Task 1).
- Produces: `tagEventArtist({ curatorProfileId, eventId, musicianProfileId }): { actIndex: number }`, `untagEventArtist({ curatorProfileId, eventId, musicianProfileId }): { ok: true }`, `respondToArtistTag({ eventId, musicianProfileId, accept }): { ok: true; status: TaggedActStatus }`, `reconcileTaggedActs(stored, incoming): EventAct[]`, `notifyPendingTags(db, eventId, event)`. Tasks 10, 11, 14, and 15 call the three callables; Task 6 relies on accepted tags reaching `lineupMusicianProfileIds`.

- [ ] **Step 1: Write the failing test**

Create `functions/test/eventArtistTags.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import {
  adb, makeApprovedCuratorProfile, makeApprovedMusicianProfile, makeDraftEvent,
  addTiersAndPublish, eventContent, waitForIndex,
} from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import type { EventDoc, EventAct, NotificationDoc, SearchIndexDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const taggedAct = async (eventId: string, musicianProfileId: string) =>
  (await event(eventId)).lineup.find(
    (a): a is Extract<EventAct, { kind: "tagged" }> => a.kind === "tagged" && a.musicianProfileId === musicianProfileId);
const notes = async (uid: string, kind: string) =>
  (await adb.collection(`users/${uid}/notifications`).where("kind", "==", kind).get()).docs
    .map((d) => d.data() as NotificationDoc);

describe("tagEventArtist", () => {
  it("tags on a draft silently, notifies once on publish, and the artist accepts", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at1");
    const artist = await makeApprovedMusicianProfile("at1m");

    const { actIndex } = await callFn<Record<string, unknown>, { actIndex: number }>(
      "tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    expect(actIndex).toBe(1);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({
      kind: "tagged", musicianProfileId: artist.profileId, name: "The Act", status: "pending", respondedAt: null,
    });
    // A draft tag is silent, and the pending act is not in the projection.
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(0);
    expect((await event(eventId)).lineupMusicianProfileIds).not.toContain(artist.profileId);

    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const sent = await notes(artist.owner.uid, "artist_tag");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "You were tagged on a lineup", refId: eventId });
    expect(sent[0].body).toContain("tagged you on");
    expect((await adb.doc(`users/${artist.owner.uid}/notifications/artist_tag:${eventId}:${artist.profileId}`).get()).exists).toBe(true);

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const accepted = await event(eventId);
    expect(accepted.lineupMusicianProfileIds).toContain(artist.profileId);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({ status: "accepted" });
    expect((await taggedAct(eventId, artist.profileId))!.respondedAt).toBeTypeOf("number");
    // The accepted act reaches the search index through the event trigger.
    const indexed = await waitForIndex(`show_${eventId}`, (d) => !!d?.relatedProfileIds.includes(artist.profileId));
    expect(indexed?.relatedProfileIds).toContain(artist.profileId);
    // A second publish attempt cannot double-send announce or the tag note.
    await expect(callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(1);
    await expect(callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This tag has already been answered." });
  });

  it("tags a published event immediately, and accept announces to that artist's followers once", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at2");
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const artist = await makeApprovedMusicianProfile("at2m");
    const fan = await signUpTestUser(`at2f-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: artist.profileId, targetType: "musician" }, fan.user);

    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(1);
    expect(await notes(fan.uid, "show_announced")).toHaveLength(0);

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const announced = await notes(fan.uid, "show_announced");
    expect(announced).toHaveLength(1);
    expect(announced[0].refId).toBe(eventId);
    expect((await adb.doc(`users/${fan.uid}/notifications/announce:${eventId}`).get()).exists).toBe(true);
  });

  it("declines, untags, and refuses non-admins, unapproved artists, duplicates, and the cap", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at3");
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const artist = await makeApprovedMusicianProfile("at3m");
    const stranger = await signUpTestUser(`at3s-${Date.now()}@test.com`);

    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    const draftArtist = await makeApprovedCuratorProfile("at3c", "venue");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: draftArtist.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Only approved artists can be tagged." });

    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "That artist is already on the lineup." });

    await expect(callFn("respondToArtistTag",
      { eventId, musicianProfileId: artist.profileId, accept: true }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: false }, artist.owner.user);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({ status: "declined" });
    expect((await event(eventId)).lineupMusicianProfileIds).not.toContain(artist.profileId);

    // Untag turns the act into a plain external name and drops the id.
    const second = await makeApprovedMusicianProfile("at3n");
    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    await callFn("respondToArtistTag", { eventId, musicianProfileId: second.profileId, accept: true }, second.owner.user);
    expect((await event(eventId)).lineupMusicianProfileIds).toContain(second.profileId);
    await callFn("untagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    const untagged = await event(eventId);
    expect(untagged.lineupMusicianProfileIds).not.toContain(second.profileId);
    expect(untagged.lineup.some((a) => a.kind === "external" && a.name === "The Act")).toBe(true);

    // The 20-act cap is the same one validateEventInput enforces.
    await adb.doc(`events/${eventId}`).update({
      lineup: Array.from({ length: 20 }, (_, i) => ({ kind: "external", name: `Filler ${i}` })),
    });
    const third = await makeApprovedMusicianProfile("at3t");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: third.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("lets a tagged artist post only after accepting, and a co-admin answer counts", async () => {
    const { curator, musician, eventId } = await makePublishedTaggedEvent("at4");
    await expect(callFn("createShowPost",
      { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const coAdmin = await addMember(musician.profileId, "at4a", "admin");
    await callFn("respondToArtistTag", { eventId, musicianProfileId: musician.profileId, accept: true }, coAdmin.user);
    const { postId } = await callFn<Record<string, unknown>, { postId: string }>(
      "createShowPost", { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user);
    expect(postId).toBeTypeOf("string");
    expect(curator.profileId).toBeTypeOf("string");
  });

  it("keeps a stored tag's status when the curator resaves the lineup, and refuses an invented one", async () => {
    const { curator, musician, eventId } = await makePublishedTaggedEvent("at5");
    await callFn("respondToArtistTag", { eventId, musicianProfileId: musician.profileId, accept: true }, musician.owner.user);
    const stored = await event(eventId);
    const forged = stored.lineup.map((a) => a.kind === "tagged"
      ? { ...a, status: "accepted", name: "Renamed", taggedAt: 1, respondedAt: 1 } : a);
    await callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: forged,
    }, curator.owner.user);
    // Name, taggedAt, respondedAt and status all come from the server copy.
    expect(await taggedAct(eventId, musician.profileId)).toMatchObject({ name: "The Act", taggedAt: stored.lineup.find((a) => a.kind === "tagged")!.taggedAt });

    const other = await makeApprovedMusicianProfile("at5o");
    await expect(callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: [...stored.lineup, {
        kind: "tagged", musicianProfileId: other.profileId, name: "Sneaky",
        status: "accepted", taggedAt: Date.now(), respondedAt: Date.now(),
      }],
    }, curator.owner.user)).rejects.toMatchObject({
      code: "functions/invalid-argument", message: "Tag artists from the lineup editor.",
    });

    // Dropping the act from the payload removes it and its projection id.
    await callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: stored.lineup.filter((a) => a.kind !== "tagged"),
    }, curator.owner.user);
    const after = await event(eventId);
    expect(after.lineupMusicianProfileIds).not.toContain(musician.profileId);
    expect(after.lineup.some((a) => a.kind === "tagged")).toBe(false);
  });
});

// Local to this file only because it composes exported fixtures; if a later
// task needs it, move it to discoverFixtures.ts rather than importing here.
async function makePublishedTaggedEvent(prefix: string) {
  const curator = await makeApprovedCuratorProfile(prefix, "venue");
  const created = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
    { curatorProfileId: curator.profileId, source: { kind: "standalone" }, ...eventContent() }, curator.owner.user);
  await addTiersAndPublish(curator.profileId, created.eventId, curator.owner.user, FREE_TIER);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await callFn("tagEventArtist",
    { curatorProfileId: curator.profileId, eventId: created.eventId, musicianProfileId: musician.profileId },
    curator.owner.user);
  return { curator, musician, eventId: created.eventId };
}
```

Note for the implementer: `SearchIndexDoc` is imported for the `waitForIndex` callback's type; remove any import the final file does not use so lint stays at zero.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/eventArtistTags.test.ts"`
Expected: FAIL, the three callables do not exist.

- [ ] **Step 3: Accept the `tagged` act shape in `eventsCore.ts`**

Replace the act loop inside `validateEventInput` with:

```ts
  for (const act of input.lineup) {
    if (typeof act !== "object" || act === null
        || (act.kind !== "booking" && act.kind !== "external" && act.kind !== "tagged")) {
      throw new HttpsError("invalid-argument", "Invalid lineup act.");
    }
    if (typeof act.name !== "string" || act.name.trim().length < 1 || act.name.trim().length > 80) {
      throw new HttpsError("invalid-argument", "Act names must be 1-80 characters.");
    }
    // SP11: a "tagged" act's status, taggedAt and respondedAt are server
    // state. This only checks the shape is well formed; events.ts's
    // reconcileTaggedActs is what refuses a payload that invents an act or
    // rewrites a stored one's status.
    if (act.kind === "tagged" && !isValidDocId(act.musicianProfileId)) {
      throw new HttpsError("invalid-argument", "Invalid lineup act.");
    }
  }
```

Add `isValidDocId` to this file's `@gatekeep/shared` import list.

- [ ] **Step 4: Write `functions/src/eventArtistTags.ts`**

```ts
/**
 * SP11 (spec section 3.5 and 5): curator-tagged GateKeep artists on events
 * that are not tied to a booking. This file is the ONLY writer of a lineup
 * act's `kind: "tagged"` entry: events.ts's update path preserves what it
 * finds here (reconcileTaggedActs) and never accepts a new one from a
 * client, so a curator cannot fabricate "X plays our venue" on X's own
 * public page, which is exactly the guarantee verifyLineupBookingActs gives
 * booking acts.
 *
 * The public rendering rule the clients implement: a tagged act reads as a
 * plain name until it is "accepted"; only an accepted act joins
 * lineupMusicianProfileIds and therefore the artist page, the search index,
 * show posts, and the reschedule fan-out.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  isValidDocId, ARTIST_TAG_DUPLICATE_MESSAGE, ARTIST_TAG_UNAPPROVED_MESSAGE,
  ARTIST_TAG_ANSWERED_MESSAGE, ARTIST_TAG_UNKNOWN_MESSAGE,
  type EventAct, type EventDoc, type ProfileDoc, type TaggedActStatus,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileAdmins } from "./notifications.js";
import { notifyFollowers } from "./follows.js";
import { artistTagNote, showAnnouncedNote } from "./announce.js";

const MAX_LINEUP_ACTS = 20;

type TaggedAct = Extract<EventAct, { kind: "tagged" }>;

export const artistTagDedupeKey = (eventId: string, musicianProfileId: string) =>
  `artist_tag:${eventId}:${musicianProfileId}`;

function taggedIn(lineup: EventAct[], musicianProfileId: string): TaggedAct | undefined {
  return lineup.find((a): a is TaggedAct => a.kind === "tagged" && a.musicianProfileId === musicianProfileId);
}

function alreadyOnLineup(lineup: EventAct[], musicianProfileId: string): boolean {
  return lineup.some((a) =>
    (a.kind === "booking" || a.kind === "tagged") && a.musicianProfileId === musicianProfileId);
}

// EventDoc.lineupMusicianProfileIds: booking acts plus ACCEPTED tagged acts.
// Kept here rather than in events.ts because both files derive it now and
// this one owns the tagged half of the rule.
export function deriveLineupMusicianProfileIds(lineup: EventAct[]): string[] {
  const ids = new Set<string>();
  for (const act of lineup) {
    if (act.kind === "booking") ids.add(act.musicianProfileId);
    if (act.kind === "tagged" && act.status === "accepted") ids.add(act.musicianProfileId);
  }
  return [...ids];
}

// updateEvent replaces the lineup wholesale, so an incoming payload carries
// the tagged acts the editor last read. Every tagged entry is replaced by the
// SERVER's own copy (status, name, taggedAt, respondedAt), and an entry the
// server has never seen is refused: tags are created only by
// tagEventArtist. An omitted entry is a removal, which is the existing
// lineup edit path and needs no special handling here.
export function reconcileTaggedActs(stored: EventAct[], incoming: EventAct[]): EventAct[] {
  return incoming.map((act) => {
    if (act.kind !== "tagged") return act;
    const known = taggedIn(stored, act.musicianProfileId);
    if (!known) throw new HttpsError("invalid-argument", ARTIST_TAG_UNKNOWN_MESSAGE);
    return known;
  });
}

async function loadOwnedEvent(
  db: Firestore, curatorProfileId: string, eventId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; event: EventDoc }> {
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = snap.data() as EventDoc;
  if (event.curatorProfileId !== curatorProfileId) {
    throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
  }
  if (event.status !== "draft" && event.status !== "published") {
    throw new HttpsError("failed-precondition", `Cannot change the lineup of an event in status "${event.status}".`);
  }
  return { ref, event };
}

// Post-commit and best-effort, the repo's fan-out posture: the tag is
// already written, so a notify failure must never surface as an error on it.
async function tellTaggedAdmins(
  eventId: string, event: EventDoc, curatorName: string, musicianProfileId: string,
): Promise<void> {
  try {
    await notifyProfileAdmins(musicianProfileId,
      artistTagNote(eventId, event, curatorName), artistTagDedupeKey(eventId, musicianProfileId));
  } catch (e) {
    console.error(`artist tag: notify failed for event ${eventId} artist ${musicianProfileId}`, e);
  }
}

// publishEvent's hook: every act still "pending" at publish time hears about
// it now, under the same per-artist key a publish-time tag already used, so
// a tag made while the event was published and a later publish (of a
// re-drafted event) can never double-send.
export async function notifyPendingTags(db: Firestore, eventId: string, event: EventDoc): Promise<void> {
  const pending = (event.lineup ?? []).filter((a): a is TaggedAct => a.kind === "tagged" && a.status === "pending");
  if (pending.length === 0) return;
  const curatorName = ((await db.doc(`profiles/${event.curatorProfileId}`).get()).data() as ProfileDoc | undefined)?.name
    ?? "A GateKeep organizer";
  for (const act of pending) await tellTaggedAdmins(eventId, event, curatorName, act.musicianProfileId);
}

export const tagEventArtist = onCall<{ curatorProfileId: string; eventId: string; musicianProfileId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { curatorProfileId, eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(curatorProfileId) || !isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile, an event, and an artist are required.");
    }
    await requireProfileAdmin(curatorProfileId, uid);

    const db = getFirestore();
    const { ref, event } = await loadOwnedEvent(db, curatorProfileId, eventId);
    const artistSnap = await db.doc(`profiles/${musicianProfileId}`).get();
    const artist = artistSnap.data() as ProfileDoc | undefined;
    if (!artist || artist.type !== "musician" || artist.status !== "approved") {
      throw new HttpsError("failed-precondition", ARTIST_TAG_UNAPPROVED_MESSAGE);
    }

    const now = Date.now();
    const actIndex = await db.runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as EventDoc | undefined;
      if (!fresh) throw new HttpsError("not-found", "Event not found.");
      const lineup = fresh.lineup ?? [];
      if (alreadyOnLineup(lineup, musicianProfileId)) {
        throw new HttpsError("failed-precondition", ARTIST_TAG_DUPLICATE_MESSAGE);
      }
      if (lineup.length >= MAX_LINEUP_ACTS) {
        throw new HttpsError("failed-precondition", `Lineup must have 1-${MAX_LINEUP_ACTS} acts.`);
      }
      const act: TaggedAct = {
        kind: "tagged", musicianProfileId, name: artist.name,
        status: "pending", taggedAt: now, respondedAt: null,
      };
      const next = [...lineup, act];
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
      return next.length - 1;
    });

    // A draft tag stays silent; publishEvent's notifyPendingTags tells them.
    if (event.status === "published") {
      const curatorName = ((await db.doc(`profiles/${curatorProfileId}`).get()).data() as ProfileDoc | undefined)?.name
        ?? "A GateKeep organizer";
      await tellTaggedAdmins(eventId, event, curatorName, musicianProfileId);
    }
    return { actIndex };
  });

export const untagEventArtist = onCall<{ curatorProfileId: string; eventId: string; musicianProfileId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { curatorProfileId, eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(curatorProfileId) || !isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile, an event, and an artist are required.");
    }
    await requireProfileAdmin(curatorProfileId, uid);
    const db = getFirestore();
    const { ref } = await loadOwnedEvent(db, curatorProfileId, eventId);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as EventDoc | undefined;
      if (!fresh) throw new HttpsError("not-found", "Event not found.");
      const lineup = fresh.lineup ?? [];
      if (!taggedIn(lineup, musicianProfileId)) throw new HttpsError("not-found", "That artist is not tagged on this lineup.");
      // The act stays on the bill as a plain external name (the show still
      // has that act), it just stops claiming a GateKeep artist. Removing it
      // entirely is the existing lineup edit path.
      const next: EventAct[] = lineup.map((a) =>
        a.kind === "tagged" && a.musicianProfileId === musicianProfileId ? { kind: "external", name: a.name } : a);
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
    });
    return { ok: true };
  });

export const respondToArtistTag = onCall<{ eventId: string; musicianProfileId: string; accept: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, musicianProfileId, accept } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "An event and an artist are required.");
    }
    if (typeof accept !== "boolean") throw new HttpsError("invalid-argument", "Accept or decline.");
    await requireProfileAdmin(musicianProfileId, uid);

    const db = getFirestore();
    const ref = db.doc(`events/${eventId}`);
    const now = Date.now();
    const status: TaggedActStatus = accept ? "accepted" : "declined";
    const event = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
      const fresh = snap.data() as EventDoc;
      const act = taggedIn(fresh.lineup ?? [], musicianProfileId);
      if (!act) throw new HttpsError("not-found", "That artist is not tagged on this lineup.");
      if (act.status !== "pending") throw new HttpsError("failed-precondition", ARTIST_TAG_ANSWERED_MESSAGE);
      const next: EventAct[] = (fresh.lineup ?? []).map((a) =>
        a.kind === "tagged" && a.musicianProfileId === musicianProfileId
          ? { ...a, status, respondedAt: now } : a);
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
      return { ...fresh, lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next) };
    });

    // Accepting on a PUBLISHED event announces the show to this artist's own
    // followers, under the publish path's own key (`announce:{eventId}`), so
    // a fan who already heard about this event hears nothing twice and a
    // later re-announce cannot double-send. Decline and untag tell nobody.
    if (accept && event.status === "published") {
      try {
        await notifyFollowers([musicianProfileId], showAnnouncedNote(eventId, event), `announce:${eventId}`);
      } catch (e) {
        console.error(`respondToArtistTag: announce fan-out failed for event ${eventId}`, e);
      }
    }
    return { ok: true, status };
  });
```

- [ ] **Step 5: The note builder and the two `events.ts` seams**

In `functions/src/announce.ts`, add after `onTheBillNote`:

```ts
// SP11: the curator tagged this musician profile on an event lineup. Sent to
// the musician profile's ADMINS (not every member): accepting is a decision
// about the act's public page, the same authority level as payout shares.
export function artistTagNote(eventId: string, event: EventDoc, curatorName: string): Note {
  return {
    kind: "artist_tag", refId: eventId, title: "You were tagged on a lineup",
    body: `${curatorName} tagged you on ${event.title}.`,
  };
}
```

In `functions/src/notifications.ts`, `notifyProfileAdmins` gains a third parameter so the tag fan-out can dedupe:

```ts
export async function notifyProfileAdmins(
  profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey?: string,
) {
  const admins = await getFirestore().collection(`profiles/${profileId}/members`).where("role", "==", "admin").get();
  await Promise.all(admins.docs.map((m) => notifyUser(m.id, note, dedupeKey)));
}
```

(the existing SP5c caller passes two arguments and is unaffected.)

In `functions/src/events.ts`:

- Delete the local `deriveLineupMusicianProfileIds` and import it, along with `reconcileTaggedActs` and `notifyPendingTags`, from `./eventArtistTags.js`.
- In `updateEvent`, immediately after the `event.status` check and before `eventRef.update`, reconcile and re-derive:

```ts
  // SP11: the client resends the whole lineup, tagged acts included. Their
  // status is server state, so every tagged entry is replaced by the stored
  // copy and an entry the server has never seen is refused.
  const lineup = reconcileTaggedActs(event.lineup ?? [], input.lineup);
```

  then use `lineup` (not `input.lineup`) in the `update` call, in `deriveLineupMusicianProfileIds`, and in the `updated` object the fan-out branch builds. `computeEventGenres` keeps taking `input.lineup`: it reads booking acts only.
- In `createEvent`, refuse a tagged act outright, immediately after `validateLineupIdentity(input.lineup)`:

```ts
    // SP11: tags are created by tagEventArtist against a saved event, so a
    // create payload never carries one. Both editors disable the picker
    // until the event exists and say so.
    if (input.lineup.some((a) => a.kind === "tagged")) {
      throw new HttpsError("invalid-argument", ARTIST_TAG_UNKNOWN_MESSAGE);
    }
```
  (add `ARTIST_TAG_UNKNOWN_MESSAGE` to this file's shared import list.)
- In `publishEvent`, inside the existing post-commit `try` block, after `notifyLineupMembers`:

```ts
    await notifyPendingTags(db, input.eventId, published);
```

- In `functions/src/index.ts`:

```ts
export { tagEventArtist, untagEventArtist, respondToArtistTag } from "./eventArtistTags.js";
```

- [ ] **Step 6: Run the new file and every suite that touches the lineup**

Run the Step 2 command for `test/eventArtistTags.test.ts`: PASS.
Then run, one file at a time with the same command shape: `test/eventFields.test.ts`, `test/events.test.ts`, `test/showPosts.test.ts`, `test/discover.test.ts`, `test/searchIndex.test.ts` (confirm names with `ls functions/test`): PASS, unchanged.

- [ ] **Step 7: Commit**

```bash
git add functions/src/eventArtistTags.ts functions/src/events.ts functions/src/eventsCore.ts functions/src/announce.ts functions/src/notifications.ts functions/src/index.ts functions/test/eventArtistTags.test.ts
git commit -m "feat(functions): curator artist tags with accept, decline, untag, and the publish notification"
```

---

### Task 6: The age facet in the search index and the fan filter end to end

**Files:**
- Modify: `functions/src/searchIndex.ts`
- Test: `functions/test/eventAgeSearch.test.ts` (new)

**Interfaces:**
- Consumes: `SearchIndexDoc.ageRestriction` and `matchesFilters`'s `allAges` branch (Task 1); the doors and age fields (Task 4).
- Produces: `searchIndex/show_{eventId}.ageRestriction`, which the `search` callable filters through the shared `matchesFilters` with no change of its own, and which `onSearchIndexCreated` therefore honours for saved-search alerts.

- [ ] **Step 1: Pre-flight the index file**

Read `firestore.indexes.json` and confirm, in writing in the task report, that every query this plan adds is already served: `search`'s `searchIndex (kind, tokens, startsAt)` and `(kind, tokens, followerCount)` are unchanged (`allAges` and `ageRestriction` are in-memory filters, never query clauses), `updateAccount` adds no query, and the three tag callables read single documents only. If any query is not covered, stop and report before writing code.

- [ ] **Step 2: Write the failing test**

Create `functions/test/eventAgeSearch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedCuratorProfile, eventContent, addTiersAndPublish, waitForIndex } from "./discoverFixtures";
import type { SearchInput, SearchOutput } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];

// Unique token per run so the shared emulator database cannot flood the
// candidate cap with other suites' events (sp8-rulings.md ruling 5).
const token = `zorbulon${Date.now().toString(36)}`;

async function publishShow(profileId: string, user: Parameters<typeof addTiersAndPublish>[2], suffix: string, ageRestriction: string) {
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
    curatorProfileId: profileId, source: { kind: "standalone" },
    ...eventContent({ title: `${token} ${suffix}` }), ageRestriction,
  }, user);
  await addTiersAndPublish(profileId, eventId, user, FREE_TIER);
  return eventId;
}

describe("ageRestriction in the search index", () => {
  it("projects the facet and the fan face's allAges filter drops 18+ and 21+ shows", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ag1", "venue");
    const allAgesId = await publishShow(profileId, owner.user, "open", "all_ages");
    const eighteenId = await publishShow(profileId, owner.user, "gated", "18_plus");

    expect((await waitForIndex(`show_${allAgesId}`, (d) => d?.ageRestriction === "all_ages"))?.ageRestriction).toBe("all_ages");
    expect((await waitForIndex(`show_${eighteenId}`, (d) => d?.ageRestriction === "18_plus"))?.ageRestriction).toBe("18_plus");

    const fan = await signUpTestUser(`ag1f-${Date.now()}@test.com`);
    const run = (allAges: boolean) => callFn<SearchInput, SearchOutput>("search", {
      face: "fan", q: token, filters: allAges ? { allAges: true } : {}, location: null, page: 0, includePins: false,
    }, fan.user);

    const both = await run(false);
    expect(both.items.map((i) => i.id).sort()).toEqual([allAgesId, eighteenId].sort());
    const filtered = await run(true);
    expect(filtered.items.map((i) => i.id)).toEqual([allAgesId]);
  });

  it("reads a pre-SP11 event with no ageRestriction as all ages", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ag2", "venue");
    const legacyId = await publishShow(profileId, owner.user, "legacy", "all_ages");
    // Strip the field the way a pre-SP11 doc looks, then force a re-project.
    await adb.doc(`events/${legacyId}`).update({ ageRestriction: FieldValue.delete(), updatedAt: Date.now() });
    expect((await waitForIndex(`show_${legacyId}`, (d) => d?.ageRestriction === "all_ages"))?.ageRestriction).toBe("all_ages");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/eventAgeSearch.test.ts"`
Expected: FAIL, `ageRestriction` is absent from the index doc and the filtered search returns both shows.

- [ ] **Step 4: Project the facet**

In `functions/src/searchIndex.ts`:

- the `base` factory gains `ageRestriction: "all_ages",` after `hasFreeTier: false,`, with the comment "SP11: every non-show kind keeps the default; only projectShow overrides it."
- `projectShow`'s returned object gains, after `hasFreeTier: event.hasFreeTier ?? false,`:

```ts
    ageRestriction: event.ageRestriction ?? "all_ages",
```

Nothing else changes: `projectShow` already reads `event.lineup` for its tokens, so an accepted tagged act's name is searchable, and `relatedProfileIds` already spreads `lineupMusicianProfileIds`, which Task 5 taught to include accepted tags.

- [ ] **Step 5: Run the new file and the search suites**

Run the Step 3 command for `test/eventAgeSearch.test.ts`: PASS.
Then run `test/searchIndex.test.ts`, `test/search.test.ts`, and `test/savedSearches.test.ts` one at a time with the same command shape: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add functions/src/searchIndex.ts functions/test/eventAgeSearch.test.ts
git commit -m "feat(functions): project ageRestriction into the show search index for the all-ages filter"
```

---

## Client tasks

Client tasks are contracts plus the load-bearing snippets (state shapes, callable calls, exact copy). Each names the existing primitives to reuse; none introduces a new visual language, a new icon source, or a new control type. There are no browser or device tests: gates are typecheck, lint, and build or export, and the on-device signal is owner-owed (spec section 9).

### Task 7: Web sharing and the deep-link verification files

**Files:**
- Create: `apps/web/src/share/ShareButton.tsx`, `apps/web/app/well-known/apple-app-site-association/route.ts`, `apps/web/app/well-known/assetlinks.json/route.ts`
- Modify: `apps/web/next.config.ts`, `apps/web/app/e/[eventId]/EventPageClient.tsx`, `apps/web/app/u/[handle]/page.tsx`, `apps/web/src/ui/icons.tsx`

**Interfaces:**
- Consumes: `getSiteUrl()` from `../seo/siteUrl` (a plain module, safe to import from a client component), `SHARE_LINK_COPIED_MESSAGE` from shared (Task 1), the `Button` primitive from `../ui/button`.
- Produces: `ShareButton({ path, title })` (a `"use client"` component), and the two public URLs `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. Task 12 mirrors the component on mobile and consumes the same env names.

- [ ] **Step 1: The share component**

`apps/web/src/share/ShareButton.tsx`, `"use client"`, props `{ path: string; title: string }`:

- The absolute URL is built inside the click handler, never during render (the React Compiler purity rule this codebase already works around in `app/e/[eventId]/page.tsx`): `const url = `${getSiteUrl() ?? window.location.origin}${path}`;`. `getSiteUrl()`'s Vercel branch reads a server-only env var that is `undefined` in the browser, so `window.location.origin` is the real fallback there, which is exactly the spec's rule.
- `navigator.share` when it exists: `await navigator.share({ title, url })`, and an `AbortError` (the user dismissed the sheet) is swallowed.
- Otherwise `await navigator.clipboard.writeText(url)` and set a `copied` state true, cleared by a `setTimeout(..., 2000)` whose id is stored in a ref and cleared on unmount and on a second click, so a rapid double click does not leave a stale timer (the deferred `SaveSearchButton` finding in `sp8-rulings.md`, not repeated here).
- Renders `<Button type="button" variant="secondary" size="sm" onClick={...}>` with `<IconShare size={16} aria-hidden="true" />` and the label `Share`; while `copied` is true the label is `SHARE_LINK_COPIED_MESSAGE` and the button carries `aria-live="polite"`.
- Add `IconShare` to `apps/web/src/ui/icons.tsx` re-exporting Phosphor's `ShareNetwork` from `@phosphor-icons/react/dist/ssr`, duotone, in the same shape as the icons already there.

- [ ] **Step 2: Mount it on the two public pages**

- `apps/web/app/e/[eventId]/EventPageClient.tsx`: in the title row, render `<ShareButton path={`/e/${eventId}`} title={event.title} />` to the right of the `<h1>`, inside a `flex items-start justify-between gap-3` wrapper so the heading keeps its own line length.
- `apps/web/app/u/[handle]/page.tsx`: in both `MusicianProfile` and `CuratorProfile`, beside the existing name heading, render `<ShareButton path={`/u/${profile.handle}`} title={profile.name} />`. `/u/{handle}` is the path the native intent filters and the AASA components claim, and in a browser it 308s to the canonical `/@{handle}` (`next.config.ts`), so a shared link is correct on both surfaces.

- [ ] **Step 3: The two route handlers**

`apps/web/app/well-known/apple-app-site-association/route.ts`:

```ts
// SP11 (spec section 3.1): the iOS universal-link claim file, served at
// /.well-known/apple-app-site-association through the rewrite pair in
// next.config.ts. Every value is read at REQUEST time from server-only env
// (never NEXT_PUBLIC: this file must not be inlined into a client bundle),
// and a missing value returns 404 rather than a half-filled claim, which is
// what would break link verification for a whole domain.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const teamId = process.env.APPLE_TEAM_ID;
  const bundleId = process.env.IOS_BUNDLE_ID;
  if (!teamId || !bundleId) return new Response("Not found", { status: 404 });
  const body = {
    applinks: {
      details: [{
        appIDs: [`${teamId}.${bundleId}`],
        components: [{ "/": "/e/*" }, { "/": "/u/*" }],
      }],
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
```

`apps/web/app/well-known/assetlinks.json/route.ts`: the same shape, reading `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256`, 404 when either is unset, body:

```ts
  const body = [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: [fingerprint] },
  }];
```

- [ ] **Step 4: The rewrites**

In `apps/web/next.config.ts`, extend `beforeFiles` (a directory whose name begins with a dot is not a reliable app-router segment, so the public URLs are produced by a rewrite rather than an `app/.well-known/` folder; the URLs the spec names are unchanged):

```ts
        // SP11: the two deep-link verification files. The app-router segment
        // lives at app/well-known/, these give it the dot-prefixed public URL
        // Apple and Google fetch.
        { source: "/.well-known/apple-app-site-association", destination: "/well-known/apple-app-site-association" },
        { source: "/.well-known/assetlinks.json", destination: "/well-known/assetlinks.json" },
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @gatekeep/web exec next typegen`, then `pnpm --filter @gatekeep/web typecheck`, `pnpm --filter @gatekeep/web lint` (0 errors, no new warnings), `pnpm --filter @gatekeep/web build`. The build's route table must list both `/well-known/...` handlers.

```bash
git add apps/web/src/share apps/web/app/well-known apps/web/next.config.ts apps/web/app/e apps/web/app/u apps/web/src/ui/icons.tsx
git commit -m "feat(web): share button on the event and profile pages, env-gated deep-link verification files"
```

---

### Task 8: Web Discover location and the home-city fallback

**Files:**
- Create: `apps/web/src/discover/useHomeGeo.ts`, `apps/web/src/discover/RankedShows.tsx`
- Modify: `apps/web/src/discover/ShowsList.tsx`, `apps/web/app/discover/DiscoverClient.tsx`

**Interfaces:**
- Consumes: `useBrowserLocation()` from `../search/useBrowserLocation` (session only, three decimals), `callFn` from `../lib/callable`, `GetDiscoverDeckInput`/`GetDiscoverDeckResult`/`DeckCard` from shared, `UserDoc.homeGeo`/`homeCity` (Task 3 writes them), `DateBlockRow`, `Chip`, `Skeleton`.
- Produces: `useHomeGeo(uid): { homeCity: string | null; homeGeo: { lat: number; lng: number } | null; loading: boolean }` and `RankedShows({ location, homeCity, usingHomeCity })`. Task 13 builds the mobile twin of `useHomeGeo` separately (different Firestore SDK surface).

- [ ] **Step 1: The home-geo hook**

`useHomeGeo(uid)` reads `users/{uid}` once with `getDoc` (the owner-read rule already allows it), returns `{ homeCity, homeGeo, loading }`, treats a missing field as null, and swallows a permission error into nulls. No listener: this value changes only when the fan saves the account card, and the card reloads the page section itself.

- [ ] **Step 2: The ranked list**

`RankedShows({ location, homeCity, usingHomeCity })`:
- State: `cards: DeckCard[] | "loading"`, `error: string | null`, `seed: number | null`, `shownIds: string[]`.
- Fetch: `const { data } = await callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>("getDiscoverDeck", input)` where `input` is `{ location }` on the first page and `{ location, seed, excludeIds: shownIds }` on "Show more". `location` is never sent as `null` (the callable rejects it); this component only mounts when a position exists.
- Render: `data.cards.filter((c) => c.kind === "show")` through the same `DateBlockRow` row `ShowsList` uses (`dateMs`, `title`, `subtitle` from `venueName` plus `neighborhood`, `href={`/e/${card.eventId}`}`, `detail` from `priceFromCents` via `formatCents`). Loading, empty ("No shows match these filters", the string already in `ShowsList`), and error rows reuse `ShowsList`'s existing treatments.
- Above the rows, when `usingHomeCity` and `homeCity`, one muted line: `Ranked near {homeCity}` with the city rendered from the value and a `<Link href="/dashboard#account">` on the words "Ranked near {homeCity}" so the fan can change it. When the position came from the browser, no line.

- [ ] **Step 3: Wire the chip into `ShowsList`**

`ShowsList` gains a `uid` prop and, beside the existing Today / This week / Weekend / Free chips, one more:

```tsx
        <Chip
          active={useMyLocation && location.status === "granted"}
          onClick={() => { setUseMyLocation((v) => !v); if (location.status === "idle") location.request(); }}
        >
          Use my location
        </Chip>
```

Resolution order, exactly the spec's: browser position when the chip is on and `status === "granted"`, else the account's `homeGeo`, else nothing. When a position resolves, render `<RankedShows ... />` in place of the filtered query list; with no position at all, today's unranked query feed renders unchanged, which is the spec's stated fallback. A denied or unsupported browser result falls through silently (no error row): `location.status === "denied"` simply leaves the chip inactive.

`DiscoverClient`'s `DiscoverBody` passes `uid` into `<ShowsList uid={uid} />`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @gatekeep/web typecheck`, `lint`, `build`.

```bash
git add apps/web/src/discover apps/web/app/discover
git commit -m "feat(web): rank Discover shows by browser location or the saved home city"
```

---

### Task 9: Web account card

**Files:**
- Create: `apps/web/src/account/AccountCard.tsx`
- Modify: `apps/web/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `callFn`, `updateAccount` (Task 3), `UpdateAccountResult`, `ACCOUNT_NAME_HELP`, `ACCOUNT_CITY_HELP`, `ACCOUNT_SAVED_MESSAGE`, `ACCOUNT_GEOCODE_MISS_MESSAGE`; `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Input`, `Button`.
- Produces: `AccountCard({ uid })`, mounted with `id="account"` so `/dashboard#account` (Task 8's "Ranked near" link) lands on it.

- [ ] **Step 1: The card**

`AccountCard({ uid })`, `"use client"`:
- Loads `users/{uid}` once with `getDoc`, seeding `name` and `city` state; renders `Skeleton` rows while loading.
- Two labelled `Input`s inside a `<Card>` titled `Account`:
  - `Display name`, `maxLength={80}`, helper line under it: `Shown on tickets you buy from now on.`
  - `Home city`, `maxLength={80}`, helper line under it: `Used to rank shows near you when your location is off.`
  Each label is a real `<label htmlFor>` pointing at its input's `id`, matching the dashboard's existing form shapes.
- Save `Button`, disabled while busy or when nothing changed. On click:

```ts
const { data } = await callFn<UpdateAccountInput, UpdateAccountResult>("updateAccount", {
  displayName: name.trim(), homeCity: city.trim() === "" ? null : city.trim(),
});
setStatus(data.geocoded === false ? ACCOUNT_GEOCODE_MISS_MESSAGE : ACCOUNT_SAVED_MESSAGE);
```
  then re-read the user doc (the spec's "success re-reads the user doc"), so the card shows what the server actually stored.
- On failure, surface `e instanceof Error ? e.message : "Could not save your account."` in the dashboard's existing inline error treatment (the same `role="alert"` block `ProfilesList` uses), never a bare `alert()`.
- The success line renders in `text-gk-success`, the geocoder-miss line in `text-gk-muted` (it is not a failure, the name and city were saved).

- [ ] **Step 2: Mount it**

In `apps/web/app/dashboard/page.tsx`, above the "Your profiles" section and below the payouts section:

```tsx
      <section id="account" className="mt-10">
        <AccountCard key={`account-${user.uid}`} uid={user.uid} />
      </section>
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @gatekeep/web typecheck`, `lint`, `build`.

```bash
git add apps/web/src/account apps/web/app/dashboard/page.tsx
git commit -m "feat(web): account card for display name and home city on the dashboard"
```

---

### Task 10: Web event editor: doors, age, and the artist picker

**Files:**
- Create: `apps/web/src/events/ArtistPicker.tsx`
- Modify: `apps/web/src/events/EventEditor.tsx`

**Interfaces:**
- Consumes: `AGE_RESTRICTIONS`, `AGE_RESTRICTION_LABEL`, `EVENT_DOORS_MESSAGE`, `DOORS_MAX_BEFORE_START_MS`, `TaggedActStatus`; `tagEventArtist`, `untagEventArtist` (Task 5); the `search` callable's `curator` face; `Chip`/`formatChipLabel` from `../portfolio/PortfolioForms`; `Input`, `Button`, `Dialog`, `IconTrash`, `IconPlus`.
- Produces: `ArtistPicker({ open, onClose, onPick })` where `onPick(profileId: string, name: string)`. `EventCreateForm` and `EventEditContentForm` both send `doorsAt` and `ageRestriction`.

- [ ] **Step 1: Doors and age fields**

In the Details card of **both** `EventCreateForm` and `EventEditContentForm`, after the Starts and Ends inputs:

```tsx
            <div className="grid gap-1.5">
              <label htmlFor="event-doors" className="font-sora text-sm font-medium text-gk-text">Doors (optional)</label>
              <Input id="event-doors" type="datetime-local" value={doorsInput} onChange={(e) => setDoorsInput(e.target.value)} />
            </div>
```

(the edit form uses `event-edit-doors` for its id, matching the file's existing per-form id prefixes), seeded from `event.doorsAt ? toLocalInput(event.doorsAt) : ""` on edit and `""` on create, and a second row of chips:

```tsx
          <div className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Age</span>
            <div className="flex flex-wrap gap-2">
              {AGE_RESTRICTIONS.map((a) => (
                <Chip key={a} active={age === a} onClick={() => setAge(a)}>{AGE_RESTRICTION_LABEL[a]}</Chip>
              ))}
            </div>
          </div>
```

with `const [age, setAge] = useState<AgeRestriction>(event.ageRestriction ?? "all_ages")` on edit and `"all_ages"` on create.

Client-side hints mirroring the server rule, inside each form's existing `save` guard chain, before the callable runs:

```ts
    const doorsAt = doorsInput ? fromLocalInput(doorsInput) : null;
    if (doorsInput && (doorsAt == null || doorsAt >= startsAt || startsAt - doorsAt > DOORS_MAX_BEFORE_START_MS)) {
      setError(EVENT_DOORS_MESSAGE); return;
    }
```

and both callable payloads gain `doorsAt, ageRestriction: age`.

- [ ] **Step 2: The picker**

`ArtistPicker({ open, onClose, onPick })`, `"use client"`, inside the existing `Dialog` primitive:
- One `Input` for the query, debounced 300 ms, calling

```ts
const { data } = await callFn<SearchInput, SearchOutput>("search", {
  face: "curator", q, filters: {}, location: null, page: 0, includePins: false,
});
```
- Rows render `item.title`, then a muted meta line of `item.city` and `item.genres.map(formatChipLabel).join(", ")` (the fields the spec names: name, city, genres). Each row is a `<button type="button">` calling `onPick(item.id, item.title)` then `onClose()`.
- Empty state `Nothing matches yet. Try fewer filters or a shorter search.` (`SEARCH_EMPTY_MESSAGE`), loading `Skeleton` rows, error row in the file's existing `ErrorBox`.

- [ ] **Step 3: Two paths in `LineupFields`**

`LineupFields` gains props `{ lineup, onChange, eventId, profileId }` (both ids null on the create form) and a second button beside "Add act":

```tsx
        <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)} disabled={!eventId}>
          <IconPlus size={16} aria-hidden="true" />
          Tag a GateKeep artist
        </Button>
```

with, when `!eventId`, a muted line under the row: `Save the event first, then tag artists.` (tags are created against a saved event by `tagEventArtist`, so the create form keeps name-only acts).

`onPick` calls `callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId })`, and on success appends the returned act locally so the row appears without a refetch; on failure it surfaces the server message verbatim (the three `ARTIST_TAG_*` strings are the whole vocabulary here).

Each rendered act row shows its provenance beside the name, replacing today's single `(booked act)` note:

```tsx
                {act.kind === "booking" && <span className="ml-1.5 font-sora text-xs text-gk-muted">(booked act)</span>}
                {act.kind === "tagged" && <span className="ml-1.5 font-sora text-xs text-gk-muted">{TAG_STATUS_LABEL[act.status]}</span>}
```

with `const TAG_STATUS_LABEL: Record<TaggedActStatus, string> = { pending: "Pending", accepted: "Accepted", declined: "Declined" };` at module scope.

The existing trash button removes any act from local state as it does today (the save then drops it through `updateEvent`, which Task 5 taught to treat an omitted tagged act as a removal). A tagged act additionally offers `Untag`, calling `untagEventArtist` and replacing the row locally with `{ kind: "external", name }`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @gatekeep/web typecheck`, `lint`, `build`.

```bash
git add apps/web/src/events
git commit -m "feat(web): doors and age fields plus the GateKeep artist tag picker in the event editor"
```

---

### Task 11: Web event page, JSON-LD, the tag banner, and the all-ages filter

**Files:**
- Create: `apps/web/src/events/ArtistTagBanner.tsx`
- Modify: `apps/web/app/e/[eventId]/page.tsx`, `apps/web/app/e/[eventId]/EventPageClient.tsx`, `apps/web/src/seo/jsonLd.ts`, `apps/web/src/search/FilterBar.tsx`
- Test: `apps/web/src/seo/jsonLd.test.ts` (append)

**Interfaces:**
- Consumes: `EventDoc.doorsAt`/`ageRestriction` (Task 4), the `tagged` act variant and `respondToArtistTag` (Task 5), `SearchFilters.allAges` (Task 1), `AGE_RESTRICTION_LABEL`, `formatGigTime`, `Badge`, `Button`.
- Produces: `ArtistTagBanner({ eventId, acts, uid })`; `eventJsonLd` emitting `doorTime`; `EventPageLineupEntry` resolved for accepted tagged acts.

- [ ] **Step 1: Failing JSON-LD test**

Append to `apps/web/src/seo/jsonLd.test.ts`:

```ts
  it("adds doorTime when the event has one and omits it otherwise", () => {
    const base = {
      title: "Night", description: "d", status: "published" as const,
      startsAt: Date.UTC(2026, 8, 4, 23, 0), endsAt: Date.UTC(2026, 8, 5, 2, 0),
      location: { venueName: "Mohawk", address: null, city: "Austin", neighborhood: null, geo: null },
    };
    const withDoors = eventJsonLd({ ...base, doorsAt: Date.UTC(2026, 8, 4, 22, 0) }, "ev1", "https://x/e/ev1", [], null, []);
    expect(withDoors.doorTime).toBe(new Date(Date.UTC(2026, 8, 4, 22, 0)).toISOString());
    expect(eventJsonLd(base, "ev1", "https://x/e/ev1", [], null, []).doorTime).toBeUndefined();
  });
```

Run: `pnpm --filter @gatekeep/web test`
Expected: FAIL, `doorTime` is undefined in the first assertion.

- [ ] **Step 2: JSON-LD**

In `apps/web/src/seo/jsonLd.ts`, widen the `event` parameter's `Pick` to include `"doorsAt"` and add, after `endDate`:

```ts
    // SP11: schema.org's MusicEvent carries doorTime; it has no age
    // property, so the age badge on the page is text only (spec 3.4).
    doorTime: event.doorsAt != null ? new Date(event.doorsAt).toISOString() : null,
```

`withoutEmpty` already drops a null, so an event with no doors emits no key.

- [ ] **Step 3: The page's schedule line, badge, and accepted tags**

In `apps/web/app/e/[eventId]/page.tsx`, widen `resolveLineup` so an **accepted** tagged act resolves a handle exactly like a booking act:

```ts
  const linkableIds = [...new Set(lineup.flatMap((a) =>
    a.kind === "booking" || (a.kind === "tagged" && a.status === "accepted") ? [a.musicianProfileId] : []))];
```

and the final map becomes:

```ts
  return lineup.map((act) => {
    const linkable = act.kind === "booking" || (act.kind === "tagged" && act.status === "accepted");
    return linkable
      ? { name: act.name, handle: handles.get(act.musicianProfileId) ?? null, profileId: act.musicianProfileId }
      : { name: act.name, handle: null, profileId: null };
  });
```

A pending or declined tagged act therefore renders as a plain name, which is the spec's public rule. `LoadedEvent` gains `tagged: Array<{ musicianProfileId: string; name: string; status: TaggedActStatus }>` (derived from `event.lineup`) so the client half can mount the banner without re-reading the doc.

In `EventPageClient.tsx`:
- The date block's `subtitle` gains the doors line. Keep `DateBlockRow` as it is and render, directly under it when `event.doorsAt != null`, one muted line: `Doors {formatGigTime(event.doorsAt)}`.
- Beside the `<h1>` (in Task 7's flex row), when `event.ageRestriction` is `18_plus` or `21_plus`, `<Badge>{AGE_RESTRICTION_LABEL[event.ageRestriction]}</Badge>`. All ages renders nothing.
- Above the poster, `<ArtistTagBanner eventId={eventId} acts={tagged} uid={user?.uid ?? null} />`.

- [ ] **Step 4: The tag banner**

`ArtistTagBanner({ eventId, acts, uid })`, `"use client"`:
- For each act with `status === "pending"`, read `profiles/{musicianProfileId}/members/{uid}` with `getDoc` (the self-read clause in `firestore.rules` allows exactly this) and keep the ones whose `role === "admin"`. Signed-out or no match renders nothing.
- For a match, render a bordered panel in the same treatment as the file's existing notice blocks: title `You were tagged on this lineup`, then two buttons, `Accept` (primary) and `Decline` (secondary), each calling `callFn("respondToArtistTag", { eventId, musicianProfileId, accept })` and, on success, replacing the panel body with the result line `Accepted` or `Declined`. A failure surfaces the server message (`This tag has already been answered.` is the one a stale page sees).
- Bounded by the 20-act lineup cap, so the per-act membership reads need no batching.

- [ ] **Step 5: The all-ages filter**

In `apps/web/src/search/FilterBar.tsx`, beside the existing `freeOnly` chip:

```tsx
        {has("allAges") && (
          <Chip active={!!filters.allAges} onClick={() => onChange({ ...filters, allAges: !filters.allAges })}>
            All ages only
          </Chip>
        )}
```

The spec calls this a checkbox on web; `FilterBar` has no checkbox control and every one of its sibling booleans is a `Chip` with `aria-pressed`, so it ships as a chip. Recorded in the report and in the self-review below.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @gatekeep/web test` (PASS), then `typecheck`, `lint`, `build`.

```bash
git add apps/web/src/seo apps/web/app/e apps/web/src/events/ArtistTagBanner.tsx apps/web/src/search/FilterBar.tsx
git commit -m "feat(web): doors line, age badge, doorTime JSON-LD, artist tag banner, and the all-ages filter"
```

---

### Task 12: Mobile deep links, the handle resolver, and sharing

**Files:**
- Create: `apps/mobile/app/u/[handle].tsx`, `apps/mobile/app/e/[eventId].tsx`, `apps/mobile/src/share/ShareButton.tsx`
- Modify: `apps/mobile/app.json`, `apps/mobile/app/_layout.tsx`, `apps/mobile/app/event/[eventId].tsx`, `apps/mobile/app/artist/[handle].tsx`, `apps/mobile/app/venue/[handle].tsx`, `apps/mobile/src/ui/icons.tsx`

**Interfaces:**
- Consumes: `EXPO_PUBLIC_SITE_URL`, expo-router's `Redirect` and `useLocalSearchParams`, the `handles/{handle}` to `profiles/{id}` lookup `app/artist/[handle].tsx` and `app/venue/[handle].tsx` already share, the `Button` and `Text` primitives.
- Produces: `ShareButton({ path, title })` (React Native), the routes `/u/[handle]` and `/e/[eventId]`, and the native link configuration.

- [ ] **Step 1: Native config**

In `apps/mobile/app.json`, `ios` gains, beside `bundleIdentifier`:

```json
      "associatedDomains": ["applinks:REPLACE_WITH_LINK_DOMAIN"],
```

and `android` gains, beside `package`:

```json
      "intentFilters": [
        {
          "action": "VIEW",
          "autoVerify": true,
          "data": [
            { "scheme": "https", "host": "REPLACE_WITH_LINK_DOMAIN", "pathPrefix": "/e/" },
            { "scheme": "https", "host": "REPLACE_WITH_LINK_DOMAIN", "pathPrefix": "/u/" }
          ],
          "category": ["BROWSABLE", "DEFAULT"]
        }
      ],
```

The placeholder follows the `REPLACE_WITH_ANDROID_MAPS_KEY` precedent already in this file: a build carrying it simply has no verified links, and the owner replaces it (spec section 9). The custom `gatekeep://` scheme is already set and is unchanged.

- [ ] **Step 2: The two incoming routes**

`apps/mobile/app/e/[eventId].tsx`: a redirect only, so a `/e/{id}` universal link reaches the existing event screen.

```tsx
import { Redirect, useLocalSearchParams } from "expo-router";

// SP11: the web URL shape is /e/{eventId}; the app's own screen lives at
// event/[eventId]. This route exists purely so an incoming universal link
// resolves, and it replaces itself rather than pushing, so Back does not
// return to an empty shim.
export default function EventLink() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  if (!eventId) return <Redirect href="/" />;
  return <Redirect href={{ pathname: "/event/[eventId]", params: { eventId } }} />;
}
```

`apps/mobile/app/u/[handle].tsx`: the resolver the spec describes. It lowercases the handle, reads `handles/{handle}` then `profiles/{id}` with the same lookup shape `app/venue/[handle].tsx` uses, and then:
- `profile.type === "musician"` renders `<Redirect href={{ pathname: "/artist/[handle]", params: { handle } }} />`
- `profile.type === "curator"` renders `<Redirect href={{ pathname: "/venue/[handle]", params: { handle } }} />`
- unknown handle, unreadable profile, or an error renders the existing not-found treatment those two screens already use (the same `Text variant="title"` plus muted line, no new visual), never a blank screen.
- While resolving, the `Skeleton` block those screens use.
- It carries the render-time `lastHandle` reset idiom both sibling screens document, so a reused instance never resolves the previous handle.

- [ ] **Step 3: Register the routes**

In `apps/mobile/app/_layout.tsx`, inside the `<Stack>`:

```tsx
        {/* SP11: incoming universal and app links. /e/{id} redirects to the
            event screen; /u/{handle} resolves the profile type and replaces
            itself with the artist or venue screen. Both are headerless: the
            screen they land on owns the header. */}
        <Stack.Screen name="e/[eventId]" options={{ headerShown: false }} />
        <Stack.Screen name="u/[handle]" options={{ headerShown: false }} />
```

The push-tap path in this file is untouched: `pushHref` already routes `artist_tag` to `/event/{id}` through the shared `notificationHref` (Task 1), with no narrowing change needed because `artist_tag` sets no `refKind`.

- [ ] **Step 4: The share component**

`apps/mobile/src/share/ShareButton.tsx`, props `{ path: string; title: string }`:

```tsx
const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "";

export function ShareButton({ path, title }: { path: string; title: string }) {
  // No env, no button: a share sheet carrying a relative path or a
  // localhost URL is worse than no share affordance at all (spec 3.1).
  if (!SITE_URL) return null;
  const onPress = async () => {
    try {
      await Share.share({ message: title, url: `${SITE_URL}${path}` });
    } catch (e) {
      console.warn("share failed", e);
    }
  };
  return <Button title="Share" variant="secondary" onPress={() => void onPress()} />;
}
```

Mount it on the three public screens, beside each screen's existing `FollowButton` or title row: `app/event/[eventId].tsx` (`path={`/e/${eventId}`}`, `title={event.title}`), `app/artist/[handle].tsx` and `app/venue/[handle].tsx` (`path={`/u/${handle}`}`, `title={profile.name}`). Add `IconShare` to `apps/mobile/src/ui/icons.tsx` (`phosphor-react-native`'s `ShareNetwork`, duotone) if the `Button` variant used takes an icon; otherwise the label alone is enough and no icon is added.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @gatekeep/mobile typecheck`, `pnpm --filter @gatekeep/mobile lint` (0 new warnings), `pnpm --filter @gatekeep/mobile exec expo export --no-bytecode`. The export must list the two new routes.

```bash
git add apps/mobile/app.json apps/mobile/app/_layout.tsx apps/mobile/app/e apps/mobile/app/u apps/mobile/src/share apps/mobile/app/event apps/mobile/app/artist apps/mobile/app/venue apps/mobile/src/ui/icons.tsx
git commit -m "feat(mobile): universal and app link config, the handle resolver, and share buttons"
```

---

### Task 13: Mobile account editor and the deck's home-city fallback

**Files:**
- Create: `apps/mobile/src/account/EditAccountSheet.tsx`, `apps/mobile/src/discover/useHomeGeo.ts`
- Modify: `apps/mobile/src/shell/AccountScreen.tsx`, `apps/mobile/src/discover/DeckScreen.tsx`, `apps/mobile/src/discover/LocationPromptSheet.tsx`

**Interfaces:**
- Consumes: `callFn`, `updateAccount` (Task 3), `UpdateAccountInput`/`UpdateAccountResult`, the five account copy constants, `HOME_CITY_PROMPT_LINE`; `Sheet`, `Input`, `Button`, `Text`, `ErrorBanner`, `Card`, `IconCaretRight`; `useDeckLocation()`.
- Produces: `EditAccountSheet({ visible, onClose })`, `useHomeGeo(uid)` with the same return shape as Task 8's web hook (`{ homeCity, homeGeo, loading }`).

- [ ] **Step 1: The sheet**

`EditAccountSheet({ visible, onClose })` inside the existing `Sheet` primitive:
- Reads `users/{uid}` once with `getDoc` when it opens, seeding `name` and `city`.
- Two `Input`s with `Text variant="label"` labels `Display name` and `Home city`, each with its muted helper line under it: `Shown on tickets you buy from now on.` and `Used to rank shows near you when your location is off.`, `maxLength={80}` on both.
- `Save` `Button` calling the identical payload shape as Task 9:

```ts
const { data } = await callFn<UpdateAccountInput, UpdateAccountResult>("updateAccount", {
  displayName: name.trim(), homeCity: city.trim() === "" ? null : city.trim(),
});
```
  then re-reading the user doc, showing `Saved.` (or `We could not place that city; ranking will not use it.` when `data.geocoded === false`) as a muted line, and closing on the fan's own dismiss rather than automatically, so the message is readable.
- Failures render through `ErrorBanner` with the server message, never `Alert.alert`.

- [ ] **Step 2: The Account row**

In `apps/mobile/src/shell/AccountScreen.tsx`, add an `Edit account` `Pressable` row as the FIRST row inside the existing `Card` (above Appearance), in the same shape as the Following / Saved searches / Payouts rows (label plus `IconCaretRight`, `accessibilityRole="button"`, `accessibilityLabel="Edit account"`), opening the sheet from local `useState`. Mount `<EditAccountSheet visible={editing} onClose={() => setEditing(false)} />` at the end of the screen's outer `View`.

- [ ] **Step 3: The deck fallback**

`useHomeGeo(uid)` reads `users/{uid}` once with `getDoc` and returns `{ homeCity, homeGeo, loading }`, nulls on error.

In `DeckScreen.tsx`, the deck's position resolution becomes device first, home city second:

```ts
  // SP11: device position when the fan granted it, else the account's saved
  // home city point. `location: null` is still never sent (the callable
  // rejects it), so with neither the key is simply omitted and the deck is
  // unranked by distance, exactly as before.
  const position = location.location ?? home.homeGeo;
  ...
      const input: GetDiscoverDeckInput = {};
      if (position) input.location = position;
```

`loadPage`'s dependency list gains `position`, and the first fetch waits for both `location.resolving` and `home.loading` to clear so the opening page is ranked once rather than fetched twice (the reason the existing code already waits on `resolving`).

- [ ] **Step 4: The prompt line**

`LocationPromptSheet` gains an optional `showHomeCityHint?: boolean` prop and renders, under the existing body line when it is true:

```tsx
        <Text muted>Or set a home city under Account.</Text>
```

`DeckScreen` passes `showHomeCityHint={!home.homeCity}`, so a fan who already set one is not told to set one.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/mobile/src/account apps/mobile/src/shell/AccountScreen.tsx apps/mobile/src/discover
git commit -m "feat(mobile): account editor sheet and the home-city fallback for the deck"
```

---

### Task 14: Mobile curator event editor: doors, age, and artist tags

**Files:**
- Create: `apps/mobile/src/events/EventDetailsFields.tsx`, `apps/mobile/src/events/LineupEditor.tsx`, `apps/mobile/src/events/ArtistPickerSheet.tsx`
- Modify: `apps/mobile/app/(curator)/events/event/[eventId].tsx`

**Interfaces:**
- Consumes: `AGE_RESTRICTIONS`, `AGE_RESTRICTION_LABEL`, `EVENT_DOORS_MESSAGE`, `DOORS_MAX_BEFORE_START_MS`, `TaggedActStatus`; `updateEvent`, `tagEventArtist`, `untagEventArtist`; the `search` callable's `curator` face through `src/search/searchApi.ts`; `Card`, `Input`, `Chip`, `Button`, `Text`, `Sheet`, `ErrorBanner`.
- Produces: `EventDetailsFields({ event, onSave, busy, error })`, `LineupEditor({ event, onChange })`, `ArtistPickerSheet({ visible, onClose, onPick })`.

This screen has no content editor today (its own header records that as a deliberate SP6 scoping decision), so this task adds exactly the two surfaces the spec names for it, doors and age plus the lineup, and nothing else: title, description, and dates stay web-edit-only.

- [ ] **Step 1: Doors and age**

`EventDetailsFields` renders inside a `Card` titled `Details`:
- Doors, as three `Input`s in the shape `src/gigs/GigForms.tsx`'s `OneOffDateTimeFields` already established on this platform (there is no date-picker dependency in this app and this task adds none): `Date (YYYY-MM-DD)` with `keyboardType="numbers-and-punctuation"`, then `HH` and `MM` with `keyboardType="number-pad"`. Seeded from `event.doorsAt` when set, from the event's start date with blank time when not. A `Clear` `Button` empties all three (doors is optional).
- Age, as the `Chip` row (mobile's segment control per `sp8-rulings.md` ruling 14), one chip per `AGE_RESTRICTIONS` entry labelled from `AGE_RESTRICTION_LABEL`, with `accessibilityState.selected` which `Chip` already sets.
- A `Save` `Button` that composes the epoch ms from the three fields in local time, applies the same client-side hint as web (`doorsAt >= startsAt` or more than `DOORS_MAX_BEFORE_START_MS` before it shows `EVENT_DOORS_MESSAGE` in an `ErrorBanner` and does not call), then calls `updateEvent` with the screen's existing full-replace payload shape (the one `savePoster` already uses) plus `doorsAt` and `ageRestriction`, and the CURRENT `event.lineup` so the reconcile path sees the stored tags unchanged.

- [ ] **Step 2: The lineup editor**

`LineupEditor` renders inside a `Card` titled `Lineup`, replacing the screen's current read-only lineup card:
- One row per act: the name, plus a muted meta line, `(booked act)` for a booking act and `Pending` / `Accepted` / `Declined` for a tagged one (the same three labels web uses).
- `Add act` (a name `Input` plus a `Button`, appending `{ kind: "external", name }`) and `Tag a GateKeep artist` (opening `ArtistPickerSheet`), matching web's two paths.
- A tagged act row offers `Untag` (calling `untagEventArtist`); any act offers remove, which drops it locally and saves through `updateEvent`.
- Every mutation that is not a tag or untag saves through the same full-replace `updateEvent` call as `EventDetailsFields`, so one code path writes this doc.

`ArtistPickerSheet` is the `Sheet` twin of web's dialog: a query `Input`, debounced 300 ms, calling the `search` callable's `curator` face through `src/search/searchApi.ts`, rows showing name then a muted `city · genres` line, `onPick(profileId, name)` calling `tagEventArtist` and closing. Empty, loading, and error states use the screen's existing `Text muted` and `ErrorBanner` treatments.

- [ ] **Step 3: Wire the screen**

In `app/(curator)/events/event/[eventId].tsx`, mount `<EventDetailsFields ... />` under the existing date card and replace the read-only lineup card with `<LineupEditor ... />`, both gated on the existing `editable` flag (draft or published). The `onSnapshot` subscription already in place re-renders both after every save, so neither component keeps its own copy of the server state beyond its draft inputs.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/mobile/src/events "apps/mobile/app/(curator)/events/event/[eventId].tsx"
git commit -m "feat(mobile): doors, age, and the artist tag lineup editor on the curator event screen"
```

---

### Task 15: Mobile event screen and the all-ages chip

**Files:**
- Modify: `apps/mobile/app/event/[eventId].tsx`, `apps/mobile/src/search/FilterChips.tsx`

**Interfaces:**
- Consumes: `EventDoc.doorsAt`/`ageRestriction`, the `tagged` act variant, `respondToArtistTag`, `AGE_RESTRICTION_LABEL`, `ARTIST_TAG_BANNER_TITLE`, `SearchFilters.allAges`; `Badge`, `Card`, `Button`, `Text`, `ErrorBanner`, `Chip`.
- Produces: the fan-facing rendering of both new event fields and the mobile half of the tag response flow.

- [ ] **Step 1: Doors, badge, and accepted tags**

In `app/event/[eventId].tsx`:
- `resolveLineup` gains the same widening web took: an act is linkable when `act.kind === "booking"` or `act.kind === "tagged" && act.status === "accepted"`, and only linkable acts resolve a handle. A pending or declined tag renders as a plain `Text`, exactly as an external act does, and the existing `router.push({ pathname: "/artist/[handle]", ... })` row shape is unchanged for the linkable ones.
- Under the existing date and time card lines, when `event.doorsAt != null`, one muted line rendering the exact string `` `Doors ${formatEventTime(event.doorsAt)}` ``. `src/events/eventDisplay.ts` exports `formatEventTimeRange` (a range, not a single time), so add a `formatEventTime(ms: number): string` beside it that formats one instant with the same `Intl` options that function already uses, and export it; never format inline in the screen.
- Beside the title, when `event.ageRestriction` is `18_plus` or `21_plus`, `<Badge label={AGE_RESTRICTION_LABEL[event.ageRestriction]} />`. All ages renders nothing.

- [ ] **Step 2: The tag banner**

Above the poster, for each `pending` tagged act whose musician profile lists the signed-in uid as an `admin` member (a `getDoc` on `profiles/{id}/members/{uid}`, the same self-read the rules allow), render a `Card` with `Text variant="label"` = `You were tagged on this lineup` and two `Button`s, `Accept` and `Decline`, calling `callFn("respondToArtistTag", { eventId, musicianProfileId, accept })`. After a response the card body becomes `Accepted` or `Declined`; a failure renders through `ErrorBanner` with the server message.

- [ ] **Step 3: The all-ages chip**

In `apps/mobile/src/search/FilterChips.tsx`, beside the existing `freeOnly` chip and gated the same way on the face's allowed keys:

```tsx
        {has("allAges") && (
          <Chip label="All ages only" active={!!filters.allAges}
            onPress={() => onChange({ ...filters, allAges: !filters.allAges })} />
        )}
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/mobile/app/event apps/mobile/src/search/FilterChips.tsx apps/mobile/src/events/eventDisplay.ts
git commit -m "feat(mobile): doors line, age badge, artist tag banner, and the all-ages search chip"
```

---

### Task 16: README, HANDOFF, and the gate counts

**Files:**
- Modify: `README.md`, `docs/superpowers/HANDOFF.md`

- [ ] **Step 1: README**

- The env-var table gains four server-only rows for the web app, each marked "server only, never NEXT_PUBLIC": `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256`, each described as "read at request time by the deep-link verification route; the file 404s while any of the pair is unset". The mobile table gains `EXPO_PUBLIC_SITE_URL` ("the web origin share links are built from; the Share button is hidden while it is unset"). `NEXT_PUBLIC_SITE_URL`'s existing row gains a note that share links now read it too.
- A "Sub-project 11 launch checklist (SP7 reconciliation)" after the 5c one: choose the domain and replace `REPLACE_WITH_LINK_DOMAIN` in `app.json`; set `NEXT_PUBLIC_SITE_URL` and `EXPO_PUBLIC_SITE_URL`; set the four verification env values on the web host and confirm both well-known URLs resolve with a 200 and the right JSON; a new EAS build (associated domains and intent filters are native config); no new composite index and no new Stripe configuration.
- A "Sub-project 11 smoke checklist (SP7 reconciliation)": share from the web event page and profile page (native sheet and the clipboard fallback), share from all three mobile screens, open a shared `/e/` and `/u/` link cold and warm; set a home city and confirm Discover ranks by it with location off on both platforms and that "Ranked near {city}" links to the account card; edit a display name and confirm a NEW ticket carries it and an old one does not; set doors and an age on an event and confirm the line and the badge on both platforms plus `doorTime` in the page source; tag an artist on a draft, publish, accept from the other account, and confirm the artist page, the search index, a show post, and the follower announce; decline and untag; the "All ages only" filter on both platforms including a saved search alert.

- [ ] **Step 2: HANDOFF**

- The merged list gains "11. SP7 reconciliation (`sp11-rulings.md`): sharing and deep links, web location plus the home-city fallback, the account editor, doors and age, artist tags" after item 5c.
- The Roadmap's "From the SP7 reconciliation" block is retired (all five bullets ship here); the roadmap leads with Messaging and the follow-ons.
- The "Audit context" paragraph's "the five remaining gaps ... are tracked in the roadmap above" sentence becomes "closed by sub-project 11".
- The standing tripwires gain item 8: "`updateAccount` is the only writer of `users/{uid}.displayName`, `.homeCity`, and `.homeGeo`; the owner rule allows `photoUrl` alone (`sp11-rulings.md`)" and item 9: "`eventArtistTags.ts` is the only writer of a `tagged` lineup act; `updateEvent` reconciles what it finds and refuses an invented tag, so a curator can never fake an artist's public linkage."
- The owner-owed table gains rows for the link domain, the four verification env values, the two `SITE_URL` values, the new EAS build, and the sub-11 device smoke.
- The Dev environment quickstart's gates line gets the MEASURED counts from Step 3; do not write a number that was not measured.

- [ ] **Step 3: Run every gate and record the counts**

`pnpm typecheck` (5/5); `pnpm --filter @gatekeep/shared test`; `pnpm --filter @gatekeep/web test`; the full `pnpm emu:test` through the detached runner; `pnpm emu:rules`; `pnpm --filter @gatekeep/web lint` and `build`; `pnpm --filter @gatekeep/mobile lint` and `expo export --no-bytecode`. Every count must be strictly above the current recorded totals (shared 209, web 7, `emu:test` 917, `emu:rules` 137), and every pre-existing test must still pass.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/HANDOFF.md
git commit -m "docs: sub-project 11 launch and smoke checklists, env rows, handoff update"
```

---

## Self-review

**1. Spec coverage.**

| Spec section | Task |
| --- | --- |
| 3.1 Share button, link shape | 7 (web), 12 (mobile) |
| 3.1 Incoming links, `/e/` and `/u/` mapping, resolver screen | 12 |
| 3.1 `app.json` associated domains and intent filters | 12 |
| 3.1 Well-known route handlers, env names, README table | 7, 16 |
| 3.2 Web "Use my location" chip through `getDiscoverDeck` | 8 |
| 3.2 Home-city fallback, "Ranked near {homeCity}", mobile sheet line | 8 (web), 13 (mobile) |
| 3.3 Web account card on `/dashboard` | 9 |
| 3.3 Mobile "Edit account" row and sheet | 13 |
| 3.3 `updateAccount`, errors, re-read, no backfill | 3, 9, 13 |
| 3.4 Doors and age in both editors | 10 (web), 14 (mobile) |
| 3.4 Doors line and age badge on both public pages | 11 (web), 15 (mobile) |
| 3.4 `eventJsonLd` `doorTime` | 11 |
| 3.4 `ageRestriction` in the show projection, the "All ages only" filter, saved-search alerts | 1 (shared `matchesFilters`), 6 (projection), 11 and 15 (the controls) |
| 3.5 Lineup editor's two paths, picker, statuses, remove | 10 (web), 14 (mobile) |
| 3.5 Public rendering of pending, accepted, declined | 11 (web), 15 (mobile) |
| 3.5 `artist_tag` notification, the banner, accept and decline | 1, 5 (backend), 11 and 15 (banners) |
| 3.5 On accept: projection, index, posts, reschedule, follower announce | 5, 6 |
| 4 Data model (`homeGeo`, `doorsAt`, `ageRestriction`, `EventAct`, `SearchIndexDoc`, `SearchFilters`, `NotificationDoc`, `notificationHref`) | 1 |
| 4 Rules and the index pre-flight | 2, 6 (step 1) |
| 5 `updateAccount` | 3 |
| 5 `getDiscoverDeck` unchanged contract, clients pass device then browser then `homeGeo` | 8, 13 (verified by Task 3's fourth case) |
| 5 Event validation | 4 |
| 5 The three tag callables and the `publishEvent` hook | 5 |
| 5 Search index | 6 |
| 5 Well-known handlers | 7 |
| 6 Messages | 1 (constants), consumed verbatim in 3, 4, 5, 7 to 15 |
| 7 Testing: emulator, rules, shared, client gates | 3, 4, 5, 6 (emulator), 2 (rules), 1 (shared), 7 to 15 (client gates) |
| 8 Out of scope | Nothing in this plan touches profile photos, per-event timezones, artist-initiated requests, tagging curators, ticket-name backfill, a gig or search share sheet, or messaging |
| 9 Owner-owed after merge | 16 |

No spec requirement is left without a task.

**2. Placeholder scan.** No "TBD", "similar to Task N", "add appropriate handling", or bare "write tests for the above". Every code step carries the actual code or the exact copy. Three steps deliberately describe an edit against a file the implementer has open rather than repeating a long unchanged body: Task 5 step 5's `events.ts` seams (three named insertion points with their code), Task 11 step 3's `resolveLineup` widening (both changed expressions given), and Task 14 step 1's reuse of `OneOffDateTimeFields`' three-input shape (named, with its keyboard types).

**3. Type consistency.** `AgeRestriction` and `AGE_RESTRICTIONS` are defined in Task 1 and used by name in Tasks 4, 6, 10, 11, 14, 15. `TaggedActStatus` is defined in Task 1, written only in Task 5, and read in 10, 11, 14, 15. `deriveLineupMusicianProfileIds` moves to `eventArtistTags.ts` in Task 5 and is imported by `events.ts` there, so exactly one definition survives. `reconcileTaggedActs(stored, incoming)` has one signature, used once. `UpdateAccountInput`/`UpdateAccountResult` are declared in Task 1, implemented in Task 3, and called with the same field names in Tasks 9 and 13. `useHomeGeo(uid)` returns `{ homeCity, homeGeo, loading }` on both platforms (Tasks 8 and 13), two implementations, one shape. `ShareButton({ path, title })` has the same props on both platforms (Tasks 7 and 12). The `artist_tag` dedupe key is `artist_tag:{eventId}:{musicianProfileId}` in Task 5's helper, its test, and the publish hook; the accept-time announce key is `announce:{eventId}` everywhere. `notifyProfileAdmins` gains an optional third parameter in Task 5 and its one pre-existing caller passes two arguments.

**4. Sequencing for the controller.** Tasks 1 to 6 are strictly sequential: 2 to 6 all consume Task 1's shared exports, Task 5 builds on Task 4's validator, and Task 6 needs Task 5's projection rule. After Task 6, the two client tracks are independent of each other and can run in parallel: web is 7, 8, 9, 10, 11 (7 before 11 only because 11 edits the same title row 7 introduces; 8, 9, and 10 are independent of each other and of 7); mobile is 12, 13, 14, 15 (12 before 15 for the same reason, on `app/event/[eventId].tsx`; 13 and 14 are independent). Task 16 runs last and needs every gate. Pre-flight before Task 1: copy `functions/.secret.local` from the main checkout into this worktree, run `pnpm install` and `pnpm --filter @gatekeep/web exec next typegen`, and confirm port 8080 is free. Pre-flight before Task 6: the index-file check that task's own step 1 mandates. Two files are touched by tasks in both tracks' sequences and by the backend track (`packages/shared/src/types.ts` in Task 1 only, `functions/src/events.ts` in Tasks 4 and 5 only), so no cross-track merge conflict is expected.

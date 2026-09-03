# GateKeep Sub-project 8: Search (design)

Status: approved in brainstorm on 2026-09-02. This document is the binding authority for
sub-project 8; the implementation plan argues from it. It contains no em dashes, and neither
may anything built from it (code, comments, copy, docs, commit messages).

Binding context: `DESIGN.md` (repo root) for every visual decision, the antislop skills for UI
and copy, `docs/superpowers/sp7-rulings.md` for follows, notifications, and the discover
surfaces this sits beside, `docs/superpowers/sp3-rulings.md` and `sp4-rulings.md` for gigs and
bookings, and `docs/superpowers/sp6-rulings.md` for events. The whole-project audit
(`docs/superpowers/audit-2026-09-01.md`, section 4 and `audit/inheritance-sp7-sp8-5c.md`)
assigned every item below to sub-project 8; this spec is the ruling on each.

Sequencing: this spec was written while sub-project 10B (hardening branch B) was still in
flight. 10B changes event and gig lifecycle (unpublish cascade, deletion refusals, dispute
handling). Nothing here depends on how 10B lands, because every index maintainer keys off the
public status fields (`profiles.status`, `events.status`, `gigs.status`, `tracks.status`,
`bookings.status`) that 10B preserves. The plan's pre-flight scan must be re-run against the
merged main before Task 1 is dispatched.

## 1. Goal

Replace the placeholder-grade directories and the mobile "coming soon" Search tab with real
search: one server-built index over every public thing in the metro, one callable, and three
role-specific faces. Fans search shows (with a map). Musicians search open gigs (with a map)
and venues. Curators search artists with booking-relevant filters. Saved searches alert users
in-app when something new matches. The web gains the SEO pack the audit listed (sitemap,
robots, JSON-LD, handle redirects, more reserved handles).

## 2. Owner decisions (from the brainstorm)

1. **Audience and faces**: everyone, but each role sees a different face. Fans: shows only.
   Musicians: open gigs on a map plus venues. Curators: artists by name or genre, no map.
2. **Fan face**: text plus filters plus a list-or-map toggle; the pins are the same results.
3. **Musician face**: two segments, Gigs (list with map toggle) and Venues (list only). Both
   replace the current Find Gigs internals.
4. **Curator filters** beyond genre: act size, city (home base), has audio, available on a date.
5. **Extra scope, all in**: saved searches with alerts, the web SEO pack, a per-user daily
   search budget, and housekeeping (unused gigs index, reserved handles).
6. **Engine**: a Firestore-native index maintained by triggers, queried by one callable, ranked
   in memory. No search vendor.
7. **Maps**: Google Maps JavaScript API on web; react-native-maps on mobile (Apple Maps on
   iOS, Google Maps on Android).
8. **Plan shape**: one spec, one plan, ordered so the index, callable, and three faces land
   first, then maps, then saved searches, then the SEO pack and housekeeping last.

## 3. Surfaces

### Faces (both platforms)

Every face is a search box, a filter row, and a result list. The `face` value is what the
callable receives.

| face | kind searched | text matches | filters |
|---|---|---|---|
| `fan` | `show` | show title, lineup act names, venue name, neighborhood | when, genres, free only, near me |
| `musician_gigs` | `gig` | gig title, venue name, neighborhood, city | when, genres, budget floor, near me |
| `musician_venues` | `venue` | venue name, handle, city, neighborhood | genres they book, near me |
| `curator` | `artist` | artist name, handle | genres, act size, city, has audio, available on |

Filter semantics:

- **when** (`tonight`, `weekend`, `month`, `any`; default `any`): `tonight` is now until the end
  of today; `weekend` is the coming Friday 17:00 through Sunday 23:59 (if today is Saturday or
  Sunday, this weekend); `month` is now plus 30 days; `any` is now onward. Day boundaries use
  `LAUNCH_TIMEZONE` (shared constant, see section 4).
- **genres**: up to 5 from `GENRES`; a result matches when it carries any of them.
- **free only**: `hasFreeTier` true.
- **near me**: requires a device location; keeps results with a geo within 25 km, and the
  distance term joins the ranking. Without a location the chip is disabled with the hint
  "Turn on location to search near you." Never stored server-side.
- **budget floor**: the gig's `budgetMaxCents` is at least the floor; gigs with no budget are
  excluded when the floor is set.
- **act size**: equality on `actSize`.
- **city**: case-insensitive equality on the artist's home city.
- **has audio**: at least one approved track.
- **available on** (a calendar date): the artist has no confirmed booking and no published
  lineup appearance on that date.

Results page 20 at a time ("Show more"). The map toggle (fan and musician gigs faces only)
shows every pin for the current query and filters, up to 200, and tapping a pin opens a
compact card for that result with the same primary action as the list row.

Empty and error copy (shared constants, section 7): no results, budget reached, location off.

### Mobile (`apps/mobile`)

- **Fan Search tab** (`app/(fan)/search.tsx`): the fan face replaces the stub. Show rows and
  pin cards push `/event/[eventId]`.
- **Musician Find Gigs tab** (`app/(musician)/gigs.tsx`): the musician face with a Gigs |
  Venues segment control. Gig rows open the existing in-page gig detail and apply sheet, which
  moves out of `src/bookings/GigBrowse.tsx` into `src/bookings/GigDetailSheet.tsx` so both the
  old query path (deleted) and the new results share it. Venue rows push `/venue/[handle]`.
- **Curator Find Musicians tab** (`app/(curator)/musicians.tsx`): the curator face. Artist rows
  push `/artist/[handle]`.
- **Saved searches**: a "Save search" action in the filter row of every face once a query or
  any non-default filter is set; the list lives on Account ("Saved searches") with Delete.
  Tapping a saved search opens its face with the query and filters restored.
- **Location**: reuse `useDeckLocation` from sub-7 (request-scoped, rounded, never stored).
- **Map**: `react-native-maps` `MapView` with one marker per pin, clustered by the library's
  default behaviour only (no clustering dependency). Pin tap shows a bottom card.
- **Notification taps**: `saved_search_match` opens `/event/[eventId]` when `refKind` is
  `event`, the gig detail sheet route when `gig` (the musician Find Gigs tab with the gig
  preselected via a `gigId` param), and `/artist/[handle]` when `profile` (handle resolved from
  `refId` with one `get`, as `new_music` already does).
- **Portfolio**: a "Home city" field on the portfolio editor (musician tab), optional.

### Web (`apps/web`)

- **`/search`** (signed-in, same gate pattern as `/discover`): renders the face for the
  viewer's role. No approved profile: fan face. Approved musician profile: musician face.
  Approved curator profile: curator face. Both: a Gigs | Venues | Artists segment control.
  "Search" joins the header nav for every signed-in role, right after Discover.
- **`/gigs`** keeps its URL and renders the musician face's Gigs | Venues segments; the client
  Firestore query in `src/bookings/GigBrowse.tsx` is deleted, not kept beside the new path.
- **`/dashboard/curator/[profileId]/musicians`** keeps its URL and gate and renders the curator
  face; `src/bookings/MusicianBrowse.tsx`'s query path is deleted the same way.
- **Result rows**: show rows link to `/e/[eventId]`; gig rows to `/gigs/[gigId]`; venue and
  artist rows to `/u/[handle]`.
- **Map**: `@googlemaps/js-api-loader` behind `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`. When the
  key is absent the map toggle is not rendered at all (no broken map, no console noise).
- **Saved searches**: the same "Save search" action; the list lives on `/dashboard` in a
  "Saved searches" card with Delete. The inbox row for `saved_search_match` links to `/e/[id]`,
  `/gigs/[id]`, or `/u/[handle]` by `refKind`.
- **Portfolio editor** (`/dashboard/portfolio/[profileId]`): "Home city" field.
- **`/admin`**: a "Rebuild search index" button calling `backfillSearchIndex`, showing the
  returned counts.

## 4. Data model

### Search index (server-only)

`searchIndex/{kind}_{sourceId}`, one doc per public thing. Never client-readable. Kinds:
`show` (published event that has not ended), `gig` (open gig), `artist` (approved musician
profile), `venue` (approved curator profile of any subtype; the deck already calls these
venues).

```ts
export type SearchKind = "show" | "gig" | "artist" | "venue";
export interface SearchIndexDoc {
  kind: SearchKind;
  sourceId: string;
  handle: string | null;            // artist, venue
  title: string;                    // show/gig title, profile name
  subtitle: string;                 // show: venue name; gig: venue name plus neighborhood; artist: genres; venue: city
  words: string[];                  // whole normalized words from the text sources
  tokens: string[];                 // prefixes of every word, 2 to 12 chars, capped at 150
  genres: string[];                 // show: EventDoc.genres; gig: wants.genres; artist: portfolio.genres; venue: lookingFor.genres
  city: string | null;
  cityLower: string | null;
  neighborhood: string | null;
  geo: { lat: number; lng: number } | null;
  startsAt: number | null;          // show, gig
  endsAt: number | null;            // show
  priceFromCents: number | null;    // show
  hasFreeTier: boolean;             // show
  budgetMinCents: number | null;    // gig
  budgetMaxCents: number | null;    // gig
  actSize: ActSize | null;          // artist (from private/booking preferences, actSize only)
  hasAudio: boolean;                // artist
  busyDays: string[];               // artist, YYYY-MM-DD in LAUNCH_TIMEZONE, next 180 days
  relatedProfileIds: string[];      // show: curator plus lineup profile ids; gig: curator; artist/venue: self
  followerCount: number;            // artist, venue
  imagePath: string | null;         // show poster, artist avatar, venue first photo, gig null
  updatedAt: number;
}
```

Text sources per kind: show = title, every lineup act name, `location.venueName`,
`location.neighborhood`; gig = title, `location.venueName`, `location.neighborhood`,
`location.city`; artist = name, handle; venue = name, handle, `curator.location.city`,
`curator.location.neighborhood`. Gig and show geo is the public (already coarsened when
`addressVisibility` is `neighborhood`) location; the private address subdoc is never read by
any maintainer.

`actSize` is the one field read from `profiles/{id}/private/booking`, and only that field. It
was already shown by the placeholder musicians directory, so exposing it through search adds
nothing new.

Token normalization (shared, `packages/shared/src/search.ts`): NFD, strip combining marks,
lowercase, split on anything that is not a letter or digit, drop words under 2 chars, keep at
most 40 words. `words` is that list deduplicated. `tokens` is every prefix of length 2 through
`min(len, 12)` of every word, deduplicated, capped at 150 entries (longest words trimmed last
so short names always index fully). Query normalization is the same pipeline, then each word
truncated to 12 chars, at most 10 words. A query with zero surviving words is "no text".

`LAUNCH_TIMEZONE` already exists in shared (`types.ts`, "America/New_York") and is what every
gig and show time already displays in; the owner confirms it before launch (section 10). Day
keys come from `Intl.DateTimeFormat` with that zone, and the day-start helper the web gig
browse already carries (`launchTzDayStartMs` in `apps/web/src/bookings/BookingForms.tsx`) moves
into shared so the callable, the alert matcher, and both clients bucket days identically.

### Musician home city (additive to sub-2)

`ProfileDoc.portfolio.location: { city: string; geo: { lat: number; lng: number } | null;
geocodedFrom: string } | null`, optional on the type so existing docs stay valid. Set through
`updatePortfolio` with a new optional `city?: string | null` on `PortfolioUpdateInput`
(`null` clears). The handler geocodes the city string exactly as the planner path of
`updateCuratorProfile` does: `consumeGeocodeBudget(uid)` then `getGeocoder().geocode(city)`,
skipped when `geocodedFrom` already equals the input. City length follows `MAX_CITY_LENGTH`.

### Saved searches

`savedSearches/{id}` (auto id):

```ts
export interface SavedSearchDoc {
  uid: string;
  face: SearchFace;
  kind: SearchKind;                 // derived from face, indexed for the alert scan
  q: string;                        // raw text as typed, max 80 chars
  filters: SearchFilters;           // nearMe is stored as false; alerts never have a location
  label: string;                    // server-built from q and filters, see savedSearchLabel
  createdAt: number;
  lastMatchedAt: number | null;
}
```

Cap 10 per user. Rules: owner-read (`resource.data.uid == request.auth.uid`), all writes
callable-only.

### Notifications

`NotificationDoc.kind` gains `saved_search_match`. `refId` is the source id (eventId, gigId,
or profileId) and a new optional `refKind?: "event" | "gig" | "profile"` says which; both
platforms' inbox rows route on it. Existing kinds are untouched.

### Search budget

`searchBudgets/{uid}`: `{ date: "YYYY-MM-DD" (UTC), count }`, the exact shape and transaction
of `geocodeBudgets`. `SEARCH_DAILY_BUDGET = 300`. Explicit deny block in rules like
`geocodeBudgets`.

### Shared types for the callable

```ts
export type SearchFace = "fan" | "musician_gigs" | "musician_venues" | "curator";
export type SearchWhen = "tonight" | "weekend" | "month" | "any";
export interface SearchFilters {
  when?: SearchWhen;
  genres?: string[];
  freeOnly?: boolean;
  nearMe?: boolean;
  budgetMinCents?: number;
  actSize?: ActSize;
  city?: string;
  hasAudio?: boolean;
  availableOn?: string;             // YYYY-MM-DD
}
export interface SearchInput {
  face: SearchFace;
  q: string;
  filters: SearchFilters;
  location: { lat: number; lng: number } | null;
  page: number;                     // 0-based, 20 per page
  includePins: boolean;
}
export interface SearchResult {
  id: string; kind: SearchKind; handle: string | null;
  title: string; subtitle: string; imagePath: string | null;
  genres: string[]; city: string | null; neighborhood: string | null;
  startsAt: number | null; endsAt: number | null;
  priceFromCents: number | null; hasFreeTier: boolean;
  budgetMinCents: number | null; budgetMaxCents: number | null;
  actSize: ActSize | null; hasAudio: boolean; followerCount: number;
  distanceMeters: number | null;
}
export interface SearchPin {
  id: string; kind: SearchKind; title: string; subtitle: string;
  geo: { lat: number; lng: number }; startsAt: number | null;
}
export interface SearchOutput {
  items: SearchResult[]; page: number; hasMore: boolean;
  matched: number;                  // in-memory result count after filters, capped by the candidate cap
  pins?: SearchPin[];               // only when includePins
}
```

### Indexes (new composites)

- `searchIndex`: `(kind asc, tokens array, startsAt asc)`, `(kind asc, tokens array,
  followerCount desc)`, `(kind asc, startsAt asc)`, `(kind asc, followerCount desc)`, and
  `(kind asc, endsAt asc)` for the expiry sweep.
- `savedSearches`: `(kind asc, createdAt asc)` for the alert scan; `(uid asc, createdAt desc)`
  for the owner's list.
- `bookings`: none. The busy-day rebuild's confirmed-bookings query is equality-only
  (`musicianProfileId`, `status`), which Firestore serves by merging single-field indexes.

## 5. Backend (`functions/src`)

### Projections and maintainers (`searchIndex.ts`)

Four pure projection functions, unit-tested without the emulator:

- `projectShow(eventId, event): SearchIndexDoc | null` (null unless `status === "published"`
  and `endsAt >= now`).
- `projectGig(gigId, gig): SearchIndexDoc | null` (null unless `status === "open"`).
- `projectArtist(profileId, profile, extras: { hasAudio, busyDays, actSize })` (null unless
  `type === "musician"` and `status === "approved"`).
- `projectVenue(profileId, profile)` (null unless `type === "curator"` and `status ===
  "approved"`).

One writer, `applyProjection(ref, doc | null)`: `set` when a doc comes back, `delete` when
null. Deletes of a missing doc are no-ops.

Triggers (all `onDocumentWritten`, region `us-central1`):

- `profiles/{profileId}`: rebuilds the artist or venue doc. Artists go through
  `rebuildArtistIndex(profileId)`, which reads the profile, one approved track (`limit(1)`),
  the `actSize` field of `private/booking`, confirmed bookings for the profile (then the gigs
  those bookings point at, capped at 50, for `startsAt`), and published events whose
  `lineupMusicianProfileIds` contains the profile with `startsAt` from now on (the sub-6
  index). Busy days are the day keys of those start times within the next 180 days.
- `profiles/{profileId}/tracks/{trackId}`: on any status change, `rebuildArtistIndex`.
- `events/{eventId}`: rebuilds the show doc, then `rebuildArtistIndex` for every profile id in
  the union of the before and after `lineupMusicianProfileIds`.
- `gigs/{gigId}`: rebuilds the gig doc.
- `bookings/{bookingId}`: when `status` enters or leaves `confirmed`, `rebuildArtistIndex` for
  `musicianProfileId`.

Every trigger body is wrapped in try/catch with `console.error`, the codebase pattern for
post-commit fan-out, so a poisoned doc never retries forever. `followerCount` changes already
write the profile doc, so the profile trigger covers them.

### Expiry

`runDailySweep` gains a step: delete `searchIndex` docs with `kind == "show"` and `endsAt`
older than 24 hours. Open gigs that pass their start are closed by the existing step 3, and the
gig trigger deletes their index doc. Wrapped like the other steps.

### Backfill

`backfillSearchIndex` (admin-only callable, `timeoutSeconds: 540`): pages `profiles`,
`events`, and `gigs` by `__name__` in pages of 300 (the `backfillDisplayNameLower` shape),
applies the projection for each, and returns `{ artists, venues, shows, gigs, deleted }`.
Idempotent; safe to re-run.

### `search` callable

Input `SearchInput`; auth required. Steps, in order:

1. Validate: `q` at most 80 chars; `page` an integer 0 to 50; `genres` at most 5 and all in
   `GENRES`; `availableOn` matches `YYYY-MM-DD`; `budgetMinCents` a non-negative integer; the
   face's filters only (unknown keys rejected with `invalid-argument`). `location` is
   `{lat, lng}` finite numbers or `null`; anything else is `invalid-argument` (the sub-7
   `location: null` lesson).
2. `consumeSearchBudget(uid)`; on exhaustion `resource-exhausted` with `SEARCH_LIMIT_MESSAGE`.
3. Candidate query on `searchIndex` where `kind == kindForFace(face)`, plus:
   - with text: `tokens array-contains-any` the query words (up to 10);
   - `show` and `gig`: `startsAt >= now`, and `startsAt <= windowEnd` when `when` is not
     `any`, ordered by `startsAt asc`;
   - `artist` and `venue`: ordered by `followerCount desc`;
   - `limit(300)`.
4. In memory: with text, keep only docs where every query word is in `tokens` (AND); apply the
   face's remaining filters (genres, freeOnly, budget floor, actSize, cityLower, hasAudio,
   availableOn against `busyDays`, nearMe within 25 km when a location was sent); compute
   `distanceMeters` with the shared `haversineMeters` when a location was sent.
5. Load the caller's follows once (the sub-7 `follows` collection, `uid ==`, cap 500) and
   score each result deterministically:
   - text: +3 per query word present in `words`, else +1 for the prefix match;
   - soonness (show, gig): `2 * (1 - min(hoursUntilStart, 720) / 720)`;
   - distance (when a location was sent and the doc has geo):
     `1.5 * (1 - min(distanceMeters, 20000) / 20000)`;
   - followers (artist, venue): `min(2, log10(1 + followerCount))`;
   - followed by you: +2 when any `relatedProfileIds` entry is a followed target, +1 when any
     genre is a followed `genre:<name>` target;
   - has audio (artist): +0.5.
   Ties break on `startsAt asc`, then `title`, then id. No randomness.
6. Sort, slice `page * 20` to `page * 20 + 20`, set `hasMore`, `matched`; when `includePins`,
   also return up to 200 `SearchPin`s from the full sorted result set for docs with geo.

Nothing from `searchIndex` reaches a client except through `SearchResult` and `SearchPin`.

### Saved search callables and alerts (`savedSearches.ts`)

- `saveSearch({ face, q, filters })` validates like `search`, forces `nearMe` false, builds
  `label` with the shared `savedSearchLabel`, enforces the cap of 10 (`SAVED_SEARCH_LIMIT_MESSAGE`,
  `failed-precondition`), returns `{ id }`. Exact duplicates (same face, normalized q, and
  filters) return the existing id instead of a second doc.
- `deleteSavedSearch({ id })`: owner only.
- `onSearchIndexCreated` (`onDocumentCreated("searchIndex/{id}")`): loads `savedSearches`
  where `kind == doc.kind` ordered by `createdAt asc`, at most 1000; for each, runs the shared
  `matchesSavedSearch(doc, saved, now)` (the same filter semantics as the callable minus
  distance, so the shared package owns the semantics once and both callers import them);
  on a match calls `notifyUser(uid, note, dedupeKey)` with kind `saved_search_match`, title
  "New match for a saved search", body `<title> matches "<label>"`, `refId` the source id,
  `refKind` by kind, and dedupe key `saved_search:${savedId}:${indexDocId}`; then updates
  `lastMatchedAt`. Wrapped in try/catch per saved search.

Index docs are deleted when their source stops being public and re-created when it returns,
so a re-opened gig fires the trigger again; the dedupe key keeps it to one notification.

### Housekeeping

- Remove the `gigs (bookedMusicianProfileId, status, startsAt)` composite from
  `firestore.indexes.json` after a grep of `functions/src`, `apps/web/src`, and
  `apps/mobile/src` shows no query that combines `bookedMusicianProfileId` with an ordered
  `startsAt`. If one exists, keep the index and record the ruling.
- `RESERVED_HANDLES` grows to: admin, administrator, gatekeep, gatekeeper, support, help, api,
  www, about, contact, legal, terms, privacy, login, signin, sign_in, signup, sign_up, join,
  account, settings, dashboard, search, discover, events, event, gigs, gig, tickets, ticket,
  artist, artists, venue, venues, u, e, app, mobile, web, root, system, staff, moderator, mod,
  official, team, null, undefined, test. Existing profiles are unaffected; validation runs on
  handle creation and change only.

## 6. Web SEO pack (`apps/web`)

- **`app/sitemap.ts`**: when `siteUrl` (the `layout.tsx` derivation) is unset, returns `[]`.
  Otherwise: `/`, `/join`, every approved profile as `/@<handle>` (cap 5000, `lastModified`
  from `updatedAt`), every published event with `endsAt` from now on as `/e/<id>`. Uses
  `getServerFirebase()` like the public page loaders.
- **`app/robots.ts`**: allow `/`, disallow `/dashboard`, `/admin`, `/tickets`, `/discover`,
  `/search`, `/sign-in`, `/design`, `/booking`; `sitemap` set only when `siteUrl` is set.
- **JSON-LD** (`src/seo/jsonLd.ts`, pure builders with unit tests, rendered as
  `<script type="application/ld+json">` from the server components):
  `musicianJsonLd(profile)` builds a `MusicGroup` (name, url, genre list, image);
  `curatorJsonLd(profile)` builds a `MusicVenue` for the venue subtype and an `Organization`
  otherwise (name, url, `address.addressLocality`);
  `eventJsonLd(event, tiers)` builds a `MusicEvent` (name, startDate, endDate, `location` as a
  `Place` with venue name and locality, `performer` list of `MusicGroup` names, `offers` per
  ticket tier with `priceCurrency` USD and `availability`, `eventStatus` `EventCancelled` when
  cancelled, image). Builders never emit fields whose source is missing.
- **Handle case**: `/u/[handle]` and `/u/[handle]/shows` `permanentRedirect` to the lowercase
  path when the raw segment is not already lowercase, before the loader runs.

## 7. Messages (shared, `messages.ts`)

- `SEARCH_LIMIT_MESSAGE = "You have reached today's search limit. Try again tomorrow."`
- `SAVED_SEARCH_LIMIT_MESSAGE = "You can keep up to 10 saved searches. Delete one to save another."`
- `SEARCH_EMPTY_MESSAGE = "Nothing matches yet. Try fewer filters or a shorter search."`
- `SEARCH_LOCATION_OFF_MESSAGE = "Turn on location to search near you."`

`savedSearchLabel(face, q, filters)` (shared): the quoted query when present, then filter
words joined with a middle dot: when (Tonight, This weekend, Next 30 days), genres, Free,
budget floor as a money sentence, act size, city, Has audio, the availableOn date. Empty query
and no filters is rejected before it gets here.

## 8. Testing

- `packages/shared/test/search.test.ts`: normalization (accents, punctuation, caps, the
  2-to-12 prefix window, the 150 cap trimming longest words last), query words (10 max,
  truncation), `matchesSavedSearch` per filter, `savedSearchLabel`, day keys across the
  `LAUNCH_TIMEZONE` midnight boundary, and the `when` windows on a Wednesday, a Saturday, and
  a Sunday.
- `functions/test/searchIndex.test.ts` (emulator): each projection; every maintainer
  transition (approve, reject, publish, cancel, end, open, fill, track approve, booking confirm
  and cancel, lineup change) creates or deletes the right doc; busy days; has audio; the sweep
  step; the backfill's counts and idempotency.
- `functions/test/searchRank.test.ts` (pure): scoring terms, tie-breaks, determinism.
- `functions/test/search.test.ts` (emulator): AND matching, every filter on every face, unknown
  filter rejection, `location` validation, paging and `hasMore`, `matched`, pins cap and geo
  requirement, the follow boosts, the budget exhausting on call 301 and resetting on a new day
  (injected clock), and that nothing outside `SearchResult`'s fields leaks.
- `functions/test/savedSearches.test.ts` (emulator): the cap, duplicate collapsing, owner-only
  delete, alert on create, no alert on non-match, one notification per saved search and doc
  across a delete and re-create, `lastMatchedAt`.
- `tests-rules/search.rules.test.ts`: `searchIndex` and `searchBudgets` denied to everyone
  including the owner; `savedSearches` owner-read, no client writes, no cross-user read.
- Web: `apps/web/src/seo/jsonLd.test.ts` and a sitemap builder test with a stubbed loader;
  typecheck, lint, build. Mobile: typecheck, lint, `expo export`.
- Gate counts in HANDOFF and README are updated to whatever the merged tree measures.

## 9. Out of scope (deliberate)

Typo tolerance and synonyms; search analytics or click ranking; a public (signed-out) web
search page; email or push-only alerts (alerts use the existing `notifyUser`, which already
sends Expo push on mobile); a curator-side map; an availability calendar beyond busy days;
marker clustering libraries; saved searches with a stored location; searching fans; a metro
selector (one launch metro).

## 10. Owner-owed after merge

- A Google Maps JavaScript API key restricted by HTTP referrer, set as
  `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` on the web host; without it the map toggle stays
  hidden.
- A Maps SDK for Android key restricted by package name and signing certificate, placed in
  `app.json` under `android.config.googleMaps.apiKey`.
- A new EAS dev build (react-native-maps joins the native deps) and the device smoke of both
  maps and the three faces; the same posture as sub-7's deck and sub-6's scanner.
- One `backfillSearchIndex` run from `/admin` after the first deploy, and confirmation that
  the new composite indexes finished building.
- Confirm `LAUNCH_TIMEZONE`.

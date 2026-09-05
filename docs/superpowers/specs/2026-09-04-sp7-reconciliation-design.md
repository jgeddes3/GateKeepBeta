# Sub-project 11: SP7 reconciliation (sharing, location, account, event fields, artist tags)

Design spec, 2026-09-04. Binding over the plan. No em dashes anywhere in this sub-project's output.

## 1. Goal

Close the five gaps the 2026-09-01 audit's SP7 brief left open after sub-projects 7, 8, and 10B:
a share affordance with links that open the app, a distance-aware Discover on web, an editable
fan account, doors time and age restriction on events, and artist linkage for events that are not
tied to a booking. Each gap is small on its own; together they finish the fan-facing discovery
story so that the next sub-project (Messaging and the optional follow-ons) is the last one.

## 2. Owner decisions (2026-09-04)

- All five gaps ship in this sub-project.
- The production web domain is not chosen yet. Universal and app links are wired through
  placeholders and finished by the owner; nothing fake ships.
- Web location: browser geolocation for the session plus a saved home city as the fallback on
  both platforms.
- Account editor: display name and home city only (no photo upload).
- Artist linkage: the curator tags a musician profile, the artist accepts, and the link becomes
  public only on accept.
- Doors time is optional; age restriction is a fixed set (all ages, 18+, 21+).
- Messaging and the optional follow-ons (antislop #10 to #29, hardening rows L62 to L80) form the
  final sub-project after this one unless something surfaces here.

## 3. Surfaces

### 3.1 Sharing and deep links

- **Share button** on the web event page (`/e/{eventId}`) and public profile page (`/u/{handle}`),
  and on the mobile event, artist, and venue screens (one shared component). Web uses
  `navigator.share({ title, url })` when available, else copies the URL to the clipboard and shows
  "Link copied" for two seconds. Mobile uses React Native `Share.share({ message: title, url })`.
- **Link shape**: always the web URL, so a recipient without the app still lands on the page.
  Web builds it from `getSiteUrl()` with `window.location.origin` as the fallback. Mobile builds
  it from a new `EXPO_PUBLIC_SITE_URL`; when that env is unset the Share button is hidden (never a
  broken link).
- **Incoming links on mobile**: expo-router linking handles both the `gatekeep://` scheme and
  https links for the configured domain. Path mapping: `/e/{eventId}` opens `event/[eventId]`;
  `/u/{handle}` opens a new resolver screen `app/u/[handle].tsx` that reads the handle, resolves
  the profile type (musician or curator) with the same lookup the artist and venue screens use,
  and replaces itself with `artist/[handle]` or `venue/[handle]`; an unknown handle shows the
  existing not-found treatment. Cold start and warm start both route through expo-router's
  linking; the push-tap path in `_layout.tsx` is unchanged.
- **Native config** in `app.json`: `ios.associatedDomains: ["applinks:REPLACE_WITH_LINK_DOMAIN"]`
  and an Android `intentFilters` entry with `autoVerify: true` for `https` on
  `REPLACE_WITH_LINK_DOMAIN` with `pathPrefix` `/e/` and `/u/`. The placeholder follows the Maps
  key precedent; a build carrying the placeholder simply has no verified links.
- **Verification files** served by the web app as route handlers:
  `/.well-known/apple-app-site-association` (JSON, `applinks.details[0].appIDs` =
  `["{APPLE_TEAM_ID}.{IOS_BUNDLE_ID}"]`, `components` for `/e/*` and `/u/*`) and
  `/.well-known/assetlinks.json` (`delegate_permission/common.handle_all_urls` for
  `{ANDROID_PACKAGE}` with `{ANDROID_CERT_SHA256}`). Each returns 404 while any of its env values
  is unset. Env names: `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256`,
  all server-only, documented in README's env table.

### 3.2 Web location and the home-city fallback

- The web Discover page gains a "Use my location" chip beside the existing controls. It reuses
  `apps/web/src/search/useBrowserLocation.ts` (session only, rounded to three decimals) and passes
  `{ lat, lng }` as `location` to the same `getDiscoverDeck` callable the mobile deck uses, so the
  ranking is `discoverRank.ts` on both platforms. Denied or unavailable geolocation falls back
  silently.
- **Home-city fallback** on both platforms: when no device or browser position is available,
  Discover passes the account's `homeGeo` as `location`. Web shows "Ranked near {homeCity}" with
  a link to the account card; mobile's existing location prompt sheet gains one line "Or set a
  home city under Account." when no home city is set. No fallback and no position means today's
  unranked feed.

### 3.3 Account editor

- **Web**: an "Account" card on `/dashboard` above "Your profiles" with two inputs (Display name,
  Home city) and Save; helper copy under the name: "Shown on tickets you buy from now on." Under
  the city: "Used to rank shows near you when your location is off."
- **Mobile**: the Account screen gains an "Edit account" row that opens a sheet with the same two
  fields and copy.
- Both call `updateAccount`; errors surface the callable's message; success re-reads the user doc.
  Existing tickets and attendee rows keep their snapshotted name (stated in copy, no backfill).

### 3.4 Doors and age on events

- **Editors** (web `EventEditor`, mobile `(curator)/events/event/[eventId]`): an optional "Doors"
  datetime input under the start time, and an "Age" segmented control (All ages, 18+, 21+,
  default All ages). Client-side hints mirror the server rule (doors before start, within 12
  hours).
- **Public pages** (web `EventPageClient`, mobile `event/[eventId]`): "Doors {time}" on the
  schedule line when set; an age badge for 18+ and 21+ (nothing for all ages).
- **SEO**: `eventJsonLd` adds `doorTime` when set; schema.org has no age property, so the badge is
  text only.
- **Search**: the show projection carries `ageRestriction`; fans get a filter "All ages only"
  (checkbox on web, chip on mobile) implemented in the shared `matchesFilters`, so saved searches
  honour it and `saved_search_match` alerts respect it.

### 3.5 Artist tags on standalone events

- **Lineup editor** (both platforms): "Add act" offers two paths: "Name only" (today's external
  act) and "Tag a GateKeep artist", which opens a musician picker backed by the existing `search`
  callable's `curator` face (query by name; results show name, city, genres). Picking one adds a
  `tagged` act with status `pending`. The curator sees each tagged act's status ("Pending",
  "Accepted", "Declined") and can remove any act.
- **Public rendering**: a `tagged` act renders as a plain name until `accepted`; accepted acts
  link to the artist page exactly like booking acts. Declined acts render as a plain name.
- **Artist side**: profile admins of the tagged musician get an `artist_tag` notification that
  opens the event page. On that page a tagged admin sees a banner "You were tagged on this lineup"
  with Accept and Decline; after responding the banner shows the result. A tag on an unpublished
  event notifies when the event publishes; a tag on a published event notifies at tag time.
- **On accept**: the act joins `lineupMusicianProfileIds`, so the artist page's upcoming events,
  the search index (show `relatedProfileIds` and the artist's `busyDays`), lineup posts
  (`createShowPost`), and `show_rescheduled` all treat it like a booking act; the artist's
  followers get `show_announced` for a published event (the publish path's fan-out, scoped to that
  one artist's followers). On decline or untag the act reads as `{ kind: "external", name }` and
  the id leaves the list; no notification to followers.

## 4. Data model

- `UserDoc`: `homeGeo: { lat: number; lng: number } | null` (coarse, two decimals, server
  written), next to the existing `homeCity`.
- `EventDoc`: `doorsAt: number | null` (epoch ms; absent on old docs reads as null) and
  `ageRestriction: "all_ages" | "18_plus" | "21_plus"` (absent reads as `all_ages`).
- `EventAct` gains `{ kind: "tagged"; musicianProfileId: string; name: string; status:
  "pending" | "accepted" | "declined"; taggedAt: number; respondedAt: number | null }`. `name`
  is the profile's display name snapshotted at tag time. `lineupMusicianProfileIds` includes
  booking acts and accepted tagged acts only (server-maintained, as today).
- `SearchIndexDoc` (show kind): `ageRestriction` facet; `SearchFilters.allAges?: boolean`.
- `NotificationDoc.kind` gains `artist_tag`; `notificationHref("artist_tag", eventId, platform)`
  returns the event page on both platforms.
- Rules: the `users/{uid}` owner update loses `displayName` and `homeCity` from its allowed set
  (`photoUrl` stays for a future photo flow); `homeGeo` is never client-writable. Events remain
  callable-only. No new composite index is expected; the plan's pre-flight confirms every new
  query against `firestore.indexes.json`.

## 5. Backend

- `updateAccount({ displayName?: string; homeCity?: string | null })` (verified email): display
  name 1 to 80 characters after trim; home city 0 to 80 characters, `null` or empty clears both
  `homeCity` and `homeGeo`; a non-empty city is geocoded with `getGeocoder()` (stub in the
  emulator), `coarsen()`ed, and charged to `consumeGeocodeBudget(uid)`; a geocoder miss stores the
  city text with `homeGeo: null` and returns `{ geocoded: false }` so the client can say "We could
  not place that city; ranking will not use it." The geocode budget bounds abuse.
- `getDiscoverDeck`: unchanged contract; clients pass `location` from device, browser, or
  `homeGeo`, in that order.
- Event validation (`validateEventInput` in `eventsCore.ts`): `doorsAt` optional, integer ms,
  `doorsAt < startsAt`, and `startsAt - doorsAt <= 12 hours`; `ageRestriction` one of the three
  values. `createEvent`, `updateEvent`, and the reschedule paths carry the fields; a `doorsAt`
  change alone does not trigger `show_rescheduled`.
- Artist tags, three callables in `functions/src/eventArtistTags.ts`:
  - `tagEventArtist({ curatorProfileId, eventId, musicianProfileId })`: curator profile admin;
    event belongs to that curator and is draft or published; musician profile exists, is
    `approved`, and is not already in the lineup by any kind; the existing lineup cap of 20 acts
    (`validateEventInput`) applies; appends the tagged act; notifies the musician's admins when the event
    is published; returns `{ actIndex }`.
  - `untagEventArtist({ curatorProfileId, eventId, musicianProfileId })`: curator admin; converts
    the act to external; removes the id from `lineupMusicianProfileIds` when it was accepted.
    Removing the act entirely goes through the existing lineup edit path.
  - `respondToArtistTag({ eventId, musicianProfileId, accept })`: musician profile admin; the act
    must be `pending`; accept sets `accepted`, adds the id, and, when the event is published, fans
    out `show_announced` to that artist's followers under the dedupe id
    `show_announced:{eventId}:{musicianProfileId}` (the publish path's id shape, so a later
    publish cannot double-send); decline sets `declined` (kept as `tagged/declined` in the doc for
    the curator's editor; public readers render it as a plain name).
  - `publishEvent`: for every `pending` tagged act, send `artist_tag` to that musician's admins
    (dedupe `artist_tag:{eventId}:{musicianProfileId}`); accepted tagged acts already ride the
    existing follower fan-out through `lineupMusicianProfileIds`.
- Search index: the events trigger already re-projects on write; the show projection reads
  `ageRestriction`; the artist projection's `busyDays` keeps using `lineupMusicianProfileIds`.
- Deep-link verification route handlers live under `apps/web/app/.well-known/` and read the four
  env values at request time.

## 6. Messages (final copy)

- Share: button label "Share" on both platforms; web fallback toast "Link copied".
- Discover: "Use my location"; "Ranked near {homeCity}"; mobile sheet line "Or set a home city
  under Account."
- Account: "Display name" with "Shown on tickets you buy from now on."; "Home city" with "Used to
  rank shows near you when your location is off."; success "Saved."; geocoder miss "We could not
  place that city; ranking will not use it."
- Validation: "Display name must be 1 to 80 characters."; "Home city must be 80 characters or
  fewer."; "Doors must be before the start time and within 12 hours of it."; "Pick an age
  restriction."
- Event page: "Doors {time}"; badges "18+" and "21+".
- Tags: notification title "You were tagged on a lineup", body "{curatorName} tagged you on
  {eventTitle}."; banner "You were tagged on this lineup"; buttons "Accept" and "Decline"; editor
  statuses "Pending", "Accepted", "Declined"; picker "Tag a GateKeep artist"; errors "That artist
  is already on the lineup.", "Only approved artists can be tagged.", "This tag has already been
  answered."

## 7. Testing

- Emulator (functions): `updateAccount` (validation, geocode through the stub, budget exhaustion,
  clearing, rules refusal of a direct `homeCity` write); event validation for doors and age
  (create, update, reschedule); the tag lifecycle (tag on draft then publish sends one
  notification; tag on published sends immediately; accept adds the id, updates the search index
  doc, fans out `show_announced` once even if publish runs again; decline and untag revert;
  non-admin refused; unapproved musician refused; duplicate refused; cap enforced;
  `createShowPost` allowed only after accept); `getDiscoverDeck` ranking with a `homeGeo`-shaped
  location.
- Rules: the `users/{uid}` owner cannot write `displayName`, `homeCity`, or `homeGeo`; can still
  write `photoUrl`.
- Shared: `matchesFilters` with `allAges`; `notificationHref("artist_tag")`; any event validator
  that moves to shared.
- Clients: typecheck, lint, build, export; the resolver screen and the share buttons are
  owner-smoked on device (universal links cannot be exercised without the domain).

## 8. Out of scope (deliberate)

Profile photos; per-event timezones; artist-initiated tag requests; tagging curators or venues;
backfilling ticket holder names; a share sheet for gigs or search results; messaging.

## 9. Owner-owed after merge

- Choose the domain; replace `REPLACE_WITH_LINK_DOMAIN` in `app.json`; set `NEXT_PUBLIC_SITE_URL`
  and `EXPO_PUBLIC_SITE_URL`; set `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`,
  `ANDROID_CERT_SHA256` on the web host; verify the two well-known files resolve.
- A new EAS build (associated domains and intent filters are native config).
- Device smoke: share from each screen, open a shared link cold and warm, tag an artist and accept
  from the other account, set a home city and confirm Discover ranks by it with location off.

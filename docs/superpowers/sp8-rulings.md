# GateKeep Sub-project 8 (Search) - Rulings & Handoff

Durable record from sub-project 8, executed subagent-driven with per-task reviews (spec compliance
then code quality), scoped re-reviews of every fix round, and a whole-branch final review on the
most capable model, merged to `main` on 2026-09-04. Mirrors the sp2 to sp7, sp9a, sp9b, and sp10b
rulings docs. This document, like all sub-8 output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-09-02-search-design.md` (binding authority)
Plan: `docs/superpowers/plans/2026-09-02-search.md` (19 tasks)
Gates at merge: typecheck 5/5, shared 201, web tests 7, `emu:test` 896, `emu:rules` 134, web lint
0 + build, mobile lint 0 new + `expo export` bundles. Sub-project 10B's suites are included
unchanged; every touch to `notifications.ts`, `scheduled.ts`, and `portfolio.ts` is additive.

## What shipped

- **Search index** (`functions/src/searchIndex.ts`): a server-only `searchIndex/{kind}_{sourceId}`
  collection (kinds show, gig, artist, venue) built by pure projections and five
  `onDocumentWritten` triggers (profiles, tracks, events, gigs, bookings); prefix tokens (2 to 12
  chars, cap 150), facets, public geo, artist `busyDays` (confirmed bookings and published lineups,
  next 180 days, `LAUNCH_TIMEZONE` day keys), `hasAudio`, `actSize` (the only private booking
  field read). `backfillSearchIndex` (admin, paged by name) and a daily expiry step (sweep step 10)
  for shows a day past their end.
- **The callable** (`functions/src/search.ts` + pure `searchRank.ts` + `searchBudget.ts`): one
  `search` for four faces (`fan`, `musician_gigs`, `musician_venues`, `curator`); kind plus
  `array-contains-any` tokens, AND over query words in memory, per-face filters from the shared
  module, deterministic ranking (word match, soonness, distance, log followers, follow boosts,
  audio), 20 per page, up to 200 map pins, a transactional 300-a-day budget per uid.
- **Saved searches** (`functions/src/savedSearches.ts`): `saveSearch` (cap 10, duplicate collapse,
  server-built label), `deleteSavedSearch` (owner only), and `onSearchIndexCreated` scanning saved
  searches of the new doc's kind and notifying under `saved_search:<savedId>:<docId>`.
- **Shared** (`packages/shared/src/search.ts`): every type, constant, normalizer, day helper, the
  `when` windows, `matchesFilters`/`matchesSavedSearch` (one source of filter semantics),
  `savedSearchLabel`, and the two validators; `NotificationDoc` gains `saved_search_match` and
  `refKind`; `notificationHref` gains a `refKind` parameter; musician `portfolio.location`;
  54 reserved handles.
- **Rules and indexes**: `searchIndex` and `searchBudgets` denied to everyone, `savedSearches`
  owner-read, all writes callable-only; seven composites (five `searchIndex`, two `savedSearches`);
  the unused `gigs (bookedMusicianProfileId, status, startsAt)` composite removed.
- **Web**: `/search` (face by role, three-segment tabs for dual-role users), `/gigs` and the
  curator musicians page rendering the same faces, the Google Maps results map behind
  `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, saved searches on the dashboard with `?saved=` restore,
  inbox deep links by `refKind`, admin "Rebuild search index", home city on the portfolio editor,
  `sitemap.xml`, `robots.txt`, JSON-LD on artist, venue, and event pages, lowercase handle
  redirects, `getSiteUrl()` (with the Vercel fallback kept).
- **Mobile**: the fan Search tab, musician Find Gigs (Gigs | Venues chips) with the gig detail
  and apply sheet extracted to `GigDetailSheet`, curator Find Musicians with the offer composer
  extracted to `OfferComposer`, react-native-maps behind the same List | Map toggle, saved searches
  under Account (hidden tab) with restore, push payload and inbox routing by `refKind`, home city
  on the portfolio editor, the deck's location prompt extracted to `LocationPromptSheet`.

## Load-bearing rulings (read before touching the named area)

1. **Deep links carry `refKind`.** Sub-project 10B centralised routing in the shared
   `notificationHref(kind, refId, platform)`; sub-8 keeps that single map and adds an optional
   fourth argument. `saved_search_match` routes event to the event page, gig to `/gigs/:id` on
   web and `/(musician)/gigs?gigId=:id` on mobile, profile to null (clients resolve the handle
   exactly as for `new_music`). The push payload carries `refKind` as `null` when absent.
2. **`LAUNCH_TIMEZONE` is the day boundary everywhere.** The shared module owns
   `dayKeyInLaunchZone`, `launchZoneDayStartMs`, and the `when` windows (tonight, weekend from
   Friday 17:00, next 30 days). `busyDays` and the curator "Free on" filter use the same keys.
3. **The index is server-only and narrowed on the way out.** `toSearchResult`/`toSearchPin` are
   explicit allow-lists; `busyDays`, `relatedProfileIds`, `tokens`, and `words` never leave the
   server. Private gig addresses are never read by a maintainer.
4. **Filter semantics live once.** `matchesFilters` in shared is used by the callable and the
   alert matcher; `nearMe` is the only filter the callable applies itself (it needs a position),
   and saved searches store `nearMe: false`.
5. **Shared-database steering in emulator tests.** The full suite shares one database, so
   `search.test.ts` writes unique tokens into fixture titles and names and searches for them;
   never raise the candidate cap or page size to make a test pass.
6. **Malformed sources project defensively.** `projectShow` guards `lineup` and
   `lineupMusicianProfileIds` with `?? []` because other suites leave half-shaped event docs;
   every trigger body is try/catch with `console.error`.
7. **Sweep step numbering.** Search expiry is step 10 of `runDailySweep` (8 is event reminders,
   9 is cascade retries); report fields `searchIndexExpired` and `errors.searchIndex`.
8. **Callables go through `callFn`.** Both clients' `searchApi.ts` use the 10B wrapper
   (`src/lib/callable.ts`), which retries once on a stale verify-email claim.
9. **The curator face keeps the directory's booking affordances.** `CuratorArtistRow` on both
   platforms lazily reads `profiles/{id}/private/curatorBooking` for the rates and reliability
   line (tolerating a summary-only doc) and offers "Offer a gig" through the existing composer
   (web `src/bookings/OfferComposer.tsx`, mobile extracted from the old browse file). N+1 reads
   accepted, as before.
10. **One sign-in message.** `SEARCH_SIGN_IN_MESSAGE` ("Sign in to search.") replaces the plan's
    gigs-specific copy for every face.
11. **`getSiteUrl()` keeps the Vercel fallback.** `NEXT_PUBLIC_SITE_URL`, else
    `https://<VERCEL_PROJECT_PRODUCTION_URL>`, else null; sitemap, robots, layout, and JSON-LD
    all read it.
12. **Classic Google Markers on web.** Advanced Markers need a Cloud-console Map ID the owner does
    not have; `google.maps.Marker` is deprecated but functional, listeners are cleared before
    `setMap(null)`, and `setOptions` runs once per page load.
13. **Map readiness is per mount on mobile.** The `MapView` lives in an inner component that
    mounts only with pins, so `fitToCoordinates` never runs on an unready map after an
    empty-then-repopulate cycle.
14. **Chips are the mobile segment control** (no tabs primitive); the shared `Chip` now sets
    `accessibilityState.selected`, and segment chips carry labels.
15. **A wrapping `<label>` is a valid association.** The web home-city field wraps its `Input`
    (parked reviewer finding; the "htmlFor" wording was the controller's, not the spec's).
16. **The `location` argument arrives as `null` when omitted.** The callable SDK sends
    `undefined` as `null`; `validateSearchInput` accepts `null`, rejects any other non-object or
    out-of-range shape.
17. **`nearMe` on a saved search.** The spec's "stored as false" applies only to faces whose
    `FACE_FILTER_KEYS` include `nearMe`; other faces omit the key, and `validateFilters` tolerates
    a literal `nearMe: false` on any face so a restored search re-saves cleanly (the final review
    caught the curator round trip failing).
18. **Tokenizer splits on Unicode letters and digits** (`/[^\p{L}\p{N}]+/u` after the NFD accent
    strip), per spec section 4; the plan's ASCII regex was a plan defect.
19. **Web `ResultList` takes `renderRow`, not a row component type**, the mobile contract; an
    inline component type remounted every curator row per keystroke.
20. **Prop-driven state uses the render-time tracked-prop reset** (mobile `MusicianFace`'s
    `preselectGigId`, `GigDetailSheet`'s `gigId`, the search hooks' request key): a `useState`
    initializer alone ignores a live param change on an already-mounted tab.
21. **Accepted at launch scale**: the event trigger rebuilds every lineup artist on any event
    write, and concurrent artist rebuilds are last-writer-wins on a possibly older snapshot
    (`busyDays` self-heals on the next rebuild or backfill). Gate the rebuild on `status`,
    `startsAt`, or lineup changes when the metro outgrows a few hundred events.

## Accepted exceptions and deferred minors (for a future polish pass)

- `formatShortDate` has no direct unit test; the `freeOnly`, `hasAudio`, and `availableOn` filter
  tests assert presence only; the comparator stability assertion is trivially true on a total
  order; the leak test checks three of the index-only fields.
- `scoreResult`'s whole-word bonus compares the 12-char-truncated query word against untruncated
  doc words, so words longer than 12 chars only ever earn the prefix point.
- `saveSearch`'s count-then-add is not transactional (same best-effort posture as the follows cap).
- `pageCollection` in `searchIndex.ts` duplicates the sweep's `paginate` generator (an import cycle
  prevented sharing); the sweep step under-reports on partial failure like its siblings.
- `withoutEmpty` in `jsonLd.ts` does not strip an all-empty nested object; the sitemap route
  propagates a Firestore failure rather than falling back.
- Web: `SaveSearchButton` does not clear a pending "Saved" timer on a second click; Open/Delete
  buttons in `SavedSearches` lack per-row labels; the map theme is read once at map creation; the
  `BookingForms.tsx` comment still mentions a From/To filter that no longer exists.
- Mobile: `FilterChips` duplicates the draft/tracked resync for city and availableOn; `ProfileRow`
  meta order differs cosmetically from the plan; the `searchIndex.test.ts` show-cancel test cannot
  assert the event-only busy-day contribution in isolation with the shared fixture.
- Task 2 casts `portfolio` to an inline `{ location?: ... }` type instead of
  `PortfolioData["location"]`.

## Owner smoke (both platforms, both themes)

The sub-8 checklists in README ("Sub-project 8 launch checklist" and "Sub-project 8 smoke
checklist"). Before device testing: the Android Maps key in `app.json` and a new EAS dev build
(react-native-maps joined the native deps). Before launch: the web Maps browser key, the seven
composite indexes built, one `backfillSearchIndex` run from `/admin`, `LAUNCH_TIMEZONE` confirmed.
The map path on both platforms is entirely unverified off device.

## Environment notes for the next session

- The full `pnpm emu:test` exceeds the tool's foreground limit; the detached PowerShell runner
  (wait for port 8080, run to a log, poll the log with a bounded `until grep -q "^EXIT"`) is the
  reliable shape. Implementers still stall when they background the command themselves; the nudge
  is "read the log now".
- The worktree guard refuses `git -C`, compound git commands, PATH exports, and any script file in
  Bash or Monitor; plain single commands from the worktree root pass, and the main checkout is
  reached from PowerShell with `git -C C:\Users\LeoArkos\GateKeepBeta ...`.
- Shared-database flakes surface only in the full suite; steer with unique tokens, never with caps.

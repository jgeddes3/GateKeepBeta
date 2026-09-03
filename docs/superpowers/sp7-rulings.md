# GateKeep Sub-project 7 (Fan Discovery) - Rulings & Handoff

Durable record from sub-project 7, executed subagent-driven with per-task reviews (spec compliance
then code quality), scoped re-reviews of every fix round, and a whole-branch final review on the
most capable model, merged to `main` on 2026-09-02. Mirrors the sp2-sp6/sp9a/sp9b rulings docs.
This document, like all sub-7 output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-09-02-fan-discovery-design.md` (binding authority)
Plan: `docs/superpowers/plans/2026-09-02-fan-discovery.md` (14 tasks)
Gates at merge: typecheck 5/5, shared 167, `emu:test` 735, `emu:rules` 114, web lint 0 + build,
mobile lint 0 new + `expo export` bundles. The 735 includes sub-5's and sub-6's suites unchanged:
every touch to `events.ts`, `tracks.ts`, `notifications.ts`, and `scheduled.ts` is additive and was
verified so by review, twice (per-task and whole-branch).

## What shipped

- **Follows** (`functions/src/follows.ts`): `followTarget` / `unfollowTarget` /
  `markGenrePickerSeen`; `follows/{uid}_{targetId}` docs for artists, venues, and `genre:<name>`
  targets; server-maintained `followerCount` on profiles (shown only to a profile's own members).
- **Notifications** (`functions/src/announce.ts` + hooks in `events.ts` and `tracks.ts`): show
  announced (publish, and newly added lineup acts), "You're on the bill" to lineup musicians, show
  rescheduled (followers plus valid ticket holders, and the 24h reminder re-arms), new music (track
  approved). Every fan-out writes under a create-if-absent dedupe key and is best-effort after
  the primary write commits.
- **Show posts** (`functions/src/showPosts.ts`): lineup musicians post short notes on a published
  event (280 chars, 3 live per profile per event, one per 10 minutes); author or admin removal is
  a status flip with an audit row for admins; followers get a push.
- **Event projections** (`events.ts`): `genres` (curator override or derived from the lineup's
  portfolios), `priceFromCents`, `hasFreeTier`, all server-derived and optional on older docs.
- **The deck** (`functions/src/discover.ts` + pure `discoverRank.ts`): `getDiscoverDeck` ranks
  shows, artists, and venues (genre overlap, follow boost, soonness, distance, seeded randomness),
  interleaves kinds, resolves each card's preview track path server-side, returns storage paths.
- **Rules and indexes**: `follows` owner-read, `events/*/posts` public when live on a public
  event, all writes callable-only; eight new composite indexes.
- **Web**: signed-in `/discover` (Shows | Artists with chips), follow buttons on artist, venue,
  and event pages, posts on event and artist pages, post-purchase genre prompt, admin "Show posts"
  panel, landing fan story and "Find a show" hero path, curator genre chips in EventEditor,
  Discover nav item, profile-less sign-ins land on `/discover`.
- **Mobile**: the Discover tab is the swipe deck (FlatList paging, one expo-audio player driven by
  playback status, expo-location with a skippable prompt, mute persisted), a List view with the
  Shows | Artists lists, Following screen, new `/venue/[handle]` screen, show posts on the event
  screen and the artist page's new "Upcoming events" section, notification deep links, curator
  genre chips on the create form.
- **Docs and seed**: `scripts/seed-test-discovery.ts` (approved track with a WAV placeholder, a
  booking-act event, a genre follow), README launch and smoke checklists, HANDOFF.

## Load-bearing rulings

1. **Follows are top-level `follows/{uid}_{targetId}` docs**, owner-readable, callable-written.
   The follow count is read outside the transaction (best-effort cap of 500) and the cap check
   sits after the idempotency short-circuit, so an at-cap re-follow is a no-op success.
2. **Dedupe keys are create-if-absent**: `notifyUser(uid, note, dedupeKey)` uses `create()` and
   treats ALREADY_EXISTS as "leave it alone, no second push". Keys: `announce:{eventId}`,
   `bill:{eventId}`, `resched:{eventId}:{newStartsAt}`, `track:{trackId}`, `post:{postId}`.
3. **Fan-out is post-commit and contained**: every follower fan-out in `publishEvent`,
   `updateEvent`, `reviewTrack`, and `createShowPost` runs after the primary write and inside the
   codebase's `try { } catch (e) { console.error(...) }` pattern, so a notify failure never
   misreports a committed publish, update, approve, or post.
4. **Firestore transactions read before they write** (the plan's `unfollowTarget` snippet had it
   reversed and failed with INTERNAL in the emulator).
5. **The show-post rate limit considers every post the profile made on the event, live or
   removed**; the 3-post cap counts live posts only. Remove-then-repost cannot dodge the cooldown.
6. **Deck ranking randomness is seeded per candidate** (`mulberry32(seed ^ fnv1a32(id))`), so a
   card's score depends only on (seed, id) and paging under one seed stays stable; ids compare
   bytewise, never with `localeCompare`.
7. **The venue candidate query orders by `updatedAt desc`** with its own composite index, so the
   deck's venue pool is not an id lottery above 100 venues.
8. **`getDiscoverDeck` rejects `location: null`** (clients omit the key when there is no position);
   the position is request-scoped, rounded to three decimals on the device, and never persisted.
9. **One follows listener per session**: web mounts `FollowsProvider` per page, mobile mounts it
   app-wide in `app/_layout.tsx`; `useFollowsContext` falls back per component where no provider
   is mounted. Per-row listeners were the recurring review finding on both platforms.
10. **The curator genre override has UI** on the web EventEditor (create and edit, always resent
    on edit; an absent field clears the selection server-side) and on the mobile create form.
11. **Deck emulator tests steer ranking with a genre no other test uses** so fixture cards land on
    page one deterministically in the shared, ever-growing emulator database; the distance test
    requires the near venue on page one and finds the far one on page one or two.
12. **Mobile deck audio is status-driven**: `replace()` then seek and play only once the player
    reports `isLoaded` for the bound card; `status.error` marks the card silent; a 300 ms window
    after a swap ignores a stale error from the source just replaced.
13. **Tickets buttons on artist and venue deck cards** are an accepted extra (shows lead, tickets
    are the revenue path).
14. **Per-act post threads query by `status == live` AND `musicianProfileId ==`** (two equalities,
    no composite) and sort client-side; narrowing the event's newest three posts by act lost an
    act's own posts whenever another act posted three times (final review).
15. **Reschedule detection compares `startsAt` at minute granularity**, so an unchanged Save from
    a minute-precision form never fires "Show rescheduled" (final review).
16. **Profile-less web sign-ins keep Dashboard in the nav** (it is the web inbox) and the
    `/discover` gate carries `next=/discover` through sign-in (final review).

## Accepted exceptions and deferred (conscious, not oversights)

- The landing fan section reuses `public/marketing/artist-page.jpg`; a Discover-page capture is
  owner-owed.
- The "This week" Shows filter is a rolling 7 days rather than a calendar week.
- `removeShowPost` is read-then-write, not transactional (two racing admin removals could write
  two audit rows).
- `preview.durationSec` is unused (no stop-at-window timer).
- A followed profile that later becomes unapproved is hidden on the Following screen (no
  "Unavailable" row with Unfollow) and still counts toward the 500 cap.
- The admin "Show posts" panel reads the 50 soonest published events with no `startsAt` floor,
  so past-but-not-completed events appear (arguably what a moderator wants).
- The artist page's Upcoming events row omits the "posting is closed" line for members after
  `endsAt` (the event screen shows it).
- The seed chain accumulates draft gigs on re-run (same as `seed-test-event.ts`).
- Composite follow doc ids would collide if a uid contained "_" (Firebase Auth uids do not).
- No per-kind notification mute, no fan reporting of posts, no photos on posts, no browser push,
  no logged-out web following, no musician location field, no standalone posts feed (spec YAGNI).

## Owner smoke (the hard pre-launch gate for sub-7)

The full checklists are in `README.md` ("Sub-project 7 launch checklist" and "smoke checklist").
Highest priority, impossible to verify on this machine:
1. **A new EAS dev build** (expo-location joined the native deps), then the DECK on a real device:
   audio swaps on swipe, mute persists across relaunch, location Allow shows distances and Not now
   does not, permanently denied opens Settings from the empty state, card layout at the largest
   text size on the smallest phone.
2. Follow from every card kind, Following screen unfollow, venue screen, notification taps
   (announced, rescheduled, post, new music), composer caps and keyboard behaviour, both themes.
3. After first deploy: confirm the eight new composite indexes finish building before real traffic.

## Environment notes

Windows, `corepack pnpm`. Emulator suites need the Java PATH prepend and
`FUNCTIONS_DISCOVERY_TIMEOUT=60`. A fresh worktree's emulator needs a local, untracked
`functions/.secret.local` or every callable fails with Secret Manager 403s. The Bash tool moves
any command past 600 s to the background automatically and the full `emu:test` takes about 617 s,
so a subagent's "foreground" full run is always backgrounded: tell implementers to poll the run's
output file with bounded Read loops instead of ending their turn. Two Claude sessions on one
machine share the emulator ports; runs that collide fail at emulator start ("Port 8080 is not
open"), so wait for the ports to free and start immediately (a detached PowerShell script that
polls port 8080 then runs `pnpm emu:test` to a log worked well).

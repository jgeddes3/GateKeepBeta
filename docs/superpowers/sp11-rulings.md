# GateKeep Sub-project 11 (SP7 reconciliation) - Rulings & Handoff

Durable record from sub-project 11, executed subagent-driven with per-task reviews (spec compliance
then code quality), scoped re-reviews of every fix round, and a whole-branch final review on the
most capable model followed by one fix wave, merged to `main` on 2026-09-05. Mirrors the earlier
rulings docs. This document, like all sub-11 output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-09-04-sp7-reconciliation-design.md` (binding authority)
Plan: `docs/superpowers/plans/2026-09-04-sp7-reconciliation.md` (16 tasks)
Gates at merge: see the gates line in `docs/superpowers/HANDOFF.md` (measured on the final tree).

## What shipped

- **Sharing and deep links**: a Share button on the web event and public profile pages and on
  the mobile event, artist, and venue screens (native share sheet; hidden on mobile when
  `EXPO_PUBLIC_SITE_URL` is unset). Links are always web URLs (`/e/{id}`, `/u/{handle}`; the
  browser redirects `/u/` to the canonical `/@handle`). Mobile resolves `/e/{id}` and
  `/u/{handle}` natively (`app/e/[eventId].tsx`, `app/u/[handle].tsx`); `app.json` carries
  associated domains and verified intent filters behind `REPLACE_WITH_LINK_DOMAIN`; the web app
  serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` from
  `app/well-known/` route handlers (Next rewrites keep the public paths) that return 404 until
  `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`, and `ANDROID_CERT_SHA256` are set.
- **Web location and the home-city fallback**: the web Discover shows list gains "Use my
  location" (browser geolocation, session only) and ranks through the same `getDiscoverDeck` the
  mobile deck uses when a position exists (device or browser position, else the account's coarse
  `homeGeo`); the date, free, and genre chips filter the ranked rows client-side and the
  unranked query feed is untouched when no position exists. Mobile's deck takes the same
  `homeGeo` fallback, and its location prompt sheet points at the account editor.
- **Account editor**: `updateAccount` (verified email) writes `displayName`, `homeCity`, and a
  server-geocoded, two-decimal `homeGeo` under the geocode budget; the `users/{uid}` owner update
  rule now allows `photoUrl` only. A dashboard Account card on web and an "Edit account" sheet on
  mobile.
- **Doors and age**: `EventDoc.doorsAt` (optional, before start, within 12 hours) and
  `ageRestriction` (`all_ages` default, `18_plus`, `21_plus`), validated in `validateEventInput`,
  carried by create, update, and poster saves, rendered as "Doors {time}" and a badge on both
  event pages, `doorTime` in JSON-LD, projected into the show search index as `ageRestriction`,
  and filtered by the fan face's "All ages only" chip through the shared `matchesFilters` (saved
  searches and alerts included).
- **Artist tags**: a `tagged` lineup act (`musicianProfileId`, snapshotted `name`, `status`
  pending/accepted/declined, `taggedAt`, `respondedAt`) created only by `tagEventArtist`,
  answered by `respondToArtistTag`, removed by `untagEventArtist` or by omission on
  `updateEvent`; public pages render it as a plain name until accepted; on accept it joins
  `lineupMusicianProfileIds` (artist page, search index, lineup posts, reschedule fan-out) and
  the artist's followers get `show_announced`; `publishEvent` notifies pending tags once.
  Editors on both platforms offer "Tag a GateKeep artist" through the `search` callable's curator
  face; the tagged profile's admins see an Accept and Decline banner on the event page.

## Load-bearing rulings (read before touching the named area)

1. **Tags are created by one callable and reconciled transactionally.** `createEvent` refuses a
   `tagged` act; `updateEvent` reads, reconciles, and writes the lineup inside one transaction
   (a concurrent accept or tag is never silently reverted), keeps the server-owned status and
   timestamps of a resent tagged act, treats omission as removal, and refuses an invented tag
   (`ARTIST_TAG_UNKNOWN_MESSAGE`).
2. **Tag responses are gated like tags.** `respondToArtistTag` requires an admin of the tagged
   musician profile, a `pending` act, and a `draft` or `published` event
   (`ARTIST_TAG_EVENT_CLOSED_MESSAGE`).
3. **Re-tagging never duplicates.** `tagEventArtist` converts a same-named external act (trimmed,
   case-insensitive) in place instead of appending, and the tag notification dedupe key carries
   `taggedAt` (`artist_tag:{eventId}:{musicianProfileId}:{taggedAt}`), so each new tag notifies
   once (a spec deviation recorded here: the spec keyed on event and profile only).
4. **Accept-time announcements reuse the publish key.** The follower fan-out on accept runs under
   `announce:{eventId}`, so a fan told at publish is not told twice and a later publish cannot
   double-send; only the accepted artist's followers are targeted.
5. **Editors show the server's lineup after a tag.** Web refetches the event after
   `tagEventArtist` (its lineup is a local buffer); mobile reads the live `onSnapshot` lineup.
   Neither appends locally.
6. **`homeGeo` is server-only.** `updateAccount` is the sole writer of `displayName`, `homeCity`,
   and `homeGeo`; the owner update rule allows `photoUrl` only; a geocoder miss stores the city
   with `homeGeo: null` and returns `geocoded: false`; a configuration failure rethrows.
7. **Location precedence is fixed.** Device or browser position, then `homeGeo`, then none;
   only the home-city fallback shows "Ranked near {homeCity}".
8. **Doors validation runs on every start-time write.** A reschedule that would strand `doorsAt`
   past the new start is refused with `EVENT_DOORS_MESSAGE`; a doors-only change does not fan out
   `show_rescheduled`.
9. **Nothing fake ships for deep links.** The well-known handlers 404 while any env value is
   unset and read env at request time; `app.json` keeps the `REPLACE_WITH_LINK_DOMAIN`
   placeholder; the mobile Share button is hidden until `EXPO_PUBLIC_SITE_URL` exists.
10. **The all-ages filter is in-memory.** `ageRestriction` is a projected facet filtered by the
    shared `matchesFilters`; no query clause and no composite index.
11. **Copy and platform shape.** The fan filter ships as a chip on both platforms (the web
    `FilterBar` has no checkbox); the mobile curator editor gained exactly a Details card and a
    Lineup card (title, description, and dates stay web-edit-only); "Save the event first, then
    tag artists." on the create form.

12. **Accepted tags are booking acts everywhere.** `isLinkableAct` (booking, or tagged and
    accepted) is the one predicate the event pages, the Discover deck's artist names, and
    `computeEventGenres` use; accept and untag recompute the event's genres (curator-set genres
    still win).

## Deferred (recorded, not fixed)

- The "on the bill" note is not sent to an artist's members on accept (only the follower
  announce).
- Artist approval is read outside the tag transaction (same posture as other callables).
- The Search faces' location prompt sheet does not show the home-city hint (Discover's does).
- Mobile's event screen has no per-act Follow button (web has one); the tag banner is inlined in
  the screen.
- A pending tag whose musician profile loses every admin or is deleted stays pending until the
  curator untags it (same posture as booking acts).
- On mobile a published event whose start has passed cannot save Details or Lineup edits ("Start
  time must be in the future") because mobile has no date field (pre-existing on poster saves).
- Web event pages revalidate every 60 seconds, so an accepted tag's link and the banner lag up
  to a minute.

## Execution lessons (SDD)

- Parallel client implementers on disjoint files work when each stages only its own paths and
  is told to commit past another implementer's transient typecheck breakage; the controller
  re-runs gates at the next quiet point. Never let a subagent use `git stash` (the stack is
  shared across sessions).
- Per-task reviews caught the seams the plan missed: the five older rules cases that asserted the
  old owner-write posture, the non-transactional lineup reconcile, the missing status gate on tag
  responses, inert Discover chips over a still-billing hidden query, and two Sheet forms without
  keyboard avoidance (the codebase's own precedent).
- A pre-flight scan against the tree caught a plan defect before dispatch (a duplicate formatter)
  and an unused import that lint would have failed.

## Owner-owed after merge

- Choose the domain; replace `REPLACE_WITH_LINK_DOMAIN` in `app.json`; set `NEXT_PUBLIC_SITE_URL`
  and `EXPO_PUBLIC_SITE_URL`; set `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`,
  `ANDROID_CERT_SHA256` on the web host; verify both well-known files resolve.
- A new EAS build (associated domains and intent filters are native config).
- Device smoke (README "Sub-project 11 smoke checklist"): share from each screen, open a shared
  link cold and warm, tag an artist and accept from the other account, set a home city and
  confirm Discover ranks by it with location off, set doors and an age on an event and see the
  badge and the all-ages filter on both platforms.

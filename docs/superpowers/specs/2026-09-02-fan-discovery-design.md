# GateKeep Sub-project 7: Fan Discovery (design)

Status: approved in brainstorm on 2026-09-02. This document is the binding authority for
sub-project 7; the implementation plan argues from it. It contains no em dashes, and neither
may anything built from it (code, comments, copy, docs, commit messages).

Binding context: `DESIGN.md` (repo root) for every visual decision, the antislop skills for UI
and copy, `docs/superpowers/sp6-rulings.md` for the event and ticket rails this builds on, and
`docs/superpowers/sp2-rulings.md` for hosted audio.

## 1. Goal

Give fans a reason to open GateKeep between ticket purchases: a swipe deck on mobile that plays
the city's music at them, Shows | Artists lists on both platforms, following (artists, venues,
genres), performance notifications, and short show posts from musicians. Everything reads the
public data sub-projects 2 through 6 already publish; nothing here touches money.

## 2. Owner decisions (from the brainstorm)

1. **Discover shape**: two equal lists, Shows | Artists, behind a segment control; on mobile the
   swipe deck is the Discover tab and the lists are one tap away ("List" control).
2. **Follow targets**: artists (musician profiles), venues (curator profiles), and genres.
3. **Notifications to followers**: show announced, new music from a followed artist, show
   rescheduled, and show posts by a followed artist. Web gets the in-app inbox only; push stays
   mobile (no browser push in v1).
4. **Show posts**: short text notes (no media) tied to a published event, written only by
   musicians in that event's lineup. The event link is the "shows only" enforcement.
5. **Web surface**: signed-in only `/discover` with the lists; no public SEO listing in v1.
6. **Landing page**: a fan story section plus a third hero path, "Find a show".
7. **Genre picker**: skippable sheet on first Discover open. It never stands between a fan and a
   ticket: a fan who arrives on an event link buys first and sees the prompt after the order.
8. **Deck cards**: shows, artists, and venues interleaved. Every card has audio (artist: their
   top track; show: a lineup act's track; venue: a track from the next act playing there).
9. **"Close to them"**: device location with a skippable prompt, falling back to the metro with
   no distances. The fan's position is request-scoped and never stored.
10. **Deck engine**: server-built via one callable, `getDiscoverDeck`.

## 3. Surfaces

### Mobile (`apps/mobile`)

- **Discover tab = deck.** Full-screen vertical paging (FlatList, `pagingEnabled`, full-height
  items; no new pager dependency). A "List" control in a corner flips to the Shows | Artists
  lists; a mute toggle sits beside it.
- **Lists.** Shows: published events from now on, soonest first, chips Today / This week /
  Weekend / Free plus a genre sheet. Artists: approved musicians by name plus a genre sheet,
  each row with a Follow button. Show rows push `/event/[eventId]`; artist rows push
  `/artist/[handle]`.
- **Account.** New "Following" screen: artists, venues, genres, each with Unfollow, and "Edit
  genres" which reopens the picker preselected.
- **Musician context.** "Post about this show" lives where an event is already resolved: the
  event screen (`/event/[eventId]`) when the viewer belongs to a profile in the lineup, and the
  artist page's new "Upcoming shows" section (the same `lineupMusicianProfileIds` events query
  the web artist page already runs) when the viewer is a member. Bookings and gigs carry no
  event id, so the Bookings screen is not an entry point. The composer is a sheet with a
  280-character field and live counter, plus the profile's posts on that event with Delete.
  Musicians learn an event went live because `publishEvent` now also notifies every lineup
  profile's members ("You're on the bill", kind `show_announced`, refId the eventId).
- **Venue screen.** New `app/venue/[handle].tsx`: photos, about, neighborhood and city,
  upcoming events, Follow. Mobile had no public curator route before this (the artist route
  rejects curator profiles), and a followable venue needs a page.
- **Search tab** stays the sub-8 placeholder.
- **Notification taps**: `show_announced`, `show_rescheduled`, `show_post` open
  `/event/[eventId]`; `new_music` opens `/artist/[handle]` (handle resolved from the profileId
  in `refId` with one `get`).

### Web (`apps/web`)

- **`/discover`** (signed-in, same gate pattern as `/tickets`): Shows | Artists segments with
  the same chips and follow buttons as mobile. No deck on web.
- **`/u/[handle]`**: Follow button in the hero for both profile types; artist pages show the
  latest live post beside each upcoming show.
- **`/e/[eventId]`**: posts under each act; Follow buttons on the venue line and each lineup
  artist that has a profile.
- **Routing**: `SignedInRedirect` on `/` sends users who belong to no profile to `/discover`;
  profile owners keep `/dashboard`. The header nav gains "Discover" for signed-in users.
- **Posting on web**: "Post about this show" appears on `/e/[eventId]` for members of a lineup
  profile and on `/u/[handle]` upcoming-event rows for the profile's own members (client-side
  membership check); every profile dashboard shows "N followers" to its members.
- **`/admin`**: a "Show posts" panel listing the latest 50 live posts with Remove.
- **Landing**: new `FanStorySection` between the venue story and How it works, and a third hero
  path "Find a show" to `/discover` (logged-out visitors go through sign-in with
  `next=/discover`). Copy under antislop-copywriting, no invented numbers, metro unnamed unless
  the owner supplies one.
- Dashboard inbox rows deep-link like mobile (`/e/[eventId]` or `/u/[handle]`).

## 4. Data model

### Follows

`follows/{uid}_{targetId}`:

```ts
interface FollowDoc {
  uid: string;
  targetId: string;                 // profileId, or "genre:<name>" with name from GENRES
  targetType: "musician" | "curator" | "genre";
  createdAt: number;
}
```

The composite id makes "am I following X" one `get`; the fan's list is `where uid ==`; fan-out
is `where targetId ==`. Rules: `get`/`list` only when `resource.data.uid == request.auth.uid`;
all writes denied. Cap: 500 follows per user.

`ProfileDoc` gains `followerCount?: number` (server-maintained, absent means 0). Public in the
document, but v1 renders it only to the profile's own members.

### Events (server-derived fields, additive to sub-6)

```ts
genres: string[];            // <= 5, from GENRES
priceFromCents: number | null;
hasFreeTier: boolean;
```

- `genres` = union of the lineup's booking acts' `portfolio.genres`, capped at 5, recomputed
  wherever `lineup` is written. `createEvent` and `updateEvent` accept an optional curator
  `genres` (1 to 3 from `GENRES`) for standalone events whose acts are external; when the
  curator has set genres, theirs win over the derived set. Stored as `curatorGenres?: string[]`
  so the derivation stays recomputable.
- `priceFromCents` (minimum tier price, null when no tiers) and `hasFreeTier` are recomputed by
  `setEventTiers`.
- Pre-existing events lack these fields; readers treat absence as `[]`, `null`, `false`. A
  one-off backfill is not required for v1 (the seed script and every new event write them).

### Show posts

`events/{eventId}/posts/{postId}`:

```ts
interface ShowPostDoc {
  eventId: string;
  musicianProfileId: string;
  authorUid: string;
  text: string;                     // 1..280 chars after trim
  createdAt: number;
  status: "live" | "removed";
  removedBy?: "author" | "admin";
  removedAt?: number;
}
```

Rules: readable when the parent event is `published` or `completed` and `status == "live"`;
members of the event's curator profile, members of `musicianProfileId`, and admins read all.
Writes denied.

### Notifications

`NotificationDoc.kind` widens with `"show_announced" | "new_music" | "show_rescheduled" |
"show_post"`. `refId` carries the eventId (announce, reschedule, post) or the artist's
profileId (new music). `notifyUser` gains an optional `dedupeKey` used as the notification doc
id so a retried fan-out overwrites rather than duplicates. Push still goes out on every call.

### Users

`UserDoc` gains `genrePickerSeenAt?: number`, stamped by a dedicated callable
`markGenrePickerSeen()` (no input, idempotent) that both Done and Skip call, so a fan who skips
without following anything is still not nagged again. The device location is never written
anywhere.

### Indexes (new composites)

- `events (status, genres array-contains, startsAt)`
- `events (status, hasFreeTier, startsAt)`
- `profiles (type, status, name)`
- `profiles (type, status, portfolio.genres array-contains, name)`
- `profiles (type, status, updatedAt desc)` and `profiles (type, subtype, status)` for the deck's
  artist and venue candidate queries
- `follows (uid, targetType, createdAt)`
- posts: `(status, createdAt)` within the subcollection

Fan-out uses the automatic single-field index on `follows.targetId`.

## 5. Backend (`functions/src`)

### Follow callables

`followTarget({ targetId, targetType })` and `unfollowTarget({ targetId })`. Transactional:
validate the target (an approved profile of the matching type, or a known genre), create or
delete the follow doc, adjust `followerCount` on profiles. Idempotent (following twice, or
unfollowing something not followed, is a no-op success). Enforce the 500 cap with
`FOLLOW_LIMIT_MESSAGE`.

### `getDiscoverDeck`

Input `{ location?: { lat: number; lng: number }; excludeIds?: string[]; seed?: number }`,
authenticated only. Output `{ cards: DeckCard[]; seed: number }`, about 20 cards.

```ts
type DeckPreview = { trackPath: string; startSec: number; durationSec: number; artistName: string } | null;
type DeckCard =
  | { kind: "show"; id: string; eventId: string; title: string; startsAt: number; endsAt: number;
      venueName: string; neighborhood: string; distanceMeters: number | null; posterPath: string | null;
      lineupNames: string[]; curatorProfileId: string; curatorHandle: string;
      priceFromCents: number | null; hasFreeTier: boolean; latestPost: { text: string; artistName: string } | null;
      genres: string[]; preview: DeckPreview }
  | { kind: "artist"; id: string; profileId: string; handle: string; name: string; subtype: MusicianSubtype;
      genres: string[]; coverPhotoPath: string | null; avatarPhotoPath: string | null;
      nextShow: { eventId: string; venueName: string; startsAt: number } | null; preview: DeckPreview }
  | { kind: "venue"; id: string; profileId: string; handle: string; name: string; neighborhood: string;
      distanceMeters: number | null; photoPath: string | null;
      nextShow: { eventId: string; title: string; startsAt: number } | null; preview: DeckPreview };
```

Assembly:
1. Read the fan's follows (targets and followed genres).
2. Query published events with `startsAt` in the next 30 days (limit 100), approved musicians by
   `updatedAt` desc (limit 150), approved curator profiles with subtype `venue` (limit 100).
3. Drop artists and venues the fan already follows (their shows still appear), and anything in
   `excludeIds`.
4. Score each candidate: genre overlap with followed genres; a boost when a followed artist or
   venue is on the show; soonness (sooner within the 30 days scores higher); distance when
   `location` is given (haversine to the event or venue `geo`, artists inherit their next show's
   venue); a seeded shuffle term so two opens differ. The exact weights live in one pure
   function in `functions/src/discoverRank.ts` with unit tests on fixed fixtures.
5. Interleave by kind so no kind appears more than twice in a row.
6. Choose `preview` per card: artist = first approved track by `order`; show = first lineup
   booking act with an approved track; venue = first track of the first booking act on that
   venue's next published event; `null` otherwise.
7. Return storage paths, not URLs. Clients build public URLs directly (`public/tracks` and
   `public/photos` are world-gettable under `storage.rules`), so there are no per-card
   `getDownloadURL` calls.

Distances are computed from coarse geo where an event's address visibility is
"neighborhood", so "1.2 mi" is approximate by construction; the UI labels use "about".

### Show post callables

- `createShowPost({ eventId, musicianProfileId, text })`: caller is a member of
  `musicianProfileId`; that profile is in the event's `lineupMusicianProfileIds`; the event is
  `published` and `endsAt` is in the future; text trims to 1..280 chars; at most 3 live posts per
  profile per event (`SHOW_POST_LIMIT_MESSAGE`) and one post per 10 minutes per profile
  (`SHOW_POST_RATE_MESSAGE`); a closed event returns `SHOW_POST_EVENT_CLOSED_MESSAGE`. Writes
  the post, then fans out `show_post` to the artist's followers.
- `removeShowPost({ eventId, postId })`: members of the author profile (sets
  `removedBy: "author"`) or admins (`removedBy: "admin"`, plus an `AuditLogDoc` action
  `"show_post_removed"`). Removal is a status flip, never a delete.

### Fan-out

One helper, `notifyFollowers(targetIds: string[], note, dedupeKey)`, in
`functions/src/follows.ts`: pages `follows` by each `targetId` in chunks of 200, unions the
uids, and calls `notifyUser(uid, note, dedupeKey)` in batches of 50. Runs inline after the
primary write commits. A crash mid-run leaves some fans unnotified rather than double-notified,
and the dedupe key makes any retry safe, so no announce flag is stored on the event.

Hooks (all additive to existing functions):
- `publishEvent` success: targets = the curator profile, each lineup musician profile, and
  `genre:<g>` for each event genre. Kind `show_announced`, key `announce:{eventId}`, title
  "Show announced", body "{lineup or title} at {venueName}, {date}". The same call also
  notifies the members of every lineup musician profile ("You're on the bill", same kind and
  refId, key `bill:{eventId}`) so musicians can reach the event screen and post.
- Dedupe keys use create-if-absent semantics: a notification doc that already exists under the
  key is left untouched (no re-surfacing as unread, no second push).
- `updateEvent` on a `published` event: newly added lineup musicians' followers get
  `show_announced` with the same key (fans who already hold it are untouched by the overwrite).
  A changed `startsAt` sends `show_rescheduled` (key `resched:{eventId}:{newStartsAt}`) to the
  announce targets plus every attendee with a `valid` or `checked_in` ticket, and clears
  `reminderSentAt` when the new start is more than 24h out. This closes the sub-6 deferred item
  "a rescheduled published event does not re-notify holders or re-arm its reminder".
- `reviewTrack` with decision `approved`: followers of the profile get `new_music`, key
  `track:{trackId}`, refId the profileId.
- `createShowPost`: followers of the artist get `show_post`, key `post:{postId}`.

## 6. Mobile deck behaviour

- **Paging and fetch.** Pages of about 20; when the visible index is within 5 of the end, fetch
  the next page passing the ids shown so far as `excludeIds` (cap 200, oldest dropped) and the
  same `seed`. Pull-to-refresh at the top starts a new seed.
- **Cards** (DESIGN.md: solid elevated surfaces, never glass; Syne display, Sora body; Phosphor
  duotone icons; accent dosage respected):
  - Show: poster or the sub-6 branded placeholder, title, date and time, venue with neighborhood
    and "about 1.2 mi" when known, lineup names, the latest live post as one quoted line, "from
    $12" or "Free", buttons Tickets (pushes `/event/[eventId]`) and Follow venue.
  - Artist: cover photo (avatar fallback), name, subtype chip, genres, "Next: {venue}, {date}"
    when present, Follow; tapping elsewhere opens `/artist/[handle]`.
  - Venue: first photo, name, neighborhood and distance, "Next up" line, Follow; tap opens the
    new `/venue/[handle]` screen.
  - Follow is optimistic with rollback on failure; a followed target reads "Following" and a
    tap unfollows.
- **Audio.** One `useAudioPlayer` at deck level. `onViewableItemsChanged` at a 50 percent
  threshold swaps the source to the visible card's `preview.trackPath`, seeks to `startSec`,
  plays. Cards with `preview: null` show "No preview yet" and stay silent. Mute persists in
  AsyncStorage. Playback stops on tab blur, app background, and when flipping to List. Reuses
  the audio mode `_layout.tsx` already sets.
- **Location.** First deck open shows a skippable sheet, "Show what's close", with Allow and
  Not now. Allow requests foreground permission through expo-location (new native dependency).
  The position is fetched once per deck session and passed to the callable; denied or skipped
  means no distances. Re-prompt only from a "Turn on location" link in the deck empty state.
- **Genre picker.** Shown on first Discover open when the user has no genre follows and no
  `genrePickerSeenAt`: the `GENRES` list as chips, Done writes follows and stamps the flag, Skip
  only stamps. Never shown on the event screen or inside the buy flow. After a successful order
  (the existing confirmation state on both platforms) a fan with zero genre follows sees a
  one-line prompt "Want more shows like this?" preselecting the event's genres; dismissing
  stamps the flag.
- **Empty and error states**: branded per 9B primitives. Deck fetch failure offers Retry; an
  audio load failure marks that card silent and moves on; a location failure never blocks the
  deck.

## 7. Messages (shared)

New constants in `packages/shared/src/messages.ts`, compared with `===` on both platforms:
`FOLLOW_LIMIT_MESSAGE`, `SHOW_POST_LIMIT_MESSAGE`, `SHOW_POST_RATE_MESSAGE`,
`SHOW_POST_EVENT_CLOSED_MESSAGE`. Notification titles and bodies are built server-side from
one helper so web and mobile inboxes show identical text.

## 8. Testing

- **Shared**: genre derivation, price projection, and `discoverRank` scoring and interleave on
  fixed fixtures.
- **`emu:test`**: follow and unfollow (idempotency, cap, counter, invalid and unapproved
  targets); `getDiscoverDeck` (auth required, deterministic order for a fixed seed, followed
  targets excluded, interleave rule, preview choice for each kind, distance ordering with a
  location, `excludeIds` honoured); each fan-out hook (target union, dedupe-key overwrite on
  retry, added-lineup-only behaviour, reschedule reaching ticket holders and clearing
  `reminderSentAt`); posts (membership, lineup check, closed event, caps, rate limit, author
  and admin removal, audit entry).
- **`emu:rules`**: follows owner-only read, post visibility by event status and post status, all
  new writes denied, every new list query pinned.
- **Web**: lint, build, and live page loads of `/discover`, `/u/[handle]`, `/e/[eventId]`, `/`,
  and `/admin` (RSC discipline from sp9a: server files never import values from client modules).
- **Mobile**: lint and `expo export`. Deck audio, location, and paging feel are device-only and
  go on the owner smoke list.
- Every existing gate stays green: typecheck 5/5, shared 158, `emu:test` 704, `emu:rules` 103.

## 9. Out of scope (deliberate)

Search internals, map view, and filter-chip directories (sub-8). Saving or "interested" on
events (a free ticket already is the RSVP). Public follower counts. Per-kind notification mute
(unfollow is the lever; revisit if volume complains). Fan reporting of posts (admins see every
post). Photos on posts. Browser push. Following from the logged-out web. A musician location
field. A standalone posts feed. Any recommendation model beyond the scoring in section 5.
Backfilling `genres`, `priceFromCents`, `hasFreeTier` onto pre-existing events.

## 10. Owner-owed after merge

- New EAS dev build (expo-location joins expo-camera and react-native-qrcode-svg), then device
  smoke of the deck: audio swaps on swipe, mute persists, location allow and deny paths, both
  themes, phone width.
- Deploy and confirm the new Firestore composite indexes build.
- Optional: name the metro for the landing copy.

# Sub-project 2 (Musician Portfolio) audit

Read-only audit of the SP2 surface as it exists on `main` (post SP6 merge, 2026-09-01). Every
claim below was verified against code, not docs. Paths are relative to the repo root
`C:\Users\LeoArkos\GateKeepBeta`. Severity scale: Critical / High / Medium / Low. Owner values:
fix-now | SP7 | SP8 | 5c | launch-checklist.

Files read in full: `functions/src/{portfolio,tracks,media,storage,profiles,guards}.ts`, the
reaper section of `functions/src/scheduled.ts`, `storage.rules`, `firestore.rules`,
`tests-rules/storage-rules.test.ts`, `packages/shared/src/{storagePaths,validation}.ts` and the
SP2 parts of `types.ts`, `apps/web/app/u/[handle]/**`, `apps/web/app/dashboard/portfolio/**`,
`apps/web/src/portfolio/**`, `apps/web/src/components/{trackPlayback,MiniPlayer}.tsx`,
`apps/web/src/lib/firebase-server.ts`, `apps/web/app/layout.tsx`, `apps/web/next.config.ts`,
`apps/mobile/app/(musician)/{portfolio,dashboard}.tsx`, `apps/mobile/app/artist/[handle].tsx`,
`apps/mobile/src/portfolio/**`, plus targeted greps into review.ts, bookingVisibility.ts,
events types, admin page, ProfileContext, app.json, indexes, and the test suites.

Overall: the pipeline and rules are in good shape. Nothing found is Critical. The two items
that matter most for the next sub-projects are (1) the launch checklist's App Check plan would
break every server-rendered public page, and (2) the booking-visibility toggle UI that SP4
promised never shipped, which means `publicBooking` is always null in practice and SP7 has no
public preference data to browse on.

---

## A. Findings

### 1. App Check enforcement (as planned in the launch checklist) breaks SSR public pages
- Severity: High. Category: spec-drift / launch.
- Evidence: `apps/web/src/lib/firebase-server.ts:5-14` (anonymous client SDK, no App Check
  provider); `apps/web/app/u/[handle]/page.tsx:13-15` ("this page can't be gated behind App
  Check"); `README.md:491-499` and `:533-539` (flip Firestore, Functions AND Cloud Storage to
  enforce at launch).
- Defect: the `/@handle` and `/@handle/shows` routes read Firestore and resolve Storage download
  URLs from the Node server with a plain client SDK and no App Check token; enforcing App Check
  on Firestore or Storage rejects those reads.
- Scenario: launch day, console toggled to enforce per README; every artist and venue page
  returns the 500 branch (`page.tsx:395-398` rethrows non-permission errors) or 404s, and OG
  previews shared before launch go dead.
- Action: record the exception in the README launch checklist now. Longer term either (a) keep
  Firestore/Storage in monitor mode and rely on rules + ISR, or (b) move the public loaders to
  the Admin SDK with an explicit public projection (the fields the rules already expose) so the
  web server no longer depends on client-SDK reads. (b) also removes the per-render
  `getDownloadURL` calls (finding 19).
- Owner: launch-checklist (document now), SP8 for the Admin SDK move if search adds more SSR.

### 2. Booking visibility toggle UI never shipped; `publicBooking` is dead in practice
- Severity: High. Category: missing-feature / spec-drift.
- Evidence: `apps/web/src/portfolio/PortfolioForms.tsx:332-339,404` and
  `apps/mobile/src/portfolio/PortfolioForms.tsx:231-238,294` both carry the "SP4 Task 1 stopgap
  ... later SP4 task" comment and hardcode `DEFAULT_BOOKING_VISIBILITY` (all "curators"). A grep
  for any RateVisibility/PrefsVisibility control across `apps/web/src`, `apps/web/app`,
  `apps/mobile/src`, `apps/mobile/app` finds nothing. `functions/src/bookingVisibility.ts:95`
  only writes `publicBooking` when `visibility.preferences === "public"`.
- Defect: no musician can mark preferences public or a rate private, so the public "Booking
  preferences" sections (`MusicianProfile.tsx:174-204`, mobile `artist/[handle].tsx:332-342`)
  can never render for a real user, and the editor copy "Visible to curators only" is the only
  option that exists.
- Scenario: SP7 tries to filter or rank fans' browse results by act size, availability, or gig
  types from the approved profile doc and finds every `publicBooking` is null.
- Action: ship the per-field toggle (four controls: three rates "curators / private", prefs
  "public / curators") on both editors, or explicitly rule that prefs are public by default and
  change the backfill default. Delete the stale stopgap comments either way.
- Owner: fix-now (small, both clients), or first task of SP7 since SP7 depends on it.

### 3. Concurrent duplicate trigger delivery can delete the review clip it just produced
- Severity: Medium. Category: bug.
- Evidence: `functions/src/media.ts:155-172`. Both invocations upload to the same
  `reviewTrackPath(profileId, trackId)`; the orphan branch at `:168-171` deletes that shared path
  by name with no generation match, whenever the doc is no longer "processing".
- Defect: Eventarc storage triggers are at-least-once; two deliveries of the SAME generation that
  both pass the guard read (`:101`) and both finish `download()` before either reaches the
  `finally` staging delete will both transcode. Invocation A writes `pending_review`; invocation
  B re-reads, sees `pending_review`, and deletes the review object A's doc now points at.
- Scenario: musician sees "In review"; admin's queue row has no playable clip; approve hits the
  404 branch in `tracks.ts:274-277` ("review clip is missing") and the musician is asked to
  re-upload a track that never failed.
- Action: make the orphan cleanup conditional. Cheapest: `bucket().upload()` returns the File
  with its generation; delete with `{ ifGenerationMatch: uploadedGeneration }` so a later
  identical-path upload from the other invocation is not removed. Alternatively include the
  staging generation in the review object name and record it on the doc. The existing
  "re-upload after pending_review" test (`functions/test/media.test.ts:126`) covers the
  sequential case only; the emulator cannot reproduce the concurrent one, so add a comment
  and a unit-level guard test around the conditional delete.
- Owner: fix-now.

### 4. ffmpeg / ffprobe run on untrusted bytes with all protocols enabled (blind SSRF surface)
- Severity: Medium. Category: security.
- Evidence: `functions/src/media.ts:58-61` (ffprobe) and `:149-154` (ffmpeg): no
  `-protocol_whitelist`, no demuxer restriction. `storage.rules:52` only checks the declared
  `Content-Type` header; `validateTrackCreate` (`validation.ts:223`) checks the declared string.
  Format is sniffed from bytes server-side (by design).
- Defect: ffmpeg's HLS, DASH, and concat demuxers probe by content (`#EXTM3U` etc.), so a text
  playlist uploaded with `contentType: audio/mpeg` makes ffprobe and ffmpeg fetch `http(s)://`
  URLs (including the Functions VPC / metadata endpoint) or `file:` paths named in it.
- Scenario: attacker uploads a playlist naming internal URLs; the function makes outbound
  requests it should never make. Exfil is limited (output lands in `review/`, admin-readable
  only) so this is blind, but it is still a server-side request forgery from a privileged
  runtime.
- Action: add `-protocol_whitelist file` to both the ffprobe and ffmpeg argument lists (before
  `-i`), and consider `-f` auto-detect narrowing is not possible, so also keep `ffmpeg-static`
  / `ffprobe-static` pinned and bumped on a schedule (currently `^5.3.0` / `^3.1.0`).
- Owner: fix-now.

### 5. iPhone HEIC photos are rejected by storage rules with a bare permission error (mobile)
- Severity: Medium. Category: bug / ux.
- Evidence: `apps/mobile/src/portfolio/PortfolioForms.tsx:179` picks with `type: "image/*"` and
  `:191` sends `contentType: a.mimeType ?? "image/jpeg"`; `storage.rules:69` allows only
  `image/(jpeg|png|webp)`; `media.ts:303` allowlists the same three. Web's `<input accept>`
  (`apps/web/src/portfolio/PortfolioForms.tsx:308`) filters at pick time; mobile does not.
- Defect: the default iOS camera format is HEIC. The picker returns `image/heic`, the rules
  deny the upload, and the musician sees "Upload failed: Firebase Storage: User does not have
  permission..." for the avatar the submit gate requires.
- Scenario: first on-device wizard run on any iPhone with default camera settings cannot get
  past "a profile photo".
- Action: pick with `expo-image-picker` (which can re-encode to JPEG) or restrict the
  DocumentPicker `type` to the three allowed MIME types and show the format hint; alternatively
  accept `image/heic` in rules and add `heif` to the sharp allowlist (sharp decodes HEIF only if
  libvips was built with it, so the picker-side fix is safer). Add a storage-rules test for the
  HEIC rejection either way.
- Owner: fix-now (before the owner's EAS device smoke).

### 6. Mobile artist page has no "Upcoming events" section (web does, since SP6)
- Severity: Medium. Category: spec-drift / missing-feature.
- Evidence: web `apps/web/app/u/[handle]/page.tsx:249-269` and `MusicianProfile.tsx:206-220`
  query `events where lineupMusicianProfileIds array-contains ... status == published`. Mobile
  `apps/mobile/app/artist/[handle].tsx` has only `loadShows` (gigs); grep for
  `lineupMusicianProfileIds` in `apps/mobile` returns nothing. sp2-rulings "Binding contracts"
  says the Shows section on both public pages gets real events/bookings.
- Defect: a fan who taps an act from `app/event/[eventId].tsx:483` into the artist page cannot
  see that artist's other ticketed events; the mobile page under-reports what the same profile
  shows on web.
- Scenario: SP7 builds fan discovery on mobile first and the artist landing surface is missing
  the one section fans care about (what can I buy a ticket to).
- Action: port `loadMusicianUpcomingEvents` to the mobile page (same query, existing composite
  index), render with the existing card idiom, link rows to `/event/[eventId]`.
- Owner: SP7 (or fix-now, it is small).

### 7. A gig promoted to an event renders twice on the web artist page
- Severity: Low. Category: ux.
- Evidence: `EventDoc.gigId` ("set when promoted from a filled gig", `types.ts:917`); the gig
  itself stays `filled`, so `fetchMusicianShowEntries` (`page.tsx:143-159`) lists it under Shows
  while `loadMusicianUpcomingEvents` lists the event under Upcoming events. No dedupe in either
  loader or in `MusicianProfile.tsx:206-261`. Same on the curator page.
- Defect: the same night appears as two rows with the same date, one linking to `/gigs/{id}`
  and one to `/e/{id}`.
- Action: when an upcoming event carries `gigId`, drop that gig from `upcomingShows` (or badge
  the show row "tickets available" and link it to the event). Decide once for both pages.
- Owner: SP7.

### 8. Twelve user-visible server strings contain em dashes (binding copy rule)
- Severity: Medium (rule violation, trivial fix). Category: docs / copy.
- Evidence (strings only, comments excluded): `functions/src/tracks.ts:34,240,241,276,301`;
  `functions/src/media.ts:52,185`; `functions/src/profiles.ts:90,167,250`;
  `packages/shared/src/validation.ts:224`. All reach the UI verbatim: callable errors are shown
  with `window.alert`/`Alert.alert` on both clients, `failureReason` renders in both
  TrackManagers, and the reviewer-note bodies go out as notifications. (`media.ts:351` is a log
  line, not user-visible, but is included in the same sweep.) The five in-scope web/mobile UI
  files have zero em dashes; the web TrimUploader uses an en dash (`&ndash;`) for the clip
  window range and mobile a literal en dash, which the rule does not forbid but note the
  inconsistency with `gigDisplay.ts:50-57` which chose a middot.
- Action: replace with a colon or a period. `HANDOFF.md` says "no em dashes anywhere: code,
  comments, copy" so the comment-level ones (portfolio.ts 9, tracks.ts 24, media.ts 32,
  profiles.ts 33, validation.ts 15, storage.rules 8, firestore.rules 30) are also out of rule,
  but the strings are the ones that matter to users.
- Owner: fix-now.

### 9. Firebase project config is hardcoded to the dev project on the web server and client
- Severity: Medium. Category: launch.
- Evidence: `apps/web/src/lib/firebase-server.ts:8-14` and `apps/web/src/lib/firebase.ts:11-13`
  hardcode `gatekeep-dev-jg`; only the emulator switch is env-driven. `functions/src/storage.ts:8`
  has a `STORAGE_BUCKET` env override but the web has none.
- Scenario: a production Vercel deploy silently renders dev-project profiles at the real domain.
- Action: read `NEXT_PUBLIC_FIREBASE_*` env vars with the dev values as the fallback, and add the
  production values to the README env table.
- Owner: launch-checklist.

### 10. No sitemap.ts / robots.ts even though the README's trigger condition is now met
- Severity: Low. Category: missing-feature (SEO).
- Evidence: `find apps/web -name "sitemap*" -o -name "robots*"` returns nothing; nine files now
  link to `/@${handle}` (`MusicianBrowse.tsx`, `MusicianCard.tsx`, dashboard pages, shows pages).
  README "Sub-project 2 polish follow-ups" deferred this "once something links to /@handle
  elsewhere in the app".
- Action: `app/robots.ts` (allow `/@*`, `/gigs`, `/e/*`; disallow `/dashboard`, `/admin`) and
  `app/sitemap.ts` listing approved handles (needs an Admin SDK or a server-side handles
  projection, see finding 1). Belongs naturally with SP8.
- Owner: SP8.

### 11. Handle case variants are separate URLs (no redirect to the lowercase canonical)
- Severity: Low. Category: ux / SEO.
- Evidence: `page.tsx:353` lowercases for lookup; `generateMetadata` sets
  `alternates.canonical` to the stored lowercase handle (`:430`); no redirect from `/@Ava`.
- Defect: `/@Ava` and `/@ava` both 200. Canonical prevents duplicate indexing, but shared links
  with mixed case never normalize.
- Action: `redirect()` to the canonical form when `rawHandle !== profile.handle`.
- Owner: SP8.

### 12. External-link host allowlist misses the share-link hosts the mobile apps produce
- Severity: Low. Category: ux.
- Evidence: `packages/shared/src/validation.ts:86-91`: spotify only `open.spotify.com`; youtube
  lacks `m.youtube.com`; instagram lacks `instagr.am`. The Spotify app's share sheet emits
  `https://spotify.link/...`.
- Scenario: musician pastes the link their phone gave them and gets "That does not look like a
  spotify link."
- Action: add `spotify.link`, `m.youtube.com`, `instagr.am`; keep the userinfo/homograph tests.
- Owner: fix-now (one-line, with a validation test).

### 13. Public pages ship the authenticated client bundle
- Severity: Low. Category: perf (README follow-up).
- Evidence: `apps/web/app/layout.tsx:73-78` wraps every route in `AuthProvider` + `AppShell`;
  `AppShell.tsx:15-23` says `/u/[handle]` is "left bare" but it still mounts inside the
  providers. README follow-up (~1.2MB JS) is not done.
- Owner: SP8 (when public surfaces multiply).

### 14. Editor still uses window.alert / confirm / prompt (web)
- Severity: Low. Category: ux (README follow-up).
- Evidence: `apps/web/src/portfolio/PortfolioForms.tsx:31,76,86,133,266,279,397,407`;
  `TrackManager.tsx:46,110,124`; `app/dashboard/portfolio/[profileId]/page.tsx:180,187,196`.
- Owner: SP7 or a small polish pass; the README item stands.

### 15. No upload cancel and no beforeunload guard on web uploaders
- Severity: Low. Category: ux (README follow-up).
- Evidence: `TrimUploader.tsx` has no cancel path for the resumable task and no `beforeunload`
  listener anywhere in `apps/web` (grep). A navigation mid-upload leaves a "Processing..." doc
  that only the 24h reaper clears (the catch block cleanup only runs on a thrown upload error).
- Owner: fix-now if cheap (task.cancel() + a `beforeunload` while `busy`), else SP7.

### 16. No positive save-success feedback on either editor
- Severity: Low. Category: ux (README follow-up).
- Evidence: `BioGenresForm` exposes `onSaved` but neither page passes it
  (`dashboard/portfolio/[profileId]/page.tsx:261`, mobile `portfolio.tsx:298`); buttons revert
  from "Saving..." with no confirmation; `LinksForm`/`BookingForm` have no success signal at all.
- Owner: SP7 polish pass.

### 17. Mobile audio upload still materializes the whole file in memory (25 MB cap stays)
- Severity: Low. Category: ux (README follow-up).
- Evidence: `apps/mobile/src/portfolio/TrimUploader.tsx:27-28,192,238` (`fetch().blob()`),
  `uploadBytesResumable` of a Blob. The README's `uploadAsync` streaming follow-up is not done.
- Owner: SP7 or launch polish (the cap is an honest, documented mobile-only limit).

### 18. `ProfileContext.switchTo` still takes a caller-supplied summary unreconciled
- Severity: Low. Category: docs (README follow-up, not a live bug).
- Evidence: `apps/mobile/src/shell/ProfileContext.tsx:61` (`switchTo: setActiveContext`).
- Owner: SP7 if it adds a new `switchTo` caller.

### 19. Storage URLs resolved with `getDownloadURL` on every SSR render (and per card, later)
- Severity: Low today, Medium for SP7. Category: perf / cost.
- Evidence: `page.tsx:80-90` (`storageUrl`), called once per track, avatar, cover, and gallery
  photo per render; ISR (`revalidate = 60`) bounds repeats. Mobile `artist/[handle].tsx:189-192`
  does the same per open with no cache.
- Defect: `public/` objects are world-readable by rule, so the tokenized URL is unnecessary: the
  deterministic REST form
  `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodeURIComponent(path)}?alt=media`
  serves without a token. A browse grid of 50 avatars would otherwise cost 50 round-trips.
- Action: have the photo/track pipelines write the final URL (or let clients build it from the
  path with one shared helper in `storagePaths.ts`), and stop calling `getDownloadURL` for
  `public/` paths on both platforms.
- Owner: SP7 (prerequisite for any grid).

### 20. Admin tracks-queue name resolution still uses `Promise.all`
- Severity: Low. Category: bug (README follow-up).
- Evidence: `apps/web/app/admin/page.tsx:610,794`. One denied/failed profile read drops the
  whole queue snapshot update.
- Owner: fix-now (mechanical `allSettled` swap).

### 21. "Failed" tracks have no retry affordance, and the reaper's reason is misleading
- Severity: Low. Category: ux / spec-drift.
- Evidence: spec section 6 lists "failed+retry"; both TrackManagers render the badge and
  `failureReason` only (`web TrackManager.tsx:77-81`, `mobile TrackManager.tsx:93-95`); the only
  path forward is delete + re-upload. `scheduled.ts:154` stamps `"Upload abandoned"` on any track
  stuck in "processing" > 24h, including one whose trigger crashed or timed out (storage-trigger
  retry is off per `media.ts:203-206`), which is not abandonment.
- Action: add a "Try again" that re-opens the uploader pre-filled with the title (server side is
  already fine: a failed doc does not occupy a slot); word the reaper reason neutrally ("Upload
  did not finish. Delete this track and try again.").
- Owner: SP7 polish.

### 22. Ten-track cap relies on query-in-transaction semantics; no counter document
- Severity: Low. Category: bug (latent) / SP7 prerequisite.
- Evidence: `tracks.ts:30-51` reads a `where("status","in",...)` query inside the transaction.
  The concurrency test at `functions/test/tracks.test.ts:72-97` runs against the emulator, which
  serializes callables, so it proves nothing about production contention on query result sets.
- Defect: whether production Firestore treats a matching insert by a concurrent transaction as a
  conflict for a query read is not something this repo verifies; worst case is an 11th active
  track, cosmetic.
- Action: maintain `trackCounts: { active, approved }` on the profile doc inside the same
  transactions (createTrack, reviewTrack, deleteTrack, reaper). That makes the cap unambiguous
  and gives SP7 the "N tracks" facet for free.
- Owner: SP7.

### 23. Test gaps in the SP2 area
- Severity: Low. Category: test-gap.
- `tests-rules/storage-rules.test.ts` never exercises the 50 MB / 10 MB size caps (every upload
  is 3 bytes) nor an `image/heic` rejection (finding 5).
- No test asserts the transcode output duration is <= `MAX_CLIP_SECONDS` for a source longer
  than 30s with a nonzero `startSec` (`media.test.ts:31` checks "<= 30s" from `startSec: 0`
  only, `:47` checks the short-remainder case).
- No test that `processUpload` leaves the doc untouched when a duplicate delivery arrives after
  the staging object is gone (the 404 branch at `media.ts:116-130`).
- No web or mobile component tests exist for any SP2 surface (known project-wide state).
- Owner: fix-now for the first two (cheap), SP7 for the rest.

### 24. Audio player error and loading states are silent on both platforms
- Severity: Low. Category: ux.
- Evidence: web `trackPlayback.ts:89-91` resets `playing` on `onerror` with no message; a
  missing object is filtered out at load (`page.tsx:303-305`) so the track vanishes rather than
  showing "unavailable". No buffering indicator (the button flips to Pause before audio starts).
  Mobile `artist/[handle].tsx:270-277` calls `player.replace/play` and never reads
  `status.error` or `status.isBuffering`; a bad URL just stays "playing".
- What is right: one clip at a time on both platforms (`trackPlayback.ts:101`, single
  `useAudioPlayer` on mobile), keyboard operable with `aria-pressed`/`aria-label` and
  focus-visible rings, MiniPlayer has `role="region"` + progressbar, `playsInSilentMode` set
  once at app start (`apps/mobile/app/_layout.tsx:103-110`), and background playback is not
  enabled (no `UIBackgroundModes` in `app.json`), which is acceptable for 30s clips.
- Action: surface `status.error` on mobile (toast + clear `playingId`), show a one-line
  "Couldn't play this track" on web from `onerror`, and a buffering spinner state on both.
- Owner: SP7 polish.

### 25. Chip label parity: mobile shows raw option codes
- Severity: Low. Category: ux / copy.
- Evidence: mobile `PortfolioForms.tsx:77` (`label={g}` renders "hip-hop", "r&b"),
  `:312` (`g.replace("_"," ")` renders "bar club"), `:326,339` raw; web uses `formatChipLabel`
  ("Hip Hop", "Bar Club"). The two "Add ... before submitting" hints also differ (Intl.ListFormat
  on web vs plain join on mobile, a documented Hermes acceptance).
- Action: move `formatChipLabel` into `@gatekeep/shared` and use it on mobile.
- Owner: SP7 polish (mobile UI touches).

### 26. Rates are USD by construction with no currency field
- Severity: Low. Category: spec-drift (documented single-metro assumption).
- Evidence: `RateAmount { amountCents, note }` (`types.ts:140`); "$" hardcoded in both
  BookingForms; `Number(raw)` on mobile `decimal-pad` will produce NaN for a locale comma.
- Owner: 5c / SP8 when a second market or band splits arrive; note it in the money docs now.

### 27. Curator public doc exposes internal-only fields
- Severity: Low. Category: security (information exposure, not a leak of secrets).
- Evidence: `firestore.rules:62` returns the whole approved profile doc; `CuratorDetails`
  includes `advertisingInterest` and `amenities.notes`, neither rendered publicly but both
  readable. Musician docs are clean: `lastRejectedAt`/`resubmitCount` are deleted on approve
  (`review.ts:92`) and `rejectionReason` is nulled; `uploaderUid` on approved tracks is the
  accepted exception (ruling 7); member `get` on approved profiles exposes uid + label (accepted
  precedent).
- Action: none required for SP2; if a public projection is ever built (finding 1b), leave these
  out.
- Owner: SP7 (only if profile docs get projected).

### 28. Tracks subscription errors are unhandled on the web editor
- Severity: Low. Category: bug (silent failure).
- Evidence: `app/dashboard/portfolio/[profileId]/page.tsx:130-136` and web
  `TrackManager.tsx:36-41` pass no error callback to `onSnapshot`; the mobile equivalents log.
  A rules/offline error leaves the list empty and the submit gate says "at least one track".
- Owner: fix-now (add the callback, show the existing error affordance).

### 29. SEO extras missing
- Severity: Low. Category: missing-feature.
- Evidence: `page.tsx:427-438` sets title, description, canonical, OG (type profile, cover
  image); no `twitter` card, no JSON-LD (`MusicGroup` / `Event`), OG image is the 1600px "inside"
  cover which may be portrait. `metadataBase` is correctly omitted until `NEXT_PUBLIC_SITE_URL`
  or Vercel's env exists (`layout.tsx:51-62`).
- Owner: SP8.

### 30. Storage `staging/` 24h lifecycle rule still not represented anywhere in the repo
- Severity: Medium (already a recorded LAUNCH BLOCKER). Category: launch.
- Evidence: `firebase.json` has no lifecycle config; no `lifecycle.json`; README manual
  follow-ups still list it. The `finally` cleanup in `media.ts:211-214` handles every path where
  the trigger runs; the rule is the backstop for triggers that never fire.
- Action: commit a `storage-lifecycle.json` plus the `gcloud storage buckets update` command to
  the launch checklist so it is versioned.
- Owner: launch-checklist.

---

## B. Status of README "Sub-project 2 polish follow-ups" and sp2-rulings obligations

| Item | Status | Evidence |
|---|---|---|
| Resolve Storage download URLs at write time (web public page) | NOT DONE | `page.tsx:80-90` per render; finding 19 |
| Split a public route group without the auth bundle | NOT DONE | `layout.tsx:73-78`; finding 13 |
| Add `sitemap.ts` / `robots.ts` once something links to `/@handle` | NOT DONE, condition met | nine linking files; finding 10 |
| Server-side Sentry `instrumentation.ts` | NOT DONE | only `apps/web/instrumentation-client.ts` exists |
| Admin tracks-queue `Promise.allSettled` | NOT DONE | `admin/page.tsx:610,794`; finding 20 |
| Replace `window.alert/confirm/prompt` | NOT DONE | finding 14 |
| Upload cancel + `beforeunload` guard | NOT DONE | finding 15 |
| Accessibility pass (aria-pressed, label pairing, focus-visible) | PARTIAL | `Chip` has aria-pressed, icon buttons have aria-labels, focus-visible rings present, inputs wrapped in `<label>`; no explicit id pairing but wrapping is valid |
| Positive save-success feedback | NOT DONE | finding 16 |
| `deleteProfile` server-gated to draft/rejected | DONE | `profiles.ts:247-251`, test `profiles.test.ts` |
| Mobile `TrimUploader` native streaming, lift 25 MB cap | NOT DONE | finding 17 |
| `ProfileContext.switchTo` reconciliation | NOT DONE | `ProfileContext.tsx:61`; finding 18 |
| Abandoned `processing`-track reaper | DONE | `scheduled.ts:146-163`, test `scheduled.test.ts:355` |
| Storage `staging/` 24h lifecycle rule (launch blocker) | NOT DONE | finding 30 |
| `PUBLIC_PROFILE_HOST` placeholder (mobile) | NOT DONE (link hidden by design) | `app/(musician)/portfolio.tsx:20-24` |
| `NEXT_PUBLIC_SITE_URL` for canonical/OG | HANDLED IN CODE, value owed | `layout.tsx:58-62` with Vercel fallback |
| sp2: review deferred admin/internal list at SP3 | DONE | `guards.ts` is the single `requireAuthUid`/`requireVerifiedEmail`; `searchUsersByName`, invite sweep, `deleteProfile` gate all exist; `(musician)/account.tsx` is a 4-line re-export |
| sp2: EAS production build + native App Check | NOT DONE | README manual follow-ups; `app.json` has an EAS projectId now |
| sp2: widen `private/booking` reads to approved curators | SUPERSEDED (SP4) | `firestore.rules:90-98` tightened; `private/curatorBooking` projection at `:107-128` is the curator surface |
| sp2: curator profiles get wizard/portfolio treatment | DONE (SP3) | `apps/*/src/curator/CuratorForms.tsx`, `processPhoto` gallery kind |
| sp2: suspension must sweep `public/` prefixes | N/A | no suspended status exists (`ProfileStatus` has four values); reject-from-approved deliberately leaves objects (ruling 3) |
| sp2: Shows section renders only platform bookings/events | DONE web, PARTIAL mobile | web: gigs + events; mobile: gigs only; finding 6 |
| sp2: per-field booking visibility (SP4 promise in code comments) | NOT DONE | finding 2 |

Check 1 sub-items verified as correct with no finding: generation-pinned staging reads,
path-derived membership (never object metadata), `finally` staging cleanup on every path,
sharp re-encode strips EXIF (tested `media.test.ts:219`), decoded-format allowlist (jpeg/png/webp),
`limitInputPixels`, 50 MB / 10 MB caps in rules + shared validator, mobile 25 MB client cap,
`failed` status + reason surfaced in both TrackManagers, subprocess timeouts, safe-message
classes so ffmpeg stderr never reaches a member-readable doc, delete-during-transcode re-check.

Check 2 verified: world-readable surface is exactly approved `profiles/{id}` (whole doc),
approved `tracks` under approved profiles (status-filtered list only), `handles/{h}` get (not
list), `members/{uid}` get (not list), `public/{tracks|photos}/...` objects (no list). No
emails, no `private/*`, no reliability, no Stripe flags, no rates. Download URLs are
tokenized but the objects are public by rule, so hotlinking is possible by design (plain HTTPS
per spec 3); revisit with a CDN if bandwidth matters. Unapproved handles 404 via
permission-denied-as-null (`page.tsx:395-396`) with `noindex`; case-insensitive lookup works.

Check 4 verified: https-only regex (blocks `javascript:`, `data:`, userinfo tricks), 300-char
cap, 8-link cap, domain allowlists per kind, server re-trims and strips extra keys
(`portfolio.ts:37-39`); web renders with `rel="noopener noreferrer nofollow" target="_blank"`
(`MusicianProfile.tsx:283-292`), curator map link with `rel="noopener noreferrer"`
(`CuratorProfile.tsx:152`); mobile filters to `https://` before `Linking.openURL`.

Check 6 verified: three structures declared as `{amountCents, note}` each, all optional;
both clients call the shared `validateBookingUpdate` so gate strings are identical to the
server's; server normalizes absent to null and strips extra keys.

---

## C. What SP7 (fan discovery) and SP8 (search) must know from this area

Data that exists on an approved musician profile doc today (world-readable):
`name`, `handle`, `subtype` (solo | band), `portfolio.{bio, genres[1..3], externalLinks,
avatarPhotoPath, coverPhotoPath}`, `publicBooking` (always null until finding 2 is fixed),
`createdAt`, `updatedAt`. Under it: approved `tracks` (title, durationSec, storagePath, order).
Related: `gigs` where `bookedMusicianProfileId == id` (filled/closed), `events` where
`lineupMusicianProfileIds` contains id (published).

What is missing for browse / filter / rank:
- Location. Musicians have no city and no geo anywhere on the profile. `travelRadiusKm` has
  no origin; `UserDoc.homeCity` is per user, owner-readable only, and a profile can have many
  members. SP7 needs `portfolio.homeCity` (+ geohash) on the profile, geocoded through the
  existing SP3 geocoder with its budget, and an editor field on both platforms.
- Denormalized counters: approved track count, upcoming show count, completed show count
  (today only inside `private/curatorBooking.reliability`, curator-readable), follower count.
  Finding 22's counter pattern is the place to start.
- Recency / popularity: no `approvedAt`, `lastActiveAt`, play counts, or profile-view counts.
  Track plays are plain `<audio>` / expo-audio fetches of a public object with no beacon.
- A featured track: `order == 0` is implicit; the hero button uses `tracks[0]`.
- Display-ready photo URLs: see finding 19 (deterministic public URL, no `getDownloadURL`).
- Card-sized image variants: avatars are 512x512, covers up to 1600px; a browse grid wants a
  ~400px cover variant written by `processPhoto`.
- Public booking prefs: blocked on finding 2.

Query and index facts:
- `profiles` reads are rules-provable for strangers only with `status == 'approved'` pinned;
  `MusicianBrowse.tsx:127` already does `type == musician AND status == approved` with no
  limit and filters genre/act size in memory, then reads `private/curatorBooking` per card.
  Do not copy that shape for fans: it is unbounded and the per-card read is curator-only.
- Any `array-contains genres` + `status` + `orderBy` combination needs a new composite index in
  `firestore.indexes.json`; the emulator will not tell you.
- `handles` cannot be listed; a public handle directory needs a server-side projection.
- SSR reads are anonymous client-SDK reads (finding 1); a fan browse page rendered on the
  server inherits the same App Check constraint and the same per-request read cost (ISR helps
  only for identical URLs).
- The Shows/events sections cap at 20/20 in JS after an unbounded fetch; a discovery feed must
  query with `limit` and a cursor instead.

Follow / save: nothing exists. Minimum shape: `users/{uid}/follows/{profileId}` (owner-only
read/write via rules would be the first client-writable collection in the app; the project
convention so far is Cloud Functions only, so plan a `followProfile` callable) plus a
denormalized `followerCount` on the profile maintained transactionally, and a
`profiles/{id}/followers` server-side list only if notifications need fan-out. Saving an event
mirrors the same shape keyed by eventId.

Public page facts SP7/SP8 will inherit: `/@handle` is canonical (`/u/handle` 308s), ISR 60s,
unapproved and unknown handles both 404 with noindex, metadata comes from `generateMetadata`
in `page.tsx`, mobile deep link is `/artist/[handle]` (musicians only; curators have no mobile
public page). The mobile fan tab already has a "Search, coming soon" stub at
`apps/mobile/app/(fan)/search.tsx`.

---

## D. Accepted exceptions reviewed

- `uploaderUid` public on approved tracks (ruling 7): fine, but if a public projection is ever
  built, drop it.
- Reject-from-approved leaves `public/` objects (ruling 3): fine given the documented two-step;
  note that the ISR cache means the page can serve for up to 60s after unpublish, which the
  page comment already accepts.
- Mobile 25 MB cap (ruling 6): still correct.
- Emulator serializes callables so reviewTrack's transactional claim is untested (tracks.ts
  comment): fine; finding 3 is the trigger-side sibling that is NOT covered by a transaction.
- Mobile `missing.join(", ")` instead of `Intl.ListFormat` (Hermes): fine.

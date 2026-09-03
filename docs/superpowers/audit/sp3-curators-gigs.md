# Audit: Sub-project 3 (Curator Profiles and Gig Postings)

Read-only audit against the code on `main` (2026-09-01). Every claim below was verified in source, not in docs; `path:line` references are to the current files. Items sp3-rulings.md records as conscious accepted exceptions are left out unless the acceptance looks wrong (said explicitly where so).

Files read in full: `functions/src/{curator,geocode,gigs,gigSeries,scheduled,adminTools,review,guards}.ts`, the SP3 parts of `firestore.rules`, `firestore.indexes.json`, `packages/shared/src/{types,validation}.ts` (SP3 sections), all of `apps/web/app/dashboard/curator/**`, `apps/web/app/gigs/**`, `apps/web/src/{curator,gigs}/**`, `GigCard.tsx`, `app/u/[handle]/{page,CuratorProfile,gigDisplay,chipLabel,GalleryLightbox}.tsx`, `apps/web/src/bookings/GigBrowse.tsx`, the admin gigs/name-search sections of `apps/web/app/admin/page.tsx`, all of `apps/mobile/app/(curator)/**` (SP3 screens), `apps/mobile/src/{curator,gigs}/**`, `apps/mobile/src/bookings/GigBrowse.tsx`, and the test names in the six SP3 test files plus `review.test.ts`.

---

## A. Findings

Severity scale: Critical / High / Medium / Low. Owner values: fix-now, SP7, SP8, 5c, launch-checklist.

### 1. Profile unpublish and gig takedown never reach ticketed events
- Severity: **High**. Category: security / missing-feature.
- Evidence: `functions/src/review.ts:100-183` (cascade closes gigs, pauses series, unwinds bookings; no `events` branch). `firestore.rules:258` (events readable whenever `status == 'published'`, no curator-approval gate). `functions/src/ticketing.ts:83` (`createTicketOrder` checks only `event.status === "published"` and a future `startsAt`). `functions/src/events.ts:508` (`cancelEvent` requires an APPROVED curator profile). `functions/src/gigs.ts:432-467` (`takedownGig` touches gigs/series/bookings only; events carry a `gigId` link, see `apps/mobile/app/(curator)/events/index.tsx:364`).
- Defect: rejecting an approved curator (the admin unpublish path) or taking down a gig leaves that curator's published events live, purchasable, and un-cancellable by the curator.
- Failure scenario: an admin unpublishes a fraudulent venue. Its published event stays on `/e/{id}`, fans keep buying tickets (money to the curator's Connect account), the curator cannot cancel/refund because `cancelEvent` demands an approved profile, and no admin event takedown exists in the SP3/SP4 export list scanned. Same for a filled gig that was promoted to an event and then taken down at occurrence scope: the event survives.
- Action: in `reviewProfile`'s reject-from-approved branch, cancel every `published` future event of the profile through `cancelEventCore` plus the SP6 refund loop (or at minimum unpublish them); mirror in `takedownGig` for events linked by `gigId`; consider an admin `takedownEvent`. Add tests in `review.test.ts` and `gigs.test.ts`.
- Owner: **fix-now** (before any real ticket sale).

### 2. Geocoder fails open to the stub in production
- Severity: **High**. Category: bug / security.
- Evidence: `functions/src/geocode.ts:169-189` (`getGeocoder` returns `StubGeocoder` whenever `GEOCODER_PROVIDER !== "google"`, no environment check). `geocode.ts:38-59` (stub: hash-derived lat/lng in a 25 to 50 N, 66 to 125 W box; `city` = last comma segment).
- Defect: a production deploy that forgets `GEOCODER_PROVIDER` silently writes fake coordinates and a wrong `city` ("NY 11201" for "123 Main St, Brooklyn, NY 11201") onto world-readable profile and gig docs; nothing errors, nothing logs.
- Failure scenario: first prod deploy, env var missed (the README launch checklist is the only guard). Every venue and gig gets a plausible-looking pin somewhere in the US; SP7's map would render it; the `geocodedFrom` cache then keeps the wrong result until the address text changes.
- Action: fail closed outside the emulator: throw (or refuse to boot) when `process.env.FUNCTIONS_EMULATOR !== "true"` and the provider is unset; log the active provider at cold start. Keep the stub for tests only. Sp3 deferred minor "document loudly if reused outside dev" is not sufficient.
- Owner: **fix-now** (5 lines) plus keep the launch-checklist line.

### 3. `parseGoogleResponse` throws on city-less results and surfaces as an opaque `internal` error
- Severity: **Medium**. Category: bug.
- Evidence: `functions/src/geocode.ts:157-159` (plain `Error` when neither `locality` nor `administrative_area_level_1` is found). Callers only handle `null` (`gigs.ts:116`, `gigs.ts:286`, `gigSeries.ts:191`, `curator.ts:126`). No test covers it (`functions/test/geocode.test.ts` has no no-city case).
- Defect: plus codes, rural addresses, and some non-US results produce an uncaught error, so the client sees a generic "internal" failure instead of the friendly "Could not locate that" message, and the daily budget is still charged (`consumeGeocodeBudget` runs first).
- Action: return `null` (or fall back to `postal_town` / `administrative_area_level_2`) instead of throwing; add the test. Also give `GoogleGeocoder.geocode` a fetch timeout (`geocode.ts:77` has none; a hung upstream holds the callable to its 60 s limit).
- Owner: **fix-now** (small), or **launch-checklist** if deferred.

### 4. Recurrence times are UTC while everything else is local or `LAUNCH_TIMEZONE`, and the series UI never says which
- Severity: **Medium**. Category: spec-drift / ux.
- Evidence: materializer is genuinely UTC: `functions/src/scheduled.ts:67-80` (`Date.UTC`, `getUTCDay`) and fixed-millisecond steps `scheduled.ts:53-57`, so a weekly series keeps the same UTC instant across DST and its `LAUNCH_TIMEZONE` wall time shifts by one hour in March and November. In-form disclosure is present and byte-identical on both platforms with no em dash: `apps/web/src/gigs/GigForms.tsx:310` and `apps/mobile/src/gigs/GigForms.tsx:388` ("Times are in UTC for now, local-timezone support is coming. The end date above is also treated as UTC midnight."). One-off gigs in the same composer take DEVICE-LOCAL time: `apps/web/app/dashboard/curator/[profileId]/gigs/new/page.tsx:142` (`new Date(oneOffDate)`), `apps/mobile/src/gigs/GigForms.tsx:152-194` ("Time (24-hour, local)"). Every rendered occurrence is `LAUNCH_TIMEZONE` (`app/u/[handle]/gigDisplay.ts:24-30`). The series summary lines render the raw recurrence hour with no zone: `gigs/page.tsx:189-190`, `series/[seriesId]/page.tsx:221-223`, `apps/mobile/app/(curator)/events/index.tsx:507`, `series/[seriesId].tsx:181-183`.
- Defect: three different time bases inside one product; the disclosure exists only at composition time, and README quotes it with an em dash the code does not contain (README "Sub-project 3 launch checklist", UTC bullet).
- Failure scenario: a New York curator sets "Fridays 20:00". Occurrences render "Fri, 4:00 PM EDT" on every surface, then "3:00 PM EST" after November 1, while the series card keeps saying "Fridays, 20:00". A fan and the curator disagree with the card.
- Action: cheapest correct v1 for a single-metro launch: interpret `weekday/hour/minute/endDate` in `LAUNCH_TIMEZONE` inside `anchorFor` (compute the zone offset per candidate via `Intl.DateTimeFormat`), which also fixes DST drift; until then, append "(UTC)" to every series summary and fix the README quote.
- Owner: label + README **fix-now**; zone-aware materializer **launch-checklist** (before real curators post series).

### 5. Series past their `endDate` never become `ended`
- Severity: **Medium**. Category: bug / ux.
- Evidence: only `endSeries` writes `"ended"` (`functions/src/gigSeries.ts:391`); the sweep short-circuits an expired series (`scheduled.ts:109-111`, `347`) but never flips its status. Cap counts `active` (`gigSeries.ts:98-105`). Recurrence validation requires a future `endDate` on every edit (`packages/shared/src/validation.ts:349-354`).
- Defect: an expired series stays "Active" forever.
- Failure scenario: a 10-week series with an end date. After it passes: it still counts toward `MAX_ACTIVE_SERIES_PER_PROFILE` (10), still costs a scan plus a `count()` query every sweep (`scheduled.ts:332-371`), shows the green "Active" badge on both dashboards, offers "Pause series", and any template save fails with "End date must be in the future." unless the curator also changes the end date.
- Action: in step 1, when `recurrence.endDate != null && endDate <= now`, flip the series to `"ended"` (same batch as the watermark). This does not touch the pause-is-one-way invariant (ruling 19). Add a test.
- Owner: **fix-now**.

### 6. Materializer birth decision can race a whole-run accept and orphan open occurrences
- Severity: **Medium**. Category: bug (race).
- Evidence: `functions/src/scheduled.ts:380-420` (plain `get()` of the series and booking), `scheduled.ts:546-549` (non-transactional batch commit). `functions/src/bookings.ts:600-620` (acceptBooking's transaction fills only the open occurrences that already exist). The self-heal comment at `scheduled.ts:512-525` covers the stale-linkage clobber, not this direction.
- Defect: the TOCTOU re-read (ruling 21) protects `status`, not `activeBookingId`.
- Failure scenario: sweep re-reads series (`activeBookingId` null) -> acceptBooking commits (series booked, existing dates filled) -> sweep commits N new `open` occurrences plus the watermark. Result: a booked run with orphan `open` dates that are publicly listed, unbookable (the rebooking door at `bookings.ts:614` refuses everyone), carry no payment doc, and are never revisited because the watermark advanced. Window is milliseconds once a day, but the outcome is silent and money-adjacent.
- Action: make the per-series write a Firestore transaction that `tx.get`s the series doc before writing (both sides write `gigSeries/{id}`, so optimistic concurrency aborts one of them); ~28 writes per series is far under the 500 limit. Add a test that seeds the accept between the re-read and the commit.
- Owner: **fix-now** (small) or **5c** if money work is batched there.

### 7. Admin gig moderation list truncates before it filters
- Severity: **Medium**. Category: ux / moderation.
- Evidence: `apps/web/app/admin/page.tsx:789` (`where("status","==",status), limit(100)`, no `orderBy`), `:817-819` (subtype filter applied client-side after the limit), `:822-827` (empty state, no "more results" hint).
- Defect: the default non-venue view can hide non-venue gigs entirely once more than 100 gigs share a status.
- Failure scenario: 150 open gigs, 120 of them venue-posted. The 100 returned are arbitrary (document-id order); the moderation queue may show 0 of the 30 planner/host gigs it exists to surface, with an honest-looking "No gigs match this filter."
- Action: `orderBy("startsAt")` plus pagination, or denormalize `curatorSubtype` onto `GigDoc` so the query filters server-side (this field is also what SP7/SP8 will want for "venue vs house show" filters).
- Owner: **fix-now** for orderBy plus a "showing first 100" note; denormalized subtype **SP8**.

### 8. Neighborhood coarsening is a 0.01 degree rounding, not a neighborhood centroid
- Severity: **Medium**. Category: privacy / spec-drift (matters the moment SP7 draws a map).
- Evidence: `functions/src/geocode.ts:228-234` (`Math.round(v * 100) / 100`). Spec section 3 says "coarsened to neighborhood centroid". Public doc carries `neighborhood` name plus `city` (`gigs.ts:119-123`).
- Analysis: not reversible (many addresses map to one cell), but the true address is within +/-0.005 deg of the pin: about 555 m north-south and about 420 m east-west at 40 N, i.e. a few blocks. The pin never sits on a real landmark, so on a street-level map it reads as "this spot". Combined with the public neighborhood string and free-text title/description (see 9), a host's home narrows to a two-block radius. Venue default is public (`gigs.ts:107`) and the venue profile address is public by spec, fine. Reveal timing is correct: the exact address lives only in `gigs/{id}/private/location` (`firestore.rules:169-180`) and `gigSeries.templatePrivateLocation` (series never public, `rules:187`), and opens to the booked musician only when `bookedMusicianProfileId` names them. No leak found in `venueName` (null for non-venues), `geocodedFrom` (private subdoc for gigs; on the world-readable profile doc it equals the already-public city for hosts and the already-public address for venues).
- Action for the map: render neighborhood-precision gigs as an area (circle >= 600 m, or the neighborhood label only), never a point; consider a 0.02 cell or a deterministic per-gig jitter before any public map ships. Keep the schema.
- Owner: **SP7**.

### 9. Free text on public gigs is unguarded against self-doxxing
- Severity: **Low**. Category: ux / privacy.
- Evidence: `title` (80 chars), `description` (2000), `provisions.notes` (500) are public on open gigs (`rules:165`); the only privacy copy is the visibility hint (`apps/web/src/gigs/GigForms.tsx:259-264`, mobile `:312-317`), which speaks about the address field, not the description.
- Scenario: an individual host picks "Neighborhood only" and writes "Backyard at 14 Elm St, ring the side bell" in the description.
- Action: one line of copy under the description for non-venues ("Anything you write here is public; keep the exact address out of it") and, later, a server-side street-address regex warning.
- Owner: **SP7** (copy pass).

### 10. `updateSeries` propagation rewrites moderated and cancelled occurrences
- Severity: **Low**. Category: bug.
- Evidence: `functions/src/gigSeries.ts:253-278` skips only `detachedFromTemplate`, `filled`, `closed`; `taken_down` and `cancelled` future occurrences get their content and `private/location` rewritten (status untouched).
- Scenario: admin takes down a series (paused, siblings `taken_down`); the curator can still edit the template (`updateSeries` allows `paused`, `:151-153`) and every save rewrites the taken-down docs. Harmless for visibility, wasteful, and an audit-trail smell.
- Action: propagate only to `open`/`draft`. Trivial; add to the existing propagation tests.
- Owner: **fix-now**.

### 11. `endDate` boundary: an occurrence exactly on the end date is never created, and the comment says otherwise
- Severity: **Low**. Category: docs / test-gap / ux.
- Evidence: `functions/src/scheduled.ts:93-98` ("exactly at endDate is left for the following day's run"), but `windowEnd = min(now+8w, endDate)` (`:102-104`) is exclusive and `windowEnd <= materializedThrough` (`:109`) then returns forever; the day-after run cannot pick it up. Test at `functions/test/scheduled.test.ts:237-250` uses an off-grid end date so the exact-grid case is unpinned (sp3 deferred minor still open). Both forms send end date as UTC midnight (`GigForms.tsx:344-359` web, `:408-426` mobile), so any evening occurrence on the chosen end day is excluded, which contradicts the "End date" label's natural inclusive reading.
- Action: treat the end date as inclusive of that day (`endDate + 1 day` at submit, or label "Last date before"); fix the comment; pin with a test.
- Owner: **fix-now** (small).

### 12. Stale comments and docs contradicting the code (ruling 25b asked for exactly this check)
- Severity: **Low**. Category: docs.
- Evidence:
  - `functions/src/scheduled.ts:126-129`: "All four daily-sweep steps share ONE deferred WriteBatch (see createChunkedWriter)". False: per-step writers (`:152-155`) and one batch per series (`:527-549`).
  - `scheduled.ts:303`: "Steps 2-6 each own their own chunked writer". Steps 7 and 8 use direct writes, and there are eight steps.
  - `scheduled.ts:962`: "its five steps". Eight.
  - `README.md:168` and `:179`: "does five things", "Each of the five steps". Eight steps since SP4/SP6.
  - README SP3 launch checklist, UTC bullet: quotes the in-form text with an em dash; the code text uses a comma (`GigForms.tsx:310`).
  - README "Gigs & series": "the native equivalent (mobile)" of the public curator page. Mobile has no public curator route (`apps/mobile/app/artist/[handle].tsx:85-86` says so explicitly).
  - `functions/test/gigs.test.ts:567` title says "sweeps other OPEN siblings only"; the code sweeps open and filled (`gigs.ts:454`), which `:722` tests.
  - `scheduled.ts:93-98` endDate comment (see 11).
- Owner: **fix-now** (docs only).

### 13. Em dashes in user-visible server strings
- Severity: **Low**. Category: ux (binding project rule: none anywhere).
- Evidence (the dash itself is omitted here to keep this report clean; each line holds one between the two halves quoted): `functions/src/curator.ts:127` and `gigs.ts:21` ("Could not locate that" / "check spelling and try again."; note `curator.ts` duplicates the string instead of importing `GEOCODE_FAILURE_MESSAGE`), `gigs.ts:258` ("This gig is filled/closed" / "its schedule and terms are locked."), `gigs.ts:385` ("This gig is filled" / "cancel the booking instead."), `adminTools.ts:122` ("note limit reached" / "archive this account's notes"), `review.ts:243` (notification body "Reviewer note: ..." / "update and resubmit anytime.", pushed to every profile member), `profiles.ts:90`, `:167`, `:250`. All surface verbatim in client banners, alerts, and push notifications.
- Action: replace with a period or colon; import the shared constant in `curator.ts`.
- Owner: **fix-now**.

### 14. Curator-side flows still use browser dialogs
- Severity: **Low**. Category: ux.
- Evidence: `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx:226,231,237,242` (confirm/alert for pause/end), `gigs/[gigId]/page.tsx:242,247`, `[profileId]/page.tsx:136,145`, `apps/web/src/curator/CuratorForms.tsx:30,71,75,144,214,220,315,324`. The admin page moved every reason flow to `ReasonCard` in 9A (`admin/page.tsx:30-41`), leaving one `window.alert` at `:280`.
- Action: reuse `ReasonCard`/`CancelDialog`-style inline confirms on the curator pages; low priority.
- Owner: **SP7** or a 9A follow-up.

### 15. Series UI does not distinguish an admin pause from a curator pause, and the list badge hides pauses on mobile
- Severity: **Low**. Category: ux (tripwire for whoever adds `resumeSeries`).
- Evidence: `pausedBy`/`takenDown` absent everywhere (grep over `apps`, `functions`, `packages`, rules). Pause confirm copy is correct and permanent-sounding on both platforms (`series/[seriesId]/page.tsx:226`, mobile `series/[seriesId].tsx:196`: "This can't be undone."). After the fact the page shows only "Paused" plus an editable template and "End series". Mobile list renders every series status with a neutral badge (`apps/mobile/app/(curator)/events/index.tsx:504`) while the detail uses `SERIES_STATUS_TONE`.
- Action: use `SERIES_STATUS_TONE` in the mobile list; add a one-line "Paused series can't be resumed; end it or create a new one" note on the paused state. Ruling 19's requirements (approval gate plus `pausedBy`) still bind whoever adds resume.
- Owner: **fix-now** (cosmetic) / resume: the sub-project that needs it.

### 16. Name search: results capped at 10 with no indicator; backfill and test minors still open
- Severity: **Low**. Category: ux / test-gap.
- Evidence: `functions/src/adminTools.ts:8,33` (`SEARCH_LIMIT = 10`), `apps/web/app/admin/page.tsx:1453-1467` (renders results, no "showing first 10"). Zero-results empty state now exists (`:1468-1470`), Enter-to-search and busy lock exist. `adminTools.ts:69` still uses `batch.update` (throws if a user doc vanishes mid-backfill). No zero-results test and no isolated backfill write-path test in `functions/test/adminTools.test.ts`.
- Action: return `{ results, truncated }` and show a hint; `set(..., { merge: true })` in the backfill; add the two tests.
- Owner: **fix-now** (tests) / **SP8** (search UX).

### 17. Mobile chip labels show raw codes and status text; one unlabeled web input
- Severity: **Low**. Category: a11y / ux.
- Evidence: `apps/mobile/src/curator/CuratorForms.tsx:130,134` and `apps/mobile/src/gigs/GigForms.tsx:213,217,378` render `hip-hop`, `individual_host`, `biweekly` raw (web uses `formatChipLabel`); `apps/mobile/app/(curator)/dashboard.tsx:188` renders `profile.status.replace("_"," ")`. Web `CuratorForms.tsx:98-103` street-address input has a placeholder but no `<label>` (the city input beside it has one). `GalleryLightbox.tsx` is in good shape (sr-only title, labeled buttons, live counter).
- Owner: **SP7** polish / 9B follow-up.

### 18. Public gig detail does not link to the curator; curator page GigCards ship without the photo they already have
- Severity: **Low**. Category: ux / missing-feature (discovery).
- Evidence: `apps/web/app/gigs/[gigId]/page.tsx:249` ("Posted by {name}" plain text; the handle is available on the same profile doc it already fetched). `app/u/[handle]/CuratorProfile.tsx:302` passes no `photoUrl` to `GigCard` although `photoUrls[0]` is loaded three lines up. Mobile `GigBrowse.tsx:142-147` states no photo is wired.
- Owner: **SP7**.

### 19. Test gaps worth closing alongside the fixes above
- Severity: **Low**. Category: test-gap.
- Missing cases: getGeocoder fail-closed in prod (after 2); `parseGoogleResponse` no-city (3); `GoogleGeocoder.geocode` non-OK HTTP; expired-`endDate` series auto-end (5); materializer vs whole-run accept race (6); `updateSeries` propagation skipping `taken_down`/`cancelled` (10); exact-grid `endDate` (11); `searchUsersByName` zero results and backfill write path (16); reject-from-approved with a published event (1).
- Owner: **fix-now** with each fix.

### 20. Accepted-tier items re-checked and left as is (no action)
- Non-transactional cap reads (`gigs.ts:207-214`, `gigSeries.ts:98-105`, materializer `scheduled.ts:369-371`): two parallel publishes can exceed 50 by one; the materializer guard is per series. Consistent with ruling 20; fine.
- Batch sizes: reject cascade (`review.ts:74-175`) is open (<=50) + future filled + active series (<=10) + members, well under 500; `takedownGig` series scope sweeps at most one materialize window of siblings; `updateSeries` at most ~9 occurrences x2; approve-path `curatorAccess` writes are bounded by member count. All unchunked, all bounded.
- Sweep isolation: per-step try/catch plus per-series try/catch (`scheduled.ts:344-560`), one batch per series, watermark atomic with its occurrences. Poisoned-series tests exist (`scheduled.test.ts:391,437,468`).
- Secrets: `secrets: [geocoderApiKey]` declared on every geocoding callable (`curator.ts:88`, `gigs.ts:130,220`, `gigSeries.ts:78,131`, and SP6's `events.ts:186`); `resolveGigLocation` charges the budget itself (`gigs.ts:114`); budget is transactional and UTC-day keyed (`geocode.ts:206-219`). A failed lookup still costs one unit; acceptable.
- Rules: `geocodeBudgets`, `curatorAccessRetries` deny all (`rules:242,247`), `gigSeries` has no public disjunct, `private/location` opens to the booked musician only (`rules:175-178`). Rules tests cover open/draft/taken_down/filled/closed-unbooked and list provability (`tests-rules/rules.test.ts:480-667`).

---

## B. Status of every "Post-gate follow-up" and "deferred minor" in sp3-rulings.md

| Item (sp3-rulings.md) | Status | Evidence |
|---|---|---|
| Sweep step 5 per-doc try/catch | Fixed (SP4) | `scheduled.ts:658-665`; test `scheduled.test.ts:518` |
| `updateGig` neighborhood-to-public branch missing `\| undefined` | Fixed (SP4) | `gigs.ts:293-306`; test `gigs.test.ts:310` |
| `removeMember` isValidDocId + requireVerifiedEmail | Fixed (SP4) | `members.ts:166-168` |
| S4 test gap (remove member from already-rejected profile with stale marker) | Fixed (SP4) | `members.test.ts:483` |
| `deleteProfile` handle delete after cascade | Fixed (SP4) | `profiles.ts:299-325` (precondition read too) |
| Invite-accept fast path stale-TRUE marker race | Fixed (SP4) | `members.ts:106-122` calls `syncCuratorAccess` |
| `syncCuratorAccess` unbounded N+1 | Partly fixed | membership scan paginated `curator.ts:230-256`; per-profile reads still sequential but break on first approved (`:258-262`) |
| Task 3: StubGeocoder US bbox, "document loudly" | Open, and worse than recorded | fails open in prod, finding 2 |
| Task 3: `parseGoogleResponse` throws on no city | Open | finding 3 |
| Task 4b: path-prefix assertion | Closed | `curator.ts:180` |
| Task 5: non-transactional cap reads | Open by design | finding 20 |
| Task 5: empty `location: {}` patch is a rewrite | Open (low) | `gigs.ts:290-320` rewrites private doc on a visibility-only or empty object |
| Task 5: Google null-branch untested | Open | `parseGoogleResponse` ZERO_RESULTS tested (`geocode.test.ts:172`); `GoogleGeocoder.geocode` fetch path untested |
| Task 6: approve-path curatorAccess batch unchunked | Open, bounded | `review.ts:109` |
| Task 6: `syncCuratorAccess` sequential reads | Open, mitigated | early break, see above |
| Task 6: `updateGig`/`updateSeries` duplicate visibility logic | Open | `gigs.ts:265-320` vs `gigSeries.ts:164-217`; `events.ts` is now a third location-resolving caller (via `resolveGigLocation`, create-only), so the "third caller" trigger is close |
| Task 7: chunk rotation past 400 untested | Moot | step 1 no longer uses the chunked writer (`scheduled.ts:157-159`, `546-549`) |
| Task 7: `endDate` exact-boundary semantics unpinned | Open, plus a wrong comment | finding 11 |
| Task 7: reaper/invite sweeps fetch-all-then-filter | Open, now paginated | `scheduled.ts:597-606`, `622-631` |
| Status-palette duplication ("third-consumer rule") | Trigger has fired | `GIG_STATUS_BADGE` defined in `gigs/page.tsx:28`, `gigs/[gigId]/page.tsx:32`, `series/[seriesId]/page.tsx:30`, and `admin/page.tsx`; mobile already centralizes (`GIG_STATUS_TONE`) |
| Name search: debounce / pagination past 10 / zero-results state / zero-results test | Empty state fixed; rest open | finding 16 |
| `backfillDisplayNameLower` `batch.update` fragility; isolated write test | Open | `adminTools.ts:69`; no isolated test |
| `processPhoto` 3-read optimization | Not checked (media.ts out of scope) | |
| `resumeSeries` (ruling 19 tripwire) | Open by design; nothing resumes | exports `index.ts:14`; no client "Resume" anywhere; no `pausedBy`/`takenDown` field |
| Per-venue timezone | Open | `LAUNCH_TIMEZONE` only; finding 4 |
| Calendar-monthly recurrence | Open | `scheduled.ts:56` (+28 d) |
| Consume `fillMode` | Done (SP4) | `bookings.ts:137` |
| Wire `filled` status | Done (SP4) | `types.ts:203` |
| Widen `private/location` to booked musician | Done (SP4) | `rules:175-178` |
| M-13 / M-12 booking read boundary | Resolved (SP4) | per rulings 23/24 |
| `curatorAccessRetries` awareness in new paths | Followed, one conscious exception | `deleteProfile` logs instead of queuing (`profiles.ts:332-338`, reasoned) |
| Geocoder secret on every new geocoding onCall | Followed | `events.ts:186` |

---

## C. What SP7 (fan discovery) and SP8 (search) must know from this area

**Data that already exists and is world-readable (client SDK, no server needed)**
- `profiles/{id}` once `status == "approved"`: `type`, `subtype` (venue / planner / individual_host), `name`, `handle`, `curator.about`, `curator.photoPaths[]` (up to 12, `photoPaths[0]` is the de-facto hero), `curator.lookingFor {genres[], actSizes[], notes}`, `curator.amenities {capacity, hasPA, hasBackline, indoorOutdoor, notes}`, `curator.location {address (venues only), city, neighborhood (venues), geo {lat,lng} (exact for venues, city-level for planners/hosts), geocodedFrom}`, `curator.advertisingInterest` (internal flag but readable; consider whether that should stay public).
- `gigs/{id}` when `status` is `open` or `filled`, or `closed` with a booked musician: `title`, `description`, `wants`, `budget` (cents), `startsAt` (epoch ms), `durationMinutes`, `provisions`, `location {venueName, neighborhood, city, geo, addressVisibility, address?}`, `seriesId`, `bookingId`, `bookedMusicianProfileId`. `geo` is exact when `addressVisibility == "public"`, otherwise rounded to 0.01 degrees (finding 8). No `curatorSubtype`, no photo, no geohash, no timezone.
- `events/{id}` when `published` or `completed`: `location` reuses `GigPublicLocation`, `lineupMusicianProfileIds[]`, `startsAt/endsAt`.
- `gigSeries` is never public. A fan can only learn "this gig belongs to a series" (`seriesId != null`); cadence and fill mode are member-only (web gig detail attempts a member-gated read and hides on permission-denied).

**Rules provability constraints for any feed/list query (these are hard limits)**
- Every `gigs` list must pin `status == "open"` or `status == "filled"` (plus optional equality filters such as `curatorProfileId`, and a `startsAt` range). A `status == "closed"` leg must also constrain `bookedMusicianProfileId`. Unfiltered or `status in [...]` lists fail for non-admins (`rules:140-168`; tests `tests-rules/rules.test.ts:540-592`).
- Every `events` list must pin `status == "published"` (or `completed`).
- `profiles` lists need `status == "approved"` pinned (rule `rules:62`). Anything more expressive (geo radius, text search, multi-genre OR) must be server-side (a callable or a search index), which is what SP8 exists for. Precedent for a server prefix index: `users.displayNameLower` plus `searchUsersByName` (`adminTools.ts:18-40`); nothing equivalent exists on `profiles` or `gigs`.

**Indexes already deployed** (`firestore.indexes.json`): `gigs(status,startsAt)`, `gigs(curatorProfileId,status,startsAt)`, `gigs(seriesId,startsAt)`, `gigs(bookedMusicianProfileId,status,startsAt)`, `events(status,startsAt)`, `events(curatorProfileId,status,startsAt)`, `events(lineupMusicianProfileIds CONTAINS,status,startsAt)`, `gigSeries(curatorProfileId,status)`. There is no geo or genre index; genre/city filtering in both browse screens is client-side over the full open set (`apps/web/src/bookings/GigBrowse.tsx:96-103`, mobile `:231-234`), which stops scaling past a few hundred open gigs.

**Fields SP7/SP8 will likely need to add (schema notes)**
- A geohash (or S2 cell) on gigs, events, and curator profiles for radius queries; keep the coarsened public geo as the source for neighborhood-precision docs so the hash cannot leak more than the pin.
- `curatorSubtype` denormalized onto `GigDoc` and `EventDoc` (also fixes finding 7).
- A canonical metro/region id: `city` is free text from the geocoder ("New York" vs "Brooklyn"), and planner/host gigs carry the gig's own city, not the profile's.
- A photo reference on gig cards (curator `photoPaths[0]` is the cheapest), and the curator handle on the gig detail page (finding 18).
- `pausedBy` on `gigSeries` if SP7 or later ever exposes "pause/resume" (ruling 19 tripwire; still binding).

**Time handling**
- All rendering must go through `LAUNCH_TIMEZONE` helpers (`app/u/[handle]/gigDisplay.ts`, mobile `GigForms.tsx:86`); date-range filters must use `launchTzDayStartMs`/`launchTzNextDayStartMs` (already done in both browse screens). Series recurrence is UTC on the server (finding 4); do not derive "every Friday" copy from `startsAt` local weekday without accounting for that.

**Mobile**
- There is no public curator page on mobile (`apps/mobile/app/artist/[handle].tsx` is musicians only; README is wrong). SP7's fan surfaces on mobile start from zero for curators/venues.
- Mobile "View public page" is gated off behind a placeholder host (`(curator)/dashboard.tsx:25-26`); the real domain is a launch item.

**Moderation and lifecycle facts a discovery feed must respect**
- Only `status == "open"` gigs are bookable; `filled` is public but not applicable-to; the day after `startsAt` passes, the sweep closes open gigs (up to 24 h of a past-dated open gig is possible; `publishGig` refuses past dates but the materializer can birth an occurrence that becomes past before the next sweep only if the anchor is within the day).
- Profile unpublish closes open gigs and pauses series within the same request (`review.ts:116-171`), but today does not touch events (finding 1); a feed that lists events from unapproved curators is exposed until that is fixed.
- Series past `endDate` remain `active` (finding 5); do not use series status as a "still running" signal.

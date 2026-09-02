# Sub-project 4 (Booking Flow) audit

Read-only audit against code on `main` (4dab485), 2026-09-01. Scope: functions/src/{bookings,bookingLifecycle,bookingVisibility}.ts, scheduled.ts steps 6 and 7, the booking parts of review/gigs/gigSeries, firestore.rules + indexes, packages/shared booking code, apps/web/src/bookings/** plus the booking routes, apps/mobile/src/bookings/** plus the booking screens, and the three booking test files. Items recorded as conscious accepted exceptions (non-transactional dedupe/cap tier, step-7 at-most-one-lost-increment, birth-decision race, musicians-page membership gate) are listed in section B only, not re-raised as findings.

Verdict in one line: the server state machine is in good shape (turn checks, windows, grace, deposit intents and cascades all verified against code), the gaps are almost all on the client and product side, plus one client crash that is reachable through the ordinary sweep path.

## A. Findings

### 1. High | bug | Find musicians crashes on a summary-only `curatorBooking` doc (both platforms)

Evidence: `apps/web/src/bookings/MusicianBrowse.tsx:73` (`booking.preferences.availabilityPattern`), `apps/mobile/src/bookings/MusicianBrowse.tsx:183` (`RatesSummary rates={booking.rates}` then `rates[k]` at :36); writer at `functions/src/bookingLifecycle.ts:125-128` (`recomputeReliability` merge-writes only `reliability` + `updatedAt`, its own comment says it creates a summary-only doc when no booking info was ever saved); approval gate at `functions/src/profiles.ts:176-187` requires a bio and one track, never booking info.

Defect: the projection can legitimately exist with no `rates`/`preferences`, and both browse grids dereference those fields unguarded inside render.

Scenario: a musician is approved without opening the booking-info editor. A curator sends an offer (offerGig needs nothing from the musician side), the booking completes, sweep step 7 (`scheduled.ts:854`) calls `recomputeReliability`, which creates `{reliability, updatedAt}`. From then on every curator who opens Find musicians (web page or mobile tab) hits a TypeError on that card: the web route falls to the Next error boundary, the mobile tab red-boxes. Same trigger from any late-cancel mark.

Action: guard the reads (`booking.preferences?.availabilityPattern`, `booking.rates ?? {perHour:null,...}`) on both platforms, and make `recomputeReliability` seed `rates`/`preferences` when the doc does not exist (or call `rebuildBookingProjections`, which reads the source and tolerates a missing one). Add a functions test asserting the projection shape after a completion for a profile with no `private/booking` doc.

Owner: fix-now.

### 2. High | spec-drift / ux | A musician never learns their application is a whole-run commitment

Evidence: `functions/src/bookings.ts:129-138` (seriesId is set automatically for any occurrence of an active whole_run series); `apps/web/app/gigs/[gigId]/page.tsx:34-46` (`useSeriesFillMode` needs a member-only gigSeries read, non-members get "Part of a recurring series"); `apps/mobile/src/bookings/GigBrowse.tsx:31-34` (always the soft copy, no fetch); `apps/web/src/bookings/BookingThread.tsx:616-631` and `apps/mobile/src/bookings/BookingThread.tsx:441-448` (the only run-aware copy is inside the curator-side accept preview); `DEPOSIT_HONESTY_LINE` (`BookingForms.tsx:40-41`) says nothing about per-date charges.

Defect: whole-run is inferred server-side from data the applicant cannot read, and no musician-facing surface (browse, detail, thread, accept preview) says the booking covers every date of the run.

Scenario: a musician applies to one Friday occurrence at one night's fee, the curator accepts, and the act is now confirmed for every open occurrence plus every future materialized one (`scheduled.ts:401-409`), with per-date deposits, per-date settlement, and per-date cancellation windows and marks. The first hint is the "Dates" list after confirmation.

Action: stamp `fillMode` (or `wholeRun: boolean`) onto occurrence docs in the materializer (`scheduled.ts:455-463`) and `createGig` (null), so browse/detail can render "Books as a run" for everyone; in both threads, when `booking.seriesId != null`, show a run notice above the Respond block for BOTH sides with the count of currently-open occurrences (`gigs where seriesId == X and status == open` is public-provable and indexed). Extend `DEPOSIT_HONESTY_LINE` with a run variant.

Owner: fix-now (pre-launch consent issue); SP8 carries the badge into search.

### 3. High | ux | Inbox rows and the thread never identify the other party

Evidence: `apps/web/src/bookings/BookingInbox.tsx:146-164` (OpenThreadRow renders gig title, "your turn", offer count), `BookingThread.tsx:537-541` (header is gig title + structure + status); `apps/mobile/src/bookings/BookingInbox.tsx:109-125`, `BookingThread.tsx:366-370`. No component in either `src/bookings` reads the counterparty's profile name, handle, or reliability (grep for a counterparty name returns only OfferComposer's `musicianName` prop).

Defect: a curator deciding on an application sees no name, no portfolio link, no reliability summary; a musician sees no venue name.

Scenario: three acts apply to "Friday Jazz". The curator's inbox shows three identical rows; each thread shows "Musician offered $300 per set". The only place the name ever appeared was the notification body.

Action: in the thread and each inbox row, `getDoc(profiles/{otherSideId})` (public once approved, member-readable otherwise) and render name + link (`/@handle` on web, `artist/[handle]` on mobile); on the curator side also render the `curatorBooking` reliability line the browse grid already knows how to build.

Owner: fix-now.

### 4. Medium | bug | A date reopened by `cancelOccurrence` on a booked run is publicly open but can never be booked

Evidence: `functions/src/bookingLifecycle.ts:610` (reopens the occurrence to `open`); `bookings.ts:134-138` (any application on an active whole_run series becomes a whole-run booking); `bookings.ts:614-616` (accept refuses whenever `series.activeBookingId` names another booking, the "rebooking door" guard); `runAcceptPostCommit` supersedes rivals by `seriesId` too (:1109-1111).

Defect: the guard closed the rebooking door without closing the application door.

Scenario: curator pulls one date off a run. That date lists in Find gigs as open, musicians apply, the curator negotiates, and every accept fails with "This series is already booked." The date stays dead until the run ends.

Action: in `finalizeBookingRequest`, read `series.activeBookingId`; when it is non-null (and the series is still active), create a single-occurrence booking (`seriesId: null`) so the reopened date can be filled date-by-date (all run-scoped unwinds already filter `bookingId ==`, so a single booking on that date is safe). Add a test: cancelOccurrence, apply, accept, gig filled by the second booking, run untouched.

Owner: fix-now.

### 5. Medium | missing-feature | Push notifications cannot deep-link (no payload, no tap handler)

Evidence: `functions/src/notifications.ts:13` (Expo message is `{to, title, body}`, no `data`); `apps/mobile/src/notifications/push.ts` registers a token only; no `addNotificationResponseReceivedListener` or `getLastNotificationResponseAsync` anywhere under apps/mobile. In-app rows do deep-link (`src/shell/NotificationsList.tsx:35-40`, web `app/dashboard/page.tsx` NotificationsList), and legacy rows without `refId` correctly render unlinked.

Scenario: a curator taps "Countered offer for Friday Jazz" on the lock screen; the app opens wherever it was, not on the thread.

Action: add `data: { kind, refId }` to the Expo push body; add a response listener in `app/_layout.tsx` that routes `booking` to `/booking/[refId]` and `ticket` to `/event/[refId]`, plus the cold-start read. SP7's fan notifications will need the same plumbing, so land it once.

Owner: SP7 (or fix-now; it is small).

### 6. Medium | ux | Mobile grace-period warnings are missing in TWO places, only one is recorded

Evidence: web accept flash `apps/web/src/bookings/BookingThread.tsx:403-405, 633-640`; mobile accept block `apps/mobile/src/bookings/BookingThread.tsx:415-471` has no equivalent (recorded in sp5b-rulings "Deferred"). Second, unrecorded half: web `CancelDialog.tsx:63-73` shows the in-grace penalty-free notice from `confirmedAt`; mobile `CancelDialog.tsx:29-54` has no `confirmedAt` prop or grace branch and `BookingThread.tsx:517-519` never passes it.

Scenario: a mobile curator cancels 20 minutes after accepting a gig 10 hours out. The dialog warns "Cancelling now forfeits your deposit" while the server (`bookingLifecycle.ts:370-384`) refunds under grace. The reverse case (accepting inside the window with no warning) is the recorded half.

Action: port both; amend the sp5b deferred note so the CancelDialog half is tracked.

Owner: fix-now on the next mobile booking touch.

### 7. Medium | ux | The curator's own gig page shows "filled" but not who, and no link to the booking

Evidence: `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx` (only the status badge map at :33 references `filled`; `bookingId`/`bookedMusicianProfileId` are never read); `apps/mobile/app/(curator)/events/[gigId].tsx` (no `bookingId` use).

Scenario: a curator opens a filled gig to cancel it, gets "This gig is filled, cancel the booking instead" from cancelGig, and has no path from the gig to the booking.

Action: when `gig.bookingId` is set, render the booked act (profile get) and a link to `/dashboard/bookings/{bookingId}` (web) / `/booking/[bookingId]` (mobile).

Owner: fix-now.

### 8. Medium | ux | Whole-run accept confirms a charge of unknown total

Evidence: `apps/web/src/bookings/BookingThread.tsx:607-623`, `apps/mobile/src/bookings/BookingThread.tsx:433-448`: the count branch depends on `occurrences[]`, which is empty pre-accept (the inline comment admits the branch is unreachable), so the curator sees one date's "Due now" plus "x each of the run's upcoming dates".

Scenario: 8 open dates at $70 due-now each; the preview reads "$70"; the card is charged $560 (`bookings.ts:1273-1290` sums every staged occurrence).

Action: pre-accept, query `gigs where seriesId == booking.seriesId and status == open` (public-provable, index `(seriesId,status)` exists) and render "8 dates, $560 due now".

Owner: fix-now.

### 9. Medium | ux | Booking inbox has no loading state and swallows errors (both platforms)

Evidence: `apps/web/src/bookings/BookingInbox.tsx:248-278` (three lists start `[]`, the onSnapshot error callbacks set `[]`), `apps/mobile/src/bookings/BookingInbox.tsx:165-195` (same). Browse and thread do have skeleton/error states.

Scenario: first paint shows "No open threads yet" then rows pop in; in production a missing composite index (README warns the 9 `bookings` composites must be confirmed after deploy) renders as a permanently empty inbox with nothing in the UI or console.

Action: track `loaded`/`error` per list, render the branded skeleton and ErrorBanner/alert, `console.error` the failure.

Owner: fix-now.

### 10. Medium | docs / copy rule | Em dashes in user-visible strings the clients render verbatim

Evidence (all reach users through `e.message` or notification bodies): `functions/src/bookings.ts:587, 640`; `functions/src/bookingLifecycle.ts:34, 44, 80, 210, 211, 222, 510, 564, 1109, 1365`; `functions/src/gigs.ts:21, 258, 385`; `packages/shared/src/messages.ts:33, 41, 47, 51, 56, 62, 74, 79, 86, 88, 90, 92, 94, 96, 108, 117, 121`. Ledger detail `bookings.ts:1065` (admin-visible). Docs: `sp4-rulings.md` (31), the SP4 spec (23), `README.md` (137). The client booking files under apps/web and apps/mobile are clean.

Action: replace with a period, colon or comma; add a shared test that scans exported `*_MESSAGE` constants and HttpsError literals for U+2014.

Owner: fix-now (server + shared), docs batch later.

### 11. Medium | missing-feature, unowned | Messaging

Evidence: `apps/mobile/app/(musician)/messages.tsx` and `(curator)/messages.tsx` are "Direct messages, coming soon" placeholders mounted as primary tabs (`_layout.tsx:23`, `:28`); `apps/web/src/shell/AppShell.tsx:88-89` states there is no web surface; spec section 1 lists "general messaging/chat (unscheduled)"; HANDOFF names 7 Fan discovery then 8 Search, deferred 5c. No spec assigns messaging to any sub-project. The thread is terms-only by design (280-char note per offer, `validation.ts:395`).

What a real feature needs, so the brainstorm can size it:
- Data model: `threads/{id}` (participants as profile ids, both sides' member uids denormalized for rules, `lastMessageAt`, per-side unread counts, optional `bookingId` link) plus `threads/{id}/messages/{id}` (senderProfileId, text <= ~2000 chars, createdAt, `deletedByAdmin`). A booking-scoped v1 (`bookings/{id}/messages`) reuses the existing read rule and needs no new access model.
- Rules: read by members of either participant profile (the bookings rule shape); writes via callable only (rate limit, length cap, link/phone scrubbing policy, blocked-pair check), or direct client create with strict field validation if latency matters.
- Notifications: new `kind: "message"` with `refId` = threadId, push with `data` (finding 5), digest/coalescing to avoid one push per line.
- Moderation: report thread, admin read of any thread, block list (`profiles/{id}/private/blocked`), per-profile daily send cap (the `geocodeBudgets` idiom), audit rows on admin actions, retention/export for account deletion (deleteProfile cascade already touches bookings; it would need threads too).
- Client: thread list, composer, unread badge on the tab, keyboard handling on mobile, 360px on web.
- Indexes: `threads (participantProfileIds array-contains, lastMessageAt desc)`, `messages (createdAt)`.

Action: decide the owner (a booking-scoped v1 is the cheapest useful shape and fits alongside SP8 polish; a general DM product is its own sub-project). Until then hide the two mobile tabs (a dead primary-nav tab violates the "no dead control" rule the codebase cites as R-26).

Owner: launch-checklist (decision), then whichever sub-project is assigned.

### 12. Medium | test-gap | Rules tests cover `bookings` get() only, no list-provability matrix

Evidence: `tests-rules/rules.test.ts:460-476` (single get matrix); gigs list tests exist at :530-590 but nothing exercises the shipped `bookings` shapes (`(musicianProfileId|curatorProfileId, status, updatedAt)`, the `status in [...]` history query, the `(musicianProfileId, updatedAt)` PastShowsList query), the gigs `(bookingId, status == filled)` occurrence query, or the bare `where(bookingId==X)` denial that ruling 17 relies on. sp4-rulings ruling 17 says the matrix lives "in the audit record", not in a test.

Action: add one `describe("bookings list provability")` with succeed/fail pairs for each shipped query.

Owner: fix-now.

### 13. Medium | test-gap | No concurrent double-accept coverage through the SP5 saga

Evidence: `functions/test/bookings.test.ts:611` flips the gig closed via the admin SDK; no test runs two `acceptBooking` calls on rival bookings of one gig, nor supersede-of-a-rival-with-`depositChargePending`. The code paths look right (`bookings.ts:735-747` pre-check returns null, `:1368-1393` refunds), but they are money paths with zero direct coverage.

Action: FakeStripe test: stage two accepts, resolve both, assert one confirmed, one refunded with ACCEPT_ABORTED_REFUNDED_MESSAGE, ledger rows consistent.

Owner: next functions touch.

### 14. Low | bug | Step 6 expires an open booking whose accept saga is in flight

Evidence: `functions/src/scheduled.ts:696-697` checks gig state only; `depositChargePending` is never consulted. The payments sweep then raises `expired_booking_saga_marker` (`paymentsSweep.ts:1090-1108`) and a human resolves what the webhook could have finished.

Scenario: an accept charge sits `processing` across the 09:00 UTC sweep on a gig that started overnight.

Action: `if (booking.depositChargePending === true) continue;` with a test.

Owner: fix-now.

### 15. Low | spec-drift | A reported no-show date stays on the musician's public Shows list

Evidence: `bookingLifecycle.ts:776-807` leaves the reported gig `filled` + linked (deliberately, `:840-843`, so settlement waive/clawback can find it); Shows loaders query `bookedMusicianProfileId == X and status in [filled, closed]` (`apps/web/app/u/[handle]/page.tsx:146-148`, `apps/mobile/app/artist/[handle].tsx:47`).

Scenario: a musician who no-showed lists that night as a past show on their public page.

Action: product call; cheapest is a `noShow: true` stamp on the gig (public doc, no terms leaked) that Shows loaders and SP7 discovery filter on.

Owner: SP7 (public surfaces) with a launch-checklist decision.

### 16. Low | ux | Counter stays enabled at the 50-entry cap

Evidence: `bookings.ts:302-305` refuses with resource-exhausted; web `BookingThread.tsx:577` and mobile `:405-406` keep "Counter" enabled and show the raw server error after the round trip. Accept, decline and withdraw still work at the cap, which is correct.

Action: disable Counter when `thread.length >= MAX_BOOKING_THREAD_ENTRIES` with "Thread is full: accept, decline or withdraw."

Owner: fix-now.

### 17. Low | ux / product | No-show reporting is coarse on runs

Evidence: `bookingLifecycle.ts:704-706` (one report per booking), `:727-735` (always the most recent past linked occurrence), `:805-807` (ends the run).

Scenario: on an 8-week run the act missed week 3 and played week 4; the curator can only report week 4, and doing so cancels the remaining run.

Action: accept an optional `gigId` (must be a past occurrence linked to this booking), key the once-per invariant on `(bookingId, gigId)`, and make "also end the run" an explicit choice.

Owner: launch-checklist (product decision) then SP8 or a booking polish pass.

### 18. Low | docs | Stale README and rulings text

Evidence: `README.md:19` ("no money moves yet"); the SP4 "Scale/hardening follow-ups" bullet still lists the `inviteMember`/`respondToInvite` guard gaps as open although sp4-rulings.md:154-161 records them resolved in SP5; the README sub-5 handoff paragraph (":199" onward) is written in the future tense. `bookings.ts:263-267` and `:557-559` say "nothing deletes gigs" while `scheduled.ts:674-687` documents that deleteProfile does; counterBooking on such a booking returns `internal` rather than a clean failed-precondition.

Action: README/comment sweep; change the missing-gig branch to failed-precondition "This gig no longer exists."

Owner: fix-now (docs).

### 19. Low | bug (narrow race) | Backfill marker can overwrite a concurrent visibility save

Evidence: `bookingVisibility.ts:147-150`: rebuild, then `set({visibility: DEFAULT}, {merge:true})` with no precondition. A musician saving `perHour: "private"` between the two writes has it reset to `curators`, and the projection built moments earlier does not reflect either.

Action: write the marker only if `visibility` is still absent (transaction on the source doc, or `lastUpdateTime` from the pre-rebuild read).

Owner: fix-now (trivial) and note in the launch checklist that the backfill should run in a quiet window.

### 20. Low | bug | Missing-source rebuild deletes a reliability summary

Evidence: `bookingVisibility.ts:59-66` deletes `curatorBooking` outright when `private/booking` is absent, discarding the `reliability` field `recomputeReliability` may have written for a musician who never saved booking info; the next mark or completion recreates it, so it is self-healing but lossy in between.

Action: merge-set `{rates: nulls, preferences: null, ...}` preserving `reliability`, or leave the doc when it carries a reliability field.

Owner: fix-now, together with finding 1.

### 21. Low | ux / a11y | Small thread and inbox polish

- Mobile `OfferFields` inputs have no `accessibilityLabel` (label is a sibling Text): `apps/mobile/src/bookings/BookingForms.tsx:75-88`. Report and cancel textareas are labelled.
- Mobile thread loading is a bare "Loading..." (`BookingThread.tsx:196`), against 9B's branded skeleton rule; the route wrapper has a skeleton but only for auth loading.
- Web `CancelDialog` is inline (no modal, so no focus trap is required) but focus does not move to the reason field when it opens: add `autoFocus` (`CancelDialog.tsx:117`).
- Web `ConfirmedRow` deposit detail is capped at `max-w-28` (`BookingInbox.tsx:195`): the sentence wraps to five lines at 360px. Truncate to "35% deposit ($X)" in the row and keep the long form in the thread.
- Money copy parity is intact ("Total:", "Due now:", "Terms: ..., total", depositLine identical on both platforms).

Owner: fix-now (mobile polish batch).

### 22. Low | ux | Browse-card parity drift

Evidence: mobile `MusicianBrowse.tsx:34-40` renders curator-tier rates under the label "No public rates." (they are curator-tier, not public) and `:187-189` says "n no-shows / m bookings"; web's locked MusicianCard never shows a price and says "m shows played · n no-shows" (`MusicianBrowse.tsx:76-82`).

Action: align copy; decide whether the mobile card shows rates at all (web's card spec says never).

Owner: fix-now (copy).

### 23. Low | ux | Curators are not told when their own offer expires

Evidence: `scheduled.ts:702-704` notifies the musician side only; every other resolution notifies both.

Owner: fix-now.

### 24. Low | bug | Past-dated open gigs are applicable and browsable for up to 24h

Evidence: `GigBrowse` (web `:70-81`, mobile `:213-216`) queries `status == open` with no `startsAt >= now`; `applyToGig`/`offerGig` (`bookings.ts:184-190, 224-229`) check status only; the accept path deliberately tolerates started dates (`bookings.ts:1265-1271`, meant for already-booked run occurrences). Sweep step 2 closes them once a day.

Scenario: a gig at 20:00 is still listed and applicable at 23:00; an accept charges a deposit for a show that is over.

Action: `startsAt > now` guard in both creation callables (mirrors publishGig's own P1 guard at `gigs.ts:203-205`) and a `startsAt >= now` filter in browse (the `(status,startsAt)` index already serves it).

Owner: fix-now; SP8 must keep the filter.

### 25. Low | test-gap | Smaller coverage holes

- `reportNoShow` from `confirmed` (only `completed` and whole-run are tested; `bookingLifecycle.test.ts:651-775`).
- Step 6 skip for a pending saga (finding 14).
- `functions/test/helpers.ts` exports none of `makeApprovedCuratorProfile`/`createOpenGig`/`seedSeries`; 15 test files carry local copies (README follow-up not done, and the list grew from 3 to 15 files).

Owner: next functions touch.

### 26. Low | ux / perf | PastShowsList runs a member-only query for every viewer

Evidence: `apps/web/app/u/[handle]/shows/PastShowsList.tsx:59-95` issues `bookings where musicianProfileId == X` for fans and anonymous visitors too; it is caught, but it is a guaranteed permission-denied round trip (plus a `curatorBooking` read) per page view.

Action: gate on `useMyProfiles` membership before querying.

Owner: SP7 (public-surface performance).

### Checks that passed (no finding)

- Turn enforcement, status checks, thread cap and the deposit-pending lock are all transactional (`bookings.ts:284-319, 351-369, 404-423, 1224-1237`).
- Concurrent accepts on one gig resolve correctly: the second B sees `filled` (HttpsError) or `superseded` (null) and refunds (`bookings.ts:1368-1393`).
- F2 stale-gig guard compares the last entry (`:584-588`); `updateSeries` propagation skips filled/closed (`gigSeries.ts:263-264`); `updateGig` refuses filled/closed (`gigs.ts:256-259`).
- Both-sides member: negotiation permitted musician-first, cancel/report refused server-side, disabled (not hidden) in both UIs.
- Money parity: server, web and mobile all call `computeExpectedTotalCents`/`computeDepositCents`/`depositChargePreviewCents` with the live gig duration and the last entry's quantity.
- Windows strict `<` from the policy snapshot, 1h grace both sides, `now` captured once, marks appended in-transaction, `occurrenceCancellations` reject-when-full: all as ruled and tested.
- Deposit intents: `executeCancellation` (forfeit only `nextGigId`, refund the rest), `cancelOccurrence`, `reportNoShow` (refund + waive + clawback) write `*_pending` in-transaction; `unwindBookingsForModeration` writes none by design and the hourly payments sweep step 7 refunds future-dated docs of `expired` bookings within a 14-day lookback (`paymentsSweep.ts:140, 1085-1181`); `pauseSeries`/`endSeries` route through `executeCancellation`. `removeReliabilityMark` needs no Stripe secret (`reopenSettlementForRestore` is Firestore-only).
- Projections: source + both projections in one batch when the source is passed; legacy docs default to all-curators; backfill rebuilds before marking.
- Rules: bookings readable only by either side or admin; `private/location` opens to the booked act only while `bookedMusicianProfileId` names them; `private/booking` and `private/reliability` are member/admin only; `curatorBooking` is curatorAccess-gated. Every shipped client query pins the field the rule needs (inbox, thread occurrences, Shows on both platforms, browse, offer composer, apply panel, PastShowsList). No production query would be rules-denied.
- `refId` is set on every booking-kind notification (apply/offer, counter, decline, withdraw, supersede, accept both sides, cancel both sides, cancelOccurrence, reportNoShow, mark removed, restore both sides, unwind both sides, takedown run musician, sweep expiry and completion); legacy rows render unlinked on both clients.
- No em dashes in any client booking file (web or mobile).

## B. Status of the recorded scale follow-ups (check 4)

| Item (README "Scale/hardening follow-ups") | Status in code | Evidence |
|---|---|---|
| Materializer birth-decision race | Open, accepted at v1 | `scheduled.ts:387-420` reads the booking, `:546-549` commits per series with no `lastUpdateTime` precondition; the `:512-525` comment covers only the self-heal clobber, not a cancel landing mid-step. No reconciling sweep step exists. |
| Step 6 `db.getAll` batching | Open | `scheduled.ts:692-695` still one `get()` per open booking. |
| functions/test helper dedup | Open, and grew | `helpers.ts` exports none of the three helpers; 15 test files now define local copies (was 3 at SP4 merge). |
| Step 7 crash posture | Accepted, implemented as ruled | `scheduled.ts:823` direct status write before the counter bump. |
| BookingInbox pagination past 50 | Open | web `BookingInbox.tsx:255-256, 265`, mobile `:172-183`: `limit(50)` open/confirmed, `limit(20)` history, no cursor UI on either platform. |
| `inviteMember`/`respondToInvite` guard gaps (still listed in README) | Resolved in SP5 (`members.ts`), README bullet stale | `sp4-rulings.md:154-161`. |
| Sub-8 note: unused `gigs (bookedMusicianProfileId, startsAt)` index | Still present, still unused by any shipped query | `firestore.indexes.json`; every Shows query uses the 3-field `(bookedMusicianProfileId, status, startsAt)` index. |

## C. What SP7 (fan discovery) and SP8 (search) must know from this area

Data that is public, and data that never is:
- Public gig docs: `status in {open, filled}` and `closed` only when `bookedMusicianProfileId != null`. Draft, cancelled, taken_down and unbooked-closed gigs are not readable, and a list query must pin `status` (or `curatorProfileId` for a member) or it is denied at the query level. Ruling 16 means performed gigs stay `filled` forever; the `closed && booked` disjunct is effectively unreachable today (nothing produces that shape: reviewProfile clears the linkage when it closes a filled gig, the sweep closes only open gigs). Treat `filled` as "booked", keep the disjunct.
- `bookings` are never fan-readable and never searchable. Discovery must work from gig docs (`bookingId`, `bookedMusicianProfileId` are the only booking facts on a public doc) and from events.
- Rates are never public. `ProfileDoc.publicBooking` (preferences only, when the musician opted in) is the only booking fact on a public profile. Reliability counts live in `private/curatorBooking`, readable by curatorAccess holders only; a fan surface must not attempt that read (finding 26 shows the cost of trying).
- Reliability counts are booking-scoped: an 8-date completed run is +1, not +8.

Shapes and gaps discovery will inherit:
- Whole-run: `gig.seriesId` is public, `fillMode` is not (gigSeries is member-only). Until finding 2 lands, discovery cannot say "books as a run"; ask for `fillMode`/`wholeRun` to be stamped on occurrence docs and index it if it becomes a facet.
- Reopened dates on a booked run are dead until finding 4 is fixed; do not promote them.
- Open gigs whose start has passed linger up to 24h (finding 24): filter `startsAt >= now` in every fan query.
- A reported no-show date stays on the musician's Shows list (finding 15); decide before building "recent shows" or reputation surfaces.
- Notifications: `NotificationDoc.kind` is `booking | ticket | ...` with optional `refId`; push carries no payload and the app has no tap handler (finding 5). Fan alerts (new show near you, saved search hits) need a new kind plus that plumbing.
- Messaging does not exist and has no owner (finding 11). "Contact the act" or "ask the venue" features cannot assume a thread.

Indexes and helpers already there:
- gigs: `(status, startsAt)`, `(bookedMusicianProfileId, status, startsAt)`, `(curatorProfileId, status, startsAt)`, `(seriesId, status, startsAt)`, `(bookingId, status, startsAt)`; events: `(status, startsAt)`, `(curatorProfileId, status, startsAt)`, `(lineupMusicianProfileIds contains, status, startsAt)`. No geo index; `location.geo` is coarsened when `addressVisibility == "neighborhood"` and the exact point lives in `gigs/{id}/private/location` (curator side plus the booked act only). Maps must render the public geo as an area, not a pin.
- Day boundaries: `LAUNCH_TIMEZONE` plus `launchTzDayStartMs`/`launchTzNextDayStartMs` (web `BookingForms.tsx:173-206`, mobile with try/catch degrade). Reuse rather than re-derive.
- The two directories ("Find gigs", "Find musicians") are placeholder-grade by ruling; SP8 replaces their internals wholesale. Their per-card `curatorBooking` n+1 and client-side filters are not a pattern to extend. The musicians-page membership gate (any approved curator member can load a foreign URL) is a recorded SP8 item.
- Provability discipline for any new client query: pin `status` on gigs/events, pin a profile id on bookings, and add a rules list test (finding 12) with the query.

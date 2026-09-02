# Audit: Sub-project 1 (Foundation) as it stands after the SP6 merge

Date: 2026-09-01. Read-only audit of functions/src (profiles, review, members, account, notifications, authTriggers, guards, adminTools, index), the SP1 tests, packages/shared (validation + user/profile/invite/notification types), the web shell/auth/join/sign-in/admin/dashboard surfaces, the mobile shell/auth/join/tab layouts/account/notifications, and both seed scripts. Every claim below was checked against code, not docs. Path:line references are to the working tree at commit 4dab485.

Severity scale: Critical = money loss or abuse path with no operator remedy in product; High = blocks a launch requirement or leaks data; Medium = real defect or missing product capability; Low = hygiene.

Owner vocabulary: fix-now (small, direct-to-main), SP7, SP8, 5c, launch-checklist.

---

## A. Findings

### 1. Unpublishing a curator leaves its published events live, on sale, and impossible to cancel or refund
- Severity: Critical. Category: bug / security (money).
- Evidence: functions/src/review.ts:100-172 (reject-from-approved cascade closes gigs, pauses series, unwinds bookings; never touches `events`). firestore.rules:258-259 (events readable by `status == 'published'` alone, no curator-approval check). functions/src/ticketing.ts:82-84 (createTicketOrder gates only on `event.status` and `startsAt`, not on the curator profile). functions/src/events.ts:507-508 and ticketing.ts:693-694 (cancelEvent and refundTicket both require `requireApprovedCuratorProfile`). functions/src/index.ts:29-32 (no admin-side event callable exists). functions/src/paymentsSweep.ts:1430-1466 (T+1 settlement transfers face value to whatever `accountId` the curator doc holds).
- Defect: the retroactive-unpublish path has no event branch, and the only two callables that can refund buyers are gated on the very approval the admin just revoked.
- Failure scenario: an admin unpublishes a fraudulent venue at 10:00. Its "published" event keeps selling tickets all day (public page still renders, createTicketOrder still succeeds). The curator cannot cancel (failed-precondition "not approved"), the admin has no cancel path, and at T+1 the sweep pays the banned curator the face value. Buyers who complain have no refund route except a manual Stripe refund that leaves every ticket doc "valid".
- Recommended action: in reviewProfile's reject-from-approved branch, run `cancelEventCore` + `refundOrdersForCancelledEvent` for every future `published` event of the profile (and mark drafts cancelled), batched with the gig/series cascade and audited. Independently, make createTicketOrder and settleTicketRevenue refuse when the curator profile is not approved, and add an admin-callable event cancel (requireAdmin OR approved member).
- Owner: fix-now (before SP7 exposes events to fan discovery).

### 2. deleteProfile has no events/orders/tickets cascade; a rejected curator can delete out from under sold tickets
- Severity: Critical. Category: bug (money hazard, orphans).
- Evidence: functions/src/profiles.ts:286-298 (cascade covers gigs, series, bookings only), profiles.ts:327 (`recursiveDelete` wipes `profiles/{id}/private/stripe`, the only record of the connected account), functions/src/paymentsSweep.ts:1430-1433 (settlement reads that doc; missing account raises `ticket_settlement_blocked` every hour, forever), ticketing.ts:987-988 (checkInTicket also requires an approved curator member).
- Defect: deleteProfile is allowed on any `rejected` profile, including one rejected from approved that owns published events with paid orders, and it does nothing about them.
- Failure scenario: venue is unpublished (finding 1), owner immediately calls deleteProfile (allowed). Event stays "published" and on sale with a dead `curatorProfileId`; 80 fans hold "valid" tickets; no one can scan them at the door; the hourly sweep files a blocked-settlement alert until the heat death of the project; buyer money sits on the platform balance with no refund path. The musician-side twin: a rejected musician deletes and the Express account id is gone from Firestore while any pending `transfer` state or balance remains in Stripe with no way to request a payout.
- Recommended action: deleteProfile must refuse (failed-precondition) while the profile owns any non-cancelled event with a paid or pending order, any `held`/`*_pending` deposit, or a Stripe account with a non-zero balance; alternatively cascade-cancel with full refunds. Preserve the Stripe ids in an audit doc before the recursiveDelete so an operator can still act in Stripe.
- Owner: fix-now.

### 3. A sole admin of an approved profile cannot delete their account in-product
- Severity: High. Category: missing-feature / spec-drift (App Store 5.1.1 in-app deletion).
- Evidence: functions/src/account.ts:18-33 (refuses while sole admin anywhere), functions/src/profiles.ts:248-251 (deleteProfile refuses approved and pending_review), functions/src/members.ts:218-235 (transferAdmin exists) but no client calls it: grep of apps/web and apps/mobile for `transferAdmin`, `inviteMember`, `respondToInvite`, `removeMember`, `revokeInvite` returns only functions/ and a comment in apps/web/app/admin/page.tsx:75-76.
- Defect: the spec (section 4) says "the flow enforces this", but the two escape hatches the error message names (transfer admin, delete the profile) have no UI and one is forbidden by status.
- Failure scenario: a solo musician with an approved profile taps Delete account on either client and gets "You are the only admin of: X. Transfer admin or delete those profiles first." There is nothing they can tap next. Only a support ticket (admin unpublish, then user deletes profile, then account) resolves it.
- Recommended action: allow a sole admin to self-unpublish-and-delete an approved profile (reuse reviewProfile's reject cascade plus deleteProfile's cascade, gated by finding 2's money checks), or ship the members panel (finding 4) so admin transfer is possible. Add a test that walks the whole path from approved profile to deleted account.
- Owner: fix-now (launch requirement).

### 4. Invite lifecycle is server-complete and client-absent; invites never notify the invitee
- Severity: High. Category: missing-feature.
- Evidence: functions/src/members.ts:11-62 (inviteMember writes the invite doc and returns; zero `notifyUser` calls in the file), firestore.rules:347-352 (invites readable by invitee, but no client queries the collection), apps/mobile and apps/web have no invite, roster, revoke, remove, or transfer UI (same grep as finding 3).
- Defect: bands and curator organisations are single-person in practice; the `band` subtype, member `label`, and the whole invites collection are unreachable from any screen.
- Failure scenario: a four-piece band signs up; only the drummer can ever edit the portfolio, see bookings, or get notified. Door staff at a venue cannot be given scanner access without sharing the owner's login. 5c (band payout splits) has no membership data to split against.
- Recommended action: members panel on the profile editor (both clients): roster, invite by email (with label/role), pending list with revoke and expiry copy ("expires in N days", 14-day rule from members.ts:67), remove member, transfer admin; an invites inbox for the invitee (accept/decline with expiry copy); `notifyUser(invited.uid, { kind: "system" ... })` on invite, plus a new `kind: "invite"` with `refId: inviteId` if a deep link is wanted.
- Owner: 5c prerequisite, or SP7 if 5c stays deferred.

### 5. No verification-email resend, no unverified banner, and a stale token after verifying
- Severity: High. Category: ux (conversion at the one revenue moment).
- Evidence: apps/web/app/sign-in/SignInForm.tsx:82-88 (sends once, then `router.push(redirectTo)` regardless), apps/mobile/app/(auth)/sign-up.tsx:17-19 (sends once, alert). No `emailVerified`, `reload()`, `getIdToken(true)` or `sendEmailVerification` outside sign-up anywhere in apps/ (grep). functions/src/ticketing.ts:61 (createTicketOrder requires verified email), guards.ts:13-17.
- Defect: every sensitive callable requires `email_verified`, but the clients neither tell the user they are unverified nor let them resend, and the ID token's claim only refreshes on the hourly rotation.
- Failure scenario: fan signs up from an event page (`next=/e/...`), verification mail lands in spam, Buy fails with "Please verify your email address first." with no resend control. They find the mail, click it, retry: same error for up to 60 minutes because the cached token still says unverified. Web has no push and no email, so nothing nudges them.
- Recommended action: shared "Verify your email" banner (both clients) with Resend (rate-limited client-side) and "I've verified" that calls `user.reload()` then `getIdToken(true)`; on any `failed-precondition` whose message mentions verification, force-refresh the token and retry once.
- Owner: fix-now.

### 6. Push tokens are never removed on sign-out; notifications leak across accounts on a shared device
- Severity: High. Category: security (privacy).
- Evidence: apps/mobile/src/notifications/push.ts:16 (token doc keyed by the Expo token under the signed-in uid), apps/mobile/src/auth/AuthProvider.tsx:15 and apps/web/src/auth/AuthProvider.tsx:16 (`signOutUser` only calls `signOut`), functions/src/notifications.ts:11-21 (fans out to every token doc under the uid).
- Defect: the Expo push token identifies the device install, not the person; both accounts end up holding the same token.
- Failure scenario: user A signs out on a phone, user B signs in; A's future "Deposit charged", "Booking confirmed", "You've been offered a ticket" pushes arrive on B's lock screen.
- Recommended action: delete `users/{uid}/pushTokens/{token}` before `signOut` (mobile), and have notifyUser prune tokens that Expo reports as `DeviceNotRegistered` (fetch receipts or inspect the immediate ticket response). Also order the `.limit(20)` query by createdAt desc so the newest device is never the one dropped (notifications.ts:11).
- Owner: fix-now.

### 7. Reject, delete, recreate: bypasses the 24h resubmit cooldown and the resubmit counter, and re-takes the freed handle
- Severity: Medium. Category: security (abuse).
- Evidence: functions/src/profiles.ts:147-149 (cooldown reads `lastRejectedAt` on the profile doc), profiles.ts:248 (rejected profiles are deletable), profiles.ts:310-325 (handle freed on delete), profiles.ts:97-127 (new draft has no rejection history).
- Defect: the anti-spam state lives on the doc the user is allowed to destroy.
- Failure scenario: impersonator rejected at 10:00, deletes, recreates the same handle at 10:01 with a fresh doc, resubmits immediately; the admin queue shows no "resubmitted" badge and the reviewer has no memory of the prior reject.
- Recommended action: stamp the cooldown on the acting uid (users/{uid}.lastProfileRejectedAt, server-only) and check it in submitProfileForReview; or write a `handles/{handle}` tombstone that only the previous owner can reclaim for 24h and that carries the reject history forward. Add a test.
- Owner: fix-now (small), or SP8 (search makes squatting visible).

### 8. Notification kinds: all six render, but deep links exist only for `booking`; push taps and foreground pushes do nothing
- Severity: Medium. Category: ux / missing-feature.
- Evidence: packages/shared/src/types.ts:90 (kinds: profile_review, track_review, system, gig_moderation, booking, ticket). Writers: review.ts:239 (profile_review, no refId), tracks.ts:237 and 341 (track_review, no refId), gigs.ts:520 (gig_moderation, no refId), ticketing.ts:283/495/505/761/927/1133/1246/1255 plus scheduled.ts:931 and paymentsSweep.ts:1447 (ticket, `refId = eventId`), bookings/bookingLifecycle/scheduled (booking, refId = bookingId). Readers: apps/web/app/dashboard/page.tsx:194 and apps/mobile/src/shell/NotificationsList.tsx:37-39 (only `booking` gets an href). functions/src/notifications.ts:13 (push carries title/body only, no `data`). No `setNotificationHandler`, `setNotificationChannelAsync`, or `addNotificationResponseReceivedListener` anywhere in apps/mobile (grep).
- Defect: the ten `ticket` write sites already carry an eventId that neither client uses; review-kind notifications carry nothing to link to; the push payload has no routing data.
- Failure scenario: fan gets the "Event tomorrow" push, taps it, lands on the Discover placeholder with no way to the event. On iOS with the app in the foreground the push is not displayed at all (expo-notifications needs a handler). A musician whose track was rejected must find the Account tab, scroll, and then navigate to Portfolio by hand.
- Recommended action: a shared `notificationHref(kind, refId)` in packages/shared consumed by both clients (ticket to /e/[id] and /event/[id], booking as today, profile_review and track_review to the editor via a new `refId: profileId` written by review.ts/tracks.ts, gig_moderation to the curator gigs list via `refId: gigId`); include `data: { kind, refId }` in the Expo message; add the response listener in app/_layout.tsx plus `setNotificationHandler` and an Android channel; an unread badge on the mobile Account tab and the web switcher.
- Owner: SP7 (it owns fan notifications and "performance notifications").

### 9. Admin surface: coverage map, gaps, and one lookup bug
- Severity: Medium. Category: missing-feature.
- Evidence (apps/web/app/admin/page.tsx): AdminAlerts 1641-1664, Queue 426-455, TracksQueue 593-655, GigsAdmin 832-860, TakedownsPanel 1122-1279 (unpublish, live-track removal, reliability marks, per-profile bookings list), UserLookup 1373-1473 (email exact + name prefix, admin notes, profiles), AuditLog 1489-1544.
- Server admin callables in functions/src/index.ts and their UI: reviewProfile (yes), reviewTrack (yes), takedownGig (yes), removeReliabilityMark (yes), releaseStuckSaga (yes, but only for 3 of 15 alert kinds: page.tsx:1574), flagAccount (yes), searchUsersByName (yes), grantAdmin (NO UI; only scripts/seed-admin.ts), backfillDisplayNameLower and backfillBookingVisibility (no UI, one-shot, acceptable).
- Content with no admin visibility at all: events, orders, tickets, transfers, ledger, stripeEvents, invites, payments subdocs (bookings are a link list only, page.tsx:974-1022). Admin actions that do not exist server-side: revokeAdmin, cancel event / refund order (finding 1), delete or disable a user, resolve the 12 non-saga alert kinds in-app.
- Bug: email lookup is an exact case-sensitive match (page.tsx:1401) while Firebase stores emails lowercased; typing "John@..." finds nothing. Fix: lowercase the term.
- Also: audit log has no entry for account deletion (account.ts writes none), which support and privacy requests will want.
- Failure scenario: a fan disputes a ticket charge; the admin cannot find the order, the ticket, or the event from /admin and has to use the Firestore console.
- Recommended action: per spec section 6 the admin page grows per sub-project; SP7/SP8 should add an events/orders/tickets lookup (by event, by buyer email), a grantAdmin/revokeAdmin control, and a deletion audit entry. Lowercase the email lookup now.
- Owner: fix-now for the lookup bug and the deletion audit entry; SP7/SP8 for the rest; launch-checklist for grant/revoke tooling.

### 10. deleteAccount cascade: named orphans and a money gap
- Severity: Medium. Category: bug (money, PII retention).
- Evidence: functions/src/account.ts:51-77 (deletes curatorAccess, memberships, `users/{uid}` tree, auth user; nothing else). ticketing.ts:242-251 (tickets live under users/{uid}/tickets, attendees under events/{e}/attendees with `ownerUid` and a copied `ownerName`), ticketing.ts:1005-1012 (check-in reads the user-side ticket doc), paymentsSweep.ts:1513-1607 (settlement counts paid, non-refunded orders), functions/src/eventsCore.ts:24 (transfer TTL 24h), scheduled.ts:613-633 (invite sweep 14d).
- What survives a deletion today: (a) `orders/{id}` with a dead `buyerUid` (fine as ledger); (b) `events/{e}/attendees/{t}` rows with the deleted user's `ownerName` and a ghost "valid" status whose check-in now throws because the user-side ticket is gone; (c) tier `soldCount` never released, so the seat is dead capacity; (d) any paid ticket for a future event is not refunded, yet the curator is still settled for it at T+1; (e) `invites` naming the uid stay pending for up to 14 days; (f) `transfers` to or from the uid stay "offered" up to 24h; (g) `adminNotes/{uid}` and `geocodeBudgets/{uid}` remain (harmless); (h) no audit entry; (i) no re-authentication is demanded (Admin SDK `deleteUser` bypasses Firebase's recent-login rule), so a hijacked session can wipe an account with one call.
- Failure scenario: fan buys two $60 tickets, deletes their account the next day, shows up with a screenshot; the door scanner errors on the ghost attendee, the curator is paid $120 for seats that were never filled, and the fan has no refund path and no account to dispute from.
- Recommended action: refuse deletion while the user holds `valid` tickets to a future event (or auto-refund via the existing refund path and release inventory); mark attendee rows `refunded`/removed; revoke pending invites and void offered transfers; write `account_deleted` to auditLogs; require a recent sign-in (check `auth_time` in the token, under 5 minutes) before deleting.
- Owner: fix-now for (d) and (i); SP7 for the rest.

### 11. No transactional email exists at all; no receipt on ticket purchases; web users get no delivery beyond the inbox
- Severity: Medium. Category: missing-feature / launch.
- Evidence: grep for sendgrid, nodemailer, resend, postmark, mailgun, `receipt_email` across functions/src returns nothing; apps/web/app/dashboard/page.tsx:131 comment records web push as deliberately deferred; functions/src/notifications.ts is the only delivery path (Firestore inbox + Expo push).
- Defect: the only way a web-only curator learns of a booking, deposit charge, or approval is by opening /dashboard; ticket buyers get no receipt.
- Failure scenario: a wedding planner who never installs the app misses an applicant's offer for a week; a fan who paid $120 has no email evidence of purchase for their card statement.
- Recommended action: set `receipt_email` on ticket PaymentIntents (Stripe sends the receipt); wire the Firebase Trigger Email extension (or Resend) to `users/{uid}/notifications` creates for profile_review, booking, and ticket kinds with an unsubscribe preference on the user doc.
- Owner: launch-checklist (receipts), SP7 (email fan-out alongside the notification href map).

### 12. Seed-admin hardcodes the dev project id on the production path
- Severity: Medium. Category: bug (launch).
- Evidence: scripts/seed-admin.ts:11 (`initializeApp({ projectId: "gatekeep-dev-jg" })` even when `GOOGLE_APPLICATION_CREDENTIALS` points at prod), same in scripts/seed-test-accounts.ts:32 (dev-only by intent, acceptable).
- Failure scenario: the first production admin is seeded against the dev project (or the call fails on a project mismatch), and /admin on prod shows "Not found" for everyone.
- Recommended action: read the project id from `GCLOUD_PROJECT`/`FIREBASE_PROJECT` or the credentials file, and print the resolved project before writing the claim.
- Owner: launch-checklist.

### 13. submitProfileForReview skips requireVerifiedEmail and the docId guard
- Severity: Low. Category: bug / spec-drift.
- Evidence: functions/src/profiles.ts:131-135 (only requireAuthUid, then `requireProfileAdmin(profileId, uid)` on an unvalidated id); contrast members.ts:156-165 which documents the file-wide ordering "requireAuthUid, requireVerifiedEmail, input validation, authz".
- Failure scenario: `profileId: "a/b"` reaches `doc(...)` and surfaces as `internal` instead of `invalid-argument`; an unverified co-admin (possible once invites ship) can submit for review.
- Recommended action: add `requireVerifiedEmail(req)` and `isValidDocId(profileId)`; add the two negative tests.
- Owner: fix-now.

### 14. requireAuth consolidation: one real leftover, and the rulings note is stale
- Severity: Low. Category: docs / test-gap.
- Evidence: functions/src/guards.ts:7-11 exports requireAuthUid, used by 13 files; functions/src/account.ts:14-15 still inlines the check; review.ts:10-14 is requireAdmin's own extraction (fine). docs/superpowers/foundation-rulings.md:37 still lists the consolidation as deferred; guards.ts carries no "three local copies" comment any more.
- Recommended action: swap account.ts to requireAuthUid; update the rulings doc (see section B).
- Owner: fix-now.

### 15. deleteProfile still orphans pending invites (deferred item, unresolved)
- Severity: Low today, Medium once finding 4 ships. Category: bug.
- Evidence: functions/src/profiles.ts:230-387 (no invites cascade); members.ts:88-89 (respondToInvite throws not-found and leaves the doc pending); scheduled.ts:613-633 (revoked after 14 days).
- Recommended action: batch-revoke `invites where profileId == X and status == pending` inside deleteProfile (the composite index already exists: firestore.indexes.json:2-6).
- Owner: fix-now (five lines) or bundle with finding 4.

### 16. inviteMember: duplicates, already-members, and untrimmed emails
- Severity: Low. Category: bug.
- Evidence: functions/src/members.ts:39-60: no check for an existing pending invite to the same `invitedUid`, no check that the invitee is already a member (accept fails later with already-exists, but the invite sits pending and counts toward the 20 cap for 14 days), `getUserByEmail(email)` is called on the raw string (offerTransfer trims at ticketing.ts:1093; this one does not).
- Failure scenario: a leading space from a mobile keyboard makes the invite silently "succeed" (anti-enumeration branch) and nothing is ever created.
- Recommended action: trim and lowercase; reject or return-existing on a duplicate pending invite; reject an already-member invitee with the same uniform response shape.
- Owner: bundle with finding 4.

### 17. Profile name and handle are immutable; user display fields have no editor; denormalized copies are safe only by accident
- Severity: Medium. Category: missing-feature.
- Evidence: no callable writes `profiles.name` or `handle` after createProfileDraft (grep of portfolio.ts and curator.ts); firestore.rules:29-40 lets the owner edit `displayName`, `photoUrl`, `homeCity` but no screen does (grep of apps for those fields hits only admin/page.tsx). Denormalized copies: `AttendeeDoc.ownerName` (ticketing.ts:235), `InviteDoc.profileName` (members.ts:57), `GigPublicLocation.venueName` (gigSeries.ts:183, gigs.ts:120), `EventAct.name` (events.ts lineup), booking notification bodies read the live name (bookings.ts:35).
- Failure scenario: a band renames itself after approval and has no option but delete-and-recreate, which is forbidden while approved (finding 3). A fan whose display name is their email local-part ("jgeddes3", authTriggers.ts:8) shows up that way on every door list forever.
- Recommended action: a `updateProfileIdentity` callable (name, and handle with cooldown plus a `handles` redirect tombstone), and a basic account editor (display name, photo, home city) on both clients. Decide the source of truth for search (finding for SP8) before adding more copies.
- Owner: SP7 (fan account basics), SP8 (name/handle change plus index invalidation).

### 18. Reserved-handle list is six words
- Severity: Low. Category: security.
- Evidence: packages/shared/src/validation.ts:12-14; spec section 8 also promised "well-known artist names".
- Failure scenario: `gatekeep_official`, `gatekeepapp`, `support_team`, `moderator`, `staff`, `official` are all claimable today and would surface prominently once SP8 search exists.
- Recommended action: expand the list, add a substring rule for "gatekeep", and keep an admin-editable `reservedHandles` doc for names of the founding partner's artists.
- Owner: SP8.

### 19. Abuse controls beyond the documented caps: none, and the draft cap is racy
- Severity: Low pre-launch. Category: security.
- Evidence: functions/src/profiles.ts:79-92 (cap counted outside the transaction: two parallel calls can both pass at 2 and create a 4th draft), members.ts:39-43 (20 pending per profile, so 3 drafts give one user 60 pending invites and an unbounded revoke/re-invite loop, each a Firestore write), adminTools.ts (searchUsersByName is admin-only, fine), `geocodeBudgets` (curator.ts / geocode.ts) is the only per-uid budget in the codebase, no `enforceAppCheck` on any onCall (recorded in README as a launch step), mobile has no App Check client code (recorded).
- Recommended action: nothing new for SP1 beyond moving the draft cap inside the transaction; SP8's search endpoint must ship with a per-uid budget doc like geocodeBudgets from day one, and App Check enforcement stays on the launch checklist.
- Owner: fix-now (transaction), SP8, launch-checklist.

### 20. Newly granted admin (and newly verified email) need a forced token refresh
- Severity: Low. Category: ux.
- Evidence: apps/web/app/admin/AdminGate.tsx:28 and dashboard/page.tsx:250 call `getIdTokenResult()` without `true`; see finding 5 for the verification twin.
- Failure scenario: admin claim granted; the person reloads /admin and still sees "Not found" for up to an hour.
- Recommended action: `getIdTokenResult(true)` on those two mounts.
- Owner: fix-now.

### 21. Mobile context switch is not persisted
- Severity: Low. Category: ux.
- Evidence: apps/mobile/src/shell/ProfileContext.tsx:17 (`useState("fan")`), ContextSwitcher.tsx:32-41.
- Failure scenario: a curator scanning tickets at the door force-quits and relaunches into the fan tabs.
- Recommended action: persist the last `activeContext.profileId` in AsyncStorage and re-validate it against `myProfiles` on load.
- Owner: SP7.

### 22. Em dashes in roughly 200 server-side user-facing strings and 5 client files
- Severity: Low. Category: docs (binding project rule).
- Evidence: functions/src/review.ts:243 (the rejection notification body itself), account.ts:58/64/70/76, profiles.ts:90, validation.ts:224, adminTools.ts:122, bookingLifecycle.ts:210-222 (notification bodies), gigs.ts:21, curator.ts:127; grep count of string literals containing the character in functions/src + packages/shared: 197; apps/: 5 files.
- Recommended action: mechanical sweep replacing with a colon or a period; several tests assert on message text, so run `pnpm emu:test` after.
- Owner: fix-now.

### 23. Test gaps (SP1 area)
- Severity: Low. Category: test-gap.
- Evidence: functions/test/notifications.test.ts covers only the inbox write (3 tests); nothing exercises the exp.host fan-out, the 5s timeout, or the 20-token cap. account.test.ts (5 tests) never seeds tickets, orders, invites, or transfers. profiles.test.ts has no events/tickets fixture for deleteProfile, no cooldown-bypass-via-delete test, no malformed-id test for submitProfileForReview. review.test.ts has no reject-from-approved-with-published-event test. members.test.ts has no duplicate-invite or whitespace-email test.
- Recommended action: land the tests with findings 1, 2, 7, 10, 13, 16.
- Owner: with each fix.

### 24. Foundation docs are stale relative to code
- Severity: Low. Category: docs.
- Evidence: docs/superpowers/foundation-rulings.md:32-40 still lists eight items as deferred; six are done (section B). HANDOFF.md says "7 Fan discovery" is next but does not mention that fans have no email verification resend, no account editor, and no invite UI, all of which SP7 will trip over.
- Recommended action: replace the "Deferred to sub-project 2" list with the status table below and link findings 1-6 as SP7 blockers.
- Owner: fix-now (docs).

---

## B. Status of every item in foundation-rulings.md "Deferred to sub-project 2" and the post-merge sweep

| Item | Status | Evidence |
|---|---|---|
| Admin user-lookup name search | Resolved | functions/src/adminTools.ts:18-40 (prefix range query, cap 10); apps/web/app/admin/page.tsx:1361-1410 (Email/Name mode toggle). Email mode is case-sensitive exact match (finding 9). |
| Join-wizard in-flight guard | Resolved | apps/web/app/join/page.tsx:85 and 188 (busy state disables the button); apps/mobile/app/join.tsx:33 (`if (busy) return`). |
| Orphaned-draft cleanup | Partial (accepted) | Cleanup path is deleteProfile plus the 3-draft cap (profiles.ts:15, 88-91). No automatic reaper for abandoned drafts; the daily sweep never touches profiles. Acceptable given the cap. |
| deleteProfile leaves orphaned pending invites | Not resolved | profiles.ts:230-387 has no invites step; scheduled.ts:613-633 revokes after 14 days (finding 15). |
| deleteProfile has no status restriction (confirm intent) | Resolved | profiles.ts:241-251: draft and rejected only, with the product rationale recorded inline ("Finding 3"). Tests at profiles.test.ts:201-244. |
| Mobile account-screen dedup (3 byte-identical screens) | Resolved | apps/mobile/src/shell/AccountScreen.tsx; the three `(role)/account.tsx` files are 4-line wrappers. |
| Shared requireAuth helper consolidation | Mostly resolved | guards.ts:7-11 `requireAuthUid` used by 13 files; account.ts:14 still inline (finding 14). No "three local copies" comment survives in guards.ts. |
| @handle vanity URL rewrite | Resolved | apps/web/next.config.ts:14-22 (`/u/:handle` 308s to `/@:handle`; `/@:handle` rewrites to app/u/[handle]). |
| Rejected-profile revise+resubmit UI on both clients | Resolved | Web: dashboard/portfolio/[profileId]/page.tsx:216-222 and 296, dashboard/curator/[profileId]/page.tsx:173-179 and 265 (reason shown, "Resubmit for review"). Mobile: (musician)/portfolio.tsx:280 and 321, (curator)/dashboard.tsx:204 and 236. Server cooldown/cap errors are surfaced verbatim. |
| Mobile lint green | Resolved | `pnpm --filter mobile lint` run during this audit: 0 errors, 3 `react-hooks/exhaustive-deps` warnings (NotificationsList.tsx:26, ProfileContext.tsx:49 and 58). |
| Post-merge: inviteMember enumeration oracle | Resolved | members.ts:44-51 uniform `{ ok: true }`; cap check runs before resolution (members.ts:31-43). |
| Post-merge: email verification on sensitive actions | Resolved, one gap | createProfileDraft (profiles.ts:67), inviteMember (members.ts:14), and every SP2-SP6 callable checked; the one non-admin callable without it is submitProfileForReview (finding 13). deleteAccount deliberately has none. Admin callables use requireAdmin only (admins are Google accounts, so verified by construction). |
| Post-merge: rejection reason cap 500 | Resolved | review.ts:39-41. |
| Post-merge: pending-invite cap 20 + index | Resolved | members.ts:9 and 39-43; firestore.indexes.json:2-6. |

Consciously accepted items confirmed still accepted and NOT re-reported above: deleteAccount's non-transactional sole-admin check (account.ts:8-12), no web push (dashboard/page.tsx:131), no native mobile App Check code and `enforceAppCheck` as a launch step (README "Manual follow-ups"), `GOOGLE_WEB_CLIENT_ID` placeholder (mobile/src/auth/config.ts:5), Expo web target out of scope, sign-in enumeration-protection assumption (README). One acceptance I would revisit: "deleteProfile has no profile-status restriction (likely fine)" was correctly tightened, but the same reasoning was never applied to the money-bearing SP5/SP6 state the profile now owns (findings 1 and 2).

---

## C. What SP7 (fan discovery) and SP8 (search) must know from this area

What a fan can do today, concretely.
- Mobile (apps/mobile/app/(fan)): Discover tab shows only "Your upcoming shows" derived from held tickets plus a coming-soon placeholder (index.tsx:13-19); Tickets tab is real (wallet, QR, transfers); Search tab is a placeholder (search.tsx); Account tab has theme, sign out, delete account, and the notifications list (AccountScreen.tsx). `/artist/[handle]` and `/event/[eventId]` exist but are reachable only from a ticket row or a deep link; there is no browse.
- Web: `/gigs` (public open-gig browse, in the shell nav for every context), `/tickets`, `/e/[eventId]`, `/@handle` and `/@handle/shows`, `/dashboard` (profiles list, notifications, delete account). No follow, no saved artists, no city filter, no search.
- A fan cannot edit display name, photo, or home city on either client (finding 17), and the default display name is the email local-part (authTriggers.ts:8). Any "people who follow you" or attendee surface will show that.
- Buying requires a verified email (ticketing.ts:61) and there is no resend or banner (finding 5). Fix this before driving fans to event pages.

Data model facts SP7 will build on.
- Roles derive from `profiles/{id}/members/{uid}` (collection-group query, rules 337-339); there is no role field on `users/{uid}`. "Fan" is the absence of memberships. A "follow" relation should live under `users/{uid}/follows/{profileId}` (owner-only rules like pushTokens) with a server-maintained counter on the profile if a public count is wanted; no such collection exists yet.
- `users/{uid}` is owner/admin-readable only (rules 22-23); nothing about a fan is public, so a follower list would need its own projection.
- Only `status == 'approved'` profiles and `published`/`completed` events are publicly readable (rules 62, 258). Note that event visibility is not tied to curator approval (finding 1): discovery must filter on the curator's status too, or the backend must fix the cascade first (recommended).
- `handles/{handle}` is get-only (rules 358); listing is denied by design, so a search index cannot be built client-side from handles.
- Notification plumbing: `notifyUser`/`notifyProfileMembers` (notifications.ts) write `users/{uid}/notifications` and push to `users/{uid}/pushTokens` (20-cap, no receipts, no data payload). Adding "artist announced a show" notifications means: a new `kind` in packages/shared/src/types.ts:90, a `refId`, the href map on both clients, and the push `data` payload (finding 8). Web users get nothing but the inbox unless finding 11 lands.
- Push registration happens in ProfileContext.tsx:55-58 on every sign-in and is never cleaned up (finding 6). Any per-user targeting SP7 adds inherits the cross-account leak until fixed.
- `LAUNCH_TIMEZONE` (types.ts:316) pins display times; discovery listings should use the same formatters (`formatGigDateTime`, `formatEventFullDate`).

Facts SP8 (search) must know.
- Profile `name` and `handle` are immutable today (finding 17), `users.displayName` is client-editable per rules but has no UI, and `displayNameLower` is the only lowercased index field in the system (authTriggers.ts:9-14, 61-67). Any search index must decide whether it mirrors these docs (trigger-maintained, like displayNameLower) or reads them live, and must handle the rename callable SP8 will probably have to add.
- The only search primitive in the codebase is a single-field prefix range on `displayNameLower` capped at 10 (adminTools.ts:18-40). Genres, act sizes, city, and neighborhood are plain fields on `profiles.portfolio` / `profiles.curator` with no lowercased or tokenized copies.
- Reserved handles are six words (finding 18); expand before handles become discoverable.
- No per-uid budget pattern exists except `geocodeBudgets` (finding 19); copy that shape for a search callable, and note App Check is not enforced.
- The admin page has no search over events/orders/tickets (finding 9); an SP8 index could serve both fan search and admin lookup.

Blockers to clear before or during SP7, in priority order: findings 1, 2, 3, 5, 6 (money and launch), then 4, 8, 10, 11, 17.

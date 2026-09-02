# GateKeep cross-cutting audit (between sub-projects)

Date: 2026-09-01. Read-only audit of main at 4dab485 (post sub-project 6 merge). No repo file was
modified. The only network command run was `pnpm audit --json` (output kept in this scratchpad as
`audit.json`). Every claim below cites path:line in the repo; line numbers are from `cat -n` of the
file as it exists today.

Scope reminder: functions/ is the only privileged writer (firestore.rules is default-deny at
firestore.rules:360, storage.rules:76). 62 callables plus 6 non-callable functions are exported
from functions/src/index.ts:4-33.

Owner key: fix-now (small, direct commit to main), SP7 (fan discovery), SP8 (search), 5c (band
payout splits track), launch-checklist (README manual follow-ups), unowned (needs a decision on who
owns it).

---

## (A) Numbered findings

### Critical

**1. A curator who is unpublished or deleted leaves their published events on sale with nobody able to cancel, refund, or check in.**
- Category: data-lifecycle (money)
- Evidence:
  - `reviewProfile` reject-from-approved cascade touches gigs, series, bookings, curatorAccess only: functions/src/review.ts:100-183. The word "events" does not appear in review.ts, profiles.ts, or account.ts.
  - `deleteProfile` cascade: gigs and series (functions/src/profiles.ts:285-288), bookings unwind (profiles.ts:297), profile recursiveDelete (profiles.ts:327). No events, orders, tickets, or transfers.
  - `createTicketOrder` gates only on `event.status === "published"` and `startsAt` (functions/src/ticketing.ts:82-85); it never checks the curator profile's approval.
  - `cancelEvent`, `refundTicket`, `checkInTicket` all call `requireApprovedCuratorProfile` (functions/src/events.ts:507-508; functions/src/ticketing.ts:693, :988), so the rejected curator is locked out of their own remediation.
  - Admin UI has no event, order, or ticket surface at all (apps/web/app/admin/page.tsx:1666-1682 renders AdminAlerts, Queue, TracksQueue, GigsAdmin, TakedownsPanel, UserLookup, AuditLog).
  - firestore.rules:258-259 keeps a `published` event world-readable regardless of curator status.
- Defect: event lifecycle is not wired into profile moderation or deletion, and the only actors who can unwind an event are the people moderation just locked out.
- Failure scenario: admin unpublishes a fraudulent venue (or the venue admin deletes a rejected profile). Its published event keeps selling paid tickets through `/e/[eventId]` and mobile; the T+1 ticket settlement in paymentsSweep step 10 either pays the connected account of a rejected profile or, after deleteProfile removed `private/stripe`, escalates to adminAlerts with no tool to resolve it; fans hold tickets nobody can refund, and the event's door address stays readable to ticket holders (firestore.rules:281-284).
- Recommended action: (a) in `reviewProfile` reject-from-approved, cancel every `published` event of the profile through the same refund loop `cancelEvent` uses (`refundOrdersForCancelledEvent`, functions/src/events.ts:530), before the notification; (b) `deleteProfile` refuses while any event of the profile is `published` or has unsettled orders, or cancels them first; (c) add an admin `cancelEvent`/`takedownEvent` path that does not require curator approval; (d) `createTicketOrder` should also require the curator profile to be `approved`.
- Proposed owner: fix-now (a, b, d are functions-only; c can ride the admin work in finding 9).

### High

**2. `deleteAccount` deletes a fan's valid tickets outright and checks nothing about tickets, orders, transfers, or money.**
- Category: data-lifecycle (money)
- Evidence: the only precondition is the sole-admin check (functions/src/account.ts:18-33); then `recursiveDelete(users/{uid})` (account.ts:67) removes `users/{uid}/tickets` and `users/{uid}/ticketIndex` (both server-owned, firestore.rules:306-318). `events/{id}/attendees/{ticketId}` (shared AttendeeDoc, packages/shared/src/types.ts:969-972), `orders` (buyerUid, types.ts:946-960), `transfers` (fromUid/toUid, types.ts:983-986) and tier sold counters are never touched. Web confirm copy is a single generic line (apps/web/app/dashboard/page.tsx:276); mobile has an Alert with no ticket warning (apps/mobile/src/shell/AccountScreen.tsx:16-41).
- Defect: account deletion silently destroys paid, future-dated tickets and leaves ghost attendee rows and consumed capacity behind.
- Failure scenario: a fan with two $40 tickets for next week deletes their account to "start over"; the tickets vanish with no refund and no capacity release; the curator's door list shows two attendees who can never scan; if the sender had an `offered` transfer, the recipient gets `TICKET_NOT_VALID` on accept (ticketing.ts:1186-1199) until step 11 expires it. If the event is later cancelled, `refundOrdersForCancelledEvent` refunds the card (fine) and `notifyUser(buyerUid)` writes notification docs under a user path that no longer exists.
- Recommended action: block deletion while the uid holds any `valid` ticket for a future event, any `offered` transfer (either side), or any `pending` order; surface that in both clients' copy; on success, mark attendee rows `status: "refunded"`-style terminal or release capacity; add a `writeAudit` entry (account.ts has none).
- Proposed owner: fix-now.

**3. No Firebase Auth `onDelete` trigger: deleting a user from the console or Admin SDK orphans everything `deleteAccount` cleans up.**
- Category: data-lifecycle
- Evidence: functions/src/authTriggers.ts:7 registers only `functionsV1.auth.user().onCreate`; grep for `onDelete`/`onUserDeleted` across functions/src returns nothing.
- Defect: two deletion paths exist (callable and console) and only one cascades.
- Failure scenario: support deletes an abusive account from the Firebase console. `users/{uid}` (with email), `profiles/*/members/{uid}` (possibly the sole admin, leaving a profile with no admin that `transferAdmin`/`removeMember` invariants assume cannot happen), `curatorAccess/{uid}`, and `pushTokens` all remain; the curatorAccess marker is harmless only because no token can be minted for the uid.
- Recommended action: add `functionsV1.auth.user().onDelete` that runs the same membership/curatorAccess/users-tree cleanup as `deleteAccount` (extract a shared `cascadeDeleteUser(uid)`), logging rather than blocking on the sole-admin case.
- Proposed owner: fix-now.

**4. Functions are pinned to Node.js 20, which Cloud Functions deprecated on 2026-04-30 and decommissions on 2026-10-30; local dev runs Node 24.**
- Category: deps
- Evidence: functions/package.json:5-7 (`"node": "20"`), firebase.json:4 (`"runtime": "nodejs20"`), root package.json:7 (`>=20`), local `node --version` = v24.14.1. The installed firebase-tools 15.28.1 runtime table (node_modules/.pnpm/firebase-tools@*/node_modules/firebase-tools/lib/deploy/functions/runtimes/supported/types.js:50-55) lists nodejs20 deprecationDate 2026-04-30, decommissionDate 2026-10-30; nodejs22 and nodejs24 are GA.
- Defect: production runtime is already deprecated and will refuse deploys in under two months; nothing in the emulator suite runs under Node 20 either (ffmpeg-static/sharp binaries are exercised on Node 24).
- Failure scenario: first production deploy after 2026-10-30 fails; or a Node 20 vs 24 difference (for example `AbortSignal.timeout`, `fetch` behaviour, sharp prebuilt binaries) shows up only in production.
- Recommended action: move `engines.node` and `firebase.json` runtime to `nodejs22` (or 24) together, run `pnpm emu:test` under the same major locally, add an `.nvmrc`.
- Proposed owner: fix-now.

**5. No email channel exists anywhere; push reaches only mobile users who granted permission; ticket buyers get no receipt at all.**
- Category: notifications
- Evidence: `notifyUser` writes an inbox doc and POSTs to `https://exp.host/--/api/v2/push/send` (functions/src/notifications.ts:4-25); grep for sendgrid, nodemailer, resend, postmark, firestore-send-email, FCM across functions/src and apps returns nothing. Ticket PaymentIntents are created with amount, metadata and `automatic_payment_methods` only, no `customer`, no `receipt_email` (functions/src/stripeClient.ts:837-843), so Stripe's own receipt emails never fire. Web in-app list exists (apps/web/app/dashboard/page.tsx:140-149) and mobile list exists (apps/mobile/src/shell/NotificationsList.tsx:20-28), both capped at the last 30.
- Moments that today produce only an in-app doc (plus push if a mobile token exists): booking apply/offer/counter/decline/withdraw/accept (bookings.ts, 8 notify sites), booking cancel/late cancel/no-show (bookingLifecycle.ts, 11 sites), gig cancel/takedown (gigs.ts, 3), profile and track review outcomes (review.ts:238, tracks.ts, 3), settlement charged/failed/past-due and payouts (paymentsSettlement.ts 4, paymentsPayouts.ts 2, paymentsSweep.ts 3), ticket purchase confirmation, grace refund, cancel refund, transfer offer/accept/decline (ticketing.ts, 9), event-tomorrow reminder and booking expiry (scheduled.ts, 5).
- Defect: every curator (web-first) and every fan who buys on web has zero out-of-app signal for money events and offers.
- Failure scenario: a curator's card is declined at T+3 settlement; dunning retries and the "past due" state exist only as a dashboard row; the curator finds out when they next log in, after the delinquency gate has blocked their next booking. A fan buys a ticket on web, closes the tab, and has no email proving the purchase.
- Recommended action: pick a transactional email provider (Firebase "Trigger Email" extension or Resend/Postmark) and fan out from `notifyUser` for a whitelist of kinds (money, offer, ticket, cancellation); set `receipt_email` on ticket PaymentIntents as the cheapest first step.
- Proposed owner: launch-checklist for the provider decision; fix-now for `receipt_email`.

**6. Every client can reach every callable with only an ID token: no `enforceAppCheck`, no App Check client on mobile, no rate limiting outside geocoding.**
- Category: abuse
- Evidence: grep `enforceAppCheck` across functions/src: zero hits (all 62 callables use `{ region: "us-central1" }` plus secrets). Web App Check initialises only in production with a site key (apps/web/src/lib/firebase.ts:42-48); mobile has no app-check package (apps/mobile/package.json) and no attestation code. Per-uid budget exists only for geocoding (`geocodeBudgets`, README "Daily geocode budget"). Other caps are per-profile counts: 20 pending invites (functions/src/members.ts:9), 50 open gigs, 10 active series, 25 open bookings (packages/shared/src/types.ts:304-305, :438), 3 unsubmitted profiles (profiles.ts:15), 1 pending curator profile (types.ts:306).
- Defect: abuse controls are all "how many objects can exist", never "how fast can you call".
- Failure scenario: a script with a verified throwaway account hammers `offerTransfer` with candidate emails (each call performs an Auth `getUserByEmail`, ticketing.ts:1093) or `createTicketOrder` on a hot event to hold capacity in `pending` orders until step 8 expiry (ORDER_TTL); Cloud Functions billing and Auth quotas absorb it with no alarm.
- Recommended action: (a) launch checklist already covers console App Check; add `enforceAppCheck: true` to all callables in the same change; (b) add a generic per-uid sliding-window counter helper (reuse the `geocodeBudgets` pattern) and apply it to `offerTransfer`, `inviteMember`, `createTicketOrder`, `createProfileDraft`, `applyToGig`, `offerGig`; (c) cap pending orders per buyer per event (there is a pending-order check at ticketing.ts:100-104, confirm it is a cap not just a dedupe).
- Proposed owner: launch-checklist (a), SP8 (b, c) or fix-now if SP7 exposes fans to public event lists first.

**7. Firebase project config is hardcoded to the dev project in three client files and the functions bucket default; a production build has no switch.**
- Category: config
- Evidence: apps/web/src/lib/firebase.ts:10-16, apps/web/src/lib/firebase-server.ts:8-14 (second file in the concatenated read, lines 59-65 of that output), apps/mobile/src/lib/firebase.ts:20-26 all embed `projectId: "gatekeep-dev-jg"` and `storageBucket: "gatekeep-dev-jg.firebasestorage.app"`; functions/src/storage.ts:8 defaults `STORAGE_BUCKET` to the dev bucket; scripts/seed-admin.ts:6 hardcodes the project id. Emulator selection is `NODE_ENV !== "production"` (web) and `__DEV__` (mobile), so a production bundle targets the real dev project.
- Defect: "production" today means "the dev project with real users".
- Failure scenario: first App Store build ships pointing at gatekeep-dev-jg; the seeded test accounts, the emulator-only `stripeFake` posture and any dev data mix with real users; switching projects later requires a code change and a new native build.
- Recommended action: read config from `NEXT_PUBLIC_FIREBASE_*` / `EXPO_PUBLIC_FIREBASE_*` with the dev values as the documented default; set `STORAGE_BUCKET` in the functions deploy env; add `.env.example` files (none exist).
- Proposed owner: launch-checklist (already partially implied by README "whatever project id production uses"), fix-now for the env plumbing.

**8. Admin tooling stops at sub-project 4: no view or action for events, orders, tickets, transfers, refunds, ledger, payments, or user disable; `grantAdmin` has no UI; no mobile admin.**
- Category: admin
- Evidence: callables used on the page: reviewProfile, reviewTrack, takedownGig, flagAccount, removeReliabilityMark, releaseStuckSaga (apps/web/app/admin/page.tsx, `httpsCallable` grep). Collections read: profiles, tracks (group), gigs, bookings, reliability, handles, members (group), adminNotes, users, auditLogs, adminAlerts (page.tsx:432-1646). No `events`, `orders`, `tickets`, `transfers`, `ledger`, `stripeEvents`, `gigSeries` reads. `grantAdmin` (functions/src/review.ts:248) is only reachable via scripts/seed-admin.ts. No `/admin` route in apps/mobile/app. See table (C).
- Defect: half of the money-bearing object graph has no operator surface.
- Failure scenario: a fan emails support "I was charged twice for tickets"; the only way to look at their order is the Firestore console; the only refund path is the curator's own grace-refund button.
- Recommended action: minimum viable set before launch: event lookup with admin cancel (finding 1), order/ticket lookup by buyer email with admin refund, ledger view per booking/event, user disable (Auth `disableUser`) with a rules check, grantAdmin button gated on Google provider.
- Proposed owner: unowned (proposal: a small "admin 2" track between SP7 and SP8, or fold into SP8 since search infra helps lookups).

**9. There is no CI: every gate is run by hand.**
- Category: test-gap
- Evidence: no `.github/` directory at repo root (`ls -la .github` empty); no Dependabot/Renovate config; HANDOFF.md:66-67 lists the gates as manual commands.
- Defect: typecheck, 704 emulator tests, 103 rules tests, lint and build only run when someone remembers.
- Failure scenario: a direct-to-main "small fix" between sub-projects (allowed by HANDOFF.md:50-51) breaks a rules test nobody runs until the next sub-project's final review.
- Recommended action: a GitHub Actions workflow with Java + Node 22 that runs `pnpm typecheck`, shared tests, `pnpm emu:rules`, `pnpm emu:test`, web lint+build, mobile lint on every PR and push to main.
- Proposed owner: fix-now.

### Medium

**10. The push pipeline is send-only: no foreground handler, no tap handling, no data payload, tokens never removed on sign-out, no receipt or `DeviceNotRegistered` pruning.**
- Category: notifications
- Evidence: messages carry `to/title/body` only (functions/src/notifications.ts:13); no Expo access token header, no receipts call. Mobile registers on every user load (apps/mobile/src/shell/ProfileContext.tsx:55-58, apps/mobile/src/notifications/push.ts:7-17) but `signOutUser` only calls `signOut` (apps/mobile/src/auth/AuthProvider.tsx:15). grep for `setNotificationHandler`, `setNotificationChannelAsync`, `addNotificationResponseReceivedListener` across apps/mobile: zero hits.
- Defect: pushes arrive as bare system banners that open the app root; while the app is foregrounded nothing is shown; a shared device keeps receiving the previous user's pushes; dead tokens accumulate up to the 20-token cap (notifications.ts:11).
- Failure scenario: fan A signs out on a friend's phone; friend signs in; fan A's "your transfer was accepted" push lands on the friend's lock screen.
- Recommended action: delete `users/{uid}/pushTokens/{token}` on sign-out; add `setNotificationHandler` and an Android channel; include `data: { kind, refId }` and route on tap; process push receipts in the daily sweep and prune `DeviceNotRegistered` tokens.
- Proposed owner: SP7.

**11. Transfer offers and member invites to an email with no account are silently dropped while the sender is told "sent".**
- Category: notifications / abuse
- Evidence: `offerTransfer` returns `TRANSFER_OFFER_SENT_MESSAGE` on unknown email with no record written (functions/src/ticketing.ts:1091-1098); `inviteMember` has the same anti-enumeration shape (functions/src/members.ts:44-56). No pending-by-email record, no email.
- Defect: the anti-enumeration ruling (correct) was implemented as "do nothing" rather than "queue for when they sign up".
- Failure scenario: a fan transfers a ticket to a friend who has never installed GateKeep; the friend never hears; 24 hours later (`TRANSFER_TTL_MS`) the fan sees the offer expired and assumes the app is broken.
- Recommended action: store a `pendingTransfersByEmail/{hash}` (or invites-by-email) record, resolve it in `onUserCreated`, and send an email (finding 5) that doubles as the signup invitation. Keep the uniform response.
- Proposed owner: SP7 (fan onboarding) with the email channel.

**12. No user-facing report or block for any side, and event content is never reviewed.**
- Category: abuse
- Evidence: grep for reportUser/reportProfile/reportEvent/blockUser across apps and functions: zero hits (the only "report" is `reportNoShow`, bookingLifecycle.ts:660). Events publish via `publishEvent` (events.ts:398) with no admin queue and no `takedownEvent`; gigs have `takedownGig` (gigs.ts:408); profiles and tracks are reviewed. Validation is length-only (packages/shared/src/validation.ts:279 caps description at 2000; no URL or profanity filters anywhere, grep `profan|sanitize|containsUrl` empty).
- Defect: the first fan-facing surface (SP7) will list curator-authored titles, descriptions, and lineups with no moderation loop and no way for a fan to flag them.
- Failure scenario: a curator publishes an event with a scam payment link in the description; fans can only email support; admins have no takedown button and no queue.
- Recommended action: `reportContent` callable writing to an admin queue (reuse adminAlerts shape), `takedownEvent` admin callable, and a light link/keyword screen on event and gig text at publish time. Blocking between musicians and curators can wait.
- Proposed owner: SP7 (fan report) and fix-now for `takedownEvent`.

**13. Handle squatting has a per-user cap but no expiry, and the daily sweep never reaps stale drafts.**
- Category: abuse
- Evidence: `MAX_UNSUBMITTED_PROFILES = 3` per admin uid (functions/src/profiles.ts:15, :79-91); dailySweep steps are materialize, past-gig close, track reaper, invite sweep, curatorAccess retry, plus SP4/SP6 booking and reminder steps (functions/src/scheduled.ts:322, :568, :586, :613, :638). No draft-profile reaper.
- Defect: three handles per verified email, forever.
- Failure scenario: 30 throwaway Gmail aliases reserve 90 venue names in the launch metro the week before launch.
- Recommended action: reap `draft` profiles untouched for 30 days in the sweep (free the handle), and cap drafts per uid to 1 until the first is submitted.
- Proposed owner: SP8 (handles become search-visible then) or fix-now.

**14. Retention is undefined for everything except `stripeEvents`, and there is no data-export or subject-access path.**
- Category: privacy
- Evidence: the only `expireAt` is stamped on `stripeEvents` (functions/src/paymentsWebhook.ts:167) and depends on a console TTL policy (README SP5 checklist). `users/{uid}/notifications`, `auditLogs`, `ledger`, `orders`, `transfers`, `pushTokens`, `adminNotes` grow without bound (no pruning in scheduled.ts or paymentsSweep.ts). grep for "export my data|subject access|gdpr|ccpa" across code and docs: zero hits. `users/{uid}.email` is stored (authTriggers.ts:15) and returned to admins by `searchUsersByName` (adminTools.ts:37). Raw `geocodedFrom` address strings are stored in gig/event private subdocs (gigs.ts:125, events.ts:236) and in curator location (curator.ts:131-133, public for approved venues by design).
- Defect: the privacy policy placeholder (apps/web/app/privacy/page.tsx:10) cannot be written truthfully yet because retention and access rights are not defined.
- Failure scenario: a deleted user asks what was kept; the honest answer today is "your email in adminNotes and auditLogs, your name in attendee rows, your uid in ledger and orders, forever".
- Recommended action: write a one-page retention table (what, why, how long) that counsel folds into /privacy; add an admin "export user data" script (Admin SDK, JSON) as the subject-access path; prune notifications older than 90 days in the sweep.
- Proposed owner: launch-checklist (with the legal review item).

**15. Observability is client-side only: no server Sentry on web, no error reporting in functions beyond Cloud Logging, mobile Sentry has no native plugin or source maps.**
- Category: ops
- Evidence: web has `instrumentation-client.ts` only (apps/web/instrumentation-client.ts:8-12, tracesSampleRate 0); no `instrumentation.ts`, no `withSentryConfig` in apps/web/next.config.ts. functions/package.json has no Sentry and the code uses `console.*` (about 250 sites, for example paymentsSettlement.ts 65, paymentsSweep.ts 52). Mobile calls `Sentry.init` (apps/mobile/app/_layout.tsx:17) but app.json plugins (apps/mobile/app.json:44-63) do not include `@sentry/react-native/expo`, so no native crash capture or source-map upload; `enabled: !__DEV__` with an empty DSN. No PII scrubbing config either way (`sendDefaultPii` unset, default false, acceptable).
- Defect: money-path failures in functions are visible only to someone reading Cloud Logging by hand; adminAlerts is the sole escalation channel and has no external notifier.
- Failure scenario: `paymentsSweep` throws on a missing composite index in production; nothing pages anyone; settlement silently stops (README SP5 already warns about this exact case).
- Recommended action: Cloud Monitoring alert policies on function error rate and on `adminAlerts` document creation (log-based metric); add `@sentry/node` or Google Error Reporting in a shared `reportError` helper; add the Sentry Expo plugin.
- Proposed owner: launch-checklist.

**16. Web has no `error.tsx` or `global-error.tsx`; mobile has no ErrorBoundary; mobile has no offline handling.**
- Category: ops
- Evidence: `find apps/web/app -name error.tsx -o -name global-error.tsx` returns nothing (only two `not-found.tsx`: apps/web/app/e/[eventId]/not-found.tsx, apps/web/app/u/[handle]/not-found.tsx). No `ErrorBoundary` export in any apps/mobile/app route and no `componentDidCatch` in apps/mobile/src. No NetInfo dependency (apps/mobile/package.json) and no offline banner; only inline comments mention offline (apps/mobile/src/bookings/BookingInbox.tsx:78).
- Defect: a render-time throw on web shows Next's default error page unstyled; on mobile a throw inside a screen falls through to expo-router's dev overlay / native crash.
- Failure scenario: a malformed booking doc (for example a legacy field) throws in `BookingThread`; the fan sees a white screen with no retry.
- Recommended action: add a branded `app/error.tsx` and `app/global-error.tsx` (DESIGN.md error-state language already exists in 9A/9B); export a root `ErrorBoundary` from apps/mobile/app/_layout.tsx; add an offline banner driven by NetInfo.
- Proposed owner: fix-now (error boundaries), SP7 (offline).

**17. Scheduler jobs have no retries, no failure alerting, and run at a UTC slot; the webhook keeps the 60s default timeout.**
- Category: ops
- Evidence: `dailySweep` `{ schedule: "every day 09:00", region, timeoutSeconds: 540, memory: "512MiB" }` (functions/src/scheduled.ts:965-968) with the UTC caveat in its own comment (scheduled.ts:954-958); `paymentsSweep` `{ schedule: "every 1 hours", ..., secrets }` (functions/src/paymentsSweep.ts:1631-1634). Neither sets `retryCount` or `timeZone`. `stripeWebhook` sets no `timeoutSeconds` (paymentsWebhook.ts:169-171, its comment at :152 acknowledges it). No `minInstances` anywhere (grep).
- Defect: a transient failure in a money-critical hourly job is skipped for an hour with no signal; a 24h daily job that fails once loses a whole materialization day.
- Failure scenario: Firestore returns UNAVAILABLE for 30 seconds at 09:00 UTC; the day's series occurrences are not materialised until tomorrow; curators see gaps.
- Recommended action: `retryCount: 3` on both schedulers, `timeZone: LAUNCH_TIMEZONE` on dailySweep, `timeoutSeconds: 120` on the webhook, and the alert policies from finding 15.
- Proposed owner: fix-now (options), launch-checklist (alerts).

**18. Deep links are not configured, which SP7 share links need.**
- Category: config
- Evidence: apps/mobile/app.json:8 sets `"scheme": "gatekeep"` but there is no `ios.associatedDomains` or `android.intentFilters`; no `Linking.addEventListener`/`useURL` usage (grep shows only `Linking.openURL`/`openSettings`). Web canonical URLs are `/@handle` and `/e/[eventId]` (apps/web/next.config.ts:13-24).
- Defect: a shared `https://<domain>/e/abc` opens the browser, never the installed app; `gatekeep://` links work only from inside the app.
- Recommended action: decide the production web domain (blocks `PUBLIC_PROFILE_HOST` too, apps/mobile/app/(musician)/portfolio.tsx:20), add associatedDomains + intentFilters, host `apple-app-site-association` and `assetlinks.json` from apps/web/public, and map `/e/[id]` and `/@handle` to expo-router routes.
- Proposed owner: SP7.

**19. Store-review permission risks: microphone permission is declared with no recording feature; Google sign-in plugin lacks `iosUrlScheme`; no googleServicesFile.**
- Category: config
- Evidence: apps/mobile/app.json:35-40 lists `RECORD_AUDIO`; the `expo-audio` plugin entry (app.json:52) has no options, and its defaults add `NSMicrophoneUsageDescription` and `RECORD_AUDIO` (node_modules expo-audio plugin `withAudio.js:8-26`); grep for `useAudioRecorder|AudioRecorder` in apps/mobile: none. `@react-native-google-signin/google-signin` is listed bare (app.json:50) with no `iosUrlScheme`; `GOOGLE_WEB_CLIENT_ID` is a placeholder (apps/mobile/src/auth/config.ts:5). Camera string is set manually (app.json:17) since `expo-camera` is not in plugins.
- Defect: Apple reviewers ask why a ticketing app wants the microphone; iOS Google sign-in cannot complete without the URL scheme.
- Recommended action: `["expo-audio", { "recordAudioAndroid": false, "microphonePermission": false }]` if the plugin supports disabling (otherwise strip via a config plugin), add `iosUrlScheme`, and keep the README's google-services items.
- Proposed owner: launch-checklist.

**20. Web ships no security headers and no CSP.**
- Category: config
- Evidence: apps/web/next.config.ts has only `redirects()` and `rewrites()`; no `headers()`; no `middleware.ts`/`proxy.ts` (ls returns nothing).
- Defect: no HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy; Stripe.js and Firebase origins are not pinned.
- Failure scenario: the public `/e/[eventId]` page can be framed on a phishing site with a fake "Buy" overlay.
- Recommended action: `headers()` with HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a report-only CSP covering `js.stripe.com`, `*.googleapis.com`, `*.firebaseio.com`, `firebasestorage.googleapis.com`, `fonts.gstatic.com`.
- Proposed owner: launch-checklist.

**21. Dependency audit: 1 critical, 1 high, 6 moderate; all dev-only or transitive tooling except `uuid` inside firebase-admin.**
- Category: deps
- Evidence: `pnpm audit --json` metadata: critical 1, high 1, moderate 6, 1773 total deps. Critical: vitest <3.2.6 (installed ^2, "Vitest UI server arbitrary file read/execute", dev). High: vite <=6.4.2 `server.fs.deny` bypass on Windows (dev, via vitest). Moderate: esbuild dev-server CORS (dev), vite path traversal and launch-editor NTLM disclosure (dev), `uuid` <11.1.1 via firebase-admin 12.7.0 (runtime, low practical exposure), `decode-uri-component` via @expo/cli (dev), `@opentelemetry/core` via firebase-tools (dev).
- Also: firebase-admin 12.7.0 while 13.x is current; stripe 18.5.0 pinned to `apiVersion: "2025-08-27.basil"` (functions/src/stripeClient.ts:666), consistent with that SDK line; firebase-functions 6.6.0 fine; TypeScript 6.0.3 on mobile vs ^5 elsewhere (apps/mobile/package.json:53); v1 auth trigger API in use (authTriggers.ts:1, :7), still supported but 1st-gen.
- Recommended action: bump vitest to 3.x across the four packages (one lockfile change), bump firebase-admin to 13 when moving to Node 22, keep the Stripe pin, add Dependabot with CI.
- Proposed owner: fix-now.

**22. Web SEO surface is missing for a discovery product: no robots, sitemap, manifest, or default OG image.**
- Category: config
- Evidence: no apps/web/app/robots.ts, sitemap.ts, manifest.ts, opengraph-image.*; public/ holds only hero/ and marketing/ (ls). OG images exist only when a poster or avatar resolves (apps/web/app/e/[eventId]/page.tsx:143, apps/web/app/u/[handle]/page.tsx:436), and posters are never persisted (README SP6 "Poster upload is not wired end to end"). `metadataBase` is env-dependent (apps/web/app/layout.tsx:58-62).
- Defect: every shared event link renders a text-only card; crawlers get no sitemap of `/e/*` or `/@*`.
- Recommended action: `robots.ts`, `sitemap.ts` over approved profiles and published events, a branded fallback `opengraph-image`, and finish the poster persistence (a `posterPath` field write in `processPhoto`).
- Proposed owner: SP7.

**23. Stripe customers and connected accounts are never cleaned up or detached on profile deletion; a rejected-then-deleted musician's Connect balance becomes unreachable in-app.**
- Category: data-lifecycle (money)
- Evidence: `deleteProfile` recursiveDelete removes `profiles/{id}/private/stripe` (profiles.ts:327); functions/src/stripeClient.ts has no `customers.del`, `accounts.del`, or `paymentMethods.detach` (grep). Payout requests require the profile (`requestPayout`, paymentsPayouts.ts:176 with `requireProfileMember`).
- Defect: the Firestore pointer to the Stripe objects is deleted while the objects (and any balance) persist.
- Failure scenario: admin unpublishes a musician for a policy breach after a settled show; the musician deletes the rejected profile; $600 sits in a connected account nobody can pay out from the app; only the Stripe dashboard can.
- Recommended action: `deleteProfile` refuses while `private/stripe` reports a non-zero connected balance or pending payout, and records the Stripe ids in the audit entry; consider `accounts.del` only for zero-balance Express accounts.
- Proposed owner: 5c (touches payout plumbing) or fix-now for the refusal check.

### Low

**24. `firebase deploy` has never been run: `workspace:*` resolution, Secret Manager injection, and composite index builds are all unproven.**
- Category: test-gap
- Evidence: README "Deploy-time workspace:* resolution" bullet; functions/package.json:15 `"@gatekeep/shared": "workspace:*"`; 39 composite indexes in firestore.indexes.json (SP3 5, SP4 16, SP5 7, SP6 11 per README).
- Recommended action: a dry-run deploy to a throwaway Firebase project before any other launch item; it also validates finding 4.
- Proposed owner: launch-checklist.

**25. User-facing strings in functions contain em dashes, violating the binding copy rule.**
- Category: config (copy rule)
- Evidence: 20 `HttpsError`/notification strings match; examples functions/src/account.ts:58,64,70,76 ("did not complete ... it is safe to try again"), adminTools.ts:122, bookingLifecycle.ts:1365 (notification body), curator.ts:127, gigs.ts:385, profiles.ts:90,167, review.ts:243. Web and mobile copy is clean (0 hits outside comments).
- Recommended action: one sweep replacing with a period or colon.
- Proposed owner: fix-now.

**26. Brand drift in native config: splash and adaptive-icon colours are Expo template blues.**
- Category: config
- Evidence: apps/mobile/app.json:22 `backgroundColor: "#E6F4FE"`, app.json:47 splash `backgroundColor: "#208AEF"`; DESIGN.md defines the Ember/Deep Night palette and 9B claimed full carry-over.
- Proposed owner: fix-now (9B follow-up).

**27. Admin bootstrap and one-shot backfills live only in scripts and console callables.**
- Category: admin
- Evidence: scripts/seed-admin.ts:6 hardcodes `gatekeep-dev-jg`; `backfillDisplayNameLower` and `backfillBookingVisibility` are admin callables with no UI (README SP3/SP4 checklists say "Functions testing tab or a short authenticated script").
- Proposed owner: launch-checklist (make seed-admin take a project id).

**28. Mobile cold-start and memory sizing for media are reasonable but unmeasured; no `minInstances`.**
- Category: ops
- Evidence: `processUpload` 1GiB/300s (functions/src/media.ts:397-399) with ffmpeg-static and sharp; every callable at defaults (256MiB/60s). Acceptable for v1; note that `acceptBooking` and `finalizeTicketOrder` cold-start with the Stripe SDK on the user's critical path.
- Proposed owner: unowned (measure after first deploy).

**29. Web has a vitest dependency but zero tests; mobile has none by ruling; no e2e.**
- Category: test-gap
- Evidence: test files: functions/test (33), packages/shared/test (4), tests-rules (4); `find apps/web -name "*.test.*"` returns none; apps/mobile/package.json:60 `"test": "echo no unit tests in mobile yet"`.
- Proposed owner: unowned (at minimum, a smoke test of `apps/web/src/lib/firebase.ts` env plumbing once finding 7 lands).

**30. Firestore backups and billing guardrails are not mentioned anywhere.**
- Category: ops
- Evidence: grep for PITR, backup, scheduled export, budget alert across README.md and docs/superpowers: zero hits. `ledger` is the append-only money audit (firestore.rules:226) with no off-Firestore copy.
- Recommended action: enable PITR and a daily scheduled export bucket; set a GCP budget alert; add both to the launch checklist.
- Proposed owner: launch-checklist.

---

## (B) Deletion and data lifecycle table

Columns: handled by `deleteAccount` (account.ts) / handled by `deleteProfile` (profiles.ts) / orphan or money hazard / severity. "n/a" means the collection is not keyed to that actor.

| Collection or object | deleteAccount | deleteProfile | Orphan or money hazard | Severity |
|---|---|---|---|---|
| Firebase Auth user | Yes (account.ts:73) | n/a | Console deletion has no trigger (finding 3) | High |
| `users/{uid}` (email, displayName, homeCity) | Yes, recursiveDelete (account.ts:67) | n/a | Survives console deletion | Medium |
| `users/{uid}/notifications` | Yes (subtree) | n/a | `notifyUser` recreates orphan docs for a deleted uid (notifications.ts:7) | Low |
| `users/{uid}/pushTokens` | Yes (subtree) | n/a | Never removed on sign-out (finding 10) | Medium |
| `users/{uid}/tickets` | Yes, destroyed (subtree) | No | Valid future tickets deleted without refund or capacity release (finding 2) | High |
| `users/{uid}/ticketIndex` | Yes (subtree) | No | Address gate proof gone; consistent with ticket loss | Low |
| `profiles/{id}` | No (sole-admin block only) | Yes (profiles.ts:327) | Console deletion of a sole admin strands the profile | Medium |
| `profiles/{id}/members` | Yes, own docs (account.ts:61) | Yes (recursiveDelete) | OK | Low |
| `profiles/{id}/private/booking`, `curatorBooking`, `reliability` | n/a | Yes (recursiveDelete) | OK | Low |
| `profiles/{id}/private/stripe` | n/a | Yes, doc only | Stripe customer + connected account persist; balance unreachable in-app (finding 23) | Medium (money) |
| `profiles/{id}/tracks` | n/a | Yes | OK | Low |
| `invites` (invitedUid / invitedByUid / profileId) | No | No | Orphans until the 14-day invite sweep revokes them (scheduled.ts:613, members.ts:67) | Low |
| `handles/{handle}` | n/a | Yes, precondition-read (profiles.ts:309-325) | OK | Low |
| `gigs` + `gigs/{id}/private/location` | n/a | Yes, curator only (profiles.ts:39-51) | OK; past filled gigs on a musician side survive by design | Low |
| `gigSeries` | n/a | Yes, curator only (profiles.ts:53-63) | OK | Low |
| `bookings` | No (profile-scoped) | Unwound to `expired`, survive (profiles.ts:297, bookingLifecycle.ts:1306) | Deliberate; sweep step 7 refunds future deposits | Low |
| `bookings/{id}/payments/{gigId}` | No | No (survive) | Deliberate; settlements of ended shows still run (bookingLifecycle.ts:335) | Low |
| `notifications` kinds referencing a dead profile/booking | No | No | Cosmetic | Low |
| `geocodeBudgets/{uid}` | No | n/a | Trivial orphan counter | Low |
| `curatorAccess/{uid}` + `curatorAccessRetries/{uid}` | Yes, first (account.ts:52-55) | Recomputed per member (profiles.ts:341-348) | Survives console deletion (harmless: no token) | Low |
| `events` + `tiers` + `private/address` | No | **No** | Published events keep selling; nobody can cancel (finding 1) | **Critical (money)** |
| `events/{id}/attendees/{ticketId}` | **No** | No | Ghost attendees with deleted `ownerUid`; capacity never released | High |
| `orders` (buyerUid) | **No** | No | Refund loop still works by PI; notifications to dead uid; no buyer lookup path | Medium |
| `transfers` (fromUid / toUid) | **No** | No | `offered` transfers dangle until step 11 expiry; recipient gets TICKET_NOT_VALID | Medium |
| `ledger` (profileId, buyerUid) | No (by design, audit) | No (by design) | PII: uid retained forever; acceptable if documented (finding 14) | Low |
| `adminAlerts` | No | No | Alerts naming a deleted profile stay open with no resolver | Low |
| `adminNotes/{uid}` | **No** | n/a | Retained flag history for a deleted person; decide retention | Low |
| `auditLogs` | No (by design) | Written (profiles.ts:385); `deleteAccount` writes none | No audit trail for account deletion | Low |
| `stripeEvents` | n/a | n/a | Console TTL policy owed | Low |
| Stripe customer (curator) | n/a | Not deleted | Saved card persists at Stripe; fine for PCI, orphaned | Low |
| Stripe connected account (musician) | n/a | Not deleted | Balance/payout stranded (finding 23) | Medium (money) |
| Storage `public/tracks`, `review/tracks`, `public/photos` | n/a | Best-effort sweep (profiles.ts:365-383) | Direct URLs work until swept (README) | Low |
| Storage `staging/{audio,photos}/{uid}/...` | **No** | No | Backstop is the unconfigured 24h lifecycle rule (README launch blocker) | Medium |

Deletion preconditions actually enforced: `deleteAccount` refuses only while the caller is the sole admin of any profile (account.ts:18-33). `deleteProfile` refuses unless status is `draft` or `rejected` (profiles.ts:247-251). Neither checks open bookings, held or unsettled funds, pending payouts, pending orders, valid future tickets, or offered transfers. Open bookings are handled indirectly by `unwindBookingsForModeration` (profile deletion only) and paymentsSweep; tickets and events are not handled at all.

---

## (C) Admin coverage table

Admin callables exported (functions/src/index.ts): `reviewProfile`, `grantAdmin` (review.ts), `searchUsersByName`, `backfillDisplayNameLower`, `flagAccount` (adminTools.ts), `backfillBookingVisibility` (bookingVisibility.ts), `takedownGig` (gigs.ts:408), `reviewTrack` (tracks.ts:150), `removeReliabilityMark` (bookingLifecycle.ts:1049), `releaseStuckSaga` (payments.ts:390). Ten total.

Admin UI sections (apps/web/app/admin/page.tsx:1666-1682): AdminAlerts (:1641), Queue (:426), TracksQueue (:593), GigsAdmin (:832), TakedownsPanel (:1122, with ReliabilityPanel :875, ProfileBookingsList :974, LiveTrackRow :1036), UserLookup (:1373, with UserProfiles :1286, AdminNotes :1328), AuditLog (:1489).

| Object type | View | Act | Gap |
|---|---|---|---|
| profiles | Pending queue; lookup by handle in Takedowns | Approve, reject (+flag), unpublish (reject-from-approved) | No list of approved profiles, no "delete" (owner must), no search by name/handle prefix |
| tracks | Pending queue (collectionGroup); live tracks per profile | Approve, reject, remove | OK for v1 |
| gigs | By status list (GigsAdmin) | takedownGig | No edit, no series context |
| series (gigSeries) | None | None (pause/end are curator callables) | **Gap: view + admin pause** |
| bookings | Per profile list in Takedowns | None directly (removeReliabilityMark only) | **Gap: no admin cancel/expire, no refund** |
| payments (`bookings/*/payments`) | None | releaseStuckSaga via alert row | **Gap: no per-booking money view, no manual refund/clawback** |
| adminAlerts | List | releaseStuckSaga for stuck sagas only | Other alert kinds (ticket_settlement_blocked, payout_failed, etc.) have no action or acknowledge |
| ledger | None | None | **Gap** |
| stripeEvents | None | None | Acceptable (console) |
| events | None | None | **Gap (finding 1): no cancel/takedown** |
| orders | None | None | **Gap: no buyer lookup, no admin refund** |
| tickets | None | None | **Gap: no check-in override, no void** |
| transfers | None | None | **Gap: no void** |
| refunds | None | None (curator grace refund only) | **Gap** |
| users | Lookup by exact email or name prefix; profiles per user; adminNotes | flagAccount | **Gap: no disable/ban, no delete, no password reset, no grantAdmin UI** |
| flags (adminNotes) | List per user | Append | No resolve/archive; 200-cap throws (adminTools.ts:121) |
| auditLogs | List | n/a | OK |

Mobile admin: none (no admin route under apps/mobile/app; no admin-claim check in apps/mobile/src). Impersonation: there is no view-as-user or support-impersonation feature; the "impersonation checklist" is the reviewer guidance banner about identity verification (apps/web/app/admin/page.tsx:442-445). Admin grant requires a Google-linked account (review.ts:259-262, scripts/seed-admin.ts:8-12) as the 2FA compensating control.

---

## (D) Callable guard table

Guards: A = `requireAuthUid` (or inline `req.auth?.uid`), V = `requireVerifiedEmail`, Adm = `requireAdmin`, M = membership/ownership check (`requireProfileMember`, `requireProfileAdmin`, `requireBookingSide`, or an equivalent inline read), Appr = approved-profile check. Source: extraction of the first 14 lines of each `onCall` body (see evidence lines).

| Callable | File:line | A | V | Adm | M | Appr | Notes |
|---|---|---|---|---|---|---|---|
| deleteAccount | account.ts:13 | inline | no | no | self | no | **Auth only**; acceptable for self-deletion, but see finding 2 |
| submitProfileForReview | profiles.ts:131 | yes | **no** | no | admin | no | **Auth only** (creator had to be verified to create the draft; a co-admin invited later need not be) |
| createProfileDraft | profiles.ts:65 | yes | yes | no | n/a | no | caps at :88 |
| deleteProfile | profiles.ts:229 | yes | yes | no | admin | status gate | |
| reviewProfile | review.ts:22 | via Adm | no | yes | n/a | n/a | admin |
| grantAdmin | review.ts:248 | via Adm | no | yes | n/a | n/a | admin; Google-provider check |
| inviteMember | members.ts:11 | yes | yes | no | admin (body) | no | cap 20 pending |
| respondToInvite | members.ts:69 | yes | yes | no | invitee | no | 14-day expiry |
| revokeInvite | members.ts:130 | yes | yes | no | inviter/admin | no | |
| removeMember | members.ts:153 | yes | yes | no | admin | no | never-zero-admin invariant |
| transferAdmin | members.ts:218 | yes | yes | no | admin | no | |
| updatePortfolio | portfolio.ts:18 | yes | yes | no | member | musician type | |
| updateBookingInfo | portfolio.ts:58 | yes | yes | no | member | musician type | |
| updateCuratorProfile | curator.ts:87 | yes | yes | no | member | curator type | geocode budget |
| removeCuratorPhoto | curator.ts:166 | yes | yes | no | member (body) | no | |
| createTrack | tracks.ts:18 | yes | yes | no | member | musician type | cap 10 |
| updateTrack | tracks.ts:55 | yes | yes | no | member | no | |
| deleteTrack | tracks.ts:86 | yes | yes | no | member | no | |
| reorderTracks | tracks.ts:109 | yes | yes | no | member (body) | no | |
| reviewTrack | tracks.ts:150 | via Adm | no | yes | n/a | n/a | admin |
| createGig | gigs.ts:130 | yes | yes | no | member | approved curator | cap 50 open |
| publishGig | gigs.ts:177 | yes | yes | no | member | no | |
| updateGig | gigs.ts:220 | yes | yes | no | member | no | |
| cancelGig | gigs.ts:346 | yes | yes | no | member | no | |
| takedownGig | gigs.ts:408 | via Adm | no | yes | n/a | n/a | admin |
| createSeries | gigSeries.ts:78 | yes | yes | no | member | approved curator | cap 10 |
| updateSeries | gigSeries.ts:130 | yes | yes | no | member (body) | no | |
| pauseSeries | gigSeries.ts:321 | yes | yes | no | member | no | |
| endSeries | gigSeries.ts:407 | yes | yes | no | member | no | |
| searchUsersByName | adminTools.ts:18 | via Adm | no | yes | n/a | n/a | admin; returns emails |
| backfillDisplayNameLower | adminTools.ts:51 | via Adm | no | yes | n/a | n/a | admin one-shot |
| flagAccount | adminTools.ts:96 | via Adm | no | yes | n/a | n/a | admin |
| backfillBookingVisibility | bookingVisibility.ts:112 | via Adm | no | yes | n/a | n/a | admin one-shot |
| applyToGig | bookings.ts:165 | yes | yes | no | member | approved musician | cap 25 open |
| offerGig | bookings.ts:206 | yes | yes | no | member (body) | approved (body) | |
| counterBooking | bookings.ts:241 | yes | yes | no | booking side | no | |
| declineBooking | bookings.ts:332 | yes | yes | no | booking side | no | |
| withdrawBooking | bookings.ts:385 | yes | yes | no | booking side | no | |
| acceptBooking | bookings.ts:1168 | yes | yes | no | booking side | no | Stripe secret |
| cancelBooking | bookingLifecycle.ts:457 | yes | yes | no | booking side (body) | no | Stripe secret |
| cancelOccurrence | bookingLifecycle.ts:491 | yes | yes | no | booking side (body) | no | cap 100 |
| reportNoShow | bookingLifecycle.ts:660 | yes | yes | no | curator side (body) | no | |
| removeReliabilityMark | bookingLifecycle.ts:1049 | via Adm | no | yes | n/a | n/a | admin |
| createSetupIntent | payments.ts:83 | yes | yes | no | member | no | |
| refreshPaymentMethod | payments.ts:121 | yes | yes | no | member | no | |
| createOnboardingLink | payments.ts:181 | yes | yes | no | admin | no | APP_ORIGIN |
| getStripeStatus | payments.ts:280 | yes | yes | no | member | no | |
| releaseStuckSaga | payments.ts:390 | via Adm | no | yes | n/a | n/a | admin |
| confirmOccurrenceActuals | payments.ts:526 | yes | yes | no | booking side (body) | no | |
| payPastDue | payments.ts:906 | yes | yes | no | member (body) | no | |
| requestPayout | paymentsPayouts.ts:176 | yes | yes | no | member (any member, README ruling) | no | |
| createEvent | events.ts:185 | yes | yes | no | member (body) | approved (body) | |
| updateEvent | events.ts:260 | yes | yes | no | member (body) | no | |
| setEventTiers | events.ts:310 | yes | yes | no | member (body) | no | |
| publishEvent | events.ts:398 | yes | yes | no | member | approved curator | no content review |
| cancelEvent | events.ts:494 | yes | yes | no | member | approved curator | locks out unpublished curators (finding 1) |
| createTicketOrder | ticketing.ts:58 | yes | yes | no | n/a (buyer) | **event status only** | no curator approval check (finding 1) |
| finalizeTicketOrder | ticketing.ts:186 | yes | yes | no | buyer (body) | no | verifies PI server-side |
| refundTicket | ticketing.ts:681 | yes | yes | no | member | approved curator | |
| checkInTicket | ticketing.ts:973 | yes | yes | no | member | approved curator | |
| offerTransfer | ticketing.ts:1059 | yes | yes | no | ticket owner (body) | no | email lookup, uniform response, no rate limit |
| respondToTransfer | ticketing.ts:1157 | yes | yes | no | toUid | no | |

Summary: 62 callables. 10 admin-only. 50 require auth + verified email. 2 require auth only: `deleteAccount` and `submitProfileForReview`. Zero declare `enforceAppCheck`. Non-callable entry points: `onUserCreated` (v1 auth), `onUserDocWritten`, `processUpload` (Storage, 1GiB/300s), `dailySweep`, `paymentsSweep` (schedulers), `stripeWebhook` (HTTP, signature-verified, App-Check-exempt by nature).

---

## (E) "Unverifiable locally" list

Things the emulator suite (704 functions tests, 103 rules tests, 158 shared tests) cannot prove, consolidated from README checklists plus this audit:

1. Composite indexes: all 39 entries in firestore.indexes.json plus the `tickets.orderId` collection-group field override (emulator never enforces indexes; a missing `payments`/`orders`/`transfers` group index makes the sweeps throw).
2. Cloud Scheduler provisioning, cadence, timezone and retry behaviour for `dailySweep` (09:00 UTC) and `paymentsSweep` (hourly), including the 540s ceiling under real collection sizes.
3. Real Stripe: webhook signature with a real `whsec`, `payment_intent.*`, `transfer.reversed`, `account.updated`, `payout.*` deliveries; Connect Express onboarding return/refresh via `APP_ORIGIN`; the legacy `charges.create({ source: accountId })` account-debit shape; instant payout fee; PaymentSheet (mobile) and Elements (web) confirmations; ticket checkout on the tickets `purpose` metadata; idempotency-key replay on the real API.
4. Secret Manager injection: every `defineSecret()` (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GEOCODER_API_KEY) resolving in deployed functions, and `getStripe()` failing closed outside the emulator.
5. `firebase deploy --only functions` resolving `@gatekeep/shared` from `workspace:*`.
6. Node 20 (or 22) runtime behaviour vs local Node 24: ffmpeg-static and sharp prebuilt binaries under Cloud Functions, `fetch`/`AbortSignal.timeout` in `notifyUser`.
7. Storage bucket lifecycle rule on `staging/` (24h) and the Firestore TTL policy on `stripeEvents.expireAt`: both are console/gcloud config the emulator ignores.
8. App Check: reCAPTCHA v3 site key on web, Play Integrity / App Attest on mobile, monitor vs enforce, and the effect of flipping Storage enforcement before native attestation exists.
9. Expo push: EAS projectId, APNs/FCM credentials, permission prompts, foreground vs background delivery, token rotation, receipts.
10. Native sign-in (Google web client id, Apple) on a dev-client build; Google `iosUrlScheme`.
11. Camera scanner (`expo-camera`) on a real device, duplicate-scan state, denied-permission Settings fallback.
12. Hermes ICU `Intl.DateTimeFormat` with `LAUNCH_TIMEZONE` on device.
13. Universal links / app links (none configured) and the `gatekeep://` scheme from outside the app.
14. Firestore rules cost and latency at scale: per-read `get()`/`exists()` in `profileApproved`, `private/curatorBooking`, `events/*/private/address`, `tiers`, `attendees` (the emulator does not bill or throttle).
15. Sentry pipelines (no DSN, no server or native wiring).
16. Email delivery of any kind (nothing exists to test).
17. Geocoding with `GEOCODER_PROVIDER=google` and the 50/day budget against real usage.
18. Firebase Auth console settings: Email Enumeration Protection, provider enablement, authorized domains for the production web origin.
19. Cold-start latency of payments callables and `processUpload` at 1GiB.
20. Both visual smoke checklists (9A web, 9B mobile) and the SP6 door-scanner pass, all still owner-owed per HANDOFF.md:72-83.

---

## Items that sit between sub-projects with no clear owner (consolidated)

Already tracked in README but still ownerless: LAUNCH_TIMEZONE and UTC series recurrence; poster upload persistence; web ticket transfers; `/terms` and `/privacy` placeholders; `CONTACT_EMAIL` and `PUBLIC_PROFILE_HOST` placeholders; hero photos; Google web client id and googleServices files; Sentry DSNs; native App Check; staging lifecycle rule; stripeEvents TTL; index verification; `workspace:*` deploy; the two one-shot backfills; Stripe go-live and 5b device steps; the `debitConnectedAccount` re-verification.

New from this audit: event lifecycle under moderation and deletion (1), ticket-aware account deletion (2), Auth onDelete trigger (3), Node runtime (4), email channel and receipts (5), App Check enforcement plus rate limiting (6), env-driven Firebase config (7), admin coverage for money objects (8), CI (9), push pipeline completeness (10), invite/transfer to unknown email (11), reporting and event takedown (12), draft reaping (13), retention and subject access (14), server-side error reporting and alerting (15), error boundaries and offline (16), scheduler retries and timezone (17), deep links (18), permission strings (19), security headers (20), dependency bumps (21), SEO surface (22), Stripe object cleanup on profile deletion (23), backups and budgets (30).

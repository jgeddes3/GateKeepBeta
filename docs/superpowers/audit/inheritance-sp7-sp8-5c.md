# GateKeep inheritance audit for SP7 (fan discovery), SP8 (search), 5c (band payout splits)

Date: 2026-09-01. Read-only audit of main after the SP6 merge (4dab485). Every status below was
re-verified in code, not taken from the docs. Paths are repo-relative; line numbers are from the
current tree. No em dashes in this document.

Sources read in full: docs/superpowers/HANDOFF.md, all nine *-rulings.md, README.md, all nine
specs. Plans were ripgrepped for the deferral keywords. Code sweep covered functions/src,
packages/shared/src, apps/web/app, apps/web/src, apps/mobile/app, apps/mobile/src,
firestore.rules, storage.rules, scripts/, firestore.indexes.json, app.json, eas.json, next.config.ts.

Status vocabulary: open = nothing in code; partial = some of it exists; resolved = done in code
(listed so nobody re-opens it). Owner vocabulary: fix-now (small, do before or at SP7 start),
SP7, SP8, 5c, launch-checklist (operator or console work, not a sub-project), unowned (no
sub-project claims it; needs an owner decision).

Counts: 91 ledger rows. 61 open, 9 partial, 21 resolved (11 in section A5 plus 10 folded into
its closing note). Of the 70 open or partial rows: 19 proposed SP7, 8 proposed SP8, 1 proposed 5c,
20 launch-checklist, 8 fix-now, 14 unowned.

---

## A. Consolidated obligations ledger

### A1. Fan, discovery, and search (the SP7 and SP8 core)

| id | item | origin | verified status in code | owner | why |
|---|---|---|---|---|---|
| L01 | Fan Discover tab is a branded coming-soon state (plus a ticket-holder upcoming list) | apps/mobile/app/(fan)/index.tsx:18-19, 96-101; sp9b-rulings.md:167-169 | open. Only "Your upcoming shows" (from held tickets) renders; the "Discover shows" block is copy only, no fetch | SP7 | This IS sub-project 7 per the file's own comment: "sub-project 7 is what actually builds discovery" |
| L02 | Fan Search tab is coming-soon | apps/mobile/app/(fan)/search.tsx:14-15; foundation spec 2026-08-24:106 (fan tabs: Home/Discover, Tickets, Search, Account) | open. No query, no input | SP8 (see B3 for the boundary argument; SP7 needs at least a browse list on this tab so it is not dead) | Foundation calls sub-7 "search, follow artists, performance notifications"; SP4 spec moves "full search experience" to sub-8. Decide in the SP7 brainstorm |
| L03 | Web has zero fan routes; a fan who signs in lands on /dashboard with a "No profiles yet" card | sp9a-rulings.md:58-59; apps/web/app/sign-in/SignInForm.tsx:77 (`redirectTo = next ?? "/dashboard"`); apps/web/app/dashboard/page.tsx:80-95; apps/web/src/marketing/SignedInRedirect.tsx:22 | open. Only /tickets (signed-in), /e/[eventId] (public), /gigs (public, musician-facing) exist; no /events index, no fan home | SP7 | Web is the SEO surface (foundation spec:113-114 "Logged-in fan: discover/tickets parity with mobile") |
| L04 | Mobile has no public curator/venue page route | apps/mobile/app/artist/[handle].tsx:85 ("mobile has no public curator-profile route"); route listing has only artist/[handle] | open | SP7 | A fan cannot open a venue on mobile at all; discovery of shows needs the venue page as a destination |
| L05 | Follow artists (foundation's definition of sub-7) | foundation spec:15 ("Fans buy tickets, discover events, and follow artists"), :31 ("7. Fan discovery: search, follow artists, performance notifications"), :138 ("artist announcements (7)") | open. No follows collection, no rules, no types (grep of packages/shared/src/types.ts, functions/src, firestore.rules for follow/favorite: none) | SP7 | Named explicitly as sub-7 scope in the binding product-context section |
| L06 | Performance notifications / artist announcements to fans | foundation spec:31, :138 | open. notifyUser writes inbox + Expo push (functions/src/notifications.ts:4-25); no fan-facing trigger exists except ticket lifecycle and the event-tomorrow reminder (functions/src/scheduled.ts:20-40, :270) | SP7 | Depends on L05 (who to notify) |
| L07 | Background web push (FCM service worker + VAPID) deferred to sub-7 | plans/2026-08-24-foundation.md:2373; apps/web/app/dashboard/page.tsx:131-132 | open. No service worker, no firebase-messaging-sw, no VAPID anywhere in apps/web | SP7 (as planned) or unowned if SP7 decides web push is not needed for a mobile-first fan | The plan explicitly parked it on sub-7 "where fan-facing notifications actually matter" |
| L08 | Fan map UI (sub-7 per SP3/SP4, sub-8 per 9A) | sp3 spec 2026-08-26-curator-gigs:119 ("fan-facing map UI (sub-7)"), :128 ("map UI itself is sub-7"), :188; sp4 spec:14 ("fan map UI (sub-7)"); web-uiux spec:343 ("Map view of gigs (sub-8, geo data already present)") | open. Geo stored on gigs (GigPublicLocation.geo, types.ts:251), curator location (types.ts:222-223), events (EventDoc.location reuses GigPublicLocation, types.ts:906). No geohash, no map component, no map dependency | SP7 or SP8 (conflict, see B3) | Three docs say sub-7, one says sub-8. Needs a ruling |
| L09 | Full search experience: text search, ranking, maps, saved searches, alerts | sp4 spec:14, :26, :80, :104; sp4-rulings.md:169-173; sp5-rulings.md:336-337; README.md:242-246, :267-268 | open. No search index, no saved-search or alert types/collections | SP8 | The one obligation every doc agrees is sub-8 |
| L10 | "Find gigs" / "Find musicians" directories are placeholder-grade; sub-8 replaces internals | README.md:242-246; apps/web/src/bookings/GigBrowse.tsx:49; apps/web/src/bookings/MusicianBrowse.tsx:20-21; apps/mobile/src/bookings/MusicianBrowse.tsx:29, :155 | open (by design) | SP8 | Recorded verbatim in code comments |
| L11 | Musicians directory page gate does not pin membership of the profile in the URL | sp4-rulings.md:170-172; apps/web/app/dashboard/curator/[profileId]/musicians/page.tsx:13-29 | open. Reads still prove via own curatorAccess; offerGig refuses server-side | SP8 | Folded into "sub-8's directory rework" by SP4 |
| L12 | Unused gigs(bookedMusicianProfileId, startsAt) index: drop or keep | sp4-rulings.md:172-173; firestore.indexes.json:60-64 | open. Shipped queries pin status too (apps/web/app/u/[handle]/page.tsx:147-148; apps/mobile/app/artist/[handle].tsx:47), so the 3-field index at :71-76 serves them | SP8 (housekeeping) | Harmless; recorded so it is not forgotten |
| L13 | Venue-defined filterable chips | web-uiux spec:315 ("Venue-defined filterable chips are sub-8"), :343-344 | open | SP8 | Explicitly sub-8 |
| L14 | Event discovery feeds and search | events-ticketing spec:361-363 ("event discovery feeds and search (sub-7/sub-8: this sub-project links events only from venue pages, artist pages, and shareable URLs)") | open. No events index route on web; mobile event screen reachable only from held tickets, transfer offers, or a raw deep link (apps/mobile/app/_layout.tsx:82-84 "(later, sub-7) discovery") | SP7 (feed/list), SP8 (search) | Joint ownership written into the spec; split it explicitly |
| L15 | Ticket-kind notifications carry refId = eventId but neither client deep-links them | functions/src/ticketing.ts:283, :495, :1133 (kind "ticket", refId eventId); apps/web/app/dashboard/page.tsx:194 (links only kind "booking"); apps/mobile/src/shell/NotificationsList.tsx:37-38 (same) | open | fix-now | Small; a fan tapping "Tickets confirmed" gets nothing. SP7 will trip over it |
| L16 | Mobile Tickets tab has no link from a ticket to its event page | apps/mobile/src/tickets/TicketDetail.tsx (only a map Linking.openURL at :96); no router.push in TicketList.tsx; web has it (apps/web/app/tickets/TicketsClient.tsx:158) | open | SP7 (or fix-now) | Fan flow dead end on mobile |
| L17 | Rescheduled published event does not re-notify holders or re-arm its reminder | sp6-rulings.md:196; functions/src/events.ts updateEvent has no reminderSentAt reset (grep) | open | SP7 | Fan-facing notification correctness; SP7 owns fan notifications |
| L18 | Poster upload not wired end to end (events render text-only) | sp6-rulings.md:186-189; README.md:882-887; functions/src/media.ts:257-260, :360 | partial. Pipeline accepts kind "poster" (media.ts:225, :268) and processes it, but never persists the path where a client can read it | fix-now, before SP7 UI work | A discovery feed of text-only event cards is the single most visible SP7 quality risk; the fix is a small functions change |
| L19 | users/{uid}.homeCity exists but no UI ever sets it | packages/shared/src/types.ts:11; functions/src/authTriggers.ts:17 (seeded null); firestore.rules:29-40 (owner may update it); grep of both apps: no reader or writer | open | SP7 | "Live music near you" (the Discover copy) needs a city or a location permission |
| L20 | No follows, favorites, saved searches, alerts, popularity signals, denormalized upcoming-event counts, event genres, city or geo indexes on events | verified absent: types.ts, functions/src, firestore.rules, firestore.indexes.json | open | SP7 (follows/favorites, counts), SP8 (saved searches/alerts, geo/text index) | See B2 for exactly what IS present |
| L21 | Web ticket transfers are mobile-only (view-only hint on web) | sp6-rulings.md:155-156; README.md:888-892; apps/web/app/tickets/TicketsClient.tsx:193-198 | open (by ruling) | unowned (SP7 candidate if web fan parity is in scope) | Nobody owns web fan parity; 9A ruled web fan surfaces empty |
| L22 | /tickets unpaginated; duplicate fan tab listeners | sp6-rulings.md:192 | open | SP7 (low) | SP7 touches both fan surfaces anyway |
| L23 | Abandoned pending orders hold inventory up to ~70 min; no buyer-side cancel | sp6-rulings.md:192-193 | open | unowned | Ticketing hardening, not discovery |
| L24 | Gig re-promotion blocked client-side only (no server gigId uniqueness) | sp6-rulings.md:190-191; functions/src/events.ts:221 (only "filled" check) | open | fix-now (small) | Duplicate events would show twice in any SP7 feed |
| L25 | Offline scan queue | events-ticketing spec:310 ("offline queue is a later item") | open | unowned | Curator door ops |
| L26 | Explicit SP6 non-goals with no owner: guest checkout, fan self-serve refunds, seat maps, promo codes, ticket emails/PDFs, resale marketplace, per-musician ticket revenue splits | events-ticketing spec:357-363 | open (YAGNI by ruling) | unowned (revenue splits: 5c territory per the spec) | Listed so the SP7 brainstorm does not re-litigate them by accident |

### A2. Messaging

| id | item | origin | verified status in code | owner | why |
|---|---|---|---|---|---|
| L27 | Musician and curator Messages tabs are coming-soon; web has no Messages nav; booking thread is terms-only | apps/mobile/app/(musician)/messages.tsx:15; apps/mobile/app/(curator)/messages.tsx:15; apps/web/src/shell/AppShell.tsx:88-91; README.md:195-196 ("terms only, no free chat"); foundation spec:17 ("Gig planning happens in-app via musician-curator messaging (fans do not get messaging)"), :110 ("built in sub-project 4"); sp4 spec:14 ("general messaging/chat (unscheduled)") | open | unowned | SP4 explicitly unscheduled it; no later doc picks it up. See B4 |

### A3. Cross-cutting launch and platform items

| id | item | origin | verified status in code | owner | why |
|---|---|---|---|---|---|
| L28 | Push sending: Expo push via exp.host, best effort, no receipts, no dead-token pruning | functions/src/notifications.ts:9-24 | partial (works for mobile; no receipt handling) | launch-checklist (token hygiene), SP7 for web push (L07) | Fine for v1; note the 20-token cap and 5s timeout |
| L29 | Email sending: none except Firebase Auth verification and reset | grep: only sendEmailVerification (SignInForm.tsx:86, sign-up.tsx:18); events spec:354-355 ("No email in v1: the Tickets tab is the receipt") | open. No receipts, no transfer email to non-users (offerTransfer returns the generic message and creates nothing for an unknown email, functions/src/ticketing.ts offerTransfer unknown-email branch), no resend-verification button anywhere | unowned; fix-now for a resend-verification affordance | createProfileDraft and inviteMember require email_verified (foundation-rulings.md:68) and the only send is at sign-up |
| L30 | SEO: sitemap.ts / robots.ts absent; metadataBase depends on NEXT_PUBLIC_SITE_URL | README.md:945 ("add sitemap.ts/robots.ts once something links to /@handle elsewhere"); README.md:404; no sitemap/robots files under apps/web/app | open | SP7 (public event and venue pages are the fan SEO surface) plus launch-checklist for the env var | /e/[eventId] and /@handle already emit OG + canonical (apps/web/app/e/[eventId]/page.tsx:131-146) |
| L31 | Share links and deep links: app scheme only, no universal links, no share button | apps/mobile/app.json:8 (scheme "gatekeep"; no associatedDomains, no intentFilters); no Share/navigator.share in apps/web/app/e/[eventId]/EventPageClient.tsx or apps/mobile/app/event/[eventId].tsx | open. Web URLs are shareable by copy-paste; the mobile app cannot open an https link | SP7 | Sharing an event is the fan growth loop the SP6 spec leaned on ("shareable web links") |
| L32 | PUBLIC_PROFILE_HOST placeholders hide "View public page" on mobile | apps/mobile/app/(musician)/portfolio.tsx:20-24; apps/mobile/app/(curator)/dashboard.tsx:25-26; README.md:566-569 | open | launch-checklist | Flips on its own once a real domain is set |
| L33 | Analytics: none | grep of both apps and functions for analytics/gtag/posthog/mixpanel/amplitude/logEvent: none | open | unowned | A discovery sub-project without any usage signal cannot tune ranking (SP8) |
| L34 | Admin tooling for SP6 objects (events, orders, tickets, transfers, refunds) | foundation spec:130 ("payment/refund tooling (5-6)"); apps/web/app/admin/page.tsx has no events/orders/transfers reads (grep) | open. SP4 admin exists (ReliabilityPanel :875, ProfileBookingsList :974); SP5 admin exists (AdminAlerts :1641, releaseStuckSaga) | unowned | Support cannot look up a fan's order or force a refund without the Firestore console |
| L35 | Legal pages are placeholders | apps/web/app/terms/page.tsx:10; apps/web/app/privacy/page.tsx:10; README.md:740-743 | open | launch-checklist (owner + counsel) | Owner-owed |
| L36 | Footer contact address placeholder | apps/web/src/shell/Footer.tsx:9 (hello@gatekeep.app) | open | launch-checklist | Owner-owed |
| L37 | Hero carousel placeholder photos | apps/web/public/hero/hero-1..3.jpg; README.md:735-739; HANDOFF.md:80 | open | launch-checklist (owner) | Owner-owed |
| L38 | App Check enforcement: zero enforceAppCheck options; web init production-only; mobile has no App Check client | grep enforceAppCheck in functions/src: 0; apps/web/src/lib/firebase.ts:43; apps/mobile/package.json has no app-check dep; README.md:491-501, :533-539 | open | launch-checklist (two-step: console + code) | Storage must not enforce before native mobile App Check ships |
| L39 | EAS: projectId now set; google-services files and GOOGLE_WEB_CLIENT_ID still placeholders; README says eas init still pending | apps/mobile/app.json:67-69 (projectId present); apps/mobile/src/auth/config.ts:5 (REPLACE_FROM_FIREBASE_CONSOLE); app.json has no googleServicesFile keys; README.md:510-527 | partial; README.md:510-513 is stale about projectId | launch-checklist; fix-now for the README line | Owner-owed console work |
| L40 | Sentry: DSNs unset; server-side instrumentation.ts absent (only instrumentation-client.ts) | apps/web/instrumentation-client.ts:2-9; apps/mobile/app/_layout.tsx:17; README.md:506-509, :946 | open | launch-checklist | Owner-owed |
| L41 | Geocoder go-live (GEOCODER_PROVIDER=google + secret); parseGoogleResponse throws on city-less results | README.md:573-581; functions/src/geocode.ts:158 | open | launch-checklist; fix-now for the throw (return a typed no-city result) | Real addresses hit plus-codes; a throw fails the whole save |
| L42 | LAUNCH_TIMEZONE single-metro constant must be set to the real metro | packages/shared/src/types.ts:316; README.md:595-600 | open | launch-checklist | Code constant, not env |
| L43 | Per-venue timezone | sp3-rulings.md:298-300; no timezone field on any doc (grep types.ts) | open | unowned (multi-metro is post-v1) | Recorded as a sub-4 obligation, never picked up |
| L44 | UTC recurrence-time caveat (series weekday/hour interpreted in UTC) | functions/src/scheduled.ts:45-52; apps/web/src/gigs/GigForms.tsx:310 (in-form disclosure); README.md:601-608 | open (disclosed, not fixed) | unowned | A fan in the launch metro sees LAUNCH_TIMEZONE wall time, but the curator picked a UTC time |
| L45 | Calendar-monthly recurrence (+28d today) | functions/src/scheduled.ts:52-57; sp3-rulings.md:301-302 | open | unowned | Sub-4 obligation, three sub-projects untouched |
| L46 | resumeSeries tripwire (pause is one-way; needs approval gate + pausedBy) | sp3-rulings.md:110-139, :240-251; sp4-rulings.md:147-153; sp5-rulings.md:330-331; grep resumeSeries/pausedBy: nothing | open, fourth sub-project running | unowned | Whoever adds resume must add pausedBy first or takedown durability breaks |
| L47 | 5c band payout splits | sp5-rulings.md:327-329; mobile-payments spec:162; functions/src/paymentsPayouts.ts:198 ("FUTURE (sub-5c)") | open | 5c | Needs its own brainstorm: multiple connected accounts per profile + a split spec surface |
| L48 | staging/ 24h GCS lifecycle rule (LAUNCH BLOCKER) | README.md:554-561; functions/src/profiles.ts:362-363 | open | launch-checklist | Emulator cannot test it |
| L49 | Stripe go-live checklist (webhook registration, secrets, TTL on stripeEvents, indexes, debitConnectedAccount re-verify, 4% re-verify, Connect activation, scheduler check) | sp5-rulings.md:300-317; README.md:657-716 | open | launch-checklist | Owner-owed |
| L50 | Deploy-time workspace:* resolution unverified | README.md:528-532 | open | launch-checklist | First real deploy risk |
| L51 | Composite indexes must be confirmed "Enabled" on the real project (SP3: 5, SP4: 16, SP5: 7, SP6: 11 + CG override) | README.md:587-594, :647-655, :708-713, :875-881 | open | launch-checklist | Emulator does not enforce them |
| L52 | One-shot backfills: backfillDisplayNameLower; backfillBookingVisibility in the SAME release as the rules | README.md:609-616, :632-646; sp4-rulings.md:26-28 | open | launch-checklist | Deploy-order CRITICAL |
| L53 | Cloud Scheduler provisioning checks (dailySweep, paymentsSweep); Firestore TTL on stripeEvents.expireAt | README.md:582-586, :672-676, :695-701 | open | launch-checklist | Silent unprovision means nothing settles |
| L54 | Firebase console: auth providers, Email Enumeration Protection, App Check registration | README.md:488-501, :549-553 | open | launch-checklist | Owner-owed |
| L55 | Owner smokes: 9A web signed-in, 9B mobile on new EAS build, SP6 (door scanner top priority), Stripe real-test-mode walkthrough | HANDOFF.md:72-82; sp9a-rulings.md:65-70; sp9b-rulings.md:183-190; sp6-rulings.md:201-212 | open | launch-checklist (owner) | Hard pre-launch gates |
| L56 | Seed script bios contain em dashes (10 occurrences) | sp9a-rulings.md:60-61; scripts/seed-test-accounts.ts (byte grep: 10) | open | fix-now | Project rule; ruled "fix in the seed script post-merge" |
| L57 | README has pre-existing em dashes outside the 9B section | sp9b-rulings.md:178-179 | open | fix-now (docs) | Project rule |
| L58 | README says "ANY member of a profile can trigger its payouts"; code and sp5 ruling 7 say admin-only | README.md:702-707 vs sp5-rulings.md:237-239 and functions/src/paymentsPayouts.ts:194-199 (requireProfileAdmin) | resolved in code, README stale | fix-now (docs) | A stale launch-checklist bullet contradicts a security ruling |
| L59 | Owner eyeball queue: light focus #BF5038, on-destructive white | sp9a-rulings.md:71-72; HANDOFF.md:79 | open | launch-checklist (owner) | Owner-owed |
| L60 | Expo web target broken (tslib/SSR) | foundation-rulings.md:20; README.md:123-125 | open, out of v1 scope | unowned | Next.js is the web surface |
| L61 | Later phases with no spec: advertising (advertisingInterest flag stored, unused: types.ts:220), subscriptions, 2FA, sign-in method linking, SMS | foundation spec:33, :170; sp3 spec:119, :188 | open | unowned | Post-v1 by design |

### A4. Engineering hardening carried from SP2 through SP6 (none block SP7; listed so they stop rotting)

| id | item | origin | verified status in code | owner | why |
|---|---|---|---|---|---|
| L62 | TrimUploader loads the whole file via fetch().blob(); mobile 25 MB cap | README.md:959-963; apps/mobile/src/portfolio/TrimUploader.tsx:19-27, :192 | open | unowned | Mobile polish |
| L63 | Mobile grace-period flash warning (startsSoonFlash) never ported | sp5b-rulings.md:66-69; only apps/web/src/bookings/BookingThread.tsx:404 | open | unowned ("do it with the next mobile booking-UI touch") | Small |
| L64 | TrueUpForm silently rounds "3.5" on both platforms | sp5b-rulings.md:70-71; apps/web/src/payments/TrueUpForm.tsx:61 | open | unowned | Shared validation someday |
| L65 | Materializer birth-decision race (filled gigs linked to a non-confirmed booking; no reconciling step) | README.md:272-277; sp5-rulings.md:332-333 | open (accepted at v1) | unowned | Fix menu recorded |
| L66 | Sweep step 6 reads each gig with a separate get(); db.getAll batching | README.md:278-279; grep getAll in functions/src/scheduled.ts: none | open | unowned | Scale only |
| L67 | functions/test helper duplication (makeApprovedCuratorProfile now defined in 10 test files) | README.md:283-287; functions/test/*.test.ts (10 files) | open, worse than recorded | unowned | Grows with every sub-project |
| L68 | BookingInbox pagination past the soft 50 cap | sp4-rulings.md:166; sp5-rulings.md:333 | open per docs (cap not re-located in code this pass) | unowned | Scale only |
| L69 | getStripeStatus TTL cache (M7); revokeAdmin/checkRevoked path (L9) | sp5-rulings.md:334-335; grep: none | open | unowned | Noted, never built |
| L70 | window.prompt/confirm/alert still used in 10 web files; shared toast/modal primitive | README.md:947-949; grep count: 10 files | open | unowned | UI polish |
| L71 | Public page perf: resolve Storage URLs at write time; public route group without the auth bundle | README.md:943-946 | open | unowned | Perf |
| L72 | processPhoto 3-read optimization | sp3-rulings.md:312-315 | open | unowned | Volume-gated |
| L73 | Admin name-search UX iteration (debounce, pagination past 10, zero-results state and test) | sp3-rulings.md:303-311 | open | unowned | Admin polish |
| L74 | Status-palette duplication (third-consumer rule) | sp3-rulings.md:344-346 | open | unowned | Wait for a third consumer |
| L75 | Invite-lifecycle client UI beyond SP1 | sp3-rulings.md:295-297 | open | unowned | Revisit when booking invites need a surface |
| L76 | ProfileContext switchTo reconciliation footgun | README.md:964-970 | open | unowned | Not a live bug |
| L77 | SP2 web polish: Promise.allSettled in admin tracks queue, upload cancel + beforeunload, accessibility pass, positive save feedback | README.md:947-951 | open | unowned | Polish |
| L78 | Two-hop transfer chains under a raced refund escalate rather than auto-resolve; grace-vs-cancel race delays a remainder ~24h | sp6-rulings.md:193-195 | open (accepted) | unowned | Alerted, self-healing |
| L79 | events/index series-list badge fixed neutral tone vs SERIES_STATUS_TONE on detail | sp9b-rulings.md:195-197 | open | unowned | Cosmetic |
| L80 | Geocoder StubGeocoder US bounding box; Google null-branch untested | sp3-rulings.md:318-325 | open | unowned | Dev-only |

### A5. Resolved rows (verified in code; do not re-open)

| id | item | origin | evidence of resolution |
|---|---|---|---|
| L81 | Admin user-lookup name search | foundation-rulings.md:34 | functions/src/adminTools.ts:18 searchUsersByName |
| L82 | Orphaned/expired invite cleanup | foundation-rulings.md:36 | README.md:171-172 sweep step 4 (scheduled.ts) |
| L83 | deleteProfile status restriction | foundation-rulings.md:36 | sp2-rulings.md:95-97; README.md:952-956 |
| L84 | Mobile account-screen dedup | foundation-rulings.md:37 | apps/mobile/src/shell/AccountScreen.tsx; the three account.tsx are 3-line wrappers |
| L85 | requireAuth/requireVerifiedEmail consolidation | foundation-rulings.md:37; sp2-rulings.md:118-123 | functions/src/guards.ts:13 exports; no local copies found by grep |
| L86 | @handle vanity URL rewrite | foundation-rulings.md:38 | apps/web/next.config.ts:12-27 redirects + rewrites |
| L87 | Rejected-profile revise+resubmit UI | foundation-rulings.md:39 | apps/web/app/dashboard/page.tsx:60 ("revise & resubmit") |
| L88 | Booking read widening / M-12 / M-13, filled status, fillMode, booked-musician address reveal | sp3-rulings.md:198-225, :262-294 | firestore.rules:90-96, :169-179; types.ts:203, :209 |
| L89 | SP2 Shows contract (platform events only) | sp2-rulings.md:139-141 | README.md:230-235 live Shows; events Upcoming sections (apps/web/app/u/[handle]/page.tsx:253-283) |
| L90 | Deposit money machine, settlement math, selfDeal settlement, inviteMember/respondToInvite guards | sp4-rulings.md:117-161 | sp5 as-built; functions/src/members.ts:156-158 |
| L91 | sp3 post-gate seven items (sweep step 5 per-doc try/catch, removeMember guards, deleteProfile handle ordering, etc.) | sp3-rulings.md:378-399 | plans/2026-08-26-booking-flow.md:309 ("All seven items ... landed"); members.ts:156-158 verified |

Also resolved and not re-listed as rows: abandoned-track reaper (README.md:562-565), EAS projectId (app.json:68), sub-6 built on completed bookings, 9A/9B money-sentence parity, transfers email-only ruling, curator photo ingestion (Task 4b), geocoder secret + budget, M-10 TOCTOU re-read, materializer cap guard, plan-doc convention.

---

## B. Precise answers

### B1. The fan role today

**Sign-up.** Mobile: apps/mobile/app/(auth)/sign-up.tsx:15-27 creates the auth user with email/password and sends a verification email; the Gate in apps/mobile/app/_layout.tsx:45-50 then replaces to "/", and apps/mobile/app/index.tsx:3 redirects to "/(fan)". Google/Apple native sign-in exists but needs a dev build and the real GOOGLE_WEB_CLIENT_ID (apps/mobile/src/auth/config.ts:5 placeholder). Web: apps/web/app/sign-in/SignInForm.tsx:79-113 handles email/password sign-up (with verification email) and Google/Apple popups, then `router.push(next ?? "/dashboard")` (:77). The only caller passing `next` is the event page buy gate (sign-in/page.tsx:11-13).

**User doc.** functions/src/authTriggers.ts:7-21 writes users/{uid} on auth create: `{ displayName, displayNameLower, email, photoUrl, homeCity: null, createdAt }` (packages/shared/src/types.ts:7-18). There is no fan profile doc, no role field (foundation spec:62 "Every user is a fan by default"). The owner may update displayName, photoUrl, homeCity (firestore.rules:29-40) but no UI on either platform does (grep). Fan-owned subcollections: users/{uid}/notifications, pushTokens, tickets (rules:306-308), ticketIndex (rules:315-317).

**Mobile fan screens** (apps/mobile/app/(fan)/_layout.tsx:8-15: Discover, Tickets, Search, Account):
- Discover (index.tsx): LIVE for ticket-holders only: "Your upcoming shows" from users/{uid}/tickets (:26-45), each row pushing /event/[eventId] (:91). Below it a coming-soon block: "Discover shows. Live music near you, coming soon." (:99-100). No query of events, profiles, or gigs.
- Tickets (tickets.tsx): LIVE. TicketList wallet (upcoming/past/cancelled, incoming transfer offers, QR, address reveal, TransferSheet).
- Search (search.tsx): COMING SOON ("Find artists and venues, coming soon." :15).
- Account (account.tsx -> src/shell/AccountScreen.tsx): LIVE: theme toggle, sign out, delete account (:16-41), NotificationsList (:42), and the ContextSwitcher join links.
- Reachable detail screens: /event/[eventId] (buy with PaymentSheet, lineup links to /artist/[handle] at event/[eventId].tsx:483), /artist/[handle] (public musician page). No venue/curator public page on mobile (artist/[handle].tsx:85).

**Web fan routes.** There is no fan home. Sign-in lands on /dashboard, which for a profile-less account shows "No profiles yet ... Create a profile" (apps/web/app/dashboard/page.tsx:80-95) plus the notifications inbox; the shell nav in the generic context is Dashboard, Gigs, Tickets (apps/web/src/shell/AppShell.tsx:122). /tickets is a signed-in wallet with QR and address reveal, transfers view-only (TicketsClient.tsx:193-198). /e/[eventId] is public SSR (page.tsx:84-129: anonymous read, published/completed only, OG metadata at :131-146) with a buy flow that gates on sign-in via `next`. /gigs is public and musician-facing (apply). /@handle venue and artist pages are public and now render Upcoming Events linking to /e/ (MusicianProfile.tsx:71, CuratorProfile.tsx:187).

**What a fan can do end to end right now.** Create an account; receive a shared /e/ link (web) or a raw gatekeep://event/ID deep link (mobile); buy free or paid tickets (web Elements, mobile PaymentSheet); see the QR and the exact address once holding a valid ticket; receive an inbox+push "Tickets confirmed", event-tomorrow reminder, cancellation/refund notices; transfer a ticket by email (mobile only) and accept/decline offers; view their upcoming ticketed events on mobile Home. A fan cannot: find any event, artist, or venue without a link; follow anything; set a city; open a venue page on mobile; deep-link from a ticket notification (L15); transfer from web (L21).

### B2. Discovery data available today without new backend work

**World-readable docs (firestore.rules):**
- profiles/{id} where status == 'approved' (rules:62): the whole ProfileDoc. Musicians: name, handle, subtype, portfolio { bio, genres[] (1-3 from GENRES), externalLinks, avatarPhotoPath, coverPhotoPath } (types.ts:132-138), publicBooking preferences only when marked public (types.ts:51), never rates. Curators: curator { about, lookingFor { genres, actSizes }, amenities, location { address (venues, public), city, neighborhood, geo }, photoPaths[], advertisingInterest } (types.ts:215-231). Members list is NOT public (rules:75); tracks are public only when approved and the profile is approved (rules:85-86). List queries must pin status == 'approved'.
- gigs/{id} where status in open, filled, or closed-with-bookedMusicianProfileId (rules:165-167): title, description, wants, budget (min/max/structure), startsAt, durationMinutes, provisions, location at public precision (GigPublicLocation types.ts:249-254: venueName, neighborhood, city, coarsened geo, address only when addressVisibility == public), curatorProfileId, seriesId, bookingId, bookedMusicianProfileId. List queries must pin status.
- events/{id} where status in published or completed (rules:258-259): EventDoc (types.ts:904-935): curatorProfileId, title, description, location (GigPublicLocation), startsAt, endsAt, posterPath, maxTicketsPerBuyer, lineup[] (booking acts carry musicianProfileId + name), lineupMusicianProfileIds[], gigId. events/{id}/tiers via parent status (rules:266-267): name, priceCents, capacity, soldCount, sale window. private/address only for ticket holders, members, admins.
- handles/{handle} single get (rules, near the end of the file); Storage public/tracks and public/photos objects (storage.rules:22-25).

**Composite indexes a fan list can use today (firestore.indexes.json):**
- gigs(status, startsAt) :39-43 -> "open gigs by date" (what /gigs already runs).
- events(status, startsAt) :189-193 -> "published events by date" (the missing fan feed query; index already exists, no client uses it yet).
- events(lineupMusicianProfileIds array-contains, status, startsAt) :200-205 -> "upcoming events for this artist" (used by /@handle).
- events(curatorProfileId, status, startsAt) :194-199 -> "upcoming events at this venue" (used by /@handle).
- gigs(curatorProfileId, status, startsAt) :17-22 -> a venue's open gigs.
- profiles has NO composite index; equality-only queries (type == musician, status == approved) merge single-field indexes, but adding array-contains on portfolio.genres or an orderBy would need a new index. tracks(status, order) exists for the artist page.

**NOT present (verified absent):** follows/favorites collections or rules; saved searches; alerts; a genre field on events (genres live only on profiles, gig wants, and curator lookingFor; GENRES is a fixed 22-value list at types.ts:182-186, GIG_TYPES at :188-190); city or geohash indexes on events (EventDoc.location.city exists but no (city, status, startsAt) index; geo is raw lat/lng with no geohash, so no proximity query); popularity signals (no play counts, view counts, follower counts, sales counts on the public doc; soldCount is per tier and readable, which is the only demand signal); denormalized upcoming-event counts on profiles; reverse linkage (profiles do not know their events; linkage is event -> artist via lineupMusicianProfileIds and event -> venue via curatorProfileId, both indexed); recommendations; any feed; users.homeCity is always null (L19); no analytics (L33).

### B3. What the docs say SP7 and SP8 own, with the fuzzy boundary

**SP7 (fan discovery) mentions:**
- foundation spec 2026-08-24:31: "7. Fan discovery: search, follow artists, performance notifications"
- foundation spec:15: "Fans buy tickets, discover events, and follow artists."
- foundation spec:113-114: "Public, no login: landing page, @handle profile pages, event pages (SEO surface). Logged-in fan: discover/tickets parity with mobile"
- foundation spec:138: "Triggers ship with their features: ... artist announcements (7)."
- foundation spec:170: out of scope for foundation "fan discovery (7)"
- plans/2026-08-24-foundation.md:2373: "Background web push ships with sub-project 7 (fan discovery), where fan-facing notifications actually matter."
- sp3 spec 2026-08-26-curator-gigs:119: "the fan-facing map UI (sub-7: SP3 only stores the geodata it needs)"; :128: "the map UI itself is sub-7"; :188: "map UI (7)"
- sp4 spec 2026-08-26-booking-flow:14: "fan map UI (sub-7)"
- events-ticketing spec 2026-08-30:361-363: "event discovery feeds and search (sub-7/sub-8: this sub-project links events only from venue pages, artist pages, and shareable URLs)"
- plans/2026-08-30-events-ticketing.md:471: "event route linked from tickets, notifications, and (later, sub-7) discovery"
- apps/mobile/app/_layout.tsx:82-84: "pushed from Home's upcoming list, the Tickets tab, and (later, sub-7) discovery"
- apps/mobile/app/(fan)/index.tsx:18-19: "sub-project 7 is what actually builds discovery, not this task"
- HANDOFF.md:39: "NEXT: 7 Fan discovery, then 8 Search. Deferred: 5c band payout splits."

**SP8 (search) mentions:**
- sp4 spec:14: "full search experience: sub-8 (user directive this brainstorm): text search, ranking, maps, saved searches/alerts replace the directories' query internals; the directory pages here are deliberately placeholder-grade"
- sp4 spec:26: "Discovery: two directories with basic filters ... Sub-8 replaces their internals."
- sp4 spec:80: "Discovery directories (placeholder-grade; sub-8 replaces internals)"
- sp4 spec:104: "Sub-8 (NEW): full search experience: replaces both directories' query internals (text search, ranking, maps, saved searches/alerts)."
- sp4-rulings.md:169-173: "Sub-8 (search): both directories ('Find gigs', 'Find musicians') are placeholder-grade by design: sub-8 replaces their query internals; also fold in: the musicians-page gate ... and the unused gigs (bookedMusicianProfileId, startsAt) index"
- sp5-rulings.md:336-337: "sub-8 (search): both directories still placeholder-grade (SP4 handoff)."
- README.md:242-246: "sub-project 8 (full search: text search, ranking, maps, saved searches/alerts) replaces both directories' query internals"; :267-268 "Sub-8 note"
- web-uiux spec 2026-08-28:315: "Venue-defined filterable chips are sub-8; only existing filters get restyled."; :343: "Map view of gigs (sub-8, geo data already present), ticket UI (sub-6), venue filter chips (sub-8)"
- apps/web/src/bookings/GigBrowse.tsx:49 and MusicianBrowse.tsx:20-21: "Placeholder-grade per spec section 1; sub-8 replaces the internals"

**Fan surfaces as coming-soon (both):**
- web-uiux spec:338-339: "Fan surfaces: fan home/search/tickets tabs get the shell and styled 'coming soon' states where features are future sub-projects"
- sp9a-rulings.md:58-59: "Spec 6.11 (fan surfaces) reconciled as empty for web: no fan routes exist on the web app"
- mobile-uiux spec 2026-08-29:168-170 and sp9b-rulings.md:167-169: fan index/search/tickets became branded coming-soon states
- README.md:774-775: "Coming-soon states: the fan tabs (discover, search, tickets)"

**Where the boundary is fuzzy (needs a ruling in the SP7 brainstorm):**
1. The fan Search tab. Foundation lists "search" inside sub-7; SP4 moved "full search experience" to sub-8. If SP7 leaves search.tsx coming-soon, a fan app ships with one dead tab out of four. Recommended split: SP7 owns "browse" (structured lists and filters over the existing indexed queries: upcoming events by date, artists by genre, venues); SP8 owns "search" (text index, ranking, saved searches, alerts, and the musician/curator directory rework).
2. The map. sp3/sp4 say the fan map is sub-7; the 9A spec says "Map view of gigs (sub-8)". Note the objects differ: sub-7's map was framed as fan-facing (events/venues), 9A's as the musician gig browse. Recommended: a fan event/venue map is SP7 if SP7 wants it at all (it needs geohash or client-side bounding, since no geo index exists); the musician gig-browse map is SP8.
3. "Event discovery feeds and search (sub-7/sub-8)" in the SP6 spec is joint by construction. Recommended: feed/list = SP7, search = SP8.
4. Alerts. sp4 spec puts "saved searches/alerts" in sub-8, but foundation puts "performance notifications" in sub-7. Recommended: follow-driven notifications (artist you follow announces a show) = SP7; query-driven alerts (new gigs matching a saved search) = SP8.
5. Web fan parity. Foundation promises "Logged-in fan: discover/tickets parity with mobile" on web; 9A reconciled web fan surfaces as empty. No later doc reassigns it. SP7 must decide whether the web fan home exists.

### B4. Messaging ownership

Unowned. Evidence: the foundation spec scoped musician-curator messaging into sub-4 (spec:17, :110 "Messages tabs are confirmed scope (musician-curator, built in sub-project 4)"); the SP4 spec then excluded it ("general messaging/chat (unscheduled)", sp4 spec:14) and shipped a terms-only thread ("terms only, no free chat", README.md:195-196; sp4 spec:19). Both mobile Messages tabs are still "Direct messages, coming soon." (apps/mobile/app/(musician)/messages.tsx:15, (curator)/messages.tsx:15); web has no Messages nav item at all (AppShell.tsx:88-91). No spec from SP5 onward mentions it. Fans explicitly do not get messaging (foundation spec:17). Recommendation: keep it out of SP7 (fan discovery) and SP8 (search); either create a dedicated sub-project or record it as a post-v1 phase in HANDOFF so the two dead tabs are a conscious decision. If it stays unbuilt through launch, the two tabs should be removed from the tab bars rather than shipped as coming-soon (a fan-facing app can carry one coming-soon tab; a professional-facing app carrying one is a trust cost).

### B5. Cross-cutting items no sub-project owns (status and proposed owner)

| item | status in code | proposed owner |
|---|---|---|
| Push notification sending | Mobile: Expo push via exp.host, best effort, 20-token cap, no receipts or pruning (functions/src/notifications.ts:9-24). Web: none (no service worker) | launch-checklist for hygiene; SP7 for web push (planned there, L07) |
| Email sending (receipts, transfer offers to non-users, verification resend) | None beyond Firebase Auth verification/reset. Receipts ruled out for v1 (events spec:354-355). offerTransfer to an unknown email silently creates nothing (anti-enumeration by design). No resend-verification UI although createProfileDraft requires email_verified | unowned; fix-now for resend |
| SEO / sitemap | OG + canonical on /@handle and /e/; no sitemap.ts/robots.ts; metadataBase needs NEXT_PUBLIC_SITE_URL | SP7 for sitemap of public pages; launch-checklist for the env var |
| Share links / deep links | app.json scheme "gatekeep" only; no associatedDomains/intentFilters (no universal links); no share affordance on event pages | SP7 |
| Analytics | None | unowned |
| Admin tooling for SP4-6 objects | SP4 (reliability, bookings per profile) and SP5 (adminAlerts, releaseStuckSaga) exist in /admin; nothing for events, orders, tickets, transfers, refunds | unowned |
| Legal pages | Placeholder text with a visible banner | launch-checklist (owner + counsel) |
| App Check enforcement | 0 enforceAppCheck; web init prod-only; mobile no client | launch-checklist (two-step) |
| EAS builds | projectId set; google-services files, GOOGLE_WEB_CLIENT_ID, dev build with expo-camera + stripe + phosphor pending | launch-checklist (owner) |
| Geocoder go-live | StubGeocoder until GEOCODER_PROVIDER=google + secret; parseGoogleResponse throws on city-less results | launch-checklist; fix-now for the throw |
| LAUNCH_TIMEZONE | "America/New_York" constant, types.ts:316 | launch-checklist |
| Calendar-monthly recurrence | +28d, scheduled.ts:52-57 | unowned |
| Per-venue timezone | no field anywhere | unowned (multi-metro) |
| resumeSeries | not built; pause one-way; pausedBy missing | unowned |
| Poster upload | pipeline accepts and processes, path never surfaced | fix-now before SP7 UI |
| 5c splits | marker at paymentsPayouts.ts:198 | 5c |

---

## C. Recommended SP7 scope boundary

### C1. SP7 must include (or SP7 is blocked or ships hollow)

1. **A published-events feed on both platforms**, backed by the existing events(status, startsAt) index (firestore.indexes.json:189-193) and the public read rule (firestore.rules:258-259). This is the first thing a fan expects and nothing today queries it. Mobile: replace the Discover coming-soon block (apps/mobile/app/(fan)/index.tsx:96-102). Web: a fan home route (foundation spec:113-114 promised parity), and make it the sign-in redirect target for profile-less accounts instead of the "No profiles yet" dashboard (SignInForm.tsx:77; dashboard/page.tsx:80-95).
2. **A public venue page on mobile** (L04). Without it a fan can open an artist but not the room the show is in.
3. **Poster path surfacing** (L18) as a prerequisite functions change, so the feed is not text-only cards. Small; do it first.
4. **Follows** (L05) and the **follow-driven notification trigger** (L06): foundation's definition of sub-7. Data model: a follows collection with owner-only reads, server-written or owner-written with a rule; a publishEvent hook that fans notifications out to followers of lineupMusicianProfileIds and curatorProfileId. Decide whether following a venue is in scope (the schema linkage supports both directions cheaply).
5. **Ticket notification deep links** (L15) and **ticket-to-event link on mobile** (L16), and **reschedule re-notify** (L17): fan notification correctness that SP7 will otherwise ship on top of.
6. **Share affordance on event pages plus universal/app links** (L31) so a shared /e/ URL opens the app on a phone that has it. The SP6 spec's whole distribution story is "shareable web links".
7. **A location story**: set users.homeCity (L19) or ask for device location, or scope v1 to the launch metro (LAUNCH_TIMEZONE already assumes one metro) and skip proximity entirely. Decide explicitly; "near you" copy is already shipped on the Discover tab.
8. **Decide the Search tab** (B3 item 1): at minimum a browse list with structured filters so the tab is not dead; text search stays SP8.
9. **Web fan home or an explicit ruling that web fans get only /tickets and /e/** (B3 item 5). Either answer is fine; silence is not.
10. **sitemap.ts/robots.ts** for /@handle and /e/ (L30) if SEO matters for launch; it is the cheapest discovery channel and README already earmarked it.

### C2. Push to SP8

- Text search, ranking, saved searches, query-driven alerts (L09).
- Directory rework: Find gigs / Find musicians internals, the musicians-page gate pin, the unused index decision (L10, L11, L12).
- Venue-defined filter chips (L13).
- Musician gig-browse map (L08, the 9A framing); a fan event map only if SP7 explicitly wants it and accepts building geohash or client-side bounding first.
- Any popularity or ranking signal, which needs analytics or aggregation that does not exist (L20, L33).

### C3. Unowned, needs an owner decision

- Messaging (L27): dedicated sub-project or post-v1; and remove the two coming-soon tabs if post-v1.
- Email (L29): receipts, transfer offers to non-users, verification resend (the last is a fix-now sized gap).
- Admin tooling for events/orders/tickets/transfers/refunds (L34).
- Analytics (L33).
- Web ticket transfers (L21) and web fan parity generally.
- resumeSeries (L46), calendar-monthly recurrence (L45), per-venue timezone (L43), UTC recurrence caveat (L44): four sub-projects have carried these. Either give them a "series v2" owner or mark them post-v1 in HANDOFF.
- Buyer-side order cancel and inventory hold time (L23); offline scan queue (L25).
- The A4 hardening list (L62-L80).

### C4. Fix-now before SP7 starts (small, mechanical)

L15 (ticket notification deep links), L18 (poster path), L24 (server gigId uniqueness on promote), L29 resend-verification button, L41 parseGoogleResponse no-city path, L56 seed em dashes, L57 README em dashes, L58 README payout-authority line, L39 README EAS projectId line.

### C5. 5c

Unchanged: admin-initiated member payout splits, marker at functions/src/paymentsPayouts.ts:198, needs its own brainstorm (multiple connected accounts per profile + split spec). Per the SP6 spec (:360-361) per-musician ticket revenue splits also belong here, not to SP7/SP8.

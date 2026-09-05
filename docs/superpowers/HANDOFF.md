# GateKeep: fresh-session handoff

Read this first in any new session or on a new machine. Last updated 2026-09-05, after the 5c and
11 merges. Update this file whenever a sub-project merges.

## What GateKeep is

A three-sided marketplace (musicians, event curators, fans) for one launch metro: hosted-audio
musician portfolios, gig booking with negotiation and escrowed payments, ticketing later.
Revenue from day one: an 11% curator booking fee and a 2% musician commission (Stripe Connect).
Stack: pnpm monorepo. apps/mobile (Expo SDK 57), apps/web (Next.js 16), functions (Firebase),
packages/shared (types, money math, message constants), tests-rules.

## Where the build stands

Done and merged (each has a rulings doc that is the authority for its area):
1. Foundation (`foundation-rulings.md`): accounts, group profiles, approval, admin, notifications.
2. Musician portfolios (`sp2-rulings.md`): hosted audio, track review, public artist pages.
3. Curators and gigs (`sp3-rulings.md`): venue profiles, gig posting, series.
4. Booking and messaging (`sp4-rulings.md`): apply/offer, negotiation, cancellation windows,
   reliability, privacy projections.
5. Payments (`sp5-rulings.md`): Stripe Connect escrow, deposits, T+3 settlement, dunning,
   payouts. 5b (`sp5b-rulings.md`): native mobile payment sheets.
9A. Web UI/UX redesign (`sp9a-rulings.md`): the "Ember, Deeper Night" design language, both
   themes, every web surface restyled. Repo-root `DESIGN.md` is now the BINDING brand contract.
9B. Mobile UI/UX redesign (`sp9b-rulings.md`): DESIGN.md carried to apps/mobile (token theme
   layer + owned src/ui primitives, Syne/Sora, Phosphor duotone), every screen restyled with
   branded skeleton/empty/error states, money-sentence colon parity restored. Pure presentation
   (touched only apps/mobile + lockfile + README); backend/shared/web gates unchanged by
   construction. NOT visually verified here (no dev client on this machine); owner EAS smoke owed.
6. Events and ticketing (`sp6-rulings.md`): curator-published events (standalone or promoted from
   a filled gig), paid/free multi-tier tickets on the sub-5 Stripe rails, QR door check-in, curator
   grace refunds, event cancel with full auto-refund, and in-app ticket transfers (mobile-only,
   email-targeted). Owner smoke owed: the sub-6 checklist in README, both web and mobile, both
   themes; the paid-ticket path needs real Stripe test keys, and the door scanner needs the new EAS
   dev build and is this sub-project's single highest on-device priority since it's entirely
   unverified off a real camera.
7. Fan discovery (`sp7-rulings.md`): a ranked discover deck and searchable lists on mobile, a
   filterable `/discover` grid on web, follow/unfollow on musician, curator, and genre targets, show
   posts from lineup members with anti-spam caps, and the notification fan-out tying it together
   (show announced, show rescheduled, a lineup post, new music from someone followed). A fixture
   script (`scripts/seed-test-discovery.ts`) gives the seeded test accounts a real followable track,
   a filled gig, and a booking-lineup event for the whole surface. Owner smoke owed: the sub-7
   checklist in README, both web and mobile, both themes; mobile needs a new EAS dev build
   (`expo-location` joined the native deps for the deck's distance sort) and is entirely unverified
   off device, same posture as sub-6's door scanner before it. The Discover-page marketing capture
   for the landing page's fan section is also still owed (it currently reuses artist-page.jpg).
8. Search (`sp8-rulings.md`): a server-only `searchIndex` collection maintained by triggers, a
   daily expiry step, and a `search` callable with three role faces (fan text search, musician Gigs
   | Venues, curator musicians directory) backing a web `/search` and the rewired `/gigs` and
   curator musicians pages, a Google Maps results map behind
   `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, saved searches with `saved_search_match` alerts, the SEO
   pack (sitemap, robots, JSON-LD, lowercase handle redirects), and the mobile twins (fan Search
   tab, musician Find Gigs, curator Find Musicians, a hidden saved-searches tab under Account,
   react-native-maps). `scripts/seed-test-discovery.ts`'s fixtures are indexed automatically by the
   same triggers, no separate search-seed step exists. Owner smoke owed: the sub-8 checklist in
   README, both platforms, both themes; a new EAS dev build for `react-native-maps`; the results
   map path is entirely unverified off device.

5c. Band payout splits (`sp5c-rulings.md`): admin-set member payout shares (`PayoutShare[]`,
   integer percents summing to 100) split each settlement through `distributeEarnings`, the ONLY
   path earnings reach a profile; held-share holding and release for a member not yet payout-ready;
   member Express accounts with their own onboarding, status, payouts, and webhook routing
   (`functions/src/memberPayouts.ts`); per-order ticket settlement (`ticket_settlement:{eventId}:
   {orderId}`, sourced from each order's own charge) replacing the old per-event transfer; and
   ledger-backed payout history. Both platforms gained a shares editor, a member "Your payouts"
   surface (`/dashboard#payouts`, `/(fan)/payouts`), and the `share_paid`/`share_held`/
   `share_released`/`member_payout_failed` notification kinds. Owner smoke owed: the sp5c
   checklist in README, both platforms; confirming the Connect webhook, `APP_ORIGIN` payout paths,
   the four new composite indexes, and a real Stripe test-mode smoke (README "Sub-project 5c
   launch checklist").

11. SP7 reconciliation (`sp11-rulings.md`): sharing and deep links (a Share button on both
   platforms, mobile-native `/e/` and `/u/` deep links, the web well-known handlers), web location
   plus the home-city fallback for Discover, the account editor (`updateAccount` writes
   `displayName`, `homeCity`, `homeGeo`), doors and age fields on events (badge, filter, JSON-LD),
   and consent-based artist tags on the lineup (tag, accept, decline, untag). Owner smoke owed: the
   sub-11 checklist in README, both platforms; the domain, the site-URL and well-known env values,
   and a new EAS build for associated domains and intent filters (README "Sub-project 11 launch
   checklist").

10. Hardening, branches A and B (`sp10b-rulings.md`): no new features. Branch A (merged
   2026-09-02 at `ee433d4`, plan `plans/2026-09-02-hardening-sweep.md`): every em dash removed
   repo-wide, Cloud Functions on Node 22 (`.nvmrc`), the `tickets.orderId` and `members.uid` index
   overrides repaired, `.claude/` local files ignored, and GitHub Actions CI
   (`.github/workflows/ci.yml`) running every gate plus an em-dash check on every push. Sub-project
   7 merged main after branch A and re-ran every gate under Node 22 before landing. Branch B (spec
   `specs/2026-09-02-hardening-design.md`, plan `plans/2026-09-02-hardening.md`) closed the audit's
   money, lifecycle, and copy defects: transfer sourcing, two Stripe webhook scopes, disputes, the
   settlement webhook race, events cancelled and refunded when a curator is unpublished, admin
   `takedownEvent`, deletion refusals with named blockers, auth `onDelete` cascade, push-token
   hygiene, fail-closed geocoder, poster upload, notification deep links, scanner offline panel,
   buyer order cancel with a five-minute expiry job, series end handling, and env-driven Firebase
   config. Owner smoke owed: the second Stripe endpoint and a simulated dispute, the new EAS dev
   build, then the 9A, 9B, 6, and 7 lists plus the sub-10 additions (table below, rows 48 to 59).

## Roadmap

- The SP7 reconciliation's five gaps (event sharing and deep links, web location story, fan
  account editor, event doorsAt and age fields, non-booking artist linkage) shipped in
  sub-project 11 (`sp11-rulings.md`).
- **Messaging**: general musician to curator chat beyond the terms-only booking thread.
  Unscheduled; the mobile Messages tabs stay coming-soon until it gets a number. Owner decision
  2026-09-04: Messaging plus the optional follow-ons (antislop #10 to #29, hardening rows L62 to
  L80) form the final sub-project.
- **Follow-on if wanted**: the accessibility and state-coverage findings (antislop #10 to #29)
  and the hardening ledger rows L62 to L80.
- Unscheduled by design: advertising, subscriptions, 2FA beyond Google-only admins, SMS, video
  hosting, guest checkout, seat maps, promo codes, resale.

**Audit context:** `docs/superpowers/audit-2026-09-01.md` is the whole-project audit run after
the 6 merge (19 blockers and near-blockers, per-area verdicts, the SP7 brief, and the
fix-before-SP7 list). The audit's SP7 brief has been reconciled against `sp7-rulings.md` and
sub-project 10B; the five remaining gaps (event sharing and deep links, web location story, fan
account editor, event doorsAt and age fields, non-booking artist linkage) are closed by
sub-project 11. Detail reports live in `docs/superpowers/audit/` and
`anti-slop/audit-001-2026-09-01.md`.

## Binding rules for ALL work

- `DESIGN.md` (repo root): tokens, fonts (Syne + Sora), radius tiers, accent dosage, glass cap.
- The antislop skills (`~/.claude/skills/antislop`, `-ui`, `-copywriting`): binding on UI and
  copy work. Install from `miqdadbadjuber/anti-slop` via `npx skills add` if missing.
- **No em dashes anywhere**: code, comments, copy, docs, commit messages. Enforced repo-wide by
  CI since sub-project 10 (2026-09): the workflow's last step fails on any U+2014 under
  `apps/**`, `functions/**`, `packages/**`, `tests-rules/**`, `scripts/**`, `docs/**`,
  `README.md`, `DESIGN.md`, and every rules file (DESIGN.md names the character instead of
  printing it).
- Two sweeps exist, so never write a bare "step N": always `dailySweep step N` (nine steps) or
  `paymentsSweep step N` (eleven steps). README lists both.
- Specs are binding over plans. Plans are historical execution records whose snippets may
  predate review fixes; code and the rulings doc win over both.
- Emulator suites run as one blocking foreground call (`pnpm emu:test` takes about ten minutes;
  use a 600000 ms timeout). A backgrounded run that then waits on itself stalls forever.
- `README.md` holds the env-var table, the launch checklists, and the smoke walkthroughs.
- Owner's AI-slop blocklist beyond the skills: no lucide icons, no Inter/Geist/Space Grotesk,
  no bento grids, no fake testimonials or invented numbers (the full list is in sp9a's spec).
- Each sub-project runs: brainstorm, spec, plan, subagent-driven execution with review gates,
  final whole-branch review, merge to main, rulings doc. Direct commits to main between
  sub-projects are fine for small fixes.

## Standing tripwires (read before touching the named area)

1. `resumeSeries` does not exist and pause is one-way. A resume must add `pausedBy` (`"curator"`
   or `"admin"`) and an approval gate so a curator cannot resume a series an admin paused; a
   naive resume is a Critical regression (`sp3-rulings.md` ruling 19).
2. Android `openBrowserAsync` resolves when the browser opens, not when it closes. Any
   in-app-browser flow must re-sync on app foreground and browser dismissal, never on the
   promise (`sp5b-rulings.md` ruling 4).
3. Stripe caches an idempotency key's response for 24 hours. A same-key retry replays the cached
   result, so a retry that must charge again needs an attempt-scoped key, and a
   grace-versus-cancel race can delay a buyer remainder up to a day (`sp5-rulings.md`,
   `sp6-rulings.md`).
4. Web RSC boundary: a server file never imports a VALUE from a `"use client"` module (types are
   fine). Verify every changed web route with a live page load, not only `next build`
   (`sp9a-rulings.md`).
5. `source_transaction` cap: Stripe (and FakeStripe) refuse a transfer sourced from a charge once
   the sourced transfers against that charge exceed its amount. `finalizeSettlementSuccess`
   sources only when `earnings <= chargeAmountCents` and records `sourced: false` otherwise; a
   new transfer path must make the same decision (`sp10b-rulings.md` ruling 5).
6. Two Stripe webhook scopes: "Your account" events verify with `STRIPE_WEBHOOK_SECRET`,
   "Connected accounts" events (`account.updated`, `payout.*`) with
   `STRIPE_CONNECT_WEBHOOK_SECRET`. An event whose scope does not match the secret that verified
   it is refused, so a new handler must be registered on the endpoint of the scope it belongs to
   (`sp10b-rulings.md` ruling 6).
7. `distributeEarnings` is the only way earnings reach a profile; a new settlement path must call
   it, never `transferToAccount` directly (`sp5c-rulings.md` ruling 1).
8. `isLinkableAct` (booking, or tagged and accepted) is the one predicate for treating a lineup
   act as a linked artist; a new consumer of `lineup` must use it, never `kind === "booking"`
   alone (`sp11-rulings.md` ruling 12).

## Dev environment quickstart

- `pnpm install`, then `pnpm --filter @gatekeep/web exec next typegen` (fresh checkouts fail
  web typecheck without it).
- Emulators need Java: prepend `C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` to PATH (this
  machine); any Java 11+ works. Set `FUNCTIONS_DISCOVERY_TIMEOUT=60` on Windows.
- Start: `pnpm emu` (UI :4000), then seed test accounts (wiped on every emulator restart):
  `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts`
- Two optional fixture scripts layer on top of the seeded accounts, same env vars, run after
  `seed-test-accounts.ts`: `pnpm tsx scripts/seed-test-event.ts` (one published standalone event
  for `/e/[eventId]` checks) and `pnpm tsx scripts/seed-test-discovery.ts` (also needs
  `FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199`; gives `@testmusician` an approved demo track,
  fills a gig and promotes it to a second published event with a real booking-kind lineup act, and
  follows `genre:rock` as test-fan, for the fan-discovery deck/list/follow smoke).
- Test logins (password `GateKeep-Test1` for all): test-fan@gatekeep.dev,
  test-musician@gatekeep.dev (approved @testmusician), test-curator@gatekeep.dev (approved
  @testvenue).
- Web: `pnpm --filter @gatekeep/web dev` (:3000). Both apps auto-connect to the emulators in
  dev, including from LAN devices. Mobile needs a dev-client build (see sp5b rulings).
- Gates before any merge: `pnpm typecheck` (5/5), shared tests (212), web tests (14), `pnpm emu:test`
  (936 across 58 files, single blocking call), `pnpm emu:rules` (140 across 9 files), web lint (0
  errors) + build, mobile lint (0 new warnings) + `expo export` bundles.
- Firebase dev project: `gatekeep-dev-jg`. Machine quirks: PS 5.1 corrupts UTF-8 pipelines
  (byte-safe tools only); hermesc.exe is App-Control-blocked (use `expo export --no-bytecode`
  locally; EAS cloud is unaffected). Node 22 is the functions runtime since sub-project 10
  (`.nvmrc`).

## Owner-owed (not code): the consolidated launch table

Consolidated from the docs audit (`docs/superpowers/audit/docs-consistency.md` section B, rows 1
to 47, verified against code on 2026-09-01) plus sub-project 10's additions (rows 48 to 59).
Blocking: Launch = before real traffic; Live = before the live-mode Stripe flip; Device = before
on-device testing; Runbook = a procedure, not a config; Optional = revisit on evidence. README
section names refer to the README as rewritten in sub-project 10.

| # | Item | Blocking | Where documented |
|---|---|---|---|
| 1 | Create the PROD Firebase project under the business Google account; keep `gatekeep-dev-jg` as DEV | Launch | `foundation-rulings.md` |
| 2 | Enable Email/Password, Google, Apple sign-in providers (dev and prod) | Launch | README "Manual follow-ups" |
| 3 | App Check: register web (reCAPTCHA v3 site key) and mobile (Play Integrity / App Attest); monitor mode until native mobile App Check ships; do not enforce Storage before it | Launch | README "Manual follow-ups" |
| 4 | App Check enforcement is two changes: the console flip plus `enforceAppCheck: true` per onCall in the same change (absent today), with the SSR exception documented | Launch | README "Manual follow-ups"; audit cross-cutting #6 |
| 5 | Never App-Check-enforce over `stripeWebhook` | Launch | README "Sub-project 5 launch checklist" |
| 6 | Set the real `GOOGLE_WEB_CLIENT_ID` (`apps/mobile/src/auth/config.ts` is a placeholder) | Device | README "Manual follow-ups" |
| 7 | Sentry projects, then `NEXT_PUBLIC_SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN` | Launch | README "Environment variables" |
| 8 | EAS: `eas login`, Firebase Android and iOS apps, `google-services.json` / `GoogleService-Info.plist` plus the keystore SHA-1, `googleServicesFile` in `app.json`; Apple Developer Program for store publication | Device | README "Manual follow-ups" |
| 9 | Verify `firebase deploy --only functions` resolves `workspace:*` for `@gatekeep/shared` | Launch | README "Manual follow-ups" |
| 10 | Confirm Email Enumeration Protection is on (dev and prod) | Launch | README "Manual follow-ups" |
| 11 | `staging/` 24h GCS lifecycle rule on the production bucket, kept as a versioned `lifecycle.json` (LAUNCH BLOCKER; the Storage emulator cannot test it) | Launch | README "Manual follow-ups"; `sp2-rulings.md` |
| 12 | `PUBLIC_PROFILE_HOST` real domain (the mobile "View public page" link stays hidden until then) | Launch | README "Manual follow-ups" |
| 13 | `NEXT_PUBLIC_SITE_URL` (canonical and OG base) | Launch | README "Environment variables" |
| 14 | `STORAGE_BUCKET` on the production functions deploy, plus the production `NEXT_PUBLIC_FIREBASE_*` and `EXPO_PUBLIC_FIREBASE_*` sets | Launch | README "Environment variables" |
| 15 | `GEOCODER_PROVIDER=google` and `firebase functions:secrets:set GEOCODER_API_KEY` (the geocoder fails closed without them since sub-project 10) | Launch | README "Sub-project 3 launch checklist" |
| 16 | Revisit the 50/day geocode budget constant if usage needs it | Optional | README "Sub-project 3 launch checklist" |
| 17 | After first deploy: the Cloud Scheduler jobs for `dailySweep`, `paymentsSweep`, and `ticketOrderExpiry` exist with `retryCount: 3` and sane next-run times | Launch | README "Gigs & series", "Payments" |
| 18 | Monitor `adminAlerts` (the sweeps' escalation queue) from day one | Runbook | README "Payments" |
| 19 | Confirm every composite index and field override in `firestore.indexes.json` shows Enabled after the first deploy (the emulator enforces none of them) | Launch | README launch checklists (3, 4, 5, 6) |
| 20 | Set `LAUNCH_TIMEZONE` to the launch metro (`packages/shared/src/types.ts` is `America/New_York`) | Launch | README "Sub-project 3 launch checklist" |
| 21 | UTC recurrence caveat: disclosure in the series forms, no fix pending | Informational | README "Sub-project 3 launch checklist" |
| 22 | Run `backfillDisplayNameLower` once after deploy | Launch | README "Sub-project 3 launch checklist" |
| 23 | Deploy the tightened rules and run `backfillBookingVisibility` in the SAME release (CRITICAL ordering) | Launch | README "Sub-project 4 launch checklist"; `sp4-rulings.md` ruling 3 |
| 24 | Device pass: Hermes ICU date formatting, nested events Stack headers, native Google and Apple sign-in on a dev-client build | Device | README "Sub-project 3 launch checklist" |
| 25 | Register both Stripe webhook endpoints ("Your account" and "Connected accounts") and set `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`; a fresh pair for live mode | Launch | README "Sub-project 5 launch checklist" |
| 26 | Firestore TTL policy on `stripeEvents.expireAt` | Launch | README "Sub-project 5 launch checklist" |
| 27 | `firebase functions:secrets:set STRIPE_SECRET_KEY`; `APP_ORIGIN` on functions; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` then REBUILD web | Launch | README "Stripe key setup" |
| 28 | Re-verify `RealStripe.debitConnectedAccount` (legacy `charges.create({source})`) against current Connect docs | Live | README "Sub-project 5 launch checklist" |
| 29 | Re-verify the 4% instant-payout retail fee against Stripe's current cost | Live | README "Sub-project 5 launch checklist" |
| 30 | Activate Stripe Connect under the business entity and swap live keys; never live under the personal entity | Live | README "Sub-project 5 launch checklist" |
| 31 | Manual real-test-mode smoke walkthrough steps 1 to 8 (web), with both endpoints attached | Launch | README "Manual smoke walkthrough" |
| 32 | Apple merchant id `merchant.app.gatekeep.mobile` and the Apple Pay certificate; Google Pay enabled in Stripe | Device | README "Sub-project 5b launch checklist" |
| 33 | `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS env var (and `apps/mobile/.env` locally) | Device | README "Sub-project 5b launch checklist" |
| 34 | New EAS dev-client build, both platforms (native deps changed in 5b, 9B, 6, and 10) | Device | README "Sub-project 5b launch checklist" |
| 35 | Mobile smoke walkthrough steps 9 to 15 (sheets, 3DS, past-due, wallets, onboarding, payouts, true-up) | Device | README "Manual smoke walkthrough" |
| 36 | 9A signed-in web visual smoke, both themes, full coverage list | Launch (hard gate) | `sp9a-rulings.md` |
| 37 | Eyeball `--gk-focus` light `#BF5038` and `--gk-on-destructive` white on `/design` | Launch | `sp9a-rulings.md` |
| 38 | Real concert photos into `apps/web/public/hero/` and `apps/web/src/marketing/heroImages.ts` | Launch | README "Sub-project 9A launch checklist" |
| 39 | Counsel review of the `/terms` and `/privacy` placeholder text | Launch | README "Sub-project 9A launch checklist" |
| 40 | Footer `CONTACT_EMAIL` (`hello@gatekeep.app`): own the mailbox or change it | Launch | README "Sub-project 9A launch checklist" |
| 41 | 9B mobile visual smoke on the next EAS build, both themes, coverage list | Device (hard gate) | README "Sub-project 9B smoke checklist" |
| 42 | Confirm the token PaymentSheet `appearance` on the owner's build | Device | `sp9b-rulings.md` |
| 43 | SP6 web smoke (create, promote, tiers, publish, public page, free RSVP, PAID with real test keys, wallet QR, attendees, grace refund, cancel), both themes | Launch | README "Sub-project 6 smoke checklist" |
| 44 | SP6 mobile smoke including the DOOR SCANNER on a real camera, a two-account transfer, tap check-in | Device (top priority) | README "Sub-project 6 smoke checklist" |
| 45 | Poster upload end to end on a device (shipped in sub-project 10; unverified on a real camera roll) | Device | README "Sub-project 6 launch checklist" |
| 46 | Content takedown two-step (unpublish, then `deleteProfile` for a scrub); the admin confirm dialog names both steps | Runbook | README "Manual follow-ups" |
| 47 | Seed the first admins (Google accounts) with `scripts/seed-admin.ts` against the prod project id | Launch | README "Scripts" |
| 48 | Register the second Stripe webhook endpoint ("Connected accounts") and set `STRIPE_CONNECT_WEBHOOK_SECRET`; re-run the README test-mode walkthrough with both endpoints | Launch | README "Sub-project 5 launch checklist" |
| 49 | Simulate a dispute with card 4000 0000 0000 0259 on a deposit and on a ticket order; confirm the alert, the delinquency flag, and the reversal on a lost outcome | Launch | README "Sub-project 5 launch checklist" |
| 50 | Stripe Radar default rules on; read the Connect dispute-liability setting | Live | README "Sub-project 5 launch checklist" |
| 51 | Decide the platform float for ticket settlement (or move to per-order sourced transfers in 5c) | Closed by 5c (per-order sourced ticket settlement) | README "Sub-project 5 launch checklist" |
| 52 | Enable 1099 delivery for Express accounts | Live | README "Sub-project 5 launch checklist" |
| 53 | Cloud Monitoring alert policies: function error rate, and a log-based metric on `adminAlerts` document creation | Launch | audit cross-cutting #15 |
| 54 | Firestore PITR on, a daily scheduled export bucket, and a GCP budget alert (the `ledger` has no off-Firestore copy otherwise) | Launch | audit cross-cutting #30 |
| 55 | Web security headers and a CSP in `apps/web/next.config.ts` | Launch | audit cross-cutting #20 |
| 56 | Mobile store-review permissions: drop the microphone permission (`expo-audio` plugin options) and add `iosUrlScheme` to the Google sign-in plugin in `apps/mobile/app.json` | Device | audit cross-cutting #19 |
| 57 | New EAS dev build (notification handler and poster picker changed native config): the 9A, 9B, 6, and 7 smoke lists, plus the admin Events block, the poster picker end to end, the verify-email banner and retry, the scanner offline panel, the buyer cancel, the notification deep links and push taps, the booking clarity screens (run notice, counterparty lines, grace notice), the portfolio visibility toggles, and the Find-musicians grids with a summary-only projection: all skipped as live checks during execution | Device | spec 10 section 11 |
| 58 | Deploy and confirm the new composite indexes `payments (musicianProfileId, settlement.status)` and `orders (buyerUid, status)`, and the repaired `tickets.orderId` and `members.uid` overrides, all show Enabled | Launch | spec 10 section 11 |
| 59 | Confirm the deployed functions run Node 22 (`firebase.json` runtime `nodejs22`) | Launch | `plans/2026-09-02-hardening-sweep.md` |
| 60 | Turn OFF the "Delete account" user action (Firebase Authentication settings / Identity Platform user actions) so self-service deletion goes through `deleteAccount`; until then the `account_deleted_unclean` alert is the backstop | Launch | README "Manual follow-ups" |
| 61 | Deploy and confirm the seven new composite indexes (5 `searchIndex`, 2 `savedSearches`) finish building after `firebase deploy --only firestore:indexes` | Launch | README "Sub-project 8 launch checklist" |
| 62 | Run `backfillSearchIndex` from `/admin` once after the first functions deploy | Launch | README "Sub-project 8 launch checklist" |
| 63 | `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` on the web host, Maps JavaScript API enabled, HTTP-referrer restricted | Launch (Optional if the map stays off) | README "Sub-project 8 launch checklist" |
| 64 | Replace the `app.json` Android Maps key placeholder (`REPLACE_WITH_ANDROID_MAPS_KEY`) with a key restricted by package name and signing certificate | Device | README "Sub-project 8 launch checklist" |
| 65 | New EAS dev build for `react-native-maps` | Device | README "Sub-project 8 launch checklist" |
| 66 | Confirm `LAUNCH_TIMEZONE` | Launch | README "Sub-project 8 launch checklist" |
| 67 | Confirm the Connect webhook endpoint delivers `account.updated`, `payout.paid`, and `payout.failed` for user-owned accounts (same endpoint, no new subscription) | Launch | README "Sub-project 5c launch checklist" |
| 68 | `APP_ORIGIN` covers `/dashboard/payouts/onboarding/return` and `/refresh` | Launch | README "Sub-project 5c launch checklist" |
| 69 | Deploy and confirm the four new composite indexes (`heldShares` by uid and status, by profileId and status; `ledger` by profileId and at, by uid and at) finish building after `firebase deploy --only firestore:indexes` | Launch | README "Sub-project 5c launch checklist" |
| 70 | Real Stripe test-mode smoke for 5c: onboard a member, set shares on a band, settle a booking and a ticketed event, watch the split legs and a held release, cash out as the member (standard and instant), report a no-show and confirm only the band's leg reverses | Launch | README "Sub-project 5c launch checklist" |
| 71 | Choose the production domain and replace `REPLACE_WITH_LINK_DOMAIN` in `app.json` | Device | README "Sub-project 11 launch checklist" |
| 72 | Set `NEXT_PUBLIC_SITE_URL` and `EXPO_PUBLIC_SITE_URL` | Launch | README "Sub-project 11 launch checklist" |
| 73 | Set the four well-known env values (`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256`) and verify both well-known URLs resolve | Launch | README "Sub-project 11 launch checklist" |
| 74 | New EAS build for associated domains and intent filters | Device | README "Sub-project 11 launch checklist" |
| 75 | Sub-11 device smoke: share from each screen, open a shared link cold and warm, tag an artist and accept from the other account, set a home city and confirm Discover ranks by it with location off, set doors and an age on an event and see the badge and the all-ages filter on both platforms | Device | README "Sub-project 11 launch checklist" |

# GateKeep

GateKeep connects musicians, event curators (venues, planners, hosts), and fans in a single
metro area: team-approved musician and curator profiles, gig booking with escrowed payments, fan
discovery, and fan ticketing, built on a shared Firebase backend behind default-deny Firestore
rules with every privileged write in Cloud Functions.

The repo spans eleven sub-projects, merged in this order: 1, 2, 3, 4, 5, 5b, 9A, 9B, 6, 7, 10.
Each merged sub-project has a rulings doc under `docs/superpowers/` that is the authority for its
area (the table under "Design docs" at the end lists them all), and `docs/superpowers/HANDOFF.md`
is the fresh-session entry point.

**Sub-project 1: Foundation.** Accounts (email, Google, Apple), group profiles with members and
admins, the draft, review, approve lifecycle, the admin approval dashboard, notification plumbing
(in-app inbox plus Expo push), and the mobile and web app shells.

**Sub-project 2: Musician portfolio.** Bio, photos, genres, links, up to ten 30-second reviewed
audio snippets with server-side trim and transcode, curator-gated booking rates and preferences,
and server-rendered public pages at `/@handle` on web with a native twin on mobile.

**Sub-project 3: Curator profiles and gig postings.** Venues, planners, and hosts get the same
wizard, photos, and public-page treatment; one-off and recurring gig postings with budget and
location privacy; the `dailySweep` scheduled job that materializes series and pays down earlier
cleanup debt; admin gig moderation and name search. See "Gigs & series" below.

**Sub-project 4: Booking flow.** Either side opens a booking (apply to an open gig, or offer a
gig directly), negotiates over a capped counter-offer thread, and accepting freezes the terms and
records a 35% deposit; cancellation windows, no-show reliability records, musician-controlled rate
visibility, and whole-run series booking. See "Booking flow" below.

**Sub-project 5: Payments.** Stripe Connect Express on the separate charges and transfers model:
the deposit is charged at accept, the remainder settles T+3 after each date ends, the musician's
share transfers to their connected account, a declined settlement duns and then flags the curator
delinquent, and profile admins cash out (standard or instant). **5b** carries the full action set
to mobile through the native PaymentSheet. See "Payments" below.

**Sub-project 9A: Web UI/UX.** The "Ember, Deeper Night" design language (repo-root `DESIGN.md`,
binding on all UI work), both themes, every web surface restyled. **9B** carries it to mobile: a
token theme layer, owned `apps/mobile/src/ui` primitives, every screen restyled with branded
loading, empty, and error states.

**Sub-project 6: Events and ticketing.** Curator-published events (standalone or promoted from a
filled gig), multi-tier paid and free tickets with a fan-paid service fee on the sub-project 5
rails, T+1 settlement to the curator, QR door check-in, grace refunds, cancel with full
auto-refund, and email-targeted in-app transfers (mobile only). See "Events and ticketing" below.

**Sub-project 7: Fan discovery.** Follows on musicians, curators, and genres; notifications for a
show announced, a lineup addition, a reschedule, and new approved music from someone followed;
short show posts from lineup musicians; a ranked discover deck and filterable list on mobile and a
filterable `/discover` grid on web. Web's grid ranks too as of sub-project 11, see
`sp11-rulings.md`. See the sub-project 7 checklists below.

**Sub-project 10: Hardening.** No new features. The whole-project audit's money, lifecycle, and
copy defects closed: transfer sourcing rules, two Stripe webhook scopes, dispute handling, the
settlement webhook race, events cancelled and refunded when their curator is unpublished, an admin
`takedownEvent`, deletion refusals with named blockers, an auth `onDelete` cascade, push-token
hygiene, a fail-closed geocoder, poster upload end to end, notification deep links, the door
scanner's offline panel, buyer order cancel with a five-minute expiry job, Node 22, CI, and the
repo-wide em-dash sweep that CI now enforces. Rulings: `docs/superpowers/sp10b-rulings.md`.

## Monorepo map

```
GateKeepBeta/
├── package.json                  # workspace root: typecheck, emu, emu:test, emu:rules scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict TS config
├── .nvmrc                        # Node 22 (sub-project 10)
├── .github/workflows/ci.yml      # every gate on every push and PR, then the em-dash grep (sub-project 10)
├── .github/dependabot.yml        # weekly npm updates for root, functions, apps/web, apps/mobile
├── firebase.json                 # emulators (auth, firestore, functions, storage :9199), functions runtime nodejs22
├── .firebaserc                   # default Firebase project id (gatekeep-dev-jg)
├── firestore.rules               # default-deny + narrow allows
├── firestore.indexes.json        # composite indexes + field overrides
├── storage.rules                 # staging/review/public paths
├── CLAUDE.md                     # session pointer to docs/superpowers/HANDOFF.md
├── DESIGN.md                     # binding brand contract for all UI work (sub-project 9A)
├── docs/superpowers/             # HANDOFF.md, specs/, plans/, one rulings doc per sub-project, audit/, mocks/
├── scripts/                      # seed-admin.ts, seed-test-accounts.ts, seed-test-event.ts, seed-test-discovery.ts (see Scripts)
├── packages/shared/              # @gatekeep/shared: the single source of truth for every cross-boundary shape
│   └── src/{types,validation,storagePaths,money,messages,paymentDisplay,feePreviews,discover,notificationHref,index}.ts
├── functions/                    # Cloud Functions: v2 callables, triggers, schedulers, one HTTPS webhook
│   ├── src/index.ts              # exports every function
│   ├── src/guards.ts             # requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile, requireCuratorProfile, requireApprovedCuratorProfile, requireApprovedMusicianProfile
│   ├── src/authTriggers.ts       # onUserCreated (users doc), onUserDocWritten, onUserDeleted (cascade, sub-project 10)
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview, deleteProfile (money and events gates, sub-project 10)
│   ├── src/review.ts             # reviewProfile (unpublish cascade, events included since sub-project 10), grantAdmin, audit log
│   ├── src/members.ts            # inviteMember, respondToInvite, revokeInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount, cascadeDeleteUser (sub-project 10)
│   ├── src/notifications.ts      # notifyUser (inbox + Expo push, token pruning), approval trigger
│   ├── src/portfolio.ts          # updatePortfolio, updateBookingInfo (sub-project 2)
│   ├── src/tracks.ts             # createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack (sub-project 2)
│   ├── src/media.ts              # processUpload: ffmpeg transcode, sharp resize, posterUploads docs (sub-projects 2, 3, 6, 10)
│   ├── src/curator.ts            # updateCuratorProfile, removeCuratorPhoto, syncCuratorAccess (sub-project 3)
│   ├── src/geocode.ts            # Stub and Google geocoders; fails closed outside the emulator (sub-projects 3, 10)
│   ├── src/gigs.ts               # createGig, publishGig, updateGig, cancelGig, takedownGig (sub-project 3)
│   ├── src/gigSeries.ts          # createSeries, updateSeries, pauseSeries, endSeries (sub-project 3)
│   ├── src/scheduled.ts          # runDailySweep + dailySweep, nine steps (sub-projects 3, 4, 6, 10)
│   ├── src/adminTools.ts         # searchUsersByName, backfillDisplayNameLower, flagAccount (sub-project 3)
│   ├── src/storage.ts            # bucket helper + STORAGE_BUCKET
│   ├── src/bookings.ts           # applyToGig, offerGig, counterBooking, declineBooking, withdrawBooking, acceptBooking (sub-project 4)
│   ├── src/bookingLifecycle.ts   # cancelBooking, cancelOccurrence, reportNoShow, removeReliabilityMark (sub-project 4)
│   ├── src/bookingVisibility.ts  # rebuildBookingProjections, backfillBookingVisibility (sub-project 4)
│   ├── src/stripeClient.ts       # RealStripe and FakeStripe, both secrets, both webhook signing secrets (sub-projects 5, 10)
│   ├── src/payments.ts           # createSetupIntent, refreshPaymentMethod, createOnboardingLink, getStripeStatus, releaseStuckSaga, confirmOccurrenceActuals, payPastDue (sub-project 5)
│   ├── src/paymentsCore.ts       # deposit saga, ledger, admin alerts (sub-project 5)
│   ├── src/paymentsSettlement.ts # settlement math, true-ups, finalizeSettlementSuccess (sub-project 5)
│   ├── src/paymentsSweep.ts      # runPaymentsSweep + paymentsSweep, eleven steps; ticketOrderExpiry (sub-projects 5, 6, 10)
│   ├── src/paymentsPayouts.ts    # requestPayout (profile admins only), payout webhooks (sub-project 5)
│   ├── src/paymentsWebhook.ts    # stripeWebhook: claim machine, handler registry (sub-projects 5, 6, 10)
│   ├── src/paymentsDisputes.ts   # charge.dispute.created/closed and charge.refunded handlers (sub-project 10)
│   ├── src/eventsCore.ts         # pure event and order helpers (sub-project 6)
│   ├── src/events.ts             # createEvent, updateEvent, setEventTiers, publishEvent, cancelEvent (sub-project 6)
│   ├── src/eventsAdmin.ts        # takedownEvent, kept apart from events.ts to avoid a review.ts import cycle (sub-project 10)
│   ├── src/ticketing.ts          # createTicketOrder, finalizeTicketOrder, cancelTicketOrder, refundTicket, checkInTicket, undoCheckIn, offerTransfer, respondToTransfer (sub-projects 6, 10)
│   ├── src/follows.ts            # followTarget, unfollowTarget, markGenrePickerSeen (sub-project 7)
│   ├── src/announce.ts           # fan-out note builders hooked into events.ts and tracks.ts (sub-project 7)
│   ├── src/discover.ts           # getDiscoverDeck (sub-project 7)
│   ├── src/discoverRank.ts       # pure ranking: genre overlap, follow boost, soonness, distance, seeded shuffle (sub-project 7)
│   ├── src/showPosts.ts          # createShowPost, removeShowPost (sub-project 7)
│   └── test/*.test.ts            # emulator integration tests (vitest)
├── apps/mobile/                  # Expo SDK 57 + expo-router
│   ├── app/(auth)/               # sign-in, sign-up; app/join.tsx is the wizard
│   ├── app/(fan)/                # index (upcoming events), search, tickets (QR wallet), account
│   ├── app/(musician)/           # dashboard, portfolio, gigs, bookings, messages, account
│   ├── app/(curator)/            # dashboard, events (gigs, series, event/[eventId], scan/[eventId]), bookings, musicians, messages, account
│   ├── app/artist/[handle].tsx   # native public artist page
│   ├── app/venue/[handle].tsx    # native public curator page (sub-project 7)
│   ├── app/booking/[bookingId].tsx, app/event/[eventId].tsx
│   └── src/{auth,shell,ui,theme,portfolio,curator,gigs,bookings,payments,events,tickets,discover,notifications,lib,types}/
├── apps/web/                     # Next.js 16 App Router
│   ├── app/u/[handle]/           # SSR public page, served as /@handle (rewrite in next.config.ts), plus shows/
│   ├── app/e/[eventId]/          # public event page + buy flow
│   ├── app/discover/             # signed-in Shows | Artists grid with filters (sub-project 7)
│   ├── app/join/, app/sign-in/   # onboarding wizard, auth
│   ├── app/dashboard/            # page.tsx (account, delete), portfolio/, curator/, bookings/, earnings/, events/
│   ├── app/tickets/, app/gigs/   # fan wallet, gig directory (placeholder-grade until sub-project 8)
│   ├── app/admin/                # claim-gated admin: review queue, gigs, events takedowns, alerts, show posts
│   ├── app/design/, app/terms/, app/privacy/
│   └── src/{auth,shell,ui,components,marketing,portfolio,curator,gigs,bookings,payments,events,discover,lib}/
└── tests-rules/                  # Firestore + Storage rules tests: rules, payments, events, discovery, storage, hardening
```

`packages/shared` owns every cross-boundary type, validation rule, money formula, and user-facing
message constant; functions and both apps import from it and nothing redefines a shape locally.
`functions` owns every privileged mutation. Apps own UI and only ever read Firestore directly or
call callables.

## Prerequisites

- **Node 22+** and **pnpm 9+** (repo pins `pnpm@11.23.0` via `packageManager`). If `pnpm` isn't on
  `PATH` yet on a machine without admin rights (Windows): `corepack enable --install-directory
  "$env:LOCALAPPDATA\Microsoft\WindowsApps"`.
- **`pnpm --filter @gatekeep/web exec next typegen`**, run once per fresh clone. It generates the
  global `PageProps`/`LayoutProps` types Next.js 16 needs; `apps/web` typecheck fails without it,
  and `pnpm install` does not run it for you.
- **Java (JRE/JDK) 11+ on `PATH`**, required by the Firebase Emulator Suite (Firestore emulator
  is a JVM process). Any Java 11+ install on `PATH` works; a portable Temurin JRE prepended
  per-command is the pattern used on the project's dev machines (past examples:
  `~\.jre\jdk-21…` and `~\.jdks\jdk-21…`). Example, used before every emulator command below:
  ```bash
  # bash
  export PATH="$HOME/.jdks/jdk-21.0.12+8-jre/bin:$PATH"
  ```
  ```powershell
  # PowerShell
  $env:PATH = "$env:USERPROFILE\.jdks\jdk-21.0.12+8-jre\bin;$env:PATH"
  ```
- **Xcode** (iOS) / **Android Studio** (Android) only if building native mobile targets locally;
  not required for web dev or emulator-only work.

## Key commands

```bash
pnpm install                          # install all workspaces (also builds @gatekeep/shared)
pnpm typecheck                        # tsc --noEmit across every workspace

pnpm emu                              # start the Firebase Emulator Suite (auth, firestore, functions, storage :9199, UI on :4000)
pnpm emu:test                         # build functions, then run functions/ integration tests against the emulator (incl. storage)
pnpm emu:rules                        # run tests-rules/ Firestore + Storage security-rules tests against the emulator

pnpm --filter @gatekeep/web dev       # Next.js dev server (apps/web)
npx expo start                        # from apps/mobile: Expo dev server (use a dev build, Expo Go
                                       # cannot do native Google/Apple sign-in)

pnpm --filter @gatekeep/web lint      # ESLint (apps/web)
pnpm --filter @gatekeep/shared test   # vitest for packages/shared (money math, validation, message constants)
pnpm --filter @gatekeep/mobile lint   # ESLint (apps/mobile), flat config at apps/mobile/eslint.config.js (tracked)
```

**Seed the emulator:** optional fixture scripts for UI/device testing, run against a live `pnpm emu`
session in this order (each depends on the previous one's accounts). Data is wiped on every
emulator restart, so re-run all three after each restart.

```bash
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
  pnpm tsx scripts/seed-test-accounts.ts
# creates the three test logins (password GateKeep-Test1): test-fan (no profile),
# test-musician (approved @testmusician), test-curator (approved @testvenue)

FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
  pnpm tsx scripts/seed-test-event.ts
# publishes one standalone event (a free tier + a paid tier) for /e/[eventId] checks

FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
  FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199 pnpm tsx scripts/seed-test-discovery.ts
# gives @testmusician an approved demo track, fills a gig and promotes it to a second
# published event with a real booking-lineup act, and follows genre:rock as test-fan
```

**Known issue:** the Expo **web** target (`expo start --web` / `apps/mobile` web output) is
currently broken (tslib/SSR interop error in `react-native-web`). Use native targets (iOS/Android
dev build) or the Next.js app (`apps/web`) for web.

**Troubleshooting, functions "not found" from the emulator:** `pnpm emu` (and `emu:test`/
`emu:rules`) can print `All emulators ready!` and still leave one or more functions unregistered
if the Functions emulator's discovery step, which has to `require()` every module under
`functions/src`, including the native `sharp`/`ffmpeg-static`/`ffprobe-static` dependencies added
in sub-project 2, takes longer than its default 30s window. The symptom is a working emulator UI
but calls to the affected callable(s) failing as if the function doesn't exist. This machine needs
the override; set it before any emulator command:

```bash
export FUNCTIONS_DISCOVERY_TIMEOUT=60      # bash, seconds; raises the 30s default
```

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT = "60"    # PowerShell
```

## Scripts

Four operator scripts live in `scripts/`, run with `pnpm tsx` from the repo root. `seed-admin.ts`
and `seed-test-accounts.ts` resolve which project they write to through the shared
`scripts/projectId.ts` (in order: a `--project` argument, then `GCLOUD_PROJECT`, then the
`project_id` inside the `GOOGLE_APPLICATION_CREDENTIALS` file, then `gatekeep-dev-jg` only when an
emulator host is set) and print the resolved project id before writing anything; anything else
refuses. `seed-test-event.ts` and `seed-test-discovery.ts` are emulator-only.

```bash
# The three test accounts (password GateKeep-Test1 for all): test-fan@gatekeep.dev (no profile),
# test-musician@gatekeep.dev (admin of the approved @testmusician), test-curator@gatekeep.dev
# (admin of the approved @testvenue). Idempotent. The emulator wipes them on every restart.
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts

# One published event (a free tier and a paid tier) owned by @testvenue; prints its /e/[eventId]
# URL (WEB_PORT overrides the port). Emulator only; run the accounts seed first. Every run
# creates another event.
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-event.ts

# Sub-project 7 fixtures on top of the accounts seed: an approved demo track for @testmusician, a
# second published event with a real booking-lineup act, and test-fan following genre:rock. Run
# the accounts seed first. Every run creates a fresh gig/booking/event set.
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
  FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199 pnpm tsx scripts/seed-test-discovery.ts

# Grant the admin claim to a Google sign-in account (refuses every other provider; see
# docs/superpowers/foundation-rulings.md).
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts someone@example.com
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json pnpm tsx scripts/seed-admin.ts someone@example.com
```

The `searchIndex` triggers index every seeded profile, gig, and event automatically, no separate
search-seed step is needed; the `/admin` "Rebuild search index" button only matters for data
seeded before the functions were running.

## Gigs & series (sub-project 3)

**Concepts.** A `gigs` doc is one dated posting (title, budget, wants, location, one of
`draft`/`open`/`closed`/`cancelled`/`taken_down`) that only an approved curator profile's members
can create, always via a callable (`createGig`/`updateGig`/`publishGig`/`cancelGig`), clients
never write `gigs` directly. A `gigSeries` doc is a recurring template (weekly/biweekly/monthly)
that the daily scheduled job (below) materializes into individual `gigs` occurrences up to 8 weeks
ahead; editing a series' template applies only to future, not-yet-detached occurrences, and any
occurrence can be edited independently (which detaches it from the template). Location privacy is
per-gig: non-venue gigs default to `addressVisibility: "neighborhood"` with a coarsened public
`geo`, while the exact address always lives in the callable/admin-only `gigs/{id}/private/location`
subdoc; venue-profile gigs default to `"public"` (full address shown). Budgets are stored as
integer `amountCents` under one of the three `BookingRates` structures (`perHour`/`perSong`/
`perSet`), never floating-point dollars.

**Key flows.** Curator onboarding is the same wizard/review pipeline as musicians (draft → submit
→ admin `reviewProfile` approve/reject), plus curator-specific required content (photos, location,
looking-for preferences) gating submission. Once approved, the curator dashboard's gig composer
posts one-off or series gigs; a public curator page at `/@handle` (web) / the native equivalent
(mobile) renders the curator's approved, `open` gigs at their public precision. Admins get a
**Gigs** section in `/admin` for moderation (status/subtype filters, takedown with an
occurrence-vs-series choice), plus name search (`searchUsersByName`) and account flags
(`flagAccount`) layered onto the existing profile review queue.

**The daily scheduled job** (`functions/src/scheduled.ts`'s `dailySweep`, wrapping the plain
`runDailySweep(now)` that tests call directly) runs once a day at 09:00 in `LAUNCH_TIMEZONE` with
`retryCount: 3` and does nine things in one pass. Naming convention, binding in every doc from
sub-project 10 on: two sweeps exist, so a bare "step N" is ambiguous. Always write
"dailySweep step N" or "paymentsSweep step N".

1. dailySweep step 1: materializes new occurrences for every `active` gigSeries up to the 8-week
   horizon, births them `filled` on a whole-run booking, and flips a series whose `endDate` has
   passed to `ended` in the same batch as its watermark (sub-project 10).
2. dailySweep step 2: closes `open` gigs whose `startsAt` has passed.
3. dailySweep step 3: fails abandoned `processing` tracks older than 24h and deletes
   `posterUploads` docs older than 24h (sub-project 10).
4. dailySweep step 4: revokes `pending` invites past their 14-day expiry.
5. dailySweep step 5: retries `curatorAccessRetries/{uid}` entries left by a failed
   `syncCuratorAccess`.
6. dailySweep step 6: expires `open` bookings whose target gig is gone or no longer open, skipping
   a booking flagged `depositChargePending` (sub-project 10).
7. dailySweep step 7: resolves `confirmed` bookings whose committed dates are all done to
   `completed`.
8. dailySweep step 8: reminds ticket holders of `published` events starting within 24h, titled
   "Tonight" or "Tomorrow" from the launch-zone calendar day.
9. dailySweep step 9: drains `eventCascadeRetries/{eventId}`, the retry queue for events the
   unpublish cascade could not cancel and refund on the first pass (sub-project 10).

**This only runs in production after `firebase deploy` provisions the Cloud Scheduler job**: the
emulator has no scheduler component, so `runDailySweep` is exercised directly by tests locally,
never on a timer. See the launch checklist below for the UTC-recurrence caveat that affects
exactly when a series' occurrences land.

Each step runs in its own try/catch with its own chunked batch writer: a poisoned doc in one step
(a malformed series, say) is logged and counted in `SweepReport.errors` and never prevents the
other steps from running, and a step's own writes are lost only if that step's own commit never
happens. Steps 1 and 3 to 5 page through their collections (100 series per page, 500 docs per
page for the rest) rather than issuing one unbounded `.get()`, and step 1 additionally skips (and
counts) a series whose profile is already at the `MAX_OPEN_GIGS_PER_PROFILE` cap, or whose status
changed between the initial scan and that series' write. `dailySweep`'s `onSchedule` options set
`timeoutSeconds: 540` and `memory: "512MiB"` to give this real headroom at scale.

## Booking flow (sub-project 4)

**Concepts.** A `bookings/{id}` top-level doc is the one record of a musician↔curator booking
relationship, created through either door, `applyToGig` (musician quotes on an `open` gig) or
`offerGig` (curator quotes to a musician), and mutated only via callables (clients never write
`bookings`). Both doors produce the same shape: an embedded `thread: OfferEntry[]` (capped at 50
entries) carries structured counter-offers (amount, expected quantity, ≤280-char note, **terms
only, no free chat**), with `awaitingSide` tracking whose turn it is; `counterBooking` appends and
flips the turn, `declineBooking`/`withdrawBooking` close it out. `acceptBooking` is the fill
transaction: it freezes the last thread entry into `acceptedTerms`, records a 35% deposit
(`computeDepositCents`, integer cents, `Math.ceil`) as **data** (`status: "unpaid"`, sub-5 wires
real money), flips the gig `open → filled` with `bookingId`/`bookedMusicianProfileId` linkage, and
auto-supersedes rival open bookings on the same gig. Cancellation windows are measured strictly
against gig start: curator cancels **< 72h** before start → deposit forfeits to the musician (≥72h
→ refunds); musician cancels **< 24h** before start → refunds the deposit but appends an automatic
`late_cancel` reliability mark. A curator can also `reportNoShow` after the fact (once per booking,
within 14 days), which appends a `reported_no_show` mark; admins can `removeReliabilityMark` on a
disputed mark (audit-preserving, the mark stays, just flagged `removedByAdmin`, never spliced).
Reliability is a curator-facing summary count only (`noShowCount`/`completedCount`), never public.

**Musician-controlled visibility** resolves sp3-rulings' M-12/M-13: booking rates are **never
public**, each rate structure (`perHour`/`perSong`/`perSet`) is independently `"curators"` or
`"private"`, and the preferences block is independently `"public"` or `"curators"`. The source of
truth (`profiles/{id}/private/booking`) now reads member/admin-only (curators lost their old
blanket read); `updateBookingInfo` and `bookingVisibility.ts`'s `rebuildBookingProjections` fan
each save out to two server-built projections in the same batch: `profiles/{id}/private/curatorBooking`
(rates with any `"private"`-marked structure nulled out, full preferences, the reliability summary:
**this projection is the curator-facing surface**, readable by curatorAccess holders + members +
admins) and `ProfileDoc.publicBooking` (the preferences object, only when `preferences: "public"`,
else `null`, rendered on the public portfolio page, rates never appear here regardless of
visibility). `profiles/{id}/private/reliability` stays member/admin-only.

**Whole-run booking** consumes sub-project 3's `fillMode`: a booking on a `whole_run` series'
occurrence carries that `seriesId`, and accepting it fills every currently-`open` occurrence plus
stamps the series (`activeBookingId`/`bookedMusicianProfileId`) so the daily sweep's materializer
births future occurrences pre-`filled` (skipping the open-gig cap for that committed work).
Deposits and cancellation windows are **per occurrence**, `cancelOccurrence` pulls one date off a
run without ending the booking; `cancelBooking`/`reportNoShow` on a whole-run booking evaluate only
against the run's next affected occurrence (one forfeiture / one mark max) and unwind future filled
dates back to `open`.

**Shows sections are now live**, the SP2 "platform events only" contract fulfilled: both public
portfolio pages (`/@handle`) query `filled`/booked-`closed` gigs by `bookedMusicianProfileId` (or
`curatorProfileId` for the curator's own page) and render upcoming/past bookings; the two Shows
queries are intentionally separate (`status=="filled"` vs `status=="closed" && bookedMusicianProfileId
!= null"`) because Firestore rules can only list-provably deny an unfiltered `status in [...]` read
that would leak an unbooked `closed` gig.

**`backfillBookingVisibility`** (admin-gated onCall, `functions/src/bookingVisibility.ts`) is a
one-shot migration alongside sub-project 3's `backfillDisplayNameLower` (see "Sub-project 4 launch
checklist" below for the deploy-ordering caveat that makes this one load-bearing, not just
convenience).

**Directories are placeholder-grade** (`apps/web/app/gigs/`, `apps/web/app/dashboard/curator/[profileId]/musicians/`,
and their mobile equivalents under `apps/mobile/src/bookings/`): plain Firestore queries + basic
client-side filters, by design, sub-project 8 (full search: text search, ranking, maps, saved
searches/alerts) replaces both directories' query internals; nothing here should be treated as the
long-term shape.

**Sub-5 handoff (settlement inputs this sub-project produces, doesn't consume).** `BookingDeposit.status`
is `"unpaid"` today; sub-5 adds `"held" | "refunded" | "forfeited"` and wires the state machine to
real money. Settlement math starts from the frozen `acceptedTerms` (`amountCents`,
`expectedQuantity`, `expectedTotalCents`), sub-5 recomputes overtime for `perHour` and a
count-true-up for `perSong` from that snapshot, per occurrence for whole-run bookings.
`occurrenceCancellations` (whole-run per-date cancellation records, capped at
`MAX_OCCURRENCE_CANCELLATIONS`=100) are themselves settlement inputs, a full 100-entry array is a
**tripwire** sub-5 must alarm on, not silently drop-oldest (unacceptable for money-adjacent
records, unlike the sweep's own drop-oldest reliability-mark idiom). A booking-linked gig that
ends up `taken_down` (an admin pulled that one date off a still-confirmed whole-run booking, per
`gigs.ts`'s `takedownGig` occurrence scope) settles as **not performed**, the completion sweep
(step 7) deliberately excludes it from the "filled linked occurrence" set it uses to decide
completion, and that same **filled-linked-gigs set is the intended per-occurrence settlement
basis** for sub-5 to walk. A booking that resolves to `expired` with a non-null `deposit` (gig/series
takedown or profile-reject cascades, i.e. moderation, nobody's fault) reads as a **refund**, no
forfeiture either way. When a deposit does forfeit, it goes to the **musician**
(`deposit.forfeitedTo: "musician"`), whether the platform carves out a fee from that forfeiture is
explicitly left as sub-5's decision, not decided here.

**Sub-8 note:** both discovery directories above are placeholder-grade by design; sub-8 replaces
their internals wholesale (see "Directories are placeholder-grade" above).

**Scale/hardening follow-ups recorded for later sweeps of this code** (none block v1, all
identified during Task 8/13's review rounds):
- **Materializer birth-decision race**: a `cancelBooking` landing between the sweep's step-1
  per-series read and that step's end-of-step commit can yield `filled` gigs linked to a
  non-`confirmed` booking, with no reconciling sweep step today, accepted at v1 given the low
  probability of hitting exactly that daily-sweep window; fix menu for whoever revisits it: a
  filled-linkage sanity-check step, or per-series batches guarded by a `lastUpdateTime`
  precondition.
- **Sweep step 6 (booking expiry)** reads each `open` booking's gig with a separate `get()`;
  batching those reads via `db.getAll()` per page would cut round-trips at scale.
- **`inviteMember`/`respondToInvite` guard gaps**: RESOLVED in sub-project 5 (Task 3). Both carry
  `isValidDocId` guards and `requireVerifiedEmail` (`functions/src/members.ts`), and sub-project 10
  added the trimmed, lowercased email plus the duplicate-pending-invite and existing-member
  refusals (uniform response) to `inviteMember`.
- **`functions/test/` helper duplication**: `bookings.test.ts`, `bookingLifecycle.test.ts`, and
  `scheduled.test.ts` each carry their own near-identical copies of `makeApprovedCuratorProfile`/
  `makeApprovedMusicianProfile`/`createOpenGig`/`gigContent`/`offerPayload`/`pollNotifications`/
  `seedSeries` rather than sharing them from `functions/test/helpers.ts`, worth consolidating the
  next time one of those files is touched.

## Payments (sub-project 5)

**Architecture.** A full **Stripe Connect Express marketplace** on the "separate charges &
transfers" model. The platform account is the escrow: a curator's card is charged into it, and the
musician's share is transferred out to their connected account afterwards, because a deposit's
fate (apply / refund / forfeit) is unknown at charge time. Every Stripe mutation is server-side
(callables, the webhook, and the hourly `paymentsSweep`); **clients never write money data**, and
no client-supplied amount ever drives what is charged. USD only. **Stripe test mode throughout**,
live mode is a secrets swap plus Connect activation, never a code change.

**Fees** (`packages/shared/src/types.ts`, snapshotted per booking as `feePolicy` at accept so a
later constant change never re-prices a live booking):

| Fee | Rate | Who pays |
|---|---|---|
| Curator service fee | **+11%** on top of every charge | curator (deposit and settlement each carry their proportional share) |
| Musician commission | **−2%** of everything transferred as earnings | musician |
| Instant cash-out | **-4%** of the payout (min $1), on cash-outs of **$10.00 or more** (`INSTANT_PAYOUT_MIN_CENTS`) | musician; standard payouts are free (1 to 3 business days) and have no minimum |
| Late fee | one-time **10%** of the outstanding settlement | curator, when the settlement goes delinquent, split **7 points to the musician, 3 to the platform** |

Integer cents everywhere: fees charged to the curator round **up** (`Math.ceil`), shares paid out
round **down** (`Math.floor`), remainders go to the platform. Worked example on a $1,000 gig,
curator pays $1,110 all-in ($388.50 at accept, $721.50 at settlement); musician receives $980;
platform keeps $130.

**Deposit machine.** SP4's 35% deposit stops being data and starts being money: `acceptBooking`
charges it off-session against the curator's saved card inside a two-transaction saga (stage →
charge → commit), and `DepositStatus` runs `unpaid → held → applied` with `refund_pending`/
`forfeit_pending` as the transactional intent-to-move-money written in the same transaction as a
cancellation, so a crash before the money moves always leaves a doc the sweep can find and finish.
Curator cancels < 72h before start → the deposit **forfeits to the musician at 100% of the base**
(no commission on forfeits); ≥72h, musician cancels, expiry, and admin unwinds → **refund
including the curator's fee share** (we eat Stripe's processing cost). A **1-hour grace period
after accept** (capped at gig start) lets either side back out penalty-free. Whole-run bookings get
one payment doc per occurrence; dates materialized onto an already-booked run are charged
individually by the sweep ("birth deposits").

**Settlement (T+3).** Three days after each occurrence *ends*, the remaining 65% + its fee share is
auto-charged off-session and the musician's 98% is transferred to their connected account. The
curator may `confirmOccurrenceActuals` (a "true-up": extra minutes for `perHour`, extra songs for
`perSong`, increase-only, and the window closes the moment a charge starts). `selfDeal` bookings
settle normally **with full fees** (paying real fees to move your own money removes any farming
incentive). A booking-linked `taken_down` date settles as not-performed.

**Dunning.** A declined settlement retries at **+1d, +2d, +2d**; when that schedule is exhausted the
occurrence goes `past_due`, the 10% late fee is added (7 points to the musician), and the curator's
profile is flagged **delinquent**, which gates it out of sending offers or accepting applications
until it clears. `payPastDue` mints an on-session PaymentIntent so the curator can clear the debt
with 3DS/SCA in the browser; an exhausted **deposit** retry schedule is the second, separate debt
shape it handles (no late fee ever applies to a deposit). Both clients surface these states per
occurrence.

**Payouts.** Musicians onboard through a Stripe-hosted Express flow (`createOnboardingLink`) and
cash out from the Earnings page on either platform: standard (free, 1 to 3 business days) or
instant (4%, min $1, debit-card-backed accounts only, and only for $10.00 or more; below that the
callable refuses with `PAYOUT_INSTANT_MIN_MESSAGE`). **Payout authority is profile admins only**:
`createOnboardingLink` and `requestPayout` call `requireProfileAdmin` (sub-project 5 security
ruling H2, `docs/superpowers/sp5-rulings.md` ruling 7), because onboarding sets the bank
destination and a payout drains the balance. Members see balance and status through
`getStripeStatus`; on mobile they see the buttons and receive the server's refusal.

**Gates.** A curator needs a saved card before sending an offer or accepting an application; a
musician must be payout-ready before applying to a gig or having a booking accepted. Both are
enforced server-side, mirrored in the UI as inline prompts keyed off exact message constants
(`packages/shared/src/messages.ts`, the single source of truth for every string a client branches
on).

**Surfaces.** Web is the full experience: `apps/web/src/payments/` (save-card modal, onboarding,
the booking `PaymentsPanel` with true-ups and pay-past-due, the `EarningsPanel` with cash-out, the
delinquency banner). **Mobile now carries the full action set natively** (`apps/mobile/src/payments/`):
a native `PaymentSheet` (cards + Apple Pay + Google Pay) drives both save-card
(`SaveCardSheet.tsx`) and pay-past-due (`PayPastDueButton.tsx`); musician onboarding opens Stripe's
hosted Express flow in an in-app browser and re-syncs status by re-polling `getStripeStatus` when
the browser is dismissed or the app re-foregrounds; `EarningsPanel.tsx` adds cash-out
(standard/instant with a live fee preview) and a `TrueUpForm.tsx`; `GatePrompt.tsx` surfaces the
apply/offer/accept gates; a `DelinquencyBanner.tsx` sits on the curator dashboard; and the booking
payment panel manages the card on file. Row-state mapping and fee previews are single-sourced with
web through `@gatekeep/shared` (`paymentDisplay.ts`, `feePreviews.ts`, `StripeStatusResult` is
shared too), so a date or a fee never reads differently on the two platforms. Stripe-hosted
onboarding still returns to the **web** pages by design, the return/refresh URLs are server-built
`APP_ORIGIN` pages, never client-supplied, so neither client can forge one and fail the gate open;
mobile has no return page of its own and relies on the re-poll described above instead. With no
`EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` set, all of this runs **keyless**: the native sheets are
skipped and the emulator loop works with zero Stripe keys.

**Data & boundaries.** `bookings/{id}/payments/{gigId}` (one doc per occurrence, the money truth for
that date) reads to both sides' members + admins and is server-write only;
`profiles/{id}/private/stripe` (payment identity + cached gate flags) is member/admin only and is
**not** a curator-shopping surface (a `curatorAccess` marker grants nothing here);
`stripeEvents` (webhook idempotency), `ledger` (append-only money audit) and `adminAlerts` (the
sweep's escalation queue) are **admin-read, server-write**; `stripeFake/**` (the emulator's fake
Stripe state) is unreachable for everyone. `tests-rules/payments.rules.test.ts` proves the full
matrix.

**The webhook is the codebase's only non-callable HTTPS entry point** (`stripeWebhook`), signature
verified, idempotent via `stripeEvents/{eventId}` claim documents, and App-Check-exempt by nature.
It is also the recovery path for a charge Stripe leaves `processing`: a same-key retry is impossible
(Stripe replays the cached response), so the caller persists the intent id and lets
`payment_intent.succeeded` finalize.

**`paymentsSweep`** runs hourly (`retryCount: 3`) and owns everything time-based. Its eleven
steps, in run order (`functions/src/paymentsSweep.ts`, the `steps` array at the bottom of the
file; the name in parentheses is the step's key in the sweep report):

1. paymentsSweep step 1 (`reconcile`): finishes or unstages accept sagas left flagged
   `depositChargePending`.
2. paymentsSweep step 2 (`pendingDeposits`): completes `refund_pending` and `forfeit_pending`
   deposits whose post-commit executor never ran.
3. paymentsSweep step 3 (`birthDeposits`): charges the deposit for occurrences the materializer
   birthed onto an already-booked run.
4. paymentsSweep step 4 (`dueOccurrences`): schedules the settlement for each occurrence that has
   ended, or waives it when the linkage broke (taken down, reopened, re-owned, gig gone).
5. paymentsSweep step 5 (`chargeSettlements`): charges due `pending` settlements off-session and
   transfers the musician's share (sourced from the charge only when it fits; see
   `sp10b-rulings.md`).
6. paymentsSweep step 6 (`retrySettlements`): runs the +1d, +2d, +2d dunning schedule on
   `past_due` settlements, then adds the late fee and declares the curator delinquent.
7. paymentsSweep step 7 (`expiredRefunds`): refunds future-dated deposits off bookings that
   resolved to `expired` (moderation cascades).
8. paymentsSweep step 8 (`ticketOrderExpiry`): expires stale pending ticket orders and releases
   inventory; completes an order whose intent already succeeded, and raises a
   `ticket_order_stuck` alert after two hours (sub-project 10). The same function runs alone every
   five minutes as the `ticketOrderExpiry` scheduler; the hourly run is the backstop.
9. paymentsSweep step 9 (`cancelledEventRefunds`): retries refunds a cancelled event could not
   complete.
10. paymentsSweep step 10 (`ticketSettlement`): transfers face value to the curator T+1 after
    `endsAt`, claiming the event with `settlementClaimedAt` before the transfer and stamping
    `settlementStartedAt` only after it succeeds (sub-project 10). Sub-project 5c replaced the
    single un-sourced per-event transfer with one sourced transfer per paid order
    (`ticket_settlement:{eventId}:{orderId}`, sourced from that order's own charge); see
    `sp5c-rulings.md`.
11. paymentsSweep step 11 (`ticketTransferExpiry`): expires ticket transfer offers past their 24h
    TTL.

Every step is isolated (a step-level and a per-doc try/catch), and states the sweep refuses to act
on are escalated into `adminAlerts` for a human (`releaseStuckSaga` is the admin callable that
resolves one).

**Not in sub-project 5** (and still open): tax forms beyond the Connect 1099 delivery setting,
statements and exports, multi-currency, and platform payout accounting. Dispute handling landed in
sub-project 10 (`charge.dispute.created`, `charge.dispute.closed`, `charge.refunded` in
`functions/src/paymentsWebhook.ts`): an open dispute writes a ledger row and an `adminAlert`,
flags a curator delinquent for a booking charge or stamps `disputeStatus: "open"` on a ticket
order, and `disputes/{disputeId}` (admin-read) holds the resolution state; a lost dispute reverses
the matching transfer; a won one clears the gate; evidence submission stays manual in the Stripe
dashboard. Live-mode activation is an owner launch item.

## Events and ticketing (sub-project 6)

**Concepts.** An `events/{eventId}` doc is a curator-published show, standalone or promoted from a
`filled` gig (at most one event per `gigId`; a second promotion is refused with
`GIG_ALREADY_PROMOTED_MESSAGE`), with `status` in `draft`, `published`, `completed`, `cancelled`,
a lineup of booking acts, external names, or (as of sub-project 11) tagged artists, a
public-precision location, and an optional poster. A booking act is verified server-side
(`verifyLineupBookingActs`): the booking must exist, belong to the calling curator, match the
musician, and be `confirmed`, so a curator cannot fabricate an association on a musician's public
page. A tagged act works the same way in spirit but through consent instead of a booking; see
`sp11-rulings.md`. Tiers live at `events/{eventId}/tiers/{tierId}`
(`priceCents`, `capacity`, server-maintained `soldCount`, an optional sale window); inventory truth
is a transactional `soldCount <= capacity` check, and after publish a capacity can only go up.
Orders (`orders/{orderId}`), tickets (`users/{uid}/tickets/{ticketId}`), the attendee projection
(`events/{eventId}/attendees/{ticketId}`), transfers, and `users/{uid}/ticketIndex/{eventId}` (the
valid-ticket proof the address gate and the buyer cap read) are all server-written. Clients never
write any of them; every event mutation is a callable (`createEvent`, `updateEvent`,
`setEventTiers`, `publishEvent`, `cancelEvent`, and the admin `takedownEvent`). Published and
completed events are publicly readable; an event past its start cannot be edited; the exact
address reveals only to a valid ticket holder.

**Money.** The fan pays a service fee on top of face value, per ticket
`min(round(price * 7%) + 99c, 399c)`, zero on free tickets, snapshotted per order as `feePolicy`
so a later tuning never rewrites history. Checkout (`createTicketOrder`) holds inventory in a
10-minute pending order, capped at eight tickets per buyer per event (held tickets plus other
pending orders) and three pending orders per buyer across events; the buyer can
`cancelTicketOrder`, and `ticketOrderExpiry` reclaims the rest every five minutes. The
PaymentIntent carries `metadata.purpose: "tickets"` and the buyer's `receipt_email`, and either
`finalizeTicketOrder` or the `payment_intent.succeeded` webhook completes the order exactly once
and mints the tickets. Both checkouts show, above Pay: "All sales are final unless the event is
cancelled or the organizer refunds you. Service fee included in the total." The curator receives
100% of face value of paid, non-refunded tickets, transferred T+1 after `endsAt` (paymentsSweep
step 10, idempotency key `ticket_settlement:{eventId}`, ledger id `ticket_settlement:{transferId}`),
and only while the curator profile is `approved`. Curator grace refunds (`refundTicket`, per
ticket, fee included) close at `endsAt`, which freezes the settlement basis a full day before any
transfer. Cancelling an event (curator `cancelEvent`, admin `takedownEvent`, or the unpublish
cascade when an approved curator is rejected) refunds every paid order in full, fee included, and
notifies holders; `cancelEventCore` refuses once settlement has started or been freshly claimed. A
lost dispute on a ticket charge reverses that order's face value out of the event's settlement
transfer, or reduces the pending basis when the event has not settled.

**Door.** A ticket's QR is possession of a server-minted `qrSecret` (payload
`{ticketId, eventId, qrSecret}`) compared `===` against the live ticket doc; a transfer mints a
fresh secret, so old QRs die at the scanner. `checkInTicket` requires membership of the event's
profile, opens 12 hours before `startsAt` (`CHECK_IN_TOO_EARLY_MESSAGE`), and has a name-list
fallback (`override: true`); `undoCheckIn` reverts one. The mobile scanner branches on the
callable's error code: `failed-precondition`, `not-found`, and `permission-denied` are ticket
verdicts; anything else renders a neutral "Couldn't reach GateKeep. Try again." panel that stays
until tapped.

**Transfers.** Email-targeted only (handles denote group profiles, not people) and mobile only.
`offerTransfer` always answers "If that account exists, the ticket offer is on its way." (no
account enumeration), offers expire after 24h, and the recipient's buyer cap is re-checked on
accept.

**Surfaces.** Web: the public SSR page `/e/[eventId]` with the Elements buy flow and the poster as
its OG image, Upcoming Events on `/@handle`, curator management under `/dashboard/events` (tiers,
poster, publish, cancel, attendee list with grace refunds and undo check-in), and the fan wallet at
`/tickets`. Mobile: the fan event screen with the PaymentSheet, the Tickets tab (QR wallet,
address reveal, transfers, incoming offers), curator management with the poster picker, and the
expo-camera door scanner. Ticket notifications deep-link to the wallet on both platforms
(`notificationHref` in `packages/shared`).

**Data and boundaries.** `tests-rules/events.rules.test.ts` proves the matrix: every client write
to these collections is denied; `orders` read to the buyer and the curator's members; `tickets`
to their owner; `attendees` to the event's curator members; `transfers` to either party.
`tests-rules/hardening.rules.test.ts` proves the sub-project 10 additions:
`posterUploads/{uid}/uploads/{nonce}` to its owner, `disputes` to admins, `eventCascadeRetries` to
nobody (server-only, not even admin reads).

## Environment variables

None are required for local development against the emulators, everything below is unset (empty
string / no-op) by default and only matters for a production deploy.

| Variable | App | Purpose | Default when unset |
|---|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | web | reCAPTCHA v3 site key for Firebase App Check | App Check init skipped |
| `NEXT_PUBLIC_SENTRY_DSN` | web | Sentry DSN for crash/error reporting | Sentry init skipped (no-op) |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile | Sentry DSN for crash/error reporting | `Sentry.init` runs with an empty DSN and is a no-op |
| `NEXT_PUBLIC_SITE_URL` | web | absolute base URL for the public portfolio page's canonical link + OpenGraph `og:url`/images (`apps/web/app/layout.tsx`'s `metadataBase`); the web Share button's `/e/`/`/u/` links are built from it too | falls back to Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` if present; if neither is set, `metadataBase` is omitted and those URLs render relative instead of absolute (never a hardcoded localhost fallback) |
| `EXPO_PUBLIC_SITE_URL` | mobile | the web origin mobile Share links are built from (`/e/{id}`, `/u/{handle}`) | the Share button is hidden on every screen |
| `APPLE_TEAM_ID` | web (server only, never `NEXT_PUBLIC`) | read at request time by the deep-link verification route that serves `/.well-known/apple-app-site-association` | the file 404s while any of the pair is unset |
| `IOS_BUNDLE_ID` | web (server only, never `NEXT_PUBLIC`) | read at request time by the same route, paired with `APPLE_TEAM_ID` | the file 404s while any of the pair is unset |
| `ANDROID_PACKAGE` | web (server only, never `NEXT_PUBLIC`) | read at request time by the deep-link verification route that serves `/.well-known/assetlinks.json` | the file 404s while any of the pair is unset |
| `ANDROID_CERT_SHA256` | web (server only, never `NEXT_PUBLIC`) | read at request time by the same route, paired with `ANDROID_PACKAGE` | the file 404s while any of the pair is unset |
| `GEOCODER_PROVIDER` | functions | set to `google` to geocode gig/curator addresses via the real Google Geocoding API (`functions/src/geocode.ts`'s `getGeocoder()`) | unset/any other value → `StubGeocoder`, a deterministic dev/test-only hash-based geocoder with a US-centric bounding box, **launch item**, see checklist below |
| `GEOCODER_API_KEY` | functions | Google Geocoding API key; required (throws at call time) when `GEOCODER_PROVIDER=google` | n/a while `GEOCODER_PROVIDER` is unset |
| `STRIPE_SECRET_KEY` | functions | Stripe secret key (`sk_test_…` / `sk_live_…`), a `defineSecret()` param, its presence is what selects the REAL Stripe client | unset → `FakeStripe`, but **only inside the emulator**; a deployed function without it throws rather than moving fake money (`functions/src/stripeClient.ts`'s `getStripe()` fails closed) |
| `STRIPE_WEBHOOK_SECRET` | functions | signing secret of the first Stripe endpoint ("Your account" scope), a `defineSecret()` param declared on `stripeWebhook`; every request is verified against it first, then against the Connect secret | outside the emulator a missing secret is a **500** from `stripeWebhook` ("webhook misconfigured", `StripeWebhookSecretMissingError` in `functions/src/stripeClient.ts`), never a signature check against an empty string; Stripe retries a 500, so a genuine delivery is not lost once the secret lands. Inside the emulator FakeStripe's webhook calls are same-process and need no secret |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | Stripe publishable key (`pk_test_…` / `pk_live_…`) for Stripe.js, **public, not a secret**; the secret key must NEVER appear in `apps/web` | Stripe.js never loads, so the save-card modal and `payPastDue`'s confirmation step can't run |
| `APP_ORIGIN` | functions | absolute origin (`https://…`) used to build Stripe Connect onboarding return/refresh URLs | `http://localhost:3000` **in the emulator only**; in production `createOnboardingLink` throws rather than build a redirect to an unknown origin |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | functions | signing secret of the second Stripe endpoint ("Connected accounts" scope: `account.updated`, `payout.paid`, `payout.failed`), a `defineSecret()` param declared on `stripeWebhook`; `constructWebhookEvent` returns which secret verified, and an event whose scope does not match that secret is refused | outside the emulator a missing secret is the same fail-closed 500 as `STRIPE_WEBHOOK_SECRET`; inside the emulator nothing needs it |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | mobile | Stripe publishable key for the native PaymentSheet (`apps/mobile/src/payments/stripe.ts`); set as an EAS environment variable, and in `apps/mobile/.env` for local dev-client runs | keyless mode: the native sheets are skipped and the emulator loop runs with zero Stripe keys |
| `FIREBASE_EMULATORS` | web | set to `1` so a production build (`next build && next start`) still targets the local emulators (`apps/web/src/lib/firebase-server.ts`) | a production build talks to real Firebase; `next dev` always targets the emulators |
| `STORAGE_BUCKET` | functions | the bucket every server-side Storage read and cleanup targets (`functions/src/storage.ts`); **must be set on the production deploy** or the functions read the dev bucket | `gatekeep-dev-jg.firebasestorage.app` |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` | web | the Firebase web config (`apps/web/src/lib/firebase.ts`); the set is documented in `apps/web/.env.example` | the `gatekeep-dev-jg` dev values compiled into the module |
| `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`, `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `EXPO_PUBLIC_FIREBASE_APP_ID` | mobile | the Firebase mobile config (`apps/mobile/src/lib/firebase.ts`); the set is documented in `apps/mobile/.env.example` | the `gatekeep-dev-jg` dev values compiled into the module |
| `WEB_PORT` | scripts | the web dev-server port `scripts/seed-test-event.ts` prints its `/e/[eventId]` URL against | `3000` |
| `GOOGLE_APPLICATION_CREDENTIALS` | scripts | service-account JSON path that lets `scripts/seed-admin.ts` and `scripts/seed-test-accounts.ts` run against a real project instead of the emulator | the scripts refuse to run when neither this nor the emulator hosts are set |
| `GCLOUD_PROJECT` | scripts | the project id `scripts/seed-admin.ts` and `scripts/seed-test-accounts.ts` (via `scripts/projectId.ts`) write to, checked after a `--project` argument and before the credentials file; printed before any write | a `--project` argument, else the credentials file's `project_id`, else `gatekeep-dev-jg` when an emulator host is set, else the script refuses |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | web | Google Maps JavaScript API key for the search results map (`apps/web/src/search/ResultsMap.tsx`); optional, HTTP-referrer restricted | unset → the map toggle stays hidden, text/list search still works |

The Android Maps key is not an environment variable: `apps/mobile/app.json`'s
`android.config.googleMaps.apiKey` carries the placeholder `REPLACE_WITH_ANDROID_MAPS_KEY`, swap it
for a Maps SDK for Android key restricted by package name and signing certificate before a device
build, `react-native-maps` reads it from the native config, not from an env var.

Web App Check only initializes when `NODE_ENV === "production"` **and** the site key is set
(`apps/web/src/lib/firebase.ts`). Mobile Sentry is additionally gated on `!__DEV__`
(`apps/mobile/app/_layout.tsx`), so it never fires in a dev build regardless of the DSN.

### Geocoder secret setup (production)

`GEOCODER_API_KEY` is a [`defineSecret()`](https://firebase.google.com/docs/functions/config-env#secret-manager)
param (`functions/src/geocode.ts`'s `geocoderApiKey`), Secret Manager-backed rather than a bare env
var, the v2 Cloud Functions mechanism that actually makes a secret available at invocation time in
production. Setting it up:

1. `firebase functions:secrets:set GEOCODER_API_KEY` (prompts for the value, stores it in Secret
   Manager, grants the functions service account access).
2. Deploy, every onCall that can trigger a geocode (`updateCuratorProfile`, `createGig`/
   `updateGig`, `createSeries`/`updateSeries`) already declares `secrets: [geocoderApiKey]` in its
   `onCall` options, which is what makes Cloud Functions inject the secret as
   `process.env.GEOCODER_API_KEY` for that function at runtime. A new onCall that needs to geocode
   must add the same `secrets: [...]` entry or the key will silently resolve to empty in production.

**Emulator/local dev fallback**: the Functions emulator does not provision Secret Manager secrets by
default, so `geocoderApiKey.value()` legitimately returns `""` there. `getGeocoder()` falls back to
a bare `process.env.GEOCODER_API_KEY` read in that case, set it via a `functions/.env` file (or
your shell) to test `GEOCODER_PROVIDER=google` against a real key locally without deploying.

**Daily geocode budget**: every address-resolving call also consumes a per-uid daily budget
(`geocodeBudgets/{uid}`, `functions/src/geocode.ts`'s `consumeGeocodeBudget`), 50 geocode calls per
uid per UTC calendar day, `resource-exhausted` ("Too many location updates today.") past the
ceiling. A caller re-submitting the exact same address/city it already resolved is NOT charged
again (the geocoded location is reused as-is via the stored `geocodedFrom` string), only a
genuinely new query consumes the budget. `geocodeBudgets/{uid}` is internal bookkeeping,
`allow read, write: if false` in `firestore.rules` for every client including the owner.

### Stripe key setup (emulator, local real-mode, production)

There are three ways to run the payments code, and they need different amounts of configuration:

1. **Emulator suite, zero configuration.** `pnpm emu:test`, `pnpm emu:rules` and a local
   `firebase emulators:start` need **no Stripe keys at all** and must never be given any. With
   `STRIPE_SECRET_KEY` unset, `getStripe()` returns **`FakeStripe`**, an in-Firestore fake
   (`stripeFake/**`, a collection that simply never exists in production) that models charges,
   refunds, transfers, payouts, idempotency-key replay and decline caching well enough to exercise
   every saga. Its decline/pending knobs are scopable per customer (`stripeFake/config`), which is
   how the test suite exercises card declines without a network. The selection **fails closed**: the
   fake is only allowed when the process can prove it is in the emulator, so a deployed function
   that forgot `secrets: [stripeSecretKey]` throws instead of silently moving fake money against
   production data.
2. **Local against REAL Stripe test mode.** Put `STRIPE_SECRET_KEY=sk_test_…` (and, if you are
   forwarding webhooks with the Stripe CLI, `STRIPE_WEBHOOK_SECRET=whsec_…`) in a **`functions/.env`**
   file, the Functions emulator does not provision Secret Manager secrets, so `defineSecret().value()`
   legitimately resolves to `""` there and the code falls back to a plain `process.env` read (same
   pattern as `GEOCODER_API_KEY` above). `functions/.env` is git-ignored; **never commit a key, and
   never put one in test code.** For the web half, set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…`
   in `apps/web/.env.local`.
3. **Production.** `firebase functions:secrets:set STRIPE_SECRET_KEY` and
   `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET` (Secret Manager-backed, not plain env
   vars), then deploy. Every payments function already declares `secrets: [stripeSecretKey]` (and
   the webhook additionally `stripeWebhookSecret`) in its options, which is what makes Cloud
   Functions inject them at invocation time, **a new payments function that omits the declaration
   will resolve to an empty key and throw**. Set `APP_ORIGIN` on the functions deployment to the
   real web origin, or Connect onboarding refuses to build its return URL.

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is **baked into the web bundle at build time** (it is a
`NEXT_PUBLIC_` var read at module scope in `apps/web/src/payments/stripeLoader.ts`), setting it on a
running deployment changes nothing until the app is **rebuilt and redeployed**. Publishable keys are
not secrets; the corresponding secret key must never appear anywhere under `apps/web`.

Set `FIREBASE_EMULATORS=1` to run a production build of the web app (`next build && next start`)
against the local emulators instead of real Firebase, `apps/web/src/lib/firebase-server.ts`'s
server-side (RSC) Firebase client otherwise only targets the emulators when
`NODE_ENV !== "production"`.

## Manual follow-ups (not automatable / require console access)

These are tracked gaps, not bugs, the app is unblocked without them, but they must be done
before a real launch:

- **Firebase console → Authentication → Sign-in method**: enable Email/Password, Google, and
  Apple providers on the `gatekeep-dev-jg` project (and again on whatever project id production
  uses).
- **Firebase console → App Check**: register the web app with **reCAPTCHA v3** (produces the
  value for `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`) and the mobile apps with **Play Integrity**
  (Android) / **App Attest** (iOS). Keep enforcement in **monitor mode** for Firestore, Functions,
  **and Cloud Storage** until both stores' builds exist, then flip to **enforce** as a
  launch-checklist item, **Storage must not be flipped to enforce before native mobile App Check
  ships**: mobile has no App Check attestation client code today, and enforcing early would lock
  the app out of its own uploads. Mobile ships v1 in monitor mode via the console only, no native
  App Check client code; native attestation (`@react-native-firebase/app-check`) and the EAS
  production build that carries it are **out of sub-project 2's scope** (superseding the earlier
  plan of landing them there) and now live in a dedicated launch-prep track (SP2 spec §1), on the
  same must-review-before-launch list as the sub-project 1 admin/internal deferred items below.
- **`apps/mobile/src/auth/config.ts`, `GOOGLE_WEB_CLIENT_ID`**: currently a
  `REPLACE_FROM_FIREBASE_CONSOLE...` placeholder. Get the real web client ID from Firebase console
  → Authentication → Sign-in method → Google → Web SDK configuration, and set it there before
  Google sign-in works on-device.
- **Sentry DSNs**: no Sentry account/project exists yet. Create one free project per app (or one
  project, two DSNs), then set `NEXT_PUBLIC_SENTRY_DSN` (web) and `EXPO_PUBLIC_SENTRY_DSN`
  (mobile) in each app's deploy/build environment. Both apps typecheck, lint, and build cleanly
  with these unset, crash reporting is simply inert until then.
- **EAS `projectId`**: DONE. `apps/mobile/app.json` carries `expo.extra.eas.projectId`
  (`0731d32c-00c5-4fdb-9d1c-78d6be4bf1c6`), which `apps/mobile/src/notifications/push.ts` reads
  for push-token registration.
- **EAS build setup (still owed; the "Owner-owed items" list in
  `docs/superpowers/HANDOFF.md` is the tracker)**: `apps/mobile/eas.json` (development/preview/
  production profiles; preview builds an installable Android APK) and the app identifiers
  (`app.gatekeep.mobile` for both `android.package` and `ios.bundleIdentifier`) are committed. Still
  manual: `eas login` on each build machine; Firebase console → add an **Android
  app** (package `app.gatekeep.mobile`) → download `google-services.json` into `apps/mobile/` and add
  the EAS keystore's SHA-1 (`eas credentials`) to it (Google Sign-In fails on-device without it);
  add an **iOS app** (bundle `app.gatekeep.mobile`) → `GoogleService-Info.plist` likewise; then set
  `android.googleServicesFile` / `ios.googleServicesFile` in `app.json` once the files exist.
  iOS on-device builds additionally require Apple Developer Program enrollment (dev builds under a
  personal Apple ID are fine; store publication waits for the business identity per the ruling in
  `docs/superpowers/sp4-rulings.md`'s launch notes). Stripe: a personal-entity TEST-MODE account
  exists (2026-08-27); keys live outside the repo, sub-5 wires `sk_test` via `defineSecret()`
  (the `GEOCODER_API_KEY` pattern). Never activate live mode or Connect onboarding under the
  personal entity.
- **Deploy-time `workspace:*` resolution**: `functions/package.json` depends on
  `@gatekeep/shared` via `"workspace:*"`. Before relying on `firebase deploy --only functions`,
  verify that command actually resolves the workspace dependency into a deployable package (rather
  than failing or publishing a broken reference), this hasn't been exercised yet, only
  `pnpm --filter functions build` against the local workspace symlink.
- **App Check enforcement is two changes, not one**: flipping Firestore/Functions App Check from
  monitor to enforce mode in the console does **not** by itself make callables reject
  unattested requests, each `onCall` also needs `enforceAppCheck: true` in its handler options
  (a code change in `functions/src/*.ts`). Both must land together at the launch-checklist step
  called out above, or enforcement is a no-op for callables. Cloud Storage doesn't have this
  second step, its enforcement toggle applies directly, but it still can't flip until native
  mobile App Check ships, per the bullet above.
- **Content takedown is a two-step for a full scrub**: an admin unpublishing an approved profile
  (`reviewProfile` reject, or the admin "Unpublish profile" button) instantly removes it from
  discovery, the public page 404s and Storage listing is denied, but deliberately leaves the
  transcoded clips and photos in the `public/` bucket, because the same reject path is also the
  routine "please revise and resubmit" flow (scrubbing them would force a full re-upload on
  resubmit). For an abuse/impersonation takedown where the raw objects must be gone, follow the
  unpublish with `deleteProfile` (unblocked once the profile is `rejected`), whose cascade sweeps
  `public/tracks`, `review/tracks`, and `public/photos`. Between the two steps a direct
  `getDownloadURL` obtained while the profile was live still resolves, do both promptly.
- **Firebase console, Authentication settings, user actions: turn OFF "Delete account"**
  (Identity Platform "user actions"), so self-service deletion has to go through the
  `deleteAccount` callable. Firebase has no blocking delete trigger, so nothing server-side can
  refuse a client's `currentUser.delete()` or a console deletion, and either walks straight past
  `deleteAccount`'s refusals (a live ticket to a future event, an offered transfer, a pending
  order, sole admin of a profile). Until the toggle is off, the `account_deleted_unclean` admin
  alert raised by `onUserDeleted` (`functions/src/authTriggers.ts`) is the only backstop: the
  cascade still runs, and the alert names the uid and what was outstanding so an operator can
  finish the unwind by hand.
- **Firebase Email Enumeration Protection**: confirm this is enabled (Firebase console →
  Authentication → Settings) on both the `gatekeep-dev-jg` project and whatever project id
  production uses. The app's sign-in error handling degrades gracefully either way, but it
  currently assumes the protection is on rather than asserting it, verify the console toggle
  before launch instead of relying on that assumption.
- **Storage `staging/` lifecycle rule, LAUNCH BLOCKER**: configure a 24h TTL lifecycle rule on
  the `staging/` prefix of the production Storage bucket (Cloud Console / `gcloud storage buckets
  update --lifecycle-file`, not the Firebase console rules editor, this is a bucket-level GCS
  lifecycle policy, not a `storage.rules` change). The Storage **emulator does not enforce
  lifecycle rules**, so nothing catches its absence in local dev. It's the backstop for staging
  objects `processUpload` fails to clean up because its trigger never fired at all, see the
  comment above the storage cascade in `functions/src/profiles.ts`'s `deleteProfile`. Ship this
  together with the abandoned-track reaper below; both are "abandoned upload cleanup."
- ~~**Abandoned `processing`-track reaper**~~, **DONE (sub-project 3):** a track created via
  `createTrack` but never uploaded (or abandoned mid-upload) used to hold one of the 10 track cap
  slots indefinitely. `functions/src/scheduled.ts`'s daily sweep now fails `processing` tracks
  older than 24h automatically; see "Gigs & series" above.
- **`PUBLIC_PROFILE_HOST`** (`apps/mobile/app/(musician)/portfolio.tsx`): still the
  `https://gatekeep.example` placeholder. The mobile "View public page" link is intentionally
  hidden (`PUBLIC_PROFILE_HOST_READY`) rather than pointing at a dead URL, update the constant to
  the real deployed web domain once one exists, and the link appears on its own.

### Sub-project 3 launch checklist (gigs & series)

- **Geocoder provider**: set `GEOCODER_PROVIDER=google` on the production functions deployment, and
  set `GEOCODER_API_KEY` via `firebase functions:secrets:set GEOCODER_API_KEY` (Secret Manager, not
  a plain env var) before launch, see "Geocoder secret setup" above. Without it, every gig/curator
  address silently geocodes through `StubGeocoder`, a deterministic hash with a US-centric
  bounding box, fine for dev/test but wrong (and non-US-safe) for real addresses.
- **Geocode budget ceiling**: the 50/day per-uid `geocodeBudgets/{uid}` ceiling (see "Geocoder
  secret setup" above) is a fixed constant (`GEOCODE_DAILY_BUDGET` in `functions/src/geocode.ts`),
  not an env var, revisit the number if real curator usage patterns turn out to need more than 50
  distinct address lookups per person per day.
- **Cloud Scheduler enablement**: `functions/src/scheduled.ts`'s `dailySweep` only starts actually
  running once `firebase deploy` provisions the underlying Cloud Scheduler job, there is nothing
  to enable by hand, but the first production deploy should be followed by a Cloud Console check
  (Cloud Scheduler → confirm the job exists and its next-run time looks right) since a silently
  failed provision would otherwise go unnoticed until series stop materializing days later.
- **Verify the 5 sub-project 3 composite indexes on first deploy**: the Firestore emulator does not
  enforce composite indexes, so `pnpm emu:rules`/`pnpm emu:test` passing locally proves nothing
  about them. `firestore.indexes.json`'s `gigs`(curatorProfileId,status),
  `gigs`(curatorProfileId,status,startsAt), `gigs`(seriesId,startsAt), `gigs`(status,startsAt), and
  `gigSeries`(curatorProfileId,status) composite indexes must actually build successfully on the
  real project (Firebase console → Firestore → Indexes, or `firebase deploy --only
  firestore:indexes` then watch for "Enabled") before the gig composer/dashboard/public-page
  queries that depend on them will work in production.
- **`LAUNCH_TIMEZONE`** (`@gatekeep/shared`'s `packages/shared/src/types.ts`): currently
  `"America/New_York"`, a v1 single-metro-launch placeholder that pins every rendered gig time
  (public curator page + dashboard gigs/series lists, web and mobile) to one IANA zone so a curator
  and a fan always see the same wall time regardless of their own device's clock. **Must be set to
  the actual launch metro's IANA zone before launch**, per-venue timezone support is a documented
  sub-4 obligation (see `docs/superpowers/sp3-rulings.md`), not a v1 feature.
- **UTC recurrence-time caveat**: a `gigSeries`' `recurrence.weekday`/`hour`/`minute` (and its
  `endDate`) are interpreted in a FIXED UTC anchor by the daily sweep's materializer
  (`functions/src/scheduled.ts`), NOT in `LAUNCH_TIMEZONE` or any curator's local time, a curator
  who picks "Friday 8pm" gets UTC 8pm, which drifts from their actual local 8pm by their UTC offset
  and across DST. The gig composer's series form (`apps/web/src/gigs/GigForms.tsx` /
  `apps/mobile/src/gigs/GigForms.tsx`) discloses this in-form ("Times are in UTC for now,
  local-timezone support is coming"); there is no code fix pending, just this disclosure, until a
  future sub-project's TZ-aware recurrence work lands.
- **Name-search backfill (one-shot)**: `searchUsersByName`'s prefix query depends on every
  `users/{uid}` doc having a `displayNameLower` field. New signups get it automatically
  (`onUserCreated` + the `onUserDocWritten` sync trigger), but any user created **before**
  sub-project 3 shipped won't have it yet. Run the admin-gated one-shot callable
  `backfillDisplayNameLower` once against production after deploy (e.g. from the Firebase console's
  Functions testing tab, or a short authenticated script) to page through and backfill existing
  users, until then, name search simply won't find pre-existing accounts (the email-exact lookup
  path still works for them).
- **Device pass (mobile, before launch)**, verify on a real dev-build device, not just the
  simulator/emulator: (1) **Hermes ICU date formatting**, `apps/mobile/src/gigs/GigForms.tsx`'s
  `formatGigDateTime` wraps its `Intl.DateTimeFormat`/`formatToParts` calls in a try/catch because
  Hermes's ICU timeZone/formatToParts support isn't independently verified on-device the way a
  browser's is; confirm it actually renders the formatted date rather than silently falling back to
  the device's raw local-time string. (2) **Nested "events" Stack headers**, the curator tab's
  `app/(curator)/events/_layout.tsx` nests an Expo Router `Stack` (list → composer → gig detail →
  series detail) inside the outer `Tabs` navigator; confirm header/back-button behavior looks right
  across that nesting on both iOS and Android. (3) **Native provider sign-in**, carried over from
  sub-projects 1/2 (see Prerequisites/Key commands above): Expo Go cannot perform native
  Google/Apple sign-in, so this only gets exercised on a real `expo-dev-client` build; confirm both
  providers still work end-to-end there.

### Sub-project 4 launch checklist (booking flow)

- **`backfillBookingVisibility` (one-shot), CRITICAL ordering, must ship in the SAME release as
  the rules deploy**: `firestore.rules`' sub-project 4 tighten removes curators' old blanket read
  of `profiles/{id}/private/booking` (see "Booking flow" above), curators from then on read only
  the server-built `private/curatorBooking` projection. That projection only exists for a profile
  once something has written it (`updateBookingInfo` going forward, or this backfill for every
  pre-sub-4 `private/booking` doc). **Deploy the tightened rules and run
  `backfillBookingVisibility` in the same release**, if the rules land first without the backfill
  (or the backfill is deferred to "later"), every pre-existing musician's rates/preferences become
  invisible to every curator until it runs; if the backfill somehow ran before the old rules were
  removed, nothing breaks, but there is no reason to split the two. Run it once against production
  after deploy (Firebase console's Functions testing tab, or a short authenticated admin script),
  the same way as `backfillDisplayNameLower` above, it's idempotent (a profile whose
  `private/booking` doc already has `visibility` is left untouched), and it defaults migrated
  profiles to all-`"curators"` visibility (preserves pre-sub-4 exposure exactly, exposes nothing
  new).
- **New composite indexes deploy with `firebase deploy`**: sub-project 4 adds 16 composite indexes
  to `firestore.indexes.json` (7 more `gigs` composites, booked-musician/series/booking linkage
  queries, plus 9 new `bookings` composites, since `bookings` is itself a new collection this
  sub-project introduces). Same caveat as the sub-project 3 indexes below: the emulator does not
  enforce composite indexes, so `pnpm emu:test`/`pnpm emu:rules` passing locally proves nothing
  about them, confirm they actually build on the real project after the first production deploy
  (Firebase console → Firestore → Indexes, or `firebase deploy --only firestore:indexes` then watch
  for "Enabled") before the booking thread/inbox/Shows/directory queries that depend on them will
  work in production.

### Sub-project 5 launch checklist (payments)

- **Register TWO webhook endpoints in the Stripe dashboard** (Developers, Webhooks, Add endpoint),
  both pointing at the deployed `stripeWebhook` function's HTTPS trigger URL (`firebase deploy`
  prints it; it also appears in the Firebase console under Functions):
  1. scope **"Events on your account"**, subscribed to `payment_intent.succeeded`,
     `payment_intent.payment_failed`, `transfer.reversed`, `charge.dispute.created`,
     `charge.dispute.closed` and `charge.refunded`; store its signing secret with
     `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`;
  2. scope **"Events on Connected accounts"**, subscribed to `account.updated`, `payout.paid` and
     `payout.failed`; store its signing secret with
     `firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET`.
  `stripeWebhook` verifies every delivery against the platform secret first, then the Connect secret,
  and refuses a delivery whose proven scope does not match the event (a platform-signed event carrying
  `account`, or a Connect-signed event without one). **Both secrets must be set**: the endpoint fails
  closed (HTTP 500, which Stripe retries) until they are. `transfer.reversed` is the only way the
  platform learns about an earnings transfer reversed from the dashboard; the two dispute events and
  `charge.refunded` are what record chargebacks and dashboard refunds (sub-project 10). Register a
  separate pair of endpoints with their own secrets when flipping to live mode.
- **Enable a Firestore TTL policy on `stripeEvents.expireAt`** (Firebase console → Firestore → TTL,
  or `gcloud firestore fields ttls update expireAt --collection-group=stripeEvents`). Every webhook
  claim document is stamped with a 30-day `expireAt`, but **the field alone expires nothing**, the
  code stamps it, the policy deletes it. Without the policy `stripeEvents` grows forever; the
  replay protection still works, it just never garbage-collects.
- **Radar and dispute liability (before live mode).** Turn on Stripe Radar's default rules on the
  platform account (every charge is a platform charge, so Radar runs there), and read the Connect
  dispute-liability setting: on the separate charges and transfers model the platform is liable
  for disputes, which is what the `charge.dispute.*` handlers assume (alert, delinquency flag on a
  booking charge, reversal of the matching transfer on a lost outcome, `disputes/{disputeId}` for
  the admin). Evidence submission stays manual in the Stripe dashboard.
- **Simulate a dispute in test mode.** Charge Stripe's dispute test card **4000 0000 0000 0259**
  once as a booking deposit and once as a ticket order. Expect: a `dispute_opened` ledger row and
  `adminAlert`, the curator flagged delinquent (deposit) or the order stamped
  `disputeStatus: "open"` (ticket), and, after closing the dispute as lost from the dashboard, a
  `dispute_lost` row plus the reversal, or a `dispute_reversal_failed` alert when no transfer
  exists yet.
- **Platform float for ticket settlement: resolved by sub-project 5c.** Ticket settlement is now
  one sourced transfer per paid order (`ticket_settlement:{eventId}:{orderId}`,
  `source_transaction` from the order's own charge), so no platform float decision is owed; see
  `sp5c-rulings.md`.
- **1099 delivery.** Enable tax form delivery for Express accounts in the Connect settings for the
  tax year; nothing in code depends on it.
- **Re-verify `debitConnectedAccount` against current Stripe Connect documentation BEFORE live
  mode.** Pulling funds from a connected account's balance back to the platform (how the 4% instant
  fee is collected) is implemented as `charges.create({ source: accountId })`, Stripe's legacy,
  pre-Treasury account-debit mechanism, thin on current Connect docs
  (`functions/src/stripeClient.ts`, `RealStripe.debitConnectedAccount`). It is exercised only
  against `FakeStripe` today. Confirm the current supported call shape and adjust before any real
  money runs through it.
- **Re-verify the instant-payout fee rate before live mode.** We charge the musician **4%** (min $1,
  `INSTANT_FEE_PCT`); Stripe's own instant-payout cost to us was ~1.5% at design time. Confirm
  Stripe's current rate and decide whether 4% is still the right retail number, it is a shared
  constant (`packages/shared/src/types.ts`) snapshotted per booking, so changing it does not
  re-price already-accepted bookings.
- **Connect activation + live-mode flip**: activate Stripe Connect on the platform account
  (business entity, Express onboarding branding, payout schedule), then swap `STRIPE_SECRET_KEY`
  and `STRIPE_WEBHOOK_SECRET` to their live values, set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to the
  live publishable key and **rebuild the web app** (it is baked in at build time, see "Stripe key
  setup" above), and set `APP_ORIGIN` to the real web origin. No code change is involved in the
  flip; if one seems necessary, something is wrong.
- **`paymentsSweep` deploys with the functions**, like `dailySweep`, its Cloud Scheduler job is
  provisioned by `firebase deploy`, so there is nothing to enable by hand, but the first production
  deploy should be followed by a Cloud Console check (Cloud Scheduler → the hourly job exists, next
  run looks right). This one is money-critical, not just housekeeping: settlement windows, birth
  deposits, the dunning schedule and every crash-recovery path live in it, so a silently unprovisioned
  job means nothing ever settles. Check `adminAlerts` periodically too, that is where the sweep
  escalates money states it refuses to act on.
- **Product decision recorded: payouts are profile ADMINS only** (`requestPayout` and
  `createOnboardingLink` call `requireProfileAdmin`, sub-project 5 security ruling H2,
  `docs/superpowers/sp5-rulings.md` ruling 7). Onboarding sets the bank destination and a payout
  drains the balance, so both are gated like `removeMember` and `transferAdmin`. Members keep
  read-only balance and status through `getStripeStatus`; the mobile Earnings card shows the
  buttons to any member and surfaces the server's refusal. Sub-project 5c (admin-initiated member
  payout splits) is the recorded follow-up.
- **New composite indexes deploy with `firebase deploy`**: sub-project 5 adds 7 (one `bookings`
  composite plus six `payments` **collection-group** composites the sweep's due/retry/delinquency
  scans depend on). Same caveat as the sub-project 3/4 indexes: the emulator does not enforce
  composite indexes, so a green `pnpm emu:test` proves nothing about them, confirm they build on
  the real project (Firebase console → Firestore → Indexes) after the first deploy. A missing
  `payments` collection-group index means the sweep throws instead of settling.
- **Do not enable App Check enforcement in a way that covers `stripeWebhook`**, it is the only
  non-callable HTTPS entry point in the codebase and is App-Check-exempt by nature (Stripe cannot
  attest). Its protection is signature verification plus event idempotency.

### Sub-project 5b launch checklist (mobile payments)

1. **Apple Developer portal**: create merchant id `merchant.app.gatekeep.mobile`; add the Apple Pay
   payment-processing certificate via the Stripe dashboard (test mode first, again at go-live).
2. **Stripe dashboard**: enable Google Pay. (`testEnv` follows the key: any non-`pk_live_` key runs
   Google Pay in test mode.)
3. Set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS environment variable (dashboard or
   `eas env:create`), plus `apps/mobile/.env` for local dev-client runs. `eas.json` stays
   key-free. No key = keyless mode (sheets skipped, emulator dev posture).
4. Cut a **new** EAS dev-client build for both platforms before device testing
   (`npx eas-cli build --profile development --platform all` from `apps/mobile/`), the Stripe
   native module changed the binary.
5. `APP_ORIGIN` must be set on deployed functions before testing onboarding from a device (the
   Stripe return/refresh pages live on web).

### Sub-project 9A launch checklist (web UI/UX)

1. **Hero carousel photos**: `apps/web/public/hero/` currently holds three placeholder
   gradient/color-field JPGs (generated with ffmpeg's `gradients` lavfi filter, not real
   photography). Replace them with the owner's real concert photo folder (2560x1440, 16:9, subject
   in the middle 60%, per the web UI/UX spec section 9) and update
   `apps/web/src/marketing/heroImages.ts`'s `HERO_IMAGES` list to point at the new files.
2. **`/terms` and `/privacy`**: both pages currently render clearly-labeled placeholder legal text
   (a visible banner on each page says so). Have counsel review and replace the placeholder prose
   in `apps/web/app/terms/page.tsx` and `apps/web/app/privacy/page.tsx` with the real Terms of
   Service and Privacy Policy before launch.
3. **Footer contact address**: the site footer's contact link (`CONTACT_EMAIL` in
   `apps/web/src/shell/Footer.tsx`) is a placeholder, `hello@gatekeep.app`. The operator must own
   that mailbox or change it to a real one before launch.

### Sub-project 9B smoke checklist (mobile UI/UX)

Sub-project 9B was a presentation-only redesign of the mobile app (the app shell, three-state
theming, branded skeleton/empty/error states, photo-forward browse cards, the artist page, and
every SP4/SP5 booking and money surface), with zero behavior change. It is the one thing this
machine cannot verify, since it can't run the dev client, so the owner runs this visual pass on
the next EAS dev-client build. Walk every item at phone width, once in dark theme and again in
light:

- **Shell**: tab bars, headers, the context switcher (fan / musician / curator), and the
  three-state theme toggle (system / light / dark) all render and switch cleanly.
- **Auth + join**: sign-in, sign-up, and the join wizard, including the inline error banners and
  the forgot-password flow.
- **Dashboards + account**: the curator and musician dashboards and the account screens.
- **Editors**: the profile editors (musician portfolio, curator wizard/editor) and the gig
  composer, including photo upload and its processing state.
- **Browse + events**: the gig and musician browse cards (photo-forward, with the placeholder art
  when a photo is missing) and curator events management (list → composer → gig → series).
- **Artist page**: the cover-photo hero, the Shows section, and the inline solid audio player
  (play/pause, one track at a time).
- **Booking thread**: offer, counter, accept, and cancel, with each state's chips and buttons.
- **Money surfaces**: the native PaymentSheet appearance, save-card, and the earnings, payout,
  delinquency, and gate-prompt surfaces. (Sheets appear only when
  `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` is set for the build; a keyless build skips them.)
- **Loading / empty / error**: skeleton loaders, branded empty states, and branded error states
  across the screens above.
- **Coming-soon states**: the fan tabs (discover, search, tickets) and the curator/musician
  messages tabs.
- **Both themes**: repeat the entire pass above in the other theme, so every surface is confirmed
  in both dark and light.

### Manual smoke walkthrough (real Stripe test mode)

The emulator suite covers the sagas against `FakeStripe`; this walkthrough is the one thing it
cannot prove, that the **real** Stripe API, Stripe.js, Connect onboarding and webhook delivery are
wired correctly. Run it against **test mode** after the first deploy to a real project (or locally
per option 2 of "Stripe key setup" above, with `stripe listen --forward-to <stripeWebhook URL>`
forwarding events). Nothing here uses real money, but everything here is real Stripe.

1. **Set up.** Confirm `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`) are
   in place, the web app was built with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_test_…`), and
   `APP_ORIGIN` points at the web origin you will actually browse. Keep the Stripe dashboard's
   test-mode **Payments** and **Events** views open alongside, every step below should produce a
   visible object there, and "nothing appeared in Stripe" is itself the finding.
2. **Save a card.** As a curator profile member, open a booking (or the curator dashboard) and add a
   card with **4242 4242 4242 4242**, any future expiry, any CVC, any ZIP. Expect: the card row
   renders "Card on file: visa •••• 4242", and a Customer with an attached PaymentMethod exists in
   Stripe. This card is now the profile's default payment method.
3. **Accept a booking → deposit charge.** With a payout-ready musician on the other side, accept an
   offer. Expect: a **succeeded PaymentIntent for 35% of the total plus its 11% fee share**
   (a $1,000 gig → $388.50), the booking flips to `confirmed`, and the booking's Payments panel
   shows "Deposit held" for the date. The musician's phone should show the same date chipped
   "Deposit held in escrow".
4. **Decline after save.** Add **4000 0000 0000 0341** as the card (it attaches successfully but
   **fails when charged**) and accept another booking. Expect: the accept is refused with "Your card
   was declined. Update your payment method and try again.", the booking stays `open`, and **no
   payment docs are left staged**. Then switch back to 4242 and accept again, expect a clean
   success. This is the one path that proves declines do not strand a booking: the retry uses a new
   attempt-scoped idempotency key, so it must NOT replay the cached decline.
5. **Musician onboarding.** As a musician profile member, hit "Set up payouts" on the Earnings page.
   Expect a redirect to Stripe's hosted Express onboarding; complete it with Stripe's test values
   (test SSN `000-00-0000`, test routing/account numbers, `000 000 0000` phone, any test address).
   On return, the page should re-sync and show a balance instead of the setup prompt, that
   round-trip is `APP_ORIGIN` plus the `account.updated` webhook both working.
6. **Settlement (T+3).** Real settlement waits three days after the gig ends, which no smoke test
   should sit through. Either let a past-dated occurrence come due naturally, or fast-forward the
   date's `settlement.settleAfter` to a past timestamp in the Firestore console (a server-written
   field, `paymentsSweep` is the only thing that ACTS on it, though both clients render it as the
   "Settles / Pays out ~" date, so an edited value shows up in the UI too) and wait for the next
   sweep run. Expect: a
   second succeeded PaymentIntent for the remaining 65% + fee, a **Transfer to the connected
   account for 98% of the base**, and both clients flipping the date to "Paid".
7. **Instant-payout simulation.** Instant payouts need a debit card as the connected account's
   external account, in test mode, attach Stripe's instant-payout-eligible test debit card
   (**4000 0566 5566 5556**) to the Express account. Expect the Earnings page's Instant button to
   become enabled with a live "fee $X" preview (4%, min $1), and a cash-out to produce a Payout plus
   a separate **account-debit charge for the fee** in the dashboard. If the button stays disabled,
   `instantEligible` is false, that is Stripe's own eligibility answer, not a UI bug.
8. **Past-due rescue.** Force a settlement failure (set the card to 4000 0000 0000 0341 before a
   settlement comes due) and let the dunning schedule exhaust, or set `settlement.nextRetryAt` back
   to hurry it. Expect: the occurrence goes `past_due`, the **10% late fee** appears, the curator
   profile is flagged delinquent, and sending a new offer is refused with "This profile has an
   overdue payment…". Then use **Pay now** on the panel with a good card: expect an on-session
   PaymentIntent (3DS challenge if you use **4000 0025 0000 3155**), the date flipping to "Paid",
   and the delinquency gate clearing on the next attempt to book.

**Mobile (device, test keys, dev build).** Steps 9–15 repeat the relevant parts of the above through
the native surfaces sub-5b added. Requires a real device (not the simulator/emulator, for Apple
Pay/Google Pay and the in-app browser hand-off), a fresh EAS dev-client build
(`npx eas-cli build --profile development --platform all`, since the Stripe native module changed
the binary), and `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` set for that build, a keyless build skips the
sheets entirely.

9. **Save a card (sheet).** As the curator, open the booking payment panel on the device and save
   **4242 4242 4242 4242** through the native `PaymentSheet`. Expect: the sheet completes without
   leaving the app, and the card row reads "Card on file: visa •••• 4242", the same row-state
   mapping web renders, sourced from the shared `paymentDisplay.ts`.
10. **3DS challenge inside the sheet.** Save **4000 0027 6000 3184** instead. Expect: the challenge
    is presented inside the `PaymentSheet` itself (no hand-off to a browser) before it completes.
11. **Past-due rescue, both debt shapes, from the sheet.** With **4000 0000 0000 0341** on file, let
    a retry schedule exhaust, once for an exhausted birth-deposit retry ("Deposit past due, pay
    now") and once for an exhausted post-settlement retry ("Past due, pay now"), the two separate
    debt shapes `payPastDue` handles, then use **Pay now** to clear each with a good card through the
    sheet. Expect: an on-session PaymentIntent, the row flipping to "Deposit held" for the deposit
    debt or "Paid" for the settlement debt, and the delinquency gate clearing either way.
12. **Apple Pay / Google Pay rows.** On a capable device (an iPhone signed into a wallet, or an
    Android with Google Pay configured, with the merchant id and Google Pay enabled per the sub-5b
    checklist above) open the same sheet. Expect: an Apple Pay or Google Pay row appears above the
    card entry.
13. **Onboarding round-trip.** As the musician, hit "Set up payouts" on the mobile Earnings card.
    Expect: an in-app browser (not the system browser) opens Stripe's hosted Express onboarding;
    complete it with the same test values as step 5 above. Dismissing the browser, or backgrounding
    and re-foregrounding the app, re-polls `getStripeStatus`, and the payout/apply gates open
    without a manual refresh.
14. **Standard then instant payout.** From the mobile Earnings card, request a standard payout, then
    an instant one. Expect: the fee preview shown before confirming ($0 standard, 4% min $1 instant)
    matches the fee `requestPayout` actually returns.
15. **A `perHour` true-up.** Submit a true-up whose actual hours differ from the booking's planned
    hours through the mobile true-up form. Expect: the preview delta shown before submitting matches
    the amount actually charged once the true-up settles.

### Sub-project 6 launch checklist (events & ticketing)

- **No new Stripe secrets or webhook registration needed.** Ticket checkout rides the existing
  `stripeWebhook` endpoint and `stripeEvents` claim machine with a new `metadata.purpose: "tickets"`
  value; the webhook subscription list and the `stripeEvents.expireAt` TTL policy set up for
  sub-project 5 (see above, unchanged) already cover it. Sub-project 10 later added
  `STRIPE_CONNECT_WEBHOOK_SECRET` for the Connect scope; see the sub-project 5 checklist.
- **New composite indexes deploy with `firebase deploy`**: sub-project 6 adds 11 composite indexes
  to `firestore.indexes.json` (3 `orders`, 5 `events`, 3 `transfers`) plus a `tickets.orderId`
  collection-group field override. Same caveat as every prior sub-project's indexes: the emulator
  does not enforce composite indexes, so a green `pnpm emu:test`/`pnpm emu:rules` proves nothing
  about them, confirm they build on the real project (Firebase console → Firestore → Indexes)
  after the first deploy before the events/orders/transfers queries that depend on them will work
  in production.
- **Poster upload: DONE in sub-project 10.** `processPhoto` writes `posterUploads/{uid}/uploads/{nonce}`
  for kind `poster`; the web `EventEditor` and the mobile event management screen watch that doc
  and save `posterPath` through `updateEvent`; `/e/[eventId]` renders it and uses it as the OG
  image. Abandoned poster docs older than 24h are reaped by dailySweep step 3.
- **Transfers are mobile-only in v1.** The web fan tickets page shows a "manage transfers in the
  GateKeep app" hint and never calls `offerTransfer`/`respondToTransfer`; only the mobile app can
  send or accept a transfer. Transfer targeting is email-only (handles denote group profiles, not
  individual people; the spec's "@handle or email" language resolved this way, recorded for the
  rulings doc).

### Sub-project 6 smoke checklist (events & ticketing)

Sub-project 6 opens ticketing to fans: curator-published events (standalone or promoted from a
filled gig), paid/free multi-tier tickets on the sub-5 Stripe rails, QR door check-in, curator grace
refunds and cancel-refunds, and in-app ticket transfers. The emulator suite covers every
server-side saga against FakeStripe; the paid-checkout path is the one thing it cannot prove.
**In the keyless local emulator a paid tier's checkout only verifies as far as the Elements/Payment
Sheet mount** (the Pay button correctly stays disabled with no publishable key), so the walkthrough
below must run at least once against **real Stripe test mode**
(`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` set for the web build, same posture as the "Manual smoke
walkthrough" above) to prove a real charge completes.

**Web, both themes:**
- Create a standalone event, and separately promote a filled gig into one.
- Tier editor: add/remove tiers freely while the event is a draft; after publish, capacity can only
  go up, never down.
- Publish the event.
- Load the public page (`/e/[eventId]`) signed out: the exact address is hidden, tiers render with
  price and sale-window state, and a sold-out tier shows as sold out.
- Buy a free RSVP tier as a fan.
- Buy a PAID tier end to end **with real Stripe test keys** (`4242 4242 4242 4242` through Elements
  should produce a confirmed order and a minted ticket).
- Fan "Your tickets" page: the QR renders and the exact address reveals for a valid ticket.
- Curator attendee list updates live as tickets sell or check in.
- Grace-refund one ticket from the attendee list (refunds close once the event's own end time
  passes).
- Cancel the event (this auto-refunds every paid order in full).

**Mobile, both themes, needs a new EAS dev-client build:** `expo-camera` and
`react-native-qrcode-svg` joined the native dependency list this sub-project, so device testing
needs a fresh dev-client build before any of this works
(`npx eas-cli build --profile development --platform all`).
- Buy a ticket from the event screen via the native `PaymentSheet`.
- Ticket wallet: the QR renders full-screen.
- Transfer a ticket between two test accounts (email-targeted, 24h expiry, cap enforcement on
  accept).
- Accept and decline an incoming transfer offer.
- Curator: tiers editor, publish, cancel.
- **Door scanner, the single top on-device priority.** This screen is entirely unverified off
  device: scan a real ticket QR, scan the same one twice and confirm the duplicate-scan state shows
  the original check-in time, then deny camera permission once and confirm the Settings fallback
  (not a dead button).
- Attendee list tap-to-check-in fallback.

### Sub-project 7 launch checklist (fan discovery)

- **New composite indexes deploy with `firebase deploy`**: sub-project 7 adds 8 composite indexes to
  `firestore.indexes.json` (2 `events`, 4 `profiles`, 1 `follows`, 1 `posts`):
  - `events (status, genres ARRAY_CONTAINS, startsAt)`
  - `events (status, hasFreeTier, startsAt)`
  - `profiles (type, status, name)`
  - `profiles (type, status, portfolio.genres ARRAY_CONTAINS, name)`
  - `profiles (type, status, updatedAt desc)`
  - `profiles (type, subtype, status, updatedAt desc)`
  - `follows (uid, targetType, createdAt desc)`
  - `posts (status, createdAt desc)`

  Same caveat as every prior sub-project's indexes: the emulator does not enforce composite
  indexes, so a green `pnpm emu:test`/`pnpm emu:rules` proves nothing about them, confirm they
  build on the real project (Firebase console → Firestore → Indexes) after the first deploy before
  the discover deck, list, and follow queries that depend on them will work in production.
- **New EAS dev build needed.** `expo-location` joined the native dependency list this
  sub-project (the deck's distance sort and "near me" labels), so device testing needs a fresh
  dev-client build before any of this works (`npx eas-cli build --profile development --platform
  all`), same as the sub-6 camera/QR dependencies before it.
- **Marketing image owed.** The landing page's fan-story section (`apps/web/src/marketing/LandingSections.tsx`'s
  `FanStorySection`) reuses `artist-page.jpg` rather than a real Discover-page capture; a proper
  screenshot of the deck or the `/discover` list is still owed.

### Sub-project 7 smoke checklist (fan discovery)

Sub-project 7 opens fan discovery: a swipeable deck and searchable lists on mobile, a filterable
`/discover` grid on web, follow/unfollow on musician, curator, and genre targets, show posts from
lineup members, and the notification fan-out that ties it together (new show announced, show
rescheduled, a lineup post, new music from someone followed).

**Web, both themes:**
- `/discover` lists events and artists, and the filters (genre, free-tier, distance) narrow the
  results.
- Follow and unfollow from a musician/curator page (`/u/[handle]`) and from an event page (`/e/[eventId]`).
- The genre picker appears once for a signed-in fan with no genre follows yet, and not again after.
- The post-purchase follow prompt appears after a free order for a fan with no genre follows.
- Posts by a lineup member render on the event page (`/e/[eventId]`).
- Admin can Remove a post from the moderation queue.
- The landing page's fan-story section renders correctly in both themes.
- A signed-in user with no profile hitting a profile-only route redirects correctly.

**Mobile, both themes, needs a new EAS dev-client build** (`expo-location` joined the native
dependency list, see the launch checklist above):
- The deck opens on the Discover tab and swiping advances cards.
- Audio swaps to the new card's preview on swipe.
- Mute persists across an app relaunch.
- Location permission Allow shows distances on cards; Not now leaves them off.
- A permanently-denied location permission opens the Settings app from the deck's empty state
  (not a dead button).
- The List toggle flips between Shows and Artists and back.
- Follow works from every card kind (deck card, Shows list row, Artists list row).
- Unfollowing from the Following screen removes the target immediately.
- The venue screen renders a curator profile correctly.
- Each notification kind deep-links to the right place on tap: show announced, show rescheduled,
  a new post, and new music from someone followed.
- The show-post composer's caps hold: 3 posts per event, one post per 10 minutes.

### Sub-project 8 launch checklist (search)

- **New composite indexes deploy with `firebase deploy`**: sub-project 8 adds 7 composite indexes
  to `firestore.indexes.json` (5 `searchIndex`, 2 `savedSearches`):
  - `searchIndex (kind, tokens ARRAY_CONTAINS, startsAt)`
  - `searchIndex (kind, tokens ARRAY_CONTAINS, followerCount desc)`
  - `searchIndex (kind, startsAt)`
  - `searchIndex (kind, followerCount desc)`
  - `searchIndex (kind, endsAt)`
  - `savedSearches (kind, createdAt)`
  - `savedSearches (uid, createdAt desc)`

  Same caveat as every prior sub-project's indexes: the emulator does not enforce composite
  indexes, so a green `pnpm emu:test`/`pnpm emu:rules` proves nothing about them, confirm they
  build on the real project (Firebase console → Firestore → Indexes) after the first deploy before
  search, ranking, and saved-search queries that depend on them will work in production.
- **Run "Rebuild search index" from `/admin` once after the first functions deploy.** The
  `backfillSearchIndex` callable walks every eligible profile, gig, and event into `searchIndex`;
  after that, the create/update/delete triggers keep it current on their own.
- **Web: set `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` on the web host** (Maps JavaScript API enabled,
  HTTP-referrer restricted); the results map toggle stays hidden without it.
- **Mobile: replace `REPLACE_WITH_ANDROID_MAPS_KEY` in `app.json`** with a Maps SDK for Android key
  restricted by package name and signing certificate, then a new EAS dev build
  (`npx eas-cli build --profile development --platform all`), react-native-maps joined the native
  dependency list this sub-project.
- Confirm `LAUNCH_TIMEZONE`.

### Sub-project 8 smoke checklist (search)

Sub-project 8 opens text search across profiles, gigs, and events: a fan/musician/curator search
experience on both platforms, a results map behind the Maps key, saved searches with match alerts,
and an SEO pack (sitemap, robots, JSON-LD, lowercase handle redirects).

**Web, both themes:**
- Fan face: the search box returns results for a query that matches a show's title, a lineup act's
  name, or its venue or neighborhood, and each filter chip narrows them.
- The map toggle and pin tap work when `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` is set.
- Musician face (`/gigs`): the Gigs and Venues segments both return results, and each face's own
  filter chips narrow the list (the gig detail's apply sheet has no filters of its own).
- Curator face: the musicians directory filters work, including "Free on".
- Save a search, see it on the dashboard, delete it.
- Publish an event or gig that matches a saved search and receive the `saved_search_match` alert.
- `sitemap.xml` and `robots.txt` render at the site root.
- A mixed-case handle in a profile URL redirects to the lowercase canonical.
- A musician portfolio's home city field saves and reflects in results (only the musician
  portfolio has one; the curator editor has no home city field).

**Mobile, both themes, needs a new EAS dev-client build** (`react-native-maps` joined the native
dependency list, see the launch checklist above):
- Fan Search tab: text plus each chip returns results, and the map toggle and pin tap work.
- Musician Find Gigs tab: the Gigs and Venues segments both return results with the apply sheet.
- Curator Find Musicians tab: filters work, including "Free on".
- Save a search, see it under the hidden Account tab, delete it.
- Receive a push for a `saved_search_match` alert and tap it to the matching result.
- Portfolio home city field saves on the musician editor (the curator editor has no home city
  field).

### Sub-project 5c launch checklist (payout splits)

- **Deploy the four new composite indexes** in `firestore.indexes.json`:
  - `heldShares (uid, status)`
  - `heldShares (profileId, status)`
  - `ledger (profileId, at)`
  - `ledger (uid, at)`

  Same caveat as every prior sub-project's indexes: the emulator does not enforce composite
  indexes, so confirm all four show Enabled in the Firebase console after `firebase deploy --only
  firestore:indexes`.
- **Confirm the Connect webhook endpoint delivers `account.updated`, `payout.paid`, and
  `payout.failed` for user-owned accounts.** Same endpoint as sub-project 5's "Connected accounts"
  scope; no new webhook subscription is needed.
- **`APP_ORIGIN` covers `/dashboard/payouts/onboarding/return` and `/refresh`.** Member payout
  onboarding returns to these web pages the same way musician onboarding does.
- **Real Stripe test-mode smoke.** Onboard a member, set shares on a band, settle a booking and a
  ticketed event, watch the split legs and a held release, cash out as the member (standard and
  instant), report a no-show and confirm only the band's leg reverses.

### Sub-project 5c smoke checklist (payout splits)

Sub-project 5c adds admin-set member payout shares split at settlement, a held-share release path
for a member not yet payout-ready, a member "Your payouts" surface, and per-order ticket
settlement.

**Both platforms, both themes:**
- Shares editor: set and save shares as a profile admin; a non-admin member sees the same shares
  read-only.
- The held line appears whenever a member's leg cannot be transferred yet.
- Member "Your payouts" surface end to end: onboarding, balance, held money, standard and instant
  cash-out.
- History paging loads a second page of ledger rows.
- The curator's history shows one settlement row per paid order for a ticketed event.
- Each payout notification kind (`share_paid`, `share_held`, `share_released`,
  `member_payout_failed`) deep-links to the payouts surface on tap.

### Sub-project 11 launch checklist (SP7 reconciliation)

- **Choose the domain and replace `REPLACE_WITH_LINK_DOMAIN`** in `app.json` (associated domains
  and the intent filter).
- **Set `NEXT_PUBLIC_SITE_URL` and `EXPO_PUBLIC_SITE_URL`** so both platforms' Share buttons build
  real links.
- **Set the four verification env values** (`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`,
  `ANDROID_CERT_SHA256`) on the web host, then confirm both well-known URLs resolve with a 200 and
  the right JSON.
- **A new EAS build.** Associated domains and intent filters are native config; no dev-client
  reload picks them up.
- No new composite index and no new Stripe configuration in this sub-project.

### Sub-project 11 smoke checklist (SP7 reconciliation)

Sub-project 11 adds sharing and deep links, web location plus the home-city fallback, the account
editor, doors and age fields, and artist tags on the lineup.

**Both platforms, both themes:**
- Share from the web event page and profile page (native share sheet where supported, clipboard
  fallback otherwise) and from all three mobile screens (event, artist, venue).
- Open a shared `/e/` and `/u/` link cold and warm on device.
- Tag an artist on a draft, publish, and accept from the other account; confirm the artist page,
  search index, a show post, and the follower announce. Then tag a second artist, decline it, and
  untag a third: both render as plain names and neither reaches the artist page.
- Edit a display name and confirm a new ticket carries it while an old ticket keeps its name.
- Set a home city and confirm Discover ranks by it with location off, on both web and mobile;
  confirm "Ranked near {city}" links to the account card.
- Set doors and an age on an event and confirm the line and the badge on both platforms, the
  "All ages only" filter, and `doorTime` in the web event page's JSON-LD (view source).
- Save a search with "All ages only" and confirm a new all-ages show alerts while an 18+ show
  does not.
- Confirm the well-known files resolve on the production domain.

### Sub-project 2 polish follow-ups (non-blocking)

Smaller items from the sub-project 2 quality-review rounds, recorded in full in
`docs/superpowers/plans/2026-08-25-musician-portfolio.md`'s Task 16 section; summarized here:

- **Public portfolio page** (web, Task 10): resolve Storage download URLs at write time instead
  of on every SSR render; split a public route group without the client-side auth bundle the page
  never uses (~1.2MB JS); add `sitemap.ts`/`robots.ts` once something links to `/@handle`
  elsewhere in the app; wire server-side Sentry (`instrumentation.ts`) once DSNs exist.
- **Editor/admin polish** (web, Task 11): `Promise.allSettled` (not `Promise.all`) for the admin
  tracks-queue snapshot callback so one bad profile read doesn't drop the whole update; replace
  `window.alert`/`confirm`/`prompt` in the editor/wizard with a shared toast/modal primitive; add
  an upload cancel button + `beforeunload` guard to `TrimUploader`/`PhotoUploader`; an
  accessibility pass (`aria-pressed`, label/id pairing, focus-visible); positive save-success
  feedback, not just failure alerts. `deleteProfile` being draft/rejected-only is enforced
  server-side (`functions/src/profiles.ts` checks the profile's status after `requireProfileAdmin`
  and throws `failed-precondition` otherwise), not just a client-side UI convention as earlier
  drafts of this doc described. An approved or pending-review profile must go through
  `reviewProfile`'s reject decision (which also supports retroactive unpublish of an already-live
  profile) before it becomes deletable; revisit only if support requests show a real need for
  self-service delete straight from a live profile.
- **`TrimUploader` native streaming** (mobile, Task 13): `upload()` currently reads the whole
  picked file into memory via `fetch().blob()` before handing it to `uploadBytesResumable`.
  Switch to `expo-file-system`'s `uploadAsync` for native streaming (no full-file `Blob`
  materialized in JS), then lift the mobile-only 25MB cap (`MOBILE_MAX_AUDIO_BYTES`) back toward
  the server's 50MB limit.
- **`ProfileContext`** (mobile, Task 14): `switchTo`'s caller-supplied `ProfileSummary` (used by
  the join wizard so the portfolio tab has an active profile before the `myProfiles` listener
  notices the new membership) is never reconciled against the listener's own copy once it arrives:
  not a live bug today, but a footgun for the next caller of `switchTo`. Separately, the
  logout-reset effect is a deliberate choice (see the comment above it) rather than the
  render-time sentinel pattern used elsewhere on this screen (web's `bookingProfileId`, mobile's
  `baseline`/`lastProfileId`), revisit if that inconsistency ever causes a real bug.

## Design docs

Each sub-project has a spec (binding over its plan), a plan (a historical execution record; its
snippets may predate review fixes), and a rulings doc that is the authority for its area.
`docs/superpowers/HANDOFF.md` is the fresh-session entry point, `DESIGN.md` at the repo root is the
brand contract binding on all UI work, and `docs/superpowers/foundation-rulings.md` holds the
sub-project 1 rulings.

| Sub-project | Spec | Plan | Rulings | Merged |
|---|---|---|---|---|
| 1 Foundation | `docs/superpowers/specs/2026-08-24-foundation-design.md` | `docs/superpowers/plans/2026-08-24-foundation.md` | `docs/superpowers/foundation-rulings.md` | 2026-08-25 |
| 2 Musician portfolio | `docs/superpowers/specs/2026-08-25-musician-portfolio-design.md` | `docs/superpowers/plans/2026-08-25-musician-portfolio.md` | `docs/superpowers/sp2-rulings.md` | 2026-08-26 |
| 3 Curator profiles and gigs | `docs/superpowers/specs/2026-08-26-curator-gigs-design.md` | `docs/superpowers/plans/2026-08-26-curator-gigs.md` | `docs/superpowers/sp3-rulings.md` | 2026-08-26 |
| 4 Booking flow | `docs/superpowers/specs/2026-08-26-booking-flow-design.md` | `docs/superpowers/plans/2026-08-26-booking-flow.md` | `docs/superpowers/sp4-rulings.md` | 2026-08-27 |
| 5 Payments | `docs/superpowers/specs/2026-08-27-payments-design.md` | `docs/superpowers/plans/2026-08-27-payments.md` | `docs/superpowers/sp5-rulings.md` | 2026-08-28 |
| 5b Mobile payments | `docs/superpowers/specs/2026-08-28-mobile-payments-design.md` | `docs/superpowers/plans/2026-08-28-mobile-payments.md` | `docs/superpowers/sp5b-rulings.md` | 2026-08-28 |
| 9A Web UI/UX | `docs/superpowers/specs/2026-08-28-web-uiux-design.md` | `docs/superpowers/plans/2026-08-28-web-uiux.md` | `docs/superpowers/sp9a-rulings.md` (mocks in `docs/superpowers/mocks/sp9a/`) | 2026-08-29 |
| 9B Mobile UI/UX | `docs/superpowers/specs/2026-08-29-mobile-uiux-design.md` | `docs/superpowers/plans/2026-08-29-mobile-uiux.md` | `docs/superpowers/sp9b-rulings.md` | 2026-08-29 |
| 6 Events and ticketing | `docs/superpowers/specs/2026-08-30-events-ticketing-design.md` | `docs/superpowers/plans/2026-08-30-events-ticketing.md` | `docs/superpowers/sp6-rulings.md` | 2026-08-31 |
| 7 Fan discovery | `docs/superpowers/specs/2026-09-02-fan-discovery-design.md` | `docs/superpowers/plans/2026-09-02-fan-discovery.md` | `docs/superpowers/sp7-rulings.md` | 2026-09-02 |
| 10 Hardening | `docs/superpowers/specs/2026-09-02-hardening-design.md` | `docs/superpowers/plans/2026-09-02-hardening-sweep.md` (branch A) and `docs/superpowers/plans/2026-09-02-hardening.md` (branch B) | `docs/superpowers/sp10b-rulings.md` (branch B Task 34; covers both branches) | 2026-09-09 |
| 8 Search | `docs/superpowers/specs/2026-09-02-search-design.md` | `docs/superpowers/plans/2026-09-02-search.md` (19 tasks) | not yet executed (no rulings doc) | docs merged 2026-09-03 |

The whole-project audit that sourced sub-project 10: `docs/superpowers/audit-2026-09-01.md`, with
the detail reports in `docs/superpowers/audit/`.

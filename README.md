# GateKeep

GateKeep connects musicians, event curators (venues, planners, hosts), and fans in a single
metro area — team-approved musician/curator profiles, gig booking, and (later) ticketing — built
on a shared Firebase backend behind default-deny Firestore rules and Cloud Functions-only
privileged writes.

This repo now spans three sub-projects. **Sub-project 1: Foundation** — accounts, auth, profile
lifecycle (draft → review → approve), the mobile + web app shells, an admin approval dashboard,
and notification plumbing. **Sub-project 2: Musician Portfolio** — bio/photos/genres/links,
10×30s reviewed audio snippets with server-side trim/transcode, curator-gated booking rates &
preferences, and server-rendered public portfolio pages at `/@handle`, on both mobile and web.
**Sub-project 3: Curator Profiles & Gig Postings** — the curator side of the same profile system
(venues/planners/hosts get the wizard/photos/public-page treatment too), one-off and recurring gig
postings with budget/location privacy semantics, a shared daily scheduled job that materializes
recurring series and pays down sub-project 2's cleanup debt, and admin gig moderation + name
search. **Sub-project 4: Booking Flow** — curators and musicians book each other through either
door (apply to an open gig / offer a gig directly), negotiate over a capped counter-offer thread,
and accepting freezes terms + records a 35% deposit as data (no money moves yet); cancellation
windows, no-show reliability records, musician-controlled booking visibility, and whole-run series
booking all land on top of sub-project 3's gig/series model. See "Gigs & series" and "Booking flow"
below for the concepts, and `docs/superpowers/specs/` / `docs/superpowers/plans/` for each
sub-project's design spec and implementation plan (exact filenames under Design docs below).

## Monorepo map

```
GateKeepBeta/
├── package.json                  # workspace root, scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict TS config
├── firebase.json                 # emulators (incl. storage :9199), functions, firestore config
├── .firebaserc                   # default Firebase project id
├── firestore.rules               # default-deny + narrow allows
├── firestore.indexes.json
├── storage.rules                 # Storage security rules (staging/review/public paths)
├── packages/shared/              # @gatekeep/shared: types + validation, single source of truth
│   └── src/{types,validation,storagePaths,index}.ts
├── functions/                    # Cloud Functions (v2 callables + triggers)
│   ├── src/index.ts              # exports all functions
│   ├── src/authTriggers.ts       # onUserCreated → users doc
│   ├── src/guards.ts             # requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile, requireCuratorProfile
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview, deleteProfile
│   ├── src/review.ts             # reviewProfile, grantAdmin, audit logging, curator-unpublish takedown cascade
│   ├── src/members.ts            # inviteMember, respondToInvite, revokeInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount
│   ├── src/notifications.ts      # push token helpers, notifyUser, approval trigger
│   ├── src/portfolio.ts          # updatePortfolio, updateBookingInfo
│   ├── src/tracks.ts             # createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack
│   ├── src/media.ts              # processUpload trigger: ffmpeg transcode + sharp photo resize (musician + curator gallery)
│   ├── src/curator.ts            # updateCuratorProfile, removeCuratorPhoto (sub-project 3)
│   ├── src/geocode.ts            # geocode(address) adapter interface + Stub/Google providers (sub-project 3)
│   ├── src/gigs.ts               # createGig, updateGig, publishGig, cancelGig, takedownGig (sub-project 3)
│   ├── src/gigSeries.ts          # createSeries, updateSeries, pauseSeries, endSeries (sub-project 3)
│   ├── src/scheduled.ts          # runDailySweep + dailySweep onSchedule wrapper (sub-project 3 — see Gigs & series below)
│   ├── src/adminTools.ts         # searchUsersByName, backfillDisplayNameLower, flagAccount (sub-project 3)
│   ├── src/storage.ts            # Storage bucket helper + STORAGE_BUCKET
│   └── test/*.test.ts            # emulator integration tests
├── apps/mobile/                  # Expo (expo-router): app/, src/lib/firebase.ts, src/auth/, src/shell/
│   ├── eslint.config.js          # flat config (Expo's `eslint-config-expo` default)
│   ├── src/shell/AccountScreen.tsx # shared account screen; app/(fan|musician|curator)/account.tsx are thin wrappers
│   ├── src/portfolio/            # RN portfolio editor: forms, TrimUploader, TrackManager
│   ├── src/curator/              # RN curator wizard/editor forms (sub-project 3)
│   ├── src/gigs/                 # RN gig composer + series management (sub-project 3)
│   ├── app/(curator)/            # curator tab group: dashboard, events (gig composer/list/series), account
│   └── app/artist/[handle].tsx   # native public portfolio view
├── apps/web/                     # Next.js (App Router): app/, src/lib/firebase.ts, app/admin/ (claim-gated)
│   ├── app/join/                 # musician + curator onboarding wizard
│   ├── app/dashboard/portfolio/  # portfolio editor page
│   ├── app/dashboard/curator/    # curator editor + gig composer/list + series management (sub-project 3)
│   ├── app/u/[handle]/           # server-rendered (SSR) public portfolio/curator page + open gigs
│   ├── src/curator/CuratorForms.tsx # curator editor form sections (sub-project 3)
│   └── src/gigs/GigForms.tsx     # gig composer + series form sections (sub-project 3)
└── tests-rules/                  # Firestore + Storage security rules emulator tests
```

`packages/shared` owns every cross-boundary type and validation rule — functions and both apps
import from it, nothing redefines a shape locally. `functions` owns every privileged mutation.
Apps own UI and only ever read Firestore directly or call callables.

## Prerequisites

- **Node 20+** and **pnpm 9+** (repo pins `pnpm@11.23.0` via `packageManager`). If `pnpm` isn't on
  `PATH` yet on a machine without admin rights (Windows): `corepack enable --install-directory
  "$env:LOCALAPPDATA\Microsoft\WindowsApps"`.
- **`pnpm --filter @gatekeep/web exec next typegen`** — run once per fresh clone. It generates the
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
npx expo start                        # from apps/mobile: Expo dev server (use a dev build — Expo Go
                                       # cannot do native Google/Apple sign-in)

pnpm --filter @gatekeep/web lint      # ESLint (apps/web)
pnpm --filter @gatekeep/mobile lint   # ESLint (apps/mobile) — green as of sub-project 2 (see Task 15
                                       # of the SP2 plan); first run scaffolds apps/mobile/eslint.config.js
```

**Known issue:** the Expo **web** target (`expo start --web` / `apps/mobile` web output) is
currently broken (tslib/SSR interop error in `react-native-web`). Use native targets (iOS/Android
dev build) or the Next.js app (`apps/web`) for web.

**Troubleshooting — functions "not found" from the emulator:** `pnpm emu` (and `emu:test`/
`emu:rules`) can print `All emulators ready!` and still leave one or more functions unregistered
if the Functions emulator's discovery step — which has to `require()` every module under
`functions/src`, including the native `sharp`/`ffmpeg-static`/`ffprobe-static` dependencies added
in sub-project 2 — takes longer than its default 30s window. The symptom is a working emulator UI
but calls to the affected callable(s) failing as if the function doesn't exist. This machine needs
the override; set it before any emulator command:

```bash
export FUNCTIONS_DISCOVERY_TIMEOUT=60      # bash, seconds; raises the 30s default
```

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT = "60"    # PowerShell
```

## Gigs & series (sub-project 3)

**Concepts.** A `gigs` doc is one dated posting (title, budget, wants, location, one of
`draft`/`open`/`closed`/`cancelled`/`taken_down`) that only an approved curator profile's members
can create, always via a callable (`createGig`/`updateGig`/`publishGig`/`cancelGig`) — clients
never write `gigs` directly. A `gigSeries` doc is a recurring template (weekly/biweekly/monthly)
that the daily scheduled job (below) materializes into individual `gigs` occurrences up to 8 weeks
ahead; editing a series' template applies only to future, not-yet-detached occurrences, and any
occurrence can be edited independently (which detaches it from the template). Location privacy is
per-gig: non-venue gigs default to `addressVisibility: "neighborhood"` with a coarsened public
`geo`, while the exact address always lives in the callable/admin-only `gigs/{id}/private/location`
subdoc; venue-profile gigs default to `"public"` (full address shown). Budgets are stored as
integer `amountCents` under one of the three `BookingRates` structures (`perHour`/`perSong`/
`perSet`) — never floating-point dollars.

**Key flows.** Curator onboarding is the same wizard/review pipeline as musicians (draft → submit
→ admin `reviewProfile` approve/reject), plus curator-specific required content (photos, location,
looking-for preferences) gating submission. Once approved, the curator dashboard's gig composer
posts one-off or series gigs; a public curator page at `/@handle` (web) / the native equivalent
(mobile) renders the curator's approved, `open` gigs at their public precision. Admins get a
**Gigs** section in `/admin` for moderation (status/subtype filters, takedown with an
occurrence-vs-series choice), plus name search (`searchUsersByName`) and account flags
(`flagAccount`) layered onto the existing profile review queue.

**The daily scheduled job** (`functions/src/scheduled.ts`'s `dailySweep`, wrapping the plain
`runDailySweep(now)` function tests call directly) runs once a day and does five things in one
pass: (1) materializes new occurrences for every `active` gigSeries up to the 8-week horizon, (2)
closes `open` gigs whose `startsAt` has passed, (3) fails abandoned `processing` tracks older than
24h (pays down sub-project 2's reaper debt), (4) revokes `pending` invites past their 14-day
expiry, and (5) retries any `curatorAccessRetries/{uid}` entry left by a `syncCuratorAccess` call
that failed at its original touchpoint. **This only runs in production after `firebase deploy`
enables the underlying Cloud Scheduler job** — the emulator has no scheduler component, so
`runDailySweep` is exercised directly by tests locally, never on a timer. See the launch checklist
below for the UTC-recurrence and timezone caveats that affect exactly when a series' occurrences
land.

Each of the five steps runs in its own try/catch with its own chunked batch writer — a poisoned
doc in one step (a malformed series, say) is logged and counted in `SweepReport.errors`, but never
prevents the other four steps from running, and each step's own writes are only lost if THAT
step's own commit never happens (a healthy step's commit is unaffected). Steps 1 and 3-5 also page
through their collections (100 series/page, 500 docs/page for the rest) rather than issuing one
unbounded `.get()`, and step 1 additionally skips (and counts) a series whose profile is already
at the `MAX_OPEN_GIGS_PER_PROFILE` cap, or whose status changed between the initial scan and that
series' write. `dailySweep`'s `onSchedule` options set `timeoutSeconds: 540` and
`memory: "512MiB"` (up from the 2nd-gen defaults) to give this real headroom at scale.

## Booking flow (sub-project 4)

**Concepts.** A `bookings/{id}` top-level doc is the one record of a musician↔curator booking
relationship, created through either door — `applyToGig` (musician quotes on an `open` gig) or
`offerGig` (curator quotes to a musician) — and mutated only via callables (clients never write
`bookings`). Both doors produce the same shape: an embedded `thread: OfferEntry[]` (capped at 50
entries) carries structured counter-offers (amount, expected quantity, ≤280-char note — **terms
only, no free chat**), with `awaitingSide` tracking whose turn it is; `counterBooking` appends and
flips the turn, `declineBooking`/`withdrawBooking` close it out. `acceptBooking` is the fill
transaction: it freezes the last thread entry into `acceptedTerms`, records a 35% deposit
(`computeDepositCents`, integer cents, `Math.ceil`) as **data** (`status: "unpaid"` — sub-5 wires
real money), flips the gig `open → filled` with `bookingId`/`bookedMusicianProfileId` linkage, and
auto-supersedes rival open bookings on the same gig. Cancellation windows are measured strictly
against gig start: curator cancels **< 72h** before start → deposit forfeits to the musician (≥72h
→ refunds); musician cancels **< 24h** before start → refunds the deposit but appends an automatic
`late_cancel` reliability mark. A curator can also `reportNoShow` after the fact (once per booking,
within 14 days), which appends a `reported_no_show` mark; admins can `removeReliabilityMark` on a
disputed mark (audit-preserving — the mark stays, just flagged `removedByAdmin`, never spliced).
Reliability is a curator-facing summary count only (`noShowCount`/`completedCount`), never public.

**Musician-controlled visibility** resolves sp3-rulings' M-12/M-13: booking rates are **never
public** — each rate structure (`perHour`/`perSong`/`perSet`) is independently `"curators"` or
`"private"`, and the preferences block is independently `"public"` or `"curators"`. The source of
truth (`profiles/{id}/private/booking`) now reads member/admin-only (curators lost their old
blanket read); `updateBookingInfo` and `bookingVisibility.ts`'s `rebuildBookingProjections` fan
each save out to two server-built projections in the same batch: `profiles/{id}/private/curatorBooking`
(rates with any `"private"`-marked structure nulled out, full preferences, the reliability summary
— **this projection is the curator-facing surface**, readable by curatorAccess holders + members +
admins) and `ProfileDoc.publicBooking` (the preferences object, only when `preferences: "public"`,
else `null` — rendered on the public portfolio page, rates never appear here regardless of
visibility). `profiles/{id}/private/reliability` stays member/admin-only.

**Whole-run booking** consumes sub-project 3's `fillMode`: a booking on a `whole_run` series'
occurrence carries that `seriesId`, and accepting it fills every currently-`open` occurrence plus
stamps the series (`activeBookingId`/`bookedMusicianProfileId`) so the daily sweep's materializer
births future occurrences pre-`filled` (skipping the open-gig cap for that committed work).
Deposits and cancellation windows are **per occurrence** — `cancelOccurrence` pulls one date off a
run without ending the booking; `cancelBooking`/`reportNoShow` on a whole-run booking evaluate only
against the run's next affected occurrence (one forfeiture / one mark max) and unwind future filled
dates back to `open`.

**Shows sections are now live** — the SP2 "platform events only" contract fulfilled: both public
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
client-side filters, by design — sub-project 8 (full search: text search, ranking, maps, saved
searches/alerts) replaces both directories' query internals; nothing here should be treated as the
long-term shape.

**Sub-5 handoff (settlement inputs this sub-project produces, doesn't consume).** `BookingDeposit.status`
is `"unpaid"` today; sub-5 adds `"held" | "refunded" | "forfeited"` and wires the state machine to
real money. Settlement math starts from the frozen `acceptedTerms` (`amountCents`,
`expectedQuantity`, `expectedTotalCents`) — sub-5 recomputes overtime for `perHour` and a
count-true-up for `perSong` from that snapshot, per occurrence for whole-run bookings.
`occurrenceCancellations` (whole-run per-date cancellation records, capped at
`MAX_OCCURRENCE_CANCELLATIONS`=100) are themselves settlement inputs — a full 100-entry array is a
**tripwire** sub-5 must alarm on, not silently drop-oldest (unacceptable for money-adjacent
records, unlike the sweep's own drop-oldest reliability-mark idiom). A booking-linked gig that
ends up `taken_down` (an admin pulled that one date off a still-confirmed whole-run booking, per
`gigs.ts`'s `takedownGig` occurrence scope) settles as **not performed** — the completion sweep
(step 7) deliberately excludes it from the "filled linked occurrence" set it uses to decide
completion, and that same **filled-linked-gigs set is the intended per-occurrence settlement
basis** for sub-5 to walk. A booking that resolves to `expired` with a non-null `deposit` (gig/series
takedown or profile-reject cascades, i.e. moderation, nobody's fault) reads as a **refund**, no
forfeiture either way. When a deposit does forfeit, it goes to the **musician**
(`deposit.forfeitedTo: "musician"`) — whether the platform carves out a fee from that forfeiture is
explicitly left as sub-5's decision, not decided here.

**Sub-8 note:** both discovery directories above are placeholder-grade by design; sub-8 replaces
their internals wholesale (see "Directories are placeholder-grade" above).

**Scale/hardening follow-ups recorded for later sweeps of this code** (none block v1, all
identified during Task 8/13's review rounds):
- **Materializer birth-decision race**: a `cancelBooking` landing between the sweep's step-1
  per-series read and that step's end-of-step commit can yield `filled` gigs linked to a
  non-`confirmed` booking, with no reconciling sweep step today — accepted at v1 given the low
  probability of hitting exactly that daily-sweep window; fix menu for whoever revisits it: a
  filled-linkage sanity-check step, or per-series batches guarded by a `lastUpdateTime`
  precondition.
- **Sweep step 6 (booking expiry)** reads each `open` booking's gig with a separate `get()`;
  batching those reads via `db.getAll()` per page would cut round-trips at scale.
- **`inviteMember`/`respondToInvite` guard gaps** (inherited from sub-project 3's Task 13 deferred
  list, still open): `inviteMember` lacks an `isValidDocId(profileId)` guard; `respondToInvite`
  validates `inviteId` by existence only, not shape.
- **`functions/test/` helper duplication**: `bookings.test.ts`, `bookingLifecycle.test.ts`, and
  `scheduled.test.ts` each carry their own near-identical copies of `makeApprovedCuratorProfile`/
  `makeApprovedMusicianProfile`/`createOpenGig`/`gigContent`/`offerPayload`/`pollNotifications`/
  `seedSeries` rather than sharing them from `functions/test/helpers.ts` — worth consolidating the
  next time one of those files is touched.

## Environment variables

None are required for local development against the emulators — everything below is unset (empty
string / no-op) by default and only matters for a production deploy.

| Variable | App | Purpose | Default when unset |
|---|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | web | reCAPTCHA v3 site key for Firebase App Check | App Check init skipped |
| `NEXT_PUBLIC_SENTRY_DSN` | web | Sentry DSN for crash/error reporting | Sentry init skipped (no-op) |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile | Sentry DSN for crash/error reporting | `Sentry.init` runs with an empty DSN and is a no-op |
| `NEXT_PUBLIC_SITE_URL` | web | absolute base URL for the public portfolio page's canonical link + OpenGraph `og:url`/images (`apps/web/app/layout.tsx`'s `metadataBase`) | falls back to Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` if present; if neither is set, `metadataBase` is omitted and those URLs render relative instead of absolute (never a hardcoded localhost fallback) |
| `GEOCODER_PROVIDER` | functions | set to `google` to geocode gig/curator addresses via the real Google Geocoding API (`functions/src/geocode.ts`'s `getGeocoder()`) | unset/any other value → `StubGeocoder`, a deterministic dev/test-only hash-based geocoder with a US-centric bounding box — **launch item**, see checklist below |
| `GEOCODER_API_KEY` | functions | Google Geocoding API key; required (throws at call time) when `GEOCODER_PROVIDER=google` | n/a while `GEOCODER_PROVIDER` is unset |

Web App Check only initializes when `NODE_ENV === "production"` **and** the site key is set
(`apps/web/src/lib/firebase.ts`). Mobile Sentry is additionally gated on `!__DEV__`
(`apps/mobile/app/_layout.tsx`), so it never fires in a dev build regardless of the DSN.

### Geocoder secret setup (production)

`GEOCODER_API_KEY` is a [`defineSecret()`](https://firebase.google.com/docs/functions/config-env#secret-manager)
param (`functions/src/geocode.ts`'s `geocoderApiKey`), Secret Manager-backed rather than a bare env
var — the v2 Cloud Functions mechanism that actually makes a secret available at invocation time in
production. Setting it up:

1. `firebase functions:secrets:set GEOCODER_API_KEY` (prompts for the value, stores it in Secret
   Manager, grants the functions service account access).
2. Deploy — every onCall that can trigger a geocode (`updateCuratorProfile`, `createGig`/
   `updateGig`, `createSeries`/`updateSeries`) already declares `secrets: [geocoderApiKey]` in its
   `onCall` options, which is what makes Cloud Functions inject the secret as
   `process.env.GEOCODER_API_KEY` for that function at runtime. A new onCall that needs to geocode
   must add the same `secrets: [...]` entry or the key will silently resolve to empty in production.

**Emulator/local dev fallback**: the Functions emulator does not provision Secret Manager secrets by
default, so `geocoderApiKey.value()` legitimately returns `""` there. `getGeocoder()` falls back to
a bare `process.env.GEOCODER_API_KEY` read in that case — set it via a `functions/.env` file (or
your shell) to test `GEOCODER_PROVIDER=google` against a real key locally without deploying.

**Daily geocode budget**: every address-resolving call also consumes a per-uid daily budget
(`geocodeBudgets/{uid}`, `functions/src/geocode.ts`'s `consumeGeocodeBudget`) — 50 geocode calls per
uid per UTC calendar day, `resource-exhausted` ("Too many location updates today.") past the
ceiling. A caller re-submitting the exact same address/city it already resolved is NOT charged
again (the geocoded location is reused as-is via the stored `geocodedFrom` string) — only a
genuinely new query consumes the budget. `geocodeBudgets/{uid}` is internal bookkeeping,
`allow read, write: if false` in `firestore.rules` for every client including the owner.

Set `FIREBASE_EMULATORS=1` to run a production build of the web app (`next build && next start`)
against the local emulators instead of real Firebase — `apps/web/src/lib/firebase-server.ts`'s
server-side (RSC) Firebase client otherwise only targets the emulators when
`NODE_ENV !== "production"`.

## Manual follow-ups (not automatable / require console access)

These are tracked gaps, not bugs — the app is unblocked without them, but they must be done
before a real launch:

- **Firebase console → Authentication → Sign-in method**: enable Email/Password, Google, and
  Apple providers on the `gatekeep-dev-jg` project (and again on whatever project id production
  uses).
- **Firebase console → App Check**: register the web app with **reCAPTCHA v3** (produces the
  value for `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`) and the mobile apps with **Play Integrity**
  (Android) / **App Attest** (iOS). Keep enforcement in **monitor mode** for Firestore, Functions,
  **and Cloud Storage** until both stores' builds exist, then flip to **enforce** as a
  launch-checklist item — **Storage must not be flipped to enforce before native mobile App Check
  ships**: mobile has no App Check attestation client code today, and enforcing early would lock
  the app out of its own uploads. Mobile ships v1 in monitor mode via the console only — no native
  App Check client code; native attestation (`@react-native-firebase/app-check`) and the EAS
  production build that carries it are **out of sub-project 2's scope** (superseding the earlier
  plan of landing them there) and now live in a dedicated launch-prep track (SP2 spec §1), on the
  same must-review-before-launch list as the sub-project 1 admin/internal deferred items below.
- **`apps/mobile/src/auth/config.ts` — `GOOGLE_WEB_CLIENT_ID`**: currently a
  `REPLACE_FROM_FIREBASE_CONSOLE...` placeholder. Get the real web client ID from Firebase console
  → Authentication → Sign-in method → Google → Web SDK configuration, and set it there before
  Google sign-in works on-device.
- **Sentry DSNs**: no Sentry account/project exists yet. Create one free project per app (or one
  project, two DSNs), then set `NEXT_PUBLIC_SENTRY_DSN` (web) and `EXPO_PUBLIC_SENTRY_DSN`
  (mobile) in each app's deploy/build environment. Both apps typecheck, lint, and build cleanly
  with these unset — crash reporting is simply inert until then.
- **EAS `projectId`**: `apps/mobile/src/notifications/push.ts` reads
  `Constants.expoConfig?.extra?.eas?.projectId` for push token registration. Run `eas init` (or
  set `expo.extra.eas.projectId` in `apps/mobile/app.json` manually) once an EAS project exists;
  this also unblocks the EAS production build in the launch-prep track above.
- **EAS build setup (in progress, 2026-08-27)**: `apps/mobile/eas.json` (development/preview/
  production profiles; preview builds an installable Android APK) and the app identifiers
  (`com.gatekeep.app` for both `android.package` and `ios.bundleIdentifier`) are committed. Still
  manual: `eas login` + `eas init` against the org account; Firebase console → add an **Android
  app** (package `com.gatekeep.app`) → download `google-services.json` into `apps/mobile/` and add
  the EAS keystore's SHA-1 (`eas credentials`) to it (Google Sign-In fails on-device without it);
  add an **iOS app** (bundle `com.gatekeep.app`) → `GoogleService-Info.plist` likewise; then set
  `android.googleServicesFile` / `ios.googleServicesFile` in `app.json` once the files exist.
  iOS on-device builds additionally require Apple Developer Program enrollment (dev builds under a
  personal Apple ID are fine; store publication waits for the business identity per the ruling in
  `docs/superpowers/sp4-rulings.md`'s launch notes). Stripe: a personal-entity TEST-MODE account
  exists (2026-08-27); keys live outside the repo — sub-5 wires `sk_test` via `defineSecret()`
  (the `GEOCODER_API_KEY` pattern). Never activate live mode or Connect onboarding under the
  personal entity.
- **Deploy-time `workspace:*` resolution**: `functions/package.json` depends on
  `@gatekeep/shared` via `"workspace:*"`. Before relying on `firebase deploy --only functions`,
  verify that command actually resolves the workspace dependency into a deployable package (rather
  than failing or publishing a broken reference) — this hasn't been exercised yet, only
  `pnpm --filter functions build` against the local workspace symlink.
- **App Check enforcement is two changes, not one**: flipping Firestore/Functions App Check from
  monitor to enforce mode in the console does **not** by itself make callables reject
  unattested requests — each `onCall` also needs `enforceAppCheck: true` in its handler options
  (a code change in `functions/src/*.ts`). Both must land together at the launch-checklist step
  called out above, or enforcement is a no-op for callables. Cloud Storage doesn't have this
  second step — its enforcement toggle applies directly — but it still can't flip until native
  mobile App Check ships, per the bullet above.
- **Content takedown is a two-step for a full scrub**: an admin unpublishing an approved profile
  (`reviewProfile` reject, or the admin "Unpublish profile" button) instantly removes it from
  discovery — the public page 404s and Storage listing is denied — but deliberately leaves the
  transcoded clips and photos in the `public/` bucket, because the same reject path is also the
  routine "please revise and resubmit" flow (scrubbing them would force a full re-upload on
  resubmit). For an abuse/impersonation takedown where the raw objects must be gone, follow the
  unpublish with `deleteProfile` (unblocked once the profile is `rejected`), whose cascade sweeps
  `public/tracks`, `review/tracks`, and `public/photos`. Between the two steps a direct
  `getDownloadURL` obtained while the profile was live still resolves — do both promptly.
- **Firebase Email Enumeration Protection**: confirm this is enabled (Firebase console →
  Authentication → Settings) on both the `gatekeep-dev-jg` project and whatever project id
  production uses. The app's sign-in error handling degrades gracefully either way, but it
  currently assumes the protection is on rather than asserting it — verify the console toggle
  before launch instead of relying on that assumption.
- **Storage `staging/` lifecycle rule — LAUNCH BLOCKER**: configure a 24h TTL lifecycle rule on
  the `staging/` prefix of the production Storage bucket (Cloud Console / `gcloud storage buckets
  update --lifecycle-file`, not the Firebase console rules editor — this is a bucket-level GCS
  lifecycle policy, not a `storage.rules` change). The Storage **emulator does not enforce
  lifecycle rules**, so nothing catches its absence in local dev. It's the backstop for staging
  objects `processUpload` fails to clean up because its trigger never fired at all — see the
  comment above the storage cascade in `functions/src/profiles.ts`'s `deleteProfile`. Ship this
  together with the abandoned-track reaper below; both are "abandoned upload cleanup."
- ~~**Abandoned `processing`-track reaper**~~ — **DONE (sub-project 3):** a track created via
  `createTrack` but never uploaded (or abandoned mid-upload) used to hold one of the 10 track cap
  slots indefinitely. `functions/src/scheduled.ts`'s daily sweep now fails `processing` tracks
  older than 24h automatically; see "Gigs & series" above.
- **`PUBLIC_PROFILE_HOST`** (`apps/mobile/app/(musician)/portfolio.tsx`): still the
  `https://gatekeep.example` placeholder. The mobile "View public page" link is intentionally
  hidden (`PUBLIC_PROFILE_HOST_READY`) rather than pointing at a dead URL — update the constant to
  the real deployed web domain once one exists, and the link appears on its own.

### Sub-project 3 launch checklist (gigs & series)

- **Geocoder provider**: set `GEOCODER_PROVIDER=google` on the production functions deployment, and
  set `GEOCODER_API_KEY` via `firebase functions:secrets:set GEOCODER_API_KEY` (Secret Manager, not
  a plain env var) before launch — see "Geocoder secret setup" above. Without it, every gig/curator
  address silently geocodes through `StubGeocoder` — a deterministic hash with a US-centric
  bounding box, fine for dev/test but wrong (and non-US-safe) for real addresses.
- **Geocode budget ceiling**: the 50/day per-uid `geocodeBudgets/{uid}` ceiling (see "Geocoder
  secret setup" above) is a fixed constant (`GEOCODE_DAILY_BUDGET` in `functions/src/geocode.ts`),
  not an env var — revisit the number if real curator usage patterns turn out to need more than 50
  distinct address lookups per person per day.
- **Cloud Scheduler enablement**: `functions/src/scheduled.ts`'s `dailySweep` only starts actually
  running once `firebase deploy` provisions the underlying Cloud Scheduler job — there is nothing
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
  the actual launch metro's IANA zone before launch** — per-venue timezone support is a documented
  sub-4 obligation (see `docs/superpowers/sp3-rulings.md`), not a v1 feature.
- **UTC recurrence-time caveat**: a `gigSeries`' `recurrence.weekday`/`hour`/`minute` (and its
  `endDate`) are interpreted in a FIXED UTC anchor by the daily sweep's materializer
  (`functions/src/scheduled.ts`), NOT in `LAUNCH_TIMEZONE` or any curator's local time — a curator
  who picks "Friday 8pm" gets UTC 8pm, which drifts from their actual local 8pm by their UTC offset
  and across DST. The gig composer's series form (`apps/web/src/gigs/GigForms.tsx` /
  `apps/mobile/src/gigs/GigForms.tsx`) discloses this in-form ("Times are in UTC for now —
  local-timezone support is coming"); there is no code fix pending, just this disclosure, until a
  future sub-project's TZ-aware recurrence work lands.
- **Name-search backfill (one-shot)**: `searchUsersByName`'s prefix query depends on every
  `users/{uid}` doc having a `displayNameLower` field. New signups get it automatically
  (`onUserCreated` + the `onUserDocWritten` sync trigger), but any user created **before**
  sub-project 3 shipped won't have it yet. Run the admin-gated one-shot callable
  `backfillDisplayNameLower` once against production after deploy (e.g. from the Firebase console's
  Functions testing tab, or a short authenticated script) to page through and backfill existing
  users — until then, name search simply won't find pre-existing accounts (the email-exact lookup
  path still works for them).
- **Device pass (mobile, before launch)** — verify on a real dev-build device, not just the
  simulator/emulator: (1) **Hermes ICU date formatting** — `apps/mobile/src/gigs/GigForms.tsx`'s
  `formatGigDateTime` wraps its `Intl.DateTimeFormat`/`formatToParts` calls in a try/catch because
  Hermes's ICU timeZone/formatToParts support isn't independently verified on-device the way a
  browser's is; confirm it actually renders the formatted date rather than silently falling back to
  the device's raw local-time string. (2) **Nested "events" Stack headers** — the curator tab's
  `app/(curator)/events/_layout.tsx` nests an Expo Router `Stack` (list → composer → gig detail →
  series detail) inside the outer `Tabs` navigator; confirm header/back-button behavior looks right
  across that nesting on both iOS and Android. (3) **Native provider sign-in** — carried over from
  sub-projects 1/2 (see Prerequisites/Key commands above): Expo Go cannot perform native
  Google/Apple sign-in, so this only gets exercised on a real `expo-dev-client` build; confirm both
  providers still work end-to-end there.

### Sub-project 4 launch checklist (booking flow)

- **`backfillBookingVisibility` (one-shot) — CRITICAL ordering, must ship in the SAME release as
  the rules deploy**: `firestore.rules`' sub-project 4 tighten removes curators' old blanket read
  of `profiles/{id}/private/booking` (see "Booking flow" above) — curators from then on read only
  the server-built `private/curatorBooking` projection. That projection only exists for a profile
  once something has written it (`updateBookingInfo` going forward, or this backfill for every
  pre-sub-4 `private/booking` doc). **Deploy the tightened rules and run
  `backfillBookingVisibility` in the same release** — if the rules land first without the backfill
  (or the backfill is deferred to "later"), every pre-existing musician's rates/preferences become
  invisible to every curator until it runs; if the backfill somehow ran before the old rules were
  removed, nothing breaks, but there is no reason to split the two. Run it once against production
  after deploy (Firebase console's Functions testing tab, or a short authenticated admin script),
  the same way as `backfillDisplayNameLower` above — it's idempotent (a profile whose
  `private/booking` doc already has `visibility` is left untouched), and it defaults migrated
  profiles to all-`"curators"` visibility (preserves pre-sub-4 exposure exactly, exposes nothing
  new).
- **New composite indexes deploy with `firebase deploy`**: sub-project 4 adds 16 composite indexes
  to `firestore.indexes.json` (7 more `gigs` composites — booked-musician/series/booking linkage
  queries — plus 9 new `bookings` composites, since `bookings` is itself a new collection this
  sub-project introduces). Same caveat as the sub-project 3 indexes below: the emulator does not
  enforce composite indexes, so `pnpm emu:test`/`pnpm emu:rules` passing locally proves nothing
  about them — confirm they actually build on the real project after the first production deploy
  (Firebase console → Firestore → Indexes, or `firebase deploy --only firestore:indexes` then watch
  for "Enabled") before the booking thread/inbox/Shows/directory queries that depend on them will
  work in production.

### Sub-project 2 polish follow-ups (non-blocking)

Smaller items from the sub-project 2 quality-review rounds — recorded in full in
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
  and throws `failed-precondition` otherwise) — not just a client-side UI convention as earlier
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
  notices the new membership) is never reconciled against the listener's own copy once it arrives
  — not a live bug today, but a footgun for the next caller of `switchTo`. Separately, the
  logout-reset effect is a deliberate choice (see the comment above it) rather than the
  render-time sentinel pattern used elsewhere on this screen (web's `bookingProfileId`, mobile's
  `baseline`/`lastProfileId`) — revisit if that inconsistency ever causes a real bug.

## Design docs

**Sub-project 1: Foundation** — `docs/superpowers/specs/2026-08-24-foundation-design.md` for the
full design spec and `docs/superpowers/plans/2026-08-24-foundation.md` for the task-by-task
implementation plan.

**Sub-project 2: Musician Portfolio** — `docs/superpowers/specs/2026-08-25-musician-portfolio-design.md`
for the full design spec and `docs/superpowers/plans/2026-08-25-musician-portfolio.md` for the
task-by-task implementation plan.

**Sub-project 3: Curator Profiles & Gig Postings** — `docs/superpowers/specs/2026-08-26-curator-gigs-design.md`
for the full design spec and `docs/superpowers/plans/2026-08-26-curator-gigs.md` for the
task-by-task implementation plan. Durable rulings/handoff record: `docs/superpowers/sp3-rulings.md`
(mirrors `sp2-rulings.md`'s structure).

**Sub-project 4: Booking Flow** — `docs/superpowers/specs/2026-08-26-booking-flow-design.md` for
the full design spec and `docs/superpowers/plans/2026-08-26-booking-flow.md` for the task-by-task
implementation plan. Builds on and resolves obligations recorded in `docs/superpowers/sp3-rulings.md`
(rulings 23/24 and the M-12/M-13 + booking-widening obligation bullets, annotated
"RESOLVED (SP4)" in place).

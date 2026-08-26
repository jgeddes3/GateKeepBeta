# GateKeep

GateKeep connects musicians, event curators (venues, planners, hosts), and fans in a single
metro area — team-approved musician/curator profiles, gig booking, and (later) ticketing — built
on a shared Firebase backend behind default-deny Firestore rules and Cloud Functions-only
privileged writes.

This repo now spans two sub-projects. **Sub-project 1: Foundation** — accounts, auth, profile
lifecycle (draft → review → approve), the mobile + web app shells, an admin approval dashboard,
and notification plumbing. **Sub-project 2: Musician Portfolio** — bio/photos/genres/links,
10×30s reviewed audio snippets with server-side trim/transcode, curator-gated booking rates &
preferences, and server-rendered public portfolio pages at `/@handle`, on both mobile and web.
See `docs/superpowers/specs/` and `docs/superpowers/plans/` for each sub-project's design spec
and implementation plan (exact filenames under Design docs below).

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
│   ├── src/guards.ts             # requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview, deleteProfile
│   ├── src/review.ts             # reviewProfile, grantAdmin, audit logging
│   ├── src/members.ts            # inviteMember, respondToInvite, revokeInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount
│   ├── src/notifications.ts      # push token helpers, notifyUser, approval trigger
│   ├── src/portfolio.ts          # updatePortfolio, updateBookingInfo
│   ├── src/tracks.ts             # createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack
│   ├── src/media.ts              # processUpload trigger: ffmpeg transcode + sharp photo resize
│   ├── src/storage.ts            # Storage bucket helper + STORAGE_BUCKET
│   └── test/*.test.ts            # emulator integration tests
├── apps/mobile/                  # Expo (expo-router): app/, src/lib/firebase.ts, src/auth/, src/shell/
│   ├── eslint.config.js          # flat config (Expo's `eslint-config-expo` default)
│   ├── src/portfolio/            # RN portfolio editor: forms, TrimUploader, TrackManager
│   └── app/artist/[handle].tsx   # native public portfolio view
├── apps/web/                     # Next.js (App Router): app/, src/lib/firebase.ts, app/admin/ (claim-gated)
│   ├── app/join/                 # musician onboarding wizard
│   ├── app/dashboard/portfolio/  # portfolio editor page
│   └── app/u/[handle]/           # server-rendered (SSR) public portfolio page
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

## Environment variables

None are required for local development against the emulators — everything below is unset (empty
string / no-op) by default and only matters for a production deploy.

| Variable | App | Purpose | Default when unset |
|---|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | web | reCAPTCHA v3 site key for Firebase App Check | App Check init skipped |
| `NEXT_PUBLIC_SENTRY_DSN` | web | Sentry DSN for crash/error reporting | Sentry init skipped (no-op) |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile | Sentry DSN for crash/error reporting | `Sentry.init` runs with an empty DSN and is a no-op |
| `NEXT_PUBLIC_SITE_URL` | web | absolute base URL for the public portfolio page's canonical link + OpenGraph `og:url`/images (`apps/web/app/layout.tsx`'s `metadataBase`) | falls back to Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` if present; if neither is set, `metadataBase` is omitted and those URLs render relative instead of absolute (never a hardcoded localhost fallback) |

Web App Check only initializes when `NODE_ENV === "production"` **and** the site key is set
(`apps/web/src/lib/firebase.ts`). Mobile Sentry is additionally gated on `!__DEV__`
(`apps/mobile/app/_layout.tsx`), so it never fires in a dev build regardless of the DSN.

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
- **Abandoned `processing`-track reaper**: a track created via `createTrack` but never uploaded
  (or abandoned mid-upload, before the client-side best-effort cleanup can run) holds one of the
  10 track cap slots indefinitely until a member manually deletes it. Needs a server-side
  scheduled sweep (e.g. delete `processing` tracks older than 24h) — not built yet.
- **`PUBLIC_PROFILE_HOST`** (`apps/mobile/app/(musician)/portfolio.tsx`): still the
  `https://gatekeep.example` placeholder. The mobile "View public page" link is intentionally
  hidden (`PUBLIC_PROFILE_HOST_READY`) rather than pointing at a dead URL — update the constant to
  the real deployed web domain once one exists, and the link appears on its own.

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
  feedback, not just failure alerts. `deleteProfile` being draft/rejected-only is a conscious
  ruling, not a gap — revisit only if support requests show a real need for self-service delete on
  live profiles.
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

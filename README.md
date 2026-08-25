# GateKeep

GateKeep connects musicians, event curators (venues, planners, hosts), and fans in a single
metro area — team-approved musician/curator profiles, gig booking, and (later) ticketing — built
on a shared Firebase backend behind default-deny Firestore rules and Cloud Functions-only
privileged writes.

This is **sub-project 1: Foundation** — accounts, auth, profile lifecycle (draft → review →
approve), the mobile + web app shells, an admin approval dashboard, and notification plumbing.
See `docs/superpowers/specs/` for the full design spec and implementation plan.

## Monorepo map

```
GateKeepBeta/
├── package.json                  # workspace root, scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict TS config
├── firebase.json                 # emulators, functions, firestore config
├── .firebaserc                   # default Firebase project id
├── firestore.rules               # default-deny + narrow allows
├── firestore.indexes.json
├── packages/shared/              # @gatekeep/shared: types + validation, single source of truth
│   └── src/{types,validation,index}.ts
├── functions/                    # Cloud Functions (v2 callables + triggers)
│   ├── src/index.ts              # exports all functions
│   ├── src/authTriggers.ts       # onUserCreated → users doc
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview
│   ├── src/review.ts             # reviewProfile, grantAdmin, audit logging
│   ├── src/members.ts            # inviteMember, respondToInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount
│   ├── src/notifications.ts      # push token helpers, notifyUser, approval trigger
│   └── test/*.test.ts            # emulator integration tests
├── apps/mobile/                  # Expo (expo-router): app/, src/lib/firebase.ts, src/auth/, src/shell/
├── apps/web/                     # Next.js (App Router): app/, src/lib/firebase.ts, app/admin/ (claim-gated)
└── tests-rules/                  # Firestore security rules emulator tests
```

`packages/shared` owns every cross-boundary type and validation rule — functions and both apps
import from it, nothing redefines a shape locally. `functions` owns every privileged mutation.
Apps own UI and only ever read Firestore directly or call callables.

## Prerequisites

- **Node 20+** and **pnpm 9+** (repo pins `pnpm@11.23.0` via `packageManager`).
- **Java (JRE/JDK) 11+ on `PATH`**, required by the Firebase Emulator Suite (Firestore emulator
  is a JVM process). This repo's dev machine relies on a JRE at
  `C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` being prepended to `PATH` — any Java 11+
  install on `PATH` works. Example (bash), used before every emulator command below:
  ```bash
  export PATH="/c/Users/LeoArkos/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"
  ```
- **Xcode** (iOS) / **Android Studio** (Android) only if building native mobile targets locally;
  not required for web dev or emulator-only work.

## Key commands

```bash
pnpm install                          # install all workspaces (also builds @gatekeep/shared)
pnpm typecheck                        # tsc --noEmit across every workspace

pnpm emu                              # start the Firebase Emulator Suite (auth, firestore, functions, UI on :4000)
pnpm emu:test                         # build functions, then run functions/ integration tests against the emulator
pnpm emu:rules                        # run tests-rules/ Firestore security-rules tests against the emulator

pnpm --filter @gatekeep/web dev       # Next.js dev server (apps/web)
npx expo start                        # from apps/mobile: Expo dev server (use a dev build — Expo Go
                                       # cannot do native Google/Apple sign-in)
```

**Known issue:** the Expo **web** target (`expo start --web` / `apps/mobile` web output) is
currently broken (tslib/SSR interop error in `react-native-web`). Use native targets (iOS/Android
dev build) or the Next.js app (`apps/web`) for web.

## Environment variables

None are required for local development against the emulators — everything below is unset (empty
string / no-op) by default and only matters for a production deploy.

| Variable | App | Purpose | Default when unset |
|---|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | web | reCAPTCHA v3 site key for Firebase App Check | App Check init skipped |
| `NEXT_PUBLIC_SENTRY_DSN` | web | Sentry DSN for crash/error reporting | Sentry init skipped (no-op) |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile | Sentry DSN for crash/error reporting | `Sentry.init` runs with an empty DSN and is a no-op |

Web App Check only initializes when `NODE_ENV === "production"` **and** the site key is set
(`apps/web/src/lib/firebase.ts`). Mobile Sentry is additionally gated on `!__DEV__`
(`apps/mobile/app/_layout.tsx`), so it never fires in a dev build regardless of the DSN.

## Manual follow-ups (not automatable / require console access)

These are tracked gaps, not bugs — foundation is unblocked without them, but they must be done
before a real launch:

- **Firebase console → Authentication → Sign-in method**: enable Email/Password, Google, and
  Apple providers on the `gatekeep-dev-jg` project (and again on whatever project id production
  uses).
- **Firebase console → App Check**: register the web app with **reCAPTCHA v3** (produces the
  value for `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`) and the mobile apps with **Play Integrity**
  (Android) / **App Attest** (iOS). Keep enforcement in **monitor mode** for Firestore + Functions
  until both stores' builds exist, then flip to **enforce** as a launch-checklist item. Mobile
  ships v1 in monitor mode via the console only — no native App Check client code; native
  attestation (`@react-native-firebase/app-check`) lands with the EAS production build in
  sub-project 2, where the dev-build pipeline already exists.
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
  this also unblocks EAS builds in sub-project 2.

## Design docs

See `docs/superpowers/specs/2026-08-24-foundation-design.md` for the full design spec and
`docs/superpowers/plans/2026-08-24-foundation.md` for the task-by-task implementation plan this
branch was built from.

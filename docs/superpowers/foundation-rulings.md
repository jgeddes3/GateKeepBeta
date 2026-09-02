# GateKeep Foundation, Rulings & Environment Notes

Durable record from sub-project 1 (Foundation), executed subagent-driven and merged to `main` on 2026-08-25. This file travels with the repo so the decisions and setup requirements are available on any device.

Spec: `docs/superpowers/specs/2026-08-24-foundation-design.md`
Plan: `docs/superpowers/plans/2026-08-24-foundation.md`

---

## Rulings made during execution

Decisions taken so the build wouldn't stall. Each is reversible; the "cost if wrong" is noted where it mattered.

1. **Firebase dev project id is `gatekeep-dev-jg`**, `gatekeep-dev` was taken globally. Used everywhere (`.firebaserc`, both apps' firebase config, test helpers, seed script). Treat as the permanent DEV project; create a separate PROD project under the business Google account before launch (no data migration needed, no real users until launch).

2. **Two plan bugs overridden in favour of the spec (spec is binding authority):**
   - The plan's verbatim security rules omitted the collection-group `members` rule the "my profiles" context switcher needs, added a scoped self-read rule (later split get/list for least privilege).
   - The plan's `removeMember` was race-unsafe against the absolute never-zero-admins invariant, rewritten transactional.

3. **Expo web target deprioritized (out of v1 scope).** A `@firebase/auth`/tslib SSR bug breaks Expo's web export. The spec's web surface is the separate Next.js app, so this is deferred, not a blocker. Native mobile (iOS/Android) and the Next.js web app both work.

4. **Built an unplanned `deleteProfile` Cloud Function.** The spec's account-deletion flow had a dead-end (a solo musician who is sole admin of their own profile could never delete their account). `deleteProfile` closes it and doubles as handle-squat remediation.

5. **Added a draft cap (max 3 unsubmitted drafts/user)** in `createProfileDraft`, closes permanent handle-squatting via never-submitted drafts.

6. **`grantAdmin` enforces Google sign-in.** Admin accounts must use Google (inherits Google 2FA), the compensating control for no-2FA-in-v1. Enforced in both `grantAdmin` and `scripts/seed-admin.ts`.

7. **Custom security-audit substituted for the `security-review` skill.** That skill hard-codes a git command that fails on a repo with no `origin/HEAD`; a dedicated opus security-reviewer with an offensive checklist ran instead. Result: PASS with pre-merge fixes, all applied. The Firestore rules were independently audited twice (score 5 / Secure).

8. **Pre-merge fix wave (from the final whole-branch review + security gate), all applied before merge:** transactional invite-accept (closes a zero-admin brick), runtime type guards in the shared validator (closes a reserved-handle bypass), Firestore get/list split (closes bulk-dump of handles and member rosters), pushToken write constraints, `grantAdmin` hardening, `deleteProfile`, draft cap, invite expiry + `revokeInvite`, visible admin impersonation checklist, admin queue error handling, admin user-lookup showing each result's profiles+statuses.

## Deferred to sub-project 2 (recorded, non-blocking)

- Admin user-lookup **name search** (email-exact is the v1 lookup key).
- Join-wizard in-flight guard / orphaned-draft cleanup (`deleteProfile` is the cleanup path).
- `deleteProfile` leaves orphaned `pending` invites; `deleteProfile` has no profile-status restriction (confirm product intent, likely fine).
- Mobile account-screen dedup (3 byte-identical screens); shared `requireAuth` helper consolidation.
- `@handle` vanity URL rewrite, currently `/u/[handle]`.
- Rejected-profile revise+resubmit UI (server-complete, no client surface yet).
- Mobile lint has 2 pre-existing errors, add "mobile lint green" to sub-project 2's definition of done.

---

## What must be installed / configured

### To brainstorm, spec, or plan (planning phase), repo only
`git clone` the repo. Nothing else required. The spec, plan, and this file carry the context.

### To build, test, or run (execution phase)
- **Node 22+** and **pnpm 9+**. Then `pnpm install` at the repo root.
- **Java 11+ on PATH**, the Firestore emulator is Java-based. On the original dev machine a portable Temurin 21 JRE lives at `C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` and is prepended per-command; on any machine, any Java 11+ on PATH works. Without it, `pnpm emu` / `pnpm emu:test` / `pnpm emu:rules` fail with "Could not spawn `java -version`".
- **Firebase CLI login**, `npx firebase-tools@latest login` (dev project: `gatekeep-dev-jg`).
- **Xcode** (iOS) / **Android Studio + JDK** (Android) for native mobile builds; an Expo **dev build** (`expo-dev-client`) is required for Google/Apple native sign-in (Expo Go can't do it).

### Key commands (repo root)
- `pnpm install` · `pnpm typecheck`
- `pnpm emu`, emulator suite (UI :4000, auth 9099, firestore 8080, functions 5001)
- `pnpm emu:test`, functions tests (builds functions first) · `pnpm emu:rules`, rules tests
- `pnpm --filter @gatekeep/web dev`, Next.js web app · `npx expo start` (in `apps/mobile`), mobile
- Note: Expo's **web** target is broken (see Ruling 3), use native targets for mobile and the Next.js app for web.

### Manual, non-scriptable steps owed before device testing / launch
See `README.md` for the full list. In brief: enable Email/Google/Apple auth providers in the Firebase console; register App Check (monitor→enforce, which also needs `enforceAppCheck: true` per callable); set the real Google OAuth web client id in `apps/mobile/src/auth/config.ts`; set Sentry DSNs; verify `firebase deploy --only functions` resolves the `workspace:*` shared dep; confirm Email Enumeration Protection is on; seed first admins (Google accounts) via `scripts/seed-admin.ts`.

## Post-merge security sweep (2026-08-25)

- **Closed the `inviteMember` email-enumeration oracle**, unknown emails now resolve `{ ok: true }` (uniform response), same as known ones, instead of throwing `not-found`.
- **Enforced email verification on sensitive actions**, `createProfileDraft` and `inviteMember` now require `email_verified === true` on the caller's token, else `failed-precondition`.
- **Capped the profile-rejection reason**, `reviewProfile` now rejects a trimmed `reason` over 500 characters with `invalid-argument`.
- **Added a per-profile pending-invite cap (20)**, `inviteMember` now throws `resource-exhausted` once a profile has 20 pending invites; backed by a new `invites` composite index (`profileId` + `status`) in `firestore.indexes.json`.

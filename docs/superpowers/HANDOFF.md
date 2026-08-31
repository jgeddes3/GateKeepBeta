# GateKeep: fresh-session handoff

Read this first in any new session or on a new machine. Last updated 2026-08-31, after the 6
merge. Update this file whenever a sub-project merges.

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

NEXT: **7 Fan discovery**, then 8 Search. Deferred: 5c band payout splits.

## Binding rules for ALL work

- `DESIGN.md` (repo root): tokens, fonts (Syne + Sora), radius tiers, accent dosage, glass cap.
- The antislop skills (`~/.claude/skills/antislop`, `-ui`, `-copywriting`): binding on UI and
  copy work. Install from `miqdadbadjuber/anti-slop` via `npx skills add` if missing.
- **No em dashes anywhere**: code, comments, copy, docs, commit messages.
- Owner's AI-slop blocklist beyond the skills: no lucide icons, no Inter/Geist/Space Grotesk,
  no bento grids, no fake testimonials or invented numbers (the full list is in sp9a's spec).
- Each sub-project runs: brainstorm, spec, plan, subagent-driven execution with review gates,
  final whole-branch review, merge to main, rulings doc. Direct commits to main between
  sub-projects are fine for small fixes.

## Dev environment quickstart

- `pnpm install`, then `pnpm --filter @gatekeep/web exec next typegen` (fresh checkouts fail
  web typecheck without it).
- Emulators need Java: prepend `C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` to PATH (this
  machine); any Java 11+ works. Set `FUNCTIONS_DISCOVERY_TIMEOUT=60` on Windows.
- Start: `pnpm emu` (UI :4000), then seed test accounts (wiped on every emulator restart):
  `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts`
- Test logins (password `GateKeep-Test1` for all): test-fan@gatekeep.dev,
  test-musician@gatekeep.dev (approved @testmusician), test-curator@gatekeep.dev (approved
  @testvenue).
- Web: `pnpm --filter @gatekeep/web dev` (:3000). Both apps auto-connect to the emulators in
  dev, including from LAN devices. Mobile needs a dev-client build (see sp5b rulings).
- Gates before any merge: `pnpm typecheck` (5/5), shared tests (158), `pnpm emu:test` (704,
  single blocking call), `pnpm emu:rules` (103), web lint + build, mobile lint.
- Firebase dev project: `gatekeep-dev-jg`. Machine quirks: PS 5.1 corrupts UTF-8 pipelines
  (byte-safe tools only); hermesc.exe is App-Control-blocked (use `expo export --no-bytecode`
  locally; EAS cloud is unaffected).

## Owner-owed items (not code)

- Signed-in visual smoke of the redesigned web app (checklist in `sp9a-rulings.md`): the hard
  pre-launch gate.
- Visual smoke of the redesigned mobile app on the next EAS build (checklist in README, "Sub-project
  9B smoke checklist"; both themes, phone width): the hard mobile pre-launch gate, since this machine
  cannot run the dev client.
- Eyeball two derived colors (light focus rust #BF5038, on-destructive white) on /design.
- Real concert photos into `apps/web/public/hero/` (2560x1440 JPG) replacing placeholders.
- Stripe go-live checklist (`sp5-rulings.md`), sp5b device-testing steps (merchant id, EAS env
  key, dev build), Firebase console items and legal-page review (README launch checklist).

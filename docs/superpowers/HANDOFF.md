# GateKeep: fresh-session handoff

Read this first in any new session or on a new machine. Last updated 2026-09-02, after the 7
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

10A. Hardening branch A (merged 2026-09-02 at `ee433d4`, plan
   `plans/2026-09-02-hardening-sweep.md`): every em dash removed repo-wide, Cloud Functions on
   Node 22 (`.nvmrc`), the `tickets.orderId` and `members.uid` index overrides repaired, `.claude/`
   local files ignored, and GitHub Actions CI (`.github/workflows/ci.yml`) running every gate plus
   an em-dash check on every push. Sub-project 7 merged main after this and re-ran every gate
   under Node 22 before landing.

NEXT: **10B Hardening branch B** (spec `specs/2026-09-02-hardening-design.md`, plan
`plans/2026-09-02-hardening.md`, branches from main), then 8 Search. Deferred: 5c band payout
splits.

**Audit context:** `docs/superpowers/audit-2026-09-01.md` is the whole-project audit run after
the 6 merge (19 blockers and near-blockers, per-area verdicts, the SP7 brief, and the
fix-before-SP7 list). Sub-project 7 was brainstormed and built before that audit was read on this
machine; 10B should reconcile the audit's SP7 brief against `sp7-rulings.md` and pick up anything
the built surface missed. Detail reports live in `docs/superpowers/audit/` and
`anti-slop/audit-001-2026-09-01.md`.

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
- Gates before any merge: `pnpm typecheck` (5/5), shared tests (167), `pnpm emu:test` (735,
  single blocking call), `pnpm emu:rules` (114), web lint + build, mobile lint.
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
- New EAS dev build for `expo-location` (joined the native deps in sub-project 7, for the deck's
  distance sort and "near me" labels): the mobile discover deck cannot be exercised on device
  without it.
- The Discover-page marketing capture for the landing page's fan section (`FanStorySection` in
  `apps/web/src/marketing/LandingSections.tsx`): it currently reuses `artist-page.jpg` rather than
  a real screenshot of the deck or the `/discover` list.
- Device smoke of the discover deck (checklist in README, "Sub-project 7 smoke checklist"): entirely
  unverified off a real device, same posture as sub-6's door scanner before it.

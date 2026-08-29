# GateKeep Sub-project 9A (Web UI/UX Redesign) - Rulings & Handoff

Durable record from sub-project 9A, executed subagent-driven with per-task reviews plus a final
whole-branch review on `worktree-sp9a-web-uiux`, merged to `main` on 2026-08-29. Mirrors the
sp2-sp5b rulings docs. Owner note: this document, like all 9A output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-08-28-web-uiux-design.md`
Plan: `docs/superpowers/plans/2026-08-28-web-uiux.md`
Brand contract: repo-root `DESIGN.md` (written by this branch; binding on 9B and all future work)
Approved mocks: `docs/superpowers/mocks/sp9a/`
Behavior: UNTOUCHED. Gates at merge held the exact pre-9A counts (emu:test 578, emu:rules 77,
shared 153), proving the redesign is pure presentation.

## What shipped

The complete "Ember, Deeper Night" redesign of apps/web: Tailwind v4 with the gk-* token system
(dark default plus a full light theme, three-state toggle), themed copied shadcn components in
src/ui (owned code, no component dependency), Syne + Sora via next/font, Phosphor icons pinned
to duotone through src/ui/icons.tsx, the top-bar shell with role-aware nav and context switcher,
the landing page (photo hero carousel, audience stories with real product captures, honest
four-step flow, real fee transparency from shared constants, terms and privacy placeholder
pages), auth and join, dashboards, both profile editors, browse with the signature photo-forward
GigCard and MusicianCard, the artist page (locked hero anatomy, scrollable Shows box, sticky
glass MiniPlayer, viewer-aware past-shows page), the venue collage page with gallery lightbox,
the chat-style booking thread and all restyled money surfaces with a Stripe Elements appearance
config, the fully polished admin (including the first UI for SP5's adminAlerts queue), and a
final voice pass.

## Load-bearing rulings

1. **Marketing dark default**: /, /terms, /privacy stamp data-theme dark when no stored choice
   exists (pre-hydration script + a route-change effect); an explicit stored choice wins
   everywhere; app routes follow system preference. The matrix is in the Task 4 report.
2. **AA is enforced with dedicated tokens, not by weakening the brand**: --gk-focus (dark =
   ember, light = #BF5038 at 4.3-4.5:1) is the focus-ring and safe-text substitute wherever
   bare ember would fail on light surfaces; prices use the filled Badge treatment. DESIGN.md
   records the math. Owner has NOT yet eyeballed #BF5038 or --gk-on-destructive.
3. **RSC boundary discipline** (learned from a Task 9 runtime crash the build cannot catch):
   server files under app/u/[handle] never import VALUES from "use client" modules; label maps
   are local consts, shared helpers live in plain modules (chipLabel.ts, gigDisplay.ts). A green
   build is NOT evidence for these routes (generateStaticParams is empty); a live page load is
   the required check.
4. **Glass cap: exactly two uses product-wide** (landing nav, MiniPlayer). Cards are solid
   elevated surfaces. Shadows only on overlays.
5. **The money surfaces changed markup only.** Two independent mechanical sweeps (task review on
   a stronger model, plus its re-review) proved zero drift in handlers, callables, queries,
   dependency arrays, and compared strings across all 16 booking/payment files. Stripe Elements
   theming is an additive appearance config; the iframe cannot receive the Sora font (custom
   properties do not cross), documented rather than hacked.
6. **Owner-ruled display gate**: the booking thread's current-bubble expected total renders only
   while `status === "open"` or acceptedTerms exists, so dead bookings never show a live
   recomputed figure.
7. **/gigs carries the shell** for signed-in users (spec one-shell rule); signed-out visitors
   get the brand + Sign in variant. The pages' own duplicate footers were removed with it.
8. **Web/mobile money-sentence divergence is temporary**: 9A recolonized web's em-dash money
   sentences; mobile still holds the em-dash twins. **9B MUST mirror the colon treatment** to
   restore the SP5 byte-parity contract.
9. **Spec 6.11 (fan surfaces) reconciled as empty for web**: no fan routes exist on the web app;
   the styled coming-soon states are a 9B (mobile) concern.
10. **Seeded test data quirk**: scripts/seed-test-accounts.ts bios contain em dashes (user data,
    not UI); fix in the seed script post-merge.

## Deferred / follow-ups

- **Owner signed-in visual smoke is the hard pre-launch gate.** Coverage (from the final
  review): shell + switcher + mobile sheet at 360px; dashboard home; both editors incl. photo
  upload; gigs/series management; booking inbox + thread (offer, counter, accept, cancel, 360px
  wrap); PaymentsPanel + SaveCardModal with the themed Stripe Element in both themes; earnings +
  payout + delinquency + gate prompts; admin incl. an AdminAlerts row; MiniPlayer with a seeded
  track; venue collage with 1, 3, and 6+ photos; the onboarding interstitials; all dark + light.
- Owner eyeball queue: --gk-focus light rust #BF5038, --gk-on-destructive white, hero
  placeholder photos (swap with the real concert-photo folder via public/hero + heroImages.ts).
- Riding minors (ledgered, none load-bearing): collage branches never photo-rendered; curator
  gigs management list could adopt date-block rows; stripeAppearance hex fallbacks could drift
  if tokens change; "Forfeited deposit:" wording; SaveCardModal run-on sentence; overflow-x
  hidden hygiene; footer mailto hello@gatekeep.app is a placeholder (README launch checklist).
- 9B carries: the colon treatment for mobile's money sentences (ruling 8), the DESIGN.md tokens
  and component semantics as the shared language, and the smoke-checklist patterns above.

## Environment notes

hermesc.exe is blocked by this machine's Application Control policy (sp5b ruling; unaffected
here). The visual-review loop ran the worktree dev server on port 3002 against the shared
emulators; Chrome extension screenshots embed a corner badge overlay, crop before shipping any
capture (bit Task 12 once).

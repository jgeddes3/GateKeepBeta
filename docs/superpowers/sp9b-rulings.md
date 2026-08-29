# GateKeep Sub-project 9B (Mobile UI/UX Redesign) - Rulings & Handoff

Durable record from sub-project 9B, executed subagent-driven with per-task reviews (spec-compliance
then code-quality), two independent zero-drift sweeps on the money surfaces, and a whole-branch final
review, merged to `main` on 2026-08-29 (merge commit, `--no-ff`). Mirrors the sp2-sp5/sp9a rulings
docs. Owner note: this document, like all 9B output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-08-29-mobile-uiux-design.md`
Plan: `docs/superpowers/plans/2026-08-29-mobile-uiux.md`
Brand contract: repo-root `DESIGN.md` (written by 9A; binding, not re-decided here)
Web precedent: `docs/superpowers/sp9a-rulings.md` (the web redesign this carries to mobile)
Behavior: UNTOUCHED. The whole branch changed ONLY `apps/mobile/**`, the 2-native-dep `pnpm-lock.yaml`
bump, and a `README.md` docs addition. ZERO changes to `functions/`, `packages/shared/`, firestore
rules, or `apps/web/`, so `shared` (153), `emu:test` (578), `emu:rules` (77), and the web build are
unchanged BY CONSTRUCTION (the tested code is byte-identical to main) - a stronger proof than the
counts. Gates at merge: typecheck 5/5, mobile lint 0, web lint 0, shared 153, `expo export` bundles,
whole-`apps/mobile` em-dash grep EMPTY.

## What shipped

The complete "Ember, Deeper Night" redesign of `apps/mobile` (Expo SDK 57, RN 0.86), with no
Tailwind/shadcn (React Native has neither):

- **Theme layer** (`src/theme/`): a typed `tokens.ts` (dark + light sets, transcribed byte-for-byte
  from `apps/web/app/globals.css`, incl. the `#BF5038` AA-safe light-focus), a React-context
  `ThemeProvider` with `useTokens()` + a three-state `useThemeChoice()` (system/light/dark) persisted
  to AsyncStorage (crash-safe read, splash gated on fonts AND theme so no wrong-font/theme first
  frame), `fonts.ts` loading Syne + Sora at runtime via expo-font, and `tokens.test.ts` pinning every
  value and enforcing dark/light key-parity at compile time (the app has no runtime test runner;
  typecheck is the gate).
- **Owned primitive library** (`src/ui/`, 15 primitives + barrel): Text (the ONLY fontFamily source),
  Button, Card, Chip, Badge, StatusBadge, Callout, Input, TextArea, Sheet, Skeleton/SkeletonCard,
  ErrorBanner, Background (PageBackground/PhotoScrim/PhotoPlaceholder via react-native-svg),
  ThemeToggle, and `icons.tsx` (the ONLY phosphor importer, weight hard-fixed to `duotone`).
- **Shell**: retinted tab bars + borderless themed headers + StatusBar via `useShellScreenOptions`,
  and a fully retinted `ContextSwitcher` (header switch + join link).
- **Screens**: auth + join; curator/musician dashboards + shared AccountScreen (with ThemeToggle);
  profile/gig editors (CuratorForms, PortfolioForms, TrackManager, TrimUploader, GigForms fields);
  photo-forward browse cards (GigCard/MusicianCard) + curator events management; the artist page
  (locked hero anatomy + Shows + the inline solid player); the booking thread + inbox + all money
  surfaces (with a token-based Stripe PaymentSheet appearance); the coverage screens the plan's sweep
  tasks missed (musician portfolio editor, the booking gate wrappers, the booking route, and the
  NotificationsList in AccountScreen); and branded fan + messages coming-soon states.

## Load-bearing rulings

1. **Fonts are instanced statics, not variable.** The 6 TTFs in `apps/mobile/assets/fonts/`
   (Syne-SemiBold/Bold/ExtraBold, Sora-Regular/Medium/SemiBold) were instanced from the Google
   variable fonts via fonttools `varLib.instancer` with UNIQUE PostScript names, because expo-font on
   iOS aliases faces that share a family name. `Text.tsx` maps each variant to one named face and
   NEVER pairs `fontWeight` with a named face (iOS would synthesize a mismatched bold).
2. **Photo-forward cards render a branded PLACEHOLDER, not a real photo.** Web's GigCard/MusicianCard
   are photo-capable but neither web browse grid wires a `photoUrl` through, and mobile's browse data
   carries no per-item photo without a NEW fetch (forbidden by the no-behavior-change rule). So the
   mobile cards port the anatomy (fixed cover + `PhotoScrim` + title/price on the always-dark scrim,
   ember price) over `PhotoPlaceholder` (a surface->border svg gradient + context icon). The artist
   HERO does use the already-resolved `coverUrl` (no new fetch). On-scrim text uses the static
   `tokens.dark.text` so it reads on the always-dark scrim in both themes.
3. **GigForms was a shared hub; its raw-hex exports were removed in sequence to keep typecheck green.**
   `Chip`/`STATUS_BG`/`STATUS_FG` were deleted in task 7 (after GigBrowse/MusicianBrowse/events
   migrated to `src/ui/Chip` + `StatusBadge` + the new `GIG_STATUS_TONE`/`SERIES_STATUS_TONE` maps);
   `Badge` was deleted in task 9 (after BookingInbox/BookingThread/PaymentStatus migrated). GigForms is
   now fully hex-clean; its pure utils/label maps/state factories stayed.
4. **Money surfaces are markup-only, proven twice.** Two INDEPENDENT mechanical no-drift sweeps
   (implementer table + an independent re-derivation) confirmed every handler, callable name,
   `httpsCallable` argument, query/`onSnapshot` shape, dependency array, and `===`-compared
   `@gatekeep/shared` constant is byte-identical across all 12 booking/payment files. The Stripe
   PaymentSheet `appearance` is the ONE sanctioned additive change: an optional param threaded through
   `stripe.ts`'s `runSetupSheet`/`runPaymentSheet` into `initPaymentSheet` (undefined = prior
   behavior), built from tokens (`secondaryText` uses hex `t.text`, never the rgba `t.muted`); the
   native sheet's font is documented-not-hacked (no Sora guaranteed).
5. **CancelDialog stays an inline destructive panel, not a Sheet.** Mobile's CancelDialog is an inline
   confirmation `View` (unlike web's modal); converting it to `src/ui/Sheet` would change mount/dismiss
   behavior, so it was only retinted (destructive tokens + `Button variant="destructive"`).
6. **Delinquency tone split mirrors web.** Web keeps an intentional gate=amber / banner=red split for
   the same overdue-payment concept; mobile mirrors it exactly (documented in `GatePrompt`). The
   "Pay now" CTA was aligned to web's `Button variant="secondary"` (was a text link).
7. **Money-sentence colon parity restores the SP5 byte-parity contract (9A ruling 8).** 15 mobile-local
   money/payment display sentences were aligned byte-identical to their web twins (colon/period/middot
   `·`/en-dash `–`), including mirroring web's own internal "1-3" vs "1–3" inconsistency.
   Strings from `@gatekeep/shared` and every `===`-compared literal were left untouched.
8. **Fan coming-soon states reconciled (9A ruling 9).** `(fan)/index|search|tickets` and the two
   `messages.tsx` placeholders became branded coming-soon states (PageBackground + Syne title + muted
   explainer + a Phosphor glyph). No behavior, no fetch.

## Accepted exceptions (conscious, not oversights)

- `src/ui/Sheet.tsx:47` `shadowColor: "#000"` and the `rgba(0,0,0,0.5)` modal backdrop (Sheet,
  ContextSwitcher, GigBrowse) are theme-independent, RN-convention values with no token; left as-is.
- En dashes (`–`) for numeric ranges and middots (`·`) as separators are web-parity glyphs,
  not em dashes; kept. Content glyphs (`→`, `✓`, `○`, `••••`) are
  pre-existing, unchanged.
- `README.md` has pre-existing em dashes (SP2-9A) outside the added 9B section; out of 9B scope. The
  added smoke-checklist section is em-dash-free.

## Deferred / follow-ups

- **Owner visual smoke on the next EAS build is the hard pre-launch gate.** This machine cannot run the
  dev client (hermesc.exe App-Control-blocked; the native deps phosphor-react-native + react-native-svg
  need a real build), so EVERY 9B claim is "bundles + lints + typechecks + no hex/em-dash left," never
  "looks right." The README "Sub-project 9B smoke checklist" enumerates the coverage (shell + toggle +
  switcher; auth/join; dashboards + account; editors incl. photo upload; browse cards; artist hero +
  Shows + player; booking thread offer/counter/accept/cancel; PaymentSheet + save-card + earnings/
  payout/delinquency/gate-prompts; skeleton/empty/error; fan + messages coming-soon; all dark + light
  at phone width).
- The token PaymentSheet `appearance` is unverifiable here (keyless emulator + no dev client); confirm
  it on the owner's build.
- `emu:test` (578) / `emu:rules` (77) / web build were NOT re-run at merge (proven unchanged by the
  zero-diff on functions/shared/rules/web); run on demand if desired.
- Riding minor (ledgered, non-blocking): the `events/index` series-list badge is a fixed `neutral`
  tone while the series DETAIL screen tones it via `SERIES_STATUS_TONE` (faithful to the pre-9B
  single-color list badge; align later if wanted).

## Environment notes

Windows, `corepack pnpm`. The dev-machine quirks (JRE path prepend, `FUNCTIONS_DISCOVERY_TIMEOUT=60`
for emu:test) live in the user memory. `expo export --platform ios` is the mobile bundling gate (plain
command works; hermesc succeeds for export, it is only the dev-client build that is App-Control-blocked).

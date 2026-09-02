# Sub-project 9B: Mobile UI/UX Redesign, Design Spec

Date: 2026-08-29. Carries the "Ember, Deeper Night" brand from web sub-project 9A to the Expo app
(`apps/mobile`). The brand contract is fixed: **`DESIGN.md` (repo root) is binding and is not
re-decided here**, 9B translates it to React Native. Prior records: `docs/superpowers/sp9a-rulings.md`
(web redesign, carry-forwards), `docs/superpowers/sp5b-rulings.md` (mobile payments, native-module
posture), `docs/superpowers/sp5-rulings.md` (money authority).

**Hard rule (from DESIGN.md, binding on all 9B code/comments/copy): no em dash (`, `) anywhere.**
Use a comma, period, colon, or parentheses.

## 0. Constraints and non-goals

- **Behavior is UNTOUCHED.** 9B is pure presentation: retint, retype, and restyle. It changes what
  states *render*, never *when* they fire, what data drives them, which callable runs, or how
  navigation is structured. Proof of parity is that the backend gate counts hold unchanged
  (`emu:test 578`, `emu:rules 77`, `shared 153`). 9B should not touch `functions/` or
  `packages/shared/` at all; a stray change to either is a red flag to justify or revert.
- **This machine cannot run the mobile dev client** (sp5b ruling 11: `hermesc.exe` is App-Control-
  blocked; the Stripe + new-icon native modules need an EAS build). The verification gate here is
  `npx expo export --platform ios` *bundling* (compiles + links native deps), plus lint and
  typecheck. Live visual verification is the owner's, on the next EAS build (see §7).
- **Non-goals**: no navigation restructure (no new tabs, no moved/renamed screens), no new fetch
  logic, no backend or shared-package change beyond what a money-sentence already shares, no theming
  library dependency.

## 1. Owner decisions (this brainstorm)

- **Icons: Phosphor duotone, matching web**, add `phosphor-react-native` + `react-native-svg`
  (native module; bundles via `expo export`, renders live on the next EAS build, consistent with
  mobile already awaiting a rebuild for sp5b). No Lucide, ever (DESIGN.md).
- **Token/theme architecture: Approach A**, a React context ThemeProvider + a typed token object +
  a `useTokens()` hook feeding an owned `src/ui/` primitive library. The RN-idiomatic version of
  9A's "owned components + tokens, no component dependency."
- **Skeleton + graceful states**: every screen gets branded loading (skeleton), empty, and error
  states, presentation-only over the loading/error conditions that already exist.

## 2. Token & theme layer (`apps/mobile/src/theme/`)

- **`tokens.ts`**, the `--gk-*` values from DESIGN.md transcribed as a typed object
  `{ dark: GkTokens, light: GkTokens }` over one `GkTokens` interface: `bg0/bg1/bg2`, `surface`,
  `border`, `text`, `muted`, `accent`, `onAccent`, `success`/`warning`/`destructive` + `onDestructive`,
  `focus`. Exact hexes including the AA-safe re-derivations: light `focus` `#BF5038`, light
  `success #2E7D43` / `warning #9A6A1B` / `destructive #C62A30`, fixed `onAccent #2A0F0A` /
  `onDestructive #FFFFFF` (theme-invariant), and the theme-invariant `accent #FF6B4A`. Non-color
  scales the DESIGN.md tables imply also live here: `radius { pill: 999, card: 10, sm: 6 }`, the type
  ramp (family names `Syne`/`Sora` + weights 600/700/800 and 400/500/600), and a small spacing scale.
  The page and scrim gradients (CSS-only on web) become `expo-linear-gradient` prop sets: `page` is
  the `165deg` night gradient in dark and flat `#FAF7F2` in light; **`scrim` is always the dark night
  gradient in both themes** (DESIGN.md: it keeps photo captions legible, not page chrome). A header
  comment names `DESIGN.md` as the source of truth and states the governance rule (values change
  there first).
- **`ThemeProvider.tsx`**, context resolving the active theme: an explicit `AsyncStorage["gk-theme"]`
  choice (`"light"`/`"dark"`) wins; otherwise RN `useColorScheme()`, with **dark as the brand default**
  when the system value is null/unknown. Reads the stored choice once on mount before rendering the
  tree (RN has no server render, so there is no flash-of-wrong-theme hazard the way web has). Exposes
  `useTokens(): GkTokens` and `useThemeChoice(): { choice: "light"|"dark"|"system"; setChoice(...) }`
  (setter writes/clears AsyncStorage). Mounted in `app/_layout.tsx` above the existing
  Auth/Profile/Stripe providers.
- **`fonts.ts`**, `useAppFonts()` wrapping expo-font's `useFonts` with the Syne (600/700/800) and
  Sora (400/500/600) TTFs added under `apps/mobile/assets/fonts/`. `_layout.tsx` holds the splash
  screen until fonts load. Runtime load, no native rebuild (expo-font is already installed).

## 3. Primitive library (`apps/mobile/src/ui/`)

Every primitive consumes `useTokens()`; the scattered inline hex across the app is deleted and
replaced by these. Each is a small, single-responsibility RN component mirroring its web `src/ui/`
counterpart's contract.

- **`Text.tsx`**, typed variants mapping the DESIGN.md ramp: `display`/`heading` → Syne (600–800),
  `body`/`label`/`meta` → Sora (400–600); `muted` prop; default color `token.text`. The only place
  font families are applied.
- **`Button.tsx`**, the four surviving web variants only (9A post-launch fix): `default` (ember
  pill, `onAccent`), `secondary` (outlined ghost, `border`), `destructive` (status red,
  `onDestructive`), `ghost`. Radius `pill` for `default`, `card` otherwise. Pressed/disabled states;
  minimum 44px touch target.
- **`Card.tsx`**, solid `surface` + `border`, radius `card`, flat. No shadow (borders separate).
- **`Chip.tsx`**, pill radius; active = ember fill + `onAccent`, inactive = `surface` + `border`.
  Replaces the current inline `Chip` in `GigForms`/`PortfolioForms`.
- **`Badge.tsx` + `StatusBadge.tsx`**, 6px radius; the status variant pairs the saturated tint with
  its **14%-opacity** background of the same color (the one soft-tint figure), re-derived per theme;
  real state only, never decorative. The gig/booking status maps (`STATUS_BG`/`STATUS_FG`) move here
  as token-based, replacing raw hexes.
- **`Input.tsx` / `TextArea.tsx`**, `surface` bg, `border`, solid `focus` border on focus (the 3:1
  indicator), `muted` placeholder.
- **`Sheet.tsx`**, the one shadowed overlay primitive (dialogs/bottom sheets, e.g. `CancelDialog`).
  Shadows are reserved for overlays only.
- **`Skeleton.tsx`**, token-colored placeholder blocks (`surface`/`border`, radius `card`/`sm`)
  shaped to the content they stand in for. A slow subtle shimmer that **pauses under
  `prefers-reduced-motion`** (static tint fallback), honoring MOTION 1.
- **`ThemeToggle.tsx`**, Light / Dark / System control writing through `useThemeChoice()`; mounts in
  the account screens.
- **`icons.tsx`**, Phosphor duotone wrapper: `phosphor-react-native` + `react-native-svg`, a curated
  `Icon`-prefixed set with `weight` locked to `"duotone"` (no caller override). **No other file
  imports Phosphor directly**, exactly web's `src/ui/icons.tsx` contract. Form-control glyph
  exceptions (a solid radio/selection dot) follow web's `IconRadioDot` precedent if needed.

**Glass cap**: DESIGN.md allows exactly two blur uses product-wide (web's landing nav + mini-player).
Mobile has no landing page, so **at most one** blur use on mobile, the artist-page MiniPlayer, if it
adopts glass (confirmed in §4). Everything else is solid `surface`. No other blur anywhere.

**Accent dosage** (DESIGN.md): ember belongs to the primary action and money/brand moments only
(primary CTA, price, active tab, status-badge tint, brand mark). Where bare ember as text would fail
AA on a light surface, use the filled-chip treatment or the `focus` (`#BF5038`) substitute, per the
DESIGN.md accent note, verified per theme wherever ember lands on `text`.

## 4. Shell (tab bars, headers, context switcher)

Mobile's shell is expo-router's tab groups + Stack headers, retinted; there is no web-style top bar.

- **Tab bars** (`(curator)`/`(musician)`/`(fan)` `_layout.tsx`): `surface` background with a top
  `border` hairline (no floating shadow); active tab = ember icon + label, inactive = `muted`;
  Phosphor duotone icons; Sora labels. The active-tab ember is DESIGN.md's sanctioned "active nav
  item" dosage. On light theme, a bare-ember label that measures under AA takes the `focus` substitute
  (web-wordmark rule); verified per theme.
- **Stack headers** (`_layout.tsx`'s `join` + `artist/[handle]`): `surface` bg, Syne `text` title,
  `border` bottom hairline, ember only for the one important action. `booking/[bookingId]` keeps its
  existing custom back control (it handles the no-history deep-link case a native header cannot),
  retinted only.
- **Context switcher**: restyle the existing `ProfileContext`-driven switcher and role-group UI to
  the token system; no change to which group a profile routes into.
- **Status bar**: `expo-status-bar` style follows the active theme. Safe areas via
  `useSafeAreaInsets` preserved.

## 5. Screen sweep

Each group is an independent, reviewable task; every screen applies the loading/empty/error states
(§6) as it goes.

- **Auth + join** (`(auth)/sign-in`, `sign-up`, `join`): brand-forward, dark-default entry.
- **Dashboards + account** (curator/musician/fan `dashboard.tsx`, `account.tsx`): token sweep; account
  mounts `ThemeToggle`.
- **Profile editors** (`CuratorForms`, `PortfolioForms`, `TrackManager`, `TrimUploader`): field
  groups adopt the primitives.
- **Browse + gigs/events** (`GigBrowse`, `MusicianBrowse`, `events/*`, `gigs.tsx`): photo-forward
  GigCard/MusicianCard with the scrim-over-photo motif and status badges.
- **Artist page** (`artist/[handle]`): the DESIGN.md-locked hero anatomy (scrim over cover),
  scrollable Shows, and the **MiniPlayer**, the one candidate for mobile's single allowed glass use
  (confirmed blur-vs-solid at build; default to solid if blur cost/legibility disappoints). Track
  playback behavior untouched.
- **Booking + money surfaces** (`BookingThread`, `BookingInbox`, `BookingForms`, `OfferForm`,
  `CancelDialog`, all of `src/payments/*`): retinted to tokens with a Stripe **PaymentSheet appearance
  config** mirroring web's Elements theming (colors from tokens; the native sheet's font support is
  limited, documented not hacked, per 9A ruling 5's iframe-font note). **Markup-only** under the 9A
  ruling-5 discipline: a mechanical diff proving zero drift in handlers, callables, queries, dependency
  arrays, and `===`-compared shared gate-message constants across every booking/payment file. Highest
  risk; reviewed on a stronger model.

## 6. Loading / empty / error states (cross-cutting)

Presentation-only over conditions that already exist (a `loading` boolean, a null-data phase, a caught
error). 9B swaps what those states render, never when they fire.

- **Loading** → the shaped `Skeleton` (list screens: 2–3 skeleton cards; detail screens: skeleton hero
  + body), replacing bare `Loading…` text / spinners.
- **Empty** → a branded empty state (the fan coming-soon states are one instance).
- **Error / failed load** → a branded inline error with a Retry affordance where the screen already has
  a refetch path (SP5's earnings-card retry is the precedent), a plain branded message where it does
  not.

## 7. Carry-forwards from 9A

- **Money-sentence colon treatment (9A ruling 8, restores SP5 byte-parity)**: 9A colonized web's
  em-dash money sentences; mobile still holds the em-dash twins. Sweep mobile-local money-sentence copy
  to the identical colon treatment, verified against web's exact wording. Strings already in
  `@gatekeep/shared/messages.ts` are shared and already colonized (no change); this targets
  mobile-local copy only.
- **Styled fan coming-soon states (9A ruling 9)**: the `(fan)` group (`index`, `search`, `tickets`) is
  placeholder; give them proper branded coming-soon empty states (spec 6.11's fan surfaces, empty for
  web, land here on mobile).

## 8. Verification

- `npx expo export --platform ios` bundles clean (links `react-native-svg`/`phosphor-react-native`).
- mobile lint 0 errors · `corepack pnpm typecheck` 5/5.
- Backend gate counts hold unchanged: `emu:test 578`, `emu:rules 77`, `shared 153` (parity proof).
- Money-surface mechanical diff: zero behavior drift (9A ruling 5).
- No-em-dash grep gate across all touched files.
- **Owner visual smoke on the next EAS build is the hard pre-launch gate** (this machine cannot run
  the dev client). Smoke checklist: shell + tab bars + `ThemeToggle` in both themes at phone width;
  auth/join; dashboards; editors incl. photo upload; browse cards; artist hero + Shows + MiniPlayer;
  booking thread (offer/counter/accept/cancel); PaymentSheet + SaveCard + earnings/payout/delinquency/
  gate-prompts in both themes; skeleton/empty/error states; fan coming-soon; all dark + light.

## 9. Task shape (for the plan)

Subagent-driven, two-stage reviews per task, whole-branch final review before merge (the SP5/9A
cadence). Money-surface task on a stronger model. ~11 tasks: (1) theme layer + native deps; (2)
primitive library incl. Skeleton; (3) shell; (4) auth+join; (5) dashboards+account; (6) profile
editors; (7) browse+gigs/events; (8) artist page; (9) booking + money surfaces (markup-only); (10)
carry-forwards (money-sentence parity + fan coming-soon); (11) voice/copy + no-em-dash sweep + final
gates + smoke checklist.

## 10. Scope boundaries

**In**: `apps/mobile` presentation only (theme, primitives, shell, all screens, states, carry-forwards),
plus the two native icon deps and font assets. **Out**: any behavior/navigation/fetch change; any
`functions/`/`packages/shared` change beyond none; a theming-library dependency; live device
verification (owner's, next build). **Carried, not 9B's**: 9A's owner eyeball queue (`#BF5038`,
placeholder hero photos) is web; mobile's equivalent owner eyeball is the §7 smoke pass.

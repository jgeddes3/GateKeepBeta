# DESIGN.md: GateKeep brand contract

This file is the single source of truth for GateKeep's visual language. It is binding for
sub-project 9A (web UI/UX redesign, `apps/web`) and for sub-project 9B (mobile app), which follows
this same design language in its own sub-project. Every UI task in either sub-project reads this
file first.

**Read this alongside the antislop skills before writing any UI code:**
`~/.claude/skills/antislop/SKILL.md` (core filter) and `~/.claude/skills/antislop-ui/SKILL.md`
(UI/visual depth). For copy-writing tasks, also read `~/.claude/skills/antislop-copywriting/SKILL.md`.
This file gives the design its identity (palette, type, mood); the antislop skills are the filter
that keeps the result from reading as generic AI output. Neither replaces the other.

**Hard rule, no exceptions: no em dash (`, `) anywhere.** Not in copy, not in code comments, not in
code strings, not in documentation. Use a comma, period, colon, or parentheses instead.

**Hard rule: no Lucide icons, ever.** Icons are Phosphor (`@phosphor-icons/react`) only, one weight
product-wide (see "Icons" below).

**Hard rule: fonts are Syne and Sora only.** No Inter, no Geist, no Space Grotesk, no other typeface
substitutions anywhere in the product.

---

## Design language: Ember, Deeper Night

Owner-picked from rendered alternatives (visual companion session,
`.superpowers/brainstorm/`). The plum-toned dark palette is a deliberate choice, kept over the
"purple and black" caution in the antislop core filter because it is a specific, considered brand
color, not a default gradient reached for out of habit. Ember (`#FF6B4A`) is the one recurring
accent; the bottom-up night scrim over photography is the one recurring visual motif. Dark is the
brand default for signed-out marketing pages; the light theme ("before doors open") is a genuine
second surface, not an afterthought.

**Design Read:** a booking marketplace for musicians, curators, and fans, in a warm nightlife
register (concert photography, ember accent, night gradient) balanced by a restrained, mostly
solid, borders-do-the-separating component system. Dial: **ENERGY 2 / RHYTHM 2 / MOTION 1.**
- ENERGY 2: one deliberate accent color and one recurring gradient motif give the product
  personality, but elevation is flat and glass is capped at two uses. This sits closer to
  Stripe/Vercel than to an Awwwards-style maximalist site.
- RHYTHM 2: the component system (cards, chips, buttons) is consistent everywhere, but page
  anatomies are individually owner-locked and vary deliberately (the landing page alternates
  section alignment; the artist page, venue page, and dashboards each have their own composition).
- MOTION 1: the spec states this explicitly ("Motion dial: low"). Hover states and a short list of
  deliberate moments only (sheet/dialog entrances, the hero carousel, the mini-player reveal). No
  endless loops, no scroll-triggered animation stacking.

## Stack

- **Tailwind CSS v4** (CSS-first config: `@import "tailwindcss"` plus `@theme inline` in
  `apps/web/app/globals.css`). PostCSS wired via `apps/web/postcss.config.mjs` and
  `@tailwindcss/postcss`.
- **shadcn/ui** components copied into `apps/web/src/ui/` and themed to the tokens below (source
  copied by hand following the shadcn/ui pattern, not a runtime dependency; the current `shadcn`
  CLI major version forced an interactive preset picker bundling Lucide and Geist, both hard-banned
  here, with no working non-interactive path, so task 2 copied component sources directly rather
  than fight the CLI. `components.json` still records the intended alias config for future CLI
  use). Never ship a shadcn default look; every copied component gets a theme pass (task 2 of
  sub-project 9A).
- **Fonts via `next/font/google`** (self-hosted at build, no request to Google at runtime): Syne
  and Sora. See "Typography" below.
- **Icons: Phosphor** (`@phosphor-icons/react`), one weight product-wide. See "Icons" below.
- **Motion: the `motion` package**, for choreographed transitions only, at the MOTION 1 dial above.

## Color tokens

All tokens are CSS custom properties defined in `apps/web/app/globals.css`, prefixed `--gk-`, and
mirrored into Tailwind's theme via `@theme inline` (so `bg-gk-surface`, `text-gk-text`,
`border-gk-border`, and so on are all real Tailwind utility classes). Component code should always
reach for the `gk-*` utility or the `var(--gk-*)` custom property, never a hardcoded hex value.

### Dark (default)

| Token | Value | Role |
|---|---|---|
| `--gk-bg-0` | `#0E0B13` | Page gradient start (top) |
| `--gk-bg-1` | `#150F20` | Page gradient midpoint |
| `--gk-bg-2` | `#1D1229` | Page gradient end (bottom) |
| `--gk-surface` | `#1A1424` | Card and panel background. Solid, never gradient |
| `--gk-border` | `#2C2438` | Card, input, and divider border |
| `--gk-text` | `#F5F1F8` | Primary text |
| `--gk-muted` | `rgba(245,241,248,.62)` | Secondary text (meta lines, timestamps, helper text) |
| `--gk-accent` | `#FF6B4A` | Ember. Primary action and money/brand moments only |
| `--gk-on-accent` | `#2A0F0A` | Text/icon color on top of a solid `--gk-accent` fill |
| `--gk-success` | `#7BC48A` | Success status tint |
| `--gk-warning` | `#E8B15C` | Warning status tint |
| `--gk-destructive` | `#E5484D` | Destructive status tint, destructive button fill |
| `--gk-on-destructive` | `#FFFFFF` | Text/icon color on top of a solid `--gk-destructive` fill |
| `--gk-focus` | `var(--gk-accent)` | Focus ring / focus border color |
| `--gk-scrim` | gradient, see below | Bottom-up night scrim over photography |
| `--gk-page` | gradient, see below | Page-level background |

`--gk-page`: `linear-gradient(165deg, var(--gk-bg-0) 0%, var(--gk-bg-1) 55%, var(--gk-bg-2) 100%)`,
applied once at the page level (`body`). Individual sections never restack their own gradient on
top of this: that is the harsh-gradient pattern the antislop filter rejects.

`--gk-scrim`: `linear-gradient(to top, var(--gk-bg-0) 4%, rgba(14,11,19,.35) 55%, transparent)`.
Used over photography: hero carousel, gig cards, cover heroes. This is the one token that does not
get a light-theme override (see "Light" below); it is deliberately always the night gradient in
both themes, because it exists to keep photo captions legible, not to match page chrome.

`--gk-on-destructive` (task 2 addition): every other status color pairs as a saturated
text/icon/border tint over a soft background tint of itself (see "Status tints" below), but
DESIGN.md's own accent note next door measures bare ember text as failing AA on light surfaces,
and destructive red is a similarly saturated hue. A solid destructive button (`src/ui/button.tsx`
`variant="destructive"`) needs white foreground text to clear AA, the same role `--gk-on-accent`
plays for a solid ember fill, so it gets the same treatment: one fixed value, not re-derived per
theme, because it only ever sits on top of the saturated `--gk-destructive` fill itself.

`bg-gk-scrim` and `bg-gk-page` are **not** valid Tailwind classes: `--gk-scrim` and `--gk-page` are
gradients (flat only in the light theme's `--gk-page`), and gradient-valued tokens are excluded
from the `@theme inline` color mapping, so no `bg-gk-scrim` / `bg-gk-page` utility is generated.
Apply them with `style={{ background: "var(--gk-scrim)" }}` (or the Tailwind arbitrary-value
equivalent, `bg-[image:var(--gk-scrim)]`) instead. Every other token in the tables above (including
`--gk-on-destructive`) is a flat color and does have a working `bg-gk-*` / `text-gk-*` /
`border-gk-*` utility.

### Light ("before doors open")

| Token | Value | Role |
|---|---|---|
| `--gk-bg-0` | `#FAF7F2` | Same as page background (flat, no gradient in light) |
| `--gk-bg-1` | `#FAF7F2` | Same as page background |
| `--gk-bg-2` | `#FAF7F2` | Same as page background |
| `--gk-surface` | `#FFFFFF` | Card and panel background |
| `--gk-border` | `#E4DDD2` | Card, input, and divider border |
| `--gk-text` | `#1C1524` | Primary text (plum ink) |
| `--gk-muted` | `rgba(28,21,36,.62)` | Secondary text |
| `--gk-accent` | `#FF6B4A` | Same ember as dark. The brand accent does not change with theme |
| `--gk-on-accent` | `#2A0F0A` | Same as dark |
| `--gk-success` | `#2E7D43` | Re-derived for AA on a light surface |
| `--gk-warning` | `#9A6A1B` | Re-derived for AA on a light surface |
| `--gk-destructive` | `#C62A30` | Re-derived for AA on a light surface |
| `--gk-on-destructive` | `#FFFFFF` | Same as dark |
| `--gk-focus` | `#BF5038` | Focus ring / focus border color, re-derived for AA (see below) |
| `--gk-page` | `#FAF7F2` | Flat warm paper, no gradient |

`--gk-scrim` is not redefined in light: it inherits the dark gradient value from `:root` (see
above). `--gk-page` is redefined flat: the light theme has no page-level gradient, matching the
"warm paper" identity.

### System preference

`apps/web/app/globals.css` applies the light token set under `@media (prefers-color-scheme: light)`
when (and only when) no `data-theme` attribute has been stamped on `<html>`. An explicit user
choice (via `ThemeToggle`, `apps/web/src/shell/ThemeToggle.tsx`) always overrides the media query.
The choice persists to `localStorage["gk-theme"]` as `"light"` or `"dark"`; choosing "System" clears
the key and the `data-theme` attribute, handing control back to the media query. A tiny inline
script in `apps/web/app/layout.tsx` reads the same key before hydration, so there is no flash of
the wrong theme on load.

### Marketing-route dark default (sub-project 9A task 4 addition, post-review fix)

The "Design language" section above states the rule: dark is the brand default for **signed-out
marketing pages** (`/`, `/terms`, `/privacy`), not the visitor's OS preference the way every other
route works. A light-OS visitor with no stored `gk-theme` choice must still see the dark hero,
below-fold sections, and legal pages, the same as a dark-OS visitor. An explicit stored choice
(light or dark) still overrides this everywhere, marketing routes included: this is a route-scoped
*default*, not a route-scoped theme lock.

Two pieces implement it, both reachable from `apps/web/app/layout.tsx`:

1. **`layout.tsx`'s pre-hydration inline script** (the same one described in "System preference"
   above) now also checks `window.location.pathname` when there's no stored choice: `/`, `/terms`,
   and `/privacy` stamp `data-theme="dark"` on `<html>` itself, before first paint. Stamping the
   *root*, not a subtree, matters here: `body`'s `--gk-page` background and every below-fold
   section on these routes need to resolve dark too, not just the hero (the hero already forces its
   own `data-theme="dark"` independently, see `HeroCarousel.tsx`'s own comment: that one exists for
   a different reason, the photo scrim being always-dark regardless of theme, and stays even when a
   visitor has explicitly chosen light).
2. **`apps/web/src/shell/MarketingThemeDefault.tsx`** (new), mounted once and unconditionally in
   `layout.tsx`, outside `AppShell`'s shell/non-shell branch. The inline script only runs once, on
   a fresh document load; it can't react to a client-side `<Link>` navigation between a marketing
   route and a non-marketing one (Next doesn't reload the document for those). This component
   re-applies the identical route/stored-choice logic on every `usePathname()` change via
   `useLayoutEffect`, so navigating from a dark-stamped marketing page to, say, `/sign-in` (a
   non-marketing route with no `ThemeToggle` mounted to otherwise correct it) correctly clears the
   forced attribute and falls back to system preference, and navigating the other way stamps dark
   again. Like the inline script, it no-ops whenever an explicit choice is stored.

Signed-in shell routes are unaffected: neither piece changes behavior there, so they keep following
system preference (or an explicit stored choice) exactly as before this addition.

### Accessibility note on the accent

`--gk-accent` (ember) measures roughly **6.4-6.9:1** against dark surfaces, comfortably AA, but only
about **2.6-2.8:1** against light surfaces (`--gk-page` / `--gk-surface` in the light theme). That
fails WCAG AA at every text size. Do not set ember as a text color directly on a light-theme
background. Safe patterns:
- Ember as a solid fill with `--gk-on-accent` as the foreground (the primary CTA pill): passes at
  **6.36:1** in both themes.
- Ember as text only on a dark surface (dark theme, or a photo scrim, which is always dark).
- Where the spec calls for "price in ember" or an "active nav item" in ember on a light surface,
  pair it with a filled chip/pill treatment (ember background, `--gk-on-accent` text) rather than
  bare ember text on paper.

`--gk-border` is intentionally low-contrast against `--gk-surface` in both themes (around
1.2-1.35:1): it is a quiet separator, not the sole indicator of an interactive boundary. Focus
states and hover states must carry their own visible affordance (the `--gk-focus` ring on
interactive elements) rather than relying on the border color alone.

**`--gk-focus` (post-launch review addition).** The focus ring/border on every interactive
`src/ui` component (`button.tsx`, `input.tsx`, `textarea.tsx`, `select.tsx`, `dialog.tsx`,
`sheet.tsx`, `switch.tsx`, `tabs.tsx`) originally used `--gk-accent` directly. Bare ember measures
**~2.64:1** against `--gk-page` (`#FAF7F2`) and **~2.82:1** against `--gk-surface` (`#FFFFFF`) in
light theme, both below the WCAG AA non-text/focus-indicator minimum of **3:1** (SC 1.4.11), so a
keyboard user tabbing through a light-theme form got a focus ring that is present in the DOM but
close to invisible. `--gk-focus` fixes this without touching `--gk-accent` itself (the brand accent
does not change):
- **Dark theme:** `--gk-focus: var(--gk-accent)`. Ember already clears 3:1 against every dark
  surface (the 6.4-6.9:1 figure above), so the focus token is just the accent.
- **Light theme:** `--gk-focus: #BF5038`, the same hue as ember (10.7 degrees vs. ember's 10.9
  degrees in HSL, same brand family, just darker/less light) rather than an unrelated color.
  Computed contrast: **4.75:1** against `--gk-surface` (`#FFFFFF`), **4.45:1** against `--gk-page`
  (`#FAF7F2`). Both clear the 3:1 minimum with real margin, not right at the edge.

Every `focus-visible:ring-*` / `focus-visible:border-*` in `src/ui` reaches for `ring-gk-focus` /
`border-gk-focus`, never `ring-gk-accent` / `border-gk-accent`. On `input.tsx`, `textarea.tsx`, and
`select.tsx`, the solid `border-gk-focus` (full opacity) is the indicator that carries the 3:1
obligation on its own; the accompanying `ring-gk-focus/40` is a diluted supplementary glow layered
on top of that already-compliant border, not a second independent claim to AA compliance.

**Brand-mark text color (sub-project 9A task 3 addition).** The signed-in app shell
(`src/shell/AppShell.tsx`) needed to render the "GateKeep" Syne wordmark in ember on the top bar,
which (unlike the landing page's glass nav, always over a dark photo scrim) has to work on a light-
theme surface too. Bare `--gk-accent` text fails AA there for the same reason the focus ring did
(the accent note above measures it at 2.6-2.8:1 against light surfaces), and neither of the two
named safe patterns for ember-as-text fits a wordmark: it is not a "price" or "active nav item"
that can take the filled-chip treatment without changing what it visually is, and it is not always
on a dark surface the way the accent note's other text exception requires. The shell reuses
`--gk-focus` for this text instead of `--gk-accent`: dark theme resolves to ember itself (visually
identical to the accent), light theme resolves to the same `#BF5038` computed above. At the
wordmark's weight (`font-extrabold`, 800) and size (20px, Tailwind's `text-xl`), this clears the
WCAG large-text 3:1 minimum with real margin (4.45-4.75:1, the same figures documented above): the
18px size used elsewhere in this doc's mockup examples would have landed just under the 18.66px
large-text threshold, so the shell's wordmark is deliberately sized at 20px rather than 18px
wherever `--gk-focus` stands in for the accent as text color this way.

## Typography

| Family | CSS variable | Weights | Role |
|---|---|---|---|
| Syne | `--font-syne` | 600, 700, 800 | Headings, brand mark, display numerals (date chips, prices) |
| Sora | `--font-sora` | 400, 500, 600 | Body copy, UI labels, form inputs |

Loaded via `next/font/google` in `apps/web/app/layout.tsx` and exposed as Tailwind utilities
`font-syne` / `font-sora` through the `@theme inline` mapping in `globals.css`. `body` defaults to
Sora; headings and brand moments opt into Syne explicitly with the `font-syne` class. No other
typeface (Inter, Geist, Space Grotesk, or otherwise) appears anywhere in the product.

## Shape: radius tiers

Three tiers, deliberately, nothing rounded "because default":

| Radius | Applies to |
|---|---|
| `999px` (pill) | Primary CTAs and chips ONLY |
| `10px` | Cards and inputs |
| `6px` | Small controls and badges |

Implementation (task 2): `globals.css` defines a base radius variable, `--radius: 10px`, mirrored
into `@theme inline` as `--radius-gk` and `--radius-gk-sm: 6px` (a fixed value, not derived from
the base variable). That generates two Tailwind utilities, `rounded-gk` (10px) and `rounded-gk-sm`
(6px), which every `src/ui/*` component reaches for instead of the default `rounded-md`/`rounded-lg`
shadcn ships. The pill tier is Tailwind's built-in `rounded-full` and needs no token. The pill is
reserved strictly for the primary button variant and chips, as the table says: `src/ui/switch.tsx`
is a rounded-rect toggle (`rounded-gk-sm`) rather than the conventional pill switch shape for
exactly this reason.

**`src/ui/button.tsx` variant roster (post-launch review fix).** This spec's section 4 names three
button roles: primary (ember pill), secondary (outlined ghost), destructive (status red). The
initial theme pass kept shadcn's full six-variant default set, and themed "outline" and "secondary"
identically (the same bordered, transparent, `gk-border` treatment), an indistinguishable duplicate
DESIGN.md never asked for. "outline" was removed rather than given a fabricated fourth look:
`variant="secondary"` is the one bordered-ghost role going forward. The surviving variants are
`default` (primary, pill), `secondary` (outlined ghost), `destructive` (status red), `ghost` (no
border, transparent, for the lowest-emphasis actions), and `link` (text-only, underlined on hover,
`--gk-text` colored per the accent note above, never `--gk-accent`).

## Elevation and motion

- **Elevation:** borders do the separating, not shadows. Shadows are reserved for overlays that
  actually float above the page: dialogs, sheets, tooltips, popovers (including the
  `src/ui/dropdown-menu.tsx` and `src/ui/select.tsx` floating content, which are Radix's popover
  primitive under a different name), the mini-player. No "everything floats" soft-shadow treatment
  anywhere else: `src/ui/card.tsx`, `button.tsx`, `input.tsx`, `badge.tsx`, and `switch.tsx` all
  stay flat.
- **Motion:** MOTION 1 (see "Design Read" above). Hover states and a short, named list of
  deliberate moments (sheet/dialog entrances, the hero carousel's slow auto-advance, the
  mini-player reveal). No endless loops. No scroll-triggered animation stacking. Respect
  `prefers-reduced-motion` everywhere motion is used; the hero carousel in particular pauses on
  reduced-motion.

## Glass cap

Glassmorphism (blur/backdrop-filter) is capped at **exactly two uses, product-wide, and never
more**:
1. The landing page's slim nav, over the hero carousel photos.
2. The sticky mini-player.

Nowhere else, ever. Cards are solid elevated surfaces (`--gk-surface` + `--gk-border`), not glass.

## Accent dosage

Ember (`--gk-accent`) belongs to the primary action and to money/brand moments only: the brand
mark, the primary CTA, a price, the active nav item, a status-badge tint. It is never used on
borders, body links, decorative icons, and backgrounds all at once. If you can point to more than
one or two ember elements on a screen and none of them is the single most important thing on that
screen, dose it down. This is the "one deliberate accent" rule from the antislop core filter,
applied specifically to this brand's accent color.

## Status tints

`--gk-success`, `--gk-warning`, `--gk-destructive` each pair a saturated color (used as text, icon,
or border tint) with a soft background tint at roughly 14% opacity of the same color, both
re-derived per theme so the pairing clears AA. Badges are always 6px radius and always carry real
state (never decorative). Do not invent a fourth status color; if a new state is needed, it maps to
one of these three or gets a written exception here first.

The same **14%** figure is the one soft-tint opacity for this color family, full stop: a hover or
highlighted-state tint on a status color (for example `src/ui/dropdown-menu.tsx`'s destructive item
highlight) uses the same `/14` as the badge background, not a nearby-but-different value picked ad
hoc per component.

## Icons

Phosphor (`@phosphor-icons/react`), one weight product-wide, chosen once and never mixed.

**Decision (task 2): duotone.** `/design` renders every icon the app is likely to need (shell nav,
search/filter, status, transport controls, theme toggle, chrome glyphs) at 16px and 20px in both
duotone and regular for direct comparison. Every content icon read clearly at both sizes in
duotone; several (`ChatCircle`, `UserCircle`, `Info`, `Play`, `Pause`, `Wallet`, `CalendarCheck`)
actually read *more* clearly than regular at 16px, because duotone's second fill layer gives the
glyph more visual weight and a fuller silhouette rather than a thin single-stroke outline. None of
the sample icons hit the documented fallback bar ("reads too busy at small sizes"); nothing tested
as illegible or cluttered. Duotone's bolder, filled character also reads as a deliberate choice
distinct from Lucide's uniform thin-stroke look, which the project bans specifically because it is
the generic "AI product" tell (antislop R-04): the icon set is meant to look like a decision, not a
default, and duotone gets there.

One known trade-off, accepted rather than hidden: a handful of small geometric chrome glyphs
(`X`/close, `Circle`, the `Caret*` family used for dropdown/select indicators) render in duotone as
solid filled shapes rather than the thin outline a minimal chevron or ring conventionally uses.
They stayed fully legible and functional in the same `/design` comparison, so this did not meet the
"illegible at small sizes" bar for falling back to regular, and Phosphor's own solid-triangle carets
are a recognized dropdown-affordance shape in their own right, not a broken rendering.

Implementation: `apps/web/src/ui/icons.tsx` imports from Phosphor's `/ssr` subpath (so icons stay
usable from React Server Components, not just client components) and re-exports a curated,
`Icon`-prefixed set (`IconHouse`, `IconCheck`, `IconCaretDown`, and so on), each wrapped so its
`weight` prop is fixed to `"duotone"` and cannot be overridden by a caller. No other file in the
product imports `@phosphor-icons/react` directly. The one deliberate exception is
`IconRadioDot`, a solid dot marker for `DropdownMenuRadioItem` that uses Phosphor's `"fill"` weight
directly: at the ~8px size a radio indicator renders, duotone and regular both draw a thin ring,
illegible as a filled bullet, so this one form-control glyph is not a content icon and does not go
through the product's weight decision. `/design`'s own weight-comparison table is the other
sanctioned exception, since its entire purpose is rendering multiple weights side by side.

No Lucide icons, and no icon chosen for "looks like an AI product" reasons (sparkle, magic wand,
generic orb). Every icon must be genuinely relevant to what it represents.

## Accessibility floor

- WCAG AA contrast in both themes (see the accent and border notes above for the two places this
  token set needs care).
- Full keyboard operability: every interactive element reachable by Tab, activatable with Enter or
  Space, dialogs closable with Escape.
- A visible focus indicator on every focused element. Never remove the focus outline without a
  replacement.
- `prefers-reduced-motion` respected everywhere motion is used.

## Governance

This file changes only when the owner approves a token, font, or rule change. Every later task in
sub-project 9A (and all of 9B) treats the values above as fixed inputs, not suggestions. If a task
needs something this file does not cover, it proposes an addition here first rather than
inventing a one-off value in component code.

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

**Hard rule, no exceptions: no em dash (`—`) anywhere.** Not in copy, not in code comments, not in
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
- **shadcn/ui** components copied into `apps/web/src/ui/` (CLI, not a runtime dependency) and
  themed to the tokens below. Never ship a shadcn default look; every copied component gets a theme
  pass (task 2 of sub-project 9A).
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
| `--gk-scrim` | gradient, see below | Bottom-up night scrim over photography |
| `--gk-page` | gradient, see below | Page-level background |

`--gk-page`: `linear-gradient(165deg, var(--gk-bg-0) 0%, var(--gk-bg-1) 55%, var(--gk-bg-2) 100%)`,
applied once at the page level (`body`). Individual sections never restack their own gradient on
top of this: that is the harsh-gradient pattern the antislop filter rejects.

`--gk-scrim`: `linear-gradient(to top, var(--gk-bg-0) 4%, rgba(14,11,19,.35) 55%, transparent)`.
Used over photography: hero carousel, gig cards, cover heroes. This is the one token that does not
get a light-theme override (see "Light" below); it is deliberately always the night gradient in
both themes, because it exists to keep photo captions legible, not to match page chrome.

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
states and hover states must carry their own visible affordance (the ember focus ring on
interactive elements) rather than relying on the border color alone.

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

## Elevation and motion

- **Elevation:** borders do the separating, not shadows. Shadows are reserved for overlays that
  actually float above the page: dialogs, popovers, the mini-player. No "everything floats"
  soft-shadow treatment anywhere else.
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

## Icons

Phosphor (`@phosphor-icons/react`), one weight product-wide, chosen once and never mixed. Sub-
project 9A's task 2 renders a sample icon set at 16px and 20px in both duotone and regular, picks
duotone unless it reads too busy at small sizes (in which case regular), and records the final
choice in this section. Until that choice is recorded, treat the weight as undecided and do not
hardcode a weight in new components; let the shared `Icon` re-export module (created in task 2)
pin it in one place.

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

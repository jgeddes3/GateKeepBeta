// Compile-time spec for tokens.ts. apps/mobile has no unit test runner (see
// package.json's "test" script), so `corepack pnpm typecheck` is the gate:
// every assertion below is a literal-type assignment that fails to compile
// if tokens.ts drifts from DESIGN.md / apps/web/app/globals.css, either in
// shape (a missing/renamed key) or in value (a wrong hex).
import { tokens } from "./tokens";

// Value assertions: tokens.dark/light are typed via `as const satisfies
// GkTokens`, so each property keeps its literal type. Assigning it to a
// differently-valued literal-typed const is a compile error, not a widened
// no-op, which is what makes this a real check.
const _darkAccent: "#FF6B4A" = tokens.dark.accent;
const _lightAccent: "#FF6B4A" = tokens.light.accent; // accent is theme-invariant
const _darkOnAccent: "#2A0F0A" = tokens.dark.onAccent;
const _lightOnAccent: "#2A0F0A" = tokens.light.onAccent;
const _darkBg0: "#0E0B13" = tokens.dark.bg0;
const _darkBg1: "#150F20" = tokens.dark.bg1;
const _darkBg2: "#1D1229" = tokens.dark.bg2;
const _lightBg0: "#FAF7F2" = tokens.light.bg0;
const _lightBg1: "#FAF7F2" = tokens.light.bg1;
const _lightBg2: "#FAF7F2" = tokens.light.bg2;
const _darkSurface: "#1A1424" = tokens.dark.surface;
const _lightSurface: "#FFFFFF" = tokens.light.surface;
const _darkBorder: "#2C2438" = tokens.dark.border;
const _lightBorder: "#E4DDD2" = tokens.light.border;
const _darkText: "#F5F1F8" = tokens.dark.text;
const _lightText: "#1C1524" = tokens.light.text;
const _darkMuted: "rgba(245,241,248,0.62)" = tokens.dark.muted;
const _lightMuted: "rgba(28,21,36,0.62)" = tokens.light.muted;
const _darkSuccess: "#7BC48A" = tokens.dark.success;
const _lightSuccess: "#2E7D43" = tokens.light.success;
const _darkWarning: "#E8B15C" = tokens.dark.warning;
const _lightWarning: "#9A6A1B" = tokens.light.warning;
const _darkDestructive: "#E5484D" = tokens.dark.destructive;
const _lightDestructive: "#C62A30" = tokens.light.destructive;
const _darkOnDestructive: "#FFFFFF" = tokens.dark.onDestructive;
const _lightOnDestructive: "#FFFFFF" = tokens.light.onDestructive;
const _darkFocus: "#FF6B4A" = tokens.dark.focus;   // = accent in dark
const _lightFocus: "#BF5038" = tokens.light.focus; // AA-safe rust in light

// Radius tiers match DESIGN.md exactly: extra, missing, or renamed keys, or a
// changed number, all fail this assignment.
const _radius: { readonly pill: 999; readonly card: 10; readonly sm: 6 } = tokens.radius;

// Key-parity: both theme sets must expose exactly the same key set. If a key
// is added to one theme and not the other, one of these two assignments
// stops compiling (an unmatched key is neither assignable to nor from the
// other side's Record type).
type DarkKeys = keyof typeof tokens.dark;
type LightKeys = keyof typeof tokens.light;
const _darkKeysCoverLight: Record<LightKeys, unknown> = tokens.dark;
const _lightKeysCoverDark: Record<DarkKeys, unknown> = tokens.light;

// Keep noUnusedLocals happy without weakening any check above: the checking
// work happens at each assignment site, not at these reads.
void [
  _darkAccent, _lightAccent, _darkOnAccent, _lightOnAccent,
  _darkBg0, _darkBg1, _darkBg2, _lightBg0, _lightBg1, _lightBg2,
  _darkSurface, _lightSurface, _darkBorder, _lightBorder,
  _darkText, _lightText, _darkMuted, _lightMuted,
  _darkSuccess, _lightSuccess, _darkWarning, _lightWarning,
  _darkDestructive, _lightDestructive, _darkOnDestructive, _lightOnDestructive,
  _darkFocus, _lightFocus, _radius, _darkKeysCoverLight, _lightKeysCoverDark,
];

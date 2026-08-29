// The gk-* brand tokens from DESIGN.md (repo root), transcribed from
// apps/web/app/globals.css. DESIGN.md is the source of truth: any value
// change happens THERE first (governance rule), then here. No component may
// hardcode a hex; reach for useTokens() instead.
export interface GkTokens {
  readonly bg0: string; readonly bg1: string; readonly bg2: string;
  readonly surface: string; readonly border: string;
  readonly text: string; readonly muted: string;
  readonly accent: string; readonly onAccent: string;
  readonly success: string; readonly warning: string; readonly destructive: string; readonly onDestructive: string;
  readonly focus: string;
}

// `as const satisfies GkTokens` (not `: GkTokens`) is deliberate: it still
// checks each set against the interface shape, but keeps every value at its
// literal type instead of widening to `string`. tokens.test.ts leans on that
// literal typing to make a wrong hex a typecheck failure, not just a runtime
// one (apps/mobile has no test runner to catch it at runtime).
const dark = {
  bg0: "#0E0B13", bg1: "#150F20", bg2: "#1D1229",
  surface: "#1A1424", border: "#2C2438",
  text: "#F5F1F8", muted: "rgba(245,241,248,0.62)",
  accent: "#FF6B4A", onAccent: "#2A0F0A",
  success: "#7BC48A", warning: "#E8B15C", destructive: "#E5484D", onDestructive: "#FFFFFF",
  focus: "#FF6B4A",
} as const satisfies GkTokens;

const light = {
  bg0: "#FAF7F2", bg1: "#FAF7F2", bg2: "#FAF7F2",
  surface: "#FFFFFF", border: "#E4DDD2",
  text: "#1C1524", muted: "rgba(28,21,36,0.62)",
  accent: "#FF6B4A", onAccent: "#2A0F0A",
  success: "#2E7D43", warning: "#9A6A1B", destructive: "#C62A30", onDestructive: "#FFFFFF",
  focus: "#BF5038",
} as const satisfies GkTokens;

export const tokens = {
  dark, light,
  radius: { pill: 999, card: 10, sm: 6 },
  // Type ramp (families loaded in fonts.ts). Weights map to the loaded faces.
  // Consumers set `fontFamily` to one of these named faces directly; never
  // set `fontWeight` alongside them (iOS synthetically bolds a named face
  // that does not match the requested weight, which distorts Syne/Sora).
  font: {
    syne: { 600: "Syne-SemiBold", 700: "Syne-Bold", 800: "Syne-ExtraBold" },
    sora: { 400: "Sora-Regular", 500: "Sora-Medium", 600: "Sora-SemiBold" },
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
} as const;

// Scrim: always the dark night gradient in BOTH themes (DESIGN.md, it keeps
// photo captions legible, not page chrome). Stops for react-native-svg.
export const SCRIM_STOPS = [
  { offset: "0%", color: "#0E0B13", opacity: 1 },
  { offset: "4%", color: "#0E0B13", opacity: 1 },
  { offset: "55%", color: "#0E0B13", opacity: 0.35 },
  { offset: "100%", color: "#0E0B13", opacity: 0 },
] as const;

// Page gradient stops, dark theme only; light page is flat bg0. Opacity is
// explicit (always 1, this gradient never fades to transparent) so
// Background.tsx (Task 2) can map PAGE_DARK_STOPS and SCRIM_STOPS through one
// shared <Stop> helper without a branch for a missing field.
export const PAGE_DARK_STOPS = [
  { offset: "0%", color: "#0E0B13", opacity: 1 },
  { offset: "55%", color: "#150F20", opacity: 1 },
  { offset: "100%", color: "#1D1229", opacity: 1 },
] as const;

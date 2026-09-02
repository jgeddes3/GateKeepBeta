# Mobile UI/UX Redesign (Sub-project 9B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the "Ember, Deeper Night" brand (`DESIGN.md`, shipped on web in 9A) to the Expo app `apps/mobile`, as a pure-presentation redesign: a token/theme layer, an owned `src/ui` primitive library, a retinted tab-bar shell, every screen restyled with branded loading/empty/error states, and the two 9A carry-forwards.

**Architecture:** React context `ThemeProvider` resolves the active theme (AsyncStorage choice or `useColorScheme()`, dark default) and feeds a typed token object through a `useTokens()` hook. An owned `apps/mobile/src/ui/` primitive set consumes `useTokens()` and replaces every scattered inline hex. Icons are Phosphor duotone via `phosphor-react-native` + `react-native-svg`; the same `react-native-svg` renders the page/scrim gradients. Fonts (Syne + Sora) load at runtime via `expo-font`. Behavior is untouched throughout.

**Tech Stack:** Expo SDK 57, React Native 0.86, expo-router, expo-font (installed), @react-native-async-storage/async-storage (installed), phosphor-react-native + react-native-svg (added task 1), TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-29-mobile-uiux-design.md`, binding. Brand contract: repo-root `DESIGN.md` (fixed input, not re-decided). Web reference primitives: `apps/web/src/ui/*`.

---

## Binding rules (every task respects these)

1. **Behavior UNTOUCHED.** Retint/retype/restyle only. Never change when a state fires, what data drives it, which callable runs, navigation structure, or query shape. The backend gate counts must hold: `emu:test 578`, `emu:rules 77`, `shared 153`. 9B must not edit `functions/` or `packages/shared/` (a money-sentence already shared is already colonized; do not touch shared).
2. **No em dash (U+2014) anywhere** in 9B code, comments, or copy (DESIGN.md). Use comma/period/colon/parentheses.
3. **No hardcoded hex in components.** After task 2, every color comes from `useTokens()`. A literal `#...` in a screen file is a defect (except inside `tokens.ts` itself and the font/asset config).
4. **No Phosphor import outside `src/ui/icons.tsx`.** No Lucide, ever. No font family named outside `Text.tsx`/`tokens.ts`.
5. **This machine cannot run the dev client.** Verify with `npx expo export --platform ios` (bundles + links native deps) + `corepack pnpm --filter @gatekeep/mobile lint` + `corepack pnpm typecheck`. Never claim a visual result; the owner verifies live on the next EAS build.
6. **Money surfaces are markup-only** (task 9): a mechanical diff must show zero drift in handlers, callables, queries, dependency arrays, and `===`-compared shared strings.

## Environment

Windows. `corepack pnpm`. PowerShell tool cwd is the MAIN repo, `Set-Location` into the worktree every call. `expo export` is long; run it as ONE blocking foreground call, never background. Edit docs byte-safe (Edit tool / bash+sed), never PS 5.1 string pipelines. `hermesc.exe` is App-Control-blocked here (sp5b ruling 11), irrelevant to `expo export`, which does not invoke it.

## Exact token values (from `apps/web/app/globals.css`, transcribed in task 1)

Dark: bg0 `#0E0B13`, bg1 `#150F20`, bg2 `#1D1229`, surface `#1A1424`, border `#2C2438`, text `#F5F1F8`, muted `rgba(245,241,248,0.62)`, accent `#FF6B4A`, onAccent `#2A0F0A`, success `#7BC48A`, warning `#E8B15C`, destructive `#E5484D`, onDestructive `#FFFFFF`, focus `#FF6B4A` (= accent).
Light: bg0/1/2 `#FAF7F2`, surface `#FFFFFF`, border `#E4DDD2`, text `#1C1524`, muted `rgba(28,21,36,0.62)`, accent `#FF6B4A`, onAccent `#2A0F0A`, success `#2E7D43`, warning `#9A6A1B`, destructive `#C62A30`, onDestructive `#FFFFFF`, focus `#BF5038`.
Radius: pill `999`, card `10`, sm `6`. Scrim gradient (both themes): top→bottom `#0E0B13` at 4% → `rgba(14,11,19,0.35)` at 55% → transparent. Page gradient (dark only): 165deg `#0E0B13` 0% → `#150F20` 55% → `#1D1229` 100%; light page: flat `#FAF7F2`.

---

## File structure

**New, `apps/mobile/src/theme/`:** `tokens.ts` (typed token object + scales), `ThemeProvider.tsx` (context, `useTokens`, `useThemeChoice`), `fonts.ts` (`useAppFonts`).
**New, `apps/mobile/src/ui/`:** `Text.tsx`, `Button.tsx`, `Card.tsx`, `Chip.tsx`, `Badge.tsx`, `StatusBadge.tsx`, `Input.tsx`, `TextArea.tsx`, `Sheet.tsx`, `Skeleton.tsx`, `ThemeToggle.tsx`, `Background.tsx` (page/scrim gradient via svg), `icons.tsx`.
**New assets:** `apps/mobile/assets/fonts/` (Syne + Sora TTFs).
**Modified:** `app/_layout.tsx` (providers + fonts), every `app/(group)/_layout.tsx` (tab bars), every screen under `app/` and `src/` (token sweep), `package.json` (+ 2 native deps).
**Untouched:** `functions/`, `packages/shared/`.

---

### Task 1: Theme layer + native deps + fonts

**Files:**
- Modify: `apps/mobile/package.json` (add deps)
- Create: `apps/mobile/src/theme/tokens.ts`, `apps/mobile/src/theme/ThemeProvider.tsx`, `apps/mobile/src/theme/fonts.ts`
- Create: `apps/mobile/assets/fonts/` (TTFs)
- Modify: `apps/mobile/app/_layout.tsx`
- Test: `apps/mobile/src/theme/tokens.test.ts`

- [ ] **Step 1: Add native + font deps**

Run from the worktree:
```
corepack pnpm add react-native-svg phosphor-react-native --filter @gatekeep/mobile
```
Then add the font files. Download the TTFs into `apps/mobile/assets/fonts/`:
`Syne-SemiBold.ttf` (600), `Syne-Bold.ttf` (700), `Syne-ExtraBold.ttf` (800),
`Sora-Regular.ttf` (400), `Sora-Medium.ttf` (500), `Sora-SemiBold.ttf` (600).
(Source: Google Fonts Syne + Sora static TTFs. If offline, copy the exact TTFs `apps/web`'s
`next/font` cached under `apps/web/.next` or fetch from the fonts.google.com download; the file
names above are what `fonts.ts` references.)

- [ ] **Step 2: Write the failing token test**, `apps/mobile/src/theme/tokens.test.ts`

```ts
import { tokens } from "./tokens";

test("dark and light token sets are complete and match DESIGN.md", () => {
  expect(tokens.dark.accent).toBe("#FF6B4A");
  expect(tokens.light.accent).toBe("#FF6B4A"); // accent is theme-invariant
  expect(tokens.dark.surface).toBe("#1A1424");
  expect(tokens.light.surface).toBe("#FFFFFF");
  expect(tokens.dark.focus).toBe("#FF6B4A");   // = accent in dark
  expect(tokens.light.focus).toBe("#BF5038");  // AA-safe rust in light
  expect(tokens.dark.onAccent).toBe("#2A0F0A");
  expect(tokens.light.onDestructive).toBe("#FFFFFF");
  // both themes define the same key set
  expect(Object.keys(tokens.dark).sort()).toEqual(Object.keys(tokens.light).sort());
});

test("radius tiers match DESIGN.md", () => {
  expect(tokens.radius).toEqual({ pill: 999, card: 10, sm: 6 });
});
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `corepack pnpm --filter @gatekeep/mobile exec vitest run src/theme/tokens.test.ts` (if mobile
has no vitest, run the assertion via `corepack pnpm typecheck` failing on the missing module first,
then treat the test as a typecheck-backed spec, see note). Expected: FAIL, `tokens` not found.

> Note: `apps/mobile` may not have a unit test runner wired. If `vitest`/`jest` is absent, DO NOT add
> one (out of scope). Instead make `tokens.test.ts` a `.ts` type-level assertion file compiled by
> `tsc` (use `satisfies` and const assertions so a wrong shape is a typecheck error), and the gate
> becomes `corepack pnpm typecheck`. Keep the value assertions as `const _check: true = (tokens.dark.accent === "#FF6B4A") as ...` compile-time checks, or simplest: leave the runtime `test()` calls only if a runner exists. Prefer the typecheck form if no runner.

- [ ] **Step 4: Write `tokens.ts`**

```ts
// The gk-* brand tokens from DESIGN.md (repo root), transcribed from
// apps/web/app/globals.css. DESIGN.md is the source of truth: any value
// change happens THERE first (governance rule), then here. No component may
// hardcode a hex; reach for useTokens() instead.
export interface GkTokens {
  bg0: string; bg1: string; bg2: string;
  surface: string; border: string;
  text: string; muted: string;
  accent: string; onAccent: string;
  success: string; warning: string; destructive: string; onDestructive: string;
  focus: string;
}

const dark: GkTokens = {
  bg0: "#0E0B13", bg1: "#150F20", bg2: "#1D1229",
  surface: "#1A1424", border: "#2C2438",
  text: "#F5F1F8", muted: "rgba(245,241,248,0.62)",
  accent: "#FF6B4A", onAccent: "#2A0F0A",
  success: "#7BC48A", warning: "#E8B15C", destructive: "#E5484D", onDestructive: "#FFFFFF",
  focus: "#FF6B4A",
};

const light: GkTokens = {
  bg0: "#FAF7F2", bg1: "#FAF7F2", bg2: "#FAF7F2",
  surface: "#FFFFFF", border: "#E4DDD2",
  text: "#1C1524", muted: "rgba(28,21,36,0.62)",
  accent: "#FF6B4A", onAccent: "#2A0F0A",
  success: "#2E7D43", warning: "#9A6A1B", destructive: "#C62A30", onDestructive: "#FFFFFF",
  focus: "#BF5038",
};

export const tokens = {
  dark, light,
  radius: { pill: 999, card: 10, sm: 6 },
  // Type ramp (families loaded in fonts.ts). Weights map to the loaded faces.
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

// Page gradient stops, dark theme only; light page is flat bg0.
export const PAGE_DARK_STOPS = [
  { offset: "0%", color: "#0E0B13" },
  { offset: "55%", color: "#150F20" },
  { offset: "100%", color: "#1D1229" },
] as const;
```

- [ ] **Step 5: Write `ThemeProvider.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { tokens, type GkTokens } from "./tokens";

type ThemeChoice = "light" | "dark" | "system";
const KEY = "gk-theme";

interface Ctx {
  t: GkTokens;               // active token set
  active: "light" | "dark";  // resolved theme
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
}
const ThemeCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme(); // "light" | "dark" | null
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === "light" || v === "dark") setChoiceState(v);
      setReady(true);
    });
  }, []);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    if (c === "system") AsyncStorage.removeItem(KEY);
    else AsyncStorage.setItem(KEY, c);
  };

  // Dark is the brand default when system is unknown (DESIGN.md).
  const active: "light" | "dark" =
    choice === "system" ? (system === "light" ? "light" : "dark") : choice;
  const t = active === "light" ? tokens.light : tokens.dark;

  if (!ready) return null; // avoids a first-paint flash of the wrong theme
  return <ThemeCtx.Provider value={{ t, active, choice, setChoice }}>{children}</ThemeCtx.Provider>;
}

export function useTokens(): GkTokens {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useTokens must be used inside ThemeProvider");
  return c.t;
}
export function useThemeChoice() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useThemeChoice must be used inside ThemeProvider");
  return { choice: c.choice, active: c.active, setChoice: c.setChoice };
}
```

- [ ] **Step 6: Write `fonts.ts`**

```ts
import { useFonts } from "expo-font";

export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    "Syne-SemiBold": require("../../assets/fonts/Syne-SemiBold.ttf"),
    "Syne-Bold": require("../../assets/fonts/Syne-Bold.ttf"),
    "Syne-ExtraBold": require("../../assets/fonts/Syne-ExtraBold.ttf"),
    "Sora-Regular": require("../../assets/fonts/Sora-Regular.ttf"),
    "Sora-Medium": require("../../assets/fonts/Sora-Medium.ttf"),
    "Sora-SemiBold": require("../../assets/fonts/Sora-SemiBold.ttf"),
  });
  return loaded;
}
```

- [ ] **Step 7: Wire `_layout.tsx`**, wrap the tree with `ThemeProvider` (outermost, so every provider
below can theme) and hold the splash until fonts load. Add near the top of `RootLayout`:

```tsx
import * as SplashScreen from "expo-splash-screen";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { useAppFonts } from "../src/theme/fonts";
// ...
SplashScreen.preventAutoHideAsync().catch(() => {});
// inside RootLayout, before returning:
const fontsLoaded = useAppFonts();
useEffect(() => { if (fontsLoaded) SplashScreen.hideAsync().catch(() => {}); }, [fontsLoaded]);
if (!fontsLoaded) return null;
return (
  <ThemeProvider>
    <AuthProvider><ProfileProvider><MaybeStripeProvider><Gate /></MaybeStripeProvider></ProfileProvider></AuthProvider>
  </ThemeProvider>
);
```
(`expo-splash-screen` is already a plugin in `app.json`; import is available. Keep the existing
`setAudioModeAsync` effect and Sentry init unchanged.)

- [ ] **Step 8: Gates**

Run (blocking foreground, worktree): `corepack pnpm typecheck` (5/5) · `corepack pnpm --filter @gatekeep/mobile lint` (0 err) · `npx expo export --platform ios` in `apps/mobile` (bundles; proves `react-native-svg`/`phosphor-react-native` link and the TTFs resolve).

- [ ] **Step 9: Commit**

```
git add apps/mobile/src/theme apps/mobile/assets/fonts apps/mobile/app/_layout.tsx apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(mobile): theme layer, tokens, ThemeProvider, runtime fonts, native icon deps"
```

---
### Task 2: Primitive library (`apps/mobile/src/ui/`)

**Files:** Create each file below. Test: `apps/mobile/src/ui/icons.tsx` compiles + `expo export` links.
Mirror the web contract at `apps/web/src/ui/<name>.tsx` for each, RN-native.

- [ ] **Step 1: `icons.tsx`**, Phosphor duotone, weight locked, curated `Icon`-prefixed set. No other
file imports `phosphor-react-native`.

```tsx
// The ONLY file importing phosphor-react-native. Weight is fixed to "duotone"
// product-wide (DESIGN.md) and cannot be overridden by a caller. No Lucide.
import * as Ph from "phosphor-react-native";
import { useTokens } from "../theme/ThemeProvider";

type Props = { size?: number; color?: string };
function wrap(Comp: React.ComponentType<Ph.IconProps>) {
  return function Icon({ size = 20, color }: Props) {
    const t = useTokens();
    return <Comp size={size} color={color ?? t.text} weight="duotone" />;
  };
}
export const IconHouse = wrap(Ph.House);
export const IconMagnifyingGlass = wrap(Ph.MagnifyingGlass);
export const IconCalendarCheck = wrap(Ph.CalendarCheck);
export const IconChatCircle = wrap(Ph.ChatCircle);
export const IconUserCircle = wrap(Ph.UserCircle);
export const IconWallet = wrap(Ph.Wallet);
export const IconMusicNotes = wrap(Ph.MusicNotes);
export const IconTicket = wrap(Ph.Ticket);
export const IconPlay = wrap(Ph.Play);
export const IconPause = wrap(Ph.Pause);
export const IconCheck = wrap(Ph.Check);
export const IconX = wrap(Ph.X);
export const IconCaretLeft = wrap(Ph.CaretLeft);
export const IconCaretRight = wrap(Ph.CaretRight);
export const IconCaretDown = wrap(Ph.CaretDown);
export const IconWarningCircle = wrap(Ph.WarningCircle);
export const IconInfo = wrap(Ph.Info);
export const IconGear = wrap(Ph.Gear);
export const IconSun = wrap(Ph.Sun);
export const IconMoon = wrap(Ph.Moon);
// Add more as screen tasks need them; every addition goes HERE, wrapped.
```
(If a screen needs an icon not exported here, add it to this file in that task, wrapped the same way.)

- [ ] **Step 2: `Text.tsx`**, the only place font families are applied.

```tsx
import { Text as RNText, type TextProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

type Variant = "display" | "heading" | "title" | "body" | "label" | "meta";
const map: Record<Variant, { family: string; size: number }> = {
  display: { family: tokens.font.syne[800], size: 28 },
  heading: { family: tokens.font.syne[700], size: 22 },
  title:   { family: tokens.font.syne[600], size: 18 },
  body:    { family: tokens.font.sora[400], size: 15 },
  label:   { family: tokens.font.sora[600], size: 14 },
  meta:    { family: tokens.font.sora[400], size: 13 },
};
export function Text({ variant = "body", muted, color, style, ...rest }:
  TextProps & { variant?: Variant; muted?: boolean; color?: string }) {
  const t = useTokens();
  const m = map[variant];
  return <RNText {...rest} style={[{ fontFamily: m.family, fontSize: m.size,
    color: color ?? (muted ? t.muted : t.text) }, style]} />;
}
```

- [ ] **Step 3: `Button.tsx`**, four variants only (`default`/`secondary`/`destructive`/`ghost`).

```tsx
import { Pressable, type PressableProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

type Variant = "default" | "secondary" | "destructive" | "ghost";
export function Button({ title, variant = "default", disabled, onPress, ...rest }:
  PressableProps & { title: string; variant?: Variant }) {
  const t = useTokens();
  const styles = {
    default:     { bg: t.accent, border: t.accent, fg: t.onAccent, radius: tokens.radius.pill },
    secondary:   { bg: "transparent", border: t.border, fg: t.text, radius: tokens.radius.card },
    destructive: { bg: t.destructive, border: t.destructive, fg: t.onDestructive, radius: tokens.radius.card },
    ghost:       { bg: "transparent", border: "transparent", fg: t.text, radius: tokens.radius.card },
  }[variant];
  return (
    <Pressable {...rest} onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 18, justifyContent: "center",
        alignItems: "center", borderWidth: 1, borderColor: styles.border, backgroundColor: styles.bg,
        borderRadius: styles.radius, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 })}>
      <Text variant="label" color={styles.fg}>{title}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 4: `Card.tsx`** (solid surface + border, flat), `Chip.tsx` (pill; active = ember fill),
`Input.tsx` + `TextArea.tsx` (surface bg, focus border), `Sheet.tsx` (the one shadowed overlay).

```tsx
// Card.tsx
import { View, type ViewProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
export function Card({ style, ...rest }: ViewProps) {
  const t = useTokens();
  return <View {...rest} style={[{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1,
    borderRadius: tokens.radius.card, padding: tokens.space.lg }, style]} />;
}
```
```tsx
// Chip.tsx  (replaces the inline Chip in GigForms/PortfolioForms)
import { Pressable } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";
export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: tokens.radius.pill, borderWidth: 1,
        borderColor: active ? t.accent : t.border, backgroundColor: active ? t.accent : t.surface }}>
      <Text variant="label" color={active ? t.onAccent : t.text}>{label}</Text>
    </Pressable>
  );
}
```
```tsx
// Input.tsx  (TextArea.tsx identical + multiline + minHeight)
import { TextInput, type TextInputProps } from "react-native";
import { useState } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
export function Input({ style, ...rest }: TextInputProps) {
  const t = useTokens();
  const [focused, setFocused] = useState(false);
  return <TextInput {...rest} placeholderTextColor={t.muted}
    onFocus={(e) => { setFocused(true); rest.onFocus?.(e); }}
    onBlur={(e) => { setFocused(false); rest.onBlur?.(e); }}
    style={[{ backgroundColor: t.surface, color: t.text, borderWidth: 1,
      borderColor: focused ? t.focus : t.border, borderRadius: tokens.radius.card,
      paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 }, style]} />;
}
```
```tsx
// Sheet.tsx  (the one shadowed overlay; wraps RN Modal as a bottom sheet)
import { Modal, View, Pressable } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
export function Sheet({ visible, onClose, children }:
  { visible: boolean; onClose: () => void; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: tokens.radius.card,
          borderTopRightRadius: tokens.radius.card, padding: tokens.space.xl, borderColor: t.border, borderWidth: 1,
          shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 12 }}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 5: `Badge.tsx` + `StatusBadge.tsx`**, 6px radius; status pairs the saturated color with
its 14%-opacity background. Move the gig/booking status maps here as token-based.

```tsx
// StatusBadge.tsx
import { View } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";
type Status = "success" | "warning" | "destructive" | "neutral";
// 14% is the ONE soft-tint opacity for the status color family (DESIGN.md).
function tint(hex: string) { return hex + "24"; } // 0x24 ~ 14% alpha on a 6-digit hex
export function StatusBadge({ label, status }: { label: string; status: Status }) {
  const t = useTokens();
  const c = status === "neutral" ? t.muted : t[status];
  return (
    <View style={{ alignSelf: "flex-start", paddingVertical: 3, paddingHorizontal: 8,
      borderRadius: tokens.radius.sm, backgroundColor: status === "neutral" ? t.surface : tint(c), borderWidth: 1, borderColor: c }}>
      <Text variant="meta" color={c}>{label}</Text>
    </View>
  );
}
```
(Map the gig/booking `GigStatus`/`BookingStatus` label+status pairs onto this in the screen tasks;
delete `STATUS_BG`/`STATUS_FG` raw-hex maps from `GigForms.tsx` and re-express via `StatusBadge`'s
`status`. `Badge.tsx` is the same without the status coloring, `t.surface`/`t.border`.)

- [ ] **Step 6: `Skeleton.tsx`**, MOTION 1 shimmer, pauses under reduced motion.

```tsx
import { useEffect, useRef } from "react";
import { Animated, View, useReducedMotion } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
export function Skeleton({ width = "100%", height = 16, radius = tokens.radius.sm }:
  { width?: number | string; height?: number; radius?: number }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
      Animated.timing(a, { toValue: 0.5, duration: 900, useNativeDriver: true }),
    ]));
    loop.start(); return () => loop.stop();
  }, [reduced, a]);
  return <Animated.View style={{ width, height, borderRadius: radius, backgroundColor: t.border,
    opacity: reduced ? 0.6 : a }} />;
}
// A card-shaped skeleton for list screens:
export function SkeletonCard() {
  const t = useTokens();
  return (
    <View style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1,
      borderRadius: tokens.radius.card, padding: tokens.space.lg, gap: 10 }}>
      <Skeleton height={20} width="60%" /><Skeleton height={14} width="90%" /><Skeleton height={14} width="40%" />
    </View>
  );
}
```
(`useReducedMotion` is exported by react-native 0.86; if unavailable, fall back to
`AccessibilityInfo.isReduceMotionEnabled()` in an effect.)

- [ ] **Step 7: `Background.tsx`**, page + scrim gradients via `react-native-svg` (no expo-linear-gradient).

```tsx
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Rect } from "react-native-svg";
import { useThemeChoice } from "../theme/ThemeProvider";
import { PAGE_DARK_STOPS, SCRIM_STOPS, tokens } from "../theme/tokens";
// Full-bleed page background: dark = 165deg night gradient, light = flat paper.
export function PageBackground() {
  const { active } = useThemeChoice();
  if (active === "light") return <View style={{ position: "absolute", inset: 0, backgroundColor: tokens.light.bg0 }} />;
  return (
    <Svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
      <Defs><LinearGradient id="page" x1="0" y1="0" x2="0.42" y2="1">
        {PAGE_DARK_STOPS.map((s) => <Stop key={s.offset} offset={s.offset} stopColor={s.color} />)}
      </LinearGradient></Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#page)" />
    </Svg>
  );
}
// Scrim over a photo (always dark, both themes). Place absolutely over the image.
export function PhotoScrim() {
  return (
    <Svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
      <Defs><LinearGradient id="scrim" x1="0" y1="1" x2="0" y2="0">
        {SCRIM_STOPS.map((s) => <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />)}
      </LinearGradient></Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#scrim)" />
    </Svg>
  );
}
```

- [ ] **Step 8: `ThemeToggle.tsx`**, Light / Dark / System segmented control.

```tsx
import { View } from "react-native";
import { Chip } from "./Chip";
import { useThemeChoice } from "../theme/ThemeProvider";
export function ThemeToggle() {
  const { choice, setChoice } = useThemeChoice();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {(["light", "dark", "system"] as const).map((c) => (
        <Chip key={c} label={c[0].toUpperCase() + c.slice(1)} active={choice === c} onPress={() => setChoice(c)} />
      ))}
    </View>
  );
}
```

- [ ] **Step 9: Gates + commit**

`corepack pnpm typecheck` · mobile lint · `npx expo export --platform ios` (bundles).
```
git add apps/mobile/src/ui
git commit -m "feat(mobile): owned ui primitives, text/button/card/chip/badge/input/sheet/skeleton/icons/background/theme-toggle"
```

---

### Task 3: Shell (tab bars, headers, status bar)

**Files:** Modify `apps/mobile/app/(curator)/_layout.tsx`, `app/(musician)/_layout.tsx`,
`app/(fan)/_layout.tsx`, `app/_layout.tsx` (Stack header styling + status bar).

- [ ] **Step 1**, Read each `_layout.tsx`. Each defines a `Tabs` with per-screen icons/labels. Replace
the tab-bar styling with tokens and Phosphor duotone icons. Pattern for one tab group:

```tsx
import { Tabs } from "expo-router";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";
import { IconHouse, IconCalendarCheck, IconChatCircle, IconUserCircle, IconMusicNotes } from "../../src/ui/icons";

export default function CuratorLayout() {
  const t = useTokens();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, borderTopWidth: 1 },
      tabBarActiveTintColor: t.accent,      // active nav item = ember (DESIGN.md dosage)
      tabBarInactiveTintColor: t.muted,
      tabBarLabelStyle: { fontFamily: tokens.font.sora[500], fontSize: 11 },
    }}>
      <Tabs.Screen name="dashboard" options={{ title: "Home",
        tabBarIcon: ({ color }) => <IconHouse color={color} size={22} /> }} />
      <Tabs.Screen name="events/index" options={{ title: "Events",
        tabBarIcon: ({ color }) => <IconCalendarCheck color={color} size={22} /> }} />
      {/* ...one Tabs.Screen per existing screen, icons chosen per meaning, NO new/removed tabs... */}
    </Tabs>
  );
}
```
Keep the EXACT set of `Tabs.Screen` entries each layout already has (same names, same order, same
hidden screens). Only styling + icons change.

- [ ] **Step 2**, In `app/_layout.tsx`'s `Gate`, theme the two Stack headers (`join`, `artist/[handle]`):

```tsx
<Stack screenOptions={{
  headerShown: false,
  headerStyle: { backgroundColor: t.surface },
  headerTintColor: t.text,
  headerTitleStyle: { fontFamily: tokens.font.syne[700] },
}}>
```
(pull `const t = useTokens()` into `Gate`.) Add `<StatusBar style={active === "light" ? "dark" : "light"} />`
from `expo-status-bar` at the top of the returned tree, reading `active` from `useThemeChoice()`.
`booking/[bookingId]`'s custom back control: retint its colors to tokens, no logic change.

- [ ] **Step 3: AA check note**, on light theme, `tabBarActiveTintColor: t.accent` (ember) on the
`surface` (#FFFFFF) tab bar is an icon+label pairing. If the label alone reads under AA at 11px,
switch the active tint to `t.focus` (#BF5038) in light only (branch on `active`), matching the
web-wordmark rule. Document the choice in a comment; the owner verifies at build.

- [ ] **Step 4: Gates + commit**

`typecheck` · lint · `expo export`.
```
git add apps/mobile/app
git commit -m "feat(mobile): themed tab-bar shell, stack headers, status bar"
```

---
## Screen sweep tasks (4-9): the standard transform

Tasks 4-9 all apply the same mechanical transform to their screen group. **The transform, once, so
each task can just name its files:**

1. Replace raw RN `View`/`Text`/`Pressable`/`TextInput` + inline `style={{ ...hex... }}` with the
   `src/ui` primitives (`Card`, `Text`, `Button`, `Chip`, `Input`, `TextArea`, `StatusBadge`, `Sheet`)
   and `useTokens()` for any remaining direct color. **Zero hardcoded hex** remains in the file.
2. Screen container gets `<PageBackground />` behind content where the screen fills the page.
3. Every `Loading…` text / bare `ActivityIndicator` becomes a `Skeleton`/`SkeletonCard` shaped to the
   content (list: 2-3 `SkeletonCard`; detail: skeleton hero + body lines).
4. Every empty state becomes a branded empty view (`Text variant="title"` + `muted` explainer + an
   optional `Button`). Every caught-error state becomes a branded inline error; add a Retry `Button`
   ONLY where the screen already exposes a refetch function (do not invent one).
5. Icons come from `src/ui/icons` (add any missing glyph to `icons.tsx`, wrapped).
6. **Do not change** any handler body, `useEffect` dependency array, callable invocation, Firestore
   query, `onSnapshot`, navigation call, or `===`-compared string. If a change seems to require it,
   STOP and report, it is out of scope.

Each task's gate: `corepack pnpm typecheck` · mobile lint · `npx expo export --platform ios`, plus a
self-check `grep -nE '#[0-9a-fA-F]{3,8}' <the task's files>` returns nothing (no hex left).

### Task 4: Auth + join
**Files:** `app/(auth)/sign-in.tsx`, `app/(auth)/sign-up.tsx`, `app/join.tsx`.
Apply the standard transform. These are the brand-forward entry: dark-default page background, Syne
wordmark/heading, ember primary CTA (`Button variant="default"`), Sora body. Auth error messages
render via the branded inline-error pattern (the auth calls already surface `e.message`).
- [ ] Transform the three files per the standard transform above.
- [ ] Gates (typecheck, lint, expo export, hex grep clean).
- [ ] Commit: `feat(mobile): restyle auth and join`.

### Task 5: Dashboards + account (+ ThemeToggle)
**Files:** `app/(curator)/dashboard.tsx`, `app/(musician)/dashboard.tsx`, `app/(fan)/dashboard.tsx`
(if present; fan uses `(fan)/index.tsx`), `app/(curator)/account.tsx`, `app/(musician)/account.tsx`,
`app/(fan)/account.tsx`.
Apply the standard transform. **Each account screen mounts `<ThemeToggle />`** in a settings row
(`Text variant="label">Appearance</Text>` + the toggle). Dashboard cards use `Card` + `StatusBadge`.
- [ ] Transform the files; mount `ThemeToggle` in each account screen.
- [ ] Gates + hex grep.
- [ ] Commit: `feat(mobile): restyle dashboards and account, add theme toggle`.

### Task 6: Profile editors
**Files:** `src/curator/CuratorForms.tsx`, `src/portfolio/PortfolioForms.tsx`,
`src/portfolio/TrackManager.tsx`, `src/portfolio/TrimUploader.tsx`, `src/gigs/GigForms.tsx`.
Apply the standard transform. The existing inline `Chip` in `GigForms`/`PortfolioForms` is deleted and
replaced by `src/ui/Chip`. `GigForms`'s `STATUS_BG`/`STATUS_FG` raw-hex maps are removed; status
renders via `StatusBadge` (map each `GigStatus`/`SeriesStatus` to a `status` prop: `open`→success,
`filled`→neutral/success, `cancelled`/`taken_down`→destructive/warning, `draft`/`closed`→neutral;
keep the existing labels). `TrimUploader`'s audio behavior is untouched.
- [ ] Transform the files; migrate Chip + status maps.
- [ ] Gates + hex grep.
- [ ] Commit: `feat(mobile): restyle profile and gig editors`.

### Task 7: Browse + gigs/events
**Files:** `src/bookings/GigBrowse.tsx`, `src/bookings/MusicianBrowse.tsx`,
`app/(curator)/events/index.tsx`, `app/(curator)/events/[gigId].tsx`, `app/(curator)/events/new.tsx`,
`app/(curator)/events/series/[seriesId].tsx`, `app/(musician)/gigs.tsx`.
Apply the standard transform. The GigCard/MusicianCard within `GigBrowse`/`MusicianBrowse` become
photo-forward: cover photo with `<PhotoScrim />` over the bottom and the title/price on the scrim (the
scrim is always dark, so ember/white text on it is legible in both themes). Price gets the ember
treatment (filled `Chip` or ember `Text` on the dark scrim). List loading = `SkeletonCard` rows.
- [ ] Transform the files; build the photo-forward cards with `PhotoScrim`.
- [ ] Gates + hex grep.
- [ ] Commit: `feat(mobile): restyle browse and events with photo-forward cards`.

### Task 8: Artist page
**Files:** `app/artist/[handle].tsx`, and the MiniPlayer if it is a separate component (search
`apps/mobile/src` for the player; restyle in place).
Apply the standard transform. The hero follows DESIGN.md's locked anatomy: cover photo,
`<PhotoScrim />`, name in Syne on the scrim, ember only on the one key action. Shows section uses
`Card`. The MiniPlayer is the ONE candidate for mobile's single glass use: implement it solid
(`surface` + top `border` + the overlay shadow) by default; a blur (`expo-blur`) is optional and only
if the owner later wants it (do NOT add `expo-blur` now, it is a native module needing a rebuild and
the spec caps mobile glass at "at most one", defaulting to solid). Transport icons from `src/ui/icons`
(`IconPlay`/`IconPause`). Track playback behavior untouched.
- [ ] Transform the artist page + MiniPlayer (solid).
- [ ] Gates + hex grep.
- [ ] Commit: `feat(mobile): restyle artist page, hero anatomy, solid mini-player`.

### Task 9: Booking + money surfaces (markup-only, STRONGER MODEL)
**Files:** `src/bookings/BookingThread.tsx`, `src/bookings/BookingInbox.tsx`,
`src/bookings/BookingForms.tsx`, `src/bookings/OfferForm.tsx`, `src/bookings/CancelDialog.tsx`,
`src/bookings/PaymentStatus.tsx`, and all of `src/payments/*`
(`DelinquencyBanner`, `EarningsPanel`, `GatePrompt`, `PayPastDueButton`, `SaveCardSheet`, `TrueUpForm`).
Apply the standard transform, PLUS the money-surface discipline:
- `CancelDialog` uses `src/ui/Sheet` for its modal.
- The Stripe **PaymentSheet appearance** (in `SaveCardSheet`/`PayPastDueButton`) gets a token-based
  appearance config: `appearance: { colors: { primary: t.accent, background: t.surface, componentBackground: t.surface, primaryText: t.text, secondaryText: t.muted } }` passed to `initPaymentSheet`.
  The native sheet's font support is limited (no custom family guaranteed), document, do not hack.
- **Mechanical no-drift proof** (this is the task's real gate). After the transform, run:
  `git diff <base>..HEAD -- <each money file>` and confirm every changed line is presentation
  (JSX/style/import), and produce a short table asserting: handlers unchanged, callable names
  unchanged, `httpsCallable(...)` arguments unchanged, `onSnapshot`/query shapes unchanged, `useEffect`
  dep arrays unchanged, and every `=== SOME_MESSAGE` comparison against a `@gatekeep/shared` constant
  unchanged. Any behavioral line = STOP and revert that line.
- [ ] Transform + appearance config + the mechanical-diff table.
- [ ] Gates + hex grep + the no-drift table.
- [ ] Commit: `feat(mobile): restyle booking and money surfaces (markup-only)`.

### Task 10: Carry-forwards (money-sentence parity + fan coming-soon)
**Files:** the money files from task 9 (copy audit) + `app/(fan)/index.tsx`, `app/(fan)/search.tsx`,
`app/(fan)/tickets.tsx`.
- [ ] **Money-sentence colon parity (9A ruling 8).** Find mobile-local money sentences that still use
  an em dash (`grep -n $'\xe2\x80\x94' apps/mobile/src apps/mobile/app`). For each, apply web's exact colon
  treatment, open `apps/web`'s twin surface, copy the wording verbatim so the two read byte-identical.
  Strings imported from `@gatekeep/shared/messages.ts` are already colonized; leave them. Do NOT change
  any `===`-compared string (those are shared constants, already correct).
- [ ] **Styled fan coming-soon states (9A ruling 9).** `(fan)/index`, `search`, `tickets` are
  placeholders. Give each a branded coming-soon empty state: `PageBackground`, a Syne `Text
  variant="heading"` title, a `muted` one-line explainer, a relevant `src/ui/icons` glyph
  (`IconTicket`/`IconMusicNotes`/`IconMagnifyingGlass`). No new behavior, no fetch.
- [ ] Gates + a final `grep -n $'\xe2\x80\x94' apps/mobile` returning nothing.
- [ ] Commit: `feat(mobile): money-sentence colon parity and styled fan coming-soon states`.

### Task 11: Voice pass + final gates + smoke checklist
**Files:** any 9B-touched file needing a copy tightening; `README.md` (smoke checklist);
`docs/superpowers/sp9b-rulings.md` is the controller's post-merge job, do NOT create it here.
- [ ] **Voice/copy pass**: read every screen's copy with the antislop-copywriting lens
  (`~/.claude/skills/antislop-copywriting/SKILL.md`); tighten obviously-AI phrasing; enforce the
  no-em-dash rule one final time across all touched files (`grep -n $'\xe2\x80\x94'` clean, including code
  comments and strings).
- [ ] **README**: add a short "Sub-project 9B (mobile UI/UX)" note + the owner smoke checklist from
  the spec §7 (shell + toggle both themes at phone width; auth/join; dashboards; editors incl. photo
  upload; browse cards; artist hero + Shows + MiniPlayer; booking thread offer/counter/accept/cancel;
  PaymentSheet + SaveCard + earnings/payout/delinquency/gate-prompts both themes; skeleton/empty/error;
  fan coming-soon; all dark + light). Byte-safe edits.
- [ ] **Final gates (each ONE blocking foreground call, exact numbers)**: `corepack pnpm typecheck`
  (5/5) · `corepack pnpm --filter @gatekeep/shared test` (153, unchanged, proves shared untouched) ·
  `corepack pnpm emu:test` (578, unchanged) · `corepack pnpm emu:rules` (77, unchanged) ·
  `corepack pnpm --filter @gatekeep/mobile lint` (0) · `corepack pnpm --filter web lint` + web build
  (unchanged, proves web untouched) · `npx expo export --platform ios` (bundles).
- [ ] Commit: `feat(mobile): voice pass, README smoke checklist, final gates`.

---

## Execution notes for the controller

- Sequential tasks, subagent-driven, two-stage review (spec-compliance then code-quality) per task,
  whole-branch final review before merge, the SP5/9A cadence.
- Task 9 (money surfaces) runs on a stronger model with the mechanical no-drift proof as its gate.
- The parity gates (`emu:test 578`, `emu:rules 77`, `shared 153`, web lint+build) are the proof that
  9B is pure presentation; any drift in those counts is a blocking finding to justify or revert.
- This machine cannot verify styling live; every task's positive claim is "bundles + lints + typechecks
  + no hex left", never "looks right". The owner's next EAS build is the visual gate.
- Font TTFs (task 1) are the one asset dependency; if they cannot be fetched offline, the task reports
  BLOCKED for the owner to drop the files in, rather than substituting a different typeface (DESIGN.md
  bans substitutes).



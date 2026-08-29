// Page + scrim gradients via react-native-svg (no expo-linear-gradient, per
// the plan: this and icons.tsx are the two native-svg/phosphor consumers).
//
// pointerEvents on the two <Svg> fills below MUST be the discrete top-level
// prop, not `style.pointerEvents`: react-native-svg's own extractResponder()
// reads `props.pointerEvents` to decide native touch handling; it never
// looks at `style.pointerEvents`, so a style-only value is silently
// ignored and the fill still eats touches (the exact hazard this prop is
// meant to prevent for PhotoScrim over a tappable card). SvgProps'
// TS type Omit<..., 'pointerEvents'>s the field from its declared props
// (it forwards it fine at runtime), so the discrete prop is passed via a
// small cast past that Omit. The `style` key is also set, belt-and-
// suspenders, in case a future react-native-svg version reverses course.
// The plain <View> (light branch) has no such split: RN's own View honors
// both forms, so the top-level prop there needs no cast.
import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Rect, type SvgProps } from "react-native-svg";
import { useThemeChoice, useTokens } from "../theme/ThemeProvider";
import { PAGE_DARK_STOPS, SCRIM_STOPS, tokens } from "../theme/tokens";

// Cast-past-the-Omit helper: SvgProps strips `pointerEvents` from its type
// even though the runtime still reads it (see comment above).
const svgNoTouch = { pointerEvents: "none" } as Partial<SvgProps>;

// Full-bleed page background: dark = 165deg night gradient, light = flat paper.
export function PageBackground() {
  const { active } = useThemeChoice();
  if (active === "light") {
    return (
      <View
        pointerEvents="none"
        style={{ position: "absolute", inset: 0, backgroundColor: tokens.light.bg0 }}
      />
    );
  }
  return (
    <Svg
      {...svgNoTouch}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      width="100%"
      height="100%"
    >
      <Defs>
        <LinearGradient id="page" x1="0" y1="0" x2="0.42" y2="1">
          {PAGE_DARK_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#page)" />
    </Svg>
  );
}

// Scrim over a photo (always the dark night gradient, both themes). Place
// absolutely over the image; text/CTAs on top of it stay legible.
export function PhotoScrim() {
  return (
    <Svg
      {...svgNoTouch}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      width="100%"
      height="100%"
    >
      <Defs>
        <LinearGradient id="scrim" x1="0" y1="1" x2="0" y2="0">
          {SCRIM_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#scrim)" />
    </Svg>
  );
}

// Branded stand-in for a card's cover photo when no real image is wired
// through (both browse grids render this, never a Storage image: see the
// task's Part A note). A 155deg surface -> border gradient built from theme
// tokens (never the page-level bg gradient), with a centered muted context
// icon naming what the slot is for (a gig vs. an artist). Fills its parent
// absolutely and never eats touches, so the card's own Pressable stays
// tappable through it. `pointerEvents` is the discrete top-level prop on both
// the wrapper View and the <Svg> fill for the same reason PhotoScrim/
// PageBackground set it that way (see the file header note).
export function PhotoPlaceholder({ icon }: { icon: ReactNode }) {
  const t = useTokens();
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}
    >
      <Svg
        {...svgNoTouch}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        width="100%"
        height="100%"
      >
        <Defs>
          {/* objectBoundingBox coords approximating CSS linear-gradient(155deg):
              start (surface) top-left-ish, end (border) bottom-right-ish. */}
          <LinearGradient id="photoPlaceholder" x1="0.29" y1="0.05" x2="0.71" y2="0.95">
            <Stop offset="0%" stopColor={t.surface} stopOpacity={1} />
            <Stop offset="100%" stopColor={t.border} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#photoPlaceholder)" />
      </Svg>
      {icon}
    </View>
  );
}

// Page + scrim gradients via react-native-svg (no expo-linear-gradient, per
// the plan: this and icons.tsx are the two native-svg/phosphor consumers).
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Rect } from "react-native-svg";
import { useThemeChoice } from "../theme/ThemeProvider";
import { PAGE_DARK_STOPS, SCRIM_STOPS, tokens } from "../theme/tokens";

// Full-bleed page background: dark = 165deg night gradient, light = flat paper.
export function PageBackground() {
  const { active } = useThemeChoice();
  if (active === "light") {
    return <View style={{ position: "absolute", inset: 0, backgroundColor: tokens.light.bg0 }} />;
  }
  return (
    <Svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
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
    <Svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
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

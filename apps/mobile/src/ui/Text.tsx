// The only place font families are applied (binding rule 4: no font family
// named outside Text.tsx/tokens.ts). Never pair `fontFamily` with
// `fontWeight`: the named Syne/Sora faces already carry their own weight, and
// setting `fontWeight` alongside a named face risks iOS synthesizing a bold
// variant of a face that does not match, distorting the glyphs.
import { Text as RNText, type TextProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

type Variant = "display" | "heading" | "title" | "body" | "label" | "meta";

const map: Record<Variant, { family: string; size: number }> = {
  display: { family: tokens.font.syne[800], size: 28 },
  heading: { family: tokens.font.syne[700], size: 22 },
  title: { family: tokens.font.syne[600], size: 18 },
  body: { family: tokens.font.sora[400], size: 15 },
  label: { family: tokens.font.sora[600], size: 14 },
  meta: { family: tokens.font.sora[400], size: 13 },
};

export function Text({
  variant = "body",
  muted,
  color,
  style,
  ...rest
}: TextProps & { variant?: Variant; muted?: boolean; color?: string }) {
  const t = useTokens();
  const m = map[variant];
  return (
    <RNText
      {...rest}
      style={[
        { fontFamily: m.family, fontSize: m.size, color: color ?? (muted ? t.muted : t.text) },
        style,
      ]}
    />
  );
}

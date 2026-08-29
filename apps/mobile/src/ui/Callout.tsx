// Shared callout box: a tone-tinted panel for the inline error/success/info
// surfaces across the money and booking screens. The non-neutral tones use a
// 14% ("24") soft tint of the status color over its own solid border, the
// same technique StatusBadge uses (DESIGN.md's one soft-tint figure for the
// status color family). neutral uses the surface/border pairing (no status
// color) for informational notices, since DESIGN.md names no fourth status.
import { View, type ViewProps } from "react-native";
import type { ReactNode } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

export type CalloutTone = "warning" | "success" | "destructive" | "neutral";

// `hex + "24"` appends the 0x24 alpha byte (36/255 ~= 14%) to a 6-digit hex
// token; every status token is 6-digit, so this always produces a valid
// 8-digit hex. Same dev guard as StatusBadge.tint: only a 6-digit hex is a
// safe base for the appended alpha byte.
function tint(hex: string) {
  if (__DEV__ && !/^#[0-9a-f]{6}$/i.test(hex)) {
    console.warn(`Callout.tint: expected a 6-digit hex color, got "${hex}"`);
  }
  return hex + "24";
}

export function Callout({ tone, children, style, ...rest }: { tone: CalloutTone; children: ReactNode } & ViewProps) {
  const t = useTokens();
  const neutral = tone === "neutral";
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: neutral ? t.surface : tint(t[tone]),
          borderWidth: 1,
          borderColor: neutral ? t.border : t[tone],
          borderRadius: tokens.radius.card,
          padding: tokens.space.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

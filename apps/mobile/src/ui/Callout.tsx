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

export function Callout({ tone, children, style, ...rest }: { tone: CalloutTone; children: ReactNode } & ViewProps) {
  const t = useTokens();
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: tone === "neutral" ? t.surface : t[tone] + "24",
          borderWidth: 1,
          borderColor: tone === "neutral" ? t.border : t[tone],
          borderRadius: tokens.radius.card,
          padding: tokens.space.md,
        },
        style,
      ]}
    />
  );
}

import { ActivityIndicator, Pressable, type PressableProps } from "react-native";
import type { ReactNode } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

type Variant = "default" | "secondary" | "destructive" | "ghost";

export function Button({
  title,
  children,
  variant = "default",
  loading,
  disabled,
  style,
  ...rest
}: PressableProps & {
  title?: string;
  // A caller can pass an icon+text row (or any custom content) via
  // `children`; when omitted, the plain `title` Text below covers the
  // common case.
  children?: ReactNode;
  variant?: Variant;
  // Disables the button and swaps its content for a spinner in the
  // variant's foreground color.
  loading?: boolean;
}) {
  const t = useTokens();
  const styles = {
    default: { bg: t.accent, border: t.accent, fg: t.onAccent, radius: tokens.radius.pill },
    secondary: { bg: "transparent", border: t.border, fg: t.text, radius: tokens.radius.card },
    destructive: { bg: t.destructive, border: t.destructive, fg: t.onDestructive, radius: tokens.radius.card },
    ghost: { bg: "transparent", border: "transparent", fg: t.text, radius: tokens.radius.card },
  }[variant];
  const isDisabled = Boolean(disabled) || Boolean(loading);
  // accessibilityState is MERGED, not replaced (Task 26 review): TogglePill
  // renders through this component and passes { selected }, which the plain
  // object literal below used to drop, so no toggle in the app announced its
  // on/off state. This component's own two flags still win, they are derived
  // from props it alone owns.
  return (
    <Pressable
      {...rest}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ ...rest.accessibilityState, disabled: isDisabled, busy: loading }}
      style={(state) => [
        {
          minHeight: 44,
          paddingHorizontal: 18,
          justifyContent: "center",
          alignItems: "center",
          borderWidth: 1,
          borderColor: styles.border,
          backgroundColor: styles.bg,
          borderRadius: styles.radius,
          opacity: isDisabled ? 0.5 : state.pressed ? 0.85 : 1,
        },
        // Merge, don't replace: a caller's `style` (object or the
        // Pressable function form) still applies on top, matching the
        // Card/Text/Input merge pattern so callers can add margin etc.
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={styles.fg} />
      ) : (
        (children ?? (
          <Text variant="label" color={styles.fg}>
            {title}
          </Text>
        ))
      )}
    </Pressable>
  );
}

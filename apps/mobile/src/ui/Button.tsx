import { Pressable, type PressableProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

type Variant = "default" | "secondary" | "destructive" | "ghost";

export function Button({
  title,
  variant = "default",
  disabled,
  onPress,
  ...rest
}: PressableProps & { title: string; variant?: Variant }) {
  const t = useTokens();
  const styles = {
    default: { bg: t.accent, border: t.accent, fg: t.onAccent, radius: tokens.radius.pill },
    secondary: { bg: "transparent", border: t.border, fg: t.text, radius: tokens.radius.card },
    destructive: { bg: t.destructive, border: t.destructive, fg: t.onDestructive, radius: tokens.radius.card },
    ghost: { bg: "transparent", border: "transparent", fg: t.text, radius: tokens.radius.card },
  }[variant];
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 18,
        justifyContent: "center",
        alignItems: "center",
        borderWidth: 1,
        borderColor: styles.border,
        backgroundColor: styles.bg,
        borderRadius: styles.radius,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text variant="label" color={styles.fg}>
        {title}
      </Text>
    </Pressable>
  );
}

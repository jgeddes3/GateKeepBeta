// Replaces the inline Chip components in GigForms/PortfolioForms (task 6).
import { Pressable, type PressableProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

export function Chip({
  label,
  active,
  onPress,
  disabled,
  ...rest
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
} & Pick<PressableProps, "testID" | "accessibilityLabel">) {
  const t = useTokens();
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: tokens.radius.pill,
        borderWidth: 1,
        borderColor: active ? t.accent : t.border,
        backgroundColor: active ? t.accent : t.surface,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text variant="label" color={active ? t.onAccent : t.text}>
        {label}
      </Text>
    </Pressable>
  );
}

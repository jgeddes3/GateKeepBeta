// Replaces the inline Chip components in GigForms/PortfolioForms (task 6).
import { Pressable } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: tokens.radius.pill,
        borderWidth: 1,
        borderColor: active ? t.accent : t.border,
        backgroundColor: active ? t.accent : t.surface,
      }}
    >
      <Text variant="label" color={active ? t.onAccent : t.text}>
        {label}
      </Text>
    </Pressable>
  );
}

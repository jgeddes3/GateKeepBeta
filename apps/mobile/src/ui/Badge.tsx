// Neutral badge: same shape as StatusBadge minus the status coloring, always
// t.surface/t.border. Use StatusBadge for anything that carries a
// success/warning/destructive/neutral meaning.
import { View } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

export function Badge({ label }: { label: string }) {
  const t = useTokens();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: tokens.radius.sm,
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <Text variant="meta">{label}</Text>
    </View>
  );
}

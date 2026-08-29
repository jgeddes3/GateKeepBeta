import { View } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

type Status = "success" | "warning" | "destructive" | "neutral";

// 14% is the ONE soft-tint opacity figure for the status color family
// (DESIGN.md). `hex + "24"` appends the 0x24 alpha byte (36/255 ~= 14%) to a
// 6-digit hex token; every status token (success/warning/destructive) is
// 6-digit, so this always produces a valid 8-digit hex.
function tint(hex: string) {
  return hex + "24";
}

export function StatusBadge({ label, status }: { label: string; status: Status }) {
  const t = useTokens();
  const c = status === "neutral" ? t.muted : t[status];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: tokens.radius.sm,
        backgroundColor: status === "neutral" ? t.surface : tint(c),
        borderWidth: 1,
        borderColor: c,
      }}
    >
      <Text variant="meta" color={c}>
        {label}
      </Text>
    </View>
  );
}

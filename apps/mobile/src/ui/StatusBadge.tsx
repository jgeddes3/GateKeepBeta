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
  if (__DEV__ && !/^#[0-9a-f]{6}$/i.test(hex)) {
    // Pins the invariant this function relies on: appending a 2-digit alpha
    // byte only produces a valid color on a 6-digit hex. A caller passing a
    // 3-digit hex, an rgba() string, or a named color would silently render
    // a broken background in production; catch it in dev instead.
    console.warn(`StatusBadge.tint: expected a 6-digit hex color, got "${hex}"`);
  }
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

import { View } from "react-native";
import { PageBackground, Text, IconMagnifyingGlass } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

export default function Screen() {
  const t = useTokens();
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.lg }}>
        <IconMagnifyingGlass size={48} color={t.muted} />
        <View style={{ alignItems: "center", gap: tokens.space.sm }}>
          <Text variant="heading">Search</Text>
          <Text muted style={{ textAlign: "center" }}>Find artists and venues, coming soon.</Text>
        </View>
      </View>
    </View>
  );
}

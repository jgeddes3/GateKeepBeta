import { View } from "react-native";
import { PageBackground, Text, IconTicket } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

export default function Screen() {
  const t = useTokens();
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.lg }}>
        <IconTicket size={48} color={t.muted} />
        <View style={{ alignItems: "center", gap: tokens.space.sm }}>
          <Text variant="heading">Tickets</Text>
          <Text muted style={{ textAlign: "center" }}>Your tickets and RSVPs, coming soon.</Text>
        </View>
      </View>
    </View>
  );
}

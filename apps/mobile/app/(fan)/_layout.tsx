import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";
import { useTokens, useThemeChoice } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";
import { IconHouse, IconTicket, IconMagnifyingGlass, IconUserCircle } from "../../src/ui/icons";

export default function FanTabs() {
  const t = useTokens();
  const { active } = useThemeChoice();
  // AA: ember (t.accent) on the white light-theme surface tab bar risks
  // failing AA contrast at the 11px label size. Light theme branches to
  // t.focus (#BF5038, an AA-safe rust), the same rule the web wordmark
  // uses in light mode. Dark theme keeps the brand ember. Owner verifies
  // contrast at the next build.
  const activeTint = active === "light" ? t.focus : t.accent;
  return (
    <Tabs screenOptions={{
      headerRight: () => <ContextSwitcher />,
      tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, borderTopWidth: 1,
        elevation: 0, shadowOpacity: 0 },
      tabBarActiveTintColor: activeTint,
      tabBarInactiveTintColor: t.muted,
      tabBarLabelStyle: { fontFamily: tokens.font.sora[500], fontSize: 11 },
    }}>
      <Tabs.Screen name="index" options={{ title: "Discover",
        tabBarIcon: ({ color }) => <IconHouse color={color as string} size={22} /> }} />
      <Tabs.Screen name="tickets" options={{ title: "Tickets",
        tabBarIcon: ({ color }) => <IconTicket color={color as string} size={22} /> }} />
      <Tabs.Screen name="search" options={{ title: "Search",
        tabBarIcon: ({ color }) => <IconMagnifyingGlass color={color as string} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color as string} size={22} /> }} />
    </Tabs>
  );
}

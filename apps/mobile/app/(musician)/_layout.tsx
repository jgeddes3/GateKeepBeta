import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";
import { useTokens, useThemeChoice } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";
import {
  IconHouse, IconCalendarCheck, IconMusicNotes, IconTicket, IconChatCircle, IconUserCircle,
} from "../../src/ui/icons";

export default function MusicianTabs() {
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
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard",
        tabBarIcon: ({ color }) => <IconHouse color={color as string} size={22} /> }} />
      {/* SP4 Task 12: was a "Coming in a later phase" placeholder — now the
          GigBrowse "Find gigs" screen (public open-gigs browse + Apply). */}
      <Tabs.Screen name="gigs" options={{ title: "Find Gigs",
        tabBarIcon: ({ color }) => <IconCalendarCheck color={color as string} size={22} /> }} />
      <Tabs.Screen name="portfolio" options={{ title: "Portfolio",
        tabBarIcon: ({ color }) => <IconMusicNotes color={color as string} size={22} /> }} />
      {/* SP4 Task 12: BookingInbox for this musician profile's own threads —
          mirrors web's inbox section on the portfolio editor page, split
          into its own tab per this app's mobile-idiom convention. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings",
        tabBarIcon: ({ color }) => <IconTicket color={color as string} size={22} /> }} />
      <Tabs.Screen name="messages" options={{ title: "Messages",
        tabBarIcon: ({ color }) => <IconChatCircle color={color as string} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color as string} size={22} /> }} />
    </Tabs>
  );
}

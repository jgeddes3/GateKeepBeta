import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";
import { useTokens, useThemeChoice } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";
import {
  IconHouse, IconCalendarCheck, IconMusicNotes, IconTicket, IconChatCircle, IconUserCircle,
} from "../../src/ui/icons";

export default function CuratorTabs() {
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
      {/* "events" is now a folder (gigs & series list, composer, gig editor,
          series detail) with its own Stack navigator (see
          app/(curator)/events/_layout.tsx) — headerShown:false here so the
          Tabs navigator's header doesn't double up with the inner Stack's
          own per-screen headers/back buttons/titles, which own that
          responsibility for every screen under this tab. */}
      <Tabs.Screen name="events" options={{ title: "My Events", headerShown: false,
        tabBarIcon: ({ color }) => <IconCalendarCheck color={color as string} size={22} /> }} />
      {/* SP4 Task 12: was the "Find Talent" placeholder (talent.tsx, now
          deleted) — replaced by musicians.tsx, the MusicianBrowse "Find
          musicians" screen, per the plan's explicit file naming. */}
      <Tabs.Screen name="musicians" options={{ title: "Find Musicians",
        tabBarIcon: ({ color }) => <IconMusicNotes color={color as string} size={22} /> }} />
      {/* SP4 Task 12: BookingInbox for this curator profile's own threads. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings",
        tabBarIcon: ({ color }) => <IconTicket color={color as string} size={22} /> }} />
      <Tabs.Screen name="messages" options={{ title: "Messages",
        tabBarIcon: ({ color }) => <IconChatCircle color={color as string} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color as string} size={22} /> }} />
    </Tabs>
  );
}

import { Tabs } from "expo-router";
import { useShellScreenOptions } from "../../src/shell/useShellScreenOptions";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { useUnreadTotal } from "../../src/messaging/useConversations";
import { useTokens } from "../../src/theme/ThemeProvider";
import {
  IconHouse, IconCalendarCheck, IconMusicNotes, IconHandshake, IconChatCircle, IconUserCircle,
} from "../../src/ui/icons";

export default function CuratorTabs() {
  const { myProfiles } = useProfileContext();
  const t = useTokens();
  // SP12 (spec 3.1): the badge sums unread across every profile of THIS tab
  // group's type, because the group's own screens can switch between them.
  const unread = useUnreadTotal(
    myProfiles.filter((p) => p.type === "curator" && p.status === "approved").map((p) => p.profileId));
  return (
    <Tabs screenOptions={useShellScreenOptions()}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard",
        tabBarIcon: ({ color }) => <IconHouse color={color} size={22} /> }} />
      {/* "events" is now a folder (gigs & series list, composer, gig editor,
          series detail) with its own Stack navigator (see
          app/(curator)/events/_layout.tsx): headerShown:false here so the
          Tabs navigator's header doesn't double up with the inner Stack's
          own per-screen headers/back buttons/titles, which own that
          responsibility for every screen under this tab. */}
      <Tabs.Screen name="events" options={{ title: "My Events", headerShown: false,
        tabBarIcon: ({ color }) => <IconCalendarCheck color={color} size={22} /> }} />
      {/* SP4 Task 12: was the "Find Talent" placeholder (talent.tsx, now
          deleted), replaced by musicians.tsx, the "Find musicians" screen
          (SP8 Task 15: now the curator search face), per the plan's
          explicit file naming. */}
      <Tabs.Screen name="musicians" options={{ title: "Find Musicians",
        tabBarIcon: ({ color }) => <IconMusicNotes color={color} size={22} /> }} />
      {/* SP4 Task 12: BookingInbox for this curator profile's own threads. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings",
        tabBarIcon: ({ color }) => <IconHandshake color={color} size={22} /> }} />
      {/* SP12 Task 10: "messages" is now a folder (list -> thread) with its
          own Stack navigator (see app/(curator)/messages/_layout.tsx):
          headerShown:false here so the Tabs navigator's header doesn't
          double up with the inner Stack's own per-screen headers, same
          reasoning as the "events" folder above. */}
      <Tabs.Screen name="messages" options={{ title: "Messages", headerShown: false,
        tabBarBadge: unread > 0 ? unread : undefined,
        tabBarBadgeStyle: { backgroundColor: t.accent, color: t.onAccent },
        tabBarAccessibilityLabel: unread > 0 ? `Messages, ${unread} unread` : "Messages",
        tabBarIcon: ({ color }) => <IconChatCircle color={color} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color} size={22} /> }} />
    </Tabs>
  );
}

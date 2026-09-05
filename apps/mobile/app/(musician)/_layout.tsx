import { Tabs } from "expo-router";
import { useShellScreenOptions } from "../../src/shell/useShellScreenOptions";
import {
  IconHouse, IconCalendarCheck, IconMusicNotes, IconHandshake, IconChatCircle, IconUserCircle,
} from "../../src/ui/icons";

export default function MusicianTabs() {
  return (
    <Tabs screenOptions={useShellScreenOptions()}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard",
        tabBarIcon: ({ color }) => <IconHouse color={color} size={22} /> }} />
      {/* SP4 Task 12: was a "Coming in a later phase" placeholder, now the
          "Find gigs" screen (public open-gigs browse + Apply; SP8 Task 15:
          now the musician search face). */}
      <Tabs.Screen name="gigs" options={{ title: "Find Gigs",
        tabBarIcon: ({ color }) => <IconCalendarCheck color={color} size={22} /> }} />
      <Tabs.Screen name="portfolio" options={{ title: "Portfolio",
        tabBarIcon: ({ color }) => <IconMusicNotes color={color} size={22} /> }} />
      {/* SP4 Task 12: BookingInbox for this musician profile's own threads,
          mirrors web's inbox section on the portfolio editor page, split
          into its own tab per this app's mobile-idiom convention. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings",
        tabBarIcon: ({ color }) => <IconHandshake color={color} size={22} /> }} />
      {/* SP12 Task 10: "messages" is now a folder (list -> thread) with its
          own Stack navigator (see app/(musician)/messages/_layout.tsx):
          headerShown:false here so the Tabs navigator's header doesn't
          double up with the inner Stack's own per-screen headers, same
          reasoning (curator)/_layout.tsx already records for the "events"
          folder. */}
      <Tabs.Screen name="messages" options={{ title: "Messages", headerShown: false,
        tabBarIcon: ({ color }) => <IconChatCircle color={color} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color} size={22} /> }} />
    </Tabs>
  );
}

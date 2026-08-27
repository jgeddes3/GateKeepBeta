import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function CuratorTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard" }} />
      {/* "events" is now a folder (gigs & series list, composer, gig editor,
          series detail) with its own Stack navigator (see
          app/(curator)/events/_layout.tsx) — headerShown:false here so the
          Tabs navigator's header doesn't double up with the inner Stack's
          own per-screen headers/back buttons/titles, which own that
          responsibility for every screen under this tab. */}
      <Tabs.Screen name="events" options={{ title: "My Events", headerShown: false }} />
      {/* SP4 Task 12: was the "Find Talent" placeholder (talent.tsx, now
          deleted) — replaced by musicians.tsx, the MusicianBrowse "Find
          musicians" screen, per the plan's explicit file naming. */}
      <Tabs.Screen name="musicians" options={{ title: "Find Musicians" }} />
      {/* SP4 Task 12: BookingInbox for this curator profile's own threads. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings" }} />
      <Tabs.Screen name="messages" options={{ title: "Messages" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}

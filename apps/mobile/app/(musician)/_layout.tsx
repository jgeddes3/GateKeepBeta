import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function MusicianTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard" }} />
      {/* SP4 Task 12: was a "Coming in a later phase" placeholder — now the
          GigBrowse "Find gigs" screen (public open-gigs browse + Apply). */}
      <Tabs.Screen name="gigs" options={{ title: "Find Gigs" }} />
      <Tabs.Screen name="portfolio" options={{ title: "Portfolio" }} />
      {/* SP4 Task 12: BookingInbox for this musician profile's own threads —
          mirrors web's inbox section on the portfolio editor page, split
          into its own tab per this app's mobile-idiom convention. */}
      <Tabs.Screen name="bookings" options={{ title: "Bookings" }} />
      <Tabs.Screen name="messages" options={{ title: "Messages" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}

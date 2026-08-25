import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function MusicianTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard" }} />
      <Tabs.Screen name="gigs" options={{ title: "Gigs" }} />
      <Tabs.Screen name="portfolio" options={{ title: "Portfolio" }} />
      <Tabs.Screen name="messages" options={{ title: "Messages" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}

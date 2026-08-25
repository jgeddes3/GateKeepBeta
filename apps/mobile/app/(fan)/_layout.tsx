import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function FanTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="index" options={{ title: "Discover" }} />
      <Tabs.Screen name="tickets" options={{ title: "Tickets" }} />
      <Tabs.Screen name="search" options={{ title: "Search" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}

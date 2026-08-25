import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function CuratorTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard" }} />
      <Tabs.Screen name="events" options={{ title: "My Events" }} />
      <Tabs.Screen name="talent" options={{ title: "Find Talent" }} />
      <Tabs.Screen name="messages" options={{ title: "Messages" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}

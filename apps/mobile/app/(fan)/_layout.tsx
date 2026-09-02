import { Tabs } from "expo-router";
import { useShellScreenOptions } from "../../src/shell/useShellScreenOptions";
import { IconHouse, IconTicket, IconMagnifyingGlass, IconUserCircle } from "../../src/ui/icons";

export default function FanTabs() {
  return (
    <Tabs screenOptions={useShellScreenOptions()}>
      <Tabs.Screen name="index" options={{ title: "Discover",
        tabBarIcon: ({ color }) => <IconHouse color={color} size={22} /> }} />
      <Tabs.Screen name="tickets" options={{ title: "Tickets",
        tabBarIcon: ({ color }) => <IconTicket color={color} size={22} /> }} />
      <Tabs.Screen name="search" options={{ title: "Search",
        tabBarIcon: ({ color }) => <IconMagnifyingGlass color={color} size={22} /> }} />
      <Tabs.Screen name="account" options={{ title: "Account",
        tabBarIcon: ({ color }) => <IconUserCircle color={color} size={22} /> }} />
      {/* SP7 Task 11: reachable via router.push("/(fan)/following") from
          AccountScreen's own "Following" row; href:null keeps it out of the
          tab bar itself. */}
      <Tabs.Screen name="following" options={{ title: "Following", href: null }} />
    </Tabs>
  );
}

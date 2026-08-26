import { Stack } from "expo-router";
import { ContextSwitcher } from "../../../src/shell/ContextSwitcher";

// Nested Stack for the "events" tab (gigs & series list -> composer -> gig
// editor -> series detail). The outer Tabs navigator hides its own header
// for this tab (see ../_layout.tsx) so this Stack fully owns headers/back
// navigation for every screen below. Only the list screen ("index") gets the
// ContextSwitcher in its header — sub-screens rely on the Stack's native
// back button instead, matching the outer Tabs' "one switcher, on the
// landing screen of each section" convention.
export default function EventsStack() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: "My Events", headerRight: () => <ContextSwitcher /> }} />
      <Stack.Screen name="new" options={{ title: "Post a gig" }} />
      <Stack.Screen name="[gigId]" options={{ title: "Gig" }} />
      <Stack.Screen name="series/[seriesId]" options={{ title: "Series" }} />
    </Stack>
  );
}

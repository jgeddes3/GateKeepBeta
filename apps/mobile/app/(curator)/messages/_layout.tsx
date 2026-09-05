import { Stack } from "expo-router";
import { useShellScreenOptions } from "../../../src/shell/useShellScreenOptions";

// SP12 Task 10: the "Messages" tab becomes a Stack (list -> thread), the
// outer Tabs navigator hides its own header for this tab (see
// ../_layout.tsx, same headerShown:false reasoning already recorded there
// for the "events" tab) so this Stack fully owns headers/back navigation
// for both screens below. useShellScreenOptions() gives both screens the
// same themed header styling and default ContextSwitcher the tab group's
// own header uses; ConversationThread overrides its own screen's title and
// headerRight (a "More" button, not the switcher) once it knows the other
// profile's name.
export default function CuratorMessagesStack() {
  return (
    <Stack screenOptions={useShellScreenOptions()}>
      <Stack.Screen name="index" options={{ title: "Messages" }} />
      <Stack.Screen name="[conversationId]" options={{ title: "Conversation" }} />
    </Stack>
  );
}

import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import { ConversationThread } from "../../../src/messaging/ConversationThread";
import { Text, PageBackground } from "../../../src/ui";
import { tokens } from "../../../src/theme/tokens";

// SP12 Task 10. `key={...}` remounts ConversationThread on any identity or
// route switch (same idiom BookingThread's own mount site uses), so a
// profile-context or conversation change always gets a fresh instance
// instead of reusing stale per-action state.
export default function MusicianConversation() {
  const { activeContext } = useProfileContext();
  const { conversationId, acting } = useLocalSearchParams<{ conversationId: string; acting?: string }>();
  // A non-empty `acting` param (SP12 fix round 1: MessageButton/BookingThread
  // carry the acting profile on the route instead of switching the shared
  // activeContext app-wide) wins over the derived activeContext profile;
  // otherwise this falls back to the existing derivation exactly as before.
  const profileId = acting
    ? acting
    : (typeof activeContext === "object" && activeContext.type === "musician" ? activeContext.profileId : null);

  if (!profileId || !conversationId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl }}>
          <Text muted style={{ textAlign: "center" }}>Switch to a musician profile to see its messages.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ConversationThread key={`${profileId}-${conversationId}`} profileId={profileId} conversationId={conversationId} />
    </View>
  );
}

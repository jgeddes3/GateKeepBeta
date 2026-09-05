import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { isValidDocId } from "@gatekeep/shared";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import { ConversationThread, parsePairId } from "../../../src/messaging/ConversationThread";
import { Text, PageBackground } from "../../../src/ui";
import { tokens } from "../../../src/theme/tokens";

// SP12 Task 10. `key={...}` remounts ConversationThread on any identity or
// route switch (same idiom BookingThread's own mount site uses), so a
// profile-context or conversation change always gets a fresh instance
// instead of reusing stale per-action state.
//
// Fix round 2 (whole-branch fix wave): a push routed here with no `acting`
// param used to fall straight to the shared activeContext, so a dual-role
// user whose active context is their musician profile saw "Switch to a
// curator profile" even while holding the exact curator profile this pair
// names. `acting` still wins when present, but only once it is
// doc-id-shaped (typeof + the same isValidDocId check parsePairId itself
// applies to both halves of the pair): it becomes a Firestore path segment
// the moment ConversationThread mounts (profiles/{acting}/conversations/
// {conversationId}), so a malformed or wrongly-typed param is treated as
// absent rather than handed straight to a doc() call. Absent (or invalid),
// this resolves the acting profile from the pair itself: the member
// profile (myProfiles) matching the curator half of conversationId, and
// only falls back to activeContext when the user holds no such profile.
export default function CuratorConversation() {
  const { activeContext, myProfiles } = useProfileContext();
  const { conversationId, acting } = useLocalSearchParams<{ conversationId: string; acting?: string }>();
  const actingParam = typeof acting === "string" && isValidDocId(acting) ? acting : null;
  const pair = conversationId ? parsePairId(conversationId) : null;
  const pairProfile = pair
    ? myProfiles.find((p) => p.type === "curator" && p.profileId === pair.curatorProfileId)
    : null;
  const profileId = actingParam
    ?? pairProfile?.profileId
    ?? (typeof activeContext === "object" && activeContext.type === "curator" ? activeContext.profileId : null);

  if (!profileId || !conversationId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl }}>
          <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to see its messages.</Text>
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

import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { conversationPairId, MESSAGE_ACTION_LABEL, type ProfileType } from "@gatekeep/shared";
import { useProfileContext, type ProfileSummary } from "../shell/ProfileContext";
import { Button, Sheet, Text } from "../ui";
import { tokens } from "../theme/tokens";

// SP12 (spec 3.1). The mobile twin of Task 7's web MessageButton
// (apps/web/src/messaging/MessageButton.tsx): same gate, HIDDEN, never
// disabled, when the viewer has no eligible profile of the opposite type
// (R-26 posture, same as OfferGigButton/web's own MessageButton), straight
// through with exactly one eligible profile, a picker Sheet with several.
// `myProfiles` comes from useProfileContext() in place of web's
// useMyProfiles, and the Sheet primitive stands in for web's Sheet dialog.
//
// The conversation id is computed client-side (conversationPairId) purely
// to pre-select the thread; the conversation itself is created server-side
// on the first send, so linking to a pair that has never been messaged is
// safe. ConversationThread gates its messages listener on the acting
// profile's own mirror doc (profiles/{acting}/conversations/{pairId}),
// which does not exist yet for such a pair, so it renders the empty state
// with the composer enabled instead of attempting a read the rules would
// deny; the first send writes the mirror and attaches the real listener.
//
// Fix round 1 (review ruling): each Messages tab group's own thread screen
// now reads an optional `acting` search param first, falling back to the
// shared activeContext only when it's absent (Task 10's app/(musician|
// curator)/messages/[conversationId].tsx). This button carries the chosen
// acting profile on the route itself instead of calling switchTo, so a
// press here never silently re-identifies a dual-role user app-wide just to
// open one thread.
export function MessageButton({ targetProfileId, targetProfileType, targetName, actingProfileId }: {
  targetProfileId: string;
  targetProfileType: ProfileType;
  targetName: string;
  actingProfileId?: string;
}) {
  const { myProfiles } = useProfileContext();
  const router = useRouter();
  const [picking, setPicking] = useState(false);

  const wantedType: ProfileType = targetProfileType === "musician" ? "curator" : "musician";
  const eligible = actingProfileId
    ? myProfiles.filter((p) => p.profileId === actingProfileId)
    : myProfiles.filter((p) => p.type === wantedType && p.status === "approved");
  if (eligible.length === 0) return null;

  const open = (acting: ProfileSummary) => {
    const pairId = targetProfileType === "musician"
      ? conversationPairId(targetProfileId, acting.profileId)
      : conversationPairId(acting.profileId, targetProfileId);
    router.push(
      acting.type === "musician"
        ? { pathname: "/(musician)/messages/[conversationId]", params: { conversationId: pairId, acting: acting.profileId } }
        : { pathname: "/(curator)/messages/[conversationId]", params: { conversationId: pairId, acting: acting.profileId } },
    );
  };

  return (
    <>
      <Button
        variant="secondary"
        title={MESSAGE_ACTION_LABEL}
        accessibilityLabel={`Message ${targetName}`}
        onPress={() => (eligible.length === 1 ? open(eligible[0]) : setPicking(true))}
      />
      <Sheet visible={picking} onClose={() => setPicking(false)}>
        <View style={{ gap: tokens.space.sm }}>
          <Text variant="title">Message {targetName} as</Text>
          {eligible.map((p) => (
            <Button
              key={p.profileId}
              variant="secondary"
              title={p.name}
              accessibilityLabel={`Message as ${p.name}`}
              style={{ alignSelf: "flex-start" }}
              onPress={() => { setPicking(false); open(p); }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

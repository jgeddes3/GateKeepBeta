import { View } from "react-native";
import { HOME_CITY_PROMPT_LINE } from "@gatekeep/shared";
import { Text, Button, Sheet } from "../ui";
import { tokens } from "../theme/tokens";
import type { DeckLocationState } from "./useDeckLocation";

// SP8 Task 14: extracted from DeckScreen.tsx (it was inline there, SP7 Task
// 12) so the fan Search tab's FanFace can mount the identical skippable
// location prompt without duplicating its copy or buttons. Copy and buttons
// unchanged from the deck; only `state` (the Pick below is every field this
// component actually reads) moved out to a prop so a second screen can
// share it against its own useDeckLocation() instance.
//
// Fix round 1 (minor #7): the body line named "the deck" even when this
// sheet mounted from a search face, which never showed a deck. `body`
// defaults to that same deck line (DeckScreen passes nothing, so it reads
// exactly as before), and each search face passes its own line instead.
const DECK_BODY = "Allow location and the deck ranks nearby rooms and shows first. Nothing is stored.";

export function LocationPromptSheet({
  state, body = DECK_BODY, showHomeCityHint,
}: {
  state: Pick<DeckLocationState, "promptVisible" | "allow" | "dismiss">;
  body?: string;
  // SP11 Task 13 (spec section 3.2): a fan with no home city set gets the
  // one extra line pointing at Account, so they learn the fallback exists
  // instead of only ever seeing an unranked deck when they decline
  // location. A fan who already set one is not told to set one again.
  showHomeCityHint?: boolean;
}) {
  return (
    <Sheet visible={state.promptVisible} onClose={() => void state.dismiss()}>
      <View style={{ gap: tokens.space.md }}>
        <View style={{ gap: 4 }}>
          <Text variant="title">Show what&apos;s close</Text>
          <Text muted>{body}</Text>
          {showHomeCityHint && <Text muted>{HOME_CITY_PROMPT_LINE}</Text>}
        </View>
        <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
          <Button title="Not now" variant="ghost" onPress={() => void state.dismiss()} style={{ flex: 1 }} />
          <Button title="Allow" onPress={() => void state.allow()} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}

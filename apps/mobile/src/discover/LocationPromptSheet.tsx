import { View } from "react-native";
import { Text, Button, Sheet } from "../ui";
import { tokens } from "../theme/tokens";
import type { DeckLocationState } from "./useDeckLocation";

// SP8 Task 14: extracted from DeckScreen.tsx (it was inline there, SP7 Task
// 12) so the fan Search tab's FanFace can mount the identical skippable
// location prompt without duplicating its copy or buttons. Copy and buttons
// unchanged from the deck; only `state` (the Pick below is every field this
// component actually reads) moved out to a prop so a second screen can
// share it against its own useDeckLocation() instance.
export function LocationPromptSheet({
  state,
}: {
  state: Pick<DeckLocationState, "promptVisible" | "allow" | "dismiss">;
}) {
  return (
    <Sheet visible={state.promptVisible} onClose={() => void state.dismiss()}>
      <View style={{ gap: tokens.space.md }}>
        <View style={{ gap: 4 }}>
          <Text variant="title">Show what&apos;s close</Text>
          <Text muted>Allow location and the deck ranks nearby rooms and shows first. Nothing is stored.</Text>
        </View>
        <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
          <Button title="Not now" variant="ghost" onPress={() => void state.dismiss()} style={{ flex: 1 }} />
          <Button title="Allow" onPress={() => void state.allow()} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}

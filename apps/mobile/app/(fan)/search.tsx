import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { PageBackground } from "../../src/ui";
import { FanFace } from "../../src/search/FanFace";
import { useSavedSearchRestore } from "../../src/search/useSavedSearchRestore";

// SP8 Task 14/17: the fan Search tab. `saved` (set by SavedSearchesScreen's
// own row navigation) resolves through useSavedSearchRestore before FanFace
// ever mounts, so its `initial` prop (which useSearch only reads at mount)
// carries the saved search's actual q/filters rather than racing an
// already-mounted empty face. A missing or permission-denied doc (deleted,
// or someone else's link) just renders the empty face, no alert.
export default function Screen() {
  const { saved } = useLocalSearchParams<{ saved?: string }>();
  const { ready, initial } = useSavedSearchRestore(saved);

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      {ready && <FanFace initial={initial} />}
    </View>
  );
}

import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { PageBackground } from "../../src/ui";
import { FanFace } from "../../src/search/FanFace";

// SP8 Task 14: the fan Search tab. `saved` will resolve to a saved search's
// own q/filters, passed through as FanFace's `initial`, once Task 17 wires
// that lookup up; the param is read here now so this screen's own contract
// (and expo-router's typed route) is already in place.
export default function Screen() {
  useLocalSearchParams<{ saved?: string }>();
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <FanFace />
    </View>
  );
}

import { View } from "react-native";
import { Chip } from "../ui";
import { tokens } from "../theme/tokens";

// Mobile twin of apps/web/src/search/ListMapToggle.tsx: two Chips standing
// in for a segmented control, the same shape MusicianFace's own SegmentChips
// uses for its Gigs | Venues strip. Chip.tsx already sets
// accessibilityState={{selected}} from its own `active` prop and each Chip
// carries an explicit "view" accessibilityLabel, so this needs no extra
// accessibility role of its own on the wrapping row.
export type ResultsView = "list" | "map";

export function ListMapToggle({ view, onChange }: { view: ResultsView; onChange: (view: ResultsView) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: tokens.space.xs }}>
      <Chip label="List" active={view === "list"} onPress={() => onChange("list")} accessibilityLabel="List view" />
      <Chip label="Map" active={view === "map"} onPress={() => onChange("map")} accessibilityLabel="Map view" />
    </View>
  );
}

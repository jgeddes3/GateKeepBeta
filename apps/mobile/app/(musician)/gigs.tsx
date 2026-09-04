import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { MusicianFace } from "../../src/search/MusicianFace";
import { PageBackground } from "../../src/ui";

// Musician "Find gigs" tab (SP8 Task 15): the Gigs | Venues search face,
// replacing the earlier browse placeholder. Browsing is public the same
// way that screen's was; the Apply flow gates on an approved musician profile
// internally (GigDetailSheet's own ApplyPanel). `gigId` opens that sheet on
// mount (Task 17's deep link); `segment` picks the starting tab; `saved` is
// read into the params type here but not consumed yet, Task 17 wires it
// into `initial`.
export default function Gigs() {
  const { gigId, segment } = useLocalSearchParams<{ gigId?: string; saved?: string; segment?: string }>();
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <MusicianFace preselectGigId={gigId ?? null} initialSegment={segment === "venues" ? "venues" : "gigs"} />
    </View>
  );
}

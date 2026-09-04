import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { MusicianFace } from "../../src/search/MusicianFace";
import { PageBackground } from "../../src/ui";
import { useSavedSearchRestore } from "../../src/search/useSavedSearchRestore";

// Musician "Find gigs" tab (SP8 Task 15/17): the Gigs | Venues search face,
// replacing the earlier browse placeholder. Browsing is public the same
// way that screen's was; the Apply flow gates on an approved musician profile
// internally (GigDetailSheet's own ApplyPanel). `gigId` opens that sheet on
// mount (Task 17's deep link). `saved` resolves through
// useSavedSearchRestore before MusicianFace ever mounts (its `initial` and
// `initialSegment` props only take effect at mount); an explicit `segment`
// param always wins, otherwise the saved doc's own face picks the starting
// tab. A missing or permission-denied doc just renders the empty face, no
// alert.
export default function Gigs() {
  const { gigId, segment, saved } = useLocalSearchParams<{ gigId?: string; saved?: string; segment?: string }>();
  const { ready, initial, face } = useSavedSearchRestore(saved);

  const initialSegment = segment !== undefined
    ? (segment === "venues" ? "venues" : "gigs")
    : (face === "musician_venues" ? "venues" : "gigs");

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      {ready && (
        <MusicianFace preselectGigId={gigId ?? null} initialSegment={initialSegment} initial={initial} />
      )}
    </View>
  );
}

import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import type { SearchFilters, SearchPin } from "@gatekeep/shared";
import { GigDetailSheet } from "../bookings/GigDetailSheet";
import { LocationPromptSheet } from "../discover/LocationPromptSheet";
import { useDeckLocation, type DeckLocationState } from "../discover/useDeckLocation";
import { Chip } from "../ui";
import { tokens } from "../theme/tokens";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { MapResults } from "./MapResults";
import { ResultList } from "./ResultList";
import { GigRow, ProfileRow } from "./ResultRows";
import { regionFromLocation } from "./ResultsMap";
import { SearchHeader } from "./SearchHeader";
import { useSearch } from "./useSearch";

// SP8 Task 15: the musician's search, mobile twin of apps/web/src/search/
// MusicianFace.tsx. Web mounts Gigs and Venues as Radix Tabs (only the
// active TabsContent stays mounted); mobile has no tabs primitive (ruling
// 4), so the two Chips below stand in for the tab strip and GigsSegment/
// VenuesSegment below reproduce the same "only the active segment is
// mounted" behaviour by hand, each owning its own useSearch that resets to
// a fresh query on remount, exactly as web's own comment describes.
//
// GigDetailSheet and its open gig id live here in the parent, NOT inside
// GigsSegment: if they lived in GigsSegment, switching to Venues and back
// would remount GigsSegment and re-run `preselectGigId ?? null`, reopening a
// sheet the musician already closed. Keeping them at this level means the
// sheet's own state survives a segment switch.

type Segment = "gigs" | "venues";

// Fix round 1 (important #2): "Gigs" | "Venues" stand in for a tab strip
// (RN has no tablist role), so each Chip carries an accessibilityLabel that
// says so explicitly ("Gigs, segment") rather than just its bare visible
// text, and Chip.tsx's own accessibilityState={{selected}} (added this
// round) announces which one is current. A sighted user reads the active
// Chip's fill color; VoiceOver/TalkBack reads both of those instead.
function SegmentChips({ segment, onChange }: { segment: Segment; onChange: (s: Segment) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Chip label="Gigs" active={segment === "gigs"} onPress={() => onChange("gigs")} accessibilityLabel="Gigs, segment" />
      <Chip label="Venues" active={segment === "venues"} onPress={() => onChange("venues")} accessibilityLabel="Venues, segment" />
    </View>
  );
}

function GigsSegment({ segment, onSegmentChange, location, initial, headerRight, onOpenGig }: {
  segment: Segment; onSegmentChange: (s: Segment) => void; location: DeckLocationState;
  initial?: { q: string; filters: SearchFilters }; headerRight?: ReactNode;
  onOpenGig: (gigId: string) => void;
}) {
  const [view, setView] = useState<ResultsView>("list");
  const [selectedPin, setSelectedPin] = useState<SearchPin | null>(null);
  const state = useSearch("musician_gigs", { location: location.location, includePins: view === "map", initial });
  const header = (
    <SearchHeader
      value={state.q} onChangeText={state.setQ} placeholder="Search gigs"
      face="musician_gigs" filters={state.filters} onFiltersChange={state.setFilters} location={location}
      above={<SegmentChips segment={segment} onChange={onSegmentChange} />}
      right={
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <ListMapToggle view={view} onChange={(v) => { setView(v); setSelectedPin(null); }} />
          {headerRight}
        </View>
      }
    />
  );
  if (view === "map") {
    return (
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.md }}>
        {header}
        <MapResults
          pins={state.pins}
          selected={selectedPin}
          onSelect={setSelectedPin}
          onOpen={(pin: SearchPin) => onOpenGig(pin.id)}
          // regionFromLocation builds a fresh Region object every render;
          // that's fine here, MapView only reads initialRegion once at
          // mount (react-native-maps' own naming, "initial"), so this is
          // deliberately not memoized.
          initialRegion={regionFromLocation(location.location)}
        />
      </ScrollView>
    );
  }
  return (
    <ResultList state={state} header={header} renderRow={(r) => <GigRow r={r} onPress={() => onOpenGig(r.id)} />} />
  );
}

function VenuesSegment({ segment, onSegmentChange, location, initial, headerRight }: {
  segment: Segment; onSegmentChange: (s: Segment) => void; location: DeckLocationState;
  initial?: { q: string; filters: SearchFilters }; headerRight?: ReactNode;
}) {
  const router = useRouter();
  const state = useSearch("musician_venues", { location: location.location, includePins: false, initial });
  const header = (
    <SearchHeader
      value={state.q} onChangeText={state.setQ} placeholder="Search venues"
      face="musician_venues" filters={state.filters} onFiltersChange={state.setFilters} location={location}
      above={<SegmentChips segment={segment} onChange={onSegmentChange} />} right={headerRight}
    />
  );
  return (
    <ResultList
      state={state}
      header={header}
      renderRow={(r) => (
        <ProfileRow r={r} onPress={() => router.push({ pathname: "/venue/[handle]", params: { handle: r.handle ?? "" } })} />
      )}
    />
  );
}

export function MusicianFace({ initialSegment, initial, preselectGigId, headerRight }: {
  initialSegment?: Segment;
  initial?: { q: string; filters: SearchFilters };
  preselectGigId?: string | null;
  headerRight?: ReactNode;
}) {
  const [segment, setSegment] = useState<Segment>(initialSegment ?? "gigs");
  const location = useDeckLocation();
  const [openGigId, setOpenGigId] = useState<string | null>(preselectGigId ?? null);

  return (
    <View style={{ flex: 1 }}>
      {segment === "gigs" ? (
        <GigsSegment
          segment={segment} onSegmentChange={setSegment} location={location}
          initial={initial} headerRight={headerRight} onOpenGig={setOpenGigId}
        />
      ) : (
        <VenuesSegment
          segment={segment} onSegmentChange={setSegment} location={location}
          initial={initial} headerRight={headerRight}
        />
      )}
      <LocationPromptSheet state={location} />
      <GigDetailSheet gigId={openGigId} onClose={() => setOpenGigId(null)} />
    </View>
  );
}

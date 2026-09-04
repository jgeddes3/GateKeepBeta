import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { SearchFace, SearchFilters } from "@gatekeep/shared";
import { GigDetailSheet } from "../bookings/GigDetailSheet";
import { LocationPromptSheet } from "../discover/LocationPromptSheet";
import { useDeckLocation, type DeckLocationState } from "../discover/useDeckLocation";
import { Chip, IconMagnifyingGlass, Input } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { FilterChips } from "./FilterChips";
import { ResultList } from "./ResultList";
import { GigRow, ProfileRow } from "./ResultRows";
import { useSearch, type UseSearchState } from "./useSearch";

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

function SegmentChips({ segment, onChange }: { segment: Segment; onChange: (s: Segment) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Chip label="Gigs" active={segment === "gigs"} onPress={() => onChange("gigs")} />
      <Chip label="Venues" active={segment === "venues"} onPress={() => onChange("venues")} />
    </View>
  );
}

function SearchHeader({ segment, onSegmentChange, state, placeholder, face, location, headerRight }: {
  segment: Segment; onSegmentChange: (s: Segment) => void; state: UseSearchState;
  placeholder: string; face: SearchFace; location: DeckLocationState; headerRight?: ReactNode;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: tokens.space.md, paddingBottom: tokens.space.md }}>
      <SegmentChips segment={segment} onChange={onSegmentChange} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <View style={{ position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 }}>
            <IconMagnifyingGlass size={18} color={t.muted} />
          </View>
          <Input
            value={state.q}
            onChangeText={state.setQ}
            placeholder={placeholder}
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={{ paddingLeft: 40 }}
          />
        </View>
        {headerRight}
      </View>
      <FilterChips face={face} filters={state.filters} onChange={state.setFilters} location={location} />
    </View>
  );
}

function GigsSegment({ segment, onSegmentChange, location, initial, headerRight, onOpenGig }: {
  segment: Segment; onSegmentChange: (s: Segment) => void; location: DeckLocationState;
  initial?: { q: string; filters: SearchFilters }; headerRight?: ReactNode;
  onOpenGig: (gigId: string) => void;
}) {
  const state = useSearch("musician_gigs", { location: location.location, includePins: false, initial });
  const header = (
    <SearchHeader segment={segment} onSegmentChange={onSegmentChange} state={state}
      placeholder="Search gigs" face="musician_gigs" location={location} headerRight={headerRight} />
  );
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
    <SearchHeader segment={segment} onSegmentChange={onSegmentChange} state={state}
      placeholder="Search venues" face="musician_venues" location={location} headerRight={headerRight} />
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

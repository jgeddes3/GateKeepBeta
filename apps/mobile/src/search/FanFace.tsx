import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import type { SearchFilters, SearchPin } from "@gatekeep/shared";
import { LocationPromptSheet } from "../discover/LocationPromptSheet";
import { useDeckLocation } from "../discover/useDeckLocation";
import { tokens } from "../theme/tokens";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { MapResults } from "./MapResults";
import { ResultList } from "./ResultList";
import { ShowRow } from "./ResultRows";
import { regionFromLocation } from "./ResultsMap";
import { SearchHeader } from "./SearchHeader";
import { useSearch } from "./useSearch";

// The fan Search tab (mobile twin of apps/web/src/search/FanFace.tsx): a
// free-text box, the "fan" face's filter chips, and a paged list (or, once
// this task's List | Map toggle is switched, a map) of upcoming shows.
// `headerRight` is a slot for Task 17's save-search button, which sits
// beside this task's own toggle rather than replacing it.
export function FanFace({ initial, headerRight }: {
  initial?: { q: string; filters: SearchFilters };
  headerRight?: ReactNode;
}) {
  const router = useRouter();
  const location = useDeckLocation();
  const [view, setView] = useState<ResultsView>("list");
  const [selectedPin, setSelectedPin] = useState<SearchPin | null>(null);
  const state = useSearch("fan", { location: location.location, includePins: view === "map", initial });

  const openShow = (id: string) => router.push({ pathname: "/event/[eventId]", params: { eventId: id } });

  const header = (
    <SearchHeader
      value={state.q}
      onChangeText={state.setQ}
      placeholder="Search shows, artists, venues"
      face="fan"
      filters={state.filters}
      onFiltersChange={state.setFilters}
      location={location}
      right={
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <ListMapToggle view={view} onChange={(v) => { setView(v); setSelectedPin(null); }} />
          {headerRight}
        </View>
      }
    />
  );

  return (
    <View style={{ flex: 1 }}>
      {view === "map" ? (
        <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.md }}>
          {header}
          <MapResults
            pins={state.pins}
            selected={selectedPin}
            onSelect={setSelectedPin}
            onOpen={(pin) => openShow(pin.id)}
            // regionFromLocation builds a fresh Region object every render;
            // that's fine here, MapView only reads initialRegion once at
            // mount (react-native-maps' own naming, "initial"), so this is
            // deliberately not memoized.
            initialRegion={regionFromLocation(location.location)}
          />
        </ScrollView>
      ) : (
        <ResultList
          state={state}
          header={header}
          renderRow={(r) => <ShowRow r={r} onPress={() => openShow(r.id)} />}
        />
      )}
      <LocationPromptSheet state={location} />
    </View>
  );
}

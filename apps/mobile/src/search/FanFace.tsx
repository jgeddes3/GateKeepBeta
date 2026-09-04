import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import type { SearchFilters, SearchPin } from "@gatekeep/shared";
import { LocationPromptSheet } from "../discover/LocationPromptSheet";
import { useDeckLocation } from "../discover/useDeckLocation";
import { formatGigDateTime } from "../gigs/GigForms";
import { Button, Card, Text } from "../ui";
import { tokens } from "../theme/tokens";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { ResultList } from "./ResultList";
import { ShowRow } from "./ResultRows";
import { regionFromLocation, ResultsMap } from "./ResultsMap";
import { SearchHeader } from "./SearchHeader";
import { useSearch } from "./useSearch";

// SP8 Task 16: the selected pin's own card in map view, one Card with a
// date line (only when the pin actually carries one; every SearchPin this
// face produces does, kind "show", but the shared type doesn't guarantee
// it) and an "Open" button that does exactly what ShowRow's own press does.
function SelectedShowCard({ pin, onOpen }: { pin: SearchPin; onOpen: () => void }) {
  return (
    <Card style={{ gap: tokens.space.xs }}>
      <Text variant="label">{pin.title}</Text>
      <Text variant="meta" muted>{pin.subtitle}</Text>
      {pin.startsAt != null && <Text variant="meta" muted>{formatGigDateTime(pin.startsAt)}</Text>}
      <Button title="Open" onPress={onOpen} style={{ marginTop: tokens.space.xs, alignSelf: "flex-start" }} />
    </Card>
  );
}

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
          <ResultsMap pins={state.pins} onSelect={setSelectedPin} initialRegion={regionFromLocation(location.location)} />
          {selectedPin && <SelectedShowCard pin={selectedPin} onOpen={() => openShow(selectedPin.id)} />}
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

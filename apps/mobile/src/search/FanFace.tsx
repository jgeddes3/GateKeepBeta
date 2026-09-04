import type { ReactNode } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { SearchFilters } from "@gatekeep/shared";
import { LocationPromptSheet } from "../discover/LocationPromptSheet";
import { useDeckLocation } from "../discover/useDeckLocation";
import { ResultList } from "./ResultList";
import { ShowRow } from "./ResultRows";
import { SearchHeader } from "./SearchHeader";
import { useSearch } from "./useSearch";

// The fan Search tab (mobile twin of apps/web/src/search/FanFace.tsx): a
// free-text box, the "fan" face's filter chips, and a paged list of
// upcoming shows. `headerRight` is a slot for Task 16's map toggle and Task
// 17's save-search button, neither of which exists yet; `initial` stays
// undefined until Task 17 wires a saved search's own q/filters through
// app/(fan)/search.tsx's `saved` param.
export function FanFace({ initial, headerRight }: {
  initial?: { q: string; filters: SearchFilters };
  headerRight?: ReactNode;
}) {
  const router = useRouter();
  const location = useDeckLocation();
  const state = useSearch("fan", { location: location.location, includePins: false, initial });

  const header = (
    <SearchHeader
      value={state.q}
      onChangeText={state.setQ}
      placeholder="Search shows, artists, venues"
      face="fan"
      filters={state.filters}
      onFiltersChange={state.setFilters}
      location={location}
      right={headerRight}
    />
  );

  return (
    <View style={{ flex: 1 }}>
      <ResultList
        state={state}
        header={header}
        renderRow={(r) => (
          <ShowRow
            r={r}
            onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId: r.id } })}
          />
        )}
      />
      <LocationPromptSheet state={location} />
    </View>
  );
}

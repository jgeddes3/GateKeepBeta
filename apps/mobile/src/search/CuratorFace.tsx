import type { ReactNode } from "react";
import { View } from "react-native";
import type { SearchFilters } from "@gatekeep/shared";
import type { DeckLocationState } from "../discover/useDeckLocation";
import { IconMagnifyingGlass, Input } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { CuratorArtistRow } from "./CuratorArtistRow";
import { FilterChips } from "./FilterChips";
import { ResultList } from "./ResultList";
import { useSearch } from "./useSearch";

// SP8 Task 15: the curator's "find an artist" search, mobile twin of
// apps/web/src/search/CuratorFace.tsx. FACE_FILTER_KEYS.curator carries no
// "nearMe" entry, so FilterChips never renders the Near me chip for this
// face and never reads this stub's fields; it exists only to satisfy
// FilterChips' required `location` prop without asking a curator screen for
// a device position it has no use for (this face takes only
// curatorProfileId, no location prop of its own, same as web's own ruling).
const NO_LOCATION: Pick<DeckLocationState, "location" | "promptVisible" | "enable"> = {
  location: null, promptVisible: false, enable: async () => {},
};

export function CuratorFace({ curatorProfileId, initial, headerRight }: {
  curatorProfileId: string;
  initial?: { q: string; filters: SearchFilters };
  headerRight?: ReactNode;
}) {
  const t = useTokens();
  const state = useSearch("curator", { location: null, includePins: false, initial });

  const header = (
    <View style={{ gap: tokens.space.md, paddingBottom: tokens.space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <View style={{ position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 }}>
            <IconMagnifyingGlass size={18} color={t.muted} />
          </View>
          <Input
            value={state.q}
            onChangeText={state.setQ}
            placeholder="Search artists by name"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={{ paddingLeft: 40 }}
          />
        </View>
        {headerRight}
      </View>
      <FilterChips face="curator" filters={state.filters} onChange={state.setFilters} location={NO_LOCATION} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <ResultList
        state={state}
        header={header}
        renderRow={(r) => <CuratorArtistRow curatorProfileId={curatorProfileId} r={r} />}
      />
    </View>
  );
}

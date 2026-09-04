import type { ReactNode } from "react";
import { View } from "react-native";
import type { SearchFace, SearchFilters } from "@gatekeep/shared";
import type { DeckLocationState } from "../discover/useDeckLocation";
import { IconMagnifyingGlass, Input } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { FilterChips } from "./FilterChips";

// SP8 Task 15 fix round 1 (minor #3): the icon + Input + FilterChips block
// every face's own header repeated byte-for-byte (FanFace, CuratorFace, and
// MusicianFace's own local SearchHeader). One component now, with two slots
// a caller supplies instead of hand-rolling: `above` for a row that belongs
// ABOVE the search box (MusicianFace's Gigs | Venues segment Chips; no
// other face uses it), and `right` for the header-actions slot every face
// already exposed as its own `headerRight` prop (Task 16's map toggle,
// Task 17's save-search button).
export function SearchHeader({ value, onChangeText, placeholder, face, filters, onFiltersChange, location, above, right }: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  face: SearchFace;
  filters: SearchFilters;
  onFiltersChange: (f: SearchFilters) => void;
  location: Pick<DeckLocationState, "location" | "promptVisible" | "enable">;
  above?: ReactNode;
  right?: ReactNode;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: tokens.space.md, paddingBottom: tokens.space.md }}>
      {above}
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <View style={{ position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 }}>
            <IconMagnifyingGlass size={18} color={t.muted} />
          </View>
          <Input
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={{ paddingLeft: 40 }}
          />
        </View>
        {right}
      </View>
      <FilterChips face={face} filters={filters} onChange={onFiltersChange} location={location} />
    </View>
  );
}

import type { ReactElement } from "react";
import { FlatList, View } from "react-native";
import { SEARCH_EMPTY_MESSAGE, type SearchResult } from "@gatekeep/shared";
import { ErrorBanner, IconMagnifyingGlass, Skeleton, Text } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import type { UseSearchState } from "./useSearch";

// The one paging list shell for every search face. This is the first
// FlatList-with-onEndReached precedent in this app (ruling 5: no shared
// paging hook exists to reach for instead), so it stays self-contained
// rather than inventing one for a single caller.

function ResultRowSkeleton() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
      <Skeleton width={56} height={56} radius={tokens.radius.sm} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton height={16} width="60%" />
        <Skeleton height={12} width="40%" />
      </View>
    </View>
  );
}

export function ResultList({ state, renderRow, header }: {
  state: UseSearchState;
  renderRow: (r: SearchResult) => ReactElement;
  header?: ReactElement | null;
}) {
  const t = useTokens();
  const firstLoad = state.loading && state.items.length === 0;

  return (
    <View style={{ flex: 1 }}>
      {state.error && (
        <View style={{ paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.lg }}>
          <ErrorBanner message={state.error} />
        </View>
      )}
      <FlatList
        data={state.items}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => renderRow(item)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.sm }}
        ListHeaderComponent={header}
        onEndReached={() => { if (state.hasMore && !state.loading) state.loadMore(); }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          firstLoad ? (
            <View style={{ gap: tokens.space.sm }}>
              {[0, 1, 2].map((i) => <ResultRowSkeleton key={i} />)}
            </View>
          ) : state.error ? null : (
            <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
              <IconMagnifyingGlass size={48} color={t.muted} />
              <Text variant="heading" style={{ textAlign: "center" }}>Nothing matches yet</Text>
              <Text muted style={{ textAlign: "center" }}>{SEARCH_EMPTY_MESSAGE}</Text>
            </View>
          )
        }
        ListFooterComponent={
          !firstLoad && state.loading && state.items.length > 0 ? (
            <View style={{ paddingTop: tokens.space.sm }}><ResultRowSkeleton /></View>
          ) : null
        }
      />
    </View>
  );
}

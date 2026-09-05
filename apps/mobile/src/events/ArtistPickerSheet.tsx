import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { SEARCH_EMPTY_MESSAGE, type SearchInput, type SearchOutput, type SearchResult } from "@gatekeep/shared";
import { callFn } from "../lib/callable";
import { formatChipLabel } from "../discover/discoverQueries";
import { Text, Input, Sheet, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

// Sub-project 11 (spec section 3.5, task 14): the Sheet twin of web's
// ArtistPicker dialog (apps/web/src/events/ArtistPicker.tsx). Backed by the
// SAME `search` callable's `curator` face the mobile Find Musicians screen
// uses (src/search/CuratorFace.tsx), just this sheet's own one-shot
// debounced query rather than useSearch's full paged/filtered state: a
// picker has no filters, no pagination, no map. onPick reports the chosen
// profile id and name; LineupEditor (the only caller) is the one that
// actually calls tagEventArtist, this component only searches and closes.

// Module-scope row component, never defined inside the sheet's own render
// body: one pickable row per result, name then a muted "city · genres" line
// (the fields spec section 3.5 names), matching web's own ArtistPickerResults.
function ArtistPickerRow({ item, onPress }: { item: SearchResult; onPress: () => void }) {
  const meta = [item.city, item.genres.length > 0 ? item.genres.map(formatChipLabel).join(", ") : null]
    .filter((p): p is string => !!p).join(" · ");
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={item.title}
      style={({ pressed }) => ({ paddingVertical: tokens.space.sm, opacity: pressed ? 0.7 : 1 })}>
      <Text variant="label">{item.title}</Text>
      {meta && <Text variant="meta" muted>{meta}</Text>}
    </Pressable>
  );
}

export function ArtistPickerSheet({ visible, onClose, onPick }: {
  visible: boolean; onClose: () => void; onPick: (profileId: string, name: string) => void;
}) {
  const t = useTokens();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [visible, q]);

  // Render-time reset (useSearch.ts's own idiom, mirrored here for the
  // identical reason web's own ArtistPicker uses it): loading/error only
  // ever flip to their in-flight values here, when the request key itself
  // changes, never from inside the fetch effect below.
  const requestKey = `${visible}:${debouncedQ}`;
  const [trackedKey, setTrackedKey] = useState(requestKey);
  if (requestKey !== trackedKey) {
    setTrackedKey(requestKey);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    callFn<SearchInput, SearchOutput>("search", {
      face: "curator", q: debouncedQ, filters: {}, location: null, page: 0, includePins: false,
    })
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data.items);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(e instanceof Error ? e.message : "Search failed.");
      });
    return () => { cancelled = true; };
  }, [visible, debouncedQ]);

  const close = () => {
    setQ("");
    setDebouncedQ("");
    setItems([]);
    setError(null);
    onClose();
  };

  const pick = (item: SearchResult) => {
    onPick(item.id, item.title);
    close();
  };

  return (
    <Sheet visible={visible} onClose={close}>
      {/* Sheet itself takes no stance on keyboard avoidance (its own header
          comment: "a caller putting a form inside a Sheet is responsible for
          its own KeyboardAvoidingView"); without this, the keyboard covers
          the results list on device. iOS needs an explicit "padding"
          behavior to shift the sheet's own content up; Android's own default
          resize behavior already handles this without one, so `behavior` is
          left undefined there rather than forcing a second, redundant
          shift. Same pattern ShowPosts.tsx's PostComposerSheet and
          GigDetailSheet.tsx already established for their own Sheet-hosted
          forms, with the autoFocus Input here the thing that raises the
          keyboard immediately on open. */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">Tag a GateKeep artist</Text>
          <Input value={q} onChangeText={setQ} placeholder="Search artists by name" autoFocus />
          <ScrollView style={{ maxHeight: 320 }}>
            {loading && <ActivityIndicator color={t.muted} />}
            {!loading && error && <ErrorBanner message={error} />}
            {!loading && !error && items.length === 0 && <Text muted>{SEARCH_EMPTY_MESSAGE}</Text>}
            {!loading && !error && items.map((item) => (
              <ArtistPickerRow key={item.id} item={item} onPress={() => pick(item)} />
            ))}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import type { SavedSearchDoc, SearchFace } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { deleteSavedSearch } from "./searchApi";
import { Text, Button, Card, PageBackground, Skeleton, IconMagnifyingGlass } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

type SavedSearchRow = { id: string } & SavedSearchDoc;

// Face names as they read here, mirroring apps/web/src/search/
// SavedSearches.tsx's own FACE_NAME (controller ruling 3b): fan is the fan's
// own shows search, musician_gigs/musician_venues are the musician's two
// tabs, curator is the curator's find-an-artist search.
const FACE_NAME: Record<SearchFace, string> = {
  fan: "Shows",
  musician_gigs: "Gigs",
  musician_venues: "Venues",
  curator: "Artists",
};

// Where a tap on a saved search row reopens it (Task 17, ruling 4): fan
// rows go back to the fan Search tab, both musician faces go to Find gigs
// with `segment` set so MusicianFace opens on the matching tab, curator
// rows go to Find musicians. Each screen resolves `saved` back into the
// face's own `initial` (SavedSearchesScreen itself only navigates).
function openRow(router: ReturnType<typeof useRouter>, row: SavedSearchRow) {
  if (row.face === "fan") {
    router.push({ pathname: "/(fan)/search", params: { saved: row.id } });
  } else if (row.face === "musician_gigs" || row.face === "musician_venues") {
    router.push({ pathname: "/(musician)/gigs", params: { saved: row.id, segment: row.face === "musician_venues" ? "venues" : "gigs" } });
  } else {
    router.push({ pathname: "/(curator)/musicians", params: { saved: row.id } });
  }
}

// The fan's hidden "Saved searches" tab (Task 17, ruling 4), reached from
// AccountScreen's own row, exactly like `following`. Every role's saved
// searches live in the one `savedSearches` collection (owner-read), so this
// single screen lists all of them regardless of which face/profile the
// signed-in user is currently browsing as.
export function SavedSearchesScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const [rows, setRows] = useState<SavedSearchRow[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, "savedSearches"), where("uid", "==", user.uid), orderBy("createdAt", "desc")),
      (snap) => {
        if (cancelled) return;
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as SavedSearchDoc) })));
      });
    return () => { cancelled = true; unsubscribe(); };
  }, [user?.uid]);

  const remove = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteSavedSearch(id);
      // No local filter here: onSnapshot's own next event removes the row,
      // the same "let the subscription be the only writer of `rows`" shape
      // NotificationsList's markRead uses.
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.md, paddingBottom: tokens.space.xl }}>
        <Text variant="title">Saved searches</Text>
        {rows === null && (
          <View style={{ gap: tokens.space.sm }}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </View>
        )}
        {rows !== null && rows.length === 0 && (
          <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
            <IconMagnifyingGlass size={48} color={t.muted} />
            <Text variant="heading" style={{ textAlign: "center" }}>No saved searches yet</Text>
            <Text muted style={{ textAlign: "center" }}>
              Save a search from Search, Find gigs, or Find musicians to get alerted about new matches.
            </Text>
          </View>
        )}
        {rows !== null && rows.map((row) => (
          <Pressable key={row.id} onPress={() => openRow(router, row)} accessibilityRole="button" accessibilityLabel={row.label}>
            <Card style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label" numberOfLines={1}>{row.label}</Text>
                <Text variant="meta" muted>{FACE_NAME[row.face]}</Text>
              </View>
              {deletingId === row.id ? (
                <Text variant="meta" muted>Deleting…</Text>
              ) : (
                <Button title="Delete" variant="secondary" onPress={() => void remove(row.id)}
                  style={{ minHeight: 36, paddingHorizontal: tokens.space.sm }} />
              )}
            </Card>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

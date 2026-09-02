import { useEffect, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { getDocs } from "firebase/firestore";
import { GENRES, type EventDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { showsQuery, dateWindow, formatChipLabel, type ShowRow, type DateFilter } from "./discoverQueries";
import { formatCents } from "../events/eventDisplay";
import { gigLocationLabel } from "../bookings/BookingForms";
import { Text, Card, Chip, ErrorBanner, Skeleton, IconTicket } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 11: RN twin of apps/web/src/discover/ShowsList.tsx. Web's genre
// picker is a <Select> dropdown; the mobile primitive kit has no equivalent
// (DESIGN.md's 9B set), so the genre filter here is a horizontally
// scrollable Chip row instead, single-select like the web dropdown. Date and
// free filtering, and the query pins themselves, are otherwise unchanged
// from the web twin (see discoverQueries.ts's own comments).

const ALL_GENRES_LABEL = "All genres";

function priceLabel(row: ShowRow): string | undefined {
  if (row.priceFromCents == null) return undefined;
  return row.priceFromCents === 0 ? "Free" : `from ${formatCents(row.priceFromCents)}`;
}

function ShowRowItem({ show, onPress }: { show: ShowRow; onPress: () => void }) {
  const price = priceLabel(show);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={show.title || "Untitled event"}>
      <Card style={{ gap: 4 }}>
        <Text variant="label" numberOfLines={1}>{show.title || "Untitled event"}</Text>
        <Text variant="meta" muted numberOfLines={1}>{gigLocationLabel(show.location)}</Text>
        {price && <Text variant="meta" muted>{price}</Text>}
      </Card>
    </Pressable>
  );
}

function ShowRowSkeleton() {
  return (
    <View style={{ gap: 6 }}>
      <Skeleton height={18} width="60%" />
      <Skeleton height={14} width="40%" />
    </View>
  );
}

// The Shows tab: published, upcoming events, filtered by date range, a
// free-tier toggle, and a genre. Date filtering (dateWindow) and the free
// toggle (when a genre is also pinned, see showsQuery's own comment) both
// apply client-side over one fetched 60-row page; genre and the free flag
// alone are the only two dimensions pinned at the Firestore query itself.
export function ShowsList() {
  const router = useRouter();
  const t = useTokens();
  const [rows, setRows] = useState<ShowRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [free, setFree] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>("any");
  // Captured once per mount rather than re-read every render: the query's
  // own startsAt >= now floor would otherwise keep sliding forward as the
  // clock ticks, silently dropping a row out of an already-rendered list.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(showsQuery(db, { genre, free, now }))
      .then((snap) => {
        if (cancelled) return;
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Could not load shows.");
      });
    return () => { cancelled = true; };
  }, [genre, free, now]);

  const filtered = rows === "loading" ? [] : (() => {
    const { from, to } = dateWindow(dateFilter, now);
    return rows.filter((r) => {
      if (r.startsAt < from || (to != null && r.startsAt > to)) return false;
      if (free && !r.hasFreeTier) return false;
      return true;
    });
  })();

  return (
    <View style={{ gap: tokens.space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip label="Today" active={dateFilter === "today"}
          onPress={() => setDateFilter(dateFilter === "today" ? "any" : "today")} />
        <Chip label="This week" active={dateFilter === "week"}
          onPress={() => setDateFilter(dateFilter === "week" ? "any" : "week")} />
        <Chip label="Weekend" active={dateFilter === "weekend"}
          onPress={() => setDateFilter(dateFilter === "weekend" ? "any" : "weekend")} />
        <Chip label="Free" active={free} onPress={() => setFree((v) => !v)} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={ALL_GENRES_LABEL} active={genre === null} onPress={() => setGenre(null)} />
        {GENRES.map((g) => (
          <Chip key={g} label={formatChipLabel(g)} active={genre === g} onPress={() => setGenre(g)} />
        ))}
      </ScrollView>

      {error && <ErrorBanner message={`Could not load shows: ${error}`} />}

      {rows === "loading" && (
        <View style={{ gap: tokens.space.md }}>
          {[0, 1, 2].map((i) => <ShowRowSkeleton key={i} />)}
        </View>
      )}

      {rows !== "loading" && filtered.length === 0 && !error && (
        <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
          <IconTicket size={48} color={t.muted} />
          <Text variant="heading" style={{ textAlign: "center" }}>No shows match these filters</Text>
          <Text muted style={{ textAlign: "center" }}>
            Try a different date range or genre, or clear a filter to see everything on sale.
          </Text>
        </View>
      )}

      {rows !== "loading" && filtered.length > 0 && (
        <View style={{ gap: tokens.space.sm }}>
          {filtered.map((show) => (
            <ShowRowItem
              key={show.id}
              show={show}
              onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId: show.id } })}
            />
          ))}
        </View>
      )}
    </View>
  );
}

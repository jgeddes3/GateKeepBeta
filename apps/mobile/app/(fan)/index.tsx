import { View, Pressable, Image, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import type { EventDoc } from "@gatekeep/shared";
import { useAuth } from "../../src/auth/AuthProvider";
import { useNow } from "../../src/bookings/BookingThread";
import { gigLocationLabel } from "../../src/bookings/BookingForms";
import { formatEventFullDate, formatEventTimeRange, usePosterUrl } from "../../src/events/eventDisplay";
import { useMyTickets, useEventCache } from "../../src/tickets/TicketList";
import { PageBackground, Text, Card, IconMusicNotes, IconTicket } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

// Sub-project 6 task 11 (brief, binding): the fan Home tab gains an
// upcoming-events list for ticket-holders, derived from the SAME
// users/{uid}/tickets + event-cache data src/tickets/TicketList.tsx already
// maintains for the Tickets tab, deduplicated to one row per event. The
// "Discover shows" framing underneath stays exactly the 9B branded
// coming-soon placeholder it already was (sp9b ruling 8 / this task's own
// ruling 7): sub-project 7 is what actually builds discovery, not this task.

type UpcomingEvent = { eventId: string; event: EventDoc };

// Only a currently-HELD, live ticket ("valid"/"checked_in") counts as "your
// upcoming show": a refunded or transferred-away ticket is no longer this
// fan's to attend, matching TicketDetail.tsx's own `isLive` gate.
function useUpcomingTicketedEvents(uid: string | null): UpcomingEvent[] {
  const rows = useMyTickets(uid);
  const liveRows = rows === "loading" ? [] : rows.filter((t) => t.status === "valid" || t.status === "checked_in");
  const eventIds = [...new Set(liveRows.map((t) => t.eventId))];
  const eventCache = useEventCache(eventIds);
  const now = useNow();

  if (rows === "loading" || now == null) return [];
  const seen = new Set<string>();
  const out: UpcomingEvent[] = [];
  for (const t of liveRows) {
    if (seen.has(t.eventId)) continue;
    const load = eventCache[t.eventId];
    if (!load || load.kind !== "ok") continue;
    if (load.event.startsAt <= now) continue;
    seen.add(t.eventId);
    out.push({ eventId: t.eventId, event: load.event });
  }
  return out.sort((a, b) => a.event.startsAt - b.event.startsAt);
}

function UpcomingEventRow({ item, onPress }: { item: UpcomingEvent; onPress: () => void }) {
  const t = useTokens();
  const posterUrl = usePosterUrl(item.event.posterPath);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={item.event.title}>
      <Card style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <View style={{ width: 48, height: 48, borderRadius: tokens.radius.sm, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.surface }}>
              <IconTicket size={16} color={t.muted} />
            </View>
          )}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{item.event.title}</Text>
          <Text variant="meta" muted numberOfLines={1}>
            {formatEventFullDate(item.event.startsAt)} · {formatEventTimeRange(item.event.startsAt, item.event.endsAt)}
          </Text>
          <Text variant="meta" muted numberOfLines={1}>{gigLocationLabel(item.event.location)}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

export default function Screen() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const upcoming = useUpcomingTicketedEvents(user?.uid ?? null);

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl, flexGrow: 1 }}>
        {upcoming.length > 0 && (
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">Your upcoming shows</Text>
            {upcoming.map((item) => (
              <UpcomingEventRow
                key={item.eventId}
                item={item}
                onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId: item.eventId } })}
              />
            ))}
          </View>
        )}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: tokens.space.lg, paddingVertical: tokens.space.xl }}>
          <IconMusicNotes size={48} color={t.muted} />
          <View style={{ alignItems: "center", gap: tokens.space.sm }}>
            <Text variant="heading">Discover shows</Text>
            <Text muted style={{ textAlign: "center" }}>Live music near you, coming soon.</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

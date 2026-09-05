import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import type { EventDoc } from "@gatekeep/shared";
import { ScannerScreen } from "../../../../src/events/ScannerScreen";
import { AttendeeListScreen } from "../../../../src/events/AttendeeListScreen";
import { Text, Button, Chip, ErrorBanner, PageBackground, Skeleton, SkeletonCard } from "../../../../src/ui";
import { tokens } from "../../../../src/theme/tokens";

// Sub-project 6 task 12: the door, one route hosting two tabs (brief
// anatomy: "AttendeeList tab beside the scanner"). Both tabs share the SAME
// event doc's curatorProfileId/status, fetched once here rather than
// duplicated in each tab's own screen.
type Tab = "scan" | "attendees";

export default function DoorScreen() {
  const { eventId: rawEventId } = useLocalSearchParams<{ eventId: string }>();
  const eventId = rawEventId ?? "";
  const { user } = useAuth();
  // Four-way sentinel (audit #11), see (curator)/dashboard.tsx's identical
  // comment.
  const [event, setEvent] = useState<EventDoc | "loading" | "error" | null>("loading");
  const [eventRetry, setEventRetry] = useState(0);
  const [tab, setTab] = useState<Tab>("scan");

  // Render-time reset, same idiom as [gigId].tsx's privLocGigId: navigating
  // from one event's door screen to another's (same route pattern,
  // different eventId) does not remount this screen.
  const [loadedEventId, setLoadedEventId] = useState(eventId);
  if (eventId !== loadedEventId) { setLoadedEventId(eventId); setEvent("loading"); }

  useEffect(() => {
    if (!eventId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "events", eventId),
      (s) => setEvent(s.exists() ? (s.data() as EventDoc) : null),
      (e) => { console.error("DoorScreen: event onSnapshot failed", e); setEvent("error"); });
  }, [eventId, eventRetry]);

  if (!user || event === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={28} width="60%" />
          <SkeletonCard />
        </View>
      </View>
    );
  }
  if (event === "error") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.md }}>
          <ErrorBanner message="Couldn't load this. Retry." />
          <Button title="Retry" variant="secondary" style={{ alignSelf: "flex-start" }}
            onPress={() => { setEvent("loading"); setEventRetry((n) => n + 1); }} />
        </View>
      </View>
    );
  }
  if (!event) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">Event not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.lg, gap: tokens.space.sm }}>
        <Text variant="title" numberOfLines={1}>{event.title || "Untitled event"}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="Scanner" active={tab === "scan"} onPress={() => setTab("scan")} />
          <Chip label="Attendees" active={tab === "attendees"} onPress={() => setTab("attendees")} />
        </View>
      </View>
      {event.status !== "published" && (
        <View style={{ paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.sm }}>
          <Text variant="meta" muted>
            Check-in is only available once this event is published.
          </Text>
        </View>
      )}
      <View style={{ flex: 1, marginTop: tokens.space.sm }}>
        {tab === "scan"
          ? <ScannerScreen curatorProfileId={event.curatorProfileId} eventId={eventId} />
          : <AttendeeListScreen
              curatorProfileId={event.curatorProfileId} eventId={eventId}
              eventStatus={event.status} eventEndsAt={event.endsAt}
            />}
      </View>
    </View>
  );
}

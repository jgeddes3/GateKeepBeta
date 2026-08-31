import { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";
import { httpsCallable } from "firebase/functions";
import { collection, onSnapshot } from "firebase/firestore";
import {
  TICKET_NOT_REFUNDABLE_MESSAGE, TICKET_REFUND_WINDOW_CLOSED_MESSAGE, EVENT_CANCELLED_MESSAGE,
  type AttendeeDoc, type EventStatus,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useNow } from "../bookings/BookingThread";
import { formatEventFullDate, formatGigTime, TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "./eventDisplay";
import {
  Text, Button, Card, Input, Sheet, StatusBadge, ErrorBanner, SkeletonCard, IconUser,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Sub-project 6 task 12: the attendee list tab beside the door scanner. RN
// twin of apps/web/src/events/AttendeeList.tsx (SP6 task 10), extended with
// the list-fallback check-in this brief adds on top of web's refund-only
// surface (controller ruling 1: `override: true`, the boolean literal, is
// what makes checkInTicket skip the qrSecret check).
//
// Live onSnapshot on events/{eventId}/attendees (firestore.rules:
// curator-side members and admin only). refundTicket itself is the
// money-critical call (functions/src/ticketing.ts): this screen never
// guesses at whether a row is refundable beyond the same two checks that
// callable enforces (ticket status valid/checked_in, event not past
// endsAt/cancelled) purely to hide a button that would only bounce; the
// server remains the sole authority either way.

type AttendeeRow = { id: string } & AttendeeDoc;
interface CheckInTicketResult { ownerName: string; tierName: string; checkedInAt: number }
interface CheckInTicketInput {
  curatorProfileId: string; eventId: string; ticketId: string; override: true;
}

function useAttendees(eventId: string): AttendeeRow[] | "loading" {
  const [rows, setRows] = useState<AttendeeRow[] | "loading">("loading");
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(collection(db, `events/${eventId}/attendees`),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as AttendeeDoc) }))));
  }, [eventId]);
  return rows;
}

function checkedInLabel(checkedInAt: number | undefined): string | null {
  if (checkedInAt == null) return null;
  return `${formatEventFullDate(checkedInAt)} at ${formatGigTime(checkedInAt)}`;
}

// ---------- Tap-row check-in confirm sheet (controller ruling 4: a Sheet,
// unlike the event-cancel panel's inline-panel precedent). override: true is
// the list-fallback for a QR that won't scan; the server still enforces
// every other check-in gate (event published, ticket resolves, not
// refunded/transferred) exactly as the scanner's own call does. ----------

function CheckInSheet({ curatorProfileId, eventId, row, onClose }: {
  curatorProfileId: string; eventId: string; row: AttendeeRow; onClose: () => void;
}) {
  const t = useTokens();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CheckInTicketResult | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await httpsCallable<CheckInTicketInput, CheckInTicketResult>(
        getFirebase().functions, "checkInTicket")({ curatorProfileId, eventId, ticketId: row.id, override: true });
      setDone(data);
    } catch (e) {
      // Verbatim server error (e.g. "Ticket already checked in.", "This
      // ticket is not valid for entry.", "Check-in is only available for a
      // published event."): every one is already self-explanatory copy,
      // same convention as this screen's own refund error handling below.
      setError(e instanceof Error ? e.message : "Could not check in this ticket.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible onClose={onClose}>
      <View style={{ gap: tokens.space.md }}>
        {done ? (
          <>
            <Text variant="title" color={t.success}>Checked in</Text>
            <Text>{done.ownerName}</Text>
            <Text muted>{done.tierName}</Text>
            <Button title="Done" onPress={onClose} />
          </>
        ) : (
          <>
            <Text variant="title">Check in {row.ownerName}?</Text>
            <Text muted>{row.tierName}</Text>
            <ErrorBanner message={error} />
            <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
              <Button title={busy ? "Checking in…" : "Check in"} onPress={() => void confirm()} disabled={busy} />
              <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}

// ---------- Row ----------

function AttendeeRowView({ row, refundable, refundBusy, onPress, onRefund }: {
  row: AttendeeRow; refundable: boolean; refundBusy: boolean;
  onPress: () => void; onRefund: () => void;
}) {
  const canRefund = refundable && (row.status === "valid" || row.status === "checked_in");
  const label = checkedInLabel(row.checkedInAt);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Check in ${row.ownerName}, ${row.tierName}`}>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: tokens.space.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
              <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>{row.ownerName}</Text>
              <StatusBadge label={TICKET_STATUS_LABEL[row.status]} status={TICKET_STATUS_TONE[row.status]} />
            </View>
            <Text variant="meta" muted>
              {row.tierName}{label ? ` · Checked in ${label}` : ""}
            </Text>
          </View>
        </View>
        {canRefund && (
          <Button variant="destructive" title={refundBusy ? "Refunding…" : "Refund"} onPress={onRefund} disabled={refundBusy} />
        )}
      </Card>
    </Pressable>
  );
}

function AttendeeListSkeleton() {
  return (
    <View style={{ gap: tokens.space.sm, padding: tokens.space.lg }}>
      <SkeletonCard /><SkeletonCard /><SkeletonCard />
    </View>
  );
}

export function AttendeeListScreen({ curatorProfileId, eventId, eventStatus, eventEndsAt }: {
  curatorProfileId: string; eventId: string; eventStatus: EventStatus; eventEndsAt: number;
}) {
  const t = useTokens();
  const rows = useAttendees(eventId);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checkInRow, setCheckInRow] = useState<AttendeeRow | null>(null);
  const [refundBusyId, setRefundBusyId] = useState<string | null>(null);
  // Same window refundTicket itself enforces (functions/src/ticketing.ts):
  // not cancelled, and not yet past the event's own endsAt, mirrors web
  // AttendeeList.tsx's identical `refundable` derivation via useNow.
  const now = useNow();
  const refundable = now != null && eventStatus !== "cancelled" && now < eventEndsAt;

  const doRefund = async (row: AttendeeRow) => {
    setRefundBusyId(row.id);
    setError(null);
    try {
      await httpsCallable(getFirebase().functions, "refundTicket")({ curatorProfileId, eventId, ticketId: row.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not refund this ticket.";
      // Recognized by name (===-compared shared constants, GatePrompt
      // precedent): each is already self-explanatory copy with no useful
      // interactive follow-up from a door-list row.
      if (message !== TICKET_REFUND_WINDOW_CLOSED_MESSAGE && message !== TICKET_NOT_REFUNDABLE_MESSAGE
          && message !== EVENT_CANCELLED_MESSAGE) {
        console.error("refundTicket failed", eventId, row.id, e);
      }
      setError(message);
    } finally {
      setRefundBusyId(null);
    }
  };
  const confirmRefund = (row: AttendeeRow) => {
    Alert.alert(
      `Refund ${row.ownerName}'s "${row.tierName}" ticket?`, "This can't be undone.",
      [{ text: "Keep ticket", style: "cancel" }, { text: "Refund", style: "destructive", onPress: () => void doRefund(row) }],
    );
  };

  if (rows === "loading") return <AttendeeListSkeleton />;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.ownerName.toLowerCase().includes(q) || r.tierName.toLowerCase().includes(q))
    : rows;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: tokens.space.lg, gap: tokens.space.sm }}>
        <Input
          value={search} onChangeText={setSearch} placeholder="Search attendees"
          accessibilityLabel="Search attendees"
        />
        {!refundable && rows.length > 0 && (
          <Text variant="meta" muted>
            {eventStatus === "cancelled" ? "This event is cancelled; every ticket was already refunded." : "Refunds are closed now that this event has ended."}
          </Text>
        )}
        <ErrorBanner message={error} />
      </View>
      {rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.md }}>
          <IconUser size={32} color={t.muted} />
          <Text variant="title">No attendees yet</Text>
          <Text muted style={{ textAlign: "center" }}>Everyone who buys or RSVPs a ticket shows up here.</Text>
        </View>
      ) : filtered.length === 0 ? (
        <Text muted style={{ paddingHorizontal: tokens.space.lg }}>No attendees match &quot;{search}&quot;.</Text>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ padding: tokens.space.lg, paddingTop: 0, gap: tokens.space.sm }}
          renderItem={({ item }) => (
            <AttendeeRowView
              row={item} refundable={refundable} refundBusy={refundBusyId === item.id}
              onPress={() => setCheckInRow(item)} onRefund={() => confirmRefund(item)}
            />
          )}
        />
      )}
      {checkInRow && (
        <CheckInSheet
          curatorProfileId={curatorProfileId} eventId={eventId} row={checkInRow}
          onClose={() => setCheckInRow(null)}
        />
      )}
    </View>
  );
}

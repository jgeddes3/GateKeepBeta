import { useEffect, useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import {
  DEPOSIT_PERCENT,
  type BookingRequestDoc, type BookingSide, type BookingStatus, type GigDoc,
} from "@gatekeep/shared";
import { Text, StatusBadge } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN port of ../../../web/src/bookings/BookingInbox.tsx (SP4 Task 12),
// per-profile booking inbox + the booking-status DISPLAY helpers it (and
// BookingThread.tsx's thread screen) both need. Mounted as its own tab
// screen on mobile (apps/mobile/app/(musician)/bookings.tsx and
// (curator)/bookings.tsx), unlike web where it's a section on the profile
// editor page, the plan's Task 12 file list names BookingInbox as its own
// peer of BookingThread/OfferForm/CancelDialog, and mobile idiom favors a
// dedicated tab over a long scrolling editor page (SP3 ruling 14
// precedent).

export const BOOKING_TERMINAL_STATUSES: readonly BookingStatus[] = [
  "completed", "declined", "withdrawn", "superseded", "expired", "cancelled_by_curator", "cancelled_by_musician",
];

// Task 8 review carry-forward (mirrored from web): an `expired` booking that
// WAS a confirmed run (acceptedTerms/confirmedAt set, accepted, then later
// unwound by a moderation cascade or the sweep's zombie-run resolver) must
// read as "this booking ended", not like an ordinary declined/expired
// application that never got anywhere.
export function bookingHistoryLabel(b: Pick<BookingRequestDoc, "status" | "acceptedTerms" | "confirmedAt">): string {
  switch (b.status) {
    case "completed": return "Completed";
    case "declined": return "Declined";
    case "withdrawn": return "Withdrawn";
    case "superseded": return "The gig was booked with another act";
    case "expired": return b.acceptedTerms != null || b.confirmedAt != null ? "This booking ended" : "Expired";
    case "cancelled_by_curator": return "Cancelled by the curator";
    case "cancelled_by_musician": return "Cancelled by the musician";
    default: return b.status;
  }
}

// The "$X known" deposit line, used once a real, already-computed deposit
// amount exists (a confirmed booking's own deposit.amountCents). Distinct
// from BookingForms.tsx's DEPOSIT_HONESTY_LINE, the pre-acceptance "implied,
// not yet known" phrasing.
// Final-review fix wave, mirrors web's SP5 Task 15 review round 1 fix
// (medium #6): payments are LIVE, "will be collected when payments launch"
// was accurate pre-SP5 and is now simply false (acceptBooking fires a real
// Stripe charge the moment it commits). DEPOSIT_PERCENT templated in rather
// than a hardcoded "35%" literal, so this can never drift from the actual
// constant. Both call sites (this row, BookingThread's Confirmed section)
// only ever render for an already-confirmed booking, so "charged... at
// accept" describes something that has, in fact, already happened.
export function depositLine(amountCents: number): string {
  return `${DEPOSIT_PERCENT}% deposit (${formatCents(amountCents)}) charged to the curator's card at accept.`;
}

type BookingRow = BookingRequestDoc & { id: string };

// Row-level, permission-tolerant gig title lookup, a permission-denied read
// here is an expected, common case for stale history/declined rows (the
// initiating gig can leave every publicly-readable disjunct once its status
// moves past open/filled/closed-booked while the viewer is on the musician
// side), not a bug, falls back to a generic label. n+1 by design, same as
// web (open threads bounded by MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE=25;
// history capped at 20).
function useRowGigTitle(gigId: string): string {
  const [title, setTitle] = useState<string>("This gig");
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "gigs", gigId))
      .then((s) => { if (!cancelled && s.exists()) setTitle((s.data() as GigDoc).title || "Untitled gig"); })
      .catch(() => { /* permission-denied or offline, keep the generic fallback */ });
    return () => { cancelled = true; };
  }, [gigId]);
  return title;
}

// Confirmed-booking "next date", bookings carry no date of their own, so
// the next occurrence is its own per-booking fetch. Filters
// status=="filled" IN ADDITION to bookingId, a bare bookingId-only list
// query has no provable disjunct under firestore.rules' gigs read rule
// (status is unconstrained); pinning status=="filled" makes it provable via
// the unconditionally-public "filled" disjunct, reusing the
// (bookingId,status,startsAt) index (Task 8) rather than a new one. Every
// currently-linked-and-filled occurrence matches (past FILLED gigs stay
// "filled" forever, per Task 8's review), the same query shape
// BookingThread.tsx's own occurrence list reuses.
function useNextOccurrence(bookingId: string): { startsAt: number } | null {
  const [next, setNext] = useState<{ startsAt: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, "gigs"),
      where("bookingId", "==", bookingId), where("status", "==", "filled"),
      orderBy("startsAt", "asc"), limit(1)))
      .then((snap) => { if (!cancelled) setNext(snap.empty ? null : { startsAt: snap.docs[0].data().startsAt as number }); })
      .catch(() => { if (!cancelled) setNext(null); });
    return () => { cancelled = true; };
  }, [bookingId]);
  return next;
}

function OpenThreadRow({ row, mySide, onPress }: { row: BookingRow; mySide: BookingSide; onPress: () => void }) {
  const t = useTokens();
  const title = useRowGigTitle(row.gigId);
  const yourTurn = row.awaitingSide === mySide;
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.card,
      padding: tokens.space.md, gap: tokens.space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <Text variant="label" style={{ flex: 1 }}>{title}</Text>
        {yourTurn && <StatusBadge status="warning" label="your turn" />}
      </View>
      <Text variant="meta" muted>
        {row.thread.length} offer{row.thread.length === 1 ? "" : "s"} so far
      </Text>
    </Pressable>
  );
}

function ConfirmedRow({ row, onPress }: { row: BookingRow; onPress: () => void }) {
  const t = useTokens();
  const title = useRowGigTitle(row.gigId);
  const next = useNextOccurrence(row.id);
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.card,
      padding: tokens.space.md, gap: tokens.space.xs }}>
      <Text variant="label">{title}</Text>
      {next && <Text variant="meta" muted>{formatGigDateTime(next.startsAt)}</Text>}
      {/* deposit is already frozen (computeDepositCents ran inside
          acceptBooking's transaction), no need to recompute, only display
          the number it already produced. */}
      {row.deposit && <Text variant="meta" muted>{depositLine(row.deposit.amountCents)}</Text>}
    </Pressable>
  );
}

function HistoryRow({ row, onPress }: { row: BookingRow; onPress: () => void }) {
  const t = useTokens();
  const title = useRowGigTitle(row.gigId);
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.card,
      padding: tokens.space.md, gap: tokens.space.xs }}>
      <Text variant="label">{title}</Text>
      <Text variant="meta" muted>{bookingHistoryLabel(row)}</Text>
    </Pressable>
  );
}

// Per-profile booking inbox, mounted by both role tabs
// (apps/mobile/app/(musician)/bookings.tsx / (curator)/bookings.tsx),
// `role` picking which IMMUTABLE side-field this profile is queried
// against. Three lists, each its own onSnapshot on the SAME
// (profileId,status,updatedAt) composite index (Task 2), just a different
// status filter/cap, mirrors web exactly.
export function BookingInbox({ profileId, role }: { profileId: string; role: BookingSide }) {
  const router = useRouter();
  const field = role === "musician" ? "musicianProfileId" : "curatorProfileId";
  const [open, setOpen] = useState<BookingRow[]>([]);
  const [confirmed, setConfirmed] = useState<BookingRow[]>([]);
  const [history, setHistory] = useState<BookingRow[]>([]);

  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "bookings"), where(field, "==", profileId), where("status", "==", "open"),
        orderBy("updatedAt", "desc"), limit(50)),
      (snap) => setOpen(snap.docs.map((d) => ({ id: d.id, ...(d.data() as BookingRequestDoc) }))),
      () => setOpen([]));
  }, [field, profileId]);

  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "bookings"), where(field, "==", profileId), where("status", "==", "confirmed"),
        orderBy("updatedAt", "desc"), limit(50)),
      (snap) => setConfirmed(snap.docs.map((d) => ({ id: d.id, ...(d.data() as BookingRequestDoc) }))),
      () => setConfirmed([]));
  }, [field, profileId]);

  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "bookings"), where(field, "==", profileId),
        where("status", "in", [...BOOKING_TERMINAL_STATUSES]),
        orderBy("updatedAt", "desc"), limit(20)),
      (snap) => setHistory(snap.docs.map((d) => ({ id: d.id, ...(d.data() as BookingRequestDoc) }))),
      () => setHistory([]));
  }, [field, profileId]);

  const openThread = (bookingId: string) => router.push({ pathname: "/booking/[bookingId]", params: { bookingId } });

  return (
    <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }}>
      <Text variant="heading">Bookings</Text>
      <View style={{ gap: tokens.space.sm }}>
        <Text variant="title">Open threads{open.length > 0 ? ` (${open.length})` : ""}</Text>
        {open.length === 0
          ? <Text muted>No open booking requests.</Text>
          : open.map((row) => <OpenThreadRow key={row.id} row={row} mySide={role} onPress={() => openThread(row.id)} />)}
      </View>
      <View style={{ gap: tokens.space.sm }}>
        <Text variant="title">Upcoming confirmed{confirmed.length > 0 ? ` (${confirmed.length})` : ""}</Text>
        {confirmed.length === 0
          ? <Text muted>Nothing confirmed yet.</Text>
          : confirmed.map((row) => <ConfirmedRow key={row.id} row={row} onPress={() => openThread(row.id)} />)}
      </View>
      <View style={{ gap: tokens.space.sm }}>
        <Text variant="title">History</Text>
        {history.length === 0
          ? <Text muted>No past bookings yet.</Text>
          : history.map((row) => <HistoryRow key={row.id} row={row} onPress={() => openThread(row.id)} />)}
      </View>
    </ScrollView>
  );
}

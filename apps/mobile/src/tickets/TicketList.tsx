import { useEffect, useRef, useState } from "react";
import { View, Pressable, ScrollView, Image } from "react-native";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import type { EventDoc, TicketDoc, TicketTransferDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { gigLocationLabel } from "../bookings/BookingForms";
import { useNow } from "../bookings/BookingThread";
import {
  formatEventFullDate, formatEventTimeRange, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, usePosterUrl,
} from "../events/eventDisplay";
import { TicketDetail } from "./TicketDetail";
import { TransferSheet } from "./TransferSheet";
import {
  Text, Button, Card, StatusBadge, ErrorBanner, SkeletonCard, PhotoPlaceholder, IconTicket, IconArrowsLeftRight,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Sub-project 6 task 11: the fan "Tickets" tab. RN twin of
// apps/web/app/tickets/TicketsClient.tsx, restructured for a mobile list +
// detail split (web keeps the QR inline on the card; mobile pushes it into
// TicketDetail.tsx's near-full-screen sheet instead, the brief's own
// anatomy: "ticket cards open TicketDetail with ... QR").
//
// TWO live sources, same shapes as the web twin:
//  1. users/{uid}/tickets: a live onSnapshot (rules: owner-only read).
//  2. Each distinct eventId a ticket names: a ONE-SHOT getDoc per id, kept
//     in a client-side cache. A permission-denied read here means the event
//     was CANCELLED after this ticket was minted (createTicketOrder only
//     ever sells against a "published" event): rendered from the ticket's
//     own local fields instead (CancelledTicketCard below), never letting
//     one failed event read take down the whole list.
//
// Exported (useMyTickets, useEventCache, TicketRow, EventLoad): (fan)/index.tsx
// reuses these same two hooks to derive its own "upcoming shows" list from
// the identical ticket data, rather than standing up a second, driftable
// copy of this fetch-and-cache logic.

export type TicketRow = { id: string } & TicketDoc;
export type EventLoad = { kind: "ok"; event: EventDoc } | { kind: "unavailable" };

export function useMyTickets(uid: string | null): TicketRow[] | "loading" {
  const [rows, setRows] = useState<TicketRow[] | "loading">("loading");
  useEffect(() => {
    if (!uid) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `users/${uid}/tickets`), orderBy("createdAt", "desc")),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketDoc) }))),
      () => setRows([]),
    );
  }, [uid]);
  return rows;
}

// One-shot fetch-and-cache for every distinct eventId a ticket names. Grows
// monotonically (a fan's own ticket list is bounded, never large enough for
// this to matter). `requested` is a ref, not state, for the exact reason the
// web twin's own header comment gives: this effect's own dependency is the
// joined id list, and reading a STATE `requested` from inside it to compute
// "missing" would need `requested` in the dependency array too, which would
// re-run the effect (and briefly re-request every id) on every one of this
// same effect's own updates to it. A ref sidesteps that without disabling
// the exhaustive-deps check: it tracks "already asked for" entirely outside
// React's render cycle, and mutating `.current` never itself triggers a
// re-render.
export function useEventCache(eventIds: string[]): Record<string, EventLoad> {
  const [cache, setCache] = useState<Record<string, EventLoad>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const missing = eventIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
    const { db } = getFirebase();
    void Promise.all(missing.map(async (eventId) => {
      try {
        const snap = await getDoc(doc(db, "events", eventId));
        return [eventId, snap.exists() ? { kind: "ok" as const, event: snap.data() as EventDoc } : { kind: "unavailable" as const }] as const;
      } catch (e) {
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.warn("useEventCache: event load failed", eventId, e);
        return [eventId, { kind: "unavailable" as const }] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setCache((prev) => {
        const next = { ...prev };
        for (const [id, load] of entries) next[id] = load;
        return next;
      });
    });
    return () => { cancelled = true; };
    // Deliberately keyed on the JOINED id list below, not the `eventIds`
    // array reference itself: the caller (TicketList/Home) recomputes that
    // array's identity on every render even when its contents are
    // unchanged, and depending on the reference directly would re-run this
    // effect (and re-evaluate the `requested` guard above) on every one of
    // those renders instead of only when the actual id set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventIds.join(",")]);
  return cache;
}

// ---------- Incoming transfer offers ----------

type TransferRow = { id: string } & TicketTransferDoc;

// List-query provability (tests-rules/events.rules.test.ts's own "toUid
// disjunct is provable query-wide" case): pinning `toUid == request.auth.uid`
// is the ONLY provable filter on this collection from the recipient's side.
// status/expiresAt are filtered client-side below rather than added as a
// second `where` clause, which would need a composite index this task's
// file list has no room to add.
function useIncomingTransfers(uid: string | null): TransferRow[] {
  const [rows, setRows] = useState<TransferRow[]>([]);
  useEffect(() => {
    if (!uid) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "transfers"), where("toUid", "==", uid)),
      (snap) => {
        const now = Date.now();
        const offered = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as TicketTransferDoc) }))
          .filter((t) => t.status === "offered" && t.expiresAt > now)
          .sort((a, b) => b.createdAt - a.createdAt);
        setRows(offered);
      },
      () => setRows([]),
    );
  }, [uid]);
  return rows;
}

// Row-level, permission-tolerant event title lookup: a transfer doc carries
// neither a tier name nor the event's title (TicketTransferDoc's own shape),
// and firestore.rules denies the recipient any read of the sender's own
// ticket doc, so this is the only data this card can show beyond what the
// notification already told the fan.
function useTransferEventInfo(eventId: string): { title: string; startsAt: number } | null {
  const [info, setInfo] = useState<{ title: string; startsAt: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "events", eventId))
      .then((s) => {
        if (cancelled || !s.exists()) return;
        const e = s.data() as EventDoc;
        setInfo({ title: e.title, startsAt: e.startsAt });
      })
      .catch((e) => console.warn("incoming transfer: event load failed", eventId, e));
    return () => { cancelled = true; };
  }, [eventId]);
  return info;
}

function IncomingTransferCard({ transfer }: { transfer: TransferRow }) {
  const t = useTokens();
  const info = useTransferEventInfo(transfer.eventId);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (accept: boolean) => {
    setBusy(accept ? "accept" : "decline");
    setError(null);
    try {
      await httpsCallable(getFirebase().functions, "respondToTransfer")({ transferId: transfer.id, accept });
      // The onSnapshot above drops this row itself once its status flips
      // away from "offered", so there's nothing left to set on success.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not respond to this offer.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ gap: tokens.space.sm, borderColor: t.accent }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <IconArrowsLeftRight size={20} color={t.accent} />
        <View style={{ flex: 1 }}>
          <Text variant="label">You&apos;ve been offered a ticket</Text>
          <Text variant="meta" muted>
            {info ? `${info.title} · ${formatEventFullDate(info.startsAt)}` : "Loading the event details…"}
          </Text>
        </View>
      </View>
      {error && <ErrorBanner message={error} />}
      <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Button title={busy === "accept" ? "Accepting…" : "Accept"} onPress={() => void respond(true)} disabled={busy !== null} />
        <Button title={busy === "decline" ? "Declining…" : "Decline"} variant="secondary" onPress={() => void respond(false)} disabled={busy !== null} />
      </View>
    </Card>
  );
}

// ---------- Ticket rows ----------

// A ticket whose event could not be read (controller ruling 6, mirrored
// from the web twin's CancelledTicketCard): rendered from the ticket doc's
// own fields only. Every path that lands a ticket here already flipped its
// status to "refunded" (refundOrderForCancelledEvent), so that's the one
// state this card needs to explain.
function CancelledTicketCard({ ticket }: { ticket: TicketRow }) {
  return (
    <Card style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: tokens.space.sm }}>
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>{ticket.tierName}</Text>
          <Text variant="meta" muted>This event was cancelled.</Text>
        </View>
        <StatusBadge label="Cancelled" status="destructive" />
      </View>
      {ticket.status === "refunded" && (
        <Text variant="meta" muted>
          This event was cancelled. Any payment was refunded to the original purchaser.
        </Text>
      )}
    </Card>
  );
}

function TicketRowCard({ ticket, event, onPress }: { ticket: TicketRow; event: EventDoc; onPress: () => void }) {
  const t = useTokens();
  const posterUrl = usePosterUrl(event.posterPath);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${event.title}, ${ticket.tierName}`}>
      <Card style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <View style={{ width: 56, height: 56, borderRadius: tokens.radius.sm, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <PhotoPlaceholder icon={<IconTicket size={18} color={t.muted} />} />
          )}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
            <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>{event.title}</Text>
            <StatusBadge label={TICKET_STATUS_LABEL[ticket.status]} status={TICKET_STATUS_TONE[ticket.status]} />
          </View>
          <Text variant="meta" muted numberOfLines={1}>
            {formatEventFullDate(event.startsAt)} · {formatEventTimeRange(event.startsAt, event.endsAt)}
          </Text>
          <Text variant="meta" muted numberOfLines={1}>{gigLocationLabel(event.location)}</Text>
          <Text variant="meta">{ticket.tierName}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

function TicketSection({ title, rows, eventCache, onPress }: {
  title: string; rows: TicketRow[]; eventCache: Record<string, EventLoad>; onPress: (ticket: TicketRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text variant="title">{title}</Text>
      <View style={{ gap: tokens.space.sm }}>
        {rows.map((t) => {
          const load = eventCache[t.eventId];
          if (!load) return <SkeletonCard key={t.id} />;
          return load.kind === "ok"
            ? <TicketRowCard key={t.id} ticket={t} event={load.event} onPress={() => onPress(t)} />
            : <CancelledTicketCard key={t.id} ticket={t} />;
        })}
      </View>
    </View>
  );
}

function TicketListSkeleton() {
  return (
    <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.sm }}>
      <SkeletonCard /><SkeletonCard />
    </ScrollView>
  );
}

function EmptyTickets() {
  const t = useTokens();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.lg }}>
      <IconTicket size={40} color={t.muted} />
      <View style={{ alignItems: "center", gap: tokens.space.sm }}>
        <Text variant="title">No tickets yet</Text>
        <Text muted style={{ textAlign: "center" }}>
          Tickets you buy for events show up here, ready to scan at the door.
        </Text>
      </View>
    </View>
  );
}

export function TicketList({ uid }: { uid: string }) {
  const rows = useMyTickets(uid);
  const eventIds = rows === "loading" ? [] : [...new Set(rows.map((t) => t.eventId))];
  const eventCache = useEventCache(eventIds);
  const incoming = useIncomingTransfers(uid);
  const now = useNow();

  const [detailTicket, setDetailTicket] = useState<TicketRow | null>(null);
  const [transferTicket, setTransferTicket] = useState<TicketRow | null>(null);

  if (rows === "loading" || now == null) return <TicketListSkeleton />;
  if (rows.length === 0 && incoming.length === 0) return <EmptyTickets />;

  const upcoming: TicketRow[] = []; const past: TicketRow[] = []; const unavailable: TicketRow[] = [];
  for (const t of rows) {
    const load = eventCache[t.eventId];
    if (!load) continue; // still resolving; TicketSection renders its own per-row skeleton meanwhile
    if (load.kind === "unavailable") { unavailable.push(t); continue; }
    (load.event.startsAt > now ? upcoming : past).push(t);
  }
  const pending = rows.filter((t) => !eventCache[t.eventId]);
  const detailEvent = detailTicket ? eventCache[detailTicket.eventId] : null;

  return (
    <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }}>
      {incoming.length > 0 && (
        <View style={{ gap: tokens.space.sm }}>
          <Text variant="title">Incoming offers</Text>
          {incoming.map((tr) => <IncomingTransferCard key={tr.id} transfer={tr} />)}
        </View>
      )}
      {pending.length > 0 && (
        <View style={{ gap: tokens.space.sm }}>{pending.map((t) => <SkeletonCard key={t.id} />)}</View>
      )}
      <TicketSection title="Upcoming" rows={upcoming} eventCache={eventCache} onPress={setDetailTicket} />
      <TicketSection title="Past" rows={past} eventCache={eventCache} onPress={setDetailTicket} />
      <TicketSection title="Cancelled" rows={unavailable} eventCache={eventCache} onPress={setDetailTicket} />

      {detailTicket && detailEvent?.kind === "ok" && (
        <TicketDetail
          uid={uid} ticket={detailTicket} event={detailEvent.event} now={now}
          onClose={() => setDetailTicket(null)}
          onTransferPress={() => { setTransferTicket(detailTicket); setDetailTicket(null); }}
        />
      )}
      {transferTicket && (
        <TransferSheet
          ticketId={transferTicket.id} ticketLabel={transferTicket.tierName}
          onClose={() => setTransferTicket(null)}
        />
      )}
    </ScrollView>
  );
}

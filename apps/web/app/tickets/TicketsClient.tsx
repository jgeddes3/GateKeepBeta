"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { collection, doc, getDoc, onSnapshot, orderBy, query } from "firebase/firestore";
import type { EventDoc, TicketDoc } from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { gigLocationLabel } from "../u/[handle]/gigDisplay";
import {
  formatEventFullDate, formatEventTimeRange, TICKET_STATUS_LABEL, TICKET_STATUS_BADGE,
} from "../../src/events/eventDisplay";
import { useTicketHolderAddress, mapUrl } from "../../src/events/ticketHolderAddress";
import { usePosterUrl } from "../../src/events/posterUrl";
import { useNow } from "../../src/bookings/BookingThread";
import { TicketQr } from "./TicketQr";
import { Badge } from "../../src/ui/badge";
import { Skeleton } from "../../src/ui/skeleton";
import { PhotoPlaceholder } from "../../src/components/GigCard";
import { IconMapPin, IconTicket } from "../../src/ui/icons";

// Sub-project 6 task 10: the fan "Your tickets" page. Signed-in only
// (app/tickets/page.tsx gates it, same shape as Dashboard/EarningsPage);
// this component owns the actual data.
//
// TWO live sources, deliberately different shapes:
//  1. users/{uid}/tickets: a live onSnapshot (rules: owner-only read, Task
//     5's completeOrderTx and Task 6/8's refund/transfer paths all write
//     here), so a ticket minted or refunded while this page is open shows
//     up without a reload.
//  2. Each distinct eventId a ticket names: a ONE-SHOT getDoc per id, kept
//     in a client-side cache. Not a second live subscription per event: the
//     interesting live state (the ticket's own status) already comes from
//     source 1 above, and firestore.rules' events/{eventId} read rule is
//     status-gated (published/completed public, draft/cancelled
//     curator-only, see firestore.rules), so a fetch that fails
//     permission-denied here means the event was CANCELLED after this
//     ticket was minted (createTicketOrder only ever sells against a
//     "published" event): a legitimate, expected state (controller ruling
//     6), not a bug: rendered from the ticket's own local fields instead
//     (see CancelledTicketCard below), never let one failed event read take
//     down the whole page.

type TicketRow = { id: string } & TicketDoc;
type EventLoad = { kind: "ok"; event: EventDoc } | { kind: "unavailable" };

function useMyTickets(uid: string): TicketRow[] | "loading" {
  const [rows, setRows] = useState<TicketRow[] | "loading">("loading");
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `users/${uid}/tickets`), orderBy("createdAt", "desc")),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketDoc) }))),
    );
  }, [uid]);
  return rows;
}

// One-shot fetch-and-cache for every distinct eventId named by the ticket
// list above. Grows monotonically (never evicts): a fan's own ticket list
// is bounded by how many events they've ever bought into, never large
// enough for this cache to matter.
//
// `requested` is a ref, not the `cache` state itself, deliberately: this
// effect's own dependency is the joined id list, and reading `cache` (state)
// from inside it to compute "missing" would need `cache` in the dependency
// array too, which would re-run the effect (and, briefly, re-request every
// id all over again) every time this very effect's own setCache call below
// updates it. A ref sidesteps that without disabling the exhaustive-deps
// check: it tracks "already asked for", entirely outside React's render
// cycle, and is never itself a reason to re-run anything.
function useEventCache(eventIds: string[]): Record<string, EventLoad> {
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
        // permission-denied: a cancelled (or, defensively, still-draft)
        // event: the expected shape ruling 6 describes. Anything else is
        // still swallowed into the same "unavailable" card rather than
        // breaking the page, but logged so a real outage isn't silent.
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
  }, [eventIds.join(",")]);
  return cache;
}

function TicketCardShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-gk border border-gk-border bg-gk-surface p-4 sm:p-5">{children}</div>
  );
}

// A ticket whose event could not be read (controller ruling 6): rendered
// from the ticket doc's OWN fields only. Every path that lands a ticket
// here already flipped its status to "refunded" (refundOrderForCancelledEvent,
// Task 6), so that's the one state this card needs to explain, not a
// generic error.
function CancelledTicketCard({ ticket }: { ticket: TicketRow }) {
  return (
    <TicketCardShell>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-syne text-base font-semibold text-gk-text">{ticket.tierName}</p>
          <p className="mt-0.5 font-sora text-sm text-gk-muted">This event was cancelled.</p>
        </div>
        <Badge variant="destructive">Cancelled</Badge>
      </div>
      {ticket.status === "refunded" && (
        <p className="mt-2 font-sora text-sm text-gk-muted">You were refunded in full.</p>
      )}
    </TicketCardShell>
  );
}

function TicketCard({ uid, ticket, event }: { uid: string; ticket: TicketRow; event: EventDoc }) {
  const posterUrl = usePosterUrl(event.posterPath);
  const address = useTicketHolderAddress(ticket.eventId, uid);
  // A live entry credential only while it's still "valid"/"checked_in": a
  // refunded or transferred-away ticket is no longer this holder's to
  // present at the door (checkInTicket's own gate), so neither the QR nor
  // the mobile-transfer hint (nothing left here to transfer) has anything
  // left to do.
  const isLive = ticket.status === "valid" || ticket.status === "checked_in";

  return (
    <TicketCardShell>
      <div className="flex gap-3.5">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-gk-sm border border-gk-border bg-gk-surface">
          {posterUrl ? (
            <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <PhotoPlaceholder icon={<IconTicket size={20} aria-hidden="true" />} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/e/${ticket.eventId}`}
              className="truncate font-syne text-base font-semibold text-gk-text hover:text-gk-focus"
            >
              {event.title}
            </Link>
            <Badge variant={TICKET_STATUS_BADGE[ticket.status]}>{TICKET_STATUS_LABEL[ticket.status]}</Badge>
          </div>
          <p className="mt-0.5 truncate font-sora text-sm text-gk-muted">
            {formatEventFullDate(event.startsAt)} · {formatEventTimeRange(event.startsAt, event.endsAt)}
          </p>
          <p className="mt-0.5 truncate font-sora text-sm text-gk-muted">{gigLocationLabel(event.location)}</p>
          <p className="mt-1.5 font-sora text-sm text-gk-text">{ticket.tierName}</p>
        </div>
      </div>

      {address !== "hidden" && (
        <div className="mt-3 border-t border-gk-border pt-3">
          <p className="flex items-start gap-2 font-sora text-sm text-gk-text">
            <IconMapPin size={16} className="mt-0.5 shrink-0 text-gk-muted" aria-hidden="true" />
            <span>
              {address.address}{" "}
              <a
                href={mapUrl(address)} target="_blank" rel="noopener noreferrer"
                className="text-gk-muted underline underline-offset-4 outline-none hover:text-gk-focus focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                Map
              </a>
            </span>
          </p>
        </div>
      )}

      {isLive && (
        <div className="mt-4 flex flex-col items-start gap-3 border-t border-gk-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <TicketQr ticketId={ticket.id} eventId={ticket.eventId} qrSecret={ticket.qrSecret} size={160} />
          {/* Controller ruling 1 (binding): web transfers are MOBILE-ONLY in
              v1. No offerTransfer/respondToTransfer call from web anywhere
              in this app; this hint is the entire web-side transfer
              surface. */}
          <p className="font-sora text-xs text-gk-muted sm:max-w-40">
            To send this ticket to someone else, manage transfers in the GateKeep app.
          </p>
        </div>
      )}
    </TicketCardShell>
  );
}

function TicketListSkeleton() {
  return (
    <div className="grid gap-3" role="status" aria-label="Loading your tickets">
      {[0, 1].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
    </div>
  );
}

function EmptyTickets() {
  return (
    <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
        <IconTicket size={20} aria-hidden="true" />
      </span>
      <p className="mt-3 font-syne text-base font-semibold text-gk-text">No tickets yet</p>
      <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
        Tickets you buy for events show up here, ready to scan at the door.
      </p>
      <Link href="/gigs" className="mt-3 inline-block font-sora text-sm text-gk-text underline underline-offset-4 hover:text-gk-focus">
        Browse what&apos;s playing
      </Link>
    </div>
  );
}

function TicketSection({ title, rows, uid, eventCache }: {
  title: string; rows: TicketRow[]; uid: string; eventCache: Record<string, EventLoad>;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">{title}</h2>
      <div className="grid gap-3">
        {rows.map((t) => {
          const load = eventCache[t.eventId];
          if (!load) return <Skeleton key={t.id} className="h-32 w-full" />;
          return load.kind === "ok"
            ? <TicketCard key={t.id} uid={uid} ticket={t} event={load.event} />
            : <CancelledTicketCard key={t.id} ticket={t} />;
        })}
      </div>
    </section>
  );
}

export function TicketsClient({ uid }: { uid: string }) {
  const rows = useMyTickets(uid);
  const eventIds = rows === "loading" ? [] : [...new Set(rows.map((t) => t.eventId))];
  const eventCache = useEventCache(eventIds);
  // Render-safe "now" (BookingThread.tsx's own useNow, reused here exactly
  // as CancelDialog.tsx already reuses it cross-feature): the React
  // Compiler's purity rule forbids a bare Date.now() call inside a
  // component's render body, and the upcoming/past split below needs one.
  // Starts null on the very first render; the loading branch just below
  // covers that instant too, so the split logic never runs against it.
  const now = useNow();

  if (rows === "loading" || now == null) return <TicketListSkeleton />;
  if (rows.length === 0) return <EmptyTickets />;

  const upcoming: TicketRow[] = []; const past: TicketRow[] = []; const unavailable: TicketRow[] = [];
  for (const t of rows) {
    const load = eventCache[t.eventId];
    if (!load) continue; // still resolving; TicketSection below renders its own per-row skeleton meanwhile
    if (load.kind === "unavailable") { unavailable.push(t); continue; }
    (load.event.startsAt > now ? upcoming : past).push(t);
  }
  // Rows whose event hasn't resolved yet at all: shown once, in a neutral
  // "loading" pass rather than triple-counted across every section below.
  const pending = rows.filter((t) => !eventCache[t.eventId]);

  return (
    <div className="grid gap-8">
      {pending.length > 0 && (
        <div className="grid gap-3">{pending.map((t) => <Skeleton key={t.id} className="h-32 w-full" />)}</div>
      )}
      <TicketSection title="Upcoming" rows={upcoming} uid={uid} eventCache={eventCache} />
      <TicketSection title="Past" rows={past} uid={uid} eventCache={eventCache} />
      <TicketSection title="Cancelled" rows={unavailable} uid={uid} eventCache={eventCache} />
    </div>
  );
}

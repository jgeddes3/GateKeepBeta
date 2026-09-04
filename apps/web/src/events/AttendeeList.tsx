"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import {
  TICKET_NOT_REFUNDABLE_MESSAGE, TICKET_REFUND_WINDOW_CLOSED_MESSAGE, EVENT_CANCELLED_MESSAGE,
  type AttendeeDoc, type EventStatus,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useNow } from "../bookings/BookingThread";
import { formatGigTime } from "../../app/u/[handle]/gigDisplay";
import { formatEventFullDate, TICKET_STATUS_LABEL, TICKET_STATUS_BADGE } from "./eventDisplay";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { IconSearch, IconUser, IconWarning } from "../ui/icons";

// Sub-project 6 task 10 (brief anatomy: "AttendeeList: live onSnapshot
// table (name, tier, status, checked-in time), search filter client-side,
// per-row grace-refund button (destructive confirm, calls refundTicket)").
//
// Live onSnapshot on events/{eventId}/attendees (firestore.rules: curator-
// side members and admin only, see that file's own comment on why the
// attendee's OWN uid is never a read path here). refundTicket itself is
// the money-critical call (functions/src/ticketing.ts): this component
// never guesses at whether a row is refundable beyond the same two checks
// that callable enforces (ticket status valid/checked_in, event not past
// endsAt/cancelled) purely to hide a button that would only bounce; the
// server remains the sole authority either way.

type AttendeeRow = { id: string } & AttendeeDoc;

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

function AttendeeRowView({ curatorProfileId, eventId, row, refundable, onError }: {
  curatorProfileId: string; eventId: string; row: AttendeeRow;
  // Client-side hint only (see this file's own header comment): true iff
  // the event itself is still within refundTicket's own window, computed
  // once by the parent from eventStatus/eventEndsAt rather than per-row.
  refundable: boolean;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const canRefund = refundable && (row.status === "valid" || row.status === "checked_in");

  const refund = async () => {
    if (!window.confirm(`Refund ${row.ownerName}'s "${row.tierName}" ticket? This can't be undone.`)) return;
    setBusy(true);
    try {
      await callFn("refundTicket", 
        { curatorProfileId, eventId, ticketId: row.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not refund this ticket.";
      // Recognized by name (a reviewer can see at a glance these are the
      // exact server strings the door/grace-refund flow can throw), same
      // "verbatim server error in a friendly wrapper" convention as every
      // other composer in this app (GatePrompt.tsx's own precedent): none
      // of the three needs a DIFFERENT UI here beyond the shared error
      // banner every other rejection already gets, since each is already
      // self-explanatory copy with no useful interactive follow-up from a
      // door-list row.
      if (message !== TICKET_REFUND_WINDOW_CLOSED_MESSAGE && message !== TICKET_NOT_REFUNDABLE_MESSAGE
          && message !== EVENT_CANCELLED_MESSAGE) {
        console.error("refundTicket failed", eventId, row.id, e);
      }
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-gk border border-gk-border bg-gk-surface px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-syne text-sm font-semibold text-gk-text">{row.ownerName}</p>
          <Badge variant={TICKET_STATUS_BADGE[row.status]}>{TICKET_STATUS_LABEL[row.status]}</Badge>
        </div>
        <p className="mt-0.5 font-sora text-sm text-gk-muted">
          {row.tierName}
          {checkedInLabel(row.checkedInAt) && ` · Checked in ${checkedInLabel(row.checkedInAt)}`}
        </p>
      </div>
      {canRefund && (
        <Button type="button" variant="destructive" size="sm" onClick={refund} disabled={busy} className="shrink-0">
          {busy ? "Refunding…" : "Refund"}
        </Button>
      )}
    </li>
  );
}

function AttendeeListSkeleton() {
  return (
    <div className="grid gap-2" role="status" aria-label="Loading attendees">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
    </div>
  );
}

export function AttendeeList({ curatorProfileId, eventId, eventStatus, eventEndsAt }: {
  curatorProfileId: string; eventId: string; eventStatus: EventStatus; eventEndsAt: number;
}) {
  const rows = useAttendees(eventId);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Same window refundTicket itself enforces (functions/src/ticketing.ts):
  // not cancelled, and not yet past the event's own endsAt. `now` is
  // BookingThread.tsx's own useNow (reused cross-feature exactly as
  // CancelDialog.tsx already does): the React Compiler's purity rule
  // forbids a bare Date.now() call in a render body, and while it's still
  // null (the very first render) this simply shows every row as
  // not-yet-refundable for one tick, matching every other consumer of this
  // hook's own accepted "flashes once" cost. This only decides whether to
  // SHOW the refund button at all; a curator who leaves this tab open
  // exactly through the event's end time gets, at worst, one stale-enabled
  // button that the server still correctly refuses.
  const now = useNow();
  const refundable = now != null && eventStatus !== "cancelled" && now < eventEndsAt;

  if (rows === "loading") return <AttendeeListSkeleton />;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.ownerName.toLowerCase().includes(q) || r.tierName.toLowerCase().includes(q))
    : rows;

  return (
    <div className="grid gap-3">
      <div className="relative">
        <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
        <Input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search attendees" aria-label="Search attendees" className="pl-9"
        />
      </div>
      {!refundable && rows.length > 0 && (
        <p className="font-sora text-xs text-gk-muted">
          {eventStatus === "cancelled" ? "This event is cancelled; every ticket was already refunded." : "Refunds are closed now that this event has ended."}
        </p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-8 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconUser size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No attendees yet</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Everyone who buys or RSVPs a ticket shows up here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="font-sora text-sm text-gk-muted">No attendees match &quot;{search}&quot;.</p>
      ) : (
        <ul className="grid gap-2">
          {filtered.map((row) => (
            <AttendeeRowView
              key={row.id} curatorProfileId={curatorProfileId} eventId={eventId} row={row}
              refundable={refundable} onError={setError}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

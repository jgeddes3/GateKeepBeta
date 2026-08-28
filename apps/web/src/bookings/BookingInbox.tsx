"use client";
import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime, badge } from "../gigs/GigForms";
import {
  DEPOSIT_PERCENT,
  type BookingRequestDoc, type BookingSide, type BookingStatus, type GigDoc,
} from "@gatekeep/shared";

// SP4 Task 10: per-profile booking inbox + the booking-status DISPLAY
// helpers it (and BookingThread.tsx's thread screen) both need. Split out
// of BookingForms.tsx (Task 10 review) — BookingForms.tsx stays field-groups
// + pure formatters only (its Task 9 scope); this file owns everything about
// LISTING/describing bookings, mirroring the plan's Task 12 mobile-parity
// file list, which names BookingInbox as its own peer of BookingThread/
// OfferForm/CancelDialog.

export const BOOKING_TERMINAL_STATUSES: readonly BookingStatus[] = [
  "completed", "declined", "withdrawn", "superseded", "expired", "cancelled_by_curator", "cancelled_by_musician",
];

// Task 8 review carry-forward, honored here too (and again on the thread
// screen): an `expired` booking that WAS a confirmed run (acceptedTerms/
// confirmedAt set — accepted, then later unwound by a moderation cascade or
// the sweep's zombie-run resolver) must read as "this booking ended", not
// like an ordinary declined/expired APPLICATION that never got anywhere.
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

// The deposit honesty line's "$X known" variant — used everywhere a REAL,
// already-computed deposit amount exists (a confirmed booking's own
// `deposit.amountCents`, frozen by acceptBooking). Distinct from
// BookingForms.tsx's DEPOSIT_HONESTY_LINE, which is the pre-acceptance
// "implied, not yet known" phrasing for the apply/offer composers — Task
// 10's brief calls for this exact "$X" wording once a real number exists.
// SP5 Task 15 review round 1 (medium #6): same live-payments fix as
// DEPOSIT_HONESTY_LINE — dropped "will be collected when payments launch"
// (false as of this sub-project) for present-tense, DEPOSIT_PERCENT-derived
// copy. Both call sites (this row, BookingThread's Confirmed section) only
// ever render for an already-confirmed booking, so "charged... at accept"
// describes something that has, in fact, already happened.
export function depositLine(amountCents: number): string {
  return `${DEPOSIT_PERCENT}% deposit (${formatCents(amountCents)}) charged to the curator's card at accept.`;
}

type BookingRow = BookingRequestDoc & { id: string };

// Row-level, permission-tolerant gig title lookup — a direct gigs/{id} GET
// is evaluated per-document against that document's OWN data (unlike a list
// query, no rules-provability constraint applies — see useNextOccurrence's
// comment below for why THAT one needs an extra filter), but a booking's
// initiating gig can still leave every publicly-readable disjunct once its
// status moves past open/filled/closed-booked while the VIEWER is on the
// musician side (the curator side always keeps isMember(curatorProfileId) —
// it's their own gig). A permission-denied read here is an expected, common
// case for stale history/declined rows, not a bug — falls back to a generic
// label rather than surfacing an error for a background row-level fetch.
// n+1 by design (one getDoc per visible row) — acceptable at inbox scale
// (open threads are bounded by MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE=25
// for this profile's own initiated ones, though an inbox can also show
// bookings the OTHER side initiated; history is capped at 20; see the task
// brief's explicit sanction of n+1 for exactly this shape of lookup).
function useRowGigTitle(gigId: string): string {
  const [title, setTitle] = useState<string>("This gig");
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "gigs", gigId))
      .then((s) => { if (!cancelled && s.exists()) setTitle((s.data() as GigDoc).title || "Untitled gig"); })
      .catch(() => { /* permission-denied or offline — keep the generic fallback */ });
    return () => { cancelled = true; };
  }, [gigId]);
  return title;
}

// Confirmed-booking "next date" — bookings carry no date of their own (see
// BookingRequestDoc), so the next occurrence is its own per-booking fetch
// (n+1, acceptable at inbox scale — see the task brief). Filters
// status=="filled" IN ADDITION to bookingId (not bookingId alone): a bare
// `where(bookingId==X)` list query has no disjunct of firestore.rules' gigs
// read rule provable from the query's own filters (status is unconstrained,
// and neither curatorProfileId nor musicianProfileId is even referenced by
// this query) — Firestore denies a rules-unprovable LIST query outright, at
// the query level, not per document (see firestore.rules' own extensive
// commentary on this exact "list-provability" requirement). Pinning
// status=="filled" makes the query provable via that disjunct alone — it's
// unconditionally public (see firestore.rules), so ANY caller (not just a
// member) can run it — and reuses the existing (bookingId,status,startsAt)
// composite index (Task 8) rather than requiring a new one. Every
// currently-linked-and-filled occurrence — past or future — matches (past
// FILLED gigs deliberately stay "filled" forever, per Task 8's review), so
// this also happens to be exactly the query the thread screen's own
// occurrence list (BookingThread.tsx) reuses.
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

function OpenThreadRow({ row, mySide }: { row: BookingRow; mySide: BookingSide }) {
  const title = useRowGigTitle(row.gigId);
  const yourTurn = row.awaitingSide === mySide;
  return (
    <li>
      <a href={`/dashboard/bookings/${row.id}`}>{title}</a>
      {yourTurn && <span style={{ ...badge("#fef3c7", "#92400e"), marginLeft: 8 }}>your turn</span>}
      <span style={{ color: "#666", fontSize: 13, marginLeft: 8 }}>
        {row.thread.length} offer{row.thread.length === 1 ? "" : "s"} so far
      </span>
    </li>
  );
}

function ConfirmedRow({ row }: { row: BookingRow }) {
  const title = useRowGigTitle(row.gigId);
  const next = useNextOccurrence(row.id);
  return (
    <li>
      <a href={`/dashboard/bookings/${row.id}`}>{title}</a>
      {next && <span style={{ color: "#666", fontSize: 13, marginLeft: 8 }}>{formatGigDateTime(next.startsAt)}</span>}
      {/* deposit is already frozen (computeDepositCents ran inside
          acceptBooking's transaction) — no need to recompute it here, only
          to display the number it already produced. */}
      {row.deposit && <p style={{ margin: "2px 0 0", fontSize: 13, color: "#666" }}>{depositLine(row.deposit.amountCents)}</p>}
    </li>
  );
}

function HistoryRow({ row }: { row: BookingRow }) {
  const title = useRowGigTitle(row.gigId);
  return (
    <li>
      <a href={`/dashboard/bookings/${row.id}`}>{title}</a>
      <span style={{ color: "#666", fontSize: 13, marginLeft: 8 }}>{bookingHistoryLabel(row)}</span>
    </li>
  );
}

// Per-profile booking inbox — mounted by both dashboard pages
// (dashboard/portfolio/[profileId] for the musician side,
// dashboard/curator/[profileId] for the curator side), `role` picking which
// IMMUTABLE side-field this profile is queried against. Three lists, each
// its own onSnapshot on the SAME (profileId,status,updatedAt) composite
// index (already shipped — Task 2), just a different status filter/cap:
// open threads, upcoming confirmed, history (terminal statuses + completed,
// newest first, capped at 20 per the task brief — open/confirmed get their
// own generous soft cap so an unusually busy profile's inbox stays bounded
// without pagination UI yet). `profileId` is pinned by an equality filter
// on exactly the field firestore.rules' bookings read rule checks via
// isMember() — the same list-provability shape as OfferComposer's own
// curatorProfileId-filtered gigs query.
export function BookingInbox({ profileId, role }: { profileId: string; role: BookingSide }) {
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

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section>
        <h3>Open threads{open.length > 0 ? ` (${open.length})` : ""}</h3>
        {open.length === 0 ? <p style={{ color: "#666" }}>No open booking requests.</p> : (
          <ul>{open.map((row) => <OpenThreadRow key={row.id} row={row} mySide={role} />)}</ul>
        )}
      </section>
      <section>
        <h3>Upcoming confirmed{confirmed.length > 0 ? ` (${confirmed.length})` : ""}</h3>
        {confirmed.length === 0 ? <p style={{ color: "#666" }}>Nothing confirmed yet.</p> : (
          <ul>{confirmed.map((row) => <ConfirmedRow key={row.id} row={row} />)}</ul>
        )}
      </section>
      <section>
        <h3>History</h3>
        {history.length === 0 ? <p style={{ color: "#666" }}>No past bookings yet.</p> : (
          <ul>{history.map((row) => <HistoryRow key={row.id} row={row} />)}</ul>
        )}
      </section>
    </div>
  );
}

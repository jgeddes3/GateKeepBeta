"use client";
import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime, badge } from "../gigs/GigForms";
import {
  validateOfferInput, LAUNCH_TIMEZONE, MAX_OFFER_NOTE_LENGTH, MAX_OFFER_SONG_COUNT,
  type BudgetStructure, type GigPublicLocation, type BookingRequestDoc, type BookingSide, type BookingStatus, type GigDoc,
} from "@gatekeep/shared";

// Sub-project 4's booking-domain equivalent of ../gigs/GigForms.tsx: shared
// "apply / offer" building blocks reused by the gig detail page's Apply
// panel and OfferComposer.tsx (Find musicians -> offerGig). Kept as its own
// module (not added to GigForms.tsx, which is SP3-owned and out of scope for
// this task) even though it mirrors that file's conventions closely —
// dollars in the UI, integer cents on the wire, the exact shared validator
// the callables run, LAUNCH_TIMEZONE-pinned dates via the existing
// formatGigDateTime import wherever a gig time is shown.

// Exact copy required by Task 9's spec for the pre-acceptance surfaces (gig
// detail Apply panel, OfferComposer) — no computed dollar amount exists yet
// at this point (that only exists once a deposit is actually calculated,
// after acceptBooking runs), so this is the "implied, not yet known" phrasing
// rather than Task 10's "$X" variant.
export const DEPOSIT_HONESTY_LINE =
  "If accepted, a 35% deposit will be collected from the curator when payments launch.";

export interface OfferState { amount: string; quantity: string; note: string; }
export const emptyOffer = (): OfferState => ({ amount: "", quantity: "", note: "" });

export interface OfferPayload { amountCents: number; expectedQuantity: number | null; note: string | null; }

// Converts the dollar-string UI state into the integer-cents callable
// payload and runs the SAME validator applyToGig/offerGig/counterBooking run
// server-side (validateOfferInput) — a malformed offer is caught here, with
// the identical error copy the server would otherwise return, before it
// ever reaches the network.
export function buildOfferPayload(
  structure: BudgetStructure, state: OfferState,
): { payload: OfferPayload | null; error: string | null } {
  const amountDollars = Number(state.amount);
  if (state.amount.trim() === "" || !Number.isFinite(amountDollars)) {
    return { payload: null, error: "Enter an amount." };
  }
  const amountCents = Math.round(amountDollars * 100);
  let expectedQuantity: number | null = null;
  if (structure === "perSong") {
    const q = Number(state.quantity);
    if (state.quantity.trim() === "" || !Number.isFinite(q)) {
      return { payload: null, error: "Enter a song count." };
    }
    // Raw, not Math.trunc'd — a fractional entry (e.g. "3.5") is passed
    // through as-is so validateOfferInput's own `!Number.isInteger(...)`
    // check catches it and returns its real "must be a whole number" copy,
    // rather than silently rounding it down to a value the musician never
    // actually typed.
    expectedQuantity = q;
  }
  const note = state.note.trim() === "" ? null : state.note.trim();
  const err = validateOfferInput(structure, { amountCents, expectedQuantity, note });
  if (err) return { payload: null, error: err };
  return { payload: { amountCents, expectedQuantity, note }, error: null };
}

// Amount + (perSong only) song count + note-with-counter — the exact input
// set functions/src/bookings.ts's finalizeBookingRequest/counterBooking
// accept, gated on the SAME structure-driven branch validateOfferInput uses
// server-side (perHour is server-derived from the gig's duration; perSet
// never takes a quantity).
export function OfferFields({ structure, value, onChange, disabled }: {
  structure: BudgetStructure; value: OfferState; onChange: (v: OfferState) => void; disabled?: boolean;
}) {
  const unitLabel = structure === "perHour" ? "per hour" : structure === "perSong" ? "per song" : "flat, per set";
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label>Your offer ({unitLabel}): $
        <input type="number" min={0} step="0.01" style={{ width: 100, marginLeft: 4 }} disabled={disabled}
          value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
      </label>
      {structure === "perSong" && (
        <label>Song count:{" "}
          <input type="number" min={1} max={MAX_OFFER_SONG_COUNT} step={1} style={{ width: 90 }} disabled={disabled}
            value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} />
        </label>
      )}
      <div>
        <textarea rows={3} maxLength={MAX_OFFER_NOTE_LENGTH} placeholder="Note (optional)" aria-label="Note (optional)" disabled={disabled}
          style={{ width: "100%" }} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
        <p style={{ margin: "2px 0 0", fontSize: 12, color: "#666" }}>{value.note.length}/{MAX_OFFER_NOTE_LENGTH}</p>
      </div>
    </div>
  );
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

// Offset (in ms) between UTC and `timeZone`'s wall clock AT a given UTC
// instant, i.e. `wallClockAsUtcNumbers - utcMs`. Derived per-instant (not a
// constant) so it's correct on both sides of a DST transition — the whole
// reason this needs Intl instead of a fixed "-5h"/"-4h" literal.
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

// GigBrowse's date-filter boundary computation: every gig time on this app
// is displayed in LAUNCH_TIMEZONE (formatGigDateTime), so a "From"/"To" day
// picked in the filter UI must be bucketed by LAUNCH_TIMEZONE midnight, not
// UTC midnight — an evening gig near the boundary would otherwise mis-bucket
// by the zone's offset (4-5h for LAUNCH_TIMEZONE = America/New_York).
// Standard two-step technique: treat the input Y-M-D as a UTC guess, read
// LAUNCH_TIMEZONE's offset AT that guess (so DST is derived per-date, never
// a hardcoded constant), then shift the guess by that offset to land on the
// actual UTC instant of LAUNCH_TIMEZONE midnight for that calendar date.
// Round-trip-validated the same way GigForms.tsx's endDateInputToUtcMs is
// (catches e.g. Feb 30 -> March 2 day-in-month rollovers); returns null for
// an empty/malformed input, mirroring that helper's contract.
export function launchTzDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const candidateMs = guessUtcMs - tzOffsetMs(LAUNCH_TIMEZONE, guessUtcMs);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAUNCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(candidateMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  if (get("year") !== year || get("month") !== month || get("day") !== day) return null;
  return candidateMs;
}

// The exclusive upper bound for a "To" date filter: the LAUNCH_TIMEZONE
// midnight that STARTS the day after `dateInput` — computed by advancing
// the calendar date itself (plain UTC-numbers arithmetic on Y-M-D, timezone-
// agnostic) and re-running launchTzDayStartMs on that date, rather than
// adding a fixed 24h to this date's start. A fixed +24h would be wrong by an
// hour on LAUNCH_TIMEZONE's own spring-forward/fall-back days (23h/25h
// calendar days) — deriving the boundary from the actual next calendar date
// keeps this correct across DST the same way launchTzDayStartMs itself is.
export function launchTzNextDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextInput = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return launchTzDayStartMs(nextInput);
}

// Public-precision location label — mirrors app/u/[handle]/CuratorProfile.tsx's
// (unexported, "use client"-boundary-duplicated) gigLocationLabel exactly:
// `address` is present on the doc ONLY when addressVisibility=='public'
// (functions/src/gigs.ts nulls it out otherwise), so this never branches on
// anything the client couldn't already see.
export function gigLocationLabel(location: GigPublicLocation): string {
  if (location.addressVisibility === "public") {
    return location.venueName ? `${location.venueName} — ${location.address}` : (location.address ?? location.city);
  }
  return location.neighborhood ? `${location.neighborhood}, ${location.city}` : location.city;
}

// A render-safe "now" — eslint-config-next's React Compiler rules
// (react-hooks/purity) forbid calling the impure `Date.now()` directly
// inside a component's render body (it "can produce unstable results that
// update unpredictably when the component happens to re-render" per the
// rule's own message); the fix is the same shape as any other async-derived
// state — defer the actual read to an effect (which runs AFTER render, not
// during it) and re-render once with the resolved value. Every render-time
// "is this occurrence in the future" / "how many hours until the gig"
// computation in BookingThread.tsx/CancelDialog.tsx goes through this
// rather than a bare `Date.now()` call. Returns null for the single initial
// render before the effect fires — callers treat that the same as "not
// determined yet" (e.g. hide a time-gated button rather than guess).
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // A zero-delay timer, not a bare synchronous setState call at the top
    // of the effect body — eslint-config-next's react-hooks/set-state-in-
    // effect rule flags the latter ("calling setState synchronously within
    // an effect can trigger cascading renders"; its own message names the
    // fix as calling setState "in a callback function when external state
    // changes" — a timer callback qualifies, an effect's own top-level
    // statement doesn't).
    const id = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(id);
  }, []);
  return now;
}

// ---------- Task 10: booking inboxes (portfolio + curator dashboards) ----------

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
// `deposit.amountCents`, frozen by acceptBooking). Distinct from this file's
// DEPOSIT_HONESTY_LINE above, which is the pre-acceptance "implied, not yet
// known" phrasing for the apply/offer composers — Task 10's brief calls for
// this exact "$X" wording once a real number exists.
export function depositLine(amountCents: number): string {
  return `35% deposit (${formatCents(amountCents)}) will be collected when payments launch.`;
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

"use client";
import {
  validateOfferInput, LAUNCH_TIMEZONE, MAX_OFFER_NOTE_LENGTH, MAX_OFFER_SONG_COUNT,
  type BudgetStructure, type GigPublicLocation,
} from "@gatekeep/shared";

// Sub-project 4's booking-domain equivalent of ../gigs/GigForms.tsx: shared
// "apply / offer" building blocks reused by the gig detail page's Apply
// panel and OfferComposer.tsx (Find musicians -> offerGig). Kept as its own
// module (not added to GigForms.tsx, which is SP3-owned and out of scope for
// this task) even though it mirrors that file's conventions closely —
// dollars in the UI, integer cents on the wire, the exact shared validator
// the callables run, LAUNCH_TIMEZONE-pinned dates via the existing
// formatGigDateTime import wherever a gig time is shown.
//
// Field-groups + pure formatters ONLY (Task 10 review) — booking-status
// DISPLAY helpers (bookingHistoryLabel/depositLine) and the inbox lists live
// in BookingInbox.tsx, and the render-safe "now" hook lives in
// BookingThread.tsx (its primary consumer) — neither is a field-group.

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

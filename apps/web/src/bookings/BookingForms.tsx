"use client";
import { useId } from "react";
import {
  validateOfferInput, LAUNCH_TIMEZONE, MAX_OFFER_NOTE_LENGTH, MAX_OFFER_SONG_COUNT, DEPOSIT_PERCENT,
  type BudgetStructure, type ReliabilitySummary,
} from "@gatekeep/shared";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
// SP4 (Task 13 item 9): re-exported, not redefined: see GigForms.tsx's
// identical formatGigDateTime re-export comment for the full rationale;
// gigDisplay.ts is now the ONE canonical gigLocationLabel too (this file
// used to carry its own, byte-identical, copy).
export { gigLocationLabel } from "../../app/u/[handle]/gigDisplay";

// Sub-project 4's booking-domain equivalent of ../gigs/GigForms.tsx: shared
// "apply / offer" building blocks reused by the gig detail page's Apply
// panel and OfferComposer.tsx (Find musicians -> offerGig). Kept as its own
// module (not added to GigForms.tsx, which is SP3-owned and out of scope for
// this task) even though it mirrors that file's conventions closely:
// dollars in the UI, integer cents on the wire, the exact shared validator
// the callables run, LAUNCH_TIMEZONE-pinned dates via the existing
// formatGigDateTime import wherever a gig time is shown.
//
// Field-groups + pure formatters ONLY (Task 10 review): booking-status
// DISPLAY helpers (bookingHistoryLabel/depositLine) and the inbox lists live
// in BookingInbox.tsx, and the render-safe "now" hook lives in
// BookingThread.tsx (its primary consumer); neither is a field-group.

// Exact copy required by Task 9's spec for the pre-acceptance surfaces (gig
// detail Apply panel, OfferComposer): no computed dollar amount exists yet
// at this point (that only exists once a deposit is actually calculated,
// after acceptBooking runs), so this is the "implied, not yet known" phrasing
// rather than Task 10's "$X" variant.
// SP5 Task 15 review round 1 (medium #6): payments are LIVE as of this
// sub-project: the old "...will be collected... when payments launch"
// wording was accurate pre-SP5 and is now simply false (acceptBooking fires
// a real Stripe charge the moment it commits). DEPOSIT_PERCENT templated in
// rather than a hardcoded "35%" literal, so this can never drift from the
// actual constant.
export const DEPOSIT_HONESTY_LINE =
  `If accepted, a ${DEPOSIT_PERCENT}% deposit is charged to the curator's card at accept.`;

// The whole-run twin (sp4 audit finding 2): on a whole_run series the deposit
// is charged PER DATE, for every open date of the run, at accept. Rendered
// wherever DEPOSIT_HONESTY_LINE is, whenever the gig's own fillMode says so.
export const DEPOSIT_HONESTY_RUN_LINE =
  `If accepted, a ${DEPOSIT_PERCENT}% deposit is charged to the curator's card per date, for every open date of the run.`;

// The curator-facing reliability sentence, one definition for every surface
// that renders it (Find musicians cards today; Task 32 adds the inbox rows and
// the thread header). Counts BOOKINGS, not dates: an 8-date completed
// whole-run booking is +1 (ReliabilitySummary.completedCount is
// booking-scoped, see functions/src/bookingLifecycle.ts's
// recomputeReliability). Tolerates a projection with no reliability block:
// pre-section-B3 recomputeReliability wrote summary-only docs, and
// rebuildBookingProjections used to delete and recreate without one.
export function formatReliabilityLine(r: ReliabilitySummary | undefined): string {
  const completed = r?.completedCount ?? 0;
  const noShows = r?.noShowCount ?? 0;
  return `${completed} show${completed === 1 ? "" : "s"} played · ${noShows} no-show${noShows === 1 ? "" : "s"}`;
}

export interface OfferState { amount: string; quantity: string; note: string; }
export const emptyOffer = (): OfferState => ({ amount: "", quantity: "", note: "" });

export interface OfferPayload { amountCents: number; expectedQuantity: number | null; note: string | null; }

// Converts the dollar-string UI state into the integer-cents callable
// payload and runs the SAME validator applyToGig/offerGig/counterBooking run
// server-side (validateOfferInput): a malformed offer is caught here, with
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
    // Raw, not Math.trunc'd: a fractional entry (e.g. "3.5") is passed
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

// Amount + (perSong only) song count + note-with-counter: the exact input
// set functions/src/bookings.ts's finalizeBookingRequest/counterBooking
// accept, gated on the SAME structure-driven branch validateOfferInput uses
// server-side (perHour is server-derived from the gig's duration; perSet
// never takes a quantity).
//
// Theme pass (sub-project 9A task 11): src/ui Input/Textarea, same
// label-above-field grid as GigForms.tsx's ContentFields/BudgetFields (the
// one other money-amount field group in the app, "Min $"/"Max $"). The
// dollar sign stays visible text next to the input; an aria-label on the
// input itself restores the "dollars" qualifier for assistive tech (the old
// inline "Your offer (per hour): $" wording announced it as part of the
// label text, which splitting the "$" into its own sibling span no longer
// does on its own).
//
// Review round 1: this component mounts more than once on the same page in
// at least two places (CuratorArtistRow can open several OfferComposer
// instances; the gig detail page can render this from ApplyPanel alongside
// other booking surfaces), so a literal id string would collide across
// instances (two elements with the same id, and a label pointing at
// whichever one the browser resolves first). useId() mints a stable,
// per-mount-instance-unique id, the same fix applied to every other
// duplicate-id spot flagged in this review (OfferComposer, EarningsPanel).
export function OfferFields({ structure, value, onChange, disabled }: {
  structure: BudgetStructure; value: OfferState; onChange: (v: OfferState) => void; disabled?: boolean;
}) {
  const unitLabel = structure === "perHour" ? "per hour" : structure === "perSong" ? "per song" : "flat, per set";
  const amountId = useId();
  const songCountId = useId();
  const noteId = useId();
  return (
    <div className="grid gap-4">
      <div className="grid max-w-44 gap-1.5">
        <label htmlFor={amountId} className="font-sora text-sm font-medium text-gk-text">
          Your offer ({unitLabel})
        </label>
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="font-sora text-sm text-gk-muted">$</span>
          <Input id={amountId} type="number" min={0} step="0.01" disabled={disabled}
            aria-label={`Your offer (${unitLabel}), dollars`}
            value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
        </div>
      </div>
      {structure === "perSong" && (
        <div className="grid max-w-32 gap-1.5">
          <label htmlFor={songCountId} className="font-sora text-sm font-medium text-gk-text">Song count</label>
          <Input id={songCountId} type="number" min={1} max={MAX_OFFER_SONG_COUNT} step={1} disabled={disabled}
            value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} />
        </div>
      )}
      <div className="grid gap-1.5">
        <label htmlFor={noteId} className="font-sora text-sm font-medium text-gk-text">Note (optional)</label>
        <Textarea id={noteId} rows={3} maxLength={MAX_OFFER_NOTE_LENGTH} placeholder="Note (optional)" disabled={disabled}
          value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
        <p className="font-sora text-xs text-gk-muted">{value.note.length}/{MAX_OFFER_NOTE_LENGTH}</p>
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
// constant) so it's correct on both sides of a DST transition: the whole
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

// A LAUNCH_TIMEZONE-aware day-boundary computation: every gig time on this
// app is displayed in LAUNCH_TIMEZONE (formatGigDateTime), so a calendar day
// picked in a date field (a "From"/"To" filter, a series end date) must be
// bucketed by LAUNCH_TIMEZONE midnight, not UTC midnight: an evening gig
// near the boundary would otherwise mis-bucket by the zone's offset (4-5h
// for LAUNCH_TIMEZONE = America/New_York).
// Standard two-step technique: treat the input Y-M-D as a UTC guess, read
// LAUNCH_TIMEZONE's offset AT that guess (so DST is derived per-date, never
// a hardcoded constant), then shift the guess by that offset to land on the
// actual UTC instant of LAUNCH_TIMEZONE midnight for that calendar date.
// Round-trip-validated the same way launchTzNextDayStartMs below is (catches
// e.g. Feb 30 -> March 2 day-in-month rollovers); returns null for an
// empty/malformed input, mirroring that helper's contract.
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
// midnight that STARTS the day after `dateInput`: computed by advancing
// the calendar date itself (plain UTC-numbers arithmetic on Y-M-D, timezone-
// agnostic) and re-running launchTzDayStartMs on that date, rather than
// adding a fixed 24h to this date's start. A fixed +24h would be wrong by an
// hour on LAUNCH_TIMEZONE's own spring-forward/fall-back days (23h/25h
// calendar days): deriving the boundary from the actual next calendar date
// keeps this correct across DST the same way launchTzDayStartMs itself is.
export function launchTzNextDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextInput = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return launchTzDayStartMs(nextInput);
}

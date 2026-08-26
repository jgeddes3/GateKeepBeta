"use client";
import type { CSSProperties } from "react";
import {
  GENRES, ACT_SIZES, SERIES_CADENCES, LAUNCH_TIMEZONE,
  type GigContentInput, type GigBudget, type GigDoc, type GigStatus, type SeriesStatus,
  type BudgetStructure, type ActSize, type SeriesCadence, type FillMode, type AddressVisibility, type GigRecurrence,
} from "@gatekeep/shared";

// Sub-project 3's gig/series equivalent of ../portfolio/PortfolioForms.tsx and
// ../curator/CuratorForms.tsx: controlled field-group components shared by
// the composer (createGig/createSeries), the gig editor (updateGig), and the
// series template editor (updateSeries) — all four consume the SAME
// GigContentInput + GigBudget + location shape (createGig/updateGig/
// createSeries/updateSeries all take the whole content object on every call,
// unlike updateCuratorProfile's partial-update fields), so unlike
// CuratorForms.tsx's independently-saved sections, these are dumb
// value/onChange components with no save button of their own — the page
// that composes them owns the one submit action.

// Mirrors functions/src/gigs.ts's MAX_ADDRESS_LENGTH (module-private, not
// exported to shared) — a UX-only soft cap; the server remains authoritative.
export const MAX_ADDRESS_LENGTH = 300;

export const GIG_STATUS_LABEL: Record<GigStatus, string> = {
  draft: "Draft", open: "Open", filled: "Filled", closed: "Closed", cancelled: "Cancelled", taken_down: "Taken down",
};
export const SERIES_STATUS_LABEL: Record<SeriesStatus, string> = {
  active: "Active", paused: "Paused", ended: "Ended",
};
export const BUDGET_STRUCTURE_LABEL: Record<BudgetStructure, string> = {
  perHour: "per hour", perSong: "per song", perSet: "per set",
};
export const FILL_MODE_LABEL: Record<FillMode, string> = {
  per_occurrence: "Each date booked separately", whole_run: "One act takes the whole run",
};
export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const chip = (active: boolean): CSSProperties => ({
  padding: "4px 10px", borderRadius: 12, border: "1px solid #bbb",
  background: active ? "#111" : "#fff", color: active ? "#fff" : "#111",
});
export const badge = (bg: string, fg = "#111"): CSSProperties => ({
  fontSize: 13, padding: "2px 8px", borderRadius: 10, background: bg, color: fg,
});

// A gig's `startsAt` is a bare epoch ms — rendering it with a bare
// `toLocaleString()` shows whichever clock is doing the rendering (the
// curator dashboard runs client-side, in the viewer's browser TZ; the public
// page at u/[handle] runs server-side, in the server's TZ), so the SAME gig
// can display two different wall times depending on which surface you're
// looking at, and neither is guaranteed to be the venue's own TZ. Pinning
// both to LAUNCH_TIMEZONE (a v1, single-metro-launch simplification — see
// its definition in @gatekeep/shared) makes every surface agree, and
// appending the zone's own short name (computed via Intl, so it tracks
// LAUNCH_TIMEZONE automatically — including DST, e.g. EDT vs EST — rather
// than a hardcoded "ET" that would go stale twice a year) makes that
// explicit to whoever's reading it. dateStyle/timeStyle can't be combined
// with timeZoneName in the same Intl call (throws), so the zone name is
// computed via a second formatToParts() call and appended as text.
export function formatGigDateTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  const formatted = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, timeZoneName: "short" })
    .formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
  return tzName ? `${formatted} ${tzName}` : formatted;
}

// cents -> a dollar string, showing cents only when they're non-zero — a
// bare `.toFixed(0)` silently rounds e.g. $12.50 up to "$13", which is wrong
// for a budget figure a musician is deciding whether to apply against.
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// Payload shapes for the four callables — mirrors functions/src/gigs.ts's
// CreateGigInput/UpdateGigInput and gigSeries.ts's CreateSeriesInput/
// UpdateSeriesInput exactly (those interfaces are server-internal and not
// exported to @gatekeep/shared, so these are the client-side equivalents,
// built the same way — `extends GigContentInput` — for real typing without
// `as any`).
export interface GigLocationPayload { address?: string | null; addressVisibility?: AddressVisibility; }
export interface CreateGigPayload extends GigContentInput {
  profileId: string; budget: GigBudget; startsAt: number; location?: GigLocationPayload;
}
export interface UpdateGigPayload extends GigContentInput {
  gigId: string; budget: GigBudget; startsAt: number; location?: GigLocationPayload;
}
export interface CreateSeriesPayload extends GigContentInput {
  profileId: string; budget: GigBudget; recurrence: GigRecurrence; fillMode: FillMode; location?: GigLocationPayload;
}
export interface UpdateSeriesPayload extends GigContentInput {
  seriesId: string; budget: GigBudget; recurrence: GigRecurrence; fillMode: FillMode; location?: GigLocationPayload;
}

// ---------- Controlled state shapes + seed helpers ----------

export interface ContentState { title: string; description: string; genres: string[]; actSizes: ActSize[]; duration: string; }
export const emptyContent = (): ContentState => ({ title: "", description: "", genres: [], actSizes: [], duration: "60" });
export const contentFrom = (g: Pick<GigDoc, "title" | "description" | "wants" | "durationMinutes">): ContentState => ({
  title: g.title, description: g.description, genres: g.wants.genres, actSizes: g.wants.actSizes,
  duration: String(g.durationMinutes),
});

export interface ProvisionsState { hasPA: boolean | null; hasBackline: boolean | null; notes: string; }
export const emptyProvisions = (): ProvisionsState => ({ hasPA: null, hasBackline: null, notes: "" });
export const provisionsFrom = (p: GigDoc["provisions"]): ProvisionsState =>
  ({ hasPA: p.hasPA, hasBackline: p.hasBackline, notes: p.notes ?? "" });

export interface BudgetState { min: string; max: string; structure: BudgetStructure; }
export const emptyBudget = (): BudgetState => ({ min: "", max: "", structure: "perHour" });
export const budgetFrom = (b: GigBudget): BudgetState =>
  ({ min: (b.minCents / 100).toString(), max: (b.maxCents / 100).toString(), structure: b.structure });

export interface RecurrenceState { weekday: number; time: string; cadence: SeriesCadence; endDate: string; fillMode: FillMode; }
export const emptyRecurrence = (): RecurrenceState =>
  ({ weekday: 5, time: "20:00", cadence: "weekly", endDate: "", fillMode: "per_occurrence" });
export const recurrenceFrom = (r: GigRecurrence, fillMode: FillMode): RecurrenceState => ({
  weekday: r.weekday, time: `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
  cadence: r.cadence, endDate: r.endDate ? new Date(r.endDate).toISOString().slice(0, 10) : "", fillMode,
});

// ---------- Field-group components ----------

export function ContentFields({ value, onChange }: { value: ContentState; onChange: (v: ContentState) => void }) {
  const toggleGenre = (g: string) => onChange({ ...value,
    genres: value.genres.includes(g) ? value.genres.filter((x) => x !== g) : [...value.genres, g] });
  const toggleActSize = (a: ActSize) => onChange({ ...value,
    actSizes: value.actSizes.includes(a) ? value.actSizes.filter((x) => x !== a) : [...value.actSizes, a] });
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <input placeholder="Gig title" maxLength={80} value={value.title}
        onChange={(e) => onChange({ ...value, title: e.target.value })} />
      <textarea rows={4} maxLength={2000} placeholder="Description — the room, the crowd, what you're building…"
        value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      <p style={{ color: "#666", margin: 0 }}>Looking for — genres</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => (
          <button key={g} type="button" onClick={() => toggleGenre(g)} style={chip(value.genres.includes(g))}>{g}</button>
        ))}
      </div>
      <p style={{ color: "#666", margin: 0 }}>Act sizes</p>
      <div style={{ display: "flex", gap: 6 }}>
        {ACT_SIZES.map((a) => (
          <button key={a} type="button" onClick={() => toggleActSize(a)} style={chip(value.actSizes.includes(a))}>{a}</button>
        ))}
      </div>
      <label>Duration (minutes): <input type="number" min={15} max={720} step={15} style={{ width: 90 }}
        value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} /></label>
    </div>
  );
}

export function BudgetFields({ value, onChange }: { value: BudgetState; onChange: (v: BudgetState) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      Budget: $<input type="number" min={0} step="0.01" style={{ width: 90 }} placeholder="min"
        value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value })} />
      {" – "}$<input type="number" min={0} step="0.01" style={{ width: 90 }} placeholder="max"
        value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value })} />
      <select value={value.structure} onChange={(e) => onChange({ ...value, structure: e.target.value as BudgetStructure })}>
        <option value="perHour">per hour</option>
        <option value="perSong">per song</option>
        <option value="perSet">per set</option>
      </select>
    </label>
  );
}

export function ProvisionsFields({ value, onChange }: { value: ProvisionsState; onChange: (v: ProvisionsState) => void }) {
  const triSelect = (v: boolean | null) => (v === null ? "" : String(v));
  const triFromEvent = (s: string): boolean | null => (s === "" ? null : s === "true");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label>PA provided:{" "}
        <select value={triSelect(value.hasPA)} onChange={(e) => onChange({ ...value, hasPA: triFromEvent(e.target.value) })}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select></label>
      <label>Backline provided:{" "}
        <select value={triSelect(value.hasBackline)} onChange={(e) => onChange({ ...value, hasBackline: triFromEvent(e.target.value) })}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select></label>
      <textarea rows={2} maxLength={500} placeholder="Other provisions (optional)" value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value })} />
    </div>
  );
}

export interface LocationValue { address: string; visibility: AddressVisibility; }

// `value.address` is always an OVERRIDE field, never a live mirror of what's
// saved: blank means "no change" on edit, or "use my venue's address on
// file" on create (non-venues must type one — createGig throws
// invalid-argument otherwise). `currentLabel` is the only place the
// ALREADY-SAVED address/visibility is displayed, so the page composing this
// is responsible for building that string (from the gig's private/location
// subdoc on edit, or the curator profile's own address on create).
export function LocationFields({ isVenue, addressRequired, currentLabel, value, onChange }: {
  isVenue: boolean; addressRequired: boolean; currentLabel: string;
  value: LocationValue; onChange: (v: LocationValue) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p style={{ color: "#666", margin: 0 }}>{currentLabel}</p>
      <input placeholder={isVenue ? "Street address (leave blank to use your venue's address on file)" : "Street address"}
        maxLength={MAX_ADDRESS_LENGTH} value={value.address} onChange={(e) => onChange({ ...value, address: e.target.value })} />
      {addressRequired && <p style={{ color: "#92400e", fontSize: 12, margin: 0 }}>An address is required for this gig.</p>}
      <label>Show address to musicians as:{" "}
        <select value={value.visibility} onChange={(e) => onChange({ ...value, visibility: e.target.value as AddressVisibility })}>
          <option value="public">Full address (public)</option>
          <option value="neighborhood">Neighborhood only</option>
        </select></label>
      {/* The brief-mandated copy: explain the non-venue neighborhood default
          (privacy — a planner/host's home or a private client's address
          shouldn't be public by default), with the symmetric venue note so
          the toggle's behavior reads as a deliberate choice either way. */}
      <p style={{ color: "#666", fontSize: 12, margin: 0 }}>
        {isVenue
          ? "Venues default to a full public address — switch to neighborhood-only if you'd rather not show it."
          : "Non-venue gigs show only the neighborhood publicly by default, to protect privacy — switch to a full " +
            "public address if you want one shown (e.g. a block party or a rented hall)."}
      </p>
    </div>
  );
}

// The materializer (functions/src/scheduled.ts's anchorFor) interprets
// weekday/hour/minute — and, per the fix below, endDate — in UTC (a
// documented v1 launch-checklist gap, not a bug: true per-curator-timezone
// support is deferred). Neither <input type="time"> nor <input type="date">
// hints at that on their own, so this caveat is the only place a curator
// finds out before picking a time that reads correctly on this form but
// lands an hour (or more) off from what they meant in their own timezone.
export function RecurrenceFields({ value, onChange }: { value: RecurrenceState; onChange: (v: RecurrenceState) => void }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label>Day of week:{" "}
        <select value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
          {WEEKDAY_LABELS.map((w, i) => <option key={w} value={i}>{w}</option>)}
        </select></label>
      <label>Time: <input type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} /></label>
      <label>Repeats:{" "}
        <select value={value.cadence} onChange={(e) => onChange({ ...value, cadence: e.target.value as SeriesCadence })}>
          {SERIES_CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select></label>
      <label>End date (optional): <input type="date" value={value.endDate}
        onChange={(e) => onChange({ ...value, endDate: e.target.value })} /></label>
      <p style={{ color: "#92400e", fontSize: 12, margin: 0 }}>
        Times are in UTC for now — local-timezone support is coming. The end date above is also treated as UTC midnight.
      </p>
      <label>Fill mode:{" "}
        <select value={value.fillMode} onChange={(e) => onChange({ ...value, fillMode: e.target.value as FillMode })}>
          <option value="per_occurrence">{FILL_MODE_LABEL.per_occurrence}</option>
          <option value="whole_run">{FILL_MODE_LABEL.whole_run}</option>
        </select></label>
    </div>
  );
}

// Explicit UTC parse for the <input type="date"> value ("YYYY-MM-DD"),
// rather than relying on `new Date(value).getTime()` — which HAPPENS to
// land on UTC midnight for a bare date string, but only because of an
// easy-to-miss quirk of the ES date-string grammar (a date-only form parses
// as UTC; the SAME string with a time suffix — like what datetime-local
// produces — parses as LOCAL). Spelling out the UTC math here, the same way
// functions/src/scheduled.ts's anchorFor does with Date.UTC(...), keeps the
// endDate consistent with the recurrence's weekday/hour/minute (also
// UTC-interpreted) by construction rather than by that easy-to-miss quirk.
//
// P8: range checks + a round-trip check, ported from mobile's
// endDateInputToUtcMs — mobile needed them first (its free-text YYYY-MM-DD
// entry has no native picker constraining the value at all), but the same
// gap exists here too: Date.UTC silently ROLLS OVER an out-of-range
// day/month into a different date (e.g. Feb 30 -> March 2) rather than
// throwing, and native <input type="date"> does not, on every browser,
// reliably prevent a hand-typed or programmatically-set out-of-range value
// from reaching onChange. The two implementations are byte-identical again.
export function endDateInputToUtcMs(value: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Round-trip check: catches day-in-month rollovers the range checks above
  // can't (e.g. Feb 30 -> March 2 — day and month are each individually
  // in-range, but the constructor didn't land on the actual date requested).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

"use client";
import {
  GENRES, ACT_SIZES, SERIES_CADENCES,
  type GigContentInput, type GigBudget, type GigDoc, type GigStatus, type SeriesStatus,
  type BudgetStructure, type ActSize, type SeriesCadence, type FillMode, type AddressVisibility, type GigRecurrence,
} from "@gatekeep/shared";
// Sub-project 9A task 8: the field-group components below are restyled with
// src/ui + the Chip/formatChipLabel precedent CuratorForms.tsx and
// PortfolioForms.tsx already established for genre/type pickers: every
// composer/editor page that imports these (gig posting, gig editor, series
// template editor) gets the restyle for free.
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
// SP4 (Task 13 item 9): re-exported, not redefined: app/u/[handle]/gigDisplay.ts
// is the ONE canonical formatGigDateTime (this file used to carry its own,
// byte-identical, copy). gigDisplay.ts stays a plain (non-"use client")
// module with no dependency on this file, so THIS import direction (a
// client component pulling in a plain module) is the only one that avoids a
// cycle or forcing a client boundary onto gigDisplay.ts's own server-
// component consumers (CuratorProfile.tsx/MusicianProfile.tsx).
export { formatGigDateTime } from "../../app/u/[handle]/gigDisplay";

// Sub-project 3's gig/series equivalent of ../portfolio/PortfolioForms.tsx and
// ../curator/CuratorForms.tsx: controlled field-group components shared by
// the composer (createGig/createSeries), the gig editor (updateGig), and the
// series template editor (updateSeries): all four consume the SAME
// GigContentInput + GigBudget + location shape (createGig/updateGig/
// createSeries/updateSeries all take the whole content object on every call,
// unlike updateCuratorProfile's partial-update fields), so unlike
// CuratorForms.tsx's independently-saved sections, these are dumb
// value/onChange components with no save button of their own; the page
// that composes them owns the one submit action.

// Mirrors functions/src/gigs.ts's MAX_ADDRESS_LENGTH (module-private, not
// exported to shared): a UX-only soft cap; the server remains authoritative.
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

// cents -> a dollar string, showing cents only when they're non-zero: a
// bare `.toFixed(0)` silently rounds e.g. $12.50 up to "$13", which is wrong
// for a budget figure a musician is deciding whether to apply against.
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// Payload shapes for the four callables: mirrors functions/src/gigs.ts's
// CreateGigInput/UpdateGigInput and gigSeries.ts's CreateSeriesInput/
// UpdateSeriesInput exactly (those interfaces are server-internal and not
// exported to @gatekeep/shared, so these are the client-side equivalents,
// built the same way (`extends GigContentInput`) for real typing without
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
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label htmlFor="gig-title" className="font-sora text-sm font-medium text-gk-text">Gig title</label>
        <Input id="gig-title" placeholder="Gig title" maxLength={80} value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="gig-description" className="font-sora text-sm font-medium text-gk-text">Description</label>
        <Textarea id="gig-description" rows={4} maxLength={2000}
          placeholder="The room, the crowd, what you're building…"
          value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      </div>
      <div className="grid gap-2">
        <span className="font-sora text-sm font-medium text-gk-text">Looking for: genres</span>
        <div className="flex flex-wrap gap-2">
          {GENRES.map((g) => (
            <Chip key={g} active={value.genres.includes(g)} onClick={() => toggleGenre(g)}>{formatChipLabel(g)}</Chip>
          ))}
        </div>
      </div>
      <div className="grid gap-2">
        <span className="font-sora text-sm font-medium text-gk-text">Act sizes</span>
        <div className="flex flex-wrap gap-2">
          {ACT_SIZES.map((a) => (
            <Chip key={a} active={value.actSizes.includes(a)} onClick={() => toggleActSize(a)}>{formatChipLabel(a)}</Chip>
          ))}
        </div>
      </div>
      <div className="grid max-w-40 gap-1.5">
        <label htmlFor="gig-duration" className="font-sora text-sm font-medium text-gk-text">Duration (minutes)</label>
        <Input id="gig-duration" type="number" min={15} max={720} step={15}
          value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} />
      </div>
    </div>
  );
}

export function BudgetFields({ value, onChange }: { value: BudgetState; onChange: (v: BudgetState) => void }) {
  return (
    <div className="grid gap-2">
      <span className="font-sora text-sm font-medium text-gk-text">Budget</span>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min={0} step="0.01" className="w-28" placeholder="Min $"
          aria-label="Minimum budget" value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value })} />
        <span className="font-sora text-sm text-gk-muted">to</span>
        <Input type="number" min={0} step="0.01" className="w-28" placeholder="Max $"
          aria-label="Maximum budget" value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value })} />
        <Select value={value.structure} onValueChange={(v) => onChange({ ...value, structure: v as BudgetStructure })}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="perHour">Per hour</SelectItem>
            <SelectItem value="perSong">Per song</SelectItem>
            <SelectItem value="perSet">Per set</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function ProvisionsFields({ value, onChange }: { value: ProvisionsState; onChange: (v: ProvisionsState) => void }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <span className="font-sora text-sm font-medium text-gk-text">PA provided</span>
        <div className="flex gap-2">
          {/* Reclicking the active chip clears it back to "not set", the
              same null the old blank select option produced. */}
          <Chip active={value.hasPA === true} onClick={() => onChange({ ...value, hasPA: value.hasPA === true ? null : true })}>
            Yes
          </Chip>
          <Chip active={value.hasPA === false} onClick={() => onChange({ ...value, hasPA: value.hasPA === false ? null : false })}>
            No
          </Chip>
        </div>
      </div>
      <div className="grid gap-2">
        <span className="font-sora text-sm font-medium text-gk-text">Backline provided</span>
        <div className="flex gap-2">
          <Chip active={value.hasBackline === true}
            onClick={() => onChange({ ...value, hasBackline: value.hasBackline === true ? null : true })}>
            Yes
          </Chip>
          <Chip active={value.hasBackline === false}
            onClick={() => onChange({ ...value, hasBackline: value.hasBackline === false ? null : false })}>
            No
          </Chip>
        </div>
      </div>
      <Textarea rows={2} maxLength={500} placeholder="Other provisions (optional)" value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value })} />
    </div>
  );
}

export interface LocationValue { address: string; visibility: AddressVisibility; }

// `value.address` is always an OVERRIDE field, never a live mirror of what's
// saved: blank means "no change" on edit, or "use my venue's address on
// file" on create (non-venues must type one; createGig throws
// invalid-argument otherwise). `currentLabel` is the only place the
// ALREADY-SAVED address/visibility is displayed, so the page composing this
// is responsible for building that string (from the gig's private/location
// subdoc on edit, or the curator profile's own address on create).
export function LocationFields({ isVenue, addressRequired, currentLabel, value, onChange }: {
  isVenue: boolean; addressRequired: boolean; currentLabel: string;
  value: LocationValue; onChange: (v: LocationValue) => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="font-sora text-sm text-gk-muted">{currentLabel}</p>
      <div className="grid gap-1.5">
        <label htmlFor="gig-address" className="font-sora text-sm font-medium text-gk-text">Street address</label>
        <Input id="gig-address"
          placeholder={isVenue ? "Leave blank to use your venue's address on file" : "Street address"}
          maxLength={MAX_ADDRESS_LENGTH} value={value.address} onChange={(e) => onChange({ ...value, address: e.target.value })} />
      </div>
      {addressRequired && <p className="font-sora text-sm text-gk-warning">An address is required for this gig.</p>}
      <div className="grid gap-1.5 max-w-64">
        <label htmlFor="gig-address-visibility" className="font-sora text-sm font-medium text-gk-text">
          Show address to musicians as
        </label>
        <Select value={value.visibility} onValueChange={(v) => onChange({ ...value, visibility: v as AddressVisibility })}>
          <SelectTrigger id="gig-address-visibility" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="public">Full address (public)</SelectItem>
            <SelectItem value="neighborhood">Neighborhood only</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* The brief-mandated copy: explain the non-venue neighborhood default
          (privacy: a planner/host's home or a private client's address
          shouldn't be public by default), with the symmetric venue note so
          the toggle's behavior reads as a deliberate choice either way. */}
      <p className="font-sora text-xs text-gk-muted">
        {isVenue
          ? "Venues default to a full public address. Switch to neighborhood-only if you'd rather not show it."
          : "Non-venue gigs show only the neighborhood publicly by default, to protect privacy. Switch to a full " +
            "public address if you want one shown (e.g. a block party or a rented hall)."}
      </p>
    </div>
  );
}

// The materializer (functions/src/scheduled.ts's anchorFor) interprets
// weekday/hour/minute (and, per the fix below, endDate) in UTC (a
// documented v1 launch-checklist gap, not a bug: true per-curator-timezone
// support is deferred). Neither <input type="time"> nor <input type="date">
// hints at that on their own, so this caveat is the only place a curator
// finds out before picking a time that reads correctly on this form but
// lands an hour (or more) off from what they meant in their own timezone.
export function RecurrenceFields({ value, onChange }: { value: RecurrenceState; onChange: (v: RecurrenceState) => void }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <label htmlFor="series-weekday" className="font-sora text-sm font-medium text-gk-text">Day of week</label>
          <Select value={String(value.weekday)} onValueChange={(v) => onChange({ ...value, weekday: Number(v) })}>
            <SelectTrigger id="series-weekday" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {WEEKDAY_LABELS.map((w, i) => <SelectItem key={w} value={String(i)}>{w}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="series-time" className="font-sora text-sm font-medium text-gk-text">Time</label>
          <Input id="series-time" type="time" className="w-32" value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })} />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="series-cadence" className="font-sora text-sm font-medium text-gk-text">Repeats</label>
          <Select value={value.cadence} onValueChange={(v) => onChange({ ...value, cadence: v as SeriesCadence })}>
            <SelectTrigger id="series-cadence" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SERIES_CADENCES.map((c) => <SelectItem key={c} value={c}>{formatChipLabel(c)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="series-end-date" className="font-sora text-sm font-medium text-gk-text">End date (optional)</label>
          <Input id="series-end-date" type="date" value={value.endDate}
            onChange={(e) => onChange({ ...value, endDate: e.target.value })} />
        </div>
      </div>
      <p className="font-sora text-xs text-gk-muted">
        Times are in UTC for now, local-timezone support is coming. The end date above is also treated as UTC midnight.
      </p>
      <div className="grid gap-1.5 max-w-72">
        <label htmlFor="series-fill-mode" className="font-sora text-sm font-medium text-gk-text">Fill mode</label>
        <Select value={value.fillMode} onValueChange={(v) => onChange({ ...value, fillMode: v as FillMode })}>
          <SelectTrigger id="series-fill-mode" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="per_occurrence">{FILL_MODE_LABEL.per_occurrence}</SelectItem>
            <SelectItem value="whole_run">{FILL_MODE_LABEL.whole_run}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// Explicit UTC parse for the <input type="date"> value ("YYYY-MM-DD"),
// rather than relying on `new Date(value).getTime()`, which HAPPENS to
// land on UTC midnight for a bare date string, but only because of an
// easy-to-miss quirk of the ES date-string grammar (a date-only form parses
// as UTC; the SAME string with a time suffix, like what datetime-local
// produces, parses as LOCAL). Spelling out the UTC math here, the same way
// functions/src/scheduled.ts's anchorFor does with Date.UTC(...), keeps the
// endDate consistent with the recurrence's weekday/hour/minute (also
// UTC-interpreted) by construction rather than by that easy-to-miss quirk.
//
// P8: range checks + a round-trip check, ported from mobile's
// endDateInputToUtcMs: mobile needed them first (its free-text YYYY-MM-DD
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
  // can't (e.g. Feb 30 -> March 2: day and month are each individually
  // in-range, but the constructor didn't land on the actual date requested).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

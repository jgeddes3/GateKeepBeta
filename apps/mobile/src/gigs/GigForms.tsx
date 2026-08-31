import { View } from "react-native";
import {
  GENRES, ACT_SIZES, SERIES_CADENCES, LAUNCH_TIMEZONE,
  type GigContentInput, type GigBudget, type GigDoc, type GigStatus, type SeriesStatus,
  type BudgetStructure, type ActSize, type SeriesCadence, type FillMode, type AddressVisibility, type GigRecurrence,
} from "@gatekeep/shared";
import { Text as UiText, Input, TextArea, Chip as UiChip, type StatusTone } from "../ui";
import { useTokens } from "../theme/ThemeProvider";

// RN port of ../../web/src/gigs/GigForms.tsx, sub-project 3's gig/series
// equivalent of ../curator/CuratorForms.tsx: controlled field-group
// components shared by the composer (createGig/createSeries), the gig editor
// (updateGig), and the series template editor (updateSeries). All four
// consume the SAME GigContentInput + GigBudget + location shape (each
// callable takes the whole content object on every call, no partial-update
// fields), so (like CuratorForms.tsx) these are dumb value/onChange
// components with no save button of their own; the screen composing them
// owns the one submit action.
//
// Mobile-appropriate pickers: web's <select>/<input type="date"/"time">
// elements are replaced here with Chip rows (weekday, cadence, fill mode,
// budget structure, address visibility, the same touch-target idiom already
// established by PortfolioForms.tsx's BookingForm/GENRES chips) and labeled
// numeric TextInputs with keyboardType="number-pad"/"decimal-pad" for
// numbers, dates, and times, instead of native date/time pickers, no new
// native dependency was added for this (the brief's file scope for this task
// doesn't list package.json, and a new native module would need a dev-client
// rebuild this environment can't perform or verify). Internal state keeps the
// same string-based shapes as web's RecurrenceState/BudgetState (raw text,
// converted once at submit). P8 CORRECTION: this comment used to claim the
// UTC endDate math and hour/minute parsing below were already
// "byte-identical to the reviewed web version", that was aspirational, not
// actual: mobile's free-text entry (no native date/time picker to constrain
// input) needed its own range + round-trip rollover validation FIRST, and
// web's endDateInputToUtcMs didn't have the matching checks until a later
// fix ported them back. They are genuinely byte-identical now (see
// endDateInputToUtcMs below), see the DO-NOT-COPY note on Intl.ListFormat:
// this file makes no use of it.

// Mirrors functions/src/gigs.ts's MAX_ADDRESS_LENGTH (module-private, not
// exported to shared), a UX-only soft cap; the server remains authoritative.
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

// Status -> StatusBadge tone maps (task 7): the color SOURCE moved to the
// themed StatusBadge (no hex here), while GIG_STATUS_LABEL/SERIES_STATUS_LABEL
// above still own every displayed word. taken_down stays visually distinct
// from cancelled (warning vs. destructive) so a moderation take-down does not
// read as just another flavor of the curator's own routine cancellation,
// matching web's badge distinction. Consumers render
// <StatusBadge label={GIG_STATUS_LABEL[x]} status={GIG_STATUS_TONE[x]} />.
export const GIG_STATUS_TONE: Record<GigStatus, StatusTone> = {
  draft: "neutral", open: "success", filled: "neutral", closed: "neutral", cancelled: "destructive", taken_down: "warning",
};
export const SERIES_STATUS_TONE: Record<SeriesStatus, StatusTone> = {
  active: "success", paused: "warning", ended: "neutral",
};

// A gig's `startsAt` is a bare epoch ms, pinning the rendered wall time to
// LAUNCH_TIMEZONE (rather than each device's own clock) is what keeps a
// curator's phone and the public/dashboard pages agreeing on the same gig
// time (see @gatekeep/shared's LAUNCH_TIMEZONE comment: a v1, single-metro
// launch simplification). dateStyle/timeStyle can't be combined with
// timeZoneName in one Intl call, so the zone's short name is computed via a
// second formatToParts() call and appended as text, mirrors web's
// formatGigDateTime exactly. Wrapped in try/catch (not present on web, which
// doesn't need it): Hermes's Intl.DateTimeFormat timeZone/formatToParts
// support isn't independently verified on-device in this environment the way
// web's browser support is, so a formatting failure here falls back to the
// device's own local-time string rather than crashing the whole screen,
// same failure-vs-crash philosophy as the Intl.ListFormat DO-NOT-COPY note,
// applied defensively to a nearby Intl call this task actually needs.
export function formatGigDateTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  try {
    const formatted = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
    const tzName = new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, timeZoneName: "short" })
      .formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
    return tzName ? `${formatted} ${tzName}` : formatted;
  } catch {
    return date.toLocaleString();
  }
}

// cents -> a dollar string, showing cents only when they're non-zero, a
// bare `.toFixed(0)` silently rounds e.g. $12.50 up to "$13".
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// Payload shapes for the four callables, mirrors functions/src/gigs.ts's
// CreateGigInput/UpdateGigInput and gigSeries.ts's CreateSeriesInput/
// UpdateSeriesInput (server-internal, not exported to @gatekeep/shared), same
// as web's client-side equivalents.
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

// hour/minute kept as raw text (not a combined "HH:MM" string like web),
// simpler to edit with two small numeric TextInputs than to parse/re-compose
// a colon-separated string on every keystroke on a numeric-only keypad.
export interface RecurrenceState { weekday: number; hour: string; minute: string; cadence: SeriesCadence; endDate: string; fillMode: FillMode; }
export const emptyRecurrence = (): RecurrenceState =>
  ({ weekday: 5, hour: "20", minute: "00", cadence: "weekly", endDate: "", fillMode: "per_occurrence" });
export const recurrenceFrom = (r: GigRecurrence, fillMode: FillMode): RecurrenceState => ({
  weekday: r.weekday, hour: String(r.hour).padStart(2, "0"), minute: String(r.minute).padStart(2, "0"),
  cadence: r.cadence, endDate: r.endDate ? new Date(r.endDate).toISOString().slice(0, 10) : "", fillMode,
});

// One-off gig startsAt, LOCAL time (unlike the recurrence's UTC-interpreted
// weekday/hour/minute/endDate above): mirrors web's <input type="datetime-local">
// + `new Date(value).getTime()`, which parses in the browser's own local
// timezone. `new Date(y, m-1, d, hh, mm)` here is the same local-time
// constructor form.
export interface OneOffDateTimeState { date: string; hour: string; minute: string; }
export const emptyOneOffDateTime = (): OneOffDateTimeState => ({ date: "", hour: "", minute: "" });
export const oneOffDateTimeFrom = (ms: number): OneOffDateTimeState => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hour: pad(d.getHours()), minute: pad(d.getMinutes()) };
};
export function oneOffDateTimeToMs(v: OneOffDateTimeState): number | null {
  if (!v.date.trim() || v.hour.trim() === "" || v.minute.trim() === "") return null;
  const parts = v.date.split("-").map(Number);
  const year = parts[0]; const month = parts[1]; const day = parts[2];
  const hh = Number(v.hour); const mm = Number(v.minute);
  if (!year || !month || !day || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  // Explicit range checks BEFORE constructing, JS's Date constructor
  // silently ROLLS OVER an out-of-range component into a different,
  // unintended date/time (day "32" becomes next month's 1st/2nd, hour "25"
  // becomes 01:00 the next day) rather than throwing, so a typo in this
  // free-text entry would otherwise create a gig at a date the curator never
  // actually typed. Mirrors validateRecurrence's bounds for hour (0-23) and
  // minute (0-59).
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  const d = new Date(year, month - 1, day, hh, mm, 0, 0);
  // Round-trip check: catches the day-in-month rollovers the range checks
  // above can't (e.g. Feb 30 -> March 2, day and month are each
  // individually in-range, but the constructor didn't land on the actual
  // month/day requested). LOCAL getters match this constructor's local-time
  // semantics (see OneOffDateTimeState's comment above, deliberately NOT
  // UTC, unlike endDateInputToUtcMs below).
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hh || d.getMinutes() !== mm) {
    return null;
  }
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ---------- Field-group components ----------

export function ContentFields({ value, onChange }: { value: ContentState; onChange: (v: ContentState) => void }) {
  const toggleGenre = (g: string) => onChange({ ...value,
    genres: value.genres.includes(g) ? value.genres.filter((x) => x !== g) : [...value.genres, g] });
  const toggleActSize = (a: ActSize) => onChange({ ...value,
    actSizes: value.actSizes.includes(a) ? value.actSizes.filter((x) => x !== a) : [...value.actSizes, a] });
  return (
    <View style={{ gap: 8 }}>
      <Input placeholder="Gig title" maxLength={80} value={value.title}
        onChangeText={(t) => onChange({ ...value, title: t })} />
      <TextArea numberOfLines={4} maxLength={2000} value={value.description}
        placeholder="Description: the room, the crowd, what you're building…"
        onChangeText={(t) => onChange({ ...value, description: t })}
        style={{ minHeight: 90 }} />
      <UiText muted>Looking for: genres</UiText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => <UiChip key={g} label={g} active={value.genres.includes(g)} onPress={() => toggleGenre(g)} />)}
      </View>
      <UiText muted>Act sizes</UiText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {ACT_SIZES.map((a) => <UiChip key={a} label={a} active={value.actSizes.includes(a)} onPress={() => toggleActSize(a)} />)}
      </View>
      <View style={{ gap: 4 }}>
        <UiText>Duration (minutes)</UiText>
        <Input keyboardType="number-pad" value={value.duration} onChangeText={(t) => onChange({ ...value, duration: t })}
          style={{ width: 90 }} />
      </View>
    </View>
  );
}

export function BudgetFields({ value, onChange }: { value: BudgetState; onChange: (v: BudgetState) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <UiText variant="label">Budget</UiText>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <UiText>$</UiText>
        <Input keyboardType="decimal-pad" placeholder="min" value={value.min}
          onChangeText={(t) => onChange({ ...value, min: t })}
          style={{ width: 80 }} />
        <UiText>–</UiText>
        <UiText>$</UiText>
        <Input keyboardType="decimal-pad" placeholder="max" value={value.max}
          onChangeText={(t) => onChange({ ...value, max: t })}
          style={{ width: 80 }} />
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["perHour", "perSong", "perSet"] as const).map((s) => (
          <UiChip key={s} label={BUDGET_STRUCTURE_LABEL[s]} active={value.structure === s}
            onPress={() => onChange({ ...value, structure: s })} />
        ))}
      </View>
    </View>
  );
}

export function ProvisionsFields({ value, onChange }: { value: ProvisionsState; onChange: (v: ProvisionsState) => void }) {
  const triRow = (label: string, v: boolean | null, set: (b: boolean | null) => void) => (
    <View style={{ gap: 4 }}>
      <UiText>{label}</UiText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <UiChip label="Yes" active={v === true} onPress={() => set(v === true ? null : true)} />
        <UiChip label="No" active={v === false} onPress={() => set(v === false ? null : false)} />
      </View>
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      {triRow("PA provided", value.hasPA, (b) => onChange({ ...value, hasPA: b }))}
      {triRow("Backline provided", value.hasBackline, (b) => onChange({ ...value, hasBackline: b }))}
      <TextArea numberOfLines={2} maxLength={500} placeholder="Other provisions (optional)" value={value.notes}
        onChangeText={(t) => onChange({ ...value, notes: t })}
        style={{ minHeight: 50 }} />
    </View>
  );
}

export interface LocationValue { address: string; visibility: AddressVisibility; }

// `value.address` is always an OVERRIDE field, never a live mirror of what's
// saved: blank means "no change" on edit, or "use my venue's address on
// file" on create (non-venues must type one, createGig throws
// invalid-argument otherwise). `currentLabel` is the only place the
// ALREADY-SAVED address/visibility is displayed, so the screen composing this
// is responsible for building that string.
// `entityNoun` (default "gig", Task 12): web's LocationFields grew the same
// prop in its own fix round 1 (apps/web/src/gigs/GigForms.tsx) once its
// event-creation surface reused this component and its two hardcoded "gig"
// strings started leaking onto a screen creating something else. Adding it
// here BEFORE this component gets its own second caller (Task 12's
// standalone event create form) avoids shipping the identical bug knowingly.
// Every existing gig/series call site omits the prop and keeps rendering
// "gig" unchanged.
export function LocationFields({ isVenue, addressRequired, currentLabel, value, onChange, entityNoun = "gig" }: {
  isVenue: boolean; addressRequired: boolean; currentLabel: string;
  value: LocationValue; onChange: (v: LocationValue) => void; entityNoun?: string;
}) {
  const tok = useTokens();
  return (
    <View style={{ gap: 8 }}>
      <UiText muted>{currentLabel}</UiText>
      <Input placeholder={isVenue ? "Street address (leave blank to use your venue's address on file)" : "Street address"}
        maxLength={MAX_ADDRESS_LENGTH} value={value.address} onChangeText={(t) => onChange({ ...value, address: t })} />
      {addressRequired && <UiText variant="meta" color={tok.warning}>An address is required for this {entityNoun}.</UiText>}
      <UiText>Show address to musicians as</UiText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <UiChip label="Full address (public)" active={value.visibility === "public"}
          onPress={() => onChange({ ...value, visibility: "public" })} />
        <UiChip label="Neighborhood only" active={value.visibility === "neighborhood"}
          onPress={() => onChange({ ...value, visibility: "neighborhood" })} />
      </View>
      {/* Brief-mandated copy, matching web's aside from em-dash removal:
          explains the non-venue neighborhood default (privacy) with the
          symmetric venue note so the toggle reads as a deliberate choice
          either way. */}
      <UiText variant="meta" muted>
        {isVenue
          ? "Venues default to a full public address, switch to neighborhood-only if you'd rather not show it."
          : `Non-venue ${entityNoun}s show only the neighborhood publicly by default, to protect privacy, switch to a ` +
            "full public address if you want one shown (e.g. a block party or a rented hall)."}
      </UiText>
    </View>
  );
}

// Date/time fields for a ONE-OFF gig's startsAt, used by both the composer
// (create) and the gig editor (edit, seeded via oneOffDateTimeFrom).
export function OneOffDateTimeFields({ value, onChange }: { value: OneOffDateTimeState; onChange: (v: OneOffDateTimeState) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <UiText variant="label">When</UiText>
      <View style={{ gap: 4 }}>
        <UiText>Date (YYYY-MM-DD)</UiText>
        <Input keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" maxLength={10} value={value.date}
          onChangeText={(t) => onChange({ ...value, date: t.replace(/[^0-9-]/g, "") })}
          style={{ width: 140 }} />
      </View>
      <View style={{ gap: 4 }}>
        <UiText>Time (24-hour, local)</UiText>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Input keyboardType="number-pad" placeholder="HH" maxLength={2} value={value.hour}
            onChangeText={(t) => onChange({ ...value, hour: t.replace(/[^0-9]/g, "") })}
            style={{ width: 60, textAlign: "center" }} />
          <UiText>:</UiText>
          <Input keyboardType="number-pad" placeholder="MM" maxLength={2} value={value.minute}
            onChangeText={(t) => onChange({ ...value, minute: t.replace(/[^0-9]/g, "") })}
            style={{ width: 60, textAlign: "center" }} />
        </View>
      </View>
    </View>
  );
}

// The materializer (functions/src/scheduled.ts's anchorFor) interprets
// weekday/hour/minute (and, per the fix mirrored from web, endDate) in
// UTC (a documented v1 launch-checklist gap, not a bug: true
// per-curator-timezone support is deferred). Same caveat copy as web, kept
// character-identical per the brief's "same copy on mobile" instruction.
export function RecurrenceFields({ value, onChange }: { value: RecurrenceState; onChange: (v: RecurrenceState) => void }) {
  const tok = useTokens();
  return (
    <View style={{ gap: 8 }}>
      <UiText>Day of week</UiText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {WEEKDAY_LABELS.map((w, i) => (
          <UiChip key={w} label={w} active={value.weekday === i} onPress={() => onChange({ ...value, weekday: i })} />
        ))}
      </View>
      <UiText>Time (24-hour)</UiText>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Input keyboardType="number-pad" placeholder="HH" maxLength={2} value={value.hour}
          onChangeText={(t) => onChange({ ...value, hour: t.replace(/[^0-9]/g, "") })}
          style={{ width: 60, textAlign: "center" }} />
        <UiText>:</UiText>
        <Input keyboardType="number-pad" placeholder="MM" maxLength={2} value={value.minute}
          onChangeText={(t) => onChange({ ...value, minute: t.replace(/[^0-9]/g, "") })}
          style={{ width: 60, textAlign: "center" }} />
      </View>
      <UiText>Repeats</UiText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {SERIES_CADENCES.map((c) => (
          <UiChip key={c} label={c} active={value.cadence === c} onPress={() => onChange({ ...value, cadence: c })} />
        ))}
      </View>
      <View style={{ gap: 4 }}>
        <UiText>End date (optional, YYYY-MM-DD)</UiText>
        <Input keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" maxLength={10} value={value.endDate}
          onChangeText={(t) => onChange({ ...value, endDate: t.replace(/[^0-9-]/g, "") })}
          style={{ width: 140 }} />
      </View>
      <UiText variant="meta" color={tok.warning}>
        Times are in UTC for now, local-timezone support is coming. The end date above is also treated as UTC midnight.
      </UiText>
      <UiText>Fill mode</UiText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <UiChip label={FILL_MODE_LABEL.per_occurrence} active={value.fillMode === "per_occurrence"}
          onPress={() => onChange({ ...value, fillMode: "per_occurrence" })} />
        <UiChip label={FILL_MODE_LABEL.whole_run} active={value.fillMode === "whole_run"}
          onPress={() => onChange({ ...value, fillMode: "whole_run" })} />
      </View>
    </View>
  );
}

// Explicit UTC parse for the "YYYY-MM-DD" endDate string, rather than
// `new Date(value).getTime()`, spells out the UTC math the same way
// functions/src/scheduled.ts's anchorFor does with Date.UTC(...), keeping
// endDate consistent with the recurrence's weekday/hour/minute (also
// UTC-interpreted). Byte-identical logic to web's endDateInputToUtcMs (P8:
// web's version was missing this function's range + round-trip rollover
// checks and has since been brought in line with this one).
export function endDateInputToUtcMs(value: string): number | null {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  const year = parts[0]; const month = parts[1]; const day = parts[2];
  if (!year || !month || !day) return null;
  // Same silent-rollover concern as oneOffDateTimeToMs above, Date.UTC
  // doesn't throw on an out-of-range day/month, it wraps into a different
  // date. Explicit range checks first, then a round-trip check via the UTC
  // getters (matching Date.UTC's own semantics) to catch day-in-month
  // rollovers the range checks alone can't (e.g. Feb 30).
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

import { View, Text, TextInput, Pressable } from "react-native";
import {
  GENRES, ACT_SIZES, SERIES_CADENCES, LAUNCH_TIMEZONE,
  type GigContentInput, type GigBudget, type GigDoc, type GigStatus, type SeriesStatus,
  type BudgetStructure, type ActSize, type SeriesCadence, type FillMode, type AddressVisibility, type GigRecurrence,
} from "@gatekeep/shared";

// RN port of ../../web/src/gigs/GigForms.tsx — sub-project 3's gig/series
// equivalent of ../curator/CuratorForms.tsx: controlled field-group
// components shared by the composer (createGig/createSeries), the gig editor
// (updateGig), and the series template editor (updateSeries). All four
// consume the SAME GigContentInput + GigBudget + location shape (each
// callable takes the whole content object on every call, no partial-update
// fields), so — like CuratorForms.tsx — these are dumb value/onChange
// components with no save button of their own; the screen composing them
// owns the one submit action.
//
// Mobile-appropriate pickers: web's <select>/<input type="date"/"time">
// elements are replaced here with Chip rows (weekday, cadence, fill mode,
// budget structure, address visibility — the same touch-target idiom already
// established by PortfolioForms.tsx's BookingForm/GENRES chips) and labeled
// numeric TextInputs with keyboardType="number-pad"/"decimal-pad" for
// numbers, dates, and times, instead of native date/time pickers — no new
// native dependency was added for this (the brief's file scope for this task
// doesn't list package.json, and a new native module would need a dev-client
// rebuild this environment can't perform or verify). Internal state keeps the
// same string-based shapes as web's RecurrenceState/BudgetState (raw text,
// converted once at submit). P8 CORRECTION: this comment used to claim the
// UTC endDate math and hour/minute parsing below were already
// "byte-identical to the reviewed web version" — that was aspirational, not
// actual: mobile's free-text entry (no native date/time picker to constrain
// input) needed its own range + round-trip rollover validation FIRST, and
// web's endDateInputToUtcMs didn't have the matching checks until a later
// fix ported them back. They are genuinely byte-identical now (see
// endDateInputToUtcMs below) — see the DO-NOT-COPY note on Intl.ListFormat:
// this file makes no use of it.

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

// taken_down is a MODERATION action (admin-issued) — distinct amber/orange
// pair from cancelled's red so it doesn't read as just another flavor of the
// curator's own routine cancellation, matching web's badge distinction.
export const STATUS_BG: Record<GigStatus, string> = {
  draft: "#fef9c3", open: "#dcfce7", filled: "#dbeafe", closed: "#e5e7eb", cancelled: "#fee2e2", taken_down: "#fed7aa",
};
export const STATUS_FG: Partial<Record<GigStatus, string>> = { taken_down: "#9a3412" };

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
      borderWidth: 1, borderColor: "#bbb", backgroundColor: active ? "#111" : "#fff" }}>
      <Text style={{ color: active ? "#fff" : "#111" }}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, bg, fg = "#111" }: { label: string; bg: string; fg?: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 10, paddingVertical: 2, paddingHorizontal: 8, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

// A gig's `startsAt` is a bare epoch ms — pinning the rendered wall time to
// LAUNCH_TIMEZONE (rather than each device's own clock) is what keeps a
// curator's phone and the public/dashboard pages agreeing on the same gig
// time (see @gatekeep/shared's LAUNCH_TIMEZONE comment: a v1, single-metro
// launch simplification). dateStyle/timeStyle can't be combined with
// timeZoneName in one Intl call, so the zone's short name is computed via a
// second formatToParts() call and appended as text — mirrors web's
// formatGigDateTime exactly. Wrapped in try/catch (not present on web, which
// doesn't need it): Hermes's Intl.DateTimeFormat timeZone/formatToParts
// support isn't independently verified on-device in this environment the way
// web's browser support is, so a formatting failure here falls back to the
// device's own local-time string rather than crashing the whole screen —
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

// cents -> a dollar string, showing cents only when they're non-zero — a
// bare `.toFixed(0)` silently rounds e.g. $12.50 up to "$13".
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// Payload shapes for the four callables — mirrors functions/src/gigs.ts's
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

// hour/minute kept as raw text (not a combined "HH:MM" string like web) —
// simpler to edit with two small numeric TextInputs than to parse/re-compose
// a colon-separated string on every keystroke on a numeric-only keypad.
export interface RecurrenceState { weekday: number; hour: string; minute: string; cadence: SeriesCadence; endDate: string; fillMode: FillMode; }
export const emptyRecurrence = (): RecurrenceState =>
  ({ weekday: 5, hour: "20", minute: "00", cadence: "weekly", endDate: "", fillMode: "per_occurrence" });
export const recurrenceFrom = (r: GigRecurrence, fillMode: FillMode): RecurrenceState => ({
  weekday: r.weekday, hour: String(r.hour).padStart(2, "0"), minute: String(r.minute).padStart(2, "0"),
  cadence: r.cadence, endDate: r.endDate ? new Date(r.endDate).toISOString().slice(0, 10) : "", fillMode,
});

// One-off gig startsAt — LOCAL time (unlike the recurrence's UTC-interpreted
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
  // Explicit range checks BEFORE constructing — JS's Date constructor
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
  // above can't (e.g. Feb 30 -> March 2 — day and month are each
  // individually in-range, but the constructor didn't land on the actual
  // month/day requested). LOCAL getters match this constructor's local-time
  // semantics (see OneOffDateTimeState's comment above — deliberately NOT
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
      <TextInput placeholder="Gig title" maxLength={80} value={value.title}
        onChangeText={(t) => onChange({ ...value, title: t })}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10 }} />
      <TextInput multiline numberOfLines={4} maxLength={2000} value={value.description}
        placeholder="Description — the room, the crowd, what you're building…"
        onChangeText={(t) => onChange({ ...value, description: t })}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 90, textAlignVertical: "top" }} />
      <Text style={{ color: "#666" }}>Looking for — genres</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => <Chip key={g} label={g} active={value.genres.includes(g)} onPress={() => toggleGenre(g)} />)}
      </View>
      <Text style={{ color: "#666" }}>Act sizes</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {ACT_SIZES.map((a) => <Chip key={a} label={a} active={value.actSizes.includes(a)} onPress={() => toggleActSize(a)} />)}
      </View>
      <View style={{ gap: 4 }}>
        <Text>Duration (minutes)</Text>
        <TextInput keyboardType="number-pad" value={value.duration} onChangeText={(t) => onChange({ ...value, duration: t })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 90 }} />
      </View>
    </View>
  );
}

export function BudgetFields({ value, onChange }: { value: BudgetState; onChange: (v: BudgetState) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: "700" }}>Budget</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text>$</Text>
        <TextInput keyboardType="decimal-pad" placeholder="min" value={value.min}
          onChangeText={(t) => onChange({ ...value, min: t })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 80 }} />
        <Text>–</Text>
        <Text>$</Text>
        <TextInput keyboardType="decimal-pad" placeholder="max" value={value.max}
          onChangeText={(t) => onChange({ ...value, max: t })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 80 }} />
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["perHour", "perSong", "perSet"] as const).map((s) => (
          <Chip key={s} label={BUDGET_STRUCTURE_LABEL[s]} active={value.structure === s}
            onPress={() => onChange({ ...value, structure: s })} />
        ))}
      </View>
    </View>
  );
}

export function ProvisionsFields({ value, onChange }: { value: ProvisionsState; onChange: (v: ProvisionsState) => void }) {
  const triRow = (label: string, v: boolean | null, set: (b: boolean | null) => void) => (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Yes" active={v === true} onPress={() => set(v === true ? null : true)} />
        <Chip label="No" active={v === false} onPress={() => set(v === false ? null : false)} />
      </View>
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      {triRow("PA provided", value.hasPA, (b) => onChange({ ...value, hasPA: b }))}
      {triRow("Backline provided", value.hasBackline, (b) => onChange({ ...value, hasBackline: b }))}
      <TextInput multiline numberOfLines={2} maxLength={500} placeholder="Other provisions (optional)" value={value.notes}
        onChangeText={(t) => onChange({ ...value, notes: t })}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 50, textAlignVertical: "top" }} />
    </View>
  );
}

export interface LocationValue { address: string; visibility: AddressVisibility; }

// `value.address` is always an OVERRIDE field, never a live mirror of what's
// saved: blank means "no change" on edit, or "use my venue's address on
// file" on create (non-venues must type one — createGig throws
// invalid-argument otherwise). `currentLabel` is the only place the
// ALREADY-SAVED address/visibility is displayed, so the screen composing this
// is responsible for building that string.
export function LocationFields({ isVenue, addressRequired, currentLabel, value, onChange }: {
  isVenue: boolean; addressRequired: boolean; currentLabel: string;
  value: LocationValue; onChange: (v: LocationValue) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: "#666" }}>{currentLabel}</Text>
      <TextInput placeholder={isVenue ? "Street address (leave blank to use your venue's address on file)" : "Street address"}
        maxLength={MAX_ADDRESS_LENGTH} value={value.address} onChangeText={(t) => onChange({ ...value, address: t })}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10 }} />
      {addressRequired && <Text style={{ color: "#92400e", fontSize: 12 }}>An address is required for this gig.</Text>}
      <Text>Show address to musicians as</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Full address (public)" active={value.visibility === "public"}
          onPress={() => onChange({ ...value, visibility: "public" })} />
        <Chip label="Neighborhood only" active={value.visibility === "neighborhood"}
          onPress={() => onChange({ ...value, visibility: "neighborhood" })} />
      </View>
      {/* Brief-mandated copy, character-identical to web's — explains the
          non-venue neighborhood default (privacy) with the symmetric venue
          note so the toggle reads as a deliberate choice either way. */}
      <Text style={{ color: "#666", fontSize: 12 }}>
        {isVenue
          ? "Venues default to a full public address — switch to neighborhood-only if you'd rather not show it."
          : "Non-venue gigs show only the neighborhood publicly by default, to protect privacy — switch to a full " +
            "public address if you want one shown (e.g. a block party or a rented hall)."}
      </Text>
    </View>
  );
}

// Date/time fields for a ONE-OFF gig's startsAt — used by both the composer
// (create) and the gig editor (edit, seeded via oneOffDateTimeFrom).
export function OneOffDateTimeFields({ value, onChange }: { value: OneOffDateTimeState; onChange: (v: OneOffDateTimeState) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: "700" }}>When</Text>
      <View style={{ gap: 4 }}>
        <Text>Date (YYYY-MM-DD)</Text>
        <TextInput keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" maxLength={10} value={value.date}
          onChangeText={(t) => onChange({ ...value, date: t.replace(/[^0-9-]/g, "") })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 140 }} />
      </View>
      <View style={{ gap: 4 }}>
        <Text>Time (24-hour, local)</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput keyboardType="number-pad" placeholder="HH" maxLength={2} value={value.hour}
            onChangeText={(t) => onChange({ ...value, hour: t.replace(/[^0-9]/g, "") })}
            style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 60, textAlign: "center" }} />
          <Text>:</Text>
          <TextInput keyboardType="number-pad" placeholder="MM" maxLength={2} value={value.minute}
            onChangeText={(t) => onChange({ ...value, minute: t.replace(/[^0-9]/g, "") })}
            style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 60, textAlign: "center" }} />
        </View>
      </View>
    </View>
  );
}

// The materializer (functions/src/scheduled.ts's anchorFor) interprets
// weekday/hour/minute — and, per the fix mirrored from web, endDate — in
// UTC (a documented v1 launch-checklist gap, not a bug: true
// per-curator-timezone support is deferred). Same caveat copy as web, kept
// character-identical per the brief's "same copy on mobile" instruction.
export function RecurrenceFields({ value, onChange }: { value: RecurrenceState; onChange: (v: RecurrenceState) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <Text>Day of week</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {WEEKDAY_LABELS.map((w, i) => (
          <Chip key={w} label={w} active={value.weekday === i} onPress={() => onChange({ ...value, weekday: i })} />
        ))}
      </View>
      <Text>Time (24-hour)</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput keyboardType="number-pad" placeholder="HH" maxLength={2} value={value.hour}
          onChangeText={(t) => onChange({ ...value, hour: t.replace(/[^0-9]/g, "") })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 60, textAlign: "center" }} />
        <Text>:</Text>
        <TextInput keyboardType="number-pad" placeholder="MM" maxLength={2} value={value.minute}
          onChangeText={(t) => onChange({ ...value, minute: t.replace(/[^0-9]/g, "") })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 60, textAlign: "center" }} />
      </View>
      <Text>Repeats</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {SERIES_CADENCES.map((c) => (
          <Chip key={c} label={c} active={value.cadence === c} onPress={() => onChange({ ...value, cadence: c })} />
        ))}
      </View>
      <View style={{ gap: 4 }}>
        <Text>End date (optional, YYYY-MM-DD)</Text>
        <TextInput keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" maxLength={10} value={value.endDate}
          onChangeText={(t) => onChange({ ...value, endDate: t.replace(/[^0-9-]/g, "") })}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 140 }} />
      </View>
      <Text style={{ color: "#92400e", fontSize: 12 }}>
        Times are in UTC for now — local-timezone support is coming. The end date above is also treated as UTC midnight.
      </Text>
      <Text>Fill mode</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label={FILL_MODE_LABEL.per_occurrence} active={value.fillMode === "per_occurrence"}
          onPress={() => onChange({ ...value, fillMode: "per_occurrence" })} />
        <Chip label={FILL_MODE_LABEL.whole_run} active={value.fillMode === "whole_run"}
          onPress={() => onChange({ ...value, fillMode: "whole_run" })} />
      </View>
    </View>
  );
}

// Explicit UTC parse for the "YYYY-MM-DD" endDate string, rather than
// `new Date(value).getTime()` — spells out the UTC math the same way
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
  // Same silent-rollover concern as oneOffDateTimeToMs above — Date.UTC
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

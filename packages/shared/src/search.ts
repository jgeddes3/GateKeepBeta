import { GENRES, ACT_SIZES, LAUNCH_TIMEZONE, type ActSize } from "./types.js";

// ---------- kinds, faces, constants ----------

export type SearchKind = "show" | "gig" | "artist" | "venue";
export const SEARCH_FACES = ["fan", "musician_gigs", "musician_venues", "curator"] as const;
export type SearchFace = (typeof SEARCH_FACES)[number];
export const SEARCH_WHENS = ["tonight", "weekend", "month", "any"] as const;
export type SearchWhen = (typeof SEARCH_WHENS)[number];

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 50;
export const SEARCH_CANDIDATE_CAP = 300;
export const SEARCH_PIN_CAP = 200;
export const SEARCH_MAX_QUERY_CHARS = 80;
export const SEARCH_MAX_QUERY_WORDS = 10;
export const SEARCH_MAX_GENRES = 5;
export const SEARCH_NEAR_ME_METERS = 25_000;
export const SEARCH_TOKEN_MIN = 2;
export const SEARCH_TOKEN_MAX = 12;
export const SEARCH_MAX_WORDS = 40;
export const SEARCH_MAX_TOKENS = 150;
export const SEARCH_DAILY_BUDGET = 300;
export const SAVED_SEARCH_LIMIT = 10;
export const SAVED_SEARCH_SCAN_CAP = 1000;
export const SEARCH_BUSY_DAYS_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
export const SEARCH_MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function kindForFace(face: SearchFace): SearchKind {
  switch (face) {
    case "fan": return "show";
    case "musician_gigs": return "gig";
    case "musician_venues": return "venue";
    case "curator": return "artist";
  }
}

export function refKindForKind(kind: SearchKind): "event" | "gig" | "profile" {
  return kind === "show" ? "event" : kind === "gig" ? "gig" : "profile";
}

// ---------- documents and payloads ----------

export interface SearchFilters {
  when?: SearchWhen;
  genres?: string[];
  freeOnly?: boolean;
  nearMe?: boolean;
  budgetMinCents?: number;
  actSize?: ActSize;
  city?: string;
  hasAudio?: boolean;
  availableOn?: string;            // YYYY-MM-DD
}

export const FACE_FILTER_KEYS: Record<SearchFace, ReadonlyArray<keyof SearchFilters>> = {
  fan: ["when", "genres", "freeOnly", "nearMe"],
  musician_gigs: ["when", "genres", "budgetMinCents", "nearMe"],
  musician_venues: ["genres", "nearMe"],
  curator: ["genres", "actSize", "city", "hasAudio", "availableOn"],
};

export interface SearchIndexDoc {
  kind: SearchKind;
  sourceId: string;
  handle: string | null;
  title: string;
  subtitle: string;
  words: string[];
  tokens: string[];
  genres: string[];
  city: string | null;
  cityLower: string | null;
  neighborhood: string | null;
  geo: { lat: number; lng: number } | null;
  startsAt: number | null;
  endsAt: number | null;
  priceFromCents: number | null;
  hasFreeTier: boolean;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  actSize: ActSize | null;
  hasAudio: boolean;
  busyDays: string[];
  relatedProfileIds: string[];
  followerCount: number;
  imagePath: string | null;
  updatedAt: number;
}

export interface SearchInput {
  face: SearchFace;
  q: string;
  filters: SearchFilters;
  location: { lat: number; lng: number } | null;
  page: number;
  includePins: boolean;
}

export interface SearchResult {
  id: string; kind: SearchKind; handle: string | null;
  title: string; subtitle: string; imagePath: string | null;
  genres: string[]; city: string | null; neighborhood: string | null;
  startsAt: number | null; endsAt: number | null;
  priceFromCents: number | null; hasFreeTier: boolean;
  budgetMinCents: number | null; budgetMaxCents: number | null;
  actSize: ActSize | null; hasAudio: boolean; followerCount: number;
  distanceMeters: number | null;
}

export interface SearchPin {
  id: string; kind: SearchKind; title: string; subtitle: string;
  geo: { lat: number; lng: number }; startsAt: number | null;
}

export interface SearchOutput {
  items: SearchResult[]; page: number; hasMore: boolean; matched: number; pins?: SearchPin[];
}

export interface SavedSearchInput { face: SearchFace; q: string; filters: SearchFilters; }

export interface SavedSearchDoc {
  uid: string;
  face: SearchFace;
  kind: SearchKind;
  q: string;
  filters: SearchFilters;
  label: string;
  createdAt: number;
  lastMatchedAt: number | null;
}

// ---------- text normalization ----------

export function normalizeWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cleaned = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const raw of cleaned.split(/[^a-z0-9]+/)) {
    if (raw.length < SEARCH_TOKEN_MIN || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= SEARCH_MAX_WORDS) break;
  }
  return out;
}

// Every prefix of every word, 2 to 12 chars. When the cap bites, the longest
// words lose their longest prefixes first, so short names always index whole.
export function buildTokens(words: string[]): string[] {
  const perWord = words.map((w) => {
    const list: string[] = [];
    for (let n = SEARCH_TOKEN_MIN; n <= Math.min(w.length, SEARCH_TOKEN_MAX); n++) list.push(w.slice(0, n));
    return list;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of perWord) for (const t of list) if (!seen.has(t)) { seen.add(t); out.push(t); }
  while (out.length > SEARCH_MAX_TOKENS) {
    let longest = -1; let longestLen = 0;
    perWord.forEach((list, i) => { if (list.length > longestLen) { longestLen = list.length; longest = i; } });
    if (longest < 0 || longestLen === 0) break;
    const dropped = perWord[longest].pop()!;
    if (!perWord.some((l) => l.includes(dropped))) { seen.delete(dropped); out.splice(out.indexOf(dropped), 1); }
  }
  return out;
}

export function queryWords(q: string): string[] {
  return normalizeWords(q).slice(0, SEARCH_MAX_QUERY_WORDS).map((w) => w.slice(0, SEARCH_TOKEN_MAX));
}

// ---------- launch-zone days ----------

function zoneParts(ms: number): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAUNCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: get("weekday") };
}

function keyOf(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dayKeyInLaunchZone(ms: number): string {
  const p = zoneParts(ms);
  return keyOf(p.year, p.month, p.day);
}

function tzOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAUNCH_TIMEZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

// Same two-step technique as the web gig browse used before this moved
// here: guess UTC midnight, shift by the zone offset at that guess, then
// round-trip the calendar date to reject rollovers like Feb 30.
export function launchZoneDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const candidate = guess - tzOffsetMs(guess);
  const p = zoneParts(candidate);
  if (p.year !== year || p.month !== month || p.day !== day) return null;
  return candidate;
}

export function addDaysToDayKey(key: string, n: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function launchZoneNextDayStartMs(dateInput: string): number | null {
  if (!launchZoneDayStartMs(dateInput)) return null;
  return launchZoneDayStartMs(addDaysToDayKey(dateInput, 1));
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function whenWindow(when: SearchWhen, now: number): { start: number; end: number | null } {
  if (when === "any") return { start: now, end: null };
  if (when === "month") return { start: now, end: now + SEARCH_MONTH_WINDOW_MS };
  const today = dayKeyInLaunchZone(now);
  if (when === "tonight") return { start: now, end: launchZoneNextDayStartMs(today) };
  const weekday = WEEKDAY_INDEX[zoneParts(now).weekday] ?? 0;
  if (weekday === 6) return { start: now, end: launchZoneNextDayStartMs(addDaysToDayKey(today, 1)) };
  if (weekday === 0) return { start: now, end: launchZoneNextDayStartMs(today) };
  const friday = addDaysToDayKey(today, 5 - weekday);
  const fridayStart = (launchZoneDayStartMs(friday) ?? now) + 17 * HOUR_MS;
  return { start: Math.max(now, fridayStart), end: launchZoneNextDayStartMs(addDaysToDayKey(friday, 2)) };
}

// ---------- matching (shared by the callable and the alert matcher) ----------

export function matchesText(doc: Pick<SearchIndexDoc, "tokens">, words: string[]): boolean {
  return words.every((w) => doc.tokens.includes(w));
}

// Everything except nearMe, which needs the caller's position and stays in
// the callable. Keep this the single source of filter semantics.
export function matchesFilters(doc: SearchIndexDoc, filters: SearchFilters, now: number): boolean {
  if ((doc.kind === "show" || doc.kind === "gig") && filters.when && filters.when !== "any") {
    const w = whenWindow(filters.when, now);
    if (doc.startsAt === null || doc.startsAt < w.start || (w.end !== null && doc.startsAt > w.end)) return false;
  }
  if (filters.genres && filters.genres.length > 0 && !filters.genres.some((g) => doc.genres.includes(g))) return false;
  if (filters.freeOnly && !doc.hasFreeTier) return false;
  if (filters.budgetMinCents !== undefined && (doc.budgetMaxCents === null || doc.budgetMaxCents < filters.budgetMinCents)) return false;
  if (filters.actSize && doc.actSize !== filters.actSize) return false;
  if (filters.city !== undefined && filters.city.trim() !== "" && doc.cityLower !== filters.city.trim().toLowerCase()) return false;
  if (filters.hasAudio && !doc.hasAudio) return false;
  if (filters.availableOn && doc.busyDays.includes(filters.availableOn)) return false;
  return true;
}

export function matchesSavedSearch(
  doc: SearchIndexDoc, saved: { kind: SearchKind; q: string; filters: SearchFilters }, now: number,
): boolean {
  if (doc.kind !== saved.kind) return false;
  if (!matchesText(doc, queryWords(saved.q))) return false;
  return matchesFilters(doc, { ...saved.filters, nearMe: false }, now);
}

// ---------- labels ----------

const WHEN_LABEL: Record<SearchWhen, string | null> = { tonight: "Tonight", weekend: "This weekend", month: "Next 30 days", any: null };
const ACT_SIZE_LABEL: Record<ActSize, string> = { solo: "Solo", duo: "Duo", band: "Band" };

function titleCase(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

export function formatShortDate(dateInput: string): string {
  const ms = launchZoneDayStartMs(dateInput);
  if (ms === null) return dateInput;
  return new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, weekday: "short", month: "short", day: "numeric" })
    .format(new Date(ms + 12 * HOUR_MS));
}

export function savedSearchLabel(face: SearchFace, q: string, filters: SearchFilters): string {
  const parts: string[] = [];
  const trimmed = q.trim();
  if (trimmed) parts.push(`"${trimmed}"`);
  const allowed = FACE_FILTER_KEYS[face];
  if (allowed.includes("when") && filters.when && WHEN_LABEL[filters.when]) parts.push(WHEN_LABEL[filters.when]!);
  if (filters.genres && filters.genres.length > 0) parts.push(filters.genres.map(titleCase).join(", "));
  if (allowed.includes("freeOnly") && filters.freeOnly) parts.push("Free");
  if (allowed.includes("budgetMinCents") && filters.budgetMinCents !== undefined) {
    parts.push(`Budget from $${Math.round(filters.budgetMinCents / 100).toLocaleString("en-US")}`);
  }
  if (allowed.includes("actSize") && filters.actSize) parts.push(ACT_SIZE_LABEL[filters.actSize]);
  if (allowed.includes("city") && filters.city && filters.city.trim()) parts.push(filters.city.trim());
  if (allowed.includes("hasAudio") && filters.hasAudio) parts.push("Has audio");
  if (allowed.includes("availableOn") && filters.availableOn) parts.push(`Free on ${formatShortDate(filters.availableOn)}`);
  return parts.join(" · ");
}

// ---------- validation ----------

type Ok<T> = { ok: true; input: T };
type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateFilters(face: SearchFace, raw: unknown): { ok: true; filters: SearchFilters } | Fail {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("Invalid filters.");
  const allowed = FACE_FILTER_KEYS[face] as readonly string[];
  const filters: SearchFilters = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) return fail(`Filter "${key}" does not apply here.`);
    switch (key as keyof SearchFilters) {
      case "when":
        if (!(SEARCH_WHENS as readonly string[]).includes(value as string)) return fail("Unknown time window.");
        filters.when = value as SearchWhen; break;
      case "genres":
        if (!Array.isArray(value) || value.length > SEARCH_MAX_GENRES) return fail(`Pick at most ${SEARCH_MAX_GENRES} genres.`);
        if (new Set(value).size !== value.length) return fail("Duplicate genres.");
        for (const g of value) if (typeof g !== "string" || !(GENRES as readonly string[]).includes(g)) return fail("Unknown genre.");
        filters.genres = value as string[]; break;
      case "freeOnly": case "nearMe": case "hasAudio":
        if (typeof value !== "boolean") return fail(`Filter "${key}" must be true or false.`);
        filters[key as "freeOnly" | "nearMe" | "hasAudio"] = value; break;
      case "budgetMinCents":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000_000) return fail("Invalid budget floor.");
        filters.budgetMinCents = value; break;
      case "actSize":
        if (!(ACT_SIZES as readonly string[]).includes(value as string)) return fail("Unknown act size.");
        filters.actSize = value as ActSize; break;
      case "city":
        if (typeof value !== "string" || value.length > 120) return fail("Invalid city.");
        filters.city = value; break;
      case "availableOn":
        if (typeof value !== "string" || !DATE_RE.test(value) || launchZoneDayStartMs(value) === null) return fail("Invalid date.");
        filters.availableOn = value; break;
    }
  }
  return { ok: true, filters };
}

function validateLocation(raw: unknown): { ok: true; location: { lat: number; lng: number } | null } | Fail {
  if (raw === null) return { ok: true, location: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("Invalid location.");
  const { lat, lng } = raw as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail("Invalid location.");
  return { ok: true, location: { lat, lng } };
}

// Shared by validateSearchInput and validateSavedSearchInput: the face
// membership check and the q type/length check, identical in both, with
// identical messages. Takes the already-object-checked record so each
// caller keeps its own top-level "is this even an object" message.
function validateFaceAndQuery(d: Record<string, unknown>): { ok: true; face: SearchFace; q: string } | Fail {
  if (!(SEARCH_FACES as readonly string[]).includes(d.face as string)) return fail("Unknown search face.");
  const face = d.face as SearchFace;
  if (typeof d.q !== "string" || d.q.length > SEARCH_MAX_QUERY_CHARS) return fail(`Search text must be at most ${SEARCH_MAX_QUERY_CHARS} characters.`);
  return { ok: true, face, q: d.q };
}

export function validateSearchInput(data: unknown): Ok<SearchInput> | Fail {
  if (typeof data !== "object" || data === null) return fail("Invalid search.");
  const d = data as Record<string, unknown>;
  const base = validateFaceAndQuery(d);
  if (!base.ok) return base;
  const { face, q } = base;
  if (typeof d.page !== "number" || !Number.isInteger(d.page) || d.page < 0 || d.page > SEARCH_MAX_PAGE) return fail("Invalid page.");
  if (typeof d.includePins !== "boolean") return fail("includePins must be true or false.");
  const f = validateFilters(face, d.filters ?? {});
  if (!f.ok) return f;
  const l = validateLocation(d.location);
  if (!l.ok) return l;
  return { ok: true, input: { face, q, filters: f.filters, location: l.location, page: d.page, includePins: d.includePins } };
}

export function hasSavedSearchCriteria(q: string, filters: SearchFilters): boolean {
  if (q.trim().length > 0) return true;
  return Object.entries(filters).some(([k, v]) => k !== "nearMe" && v !== undefined && v !== false && v !== "any"
    && !(Array.isArray(v) && v.length === 0) && !(typeof v === "string" && v.trim() === ""));
}

export function validateSavedSearchInput(data: unknown): Ok<SavedSearchInput> | Fail {
  if (typeof data !== "object" || data === null) return fail("Invalid saved search.");
  const d = data as Record<string, unknown>;
  const base = validateFaceAndQuery(d);
  if (!base.ok) return base;
  const { face, q } = base;
  const f = validateFilters(face, d.filters ?? {});
  if (!f.ok) return f;
  const filters: SearchFilters = { ...f.filters, nearMe: false };
  if (!hasSavedSearchCriteria(q, filters)) return fail("Type something or pick a filter before saving a search.");
  return { ok: true, input: { face, q: q.trim(), filters } };
}

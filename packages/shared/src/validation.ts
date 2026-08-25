import type { ProfileDraftInput } from "./types.js";
import {
  GENRES, GIG_TYPES, AUDIO_CONTENT_TYPES, MAX_AUDIO_UPLOAD_BYTES,
  ACT_SIZES, AVAILABILITY_PATTERNS,
  type PortfolioUpdateInput, type BookingUpdateInput, type CreateTrackInput,
  type ExternalLink, type RateAmount,
} from "./types.js";

export const RESERVED_HANDLES = [
  "admin", "gatekeep", "support", "help", "api", "www",
] as const;

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export function validateHandle(handle: string): { ok: true } | { ok: false; reason: string } {
  // Defensive runtime guard: the compile-time `string` type only binds
  // trusted callers — an onCall's generic type parameter does not validate
  // the untrusted request payload at runtime, so `handle` can arrive as any
  // JSON value. RESERVED_HANDLES.includes() does not coerce, so a non-string
  // (e.g. an array or number) would otherwise sail past the reserved check.
  if (typeof handle !== "string") {
    return { ok: false, reason: "Handle must be a string." };
  }
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, reason: "Handles are 3-30 lowercase letters, digits, or underscores." };
  }
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) {
    return { ok: false, reason: "That handle is reserved." };
  }
  return { ok: true };
}

const SUBTYPES: Record<string, string[]> = {
  musician: ["solo", "band"],
  curator: ["venue", "planner", "individual_host"],
};

export function validateProfileDraft(input: ProfileDraftInput): { ok: true } | { ok: false; reason: string } {
  // Same defensive rationale as validateHandle above: input.type/subtype/name
  // are typed as string at compile time, but this is untrusted onCall
  // payload data at runtime and can arrive as any JSON shape.
  if (
    typeof input.type !== "string" ||
    typeof input.subtype !== "string" ||
    typeof input.name !== "string" ||
    typeof input.handle !== "string"
  ) {
    return { ok: false, reason: "Invalid profile draft input." };
  }
  if (!SUBTYPES[input.type]?.includes(input.subtype)) {
    return { ok: false, reason: "Invalid profile type/subtype." };
  }
  if (input.name.trim().length < 1 || input.name.length > 80) {
    return { ok: false, reason: "Name must be 1-80 characters." };
  }
  return validateHandle(input.handle);
}

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

// Guards Firestore document-id-shaped fields (profileId, etc.) against empty
// strings, path traversal ("a/b"), and absurdly long values before they reach
// a doc() call — Firestore would throw on "/" in an id, and we want a clean
// validation failure from an onCall handler, not an uncaught exception.
export const isValidDocId = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// Domain allowlists per link kind. Regex-based host extraction (not `new URL`)
// so behavior is identical on Node and React Native/Hermes.
// NOTE: "website" accepts any https host, which may resolve to localhost,
// private IPs, or internal hostnames. These links are display-only (rendered
// as an <a href>) and MUST NEVER be fetched server-side — that would be an
// SSRF vector.
const LINK_HOSTS: Record<ExternalLink["kind"], readonly string[] | null> = {
  spotify: ["open.spotify.com"],
  youtube: ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"],
  instagram: ["instagram.com", "www.instagram.com"],
  website: null, // any https host
};
const HTTPS_HOST_RE = /^https:\/\/([a-z0-9.-]+)(?::\d{1,5})?(?=[/?#]|$)/i;

function validateLink(link: unknown): Result {
  const l = link as ExternalLink;
  if (typeof l !== "object" || l === null || typeof l.kind !== "string" || typeof l.url !== "string") {
    return fail("Invalid link.");
  }
  // Object.hasOwn, not `in` — `in` walks the prototype chain, so kind values
  // like "constructor"/"toString"/"__proto__" would otherwise pass this guard
  // and crash `hosts.includes` below with an uncaught TypeError.
  if (!Object.hasOwn(LINK_HOSTS, l.kind)) return fail("Unknown link type.");
  const url = l.url.trim();
  if (url.length > 300) return fail("Link URLs must be 300 characters or fewer.");
  const m = HTTPS_HOST_RE.exec(url);
  if (!m) return fail("Links must be https:// URLs.");
  const hosts = LINK_HOSTS[l.kind];
  if (hosts && !hosts.includes(m[1].toLowerCase())) {
    return fail(`That does not look like a ${l.kind} link.`);
  }
  return { ok: true };
}

export function validatePortfolioUpdate(input: PortfolioUpdateInput): Result {
  // Untrusted onCall payload — same defensive-runtime rationale as validateHandle.
  if (typeof input !== "object" || input === null) {
    return fail("Invalid portfolio update.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  if (input.bio === undefined && input.genres === undefined && input.externalLinks === undefined) {
    return fail("Nothing to update.");
  }
  if (input.bio !== undefined) {
    if (typeof input.bio !== "string" || input.bio.length > 2000) {
      return fail("Bio must be a string of at most 2000 characters.");
    }
  }
  if (input.genres !== undefined) {
    if (!Array.isArray(input.genres) || input.genres.length < 1 || input.genres.length > 3) {
      return fail("Pick 1-3 genres.");
    }
    if (new Set(input.genres).size !== input.genres.length) return fail("Duplicate genres.");
    for (const g of input.genres) {
      if (!(GENRES as readonly string[]).includes(g)) return fail("Unknown genre.");
    }
  }
  if (input.externalLinks !== undefined) {
    if (!Array.isArray(input.externalLinks) || input.externalLinks.length > 8) {
      return fail("At most 8 links.");
    }
    for (const l of input.externalLinks) {
      const v = validateLink(l);
      if (!v.ok) return v;
    }
    const linkKeys = input.externalLinks.map((l) => `${l.kind}:${l.url}`);
    if (new Set(linkKeys).size !== linkKeys.length) return fail("Duplicate links.");
  }
  return { ok: true };
}

function validateRate(rate: unknown, label: string): Result {
  if (rate == null) return { ok: true }; // absent (undefined) and explicit null both mean "not set"
  const r = rate as RateAmount;
  if (typeof r !== "object" || typeof r.amountCents !== "number"
      || !Number.isInteger(r.amountCents) || r.amountCents < 1 || r.amountCents > 100_000_000) {
    return fail(`${label} must be a whole number of cents between 1 and 100,000,000.`);
  }
  if (r.note != null && (typeof r.note !== "string" || r.note.length > 200)) {
    return fail(`${label} note must be at most 200 characters.`);
  }
  return { ok: true };
}

export function validateBookingUpdate(input: BookingUpdateInput): Result {
  if (typeof input !== "object" || input === null
      || typeof input.rates !== "object" || input.rates === null || Array.isArray(input.rates)
      || typeof input.preferences !== "object" || input.preferences === null || Array.isArray(input.preferences)) {
    return fail("Invalid booking info.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  for (const [k, label] of [["perHour", "Hourly rate"], ["perSong", "Per-song rate"], ["perSet", "Per-set rate"]] as const) {
    const v = validateRate(input.rates[k], label);
    if (!v.ok) return v;
  }
  const p = input.preferences;
  if (!Array.isArray(p.gigTypes)) return fail("Invalid gig types.");
  if (p.gigTypes.length > GIG_TYPES.length) return fail("Too many gig types.");
  if (new Set(p.gigTypes).size !== p.gigTypes.length) return fail("Duplicate gig types.");
  for (const g of p.gigTypes) {
    if (!(GIG_TYPES as readonly string[]).includes(g)) return fail("Unknown gig type.");
  }
  if (p.travelRadiusKm !== null && (typeof p.travelRadiusKm !== "number"
      || !Number.isInteger(p.travelRadiusKm) || p.travelRadiusKm < 0 || p.travelRadiusKm > 3000)) {
    return fail("Travel radius must be 0-3000 km.");
  }
  if (p.actSize !== null && !(ACT_SIZES as readonly string[]).includes(p.actSize)) {
    return fail("Invalid act size.");
  }
  if (p.typicalSetMinutes !== null && (typeof p.typicalSetMinutes !== "number"
      || !Number.isInteger(p.typicalSetMinutes) || p.typicalSetMinutes < 15 || p.typicalSetMinutes > 480)) {
    return fail("Set length must be 15-480 minutes.");
  }
  if (p.bringsOwnPA !== null && typeof p.bringsOwnPA !== "boolean") return fail("Invalid PA answer.");
  if (p.availabilityPattern !== null
      && !(AVAILABILITY_PATTERNS as readonly string[]).includes(p.availabilityPattern)) {
    return fail("Invalid availability.");
  }
  return { ok: true };
}

export function validateTrackCreate(input: CreateTrackInput): Result {
  if (typeof input !== "object" || input === null) {
    return fail("Invalid track.");
  }
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.trim().length > 80) {
    return fail("Track titles are 1-80 characters.");
  }
  if (typeof input.startSec !== "number" || !Number.isFinite(input.startSec)
      || input.startSec < 0 || input.startSec > 24 * 3600) {
    return fail("Invalid clip start time.");
  }
  if (typeof input.sizeBytes !== "number" || !Number.isInteger(input.sizeBytes)
      || input.sizeBytes < 1 || input.sizeBytes > MAX_AUDIO_UPLOAD_BYTES) {
    return fail("Audio files must be at most 50 MB.");
  }
  if (!(AUDIO_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    return fail("Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.");
  }
  return { ok: true };
}

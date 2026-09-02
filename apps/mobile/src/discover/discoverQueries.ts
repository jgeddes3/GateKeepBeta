import {
  collection, limit, orderBy, query, where,
  type Firestore, type Query,
} from "firebase/firestore";
import { LAUNCH_TIMEZONE, type EventDoc, type ProfileDoc } from "@gatekeep/shared";

// SP7 Task 11: RN twin of apps/web/src/discover/discoverQueries.ts. Plain
// module (no hooks, no Firebase side effects of its own beyond taking a
// Firestore instance the caller already resolved), reused by ShowsList.tsx,
// ArtistsList.tsx, venue/[handle].tsx, and (curator)/events/index.tsx's own
// genre chip row, the same way the web twin's own header comment describes.

export type ShowRow = { id: string } & EventDoc;
export type ArtistRow = { id: string } & ProfileDoc;
export type DateFilter = "any" | "today" | "week" | "weekend";

const MS_DAY = 24 * 60 * 60_000;

// LAUNCH_TIMEZONE's offset from UTC at a given instant, read via Intl rather
// than a fixed constant so DST is derived per-date. Byte-for-byte the same
// technique the web twin's own tzOffsetMs uses.
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

// Epoch ms for a LAUNCH_TIMEZONE wall-clock instant (Y-M-D H:M), via the same
// guess-then-shift technique as the web twin's own tzInstantMs.
function tzInstantMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  return guessUtcMs - tzOffsetMs(LAUNCH_TIMEZONE, guessUtcMs);
}

function tzWallClockParts(utcMs: number): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAUNCH_TIMEZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    weekday: weekdayIndex[get("weekday")] ?? 0,
  };
}

// [from, to] epoch-ms bounds for a date-filter chip, LAUNCH_TIMEZONE-aware.
// Applied client-side over showsQuery's already-fetched 60-row page, never
// baked into the Firestore query itself, so DateFilter never has to be an
// index dimension. "any" has no upper bound. "weekend" is Friday 17:00
// through Sunday 23:59:59.999, rolling forward once its own Sunday cutoff has
// already passed. Byte-for-byte the web twin's own dateWindow.
export function dateWindow(filter: DateFilter, now: number): { from: number; to: number | null } {
  if (filter === "any") return { from: now, to: null };
  const wc = tzWallClockParts(now);

  if (filter === "today") {
    const to = tzInstantMs(wc.year, wc.month, wc.day, 23, 59) + 59_999;
    return { from: now, to };
  }
  if (filter === "week") {
    return { from: now, to: now + 7 * MS_DAY };
  }

  const todayUtcDate = Date.UTC(wc.year, wc.month - 1, wc.day);
  const daysSinceFriday = (wc.weekday - 5 + 7) % 7;
  const windowFor = (fridayUtcDate: number) => {
    const friday = new Date(fridayUtcDate);
    const from = tzInstantMs(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate(), 17, 0);
    const sunday = new Date(fridayUtcDate + 2 * MS_DAY);
    const to = tzInstantMs(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), 23, 59) + 59_999;
    return { from, to };
  };
  let fridayUtcDate = todayUtcDate - daysSinceFriday * MS_DAY;
  let win = windowFor(fridayUtcDate);
  if (now > win.to) {
    fridayUtcDate += 7 * MS_DAY;
    win = windowFor(fridayUtcDate);
  }
  return win;
}

// events, published + upcoming, optionally by genre and/or a free tier.
// Genre and hasFreeTier can never both be pinned as query clauses (no
// composite index covers status + genres + hasFreeTier together): when both
// are chosen, this pins genre only, and the caller (ShowsList) applies the
// free filter over the returned rows client-side, a harmless no-op re-check
// in the genre-only case too. Byte-for-byte the web twin's own showsQuery.
export function showsQuery(db: Firestore, opts: { genre: string | null; free: boolean; now: number }): Query {
  const clauses = [where("status", "==", "published"), where("startsAt", ">=", opts.now)];
  if (opts.genre) {
    clauses.push(where("genres", "array-contains", opts.genre));
  } else if (opts.free) {
    clauses.push(where("hasFreeTier", "==", true));
  }
  return query(collection(db, "events"), ...clauses, orderBy("startsAt"), limit(60));
}

// Approved musician profiles, optionally by genre.
export function artistsQuery(db: Firestore, opts: { genre: string | null }): Query {
  const clauses = [where("type", "==", "musician"), where("status", "==", "approved")];
  if (opts.genre) clauses.push(where("portfolio.genres", "array-contains", opts.genre));
  return query(collection(db, "profiles"), ...clauses, orderBy("name"), limit(60));
}

// Reskins a raw GENRES code ("hip-hop", "singer-songwriter") into a readable
// chip label ("Hip Hop", "Singer Songwriter") for display only. Byte-for-byte
// the web twin's own formatChipLabel (apps/web/app/u/[handle]/chipLabel.ts);
// every caller still passes the raw code, never this formatted string, into
// any toggle/save logic, so the value the server sees is unchanged.
export function formatChipLabel(code: string): string {
  return code.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

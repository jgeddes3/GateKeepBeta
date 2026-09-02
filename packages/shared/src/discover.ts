import { GENRES } from "./types.js";

export const GENRE_TARGET_PREFIX = "genre:";
export function genreTargetId(genre: string): string { return `${GENRE_TARGET_PREFIX}${genre}`; }
/** Returns the genre name when targetId is a well-formed genre target, else null. */
export function parseGenreTarget(targetId: string): string | null {
  if (!targetId.startsWith(GENRE_TARGET_PREFIX)) return null;
  const g = targetId.slice(GENRE_TARGET_PREFIX.length);
  return (GENRES as readonly string[]).includes(g) ? g : null;
}

export const MAX_EVENT_GENRES = 5;
/** Curator-set genres win; otherwise the union of the lineup's genres, first seen first, capped. */
export function deriveEventGenres(actGenres: string[][], curatorGenres: string[] | null | undefined): string[] {
  if (curatorGenres && curatorGenres.length > 0) return curatorGenres.slice(0, MAX_EVENT_GENRES);
  const out: string[] = [];
  for (const list of actGenres) for (const g of list) {
    if (!out.includes(g)) out.push(g);
    if (out.length >= MAX_EVENT_GENRES) return out;
  }
  return out;
}

/** Cheapest tier price and whether any tier is free. Empty input means "no tiers yet". */
export function tierProjection(tiers: Array<{ priceCents: number }>): { priceFromCents: number | null; hasFreeTier: boolean } {
  if (tiers.length === 0) return { priceFromCents: null, hasFreeTier: false };
  let min = Infinity; let free = false;
  for (const t of tiers) { if (t.priceCents < min) min = t.priceCents; if (t.priceCents === 0) free = true; }
  return { priceFromCents: min, hasFreeTier: free };
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6_371_000;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** "about 0.3 mi" / "about 1.2 mi" / "about 12 mi". Under 0.1 mi reads "nearby". */
export function distanceLabel(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return "nearby";
  if (miles < 10) return `about ${miles.toFixed(1)} mi`;
  return `about ${Math.round(miles)} mi`;
}

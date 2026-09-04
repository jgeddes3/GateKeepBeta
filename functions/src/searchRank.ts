import type { SearchIndexDoc } from "@gatekeep/shared";

export interface RankContext {
  now: number;
  hasLocation: boolean;
  followedProfiles: Set<string>;
  followedGenres: Set<string>;
  queryWords: string[];
}

export interface Ranked { doc: SearchIndexDoc; distanceMeters: number | null; score: number }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const SOON_FULL_HOURS = 720;
const DISTANCE_FULL_METERS = 20_000;
const HOUR_MS = 60 * 60 * 1000;

// Deterministic: no randomness, so the same query pages consistently.
export function scoreResult(doc: SearchIndexDoc, distanceMeters: number | null, ctx: RankContext): number {
  let score = 0;
  for (const w of ctx.queryWords) score += doc.words.includes(w) ? 3 : 1;
  if ((doc.kind === "show" || doc.kind === "gig") && doc.startsAt !== null) {
    const hours = Math.max(0, (doc.startsAt - ctx.now) / HOUR_MS);
    score += 2 * (1 - clamp01(hours / SOON_FULL_HOURS));
  }
  if (ctx.hasLocation && distanceMeters !== null) score += 1.5 * (1 - clamp01(distanceMeters / DISTANCE_FULL_METERS));
  if (doc.kind === "artist" || doc.kind === "venue") score += Math.min(2, Math.log10(1 + doc.followerCount));
  if (doc.relatedProfileIds.some((id) => ctx.followedProfiles.has(id))) score += 2;
  if (doc.genres.some((g) => ctx.followedGenres.has(g))) score += 1;
  if (doc.kind === "artist" && doc.hasAudio) score += 0.5;
  return score;
}

export function compareRanked(a: Ranked, b: Ranked): number {
  if (b.score !== a.score) return b.score - a.score;
  const sa = a.doc.startsAt ?? Number.POSITIVE_INFINITY;
  const sb = b.doc.startsAt ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb;
  const t = a.doc.title.localeCompare(b.doc.title);
  if (t !== 0) return t;
  return a.doc.sourceId.localeCompare(b.doc.sourceId);
}

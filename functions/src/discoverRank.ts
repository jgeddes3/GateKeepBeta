import { DECK_WINDOW_MS } from "@gatekeep/shared";

export type DeckCandidate = {
  id: string; kind: "show" | "artist" | "venue"; genres: string[];
  startsAt: number | null; distanceMeters: number | null; followedBoost: boolean;
};

// Small seeded PRNG so a given seed reproduces a deck order (tests, and paging
// under one seed across calls).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const DISTANCE_FULL_METERS = 20_000;

export function scoreCandidate(
  c: DeckCandidate, ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; rand: () => number },
): number {
  const overlap = c.genres.filter((g) => ctx.followedGenres.has(g)).length;
  const genre = c.genres.length > 0 ? 3 * (overlap / c.genres.length) : 0;
  const boost = c.followedBoost ? 2 : 0;
  const soon = c.startsAt === null ? 0.5 : 2 * (1 - clamp01((c.startsAt - ctx.now) / DECK_WINDOW_MS));
  const dist = ctx.hasLocation && c.distanceMeters !== null ? 1.5 * (1 - clamp01(c.distanceMeters / DISTANCE_FULL_METERS)) : 0;
  return genre + boost + soon + dist + ctx.rand();
}

// Stable sort by score desc, then interleave so no kind runs more than maxRun.
export function rankDeck(
  candidates: DeckCandidate[], ctx: { followedGenres: Set<string>; now: number; hasLocation: boolean; seed: number }, pageSize: number,
): DeckCandidate[] {
  const rand = mulberry32(ctx.seed);
  // Score in id order so the PRNG draw per candidate is deterministic regardless of input order.
  const scored = [...candidates].sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({ c, s: scoreCandidate(c, { ...ctx, rand }) }))
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .map((x) => x.c);
  return interleaveByKind(scored).slice(0, pageSize);
}

export function interleaveByKind<T extends { kind: string }>(sorted: T[], maxRun = 2): T[] {
  const out: T[] = []; const pool = [...sorted];
  while (pool.length > 0) {
    const run = out.length >= maxRun && out.slice(-maxRun).every((x) => x.kind === out[out.length - 1].kind)
      ? out[out.length - 1].kind : null;
    let idx = 0;
    if (run !== null) { const alt = pool.findIndex((x) => x.kind !== run); idx = alt === -1 ? 0 : alt; }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

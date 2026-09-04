import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  validateSearchInput, kindForFace, queryWords, whenWindow, matchesText, matchesFilters, haversineMeters, parseGenreTarget,
  SEARCH_CANDIDATE_CAP, SEARCH_PAGE_SIZE, SEARCH_PIN_CAP, SEARCH_NEAR_ME_METERS, MAX_FOLLOWS_PER_USER,
  type SearchIndexDoc, type SearchInput, type SearchOutput, type SearchResult, type SearchPin, type FollowDoc,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { consumeSearchBudget } from "./searchBudget.js";
import { scoreResult, compareRanked, type Ranked } from "./searchRank.js";

export function toSearchResult(doc: SearchIndexDoc, distanceMeters: number | null): SearchResult {
  return {
    id: doc.sourceId, kind: doc.kind, handle: doc.handle, title: doc.title, subtitle: doc.subtitle, imagePath: doc.imagePath,
    genres: doc.genres, city: doc.city, neighborhood: doc.neighborhood, startsAt: doc.startsAt, endsAt: doc.endsAt,
    priceFromCents: doc.priceFromCents, hasFreeTier: doc.hasFreeTier, budgetMinCents: doc.budgetMinCents,
    budgetMaxCents: doc.budgetMaxCents, actSize: doc.actSize, hasAudio: doc.hasAudio, followerCount: doc.followerCount,
    distanceMeters,
  };
}

export function toSearchPin(doc: SearchIndexDoc): SearchPin {
  return { id: doc.sourceId, kind: doc.kind, title: doc.title, subtitle: doc.subtitle, geo: doc.geo!, startsAt: doc.startsAt };
}

async function loadFollows(db: Firestore, uid: string): Promise<{ profiles: Set<string>; genres: Set<string> }> {
  const snap = await db.collection("follows").where("uid", "==", uid).limit(MAX_FOLLOWS_PER_USER).get();
  const profiles = new Set<string>(); const genres = new Set<string>();
  for (const d of snap.docs) {
    const f = d.data() as FollowDoc;
    const g = parseGenreTarget(f.targetId);
    if (g) genres.add(g); else profiles.add(f.targetId);
  }
  return { profiles, genres };
}

export const search = onCall<SearchInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const v = validateSearchInput(req.data);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  const input = v.input;
  await consumeSearchBudget(uid);

  const db = getFirestore();
  const now = Date.now();
  const kind = kindForFace(input.face);
  const words = queryWords(input.q);

  let q: FirebaseFirestore.Query = db.collection("searchIndex").where("kind", "==", kind);
  if (words.length > 0) q = q.where("tokens", "array-contains-any", words);
  if (kind === "show" || kind === "gig") {
    const win = whenWindow(input.filters.when ?? "any", now);
    q = q.where("startsAt", ">=", win.start);
    if (win.end !== null) q = q.where("startsAt", "<=", win.end);
    q = q.orderBy("startsAt", "asc");
  } else {
    q = q.orderBy("followerCount", "desc");
  }
  const snap = await q.limit(SEARCH_CANDIDATE_CAP).get();

  const follows = await loadFollows(db, uid);
  const ctx = { now, hasLocation: input.location !== null, followedProfiles: follows.profiles, followedGenres: follows.genres, queryWords: words };
  const ranked: Ranked[] = [];
  for (const d of snap.docs) {
    const doc = d.data() as SearchIndexDoc;
    if (words.length > 0 && !matchesText(doc, words)) continue;
    if (!matchesFilters(doc, input.filters, now)) continue;
    const distanceMeters = input.location && doc.geo ? haversineMeters(input.location, doc.geo) : null;
    if (input.filters.nearMe && input.location && (distanceMeters === null || distanceMeters > SEARCH_NEAR_ME_METERS)) continue;
    ranked.push({ doc, distanceMeters, score: scoreResult(doc, distanceMeters, ctx) });
  }
  ranked.sort(compareRanked);

  const start = input.page * SEARCH_PAGE_SIZE;
  const out: SearchOutput = {
    items: ranked.slice(start, start + SEARCH_PAGE_SIZE).map((r) => toSearchResult(r.doc, r.distanceMeters)),
    page: input.page, hasMore: ranked.length > start + SEARCH_PAGE_SIZE, matched: ranked.length,
  };
  if (input.includePins) out.pins = ranked.filter((r) => r.doc.geo !== null).slice(0, SEARCH_PIN_CAP).map((r) => toSearchPin(r.doc));
  return out;
});

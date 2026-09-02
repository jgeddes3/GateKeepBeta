import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  DECK_PAGE_SIZE, DECK_WINDOW_MS, DECK_MAX_EXCLUDE_IDS, haversineMeters, parseGenreTarget,
  type DeckCard, type DeckPreview, type DeckNextShow, type EventDoc, type ProfileDoc, type FollowDoc, type TrackDoc,
  type ShowPostDoc, type GetDiscoverDeckInput, type GetDiscoverDeckResult, type MusicianSubtype,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { rankDeck, type DeckCandidate } from "./discoverRank.js";

const EVENT_LIMIT = 100; const ARTIST_LIMIT = 150; const VENUE_LIMIT = 100;
type Geo = { lat: number; lng: number };

function validateInput(data: unknown): { location: Geo | null; excludeIds: Set<string>; seed: number } {
  const d = (data ?? {}) as GetDiscoverDeckInput;
  let location: Geo | null = null;
  if (d.location !== undefined) {
    const { lat, lng } = d.location as Geo;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpsError("invalid-argument", "Invalid location.");
    }
    location = { lat, lng };
  }
  const excludeIds = new Set<string>();
  if (d.excludeIds !== undefined) {
    if (!Array.isArray(d.excludeIds) || d.excludeIds.length > DECK_MAX_EXCLUDE_IDS
        || d.excludeIds.some((x) => typeof x !== "string" || x.length > 80)) {
      throw new HttpsError("invalid-argument", "Invalid exclude list.");
    }
    for (const x of d.excludeIds) excludeIds.add(x);
  }
  const seed = typeof d.seed === "number" && Number.isInteger(d.seed) && d.seed >= 0
    ? d.seed : Math.floor(Math.random() * 2 ** 31);
  return { location, excludeIds, seed };
}

async function firstApprovedTrack(db: Firestore, profileId: string): Promise<{ track: TrackDoc } | null> {
  const snap = await db.collection(`profiles/${profileId}/tracks`).where("status", "==", "approved").orderBy("order").limit(1).get();
  if (snap.empty) return null;
  return { track: snap.docs[0].data() as TrackDoc };
}
async function previewFor(db: Firestore, profileIds: string[], nameOf: (id: string) => string): Promise<DeckPreview> {
  for (const id of profileIds) {
    const hit = await firstApprovedTrack(db, id);
    if (hit && hit.track.storagePath) {
      return { trackPath: hit.track.storagePath, startSec: hit.track.startSec, durationSec: hit.track.durationSec ?? 0, artistName: nameOf(id) };
    }
  }
  return null;
}

export const getDiscoverDeck = onCall<GetDiscoverDeckInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const { location, excludeIds, seed } = validateInput(req.data);
  const db = getFirestore();
  const now = Date.now();

  const followsSnap = await db.collection("follows").where("uid", "==", uid).limit(500).get();
  const followedProfiles = new Set<string>(); const followedGenres = new Set<string>();
  for (const d of followsSnap.docs) {
    const f = d.data() as FollowDoc;
    const g = parseGenreTarget(f.targetId);
    if (g) followedGenres.add(g); else followedProfiles.add(f.targetId);
  }

  const [eventsSnap, artistsSnap, venuesSnap] = await Promise.all([
    db.collection("events").where("status", "==", "published").where("startsAt", ">=", now)
      .where("startsAt", "<=", now + DECK_WINDOW_MS).orderBy("startsAt").limit(EVENT_LIMIT).get(),
    db.collection("profiles").where("type", "==", "musician").where("status", "==", "approved")
      .orderBy("updatedAt", "desc").limit(ARTIST_LIMIT).get(),
    db.collection("profiles").where("type", "==", "curator").where("subtype", "==", "venue")
      .where("status", "==", "approved").limit(VENUE_LIMIT).get(),
  ]);
  const events = eventsSnap.docs.map((d) => ({ id: d.id, ev: d.data() as EventDoc }));
  const artists = artistsSnap.docs.map((d) => ({ id: d.id, p: d.data() as ProfileDoc }));
  const venues = venuesSnap.docs.map((d) => ({ id: d.id, p: d.data() as ProfileDoc }));

  // Earliest upcoming show per artist and per venue, from the same event window.
  const nextByArtist = new Map<string, { id: string; ev: EventDoc }>();
  const nextByVenue = new Map<string, { id: string; ev: EventDoc }>();
  for (const e of events) {
    if (!nextByVenue.has(e.ev.curatorProfileId)) nextByVenue.set(e.ev.curatorProfileId, e);
    for (const mid of e.ev.lineupMusicianProfileIds) if (!nextByArtist.has(mid)) nextByArtist.set(mid, e);
  }
  const dist = (geo: Geo | null | undefined): number | null => (location && geo ? haversineMeters(location, geo) : null);

  const candidates: DeckCandidate[] = [];
  for (const e of events) {
    if (excludeIds.has(e.id)) continue;
    const boost = followedProfiles.has(e.ev.curatorProfileId) || e.ev.lineupMusicianProfileIds.some((m) => followedProfiles.has(m));
    candidates.push({ id: e.id, kind: "show", genres: e.ev.genres ?? [], startsAt: e.ev.startsAt, distanceMeters: dist(e.ev.location.geo), followedBoost: boost });
  }
  for (const a of artists) {
    if (excludeIds.has(a.id) || followedProfiles.has(a.id)) continue;
    const next = nextByArtist.get(a.id);
    candidates.push({ id: a.id, kind: "artist", genres: a.p.portfolio?.genres ?? [], startsAt: next?.ev.startsAt ?? null,
      distanceMeters: next ? dist(next.ev.location.geo) : null, followedBoost: false });
  }
  for (const v of venues) {
    if (excludeIds.has(v.id) || followedProfiles.has(v.id)) continue;
    const next = nextByVenue.get(v.id);
    candidates.push({ id: v.id, kind: "venue", genres: v.p.curator?.lookingFor?.genres ?? [], startsAt: next?.ev.startsAt ?? null,
      distanceMeters: dist(v.p.curator?.location?.geo), followedBoost: false });
  }

  const page = rankDeck(candidates, { followedGenres, now, hasLocation: location !== null, seed }, DECK_PAGE_SIZE);

  // Resolve the page's supporting docs (curator handles for shows, previews, latest posts): bounded by the page size.
  const eventById = new Map(events.map((e) => [e.id, e.ev]));
  const artistById = new Map(artists.map((a) => [a.id, a.p]));
  const venueById = new Map(venues.map((v) => [v.id, v.p]));
  const profileName = async (id: string): Promise<{ name: string; handle: string | null }> => {
    const known = artistById.get(id) ?? venueById.get(id);
    if (known) return { name: known.name, handle: known.handle ?? null };
    const s = await db.doc(`profiles/${id}`).get();
    const p = s.data() as ProfileDoc | undefined;
    return { name: p?.name ?? "", handle: p?.handle ?? null };
  };

  const cards: DeckCard[] = await Promise.all(page.map(async (c): Promise<DeckCard> => {
    if (c.kind === "show") {
      const ev = eventById.get(c.id)!;
      const curator = await profileName(ev.curatorProfileId);
      const nameOf = (id: string) => ev.lineup.find((a) => a.kind === "booking" && a.musicianProfileId === id)?.name ?? "";
      const [preview, postSnap] = await Promise.all([
        previewFor(db, ev.lineupMusicianProfileIds, nameOf),
        db.collection(`events/${c.id}/posts`).where("status", "==", "live").orderBy("createdAt", "desc").limit(1).get(),
      ]);
      const post = postSnap.empty ? null : (postSnap.docs[0].data() as ShowPostDoc);
      return { kind: "show", id: c.id, eventId: c.id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt,
        venueName: ev.location.venueName ?? curator.name, neighborhood: ev.location.neighborhood, distanceMeters: c.distanceMeters,
        posterPath: ev.posterPath, lineupNames: ev.lineup.map((a) => a.name), curatorProfileId: ev.curatorProfileId, curatorHandle: curator.handle,
        priceFromCents: ev.priceFromCents ?? null, hasFreeTier: ev.hasFreeTier ?? false,
        latestPost: post ? { text: post.text, artistName: nameOf(post.musicianProfileId) } : null,
        genres: ev.genres ?? [], preview };
    }
    if (c.kind === "artist") {
      const p = artistById.get(c.id)!;
      const next = nextByArtist.get(c.id);
      const nextShow: DeckNextShow = next ? { eventId: next.id, title: next.ev.title, venueName: next.ev.location.venueName ?? "", startsAt: next.ev.startsAt } : null;
      return { kind: "artist", id: c.id, profileId: c.id, handle: p.handle, name: p.name, subtype: p.subtype as MusicianSubtype,
        genres: p.portfolio?.genres ?? [], coverPhotoPath: p.portfolio?.coverPhotoPath ?? null, avatarPhotoPath: p.portfolio?.avatarPhotoPath ?? null,
        nextShow, preview: await previewFor(db, [c.id], () => p.name) };
    }
    const p = venueById.get(c.id)!;
    const next = nextByVenue.get(c.id);
    const nextShow: DeckNextShow = next ? { eventId: next.id, title: next.ev.title, venueName: p.name, startsAt: next.ev.startsAt } : null;
    const preview = next
      ? await previewFor(db, next.ev.lineupMusicianProfileIds, (id) => next.ev.lineup.find((a) => a.kind === "booking" && a.musicianProfileId === id)?.name ?? "")
      : null;
    return { kind: "venue", id: c.id, profileId: c.id, handle: p.handle, name: p.name, neighborhood: p.curator?.location?.neighborhood ?? null,
      distanceMeters: c.distanceMeters, photoPath: p.curator?.photoPaths?.[0] ?? null, genres: p.curator?.lookingFor?.genres ?? [], nextShow, preview };
  }));

  const result: GetDiscoverDeckResult = { cards, seed };
  return result;
});

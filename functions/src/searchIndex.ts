import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall } from "firebase-functions/v2/https";
import { getFirestore, type Firestore, type DocumentReference } from "firebase-admin/firestore";
import {
  normalizeWords, buildTokens, dayKeyInLaunchZone, SEARCH_BUSY_DAYS_WINDOW_MS,
  type SearchIndexDoc, type SearchKind, type EventDoc, type GigDoc, type ProfileDoc, type BookingRequestDoc,
  type BookingDoc, type ActSize,
} from "@gatekeep/shared";
import { requireAdmin } from "./review.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY_BOOKINGS_CAP = 50;
const BUSY_EVENTS_CAP = 50;

export function indexDocId(kind: SearchKind, sourceId: string): string { return `${kind}_${sourceId}`; }

function text(...parts: Array<string | null | undefined>): { words: string[]; tokens: string[] } {
  const words = normalizeWords(parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" "));
  return { words, tokens: buildTokens(words) };
}

const lower = (s: string | null | undefined): string | null => (s ? s.toLowerCase() : null);

const base = (kind: SearchKind, sourceId: string, now: number): SearchIndexDoc => ({
  kind, sourceId, handle: null, title: "", subtitle: "", words: [], tokens: [], genres: [],
  city: null, cityLower: null, neighborhood: null, geo: null, startsAt: null, endsAt: null,
  priceFromCents: null, hasFreeTier: false,
  // SP11 Task 1 default; Task 6 projects the event's value
  ageRestriction: "all_ages",
  budgetMinCents: null, budgetMaxCents: null, actSize: null,
  hasAudio: false, busyDays: [], relatedProfileIds: [], followerCount: 0, imagePath: null, updatedAt: now,
});

// ---------- pure projections ----------

export function projectShow(eventId: string, event: EventDoc | undefined, now: number): SearchIndexDoc | null {
  if (!event || event.status !== "published" || event.endsAt < now) return null;
  const venueName = event.location.venueName ?? null;
  const lineup = event.lineup ?? [];
  const lineupMusicianProfileIds = event.lineupMusicianProfileIds ?? [];
  const { words, tokens } = text(event.title, ...lineup.map((a) => a.name), venueName, event.location.neighborhood);
  return {
    ...base("show", eventId, now), title: event.title, subtitle: venueName ?? event.location.city,
    words, tokens, genres: event.genres ?? [], city: event.location.city ?? null, cityLower: lower(event.location.city),
    neighborhood: event.location.neighborhood ?? null, geo: event.location.geo ?? null,
    startsAt: event.startsAt, endsAt: event.endsAt, priceFromCents: event.priceFromCents ?? null,
    hasFreeTier: event.hasFreeTier ?? false,
    relatedProfileIds: [...new Set([event.curatorProfileId, ...lineupMusicianProfileIds])],
    imagePath: event.posterPath ?? null,
  };
}

export function projectGig(gigId: string, gig: GigDoc | undefined, now: number): SearchIndexDoc | null {
  if (!gig || gig.status !== "open") return null;
  const venueName = gig.location.venueName ?? null;
  const { words, tokens } = text(gig.title, venueName, gig.location.neighborhood, gig.location.city);
  const subtitle = [venueName, gig.location.neighborhood].filter(Boolean).join(", ") || gig.location.city;
  return {
    ...base("gig", gigId, now), title: gig.title, subtitle, words, tokens, genres: gig.wants?.genres ?? [],
    city: gig.location.city ?? null, cityLower: lower(gig.location.city), neighborhood: gig.location.neighborhood ?? null,
    geo: gig.location.geo ?? null, startsAt: gig.startsAt, endsAt: null,
    budgetMinCents: gig.budget?.minCents ?? null, budgetMaxCents: gig.budget?.maxCents ?? null,
    relatedProfileIds: [gig.curatorProfileId],
  };
}

export interface ArtistExtras { hasAudio: boolean; busyDays: string[]; actSize: ActSize | null; now: number }

export function projectArtist(profileId: string, profile: ProfileDoc | undefined, extras: ArtistExtras): SearchIndexDoc | null {
  if (!profile || profile.type !== "musician" || profile.status !== "approved") return null;
  const { words, tokens } = text(profile.name, profile.handle);
  const loc = profile.portfolio?.location ?? null;
  const genres = profile.portfolio?.genres ?? [];
  return {
    ...base("artist", profileId, extras.now), handle: profile.handle, title: profile.name, subtitle: genres.join(", "),
    words, tokens, genres, city: loc?.city ?? null, cityLower: lower(loc?.city), geo: loc?.geo ?? null,
    actSize: extras.actSize, hasAudio: extras.hasAudio, busyDays: extras.busyDays, relatedProfileIds: [profileId],
    followerCount: profile.followerCount ?? 0, imagePath: profile.portfolio?.avatarPhotoPath ?? null,
  };
}

export function projectVenue(profileId: string, profile: ProfileDoc | undefined, now: number): SearchIndexDoc | null {
  if (!profile || profile.type !== "curator" || profile.status !== "approved") return null;
  const c = profile.curator;
  const { words, tokens } = text(profile.name, profile.handle, c?.location?.city, c?.location?.neighborhood);
  return {
    ...base("venue", profileId, now), handle: profile.handle, title: profile.name, subtitle: c?.location?.city ?? "",
    words, tokens, genres: c?.lookingFor?.genres ?? [], city: c?.location?.city ?? null, cityLower: lower(c?.location?.city),
    neighborhood: c?.location?.neighborhood ?? null, geo: c?.location?.geo ?? null, relatedProfileIds: [profileId],
    followerCount: profile.followerCount ?? 0, imagePath: c?.photoPaths?.[0] ?? null,
  };
}

// ---------- writer and rebuilds ----------

// A plain set-or-delete, no existence check: a pre-read here would mean one
// extra read per source in backfillSearchIndex's own walk over every
// profile/event/gig (fine for a trigger firing on one document, ruinous
// once the full test suite's shared database made that walk itself run
// past the emulator test's timeout). backfillSearchIndex instead knows
// which ids existed before it started, from its own one-time scan of
// searchIndex below, so it decides "deleted" vs "skipped" itself.
export async function applyProjection(ref: DocumentReference, doc: SearchIndexDoc | null): Promise<"set" | "deleted"> {
  if (doc) { await ref.set(doc); return "set"; }
  await ref.delete();
  return "deleted";
}

export async function rebuildArtistIndex(db: Firestore, profileId: string, now: number): Promise<"set" | "deleted"> {
  const ref = db.doc(`searchIndex/${indexDocId("artist", profileId)}`);
  const snap = await db.doc(`profiles/${profileId}`).get();
  const profile = snap.data() as ProfileDoc | undefined;
  if (!profile || profile.type !== "musician" || profile.status !== "approved") return applyProjection(ref, null);
  const [trackSnap, bookingSnap, confirmedSnap, eventsSnap] = await Promise.all([
    db.collection(`profiles/${profileId}/tracks`).where("status", "==", "approved").limit(1).get(),
    db.doc(`profiles/${profileId}/private/booking`).get(),
    db.collection("bookings").where("musicianProfileId", "==", profileId).where("status", "==", "confirmed").limit(BUSY_BOOKINGS_CAP).get(),
    db.collection("events").where("lineupMusicianProfileIds", "array-contains", profileId)
      .where("status", "==", "published").where("startsAt", ">=", now).orderBy("startsAt").limit(BUSY_EVENTS_CAP).get(),
  ]);
  const horizon = now + SEARCH_BUSY_DAYS_WINDOW_MS;
  const days = new Set<string>();
  const gigIds = [...new Set(confirmedSnap.docs.map((d) => (d.data() as BookingRequestDoc).gigId))];
  const gigSnaps = await Promise.all(gigIds.map((id) => db.doc(`gigs/${id}`).get()));
  for (const g of gigSnaps) {
    const gig = g.data() as GigDoc | undefined;
    if (gig && gig.startsAt >= now - DAY_MS && gig.startsAt <= horizon) days.add(dayKeyInLaunchZone(gig.startsAt));
  }
  for (const e of eventsSnap.docs) {
    const ev = e.data() as EventDoc;
    if (ev.startsAt <= horizon) days.add(dayKeyInLaunchZone(ev.startsAt));
  }
  const actSize = (bookingSnap.data() as BookingDoc | undefined)?.preferences?.actSize ?? null;
  return applyProjection(ref, projectArtist(profileId, profile, { hasAudio: !trackSnap.empty, busyDays: [...days].sort(), actSize, now }));
}

export async function rebuildVenueIndex(db: Firestore, profileId: string, now: number): Promise<"set" | "deleted"> {
  const snap = await db.doc(`profiles/${profileId}`).get();
  return applyProjection(db.doc(`searchIndex/${indexDocId("venue", profileId)}`), projectVenue(profileId, snap.data() as ProfileDoc | undefined, now));
}

export async function rebuildShowIndex(db: Firestore, eventId: string, now: number): Promise<"set" | "deleted"> {
  const snap = await db.doc(`events/${eventId}`).get();
  return applyProjection(db.doc(`searchIndex/${indexDocId("show", eventId)}`), projectShow(eventId, snap.data() as EventDoc | undefined, now));
}

export async function rebuildGigIndex(db: Firestore, gigId: string, now: number): Promise<"set" | "deleted"> {
  const snap = await db.doc(`gigs/${gigId}`).get();
  return applyProjection(db.doc(`searchIndex/${indexDocId("gig", gigId)}`), projectGig(gigId, snap.data() as GigDoc | undefined, now));
}

// ---------- triggers ----------
// Every body is wrapped so one poisoned document logs and returns instead
// of retrying forever (the repo's post-commit fan-out pattern).

export const onProfileWrittenSearch = onDocumentWritten("profiles/{profileId}", async (event) => {
  const profileId = event.params.profileId;
  try {
    const db = getFirestore();
    const before = event.data?.before.data() as ProfileDoc | undefined;
    const after = event.data?.after.data() as ProfileDoc | undefined;
    const type = after?.type ?? before?.type;
    const now = Date.now();
    if (type === "musician") await rebuildArtistIndex(db, profileId, now);
    else if (type === "curator") await rebuildVenueIndex(db, profileId, now);
  } catch (e) {
    console.error("searchIndex: profile trigger failed", profileId, e);
  }
});

export const onTrackWrittenSearch = onDocumentWritten("profiles/{profileId}/tracks/{trackId}", async (event) => {
  const profileId = event.params.profileId;
  try {
    const before = event.data?.before.data()?.status;
    const after = event.data?.after.data()?.status;
    if (before === after) return;
    await rebuildArtistIndex(getFirestore(), profileId, Date.now());
  } catch (e) {
    console.error("searchIndex: track trigger failed", profileId, e);
  }
});

export const onEventWrittenSearch = onDocumentWritten("events/{eventId}", async (event) => {
  const eventId = event.params.eventId;
  try {
    const db = getFirestore();
    const now = Date.now();
    const before = event.data?.before.data() as EventDoc | undefined;
    const after = event.data?.after.data() as EventDoc | undefined;
    await applyProjection(db.doc(`searchIndex/${indexDocId("show", eventId)}`), projectShow(eventId, after, now));
    const lineup = new Set<string>([...(before?.lineupMusicianProfileIds ?? []), ...(after?.lineupMusicianProfileIds ?? [])]);
    for (const profileId of lineup) await rebuildArtistIndex(db, profileId, now);
  } catch (e) {
    console.error("searchIndex: event trigger failed", eventId, e);
  }
});

export const onGigWrittenSearch = onDocumentWritten("gigs/{gigId}", async (event) => {
  const gigId = event.params.gigId;
  try {
    const after = event.data?.after.data() as GigDoc | undefined;
    await applyProjection(getFirestore().doc(`searchIndex/${indexDocId("gig", gigId)}`), projectGig(gigId, after, Date.now()));
  } catch (e) {
    console.error("searchIndex: gig trigger failed", gigId, e);
  }
});

export const onBookingWrittenSearch = onDocumentWritten("bookings/{bookingId}", async (event) => {
  const bookingId = event.params.bookingId;
  try {
    const before = event.data?.before.data() as BookingRequestDoc | undefined;
    const after = event.data?.after.data() as BookingRequestDoc | undefined;
    const wasConfirmed = before?.status === "confirmed";
    const isConfirmed = after?.status === "confirmed";
    if (wasConfirmed === isConfirmed) return;
    const profileId = after?.musicianProfileId ?? before?.musicianProfileId;
    if (profileId) await rebuildArtistIndex(getFirestore(), profileId, Date.now());
  } catch (e) {
    console.error("searchIndex: booking trigger failed", bookingId, e);
  }
});

// ---------- backfill and sweep ----------

const BACKFILL_PAGE = 300;

async function* pageCollection(db: Firestore, name: string) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection(name).orderBy("__name__").limit(BACKFILL_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.docs.length < BACKFILL_PAGE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

// Ids only (an empty field mask via .select()), so a full-database backfill
// pays for one cheap scan of searchIndex instead of one extra get() per
// source it walks (that per-source read was what made backfillSearchIndex
// itself time out under the full suite: 47 other test files leave hundreds
// of profiles/events/gigs in the shared emulator database, so this callable
// was already walking thousands of sources before this fix wave's
// per-delete pre-read piled another read onto every single one of them).
async function existingSearchIndexIds(db: Firestore): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection("searchIndex").select().orderBy("__name__").limit(BACKFILL_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return ids;
    for (const d of snap.docs) ids.add(d.id);
    if (snap.docs.length < BACKFILL_PAGE) return ids;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

// Admin one-shot after the first deploy (and safe to re-run): projects
// every profile, event, and gig through the same functions the triggers
// use. Counts are docs written per kind; `deleted` counts sources that
// resolved to "not public" and had a stale index doc removed (decided from
// existingSearchIndexIds's own pre-backfill snapshot, not a per-delete
// read, since applyProjection itself always just sets or deletes).
export const backfillSearchIndex = onCall<Record<string, never>>(
  { region: "us-central1", timeoutSeconds: 540, memory: "512MiB" },
  async (req) => {
    requireAdmin(req);
    const db = getFirestore();
    const now = Date.now();
    const existingIds = await existingSearchIndexIds(db);
    const counts = { artists: 0, venues: 0, shows: 0, gigs: 0, deleted: 0 };
    const tally = (kind: "artists" | "venues" | "shows" | "gigs", r: "set" | "deleted", indexId: string) => {
      if (r === "set") counts[kind]++;
      else if (existingIds.has(indexId)) counts.deleted++;
    };
    for await (const page of pageCollection(db, "profiles")) {
      for (const d of page) {
        const p = d.data() as ProfileDoc;
        if (p.type === "musician") tally("artists", await rebuildArtistIndex(db, d.id, now), indexDocId("artist", d.id));
        else if (p.type === "curator") tally("venues", await rebuildVenueIndex(db, d.id, now), indexDocId("venue", d.id));
      }
    }
    for await (const page of pageCollection(db, "events")) {
      for (const d of page) {
        const indexId = indexDocId("show", d.id);
        tally("shows", await applyProjection(db.doc(`searchIndex/${indexId}`), projectShow(d.id, d.data() as EventDoc, now)), indexId);
      }
    }
    for await (const page of pageCollection(db, "gigs")) {
      for (const d of page) {
        const indexId = indexDocId("gig", d.id);
        tally("gigs", await applyProjection(db.doc(`searchIndex/${indexId}`), projectGig(d.id, d.data() as GigDoc, now)), indexId);
      }
    }
    return counts;
  },
);

// Daily: drop show docs a day after they end. Open gigs that pass their
// start are closed by the sweep's past-gig step, and the gig trigger removes
// their index doc, so only shows need this.
export async function runSearchIndexSweep(db: Firestore, now: number): Promise<number> {
  let deleted = 0;
  const cutoff = now - DAY_MS;
  for (;;) {
    const snap = await db.collection("searchIndex").where("kind", "==", "show").where("endsAt", "<", cutoff).orderBy("endsAt").limit(BACKFILL_PAGE).get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BACKFILL_PAGE) return deleted;
  }
}

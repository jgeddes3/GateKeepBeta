import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import {
  validateHandle, type ProfileDoc, type TrackDoc, type GigDoc, type GigPublicLocation, type EventDoc,
} from "@gatekeep/shared";
import { MusicianProfile } from "./MusicianProfile";
import { CuratorProfile } from "./CuratorProfile";

// Takedowns/approvals need to propagate within about a minute, and this page
// can't be gated behind App Check (it's plain SSR, no client attestation),
// so ISR bounds repeat Firestore/Storage reads to once per handle per
// revalidate window instead of `force-dynamic`'s unbounded per-request reads.
// (A flood of distinct/random handles still costs one cold render each:
// this caps *repeat* hits on the same handle, not a broad crawl.)
export const revalidate = 60;
// Required for `revalidate` to take effect on a dynamic-params route: without
// this, Next treats the route as fully dynamic (no caching, revalidate is a
// no-op) per generate-static-params.md ("you must return an empty array ...
// in order to revalidate (ISR) paths at runtime"). An empty array means no
// paths are prerendered at build time; each handle is rendered (and cached)
// on its first request instead.
export function generateStaticParams() {
  return [];
}

export type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };
export type PublicGig = GigDoc & { id: string };

// Task 11 Shows entry: one filled/closed-booked gig, plus the OTHER party's
// resolved display name/handle (curator, on the musician page; booked
// musician, on the curator page, see resolveProfileLabels below).
// `location` is always populated (every GigDoc has one) even though only
// MusicianProfile.tsx's ShowCard renders it: the curator already knows
// their own gig's location.
// durationMinutes (Task 9 addition): public per the gigs read rule (a
// filled, or closed-and-booked, gig is readable by anyone regardless of
// query shape: see firestore.rules' comment on this exact disjunct), and
// already present on every GigDoc these queries already fetch in full. The
// past-shows page's member-only depth (spec 6.5) renders it alongside the
// private earned/true-up figures it DOES need a gated read for, so it rides
// along here at zero extra read cost rather than needing its own fetch.
export type ShowEntry = {
  gigId: string; title: string; startsAtMs: number; location: GigPublicLocation; durationMinutes: number;
  otherProfileName: string; otherProfileHandle: string | null;
};

// Sub-project 6 task 9: the "Upcoming events" section's row shape, both
// pages. Deliberately carries no poster: resolving posterPath ->
// getDownloadURL for every row would cost one extra Storage round trip per
// event on a section that already has DateBlockRow's own no-photo precedent
// (the Shows sections above render the same way, title + date + location,
// no image), so this stays cheap-to-fetch and consistent with that
// existing pattern rather than inventing a photo treatment nothing else on
// this page uses.
// Task 9: endsAtMs added (additive) alongside startsAtMs, so
// MusicianProfile.tsx's own ShowPostsForAct row (the show-post composer,
// which needs a show's end time to know when posting closes) has it on
// hand without a second per-event fetch. Curator rows carry the same field
// for type-shape parity even though CuratorProfile.tsx never mounts a
// composer.
export type UpcomingEventSummary = {
  eventId: string; title: string; startsAtMs: number; endsAtMs: number; location: GigPublicLocation;
};

export type MusicianLoaded = {
  kind: "musician";
  profileId: string;
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
  upcomingShows: ShowEntry[]; pastShows: ShowEntry[];
  upcomingEvents: UpcomingEventSummary[];
};
export type CuratorLoaded = {
  kind: "curator";
  profileId: string;
  profile: ProfileDoc;
  photoUrls: string[];
  openGigs: PublicGig[];
  upcomingShows: ShowEntry[]; pastShows: ShowEntry[];
  upcomingEvents: UpcomingEventSummary[];
};
type Loaded = MusicianLoaded | CuratorLoaded;

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch (e) {
    // Swallowed to null on purpose (a missing/racing object shouldn't 500 the
    // whole page), but a Storage-wide outage would otherwise silently empty
    // every avatar/cover/track/gallery URL with no signal anywhere: log it.
    console.warn("storageUrl failed", path, e);
    return null;
  }
}

// Batched cross-reference profile-name lookup for the Shows section below
// (curator names on the musician page, musician names on the curator page):
// one Promise.all over the *unique* ids in a Shows result set, not one
// sequential getDoc per row (n+1-avoidance, same shape the admin page's own
// TracksQueue/GigsAdmin batched name resolution uses). A single id's lookup
// failing, permission-denied (that profile has since gone
// unapproved/deleted) or any other read error, doesn't fail the whole Shows
// section: same "auxiliary content shouldn't 500 the whole page" tradeoff as
// storageUrl above, just falling back to an unlinked placeholder name for
// that one row instead of a null URL.
async function resolveProfileLabels(ids: string[]): Promise<Map<string, { name: string; handle: string | null }>> {
  const { db } = getServerFirebase();
  const unique = Array.from(new Set(ids));
  const entries = await Promise.all(unique.map(async (id): Promise<readonly [string, { name: string; handle: string | null }]> => {
    try {
      const snap = await getDoc(doc(db, "profiles", id));
      if (!snap.exists()) return [id, { name: "Unknown", handle: null }];
      const p = snap.data() as ProfileDoc;
      return [id, { name: p.name, handle: p.handle }];
    } catch (e) {
      // Duck-typed per loadProfile's own comment below: a stranger's
      // profile that went unapproved/private reads as permission-denied,
      // which is a legitimate (if unusual) state for a Shows row's OTHER
      // party, not a bug worth logging loudly.
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code !== "permission-denied" && code !== "not-found") {
        console.warn("resolveProfileLabels: lookup failed", id, e);
      }
      return [id, { name: "Unknown", handle: null }];
    }
  }));
  return new Map(entries);
}

// Musician-page Shows query (Task 11): a single `status in [...]` query is
// list-provable here because bookedMusicianProfileId is pinned by EQUALITY
// to one specific non-null profileId, see firestore.rules' own comment on
// the gigs read rule for why that alone proves the status=='closed'
// disjunct's `bookedMusicianProfileId != null` requirement (the curator page
// below can't take this shortcut, see loadCuratorShows). No `.limit()`: the
// Shows section's own design assumption (this task's plan) is that this
// returns at most a few dozen docs per profile at V1 scale: capping the
// ascending-ordered result at the Firestore level would bias toward the
// OLDEST rows instead of the ones nearest "now", so the 20/20 caps are
// applied in JS below, after the full (bounded-in-practice) result is in
// hand.
// Split out of loadMusicianShows (Task 9) so the new past-shows page (spec
// 6.5) can reuse the EXACT SAME query (no new where/orderBy clause, no new
// index) without loadMusicianShows' own 20-cap slice, which exists only for
// the artist page's fixed-height Shows-box PREVIEW: see
// loadAllPastMusicianShows below.
async function fetchMusicianShowEntries(profileId: string): Promise<ShowEntry[]> {
  const { db } = getServerFirebase();
  const snap = await getDocs(query(
    collection(db, "gigs"),
    where("bookedMusicianProfileId", "==", profileId),
    where("status", "in", ["filled", "closed"]),
    orderBy("startsAt")));
  const gigs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }));
  const labels = await resolveProfileLabels(gigs.map((g) => g.curatorProfileId));
  return gigs.map((g) => {
    const label = labels.get(g.curatorProfileId) ?? { name: "Unknown", handle: null };
    return {
      gigId: g.id, title: g.title, startsAtMs: g.startsAt, location: g.location, durationMinutes: g.durationMinutes,
      otherProfileName: label.name, otherProfileHandle: label.handle,
    };
  });
}

async function loadMusicianShows(profileId: string): Promise<{ upcoming: ShowEntry[]; past: ShowEntry[] }> {
  try {
    const entries = await fetchMusicianShowEntries(profileId);
    const now = Date.now();
    return {
      upcoming: entries.filter((e) => e.startsAtMs > now).slice(0, 20), // already ascending -> soonest first
      past: entries.filter((e) => e.startsAtMs <= now).slice(-20).reverse(), // newest first
    };
  } catch (e) {
    // Same "auxiliary content shouldn't 500 the whole page" tradeoff as
    // storageUrl above: an empty Shows section (indistinguishable from the
    // legitimate no-shows-yet case, per the section's own hidden-while-empty
    // contract) beats a 500 for every visitor to this profile.
    console.error("loadMusicianShows failed", profileId, e);
    return { upcoming: [], past: [] };
  }
}

// Task 9: app/u/[handle]/shows/page.tsx's own base-depth loader. Same query,
// same failure handling as loadMusicianShows above, just unsliced (this
// page's entire purpose is the FULL past-shows history, not a preview) and
// past-only (the new page links from the artist page's Shows box, which
// already covers upcoming shows itself).
export async function loadAllPastMusicianShows(profileId: string): Promise<ShowEntry[]> {
  try {
    const entries = await fetchMusicianShowEntries(profileId);
    const now = Date.now();
    return entries.filter((e) => e.startsAtMs <= now).reverse(); // newest first, matching loadMusicianShows' own past ordering
  } catch (e) {
    console.error("loadAllPastMusicianShows failed", profileId, e);
    return [];
  }
}

// Curator-page Shows query (Task 11): MUST split into two queries per the
// rules-provability constraint (Task 2 audit): a combined `status in`
// query filtered only by curatorProfileId can't prove the closed leg's
// `bookedMusicianProfileId != null` requirement (unlike the musician page's
// single query above, curatorProfileId doesn't pin bookedMusicianProfileId
// to anything). The closed leg's inequality filter (`> ""`) forces an
// implicit order by bookedMusicianProfileId when no explicit orderBy is
// given (not startsAt), so chronological ordering happens here, in JS,
// over the merged result, rather than at the query level for either leg.
async function loadCuratorShows(profileId: string): Promise<{ upcoming: ShowEntry[]; past: ShowEntry[] }> {
  try {
    const { db } = getServerFirebase();
    const [filledSnap, closedSnap] = await Promise.all([
      getDocs(query(collection(db, "gigs"),
        where("curatorProfileId", "==", profileId), where("status", "==", "filled"))),
      getDocs(query(collection(db, "gigs"),
        where("curatorProfileId", "==", profileId), where("status", "==", "closed"),
        where("bookedMusicianProfileId", ">", ""))),
    ]);
    const gigs = [...filledSnap.docs, ...closedSnap.docs]
      .map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))
      .sort((a, b) => a.startsAt - b.startsAt);
    const musicianIds = gigs
      .map((g) => g.bookedMusicianProfileId)
      .filter((id): id is string => id !== null);
    const labels = await resolveProfileLabels(musicianIds);
    const now = Date.now();
    const entries: ShowEntry[] = gigs.map((g) => {
      const label = g.bookedMusicianProfileId ? labels.get(g.bookedMusicianProfileId) : undefined;
      return {
        gigId: g.id, title: g.title, startsAtMs: g.startsAt, location: g.location, durationMinutes: g.durationMinutes,
        otherProfileName: label?.name ?? "Unknown", otherProfileHandle: label?.handle ?? null,
      };
    });
    return {
      upcoming: entries.filter((e) => e.startsAtMs > now).slice(0, 20),
      past: entries.filter((e) => e.startsAtMs <= now).slice(-20).reverse(),
    };
  } catch (e) {
    console.error("loadCuratorShows failed", profileId, e);
    return { upcoming: [], past: [] };
  }
}

// Sub-project 6 task 9: the musician page's "Upcoming events" query. The
// event doc's server-maintained lineupMusicianProfileIds array (functions/
// src/events.ts's deriveLineupMusicianProfileIds) is what makes an
// array-contains query provable at all: rules-provability here comes
// entirely from the status=='published' equality filter, exactly like
// loadCurator's own open-gigs query below (see that query's own comment);
// array-contains adds no further rules exposure of its own (firestore.rules
// only ever sees per-document field values, never which array element
// matched). See firestore.indexes.json for the composite index this needs
// (lineupMusicianProfileIds CONTAINS + status ASC + startsAt ASC).
async function loadMusicianUpcomingEvents(profileId: string): Promise<UpcomingEventSummary[]> {
  try {
    const { db } = getServerFirebase();
    const snap = await getDocs(query(
      collection(db, "events"),
      where("lineupMusicianProfileIds", "array-contains", profileId),
      where("status", "==", "published"),
      orderBy("startsAt")));
    return snap.docs.map((d) => {
      const e = d.data() as EventDoc;
      return { eventId: d.id, title: e.title, startsAtMs: e.startsAt, endsAtMs: e.endsAt, location: e.location };
    });
  } catch (e) {
    // Same "auxiliary content shouldn't 500 the whole page" tradeoff as
    // loadMusicianShows below: an empty section (indistinguishable from the
    // legitimate no-upcoming-events case, per this section's own
    // hidden-while-empty contract) beats a 500 for every visitor.
    console.error("loadMusicianUpcomingEvents failed", profileId, e);
    return [];
  }
}

// Curator-page equivalent of loadMusicianUpcomingEvents above: a single
// query is provable here (unlike loadCuratorShows' own split-query gigs
// case) because curatorProfileId pins nothing the events read rule needs
// beyond status=='published', which the query already carries as its own
// equality filter, matching loadCurator's open-gigs query below one for
// one.
async function loadCuratorUpcomingEvents(profileId: string): Promise<UpcomingEventSummary[]> {
  try {
    const { db } = getServerFirebase();
    const snap = await getDocs(query(
      collection(db, "events"),
      where("curatorProfileId", "==", profileId),
      where("status", "==", "published"),
      orderBy("startsAt")));
    return snap.docs.map((d) => {
      const e = d.data() as EventDoc;
      return { eventId: d.id, title: e.title, startsAtMs: e.startsAt, endsAtMs: e.endsAt, location: e.location };
    });
  } catch (e) {
    console.error("loadCuratorUpcomingEvents failed", profileId, e);
    return [];
  }
}

async function loadMusician(profileId: string, profile: ProfileDoc): Promise<MusicianLoaded> {
  const { db } = getServerFirebase();
  const trackSnap = await getDocs(query(
    collection(db, `profiles/${profileId}/tracks`),
    where("status", "==", "approved"), orderBy("order")));
  const [tracks, avatarUrl, coverUrl, shows, upcomingEvents] = await Promise.all([
    Promise.all(trackSnap.docs.map(async (t) => {
      const d = t.data() as TrackDoc;
      const url = await storageUrl(d.storagePath);
      return url ? { id: t.id, title: d.title, durationSec: d.durationSec, url } : null;
    })).then((rows) => rows.filter((t): t is LoadedTrack => t !== null)),
    storageUrl(profile.portfolio?.avatarPhotoPath),
    storageUrl(profile.portfolio?.coverPhotoPath),
    loadMusicianShows(profileId),
    loadMusicianUpcomingEvents(profileId),
  ]);
  return {
    kind: "musician", profileId, profile, tracks, avatarUrl, coverUrl,
    upcomingShows: shows.upcoming, pastShows: shows.past, upcomingEvents,
  };
}

async function loadCurator(profileId: string, profile: ProfileDoc): Promise<CuratorLoaded> {
  const { db } = getServerFirebase();
  const photoPaths = profile.curator?.photoPaths ?? [];
  // Anonymous, rules-governed read (same client SDK as everything else on
  // this page): firestore.rules' gigs read rule proves this exact shape
  // (status=='open' AND curatorProfileId=='X') for a stranger without a
  // membership/admin disjunct: see tests-rules/rules.test.ts's "public
  // open-gigs list may add a curatorProfileId equality filter (a curator's
  // public page's 'open gigs' section)" test. orderBy(startsAt) adds no
  // further rules exposure (rules only ever see per-document field values,
  // never result ordering): it only changes which composite index the
  // query needs at the datastore layer (see firestore.indexes.json).
  const [gigsSnap, photoUrls, shows, upcomingEvents] = await Promise.all([
    getDocs(query(
      collection(db, "gigs"),
      where("curatorProfileId", "==", profileId),
      where("status", "==", "open"),
      orderBy("startsAt"))),
    Promise.all(photoPaths.map((p) => storageUrl(p))).then((urls) => urls.filter((u): u is string => u !== null)),
    loadCuratorShows(profileId),
    loadCuratorUpcomingEvents(profileId),
  ]);
  const openGigs = gigsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }));
  return {
    kind: "curator", profileId, profile, photoUrls, openGigs,
    upcomingShows: shows.upcoming, pastShows: shows.past, upcomingEvents,
  };
}

// cache() dedupes this per-request across generateMetadata and the page body:
// both call loadProfile(handle) with the same argument, so React's per-request
// cache means the Firestore/Storage reads only actually happen once. Exported
// (Task 9) so the new past-shows page (app/u/[handle]/shows/page.tsx) can
// reuse this EXACT loader (same handle resolution, same approval gate, same
// permission-denied-as-404 handling) rather than a second, driftable copy.
export const loadProfile = cache(async (rawHandle: string): Promise<Loaded | null> => {
  const handle = rawHandle.toLowerCase(); // handles are stored lowercase
  // Finding 5: an unvalidated handle segment (e.g. "/@a/b", "/@..") used to
  // reach doc(db, "handles", handle) directly: Firestore's doc() throws on
  // a value containing "/", which propagated as an uncaught 500 instead of
  // a normal 404, and (since throws bypass the `return null` path below)
  // never got cached by ISR either, so every hit on a malformed handle paid
  // a fresh Firestore round-trip AND rendered as a 500. validateHandle is
  // already the source of truth for what a well-formed handle looks like
  // (createProfileDraft enforces the same shape server-side); reject
  // anything that doesn't match before it ever reaches doc().
  if (!validateHandle(handle).ok) return null;
  try {
    const { db } = getServerFirebase();
    const h = await getDoc(doc(db, "handles", handle));
    if (!h.exists()) return null;
    const profileId = h.data().profileId as string;
    const p = await getDoc(doc(db, "profiles", profileId)); // rules deny unless approved
    if (!p.exists()) return null;
    const profile = p.data() as ProfileDoc;
    // Sub-3 widens this route to curators, branching on profile.type: both
    // types share the exact same handle-lookup/approval-gate machinery
    // above (profiles/{id}'s read rule is status=='approved' regardless of
    // type), only the content loaded below differs.
    if (profile.type === "musician") return await loadMusician(profileId, profile);
    if (profile.type === "curator") return await loadCurator(profileId, profile);
    return null;
  } catch (e) {
    // Duck-typed, not `e instanceof FirestoreError`: FirebaseError's own
    // constructor runs `Object.setPrototypeOf(this, FirebaseError.prototype)`
    // (an ES5-target workaround in @firebase/util, still present in the
    // built SDK) which clobbers the prototype chain of every subclass
    // instance, so a real FirestoreError never passes `instanceof
    // FirestoreError`, only `instanceof FirebaseError`. Trusting that check
    // would send every FirestoreError down the "rethrow as 500" path below,
    // including permission-denied ones: turning "not approved" into a
    // 404-vs-500 enumeration oracle for handle existence.
    //
    // permission-denied = the profile/track isn't approved (rules deny the
    // read): that's a legitimate "not found" from the public's point of
    // view. not-found only fires if a doc vanishes between reads. Anything
    // else (offline, a missing index, a backend outage) is a real failure:
    // surface it as a truthful 500, not a silent "Not found" 200.
    const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
    if (code === "permission-denied" || code === "not-found") return null;
    console.error("portfolio load failed", handle, e);
    throw e;
  }
});

export async function generateMetadata(props: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  // The page component calls notFound() for the same null case, which
  // renders not-found.tsx's own `metadata` (its title) instead of whatever
  // this function returns, so only robots survives here in practice; keep
  // it anyway as a fallback for any caller that resolves metadata without
  // rendering the page (e.g. a metadata-only route consumer).
  if (!data) return { robots: { index: false } };
  const { profile } = data;
  let description: string;
  let imageUrl: string | null;
  if (data.kind === "musician") {
    const pf = profile.portfolio;
    description = pf?.bio?.slice(0, 160)
      || [`${profile.name} on GateKeep`, pf?.genres?.length ? pf.genres.join(", ") : null]
        .filter(Boolean).join(": ");
    imageUrl = data.coverUrl;
  } else {
    const c = profile.curator;
    description = c?.about?.slice(0, 160)
      || [`${profile.name} on GateKeep`, c?.lookingFor?.genres?.length ? c.lookingFor.genres.join(", ") : null]
        .filter(Boolean).join(": ");
    imageUrl = data.photoUrls[0] ?? null;
  }
  return {
    title: `${profile.name} (@${profile.handle}) · GateKeep`,
    description,
    alternates: { canonical: `/@${profile.handle}` },
    openGraph: {
      title: `${profile.name} on GateKeep`,
      description,
      url: `/@${profile.handle}`,
      type: "profile",
      ...(imageUrl ? { images: [imageUrl] } : {}),
    },
  };
}

export default async function PublicProfile(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) notFound();
  return data.kind === "musician" ? <MusicianProfile data={data} /> : <CuratorProfile data={data} />;
}

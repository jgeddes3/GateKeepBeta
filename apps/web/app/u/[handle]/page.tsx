import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import { validateHandle, type ProfileDoc, type TrackDoc, type GigDoc } from "@gatekeep/shared";
import { MusicianProfile } from "./MusicianProfile";
import { CuratorProfile } from "./CuratorProfile";

// Takedowns/approvals need to propagate within about a minute, and this page
// can't be gated behind App Check (it's plain SSR, no client attestation) —
// so ISR bounds repeat Firestore/Storage reads to once per handle per
// revalidate window instead of `force-dynamic`'s unbounded per-request reads.
// (A flood of distinct/random handles still costs one cold render each —
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

export type MusicianLoaded = {
  kind: "musician";
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
};
export type CuratorLoaded = {
  kind: "curator";
  profile: ProfileDoc;
  photoUrls: string[];
  openGigs: PublicGig[];
};
type Loaded = MusicianLoaded | CuratorLoaded;

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch (e) {
    // Swallowed to null on purpose (a missing/racing object shouldn't 500 the
    // whole page), but a Storage-wide outage would otherwise silently empty
    // every avatar/cover/track/gallery URL with no signal anywhere — log it.
    console.warn("storageUrl failed", path, e);
    return null;
  }
}

async function loadMusician(profileId: string, profile: ProfileDoc): Promise<MusicianLoaded> {
  const { db } = getServerFirebase();
  const trackSnap = await getDocs(query(
    collection(db, `profiles/${profileId}/tracks`),
    where("status", "==", "approved"), orderBy("order")));
  const [tracks, avatarUrl, coverUrl] = await Promise.all([
    Promise.all(trackSnap.docs.map(async (t) => {
      const d = t.data() as TrackDoc;
      const url = await storageUrl(d.storagePath);
      return url ? { id: t.id, title: d.title, durationSec: d.durationSec, url } : null;
    })).then((rows) => rows.filter((t): t is LoadedTrack => t !== null)),
    storageUrl(profile.portfolio?.avatarPhotoPath),
    storageUrl(profile.portfolio?.coverPhotoPath),
  ]);
  return { kind: "musician", profile, tracks, avatarUrl, coverUrl };
}

async function loadCurator(profileId: string, profile: ProfileDoc): Promise<CuratorLoaded> {
  const { db } = getServerFirebase();
  const photoPaths = profile.curator?.photoPaths ?? [];
  // Anonymous, rules-governed read (same client SDK as everything else on
  // this page) — firestore.rules' gigs read rule proves this exact shape
  // (status=='open' AND curatorProfileId=='X') for a stranger without a
  // membership/admin disjunct: see tests-rules/rules.test.ts's "public
  // open-gigs list may add a curatorProfileId equality filter (a curator's
  // public page's 'open gigs' section)" test. orderBy(startsAt) adds no
  // further rules exposure (rules only ever see per-document field values,
  // never result ordering) — it only changes which composite index the
  // query needs at the datastore layer (see firestore.indexes.json).
  const [gigsSnap, photoUrls] = await Promise.all([
    getDocs(query(
      collection(db, "gigs"),
      where("curatorProfileId", "==", profileId),
      where("status", "==", "open"),
      orderBy("startsAt"))),
    Promise.all(photoPaths.map((p) => storageUrl(p))).then((urls) => urls.filter((u): u is string => u !== null)),
  ]);
  const openGigs = gigsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }));
  return { kind: "curator", profile, photoUrls, openGigs };
}

// cache() dedupes this per-request across generateMetadata and the page body —
// both call loadProfile(handle) with the same argument, so React's per-request
// cache means the Firestore/Storage reads only actually happen once.
const loadProfile = cache(async (rawHandle: string): Promise<Loaded | null> => {
  const handle = rawHandle.toLowerCase(); // handles are stored lowercase
  // Finding 5: an unvalidated handle segment (e.g. "/@a/b", "/@..") used to
  // reach doc(db, "handles", handle) directly — Firestore's doc() throws on
  // a value containing "/", which propagated as an uncaught 500 instead of
  // a normal 404, and — since throws bypass the `return null` path below —
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
    // Sub-3 widens this route to curators, branching on profile.type — both
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
    // instance — so a real FirestoreError never passes `instanceof
    // FirestoreError`, only `instanceof FirebaseError`. Trusting that check
    // would send every FirestoreError down the "rethrow as 500" path below,
    // including permission-denied ones — turning "not approved" into a
    // 404-vs-500 enumeration oracle for handle existence.
    //
    // permission-denied = the profile/track isn't approved (rules deny the
    // read) — that's a legitimate "not found" from the public's point of
    // view. not-found only fires if a doc vanishes between reads. Anything
    // else (offline, a missing index, a backend outage) is a real failure —
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
  // this function returns — so only robots survives here in practice; keep
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
        .filter(Boolean).join(" — ");
    imageUrl = data.coverUrl;
  } else {
    const c = profile.curator;
    description = c?.about?.slice(0, 160)
      || [`${profile.name} on GateKeep`, c?.lookingFor?.genres?.length ? c.lookingFor.genres.join(", ") : null]
        .filter(Boolean).join(" — ");
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

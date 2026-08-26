import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";
import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";

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

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };
type Loaded = {
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
};

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch (e) {
    // Swallowed to null on purpose (a missing/racing object shouldn't 500 the
    // whole page), but a Storage-wide outage would otherwise silently empty
    // every avatar/cover/track URL with no signal anywhere — log it.
    console.warn("storageUrl failed", path, e);
    return null;
  }
}

// cache() dedupes this per-request across generateMetadata and the page body —
// both call loadProfile(handle) with the same argument, so React's per-request
// cache means the Firestore/Storage reads only actually happen once.
const loadProfile = cache(async (rawHandle: string): Promise<Loaded | null> => {
  const handle = rawHandle.toLowerCase(); // handles are stored lowercase
  try {
    const { db } = getServerFirebase();
    const h = await getDoc(doc(db, "handles", handle));
    if (!h.exists()) return null;
    const profileId = h.data().profileId as string;
    const p = await getDoc(doc(db, "profiles", profileId)); // rules deny unless approved
    if (!p.exists()) return null;
    const profile = p.data() as ProfileDoc;
    if (profile.type !== "musician") return null; // curator pages are sub-3
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
    return { profile, tracks, avatarUrl, coverUrl };
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
  const pf = profile.portfolio;
  const description = pf?.bio?.slice(0, 160)
    || [`${profile.name} on GateKeep`, pf?.genres?.length ? pf.genres.join(", ") : null]
      .filter(Boolean).join(" — ");
  return {
    title: `${profile.name} (@${profile.handle}) · GateKeep`,
    description,
    alternates: { canonical: `/@${profile.handle}` },
    openGraph: {
      title: `${profile.name} on GateKeep`,
      description,
      url: `/@${profile.handle}`,
      type: "profile",
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  };
}

export default async function PublicProfile(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) notFound();
  const { profile, tracks, avatarUrl, coverUrl } = data;
  const pf = profile.portfolio;
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
  return (
    <main className={styles.page}>
      {coverUrl
        ? <img className={styles.cover} src={coverUrl} alt="" />
        : <div className={styles.cover} aria-hidden />}
      <div className={styles.layout}>
        <aside className={styles.identity}>
          {avatarUrl && <img className={styles.avatar} src={avatarUrl} alt={`${profile.name} photo`} />}
          <h1>{profile.name}</h1>
          <p>@{profile.handle}</p>
          {pf?.genres && pf.genres.length > 0 && <p className={styles.genres}>{pf.genres.join(" · ")}</p>}
          {links.length > 0 && (
            <div className={styles.links}>
              {links.map((l) => (
                <a key={`${l.kind}:${l.url}`} href={l.url} rel="noopener noreferrer nofollow" target="_blank">{l.kind}</a>
              ))}
            </div>
          )}
        </aside>
        <div>
          {tracks.length > 0 && (
            <section className={`${styles.section} ${styles.tracks}`}>
              <h2>Listen</h2>
              {tracks.map((t) => <TrackPlayer key={t.id} title={t.title} url={t.url} durationSec={t.durationSec} />)}
            </section>
          )}
          {pf?.bio && (
            <section className={styles.section}>
              <h2>About</h2>
              <p className={styles.bio}>{pf.bio}</p>
            </section>
          )}
          {tracks.length === 0 && !pf?.bio && (
            <p className={styles.empty}>This artist hasn&apos;t added content yet.</p>
          )}
          {/* Shows: platform events only (spec §2). The events collection ships in
              sub-projects 4/6 — this section stays hidden until it has data. */}
        </div>
      </div>
    </main>
  );
}

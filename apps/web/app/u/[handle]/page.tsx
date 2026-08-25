import { cache } from "react";
import type { Metadata } from "next";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";
import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";

export const dynamic = "force-dynamic"; // live approval state on every request

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };
type Loaded = {
  profile: ProfileDoc; tracks: LoadedTrack[];
  avatarUrl: string | null; coverUrl: string | null;
};

async function storageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try { return await getDownloadURL(ref(getServerFirebase().storage, path)); }
  catch { return null; }
}

// cache() dedupes this per-request across generateMetadata and the page body —
// both call loadProfile(handle) with the same argument, so React's per-request
// cache means the Firestore/Storage reads only actually happen once.
const loadProfile = cache(async (handle: string): Promise<Loaded | null> => {
  const { db } = getServerFirebase();
  try {
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
    const tracks = (await Promise.all(trackSnap.docs.map(async (t) => {
      const d = t.data() as TrackDoc;
      const url = await storageUrl(d.storagePath);
      return url ? { id: t.id, title: d.title, durationSec: d.durationSec, url } : null;
    }))).filter((t): t is LoadedTrack => t !== null);
    return {
      profile, tracks,
      avatarUrl: await storageUrl(profile.portfolio?.avatarPhotoPath),
      coverUrl: await storageUrl(profile.portfolio?.coverPhotoPath),
    };
  } catch { return null; } // permission-denied = not approved = not found
});

export async function generateMetadata(props: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) return { title: "Not found · GateKeep" };
  const { profile } = data;
  const description = profile.portfolio?.bio?.slice(0, 160)
    || `${profile.name} on GateKeep — ${profile.portfolio?.genres?.join(", ")}`;
  return {
    title: `${profile.name} (@${profile.handle}) · GateKeep`,
    description,
    openGraph: {
      title: `${profile.name} on GateKeep`,
      description,
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  };
}

export default async function PublicProfile(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data) {
    return <main className={styles.page}><h1>Not found</h1><p>No profile at @{handle}.</p></main>;
  }
  const { profile, tracks, avatarUrl, coverUrl } = data;
  const pf = profile.portfolio;
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
          {pf?.externalLinks && pf.externalLinks.length > 0 && (
            <div className={styles.links}>
              {pf.externalLinks.map((l) => (
                <a key={l.url} href={l.url} rel="noopener noreferrer nofollow" target="_blank">{l.kind}</a>
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
          {/* Shows: platform events only (spec §2). The events collection ships in
              sub-projects 4/6 — this section stays hidden until it has data. */}
        </div>
      </div>
    </main>
  );
}

import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";
import type { MusicianLoaded } from "./page";

// Split out of page.tsx's default export when sub-3 widened this route to
// curators (see CuratorProfile.tsx) — the render body itself is unchanged
// from the SP2 original, just relocated so page.tsx can branch on
// `profile.type` between two type-specific components instead of growing one
// file with both layouts inline.
export function MusicianProfile({ data }: { data: MusicianLoaded }) {
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

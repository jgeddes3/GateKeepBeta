import { TrackPlayer } from "./TrackPlayer";
import styles from "./portfolio.module.css";
import type { MusicianLoaded, ShowEntry } from "./page";
import { formatGigDateTime, gigLocationLabel } from "./gigDisplay";
import { type ActSize, type AvailabilityPattern } from "@gatekeep/shared";

// Split out of page.tsx's default export when sub-3 widened this route to
// curators (see CuratorProfile.tsx) — the render body itself is unchanged
// from the SP2 original, just relocated so page.tsx can branch on
// `profile.type` between two type-specific components instead of growing one
// file with both layouts inline. Task 11 adds the Shows section (this
// musician's own filled/closed-booked gigs — the SP2 hidden-while-empty
// contract, now wired for real) and a public "Booking preferences" section
// (profile.publicBooking, when the musician has opted their preferences
// public — see BookingVisibility/rebuildBookingProjections. NEVER rates.)

const ACT_SIZE_LABEL: Record<ActSize, string> = { solo: "Solo", duo: "Duo", band: "Band" };
const AVAILABILITY_LABEL: Record<AvailabilityPattern, string> = {
  weekends: "Weekends", weeknights: "Weeknights", anytime: "Anytime", limited: "Limited",
};

// Task 11 Shows entry — venue-or-city at public precision (same
// gigLocationLabel used by CuratorProfile.tsx's own "Open gigs" list) plus a
// link to the booking curator's public page (unlinked plain text when the
// curator's handle isn't known — see page.tsx's resolveProfileLabels).
function ShowCard({ show }: { show: ShowEntry }) {
  return (
    <li className={styles.gigCard}>
      <strong>{show.title || "Untitled gig"}</strong>
      <p className={styles.gigMeta}>{formatGigDateTime(show.startsAtMs)} · {gigLocationLabel(show.location)}</p>
      <p className={styles.gigMeta}>
        {show.otherProfileHandle
          ? <a href={`/@${show.otherProfileHandle}`}>{show.otherProfileName}</a>
          : show.otherProfileName}
      </p>
    </li>
  );
}

export function MusicianProfile({ data }: { data: MusicianLoaded }) {
  const { profile, tracks, avatarUrl, coverUrl, upcomingShows, pastShows } = data;
  const pf = profile.portfolio;
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
  // Optional (not `publicBooking:`) on ProfileDoc — legacy pre-SP4 docs lack
  // the field entirely; `?? null` treats "absent" identically to "present
  // and explicitly null" (never public), per the field's own migration
  // comment in packages/shared/src/types.ts.
  const publicBooking = profile.publicBooking ?? null;
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
          {/* Booking preferences (Task 11): rendered only when this musician
              has opted their preferences public (BookingVisibility.preferences
              == "public") — rebuildBookingProjections is the sole writer of
              publicBooking. Rates are NEVER shown here, by design (spec
              decision 4) — this section literally cannot render them, since
              publicBooking's type (BookingPreferences) has no rate fields. */}
          {publicBooking && (
            <section className={styles.section}>
              <h2>Booking preferences</h2>
              <dl className={styles.amenities}>
                {publicBooking.actSize != null && (
                  <><dt>Act size</dt><dd>{ACT_SIZE_LABEL[publicBooking.actSize]}</dd></>
                )}
                {publicBooking.typicalSetMinutes != null && (
                  <><dt>Typical set</dt><dd>{publicBooking.typicalSetMinutes} min</dd></>
                )}
                {publicBooking.bringsOwnPA != null && (
                  <><dt>Brings own PA</dt><dd>{publicBooking.bringsOwnPA ? "Yes" : "No"}</dd></>
                )}
                {publicBooking.availabilityPattern != null && (
                  <><dt>Availability</dt><dd>{AVAILABILITY_LABEL[publicBooking.availabilityPattern]}</dd></>
                )}
              </dl>
            </section>
          )}
          {/* Shows (Task 11): filled/closed-booked gigs — the SP2 hidden-
              while-empty contract, now wired for real (was platform-events-
              only in SP2; SP4's booking flow is what actually populates it).
              Hidden entirely (not an empty-state message) when there are
              none, same as every other optional section on this page. */}
          {(upcomingShows.length > 0 || pastShows.length > 0) && (
            <section className={styles.section}>
              <h2>Shows</h2>
              {upcomingShows.length > 0 && (
                <>
                  <h3>Upcoming shows</h3>
                  <ul className={styles.gigList}>
                    {upcomingShows.map((s) => <ShowCard key={s.gigId} show={s} />)}
                  </ul>
                </>
              )}
              {pastShows.length > 0 && (
                <>
                  <h3>Past shows</h3>
                  <ul className={styles.gigList}>
                    {pastShows.map((s) => <ShowCard key={s.gigId} show={s} />)}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

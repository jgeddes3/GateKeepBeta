import styles from "./portfolio.module.css";
import type { CuratorLoaded, PublicGig, ShowEntry } from "./page";
import { type BudgetStructure, type CuratorDetails, type CuratorSubtype } from "@gatekeep/shared";
import { formatGigDateTime, gigLocationLabel } from "./gigDisplay";

// Sub-3's curator counterpart of MusicianProfile.tsx — same page.tsx SSR/ISR/
// canonical/404 machinery, different content: no avatar/cover (curators have
// no such fields — see CuratorDetails), just a gallery of curator.photoPaths,
// the profile's own about/amenities/lookingFor sections, and a public Open
// gigs listing. Task 11 adds a Shows section (this curator's own past/
// upcoming filled bookings, "featuring <musician>") below Open gigs.

const SUBTYPE_LABEL: Record<CuratorSubtype, string> = {
  venue: "Venue", planner: "Planner", individual_host: "Individual host",
};
const INDOOR_OUTDOOR_LABEL: Record<NonNullable<CuratorDetails["amenities"]["indoorOutdoor"]>, string> = {
  indoor: "Indoor", outdoor: "Outdoor", both: "Indoor & outdoor",
};
// Display-only duplicate of ../../../src/gigs/GigForms.tsx's
// BUDGET_STRUCTURE_LABEL: that module is "use client" (form components with
// hooks), and this page has no client boundary of its own to spend on
// importing it — same tradeoff CuratorForms.tsx/GigForms.tsx already accept
// for their own mirrored server-side soft caps (see those files' comments).
const BUDGET_STRUCTURE_LABEL: Record<BudgetStructure, string> = {
  perHour: "per hour", perSong: "per song", perSet: "per set",
};

// Display-only duplicate of ../../../src/gigs/GigForms.tsx's formatCents:
// same "$12.50 must not round to $13" fix, same import-boundary tradeoff as
// BUDGET_STRUCTURE_LABEL above.
const fmtCents = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`);

function mapUrl(location: CuratorDetails["location"]): string {
  const q = location.geo ? `${location.geo.lat},${location.geo.lng}` : (location.address ?? location.city);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function GigCard({ gig }: { gig: PublicGig }) {
  return (
    <li className={styles.gigCard}>
      <strong>{gig.title || "Untitled gig"}</strong>
      <p className={styles.gigMeta}>
        {formatGigDateTime(gig.startsAt)}
        {" · "}{fmtCents(gig.budget.minCents)}–{fmtCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
      </p>
      {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
        <p className={styles.gigMeta}>
          Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
        </p>
      )}
      <p className={styles.gigMeta}>{gigLocationLabel(gig.location)}</p>
    </li>
  );
}

// Task 11 Shows entry — this curator's own filled/closed-booked gig, tagged
// with the booked musician's name (linked to their public page when a handle
// is known — see page.tsx's resolveProfileLabels for the "profile since
// went private/deleted" fallback). No location line here (unlike
// MusicianProfile.tsx's ShowCard): it's the curator's own gig, they already
// know where it is.
function ShowCard({ show }: { show: ShowEntry }) {
  return (
    <li className={styles.gigCard}>
      <strong>{show.title || "Untitled gig"}</strong>
      <p className={styles.gigMeta}>{formatGigDateTime(show.startsAtMs)}</p>
      <p className={styles.gigMeta}>
        featuring{" "}
        {show.otherProfileHandle
          ? <a href={`/@${show.otherProfileHandle}`}>{show.otherProfileName}</a>
          : show.otherProfileName}
      </p>
    </li>
  );
}

export function CuratorProfile({ data }: { data: CuratorLoaded }) {
  const { profile, photoUrls, openGigs, upcomingShows, pastShows } = data;
  const c = profile.curator;
  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const amenities = c?.amenities;
  const hasAnyAmenity = !!amenities && (
    amenities.capacity != null || amenities.hasPA != null || amenities.hasBackline != null
    || amenities.indoorOutdoor != null || !!amenities.notes);
  const lookingFor = c?.lookingFor;
  const hasLookingFor = !!lookingFor && (lookingFor.genres.length > 0 || lookingFor.actSizes.length > 0 || !!lookingFor.notes);

  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <aside className={styles.identity}>
          <h1>{profile.name}</h1>
          <p>@{profile.handle}</p>
          <p className={styles.genres}>{SUBTYPE_LABEL[subtype]}</p>
          {/* Location: an address line (with a map link) for venues only —
              planners/individual hosts show just their home-base city, never
              a precise public location (spec §2/"Location & privacy"). */}
          {c?.location && (isVenue
            ? (c.location.address && (
                <p>
                  {c.location.address}
                  {" — "}
                  <a href={mapUrl(c.location)} target="_blank" rel="noopener noreferrer">Map</a>
                </p>
              ))
            : <p>{c.location.city}</p>)}
        </aside>
        <div>
          {photoUrls.length > 0 && (
            <section className={styles.section}>
              <h2>Photos</h2>
              <div className={styles.gallery}>
                {photoUrls.map((url) => (
                  <img key={url} className={styles.galleryPhoto} src={url} alt={`${profile.name} photo`} />
                ))}
              </div>
            </section>
          )}
          {c?.about && (
            <section className={styles.section}>
              <h2>About</h2>
              <p className={styles.bio}>{c.about}</p>
            </section>
          )}
          {hasAnyAmenity && amenities && (
            <section className={styles.section}>
              <h2>Amenities</h2>
              <dl className={styles.amenities}>
                {amenities.capacity != null && (<><dt>Capacity</dt><dd>{amenities.capacity}</dd></>)}
                {amenities.hasPA != null && (<><dt>PA system</dt><dd>{amenities.hasPA ? "Yes" : "No"}</dd></>)}
                {amenities.hasBackline != null && (<><dt>Backline</dt><dd>{amenities.hasBackline ? "Yes" : "No"}</dd></>)}
                {amenities.indoorOutdoor != null && (<><dt>Space</dt><dd>{INDOOR_OUTDOOR_LABEL[amenities.indoorOutdoor]}</dd></>)}
                {amenities.notes && (<><dt>Notes</dt><dd>{amenities.notes}</dd></>)}
              </dl>
            </section>
          )}
          {hasLookingFor && lookingFor && (
            <section className={styles.section}>
              <h2>What we&apos;re looking for</h2>
              {lookingFor.genres.length > 0 && <p className={styles.bio}>{lookingFor.genres.join(" · ")}</p>}
              {lookingFor.actSizes.length > 0 && <p className={styles.bio}>{lookingFor.actSizes.join(" · ")}</p>}
              {lookingFor.notes && <p className={styles.bio}>{lookingFor.notes}</p>}
            </section>
          )}
          {photoUrls.length === 0 && !c?.about && !hasAnyAmenity && !hasLookingFor && (
            <p className={styles.empty}>This curator hasn&apos;t added content yet.</p>
          )}
          {/* Open gigs: hidden entirely (not an empty-state message) when
              there are none — mirrors this page's other optional sections
              (About/Amenities/Looking for) and MusicianProfile.tsx's Shows
              section, all of which stay unmounted rather than rendering an
              empty shell. */}
          {openGigs.length > 0 && (
            <section className={styles.section}>
              <h2>Open gigs</h2>
              <ul className={styles.gigList}>
                {openGigs.map((g) => <GigCard key={g.id} gig={g} />)}
              </ul>
            </section>
          )}
          {/* Shows (Task 11): this curator's own filled/closed-booked gigs —
              the SP2 hidden-while-empty contract, now real. Hidden entirely
              (not an empty-state message) when there are none, same as every
              other optional section on this page. */}
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
          {/* Upcoming Events: platform-ticketed events for this curator ship
              in sub-6 (spec §"Out (later sub-projects)") — a DIFFERENT
              feature from the Shows section above (that's this curator's
              booked-gig history; this is platform ticketing) — hidden until
              that collection exists. */}
        </div>
      </div>
    </main>
  );
}

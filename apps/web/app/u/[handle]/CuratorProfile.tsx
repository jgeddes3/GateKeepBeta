import type { CuratorLoaded, PublicGig, ShowEntry } from "./page";
import { type CuratorDetails, type CuratorSubtype } from "@gatekeep/shared";
import { formatGigTime, gigLocationLabel } from "./gigDisplay";
import { GalleryLightbox } from "./GalleryLightbox";
import { DateBlockRow } from "../../../src/components/DateBlockRow";
import { GigCard } from "../../../src/components/GigCard";
import { Badge } from "../../../src/ui/badge";
import { Button } from "../../../src/ui/button";
import { formatChipLabel } from "./chipLabel";
import { IconImages } from "../../../src/ui/icons";
import { cn } from "../../../src/lib/utils";

// Sub-project 9A task 10: full restyle to the owner-locked anatomy (spec
// section 6.6, docs/superpowers/mocks/sp9a/venue-page.html): the owner's
// pick is option A's COLLAGE HEADER (Airbnb-style anchor photo + grid, with
// an "Open gallery" bubble opening a dialog lightbox) COMBINED WITH option
// B's FACTS CARD in the body. Locked order: collage, name + chips + CTA,
// facts card, about, looking-for, open gigs (shared GigCard), location
// line, Shows (Task 11 content, preserved).
//
// portfolio.module.css (the Task 1 casualty MusicianProfile.tsx's own
// comment tracked) is DROPPED here too, same as that file: replaced by
// gk-* tokens and src/ui components. Both of this route's own components
// now use it nowhere, so the module is deleted (not-found.tsx, this
// module's last other importer, is restyled in the same commit).

const SUBTYPE_LABEL: Record<CuratorSubtype, string> = {
  venue: "Venue", planner: "Planner", individual_host: "Individual host",
};
const INDOOR_OUTDOOR_LABEL: Record<NonNullable<CuratorDetails["amenities"]["indoorOutdoor"]>, string> = {
  indoor: "Indoor", outdoor: "Outdoor", both: "Indoor & outdoor",
};

function mapUrl(location: CuratorDetails["location"]): string {
  const q = location.geo ? `${location.geo.lat},${location.geo.lng}` : (location.address ?? location.city);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Display-only duplicate of src/bookings/GigBrowse.tsx's own (unexported,
// "use client") gigBadgeLabel: same rationale as this file's other local
// duplicates below (BUDGET_STRUCTURE_LABEL used to live here for the same
// reason): a Server Component can't import a value out of a "use client"
// module. The badge only ever claims what's provable from the public gig
// doc alone (real status, whether it belongs to a series), the same
// constraint GigBrowse.tsx's own comment documents.
function gigBadgeLabel(gig: PublicGig): string {
  return gig.seriesId != null ? "Recurring series" : "Open for applications";
}

// Collage header (spec 6.6, mock option A): one anchor photo plus up to
// four side tiles, adapting by count rather than a single fixed shape:
//   0 photos: an honest empty state (no anchor exists to show).
//   1 photo: the anchor alone, full-bleed, no side grid.
//   2-4 photos: anchor + 1-3 side tiles ("the smaller collage").
//   5+ photos: anchor + 4 side tiles (the full Airbnb 1+4 shape), the last
//     tile carrying a "+N" overlay for whatever didn't make the grid (all
//     still reachable through the lightbox, which carries the full list).
// The side grid's own column/row count is picked per tile count so nothing
// ever leaves a visibly empty cell: 1 tile fills the whole area, 2 stack,
// 3 uses a 2x2 grid with the last tile spanning both columns, 4 fills the
// 2x2 grid exactly.
function CollageHeader({ photos, name }: { photos: string[]; name: string }) {
  const anchor = photos[0];
  const sideTiles = photos.slice(1, 5);
  const overflow = photos.length - 5;

  return (
    <div className="relative overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
      {photos.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-gk-muted sm:h-80">
          <IconImages size={26} aria-hidden="true" />
          <span className="font-sora text-sm">No photos yet</span>
        </div>
      ) : sideTiles.length === 0 ? (
        <img src={anchor} alt={`${name} photo`} className="h-64 w-full object-cover sm:h-80 lg:h-96" />
      ) : (
        <div className="flex h-64 gap-1 sm:h-80 lg:h-96">
          <img src={anchor} alt={`${name} photo 1`} className="h-full flex-[2] object-cover" />
          <div
            className={cn(
              "grid flex-1 gap-1",
              sideTiles.length === 1 && "grid-cols-1 grid-rows-1",
              sideTiles.length === 2 && "grid-cols-1 grid-rows-2",
              sideTiles.length >= 3 && "grid-cols-2 grid-rows-2",
            )}
          >
            {sideTiles.map((url, i) => {
              const isLast = i === sideTiles.length - 1;
              return (
                <div
                  key={url}
                  className={cn("relative", sideTiles.length === 3 && isLast && "col-span-2")}
                >
                  <img src={url} alt={`${name} photo ${i + 2}`} className="h-full w-full object-cover" />
                  {isLast && overflow > 0 && (
                    // Plain black scrim, not a gk-* token: same "chrome, not
                    // a brand color decision" exception src/ui/dialog.tsx's
                    // own overlay already documents, applied here to a
                    // photo tile instead of the whole viewport.
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 flex items-center justify-center bg-black/50 font-syne text-lg font-bold text-white"
                    >
                      +{overflow}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <GalleryLightbox photos={photos} name={name} triggerClassName="absolute bottom-3 right-3 sm:bottom-4 sm:right-4" />
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-sora text-xs text-gk-muted">{label}</dt>
      <dd className="font-sora text-sm text-gk-text">{value}</dd>
    </div>
  );
}

// Facts card (mock option B): capacity/PA/backline/indoor-outdoor as a
// structured grid, address (venue-only, per the same visibility rule the
// page already enforced pre-restyle) as a line below it, notes (real
// existing content the locked four-field list doesn't name, preserved the
// same way MusicianProfile.tsx kept booking preferences) as a further line.
// Only ever called when at least one of these actually has data, see
// hasFactsCard below.
function FactsCard({ amenities, address, addressHref }: {
  amenities: CuratorDetails["amenities"];
  address: string | null;
  addressHref: string;
}) {
  return (
    <div className="rounded-gk border border-gk-border bg-gk-surface p-4 sm:p-5">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Venue details</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {amenities.capacity != null && <FactRow label="Capacity" value={String(amenities.capacity)} />}
        {amenities.hasPA != null && <FactRow label="PA system" value={amenities.hasPA ? "Yes" : "No"} />}
        {amenities.hasBackline != null && <FactRow label="Backline" value={amenities.hasBackline ? "Yes" : "No"} />}
        {amenities.indoorOutdoor != null && <FactRow label="Space" value={INDOOR_OUTDOOR_LABEL[amenities.indoorOutdoor]} />}
      </dl>
      {address && (
        <p className="mt-4 border-t border-gk-border pt-3 font-sora text-sm text-gk-muted">
          {address}{" "}
          <a
            href={addressHref} target="_blank" rel="noopener noreferrer"
            className="text-gk-text underline underline-offset-4 outline-none hover:text-gk-focus focus-visible:ring-2 focus-visible:ring-gk-focus"
          >
            Map
          </a>
        </p>
      )}
      {amenities.notes && (
        <p className={cn("font-sora text-sm text-gk-muted", address ? "mt-2" : "mt-4 border-t border-gk-border pt-3")}>
          {amenities.notes}
        </p>
      )}
    </div>
  );
}

// Shows row (Task 11 content, preserved): same DateBlockRow pattern
// MusicianProfile.tsx's own ShowRow established for this route family
// (spec section 4's locked schedule-row anatomy). The booked musician's
// name renders as the row's plain-text detail slot, not a nested link:
// DateBlockRow already wraps the whole row in one <Link>, and nesting an
// anchor inside an anchor is invalid HTML (MusicianProfile.tsx's own
// ShowRow comment documents the same constraint).
function ShowRow({ show, isVenue }: { show: ShowEntry; isVenue: boolean }) {
  const time = formatGigTime(show.startsAtMs);
  return (
    <DateBlockRow
      dateMs={show.startsAtMs}
      title={show.title || "Untitled gig"}
      subtitle={isVenue ? time : `${gigLocationLabel(show.location)} · ${time}`}
      href={`/gigs/${show.gigId}`}
      detail={`featuring ${show.otherProfileName}`}
    />
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
  // Venue-vs-planner address visibility (unchanged from the pre-restyle
  // page): venues carry a full public street address; planners/individual
  // hosts show only a city, further down as the location line, never a
  // precise address (spec 2, "Location & privacy").
  const address = isVenue ? (c?.location?.address ?? null) : null;
  const hasFactsCard = hasAnyAmenity || !!address;
  const lookingFor = c?.lookingFor;
  const hasLookingFor = !!lookingFor && (lookingFor.genres.length > 0 || lookingFor.actSizes.length > 0 || !!lookingFor.notes);
  const hasShows = upcomingShows.length > 0 || pastShows.length > 0;
  const hasAnyContent = photoUrls.length > 0 || !!c?.about || hasAnyAmenity || hasLookingFor;

  const chips = [SUBTYPE_LABEL[subtype]];
  if (c?.location?.neighborhood) chips.push(c.location.neighborhood);
  if (amenities?.capacity != null) chips.push(`Capacity ${amenities.capacity}`);

  return (
    <main className="flex-1 pb-24">
      <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-8">
        {/* 1. COLLAGE HEADER */}
        <CollageHeader photos={photoUrls} name={profile.name} />

        {/* 2. NAME + CHIPS + CTA */}
        <div className="mt-5">
          <h1 className="font-syne text-2xl font-extrabold leading-none text-gk-text sm:text-4xl">{profile.name}</h1>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {chips.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
          </div>
          {openGigs.length > 0 && (
            <div className="mt-4">
              <Button asChild>
                <a href="#gigs">See open gigs ({openGigs.length})</a>
              </Button>
            </div>
          )}
        </div>

        {/* 3. FACTS CARD */}
        {hasFactsCard && amenities && (
          <section className="mt-8">
            <FactsCard amenities={amenities} address={address} addressHref={c?.location ? mapUrl(c.location) : "#"} />
          </section>
        )}

        {/* 4. ABOUT */}
        {c?.about && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">About</h2>
            <p className="mt-2 whitespace-pre-wrap font-sora text-sm leading-relaxed text-gk-text">{c.about}</p>
          </section>
        )}

        {/* 5. WHAT WE'RE LOOKING FOR: real existing content the locked
            anatomy list doesn't name, kept (this task restyles, never
            removes) the same way MusicianProfile.tsx kept booking
            preferences. Genres/act sizes render as the same chip treatment
            the hero chips above use, via the shared formatChipLabel. */}
        {hasLookingFor && lookingFor && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">What we&apos;re looking for</h2>
            {(lookingFor.genres.length > 0 || lookingFor.actSizes.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lookingFor.genres.map((g) => <Badge key={`genre:${g}`} variant="secondary">{formatChipLabel(g)}</Badge>)}
                {lookingFor.actSizes.map((a) => <Badge key={`act:${a}`} variant="secondary">{formatChipLabel(a)}</Badge>)}
              </div>
            )}
            {lookingFor.notes && (
              <p className="mt-2 whitespace-pre-wrap font-sora text-sm leading-relaxed text-gk-text">{lookingFor.notes}</p>
            )}
          </section>
        )}

        {!hasAnyContent && (
          <p className="mt-8 font-sora text-sm text-gk-muted">This curator hasn&apos;t added content yet.</p>
        )}

        {/* 6. OPEN GIGS: shared GigCard grid, matching the public "Find
            gigs" browse grid's own layout (src/bookings/GigBrowse.tsx).
            Unlike the pre-restyle page (and unlike this route's Shows
            section below), this section always renders, empty state
            included: the "See open gigs" CTA above anchors here, and a
            visitor who scrolls past it without clicking should still land
            on an honest reason rather than a section that silently
            vanished. */}
        <section id="gigs" className="mt-8 scroll-mt-4">
          <h2 className="font-syne text-lg font-semibold text-gk-text">Open gigs</h2>
          {openGigs.length > 0 ? (
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {openGigs.map((g) => <GigCard key={g.id} gig={g} badgeLabel={gigBadgeLabel(g)} />)}
            </div>
          ) : (
            <p className="mt-2 font-sora text-sm text-gk-muted">
              No open gigs right now. Check back soon, this venue posts new calls here as they open up.
            </p>
          )}
        </section>

        {/* 7. LOCATION LINE: non-venue subtypes only (venues already show
            their full address in the facts card above). */}
        {!isVenue && c?.location?.city && (
          <p className="mt-8 font-sora text-sm text-gk-muted">{c.location.city}</p>
        )}

        {/* Shows (Task 11): this curator's own filled/closed-booked gigs,
            hidden entirely (not an empty-state message) when there are
            none, unchanged from the pre-restyle page's own contract. */}
        {hasShows && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Shows</h2>
            {upcomingShows.length > 0 && (
              <div className="mt-2">
                <p className="px-2 pt-1 font-sora text-[11px] font-semibold uppercase tracking-wide text-gk-muted">Upcoming</p>
                {upcomingShows.map((s) => <ShowRow key={s.gigId} show={s} isVenue={isVenue} />)}
              </div>
            )}
            {pastShows.length > 0 && (
              <div className="mt-2">
                <p className="px-2 pt-1 font-sora text-[11px] font-semibold uppercase tracking-wide text-gk-muted">Past</p>
                {pastShows.map((s) => <ShowRow key={s.gigId} show={s} isVenue={isVenue} />)}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

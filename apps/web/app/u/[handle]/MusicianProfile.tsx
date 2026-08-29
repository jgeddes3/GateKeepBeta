import Link from "next/link";
import { TrackPlayer } from "./TrackPlayer";
import { HeroPlayButton } from "./HeroPlayButton";
import type { MusicianLoaded, ShowEntry } from "./page";
import { formatGigTime, gigLocationLabel } from "./gigDisplay";
import { type ActSize, type AvailabilityPattern, type ExternalLinkKind, type MusicianSubtype } from "@gatekeep/shared";
import { DateBlockRow } from "../../../src/components/DateBlockRow";
import { MiniPlayer } from "../../../src/components/MiniPlayer";
import { PhotoPlaceholder } from "../../../src/components/GigCard";
import { ACT_SIZE_LABEL as SUBTYPE_LABEL } from "../../../src/components/MusicianCard";
import { OfferGigButton } from "../../../src/bookings/OfferGigButton";
import { formatChipLabel } from "../../../src/portfolio/PortfolioForms";
import { Button } from "../../../src/ui/button";
import { Badge } from "../../../src/ui/badge";
import { IconInstagram, IconLink, IconSpotify, IconUser, IconWebsite, IconYoutube } from "../../../src/ui/icons";

// Sub-project 9A task 9: full restyle to the owner-locked anatomy (spec
// section 6.4, docs/superpowers/mocks/sp9a/artist-hero.html option A) with
// the owner's post-mock amendment: the genre/act-size line becomes CHIPS
// (option B's chip treatment) and a small avatar renders beside the
// overlaid Syne name. Locked order: hero, bio, Shows (fixed-height
// scrollable date-block box), tracks, external links, closing CTA.
//
// portfolio.module.css (the Task 1 casualty this task was asked to record a
// call on) is DROPPED for this component entirely, replaced by gk-* tokens
// and src/ui components below. It is NOT deleted from the repo:
// CuratorProfile.tsx and not-found.tsx (both out of this task's scope; the
// curator/venue page gets its own restyle in a later task, spec section 6.6)
// still import it, so it stays, trimmed to just what those two still use
// (see that file's own trim note).

const ACT_SIZE_LABEL: Record<ActSize, string> = { solo: "Solo", duo: "Duo", band: "Band" };
const AVAILABILITY_LABEL: Record<AvailabilityPattern, string> = {
  weekends: "Weekends", weeknights: "Weeknights", anytime: "Anytime", limited: "Limited",
};
const EXTERNAL_LINK_ICON: Record<ExternalLinkKind, typeof IconLink> = {
  spotify: IconSpotify, youtube: IconYoutube, instagram: IconInstagram, website: IconWebsite,
};
const EXTERNAL_LINK_LABEL: Record<ExternalLinkKind, string> = {
  spotify: "Spotify", youtube: "YouTube", instagram: "Instagram", website: "Website",
};

// Shows-box row (Task 9): DateBlockRow per spec section 4's locked pattern,
// linking to the gig's own detail page (a new behavior this task adds; the
// pre-restyle version linked only the OTHER party's name, and the row
// itself wasn't clickable). The other party's name still renders, as the
// row's right-aligned "detail" slot, but as plain text now rather than a
// second nested link: DateBlockRow already wraps the whole row in one
// <Link>, and nesting an anchor inside an anchor is invalid HTML (the same
// rule GigCard/MusicianCard's own "whole card clickable" comments state).
function ShowRow({ show }: { show: ShowEntry }) {
  return (
    <DateBlockRow
      dateMs={show.startsAtMs}
      title={show.title || "Untitled gig"}
      subtitle={`${gigLocationLabel(show.location)} · ${formatGigTime(show.startsAtMs)}`}
      href={`/gigs/${show.gigId}`}
      detail={show.otherProfileName}
    />
  );
}

export function MusicianProfile({ data }: { data: MusicianLoaded }) {
  const { profileId, profile, tracks, avatarUrl, coverUrl, upcomingShows, pastShows } = data;
  const pf = profile.portfolio;
  const subtype = profile.subtype as MusicianSubtype;
  const genres = (pf?.genres ?? []).slice(0, 2);
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
  const hasShows = upcomingShows.length > 0 || pastShows.length > 0;
  const firstTrack = tracks[0] ?? null;

  // Optional (not `publicBooking:`) on ProfileDoc: legacy pre-SP4 docs lack
  // the field entirely; `?? null` treats "absent" identically to "present
  // and explicitly null" (never public), per the field's own migration
  // comment in packages/shared/src/types.ts.
  const publicBooking = profile.publicBooking ?? null;
  const hasAnyBookingPref = publicBooking != null && (
    publicBooking.actSize != null || publicBooking.typicalSetMinutes != null
    || publicBooking.bringsOwnPA != null || publicBooking.availabilityPattern != null);

  const hasAnyContent = tracks.length > 0 || !!pf?.bio || hasShows || links.length > 0 || hasAnyBookingPref;

  return (
    <main className="flex-1 pb-24">
      {/* 1. HERO (spec 6.4): full-bleed cover with --gk-scrim melting into
          the page, small avatar beside the overlaid Syne name, genre/act-
          size chips, instant-play, "Offer a gig", and a "Shows" jump link. */}
      <section className="relative h-72 overflow-hidden sm:h-96">
        {coverUrl ? (
          <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <PhotoPlaceholder icon={<IconUser size={40} aria-hidden="true" />} />
        )}
        <div aria-hidden="true" className="absolute inset-0" style={{ background: "var(--gk-scrim)" }} />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-5 sm:px-6 sm:pb-7">
          <div className="mx-auto max-w-5xl">
            <div className="flex items-end gap-3">
              {avatarUrl ? (
                <img
                  src={avatarUrl} alt=""
                  className="size-12 shrink-0 rounded-full border-2 border-gk-bg-0 object-cover sm:size-14"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-gk-bg-0 bg-gk-border text-gk-muted sm:size-14"
                >
                  <IconUser size={22} />
                </span>
              )}
              <h1 className="truncate font-syne text-2xl font-extrabold leading-none text-gk-text sm:text-4xl">
                {profile.name}
              </h1>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant="secondary">{SUBTYPE_LABEL[subtype]}</Badge>
              {genres.map((g) => <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>)}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {firstTrack && <HeroPlayButton id={firstTrack.id} title={firstTrack.title} url={firstTrack.url} />}
              <OfferGigButton musicianProfileId={profileId} musicianName={profile.name} />
              {hasShows && (
                <Button asChild variant="secondary" size="sm">
                  <a href="#shows">Shows</a>
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        {/* 2. BIO */}
        {pf?.bio && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">About</h2>
            <p className="mt-2 whitespace-pre-wrap font-sora text-sm leading-relaxed text-gk-text">{pf.bio}</p>
          </section>
        )}

        {/* Booking preferences: a Task 11 (SP4) feature not named in the
            locked six-item anatomy list above; kept (this task restyles,
            never removes, real existing content) and placed right after Bio
            as a supplementary facts strip, ahead of the three anatomy items
            (Shows/Tracks/Links) whose relative order IS locked. Rates are
            NEVER shown here (spec decision 4): publicBooking's own type has
            no rate fields, so this section literally cannot render them. */}
        {hasAnyBookingPref && publicBooking && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Booking preferences</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              {publicBooking.actSize != null && (
                <div>
                  <dt className="font-sora text-xs text-gk-muted">Act size</dt>
                  <dd className="font-sora text-sm text-gk-text">{ACT_SIZE_LABEL[publicBooking.actSize]}</dd>
                </div>
              )}
              {publicBooking.typicalSetMinutes != null && (
                <div>
                  <dt className="font-sora text-xs text-gk-muted">Typical set</dt>
                  <dd className="font-sora text-sm text-gk-text">{publicBooking.typicalSetMinutes} min</dd>
                </div>
              )}
              {publicBooking.bringsOwnPA != null && (
                <div>
                  <dt className="font-sora text-xs text-gk-muted">Brings own PA</dt>
                  <dd className="font-sora text-sm text-gk-text">{publicBooking.bringsOwnPA ? "Yes" : "No"}</dd>
                </div>
              )}
              {publicBooking.availabilityPattern != null && (
                <div>
                  <dt className="font-sora text-xs text-gk-muted">Availability</dt>
                  <dd className="font-sora text-sm text-gk-text">{AVAILABILITY_LABEL[publicBooking.availabilityPattern]}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* 3. SHOWS: fixed-height (~360px) box, scrollable inside, upcoming
            then recent past (the page's own existing ordering), each row
            linking to its gig page. "All past shows" is a persistent footer
            strip on the box (not inside the scroll area) so it's reachable
            without scrolling all the way down. */}
        {hasShows && (
          <section id="shows" className="mt-8 scroll-mt-4">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Shows</h2>
            <div className="mt-2 overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
              <div className="h-[360px] overflow-y-auto p-2">
                {upcomingShows.length > 0 && (
                  <>
                    {pastShows.length > 0 && (
                      <p className="px-2 pt-1 font-sora text-[11px] font-semibold uppercase tracking-wide text-gk-muted">
                        Upcoming
                      </p>
                    )}
                    {upcomingShows.map((s) => <ShowRow key={s.gigId} show={s} />)}
                  </>
                )}
                {pastShows.length > 0 && (
                  <>
                    {upcomingShows.length > 0 && (
                      <p className="px-2 pt-3 font-sora text-[11px] font-semibold uppercase tracking-wide text-gk-muted">
                        Past
                      </p>
                    )}
                    {pastShows.map((s) => <ShowRow key={s.gigId} show={s} />)}
                  </>
                )}
              </div>
              <Link
                href={`/@${profile.handle}/shows`}
                className="block border-t border-gk-border px-4 py-3 text-center font-sora text-sm font-medium text-gk-text outline-none transition-colors hover:bg-gk-border/20 focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                All past shows
              </Link>
            </div>
          </section>
        )}

        {/* 4. TRACKS: restyled list, each row plays via the existing
            mechanism (trackPlayback.ts wraps it); playing state visible via
            the row's own icon swap plus the MiniPlayer below. */}
        {tracks.length > 0 && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Listen</h2>
            <div className="mt-2 grid gap-2">
              {tracks.map((t) => <TrackPlayer key={t.id} id={t.id} title={t.title} url={t.url} durationSec={t.durationSec} />)}
            </div>
          </section>
        )}

        {/* 5. EXTERNAL LINKS */}
        {links.length > 0 && (
          <section className="mt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Links</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {links.map((l) => {
                const Icon = EXTERNAL_LINK_ICON[l.kind];
                return (
                  <a
                    key={`${l.kind}:${l.url}`}
                    href={l.url}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="flex items-center gap-2 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2 font-sora text-sm text-gk-text outline-none transition-colors hover:border-gk-accent/50 focus-visible:ring-2 focus-visible:ring-gk-focus"
                  >
                    <Icon size={16} aria-hidden="true" className="text-gk-muted" />
                    {EXTERNAL_LINK_LABEL[l.kind]}
                  </a>
                );
              })}
            </div>
          </section>
        )}

        {!hasAnyContent && (
          <p className="mt-8 font-sora text-sm text-gk-muted">This artist hasn&apos;t added content yet.</p>
        )}

        {/* 6. Closing "Offer a gig" CTA: a second instance of the same
            gated control, its own independent identity/gate subscription
            (the same "each surface is self-contained" tradeoff
            PaymentsPanel.tsx's own comment documents for its sibling
            BookingThread listener). */}
        <section className="mt-12 border-t border-gk-border pt-8 text-center">
          <p className="font-syne text-lg font-semibold text-gk-text">Book {profile.name}</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Curators can send an offer straight from their open gigs.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <OfferGigButton musicianProfileId={profileId} musicianName={profile.name} />
          </div>
        </section>
      </div>

      <MiniPlayer artistName={profile.name} />
    </main>
  );
}

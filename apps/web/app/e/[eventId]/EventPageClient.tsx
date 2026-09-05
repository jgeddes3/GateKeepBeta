"use client";
import Link from "next/link";
import { AGE_RESTRICTION_LABEL, type EventDoc, type TaggedActStatus } from "@gatekeep/shared";
import { useAuth } from "../../../src/auth/AuthProvider";
import { formatGigTime, gigLocationLabel } from "../../u/[handle]/gigDisplay";
import { formatEventFullDate } from "../../../src/events/eventDisplay";
import { useTicketHolderAddress, mapUrl } from "../../../src/events/ticketHolderAddress";
import { BuyTicketsFlow } from "../../../src/events/BuyTicketsFlow";
import type { TierPickerTier } from "../../../src/events/TierPicker";
import { DateBlockRow } from "../../../src/components/DateBlockRow";
import { PhotoPlaceholder } from "../../../src/components/GigCard";
import { FollowsProvider } from "../../../src/discover/useFollows";
import { FollowButton } from "../../../src/discover/FollowButton";
import { ShowPostsForAct } from "../../../src/discover/ShowPosts";
import { IconMapPin, IconTicket } from "../../../src/ui/icons";
import { ShareButton } from "../../../src/share/ShareButton";
import { Badge } from "../../../src/ui/badge";
import { ArtistTagBanner } from "../../../src/events/ArtistTagBanner";

// Sub-project 6 task 9: the public event page's client half. page.tsx
// (server) fetches the event + tiers via the anonymous, rules-governed
// client SDK (getServerFirebase(), same pattern app/u/[handle]/page.tsx
// uses) and hands the result down here as plain props, so the SSR response
// already carries the real title/tier names (curl-provable, the RSC-rule
// live-verification gate) even though this component is "use client" for
// the interactive buy flow and the ticket-holder address reveal below.
//
// The ticket-holder address reveal itself (spec anatomy: "when signed in
// and users/{uid}/ticketIndex/{eventId} exists, show the exact address
// block") moved to src/events/ticketHolderAddress.ts in sub-project 6 task
// 10 (controller ruling 8): the fan tickets page needs the identical
// per-event reveal for every ticket card that carries one, so the hook now
// lives in one shared "use client" module rather than being duplicated.

export interface EventPageLineupEntry { name: string; handle: string | null; profileId: string | null }
export type EventPageTier = TierPickerTier;

export function EventPageClient({ eventId, event, posterUrl, curatorName, curatorHandle, lineup, tagged, tiers, now }: {
  eventId: string; event: EventDoc; posterUrl: string | null;
  curatorName: string; curatorHandle: string | null;
  lineup: EventPageLineupEntry[];
  // SP11 (spec 3.5): the tagged acts, plain summary shape (page.tsx's own
  // LoadedEvent.tagged), handed straight to ArtistTagBanner.
  tagged: Array<{ musicianProfileId: string; name: string; status: TaggedActStatus }>;
  tiers: EventPageTier[];
  // The instant page.tsx's own server render captured, threaded down to
  // BuyTicketsFlow (see that file's useLiveNow for why this is a prop
  // rather than a bare client Date.now() call).
  now: number;
}) {
  const { user } = useAuth();
  const address = useTicketHolderAddress(eventId, user?.uid ?? null);

  // One shared follows/{uid} listener for every FollowButton this page
  // renders (the venue card, plus one per lineup act with a profile), the
  // same win FollowsProvider gives ArtistsList's own up-to-60 rows
  // (useFollows.tsx's own header comment). Safe for a signed-out visitor:
  // useFollows(null) resolves to a stable "nothing followed" state rather
  // than opening a listener.
  return (
    <FollowsProvider uid={user?.uid ?? null}>
      <main className="flex-1 pb-10">
        <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 sm:pt-8">
          {/* SP11 (spec 3.5): the tag banner sits above the poster, so a
              tagged admin sees it before anything else. Renders nothing for
              every other visitor (ArtistTagBanner's own gate). */}
          <ArtistTagBanner eventId={eventId} acts={tagged} uid={user?.uid ?? null} />

          {/* 1. POSTER (or the branded PhotoPlaceholder treatment). */}
          <div className="relative h-64 overflow-hidden rounded-gk border border-gk-border bg-gk-surface sm:h-80 lg:h-96">
            {posterUrl ? (
              <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <PhotoPlaceholder icon={<IconTicket size={40} aria-hidden="true" />} />
            )}
          </div>

          {/* 2. TITLE: flex row so the Share button (Task 7, spec 3.1) sits to
              the right of the heading without eating into its own line
              length (it wraps onto its own lines above the button instead). */}
          <div className="mt-5 flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <h1 className="font-syne text-2xl font-extrabold leading-tight text-gk-text sm:text-4xl">
                {event.title}
              </h1>
              {/* SP11 (spec 3.4): 18+/21+ badge beside the title; all ages
                  renders nothing (schema.org has no age property, so this is
                  text-only, unlike doorTime below). */}
              {(event.ageRestriction === "18_plus" || event.ageRestriction === "21_plus") && (
                <Badge>{AGE_RESTRICTION_LABEL[event.ageRestriction]}</Badge>
              )}
            </div>
            <ShareButton path={`/e/${eventId}`} title={event.title} />
          </div>

          {/* 3. DATE BLOCK: DateBlockRow's own anatomy (date chip + title +
              subtitle), just not a link (this IS the page, not a row pointing
              elsewhere). Title carries the time range; subtitle adds the
              weekday + year the chip's own month/day glyph can't show. */}
          <div className="mt-4">
            <DateBlockRow
              dateMs={event.startsAt}
              title={`${formatGigTime(event.startsAt)}–${formatGigTime(event.endsAt)}`}
              subtitle={formatEventFullDate(event.startsAt)}
              subtitleHasDate
              className="px-0"
            />
            {/* SP11 (spec 3.4): doors line, only when the curator set one.
                Same single-instant formatter the range above uses. */}
            {event.doorsAt != null && (
              <p className="font-sora text-sm text-gk-muted">Doors {formatGigTime(event.doorsAt)}</p>
            )}
          </div>

          {/* 4. VENUE CARD: name (linked to the curator's public page), the
              same public-precision location gigLocationLabel already renders
              for gigs (EventDoc.location reuses GigPublicLocation verbatim),
              plus the ticket-holder-only exact address underneath, plus (Task
              9) a FollowButton for the venue. */}
          <div className="mt-4 rounded-gk border border-gk-border bg-gk-surface p-4">
            <div className="flex items-start justify-between gap-2.5">
              <div className="flex min-w-0 items-start gap-2.5">
                <IconMapPin size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-gk-muted" />
                <div className="min-w-0">
                  {curatorHandle ? (
                    <Link
                      href={`/u/${curatorHandle}`}
                      className="font-syne text-sm font-semibold text-gk-text underline-offset-4 outline-none hover:text-gk-focus hover:underline focus-visible:ring-2 focus-visible:ring-gk-focus"
                    >
                      {curatorName}
                    </Link>
                  ) : (
                    <p className="font-syne text-sm font-semibold text-gk-text">{curatorName}</p>
                  )}
                  <p className="font-sora text-sm text-gk-muted">{gigLocationLabel(event.location)}</p>
                </div>
              </div>
              <FollowButton targetId={event.curatorProfileId} targetType="curator" label="Follow venue" />
            </div>
            {address !== "hidden" && (
              <div className="mt-3 border-t border-gk-border pt-3">
                <p className="font-sora text-sm text-gk-text">
                  {address.address}{" "}
                  <a
                    href={mapUrl(address)} target="_blank" rel="noopener noreferrer"
                    className="text-gk-muted underline underline-offset-4 outline-none hover:text-gk-focus focus-visible:ring-2 focus-visible:ring-gk-focus"
                  >
                    Map
                  </a>
                </p>
              </div>
            )}
          </div>

          {/* 5. LINEUP: booking acts link to their artist page, external acts
              are plain text (spec anatomy, verbatim). Task 9: a booking act
              (one with a real profileId) also gets a FollowButton and its own
              show-post thread; an external act (no profile to follow or post
              through) stays exactly the plain-text row it always was. */}
          {lineup.length > 0 && (
            <section className="mt-6">
              <h2 className="font-syne text-lg font-semibold text-gk-text">Lineup</h2>
              <ul className="mt-2 grid gap-3">
                {lineup.map((act, i) => (
                  <li key={`${act.name}-${i}`} className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-sora text-sm text-gk-text">
                        {act.handle ? (
                          <Link
                            href={`/u/${act.handle}`}
                            className="underline-offset-4 outline-none hover:text-gk-focus hover:underline focus-visible:ring-2 focus-visible:ring-gk-focus"
                          >
                            {act.name}
                          </Link>
                        ) : act.name}
                      </span>
                      {act.profileId && <FollowButton targetId={act.profileId} targetType="musician" />}
                    </div>
                    {act.profileId && (
                      <ShowPostsForAct
                        eventId={eventId} musicianProfileId={act.profileId} artistName={act.name} endsAt={event.endsAt}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {event.description && (
            <section className="mt-6">
              <h2 className="font-syne text-lg font-semibold text-gk-text">About</h2>
              <p className="mt-2 whitespace-pre-wrap font-sora text-sm leading-relaxed text-gk-text">
                {event.description}
              </p>
            </section>
          )}

          {/* 6. TICKETS: the tier picker + sticky Buy button. */}
          <section className="mt-8 border-t border-gk-border pt-6">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Tickets</h2>
            <div className="mt-3">
              <BuyTicketsFlow
                eventId={eventId} eventStatus={event.status} startsAt={event.startsAt} tiers={tiers} now={now}
                eventGenres={event.genres ?? []}
              />
            </div>
          </section>
        </div>
      </main>
    </FollowsProvider>
  );
}

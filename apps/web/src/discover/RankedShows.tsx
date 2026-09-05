"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DECK_MAX_EXCLUDE_IDS, type DeckCard, type GetDiscoverDeckInput, type GetDiscoverDeckResult } from "@gatekeep/shared";
import { callFn } from "../lib/callable";
import { formatCents } from "../events/eventDisplay";
import { dateWindow, type DateFilter } from "./discoverQueries";
import { DateBlockRow } from "../components/DateBlockRow";
import { Button } from "../ui/button";
import { ShowRowSkeleton, ShowsErrorRow, ShowsEmptyState } from "./ShowsList";

type ShowCard = Extract<DeckCard, { kind: "show" }>;

function priceLabel(card: ShowCard): string | undefined {
  if (card.priceFromCents == null) return undefined;
  return card.priceFromCents === 0 ? "Free" : `from ${formatCents(card.priceFromCents)}`;
}

function subtitleFor(card: ShowCard): string {
  return card.neighborhood ? `${card.venueName} · ${card.neighborhood}` : card.venueName;
}

function ShowCardRow({ card }: { card: ShowCard }) {
  return (
    <DateBlockRow
      dateMs={card.startsAt}
      title={card.title || "Untitled event"}
      subtitle={subtitleFor(card)}
      href={`/e/${card.eventId}`}
      detail={priceLabel(card)}
    />
  );
}

// Review fix round 1: the same date/free/genre predicates showsQuery's
// caller applies over the unranked feed's fetched page, run here over the
// deck's own returned cards instead of a Firestore snapshot. DeckCard's
// "show" variant already carries startsAt, hasFreeTier and genres, so no
// extra fetch is needed to keep these three chips meaningful once the list
// is ranked.
function matchesChips(card: ShowCard, opts: { dateFilter: DateFilter; free: boolean; genre: string | null; now: number }): boolean {
  const { from, to } = dateWindow(opts.dateFilter, opts.now);
  if (card.startsAt < from || (to != null && card.startsAt > to)) return false;
  if (opts.free && !card.hasFreeTier) return false;
  if (opts.genre && !card.genres.includes(opts.genre)) return false;
  return true;
}

// SP11 task 8: the deck-backed, distance-ranked replacement for ShowsList's
// query feed, mounted by ShowsList only once a position exists (the browser
// fix or the account's homeGeo fallback). Shares getDiscoverDeck with the
// mobile deck (design spec 3.2), so ranking logic lives in exactly one place
// (discoverRank.ts) for both platforms. dateFilter/free/genre/now are
// ShowsList's own chip state, passed through so those three chips keep
// filtering something once the ranked list is showing (review fix round 1).
export function RankedShows({ location, homeCity, usingHomeCity, dateFilter, free, genre, now }: {
  location: { lat: number; lng: number };
  homeCity: string | null;
  usingHomeCity: boolean;
  dateFilter: DateFilter;
  free: boolean;
  genre: string | null;
  now: number;
}) {
  const [cards, setCards] = useState<DeckCard[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Review fix round 1: getDiscoverDeck rejects more than
  // DECK_MAX_EXCLUDE_IDS ids with invalid-argument, so this has to stay
  // capped the same way mobile's DeckScreen caps its own shownIds ref,
  // rather than growing unbounded across "Show more" pages. A ref, not
  // state: nothing here renders off shownIds directly, only the callable
  // input the next page's fetch builds.
  const shownIds = useRef<string[]>([]);

  // `location` is a fresh object every render from ShowsList (the browser
  // fix and homeGeo hooks each hold their own state), so this depends on the
  // coordinates themselves, not the object's identity, or every render would
  // refetch. No synchronous "loading"/error reset in the effect body itself
  // (ShowsList.tsx's own comment on this same lint rule): every transition
  // happens inside the callable's own success/failure callback.
  useEffect(() => {
    let cancelled = false;
    const input: GetDiscoverDeckInput = { location };
    callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>("getDiscoverDeck", input)
      .then(({ data }) => {
        if (cancelled) return;
        setCards(data.cards);
        setSeed(data.seed);
        shownIds.current = data.cards.map((c) => c.id).slice(-DECK_MAX_EXCLUDE_IDS);
        setExhausted(data.cards.length === 0);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setCards([]);
        setError(e instanceof Error ? e.message : "Could not load shows.");
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.lat, location.lng]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const input: GetDiscoverDeckInput = { location, excludeIds: shownIds.current };
      if (seed != null) input.seed = seed;
      const { data } = await callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>("getDiscoverDeck", input);
      setCards((prev) => (prev === "loading" ? data.cards : [...prev, ...data.cards]));
      setSeed(data.seed);
      shownIds.current = [...shownIds.current, ...data.cards.map((c) => c.id)].slice(-DECK_MAX_EXCLUDE_IDS);
      setExhausted(data.cards.length === 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more shows.");
    } finally {
      setLoadingMore(false);
    }
  }

  const showCards = cards === "loading" ? [] : cards.filter((c): c is ShowCard => c.kind === "show");
  const filteredShowCards = showCards.filter((c) => matchesChips(c, { dateFilter, free, genre, now }));

  return (
    <div className="grid gap-4">
      {usingHomeCity && homeCity && (
        <p className="font-sora text-sm text-gk-muted">
          <Link href="/dashboard#account" className="hover:text-gk-text hover:underline">
            Ranked near {homeCity}
          </Link>
        </p>
      )}

      {error && <ShowsErrorRow error={error} />}

      {cards === "loading" && (
        <div role="status" aria-label="Loading shows" className="grid gap-1">
          {[0, 1, 2].map((i) => <ShowRowSkeleton key={i} />)}
        </div>
      )}

      {cards !== "loading" && filteredShowCards.length === 0 && !error && <ShowsEmptyState />}

      {cards !== "loading" && filteredShowCards.length > 0 && (
        <div>
          {filteredShowCards.map((card) => <ShowCardRow key={card.id} card={card} />)}
        </div>
      )}

      {cards !== "loading" && showCards.length > 0 && !exhausted && (
        <Button onClick={() => void loadMore()} disabled={loadingMore} variant="secondary" size="sm" className="w-fit">
          {loadingMore ? "Loading…" : "Show more"}
        </Button>
      )}
    </div>
  );
}

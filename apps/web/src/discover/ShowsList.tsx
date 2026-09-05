"use client";
import { useEffect, useMemo, useState } from "react";
import { getDocs } from "firebase/firestore";
import { GENRES, type EventDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { showsQuery, dateWindow, type ShowRow, type DateFilter } from "./discoverQueries";
import { formatCents } from "../events/eventDisplay";
import { gigLocationLabel } from "../../app/u/[handle]/gigDisplay";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { DateBlockRow } from "../components/DateBlockRow";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { IconEvents, IconWarning } from "../ui/icons";
import { useBrowserLocation } from "../search/useBrowserLocation";
import { useHomeGeo } from "./useHomeGeo";
import { RankedShows } from "./RankedShows";

const ALL_GENRES = "__all";

function priceLabel(row: ShowRow): string | undefined {
  if (row.priceFromCents == null) return undefined;
  return row.priceFromCents === 0 ? "Free" : `from ${formatCents(row.priceFromCents)}`;
}

function ShowRowItem({ show }: { show: ShowRow }) {
  return (
    <DateBlockRow
      dateMs={show.startsAt}
      title={show.title || "Untitled event"}
      subtitle={gigLocationLabel(show.location)}
      href={`/e/${show.id}`}
      detail={priceLabel(show)}
    />
  );
}

// Exported: RankedShows.tsx's loading rows reuse this exact skeleton so the
// two Shows tab bodies (unranked query feed and the ranked deck-backed list)
// never drift into two different loading treatments.
export function ShowRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <Skeleton className="h-[46px] w-[46px] shrink-0 rounded-gk-sm" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// Exported alongside ShowRowSkeleton for the same reason: RankedShows.tsx's
// error and empty states are the identical treatment, not a lookalike copy.
export function ShowsErrorRow({ error }: { error: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
    >
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      Could not load shows: {error}
    </p>
  );
}

export function ShowsEmptyState() {
  return (
    <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
        <IconEvents size={20} aria-hidden="true" />
      </span>
      <p className="mt-3 font-syne text-base font-semibold text-gk-text">No shows match these filters</p>
      <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
        Try a different date range or genre, or clear a filter to see everything on sale.
      </p>
    </div>
  );
}

// The Shows tab: published, upcoming events, filtered by date range, a
// free-tier toggle, and a genre. Date filtering (dateWindow) and the free
// toggle (when a genre is also pinned, see showsQuery's own comment) both
// apply client-side over one fetched 60-row page; genre and the free flag
// alone are the only two dimensions pinned at the Firestore query itself.
//
// SP11 task 8: a "Use my location" chip sits beside these filters. Once a
// position resolves (the browser fix while the chip is on, else the
// account's saved homeGeo, in that order), the rows below swap for
// RankedShows' deck-backed, distance-ranked list; the date/free/genre chips
// above keep filtering nothing in that mode (the deck ranks on location and
// followed genres server-side, not these client-side dimensions). With no
// position at all, this unchanged unranked query feed is exactly what
// rendered before this task, which is the spec's stated fallback.
export function ShowsList({ uid }: { uid: string }) {
  const [rows, setRows] = useState<ShowRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [free, setFree] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>("any");
  // Captured once per mount rather than re-read every render: the query's
  // own startsAt >= now floor would otherwise keep sliding forward as the
  // clock ticks, silently dropping a row out of an already-rendered list.
  const [now] = useState(() => Date.now());

  const location = useBrowserLocation();
  const [useMyLocation, setUseMyLocation] = useState(false);
  const homeGeo = useHomeGeo(uid);

  const browserPosition = useMyLocation && location.status === "granted" ? location.location : null;
  const position = browserPosition ?? homeGeo.homeGeo;
  const usingHomeCity = browserPosition == null && homeGeo.homeGeo != null;

  // No synchronous "loading"/error reset at the top of the effect
  // (eslint-config-next's React Compiler rules flag a setState called
  // directly in an effect body): every state transition happens inside
  // getDocs' own success/failure callback instead. A filter change keeps
  // showing the PREVIOUS result set until the new query resolves, rather
  // than flashing back to a loading skeleton.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(showsQuery(db, { genre, free, now }))
      .then((snap) => {
        if (cancelled) return;
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Could not load shows.");
      });
    return () => { cancelled = true; };
  }, [genre, free, now]);

  const filtered = useMemo(() => {
    if (rows === "loading") return [];
    const { from, to } = dateWindow(dateFilter, now);
    return rows.filter((r) => {
      if (r.startsAt < from || (to != null && r.startsAt > to)) return false;
      if (free && !r.hasFreeTier) return false;
      return true;
    });
  }, [rows, dateFilter, free, now]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={dateFilter === "today"} onClick={() => setDateFilter(dateFilter === "today" ? "any" : "today")}>
          Today
        </Chip>
        <Chip active={dateFilter === "week"} onClick={() => setDateFilter(dateFilter === "week" ? "any" : "week")}>
          This week
        </Chip>
        <Chip active={dateFilter === "weekend"} onClick={() => setDateFilter(dateFilter === "weekend" ? "any" : "weekend")}>
          Weekend
        </Chip>
        <Chip active={free} onClick={() => setFree((v) => !v)}>Free</Chip>
        <Select value={genre ?? ALL_GENRES} onValueChange={(v) => setGenre(v === ALL_GENRES ? null : v)}>
          <SelectTrigger size="sm" aria-label="Genre" className="w-fit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_GENRES}>All genres</SelectItem>
            {GENRES.map((g) => <SelectItem key={g} value={g}>{formatChipLabel(g)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Chip
          active={useMyLocation && location.status === "granted"}
          onClick={() => { setUseMyLocation((v) => !v); if (location.status === "idle") location.request(); }}
        >
          Use my location
        </Chip>
      </div>

      {position ? (
        <RankedShows location={position} homeCity={homeGeo.homeCity} usingHomeCity={usingHomeCity} />
      ) : (
        <>
          {error && <ShowsErrorRow error={error} />}

          {rows === "loading" && (
            <div role="status" aria-label="Loading shows" className="grid gap-1">
              {[0, 1, 2].map((i) => <ShowRowSkeleton key={i} />)}
            </div>
          )}

          {rows !== "loading" && filtered.length === 0 && !error && <ShowsEmptyState />}

          {rows !== "loading" && filtered.length > 0 && (
            <div>
              {filtered.map((show) => <ShowRowItem key={show.id} show={show} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

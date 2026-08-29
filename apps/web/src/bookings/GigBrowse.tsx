"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where, type QueryConstraint } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { GENRES, type GigDoc, type BudgetStructure } from "@gatekeep/shared";
import { launchTzDayStartMs, launchTzNextDayStartMs } from "./BookingForms";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { GigCard } from "../components/GigCard";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { IconGigs, IconWarning } from "../ui/icons";

type GigRow = GigDoc & { id: string };

// The public "Find gigs" grid can never prove a series' exact recurrence
// (gigSeries has no public disjunct in firestore.rules: see the query
// comment below), so the badge names what's actually provable from the
// public gig doc alone: real status, and whether it belongs to a series at
// all. A curator-side context with member access to the series doc could
// pass a real cadence label here instead (formatChipLabel already turns
// "weekly" into "Weekly"); this page never can, so it never claims to.
function gigBadgeLabel(gig: GigRow): string {
  return gig.seriesId != null ? "Recurring series" : "Open for applications";
}

function GigCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
      <Skeleton className="h-36 w-full rounded-none sm:h-40" />
      <div className="grid gap-2 p-3.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <div className="mt-1 flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      </div>
    </div>
  );
}

// Public "Find gigs" browse: status=="open" ordered startsAt is the one
// query shape firestore.rules can prove for an anonymous caller (see
// firestore.rules' gigs read rule + tests-rules/rules.test.ts). City/genre/
// structure are pure client-side filters over that result; the date range
// is the only filter mapped onto the query itself, as a range on the
// already-indexed startsAt field (gigs(status,startsAt), no new index
// needed). Placeholder-grade per spec §1; sub-8 replaces the internals
// with real server-side search.
export function GigBrowse() {
  const [gigs, setGigs] = useState<GigRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState("");
  const [genre, setGenre] = useState<string | null>(null);
  const [structure, setStructure] = useState<BudgetStructure | "any">("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // No synchronous "loading"/error reset at the top of the effect (that
  // pattern is what eslint-config-next's React Compiler rules flag as
  // set-state-in-effect): every state transition here happens inside
  // getDocs' own success/failure callback instead. A filter change (from/to
  // date) therefore keeps showing the PREVIOUS result set until the new
  // query resolves, rather than flashing back to a bare "Loading…":
  // acceptable, even preferable, UX for a fast local/emulator query.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const constraints: QueryConstraint[] = [where("status", "==", "open")];
    // LAUNCH_TIMEZONE-aware boundaries (not UTC midnight): every gig time on
    // this app displays in LAUNCH_TIMEZONE (formatGigDateTime), so bucketing
    // the "From"/"To" filter by UTC midnight instead would mis-bucket an
    // evening gig near either boundary by the zone's offset (4-5h for
    // LAUNCH_TIMEZONE). See BookingForms.tsx's launchTzDayStartMs/
    // launchTzNextDayStartMs for the DST-aware derivation.
    const fromMs = launchTzDayStartMs(fromDate);
    const toMs = launchTzNextDayStartMs(toDate);
    if (fromMs != null) constraints.push(where("startsAt", ">=", fromMs));
    if (toMs != null) constraints.push(where("startsAt", "<", toMs));
    constraints.push(orderBy("startsAt"));
    getDocs(query(collection(db, "gigs"), ...constraints))
      .then((snap) => {
        if (cancelled) return;
        setGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setGigs([]);
        setError(e instanceof Error ? e.message : "Could not load gigs.");
      });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const filtered = useMemo(() => {
    if (gigs === "loading") return [];
    const cityLower = city.trim().toLowerCase();
    return gigs.filter((g) =>
      (cityLower === "" || g.location.city.toLowerCase().includes(cityLower))
      && (genre === null || g.wants.genres.includes(genre))
      && (structure === "any" || g.budget.structure === structure));
  }, [gigs, city, genre, structure]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-4">
        <div className="grid max-w-xs gap-1.5">
          <label htmlFor="browse-city" className="font-sora text-sm font-medium text-gk-text">City</label>
          <Input id="browse-city" placeholder="Any city" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Genre</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={genre === null} onClick={() => setGenre(null)}>All genres</Chip>
            {GENRES.map((g) => (
              <Chip key={g} active={genre === g} onClick={() => setGenre(genre === g ? null : g)}>
                {formatChipLabel(g)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <label htmlFor="browse-structure" className="font-sora text-sm font-medium text-gk-text">Payment structure</label>
            <Select value={structure} onValueChange={(v) => setStructure(v as BudgetStructure | "any")}>
              <SelectTrigger id="browse-structure" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="perHour">Per hour</SelectItem>
                <SelectItem value="perSong">Per song</SelectItem>
                <SelectItem value="perSet">Per set</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="browse-from" className="font-sora text-sm font-medium text-gk-text">From</label>
            <Input id="browse-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="browse-to" className="font-sora text-sm font-medium text-gk-text">To</label>
            <Input id="browse-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          Could not load gigs: {error}
        </p>
      )}

      {gigs === "loading" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading open gigs">
          {[0, 1, 2, 3, 4, 5].map((i) => <GigCardSkeleton key={i} />)}
        </div>
      )}

      {gigs !== "loading" && filtered.length === 0 && !error && (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconGigs size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No gigs on the books</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            The night is young: try a different city, clear a filter, or check back soon for new gigs.
          </p>
        </div>
      )}

      {gigs !== "loading" && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((g) => <GigCard key={g.id} gig={g} badgeLabel={gigBadgeLabel(g)} />)}
        </div>
      )}
    </div>
  );
}

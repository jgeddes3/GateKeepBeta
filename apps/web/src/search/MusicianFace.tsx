"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { SearchPin } from "@gatekeep/shared";
import { DateBlockRow } from "../components/DateBlockRow";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { FilterBar } from "./FilterBar";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { GigRow, ProfileRow, ResultList } from "./ResultRows";
import { hasMapsKey, ResultsMap } from "./ResultsMap";
import { SearchInputField } from "./SearchInputField";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

type PanelProps = { location: UseBrowserLocationState; headerSlot?: ReactNode };

// SearchPin.startsAt is typed number | null; every pin this panel actually
// produces (kind "gig") has one, but the type doesn't guarantee it, so
// this renders the DateBlockRow only when it's actually present, and a
// plain title/subtitle link (ProfileRow's own shape) otherwise, rather
// than asserting a value that isn't provably there.
function SelectedGigCard({ pin }: { pin: SearchPin }) {
  const href = `/gigs/${pin.id}`;
  if (pin.startsAt !== null) {
    return <DateBlockRow dateMs={pin.startsAt} title={pin.title} subtitle={pin.subtitle} href={href} />;
  }
  return (
    <Link
      href={href}
      className="flex w-full items-center gap-3 rounded-gk-sm px-2 py-2 text-left outline-none transition-colors hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-syne text-sm font-semibold text-gk-text">{pin.title}</p>
        <p className="truncate font-sora text-xs text-gk-muted">{pin.subtitle}</p>
      </div>
    </Link>
  );
}

// MusicianGigsPanel and MusicianVenuesPanel are exported on their own, not
// only assembled inside MusicianFace below: SearchFaces' three-segment
// Gigs | Venues | Artists strip (musician + curator both approved) reuses
// these two panels directly inside its own Tabs rather than nesting a
// whole second Tabs component inside the first.
//
// Only the gigs panel gets a map (the task brief's own scope: "the gigs
// tab of MusicianFace"); MusicianVenuesPanel below is untouched by this
// task. Without a Maps browser key, hasMapsKey() is false, view can never
// leave "list", and includePins is always false: same behaviour as before
// this task.
export function MusicianGigsPanel({ location, headerSlot }: PanelProps) {
  const [view, setView] = useState<ResultsView>("list");
  const [selectedPin, setSelectedPin] = useState<SearchPin | null>(null);
  const state = useSearch("musician_gigs", { location: location.location, includePins: view === "map" });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <SearchInputField value={state.q} onChange={state.setQ} placeholder="Search gigs" className="min-w-0 flex-1" />
        {hasMapsKey() && (
          <ListMapToggle
            view={view}
            onChange={(v) => { setView(v); setSelectedPin(null); }}
          />
        )}
        {headerSlot}
      </div>
      <FilterBar face="musician_gigs" filters={state.filters} onChange={state.setFilters} location={location} />
      {view === "map" ? (
        <div className="grid gap-3">
          <ResultsMap pins={state.pins} onSelect={setSelectedPin} />
          {selectedPin && <SelectedGigCard pin={selectedPin} />}
        </div>
      ) : (
        <ResultList state={state} row={GigRow} />
      )}
    </div>
  );
}

export function MusicianVenuesPanel({ location, headerSlot }: PanelProps) {
  const state = useSearch("musician_venues", { location: location.location, includePins: false });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <SearchInputField value={state.q} onChange={state.setQ} placeholder="Search venues" className="min-w-0 flex-1" />
        {headerSlot}
      </div>
      <FilterBar face="musician_venues" filters={state.filters} onChange={state.setFilters} location={location} />
      <ResultList state={state} row={ProfileRow} />
    </div>
  );
}

// The musician's search: Gigs and Venues each own their own useSearch (a
// different face, different filters, different rows). Radix's TabsContent
// only mounts the active panel (same as DiscoverClient's Shows/Artists
// tabs), so switching tabs remounts the inactive one and its useSearch
// resets to a fresh query, the same tradeoff Discover already accepts.
export function MusicianFace({ location, headerSlot }: PanelProps) {
  return (
    <Tabs defaultValue="gigs">
      <TabsList>
        <TabsTrigger value="gigs">Gigs</TabsTrigger>
        <TabsTrigger value="venues">Venues</TabsTrigger>
      </TabsList>
      <TabsContent value="gigs"><MusicianGigsPanel location={location} headerSlot={headerSlot} /></TabsContent>
      <TabsContent value="venues"><MusicianVenuesPanel location={location} headerSlot={headerSlot} /></TabsContent>
    </Tabs>
  );
}

"use client";
import type { ReactNode } from "react";
import { Input } from "../ui/input";
import { IconSearch } from "../ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { FilterBar } from "./FilterBar";
import { GigRow, ProfileRow, ResultList } from "./ResultRows";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

type PanelProps = { location: UseBrowserLocationState; headerSlot?: ReactNode };

// MusicianGigsPanel and MusicianVenuesPanel are exported on their own, not
// only assembled inside MusicianFace below: SearchFaces' three-segment
// Gigs | Venues | Artists strip (musician + curator both approved) reuses
// these two panels directly inside its own Tabs rather than nesting a
// whole second Tabs component inside the first.
export function MusicianGigsPanel({ location, headerSlot }: PanelProps) {
  const state = useSearch("musician_gigs", { location: location.location, includePins: false });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
          <Input value={state.q} onChange={(e) => state.setQ(e.target.value)} placeholder="Search gigs" className="pl-9" />
        </div>
        {headerSlot}
      </div>
      <FilterBar face="musician_gigs" filters={state.filters} onChange={state.setFilters} location={location} />
      <ResultList state={state} row={GigRow} />
    </div>
  );
}

export function MusicianVenuesPanel({ location, headerSlot }: PanelProps) {
  const state = useSearch("musician_venues", { location: location.location, includePins: false });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
          <Input value={state.q} onChange={(e) => state.setQ(e.target.value)} placeholder="Search venues" className="pl-9" />
        </div>
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

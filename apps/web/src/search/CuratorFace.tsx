"use client";
import type { ReactNode } from "react";
import type { SearchFilters } from "@gatekeep/shared";
import { CuratorArtistRow } from "./CuratorArtistRow";
import { FilterBar } from "./FilterBar";
import { ResultList } from "./ResultRows";
import { SaveSearchButton } from "./SaveSearchButton";
import { SearchInputField } from "./SearchInputField";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

// FACE_FILTER_KEYS.curator carries no "nearMe" entry, so FilterBar never
// renders the Near me chip for this face and never reads this stub's
// fields; it exists only to satisfy FilterBar's required `location` prop
// without this face asking for a device position it has no use for
// (controller ruling 2: CuratorFace takes only curatorProfileId, no
// location prop of its own).
const NO_LOCATION: UseBrowserLocationState = { location: null, status: "unsupported", request: () => {} };

// The curator's "find an artist" search: a name box, the curator face's
// filter chips, and CuratorArtistRow (controller ruling 2), not the plain
// ProfileRow the brief names for a venue row: a curator result needs the
// private booking read and "Offer a gig" action ProfileRow has no business
// doing.
export function CuratorFace({
  curatorProfileId, headerSlot, initial,
}: { curatorProfileId: string; headerSlot?: ReactNode; initial?: { q: string; filters: SearchFilters } }) {
  const state = useSearch("curator", { location: null, includePins: false, initial });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <SearchInputField value={state.q} onChange={state.setQ} placeholder="Search artists by name" className="min-w-0 flex-1" />
        <SaveSearchButton face="curator" q={state.q} filters={state.filters} />
        {headerSlot}
      </div>
      <FilterBar face="curator" filters={state.filters} onChange={state.setFilters} location={NO_LOCATION} />
      <ResultList state={state} renderRow={(r) => <CuratorArtistRow curatorProfileId={curatorProfileId} r={r} />} />
    </div>
  );
}

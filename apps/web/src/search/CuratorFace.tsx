"use client";
import { Input } from "../ui/input";
import { IconSearch } from "../ui/icons";
import { CuratorArtistRow } from "./CuratorArtistRow";
import { FilterBar } from "./FilterBar";
import { ResultList } from "./ResultRows";
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
export function CuratorFace({ curatorProfileId }: { curatorProfileId: string }) {
  const state = useSearch("curator", { location: null, includePins: false });
  return (
    <div className="grid gap-4">
      <div className="relative">
        <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
        <Input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder="Search artists by name"
          className="pl-9"
        />
      </div>
      <FilterBar face="curator" filters={state.filters} onChange={state.setFilters} location={NO_LOCATION} />
      <ResultList state={state} row={(props) => <CuratorArtistRow curatorProfileId={curatorProfileId} r={props.r} />} />
    </div>
  );
}

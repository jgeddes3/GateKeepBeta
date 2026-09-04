"use client";
import type { ReactNode } from "react";
import { Input } from "../ui/input";
import { IconSearch } from "../ui/icons";
import { FilterBar } from "./FilterBar";
import { ResultList, ShowRow } from "./ResultRows";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

// The signed-in fan's search: a free-text box, the "fan" face's filter
// chips, and a list of upcoming shows. headerSlot sits right-aligned
// beside the input, an empty slot at this task: Task 10 fills it with the
// List | Map toggle, Task 11 with Save search, both reading this same
// component's live query/filters rather than this task inventing a shape
// for them to guess at later.
export function FanFace({ location, headerSlot }: { location: UseBrowserLocationState; headerSlot?: ReactNode }) {
  const state = useSearch("fan", { location: location.location, includePins: false });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
          <Input
            value={state.q}
            onChange={(e) => state.setQ(e.target.value)}
            placeholder="Search shows, artists, venues"
            className="pl-9"
          />
        </div>
        {headerSlot}
      </div>
      <FilterBar face="fan" filters={state.filters} onChange={state.setFilters} location={location} />
      <ResultList state={state} row={ShowRow} />
    </div>
  );
}

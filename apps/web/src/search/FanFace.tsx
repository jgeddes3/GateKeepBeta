"use client";
import type { ReactNode } from "react";
import { FilterBar } from "./FilterBar";
import { ResultList, ShowRow } from "./ResultRows";
import { SearchInputField } from "./SearchInputField";
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
        <SearchInputField
          value={state.q}
          onChange={state.setQ}
          placeholder="Search shows, artists, venues"
          className="min-w-0 flex-1"
        />
        {headerSlot}
      </div>
      <FilterBar face="fan" filters={state.filters} onChange={state.setFilters} location={location} />
      <ResultList state={state} row={ShowRow} />
    </div>
  );
}

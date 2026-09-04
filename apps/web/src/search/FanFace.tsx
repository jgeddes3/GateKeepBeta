"use client";
import { useState, type ReactNode } from "react";
import type { SearchPin } from "@gatekeep/shared";
import { DateBlockRow } from "../components/DateBlockRow";
import { FilterBar } from "./FilterBar";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { ResultList, ShowRow } from "./ResultRows";
import { hasMapsKey, ResultsMap } from "./ResultsMap";
import { SearchInputField } from "./SearchInputField";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

// The signed-in fan's search: a free-text box, the "fan" face's filter
// chips, and a list (or, behind the Maps browser key, a map) of upcoming
// shows. headerSlot sits right-aligned beside the input, alongside this
// task's own List | Map toggle: Task 11 fills it further with Save search,
// both reading this same component's live query/filters rather than this
// task inventing a shape for them to guess at later.
//
// Without a Maps browser key, hasMapsKey() is false: view can never leave
// "list", the toggle never renders, and includePins is always false, so
// this behaves exactly as it did before this task (Task 8's own contract).
export function FanFace({ location, headerSlot }: { location: UseBrowserLocationState; headerSlot?: ReactNode }) {
  const [view, setView] = useState<ResultsView>("list");
  const [selectedPin, setSelectedPin] = useState<SearchPin | null>(null);
  const state = useSearch("fan", { location: location.location, includePins: view === "map" });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <SearchInputField
          value={state.q}
          onChange={state.setQ}
          placeholder="Search shows, artists, venues"
          className="min-w-0 flex-1"
        />
        {hasMapsKey() && (
          <ListMapToggle
            view={view}
            onChange={(v) => { setView(v); setSelectedPin(null); }}
          />
        )}
        {headerSlot}
      </div>
      <FilterBar face="fan" filters={state.filters} onChange={state.setFilters} location={location} />
      {view === "map" ? (
        <div className="grid gap-3">
          <ResultsMap pins={state.pins} onSelect={setSelectedPin} />
          {selectedPin && (
            <DateBlockRow
              dateMs={selectedPin.startsAt!}
              title={selectedPin.title}
              subtitle={selectedPin.subtitle}
              href={`/e/${selectedPin.id}`}
            />
          )}
        </div>
      ) : (
        <ResultList state={state} row={ShowRow} />
      )}
    </div>
  );
}

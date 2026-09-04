"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { SearchFilters, SearchPin } from "@gatekeep/shared";
import { DateBlockRow } from "../components/DateBlockRow";
import { FilterBar } from "./FilterBar";
import { ListMapToggle, type ResultsView } from "./ListMapToggle";
import { ResultList, ShowRow } from "./ResultRows";
import { hasMapsKey, ResultsMap } from "./ResultsMap";
import { SaveSearchButton } from "./SaveSearchButton";
import { SearchInputField } from "./SearchInputField";
import { useSearch } from "./useSearch";
import type { UseBrowserLocationState } from "./useBrowserLocation";

// SearchPin.startsAt is typed number | null; every pin this face actually
// produces (kind "show") has one, but the type doesn't guarantee it, so
// this renders the DateBlockRow only when it's actually present, and a
// plain title/subtitle link (ProfileRow's own shape) otherwise, rather
// than asserting a value that isn't provably there.
function SelectedShowCard({ pin }: { pin: SearchPin }) {
  const href = `/e/${pin.id}`;
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
export function FanFace({
  location, headerSlot, initial,
}: { location: UseBrowserLocationState; headerSlot?: ReactNode; initial?: { q: string; filters: SearchFilters } }) {
  const [view, setView] = useState<ResultsView>("list");
  const [selectedPin, setSelectedPin] = useState<SearchPin | null>(null);
  const state = useSearch("fan", { location: location.location, includePins: view === "map", initial });
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
        <SaveSearchButton face="fan" q={state.q} filters={state.filters} />
        {headerSlot}
      </div>
      <FilterBar face="fan" filters={state.filters} onChange={state.setFilters} location={location} />
      {view === "map" ? (
        <div className="grid gap-3">
          <ResultsMap pins={state.pins} onSelect={setSelectedPin} />
          {selectedPin && <SelectedShowCard pin={selectedPin} />}
        </div>
      ) : (
        <ResultList state={state} renderRow={(r) => <ShowRow r={r} />} />
      )}
    </div>
  );
}

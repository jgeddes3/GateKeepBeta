"use client";
import { Chip } from "../portfolio/PortfolioForms";

export type ResultsView = "list" | "map";

// Two Chips in a labelled group, DESIGN.md's shape for a small binary
// switch. The caller (FanFace, MusicianFace's gigs panel) is responsible
// for only rendering this when hasMapsKey() is true: without a Maps
// browser key there is no map view to switch to.
export function ListMapToggle({ view, onChange }: { view: ResultsView; onChange: (view: ResultsView) => void }) {
  return (
    <div role="group" aria-label="View" className="flex items-center gap-2">
      <Chip active={view === "list"} onClick={() => onChange("list")}>List</Chip>
      <Chip active={view === "map"} onClick={() => onChange("map")}>Map</Chip>
    </div>
  );
}

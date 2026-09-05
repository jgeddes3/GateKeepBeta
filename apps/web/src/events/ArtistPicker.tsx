"use client";
import { useEffect, useState } from "react";
import { SEARCH_EMPTY_MESSAGE, type SearchInput, type SearchOutput, type SearchResult } from "@gatekeep/shared";
import { callFn } from "../lib/callable";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { ErrorBox } from "./EventEditor";

// Sub-project 11 (spec section 3.5): the lineup editor's second "Add act"
// path. Backed by the SAME `search` callable the curator musicians page
// uses (CuratorFace.tsx), just this dialog's own one-shot query rather than
// useSearch's full paged/filtered state (a picker has no filters, no
// pagination, no map): a name box debounced 300ms, results showing name,
// city, and genres (the fields spec section 3.5 names), and a click both
// picks the artist and closes the dialog. Edit-only per the plan's ruling
// (LineupFields disables the trigger button until eventId exists): tagging
// requires a saved event for tagEventArtist to append to.

// Module-scope list component (never defined inside ArtistPicker's own
// render body), rendering the current page of search results as pickable
// rows.
function ArtistPickerResults({ items, onPick }: { items: SearchResult[]; onPick: (id: string, name: string) => void }) {
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onPick(item.id, item.title)}
            className="flex w-full flex-col items-start gap-0.5 rounded-gk-sm px-3 py-2 text-left outline-none transition-colors hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus"
          >
            <span className="font-syne text-sm font-semibold text-gk-text">{item.title}</span>
            {(item.city || item.genres.length > 0) && (
              <span className="truncate font-sora text-xs text-gk-muted">
                {[item.city, item.genres.length > 0 ? item.genres.map(formatChipLabel).join(", ") : null]
                  .filter((p): p is string => !!p).join(" · ")}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ArtistPicker({ open, onClose, onPick }: {
  open: boolean; onClose: () => void; onPick: (profileId: string, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [open, q]);

  // Render-time reset (useSearch.ts's own idiom, for the identical reason:
  // eslint-config-next's react-hooks/set-state-in-effect rule flags a
  // setState reachable synchronously from an effect body, so "loading" and
  // "error" flip back to their in-flight values here, when the request key
  // itself changes, rather than inside the fetch effect below).
  const requestKey = `${open}:${debouncedQ}`;
  const [trackedKey, setTrackedKey] = useState(requestKey);
  if (requestKey !== trackedKey) {
    setTrackedKey(requestKey);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    callFn<SearchInput, SearchOutput>("search", {
      face: "curator", q: debouncedQ, filters: {}, location: null, page: 0, includePins: false,
    })
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data.items);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(e instanceof Error ? e.message : "Search failed.");
      });
    return () => { cancelled = true; };
  }, [open, debouncedQ]);

  const reset = () => {
    setQ("");
    setDebouncedQ("");
    setItems([]);
    setError(null);
  };

  const pick = (id: string, name: string) => {
    onPick(id, name);
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tag a GateKeep artist</DialogTitle>
        </DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artists by name" autoFocus />
        <div className="grid max-h-80 gap-1 overflow-y-auto">
          {loading && (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          )}
          {!loading && error && <ErrorBox message={error} />}
          {!loading && !error && items.length === 0 && (
            <p className="px-3 py-2 font-sora text-sm text-gk-muted">{SEARCH_EMPTY_MESSAGE}</p>
          )}
          {!loading && !error && items.length > 0 && <ArtistPickerResults items={items} onPick={pick} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

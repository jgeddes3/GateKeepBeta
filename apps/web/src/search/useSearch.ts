"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SEARCH_LIMIT_MESSAGE,
  type SearchFace, type SearchFilters, type SearchInput, type SearchPin, type SearchResult,
} from "@gatekeep/shared";
import { callableCode, runSearch } from "./searchApi";

export interface UseSearchState {
  q: string; setQ: (q: string) => void;
  filters: SearchFilters; setFilters: (f: SearchFilters) => void;
  items: SearchResult[]; pins: SearchPin[]; matched: number; hasMore: boolean;
  loading: boolean; error: string | null; budgetHit: boolean;
  loadMore: () => void;
}

// nearMe only ever reaches the callable when a location is actually held:
// every face that renders the "Near me" chip (FilterBar) also has this
// stripped for free the moment the location goes null (denied, revoked,
// or never granted), rather than sending a stale/empty filter the server
// would have to special-case.
function buildInput(
  face: SearchFace, q: string, filters: SearchFilters,
  location: { lat: number; lng: number } | null, page: number, includePins: boolean,
): SearchInput {
  const f: SearchFilters = { ...filters };
  if (!location) delete f.nearMe;
  return { face, q, filters: f, location, page, includePins };
}

// Stable key for "what page-0 request should be in flight right now": used
// only to detect that the request identity changed, never sent anywhere
// itself. JSON.stringify is safe here because SearchFilters and location
// are both small, plain, JSON-shaped values (no functions, no cycles).
function requestKey(
  face: SearchFace, debouncedQ: string, filters: SearchFilters,
  location: { lat: number; lng: number } | null, includePins: boolean,
): string {
  return JSON.stringify([face, debouncedQ, filters, location, includePins]);
}

// One search face's live state: a debounced free-text query (300ms, so a
// fast typist doesn't fire a callable per keystroke), instant filters (a
// chip/select click should feel immediate), and a page cursor kept in a
// ref rather than state (nothing renders the page number itself, only
// loadMore reads it, so it never needs to trigger a render on its own).
//
// seqRef is the staleness guard: every fetch stamps the ref with its own
// sequence number before the async call starts, and only applies its
// result if that number is still current when the promise settles. A slow
// page-0 response from a query the user has since changed (typed more,
// flipped a filter, paged forward) is silently dropped rather than
// clobbering newer state.
//
// loading/error/budgetHit only ever flip to their "in flight" values in
// one of two places: the render-time reset below (when the request key
// itself changes, the same synchronous-during-render idiom
// useMyProfiles.ts's own trackedUid reset uses) or loadMore's own click
// handler. Neither is inside a useEffect body, so runFetch itself never
// calls setState outside a promise callback: eslint-config-next's
// react-hooks/set-state-in-effect rule flags exactly the alternative
// (a setState call reachable synchronously from an effect), the same
// constraint GigBrowse.tsx/ShowsList.tsx's own comments document.
export function useSearch(face: SearchFace, opts: {
  location: { lat: number; lng: number } | null;
  includePins: boolean;
  initial?: { q: string; filters: SearchFilters };
}): UseSearchState {
  const [q, setQ] = useState(opts.initial?.q ?? "");
  const [debouncedQ, setDebouncedQ] = useState(opts.initial?.q ?? "");
  const [filters, setFilters] = useState<SearchFilters>(opts.initial?.filters ?? {});
  const [items, setItems] = useState<SearchResult[]>([]);
  const [pins, setPins] = useState<SearchPin[]>([]);
  const [matched, setMatched] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budgetHit, setBudgetHit] = useState(false);
  const seqRef = useRef(0);
  const pageRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const key = requestKey(face, debouncedQ, filters, opts.location, opts.includePins);
  const [trackedKey, setTrackedKey] = useState(key);
  if (key !== trackedKey) {
    setTrackedKey(key);
    setLoading(true);
    setError(null);
    setBudgetHit(false);
  }

  // No setState here outside the .then/.catch callbacks: see this hook's
  // own header comment.
  const runFetch = useCallback((pageToFetch: number, append: boolean) => {
    pageRef.current = pageToFetch;
    const mySeq = ++seqRef.current;
    runSearch(buildInput(face, debouncedQ, filters, opts.location, pageToFetch, opts.includePins))
      .then((res) => {
        if (seqRef.current !== mySeq) return;
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setPins(res.pins ?? []);
        setMatched(res.matched);
        setHasMore(res.hasMore);
        setBudgetHit(false);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seqRef.current !== mySeq) return;
        setLoading(false);
        if (callableCode(e) === "functions/resource-exhausted") {
          setBudgetHit(true);
          setError(SEARCH_LIMIT_MESSAGE);
        } else {
          setBudgetHit(false);
          setError(e instanceof Error ? e.message : "Search failed.");
        }
      });
  }, [face, debouncedQ, filters, opts.location, opts.includePins]);

  // runFetch's own dependency list IS the "reset to page 0 and refetch"
  // trigger list the contract asks for (face, debouncedQ, filters,
  // location, includePins); this effect only has to react to runFetch's
  // identity changing, not restate that list a second time. The render-time
  // reset above already flipped loading/error/budgetHit before this runs.
  useEffect(() => {
    runFetch(0, false);
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    setBudgetHit(false);
    runFetch(pageRef.current + 1, true);
  }, [loading, hasMore, runFetch]);

  return { q, setQ, filters, setFilters, items, pins, matched, hasMore, loading, error, budgetHit, loadMore };
}

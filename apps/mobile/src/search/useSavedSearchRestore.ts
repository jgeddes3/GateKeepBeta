import { useEffect, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import type { SavedSearchDoc, SearchFace, SearchFilters } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

export interface SavedSearchRestore {
  ready: boolean;
  initial: { q: string; filters: SearchFilters } | undefined;
  face: SearchFace | undefined;
}

// Shared by app/(fan)/search.tsx, app/(musician)/gigs.tsx, and
// app/(curator)/musicians.tsx (Task 17 fix round 1, minor #4): each of those
// screens resolves a `saved` route param into the saved search's own doc
// through exactly this getDoc, once per distinct `saved` value (resolvedRef
// guards a re-fetch on every render, only a genuine change of `saved`
// re-fires it), before its face ever mounts. That "before ever mounts" part
// matters: a face's `initial` prop is only read once, at mount, by
// useSearch's own useState initializer, so the caller must gate rendering
// the face on `ready` rather than just passing `initial` straight through.
// `ready` starts true when there's no `saved` param to resolve at all, so a
// plain (unsaved) visit to any of these screens renders its face
// immediately. A missing or permission-denied doc (deleted, or someone
// else's link) resolves to `initial: undefined, face: undefined` rather
// than throwing or alerting, so the caller just renders the empty face.
export function useSavedSearchRestore(saved: string | undefined): SavedSearchRestore {
  const [ready, setReady] = useState(!saved);
  const [initial, setInitial] = useState<{ q: string; filters: SearchFilters } | undefined>(undefined);
  const [face, setFace] = useState<SearchFace | undefined>(undefined);
  const resolvedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!saved || resolvedRef.current === saved) return;
    resolvedRef.current = saved;
    setReady(false);
    let cancelled = false;
    getDoc(doc(getFirebase().db, "savedSearches", saved))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const d = snap.data() as SavedSearchDoc;
          setInitial({ q: d.q, filters: d.filters });
          setFace(d.face);
        }
        setReady(true);
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [saved]);

  return { ready, initial, face };
}

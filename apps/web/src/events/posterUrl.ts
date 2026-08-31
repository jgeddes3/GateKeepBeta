"use client";
import { useEffect, useState } from "react";
import { ref, getDownloadURL } from "firebase/storage";
import { getFirebase } from "../lib/firebase";

// Sub-project 6 task 10: client-side poster resolution, shared by
// EventsManager.tsx's list rows and TicketsClient.tsx's ticket cards (two
// independent surfaces that both just need "turn a posterPath into a
// download URL, or null while there isn't one"). storage.rules' public/{kind}/
// {profileId}/{fileName} match grants an unauthenticated `get` to anyone
// (see that file's own comment), so this needs no auth check of its own,
// unlike app/e/[eventId]/page.tsx's server-side storageUrl (which resolves
// through the anonymous SERVER SDK instead, see that function's own
// header). A missing/racing poster resolves to null exactly like that
// function does, rather than surfacing a Storage error to either surface's
// UI: a poster is always optional (EventDoc.posterPath is nullable), never
// load-bearing for anything this hook's callers render.
export function usePosterUrl(path: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Render-time reset so navigating between events (list re-keyed, or a
  // path prop changing under the same component instance) never shows the
  // PREVIOUS poster while the new one is still resolving: same "adjust
  // state while rendering" idiom PhotoUploader's own `baseline` uses.
  const [trackedPath, setTrackedPath] = useState(path);
  if (path !== trackedPath) {
    setTrackedPath(path);
    if (url !== null) setUrl(null);
  }
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    getDownloadURL(ref(getFirebase().storage, path))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => { console.warn("usePosterUrl: resolve failed", path, e); });
    return () => { cancelled = true; };
  }, [path]);
  return path ? url : null;
}

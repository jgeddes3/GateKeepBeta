import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import type { UserDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

// SP11 Task 13 (spec section 3.2): the deck's home-city fallback. Same
// return shape as Task 8's web twin (apps/web/src/discover/useHomeGeo.ts):
// `{ homeCity, homeGeo, loading }`, read once with getDoc (no live
// subscription; a change made from the account sheet is only ever going to
// be seen again on this screen's next mount, exactly like useDeckLocation's
// own one-shot position). `uid` is nullable, unlike the web twin: the deck
// renders for signed-out fans too. Any read failure (offline, a missing
// doc) resolves to nulls rather than throwing, so DeckScreen's fallback
// chain (device position, then this) degrades to "no position" instead of
// blocking the deck.
//
// A uid change (sign-in, sign-out, or account switch) is handled during
// render, the same way useGenrePickerGate's own trackedUid guard is
// (GenrePickerSheet.tsx), rather than as a synchronous setState at the top
// of the effect: the react-hooks/set-state-in-effect rule flags the latter.
// The effect below only ever calls setState from inside getDoc's own
// then/catch/finally, matching the web twin's own comment on this point.
export interface HomeGeoState {
  homeCity: string | null;
  homeGeo: { lat: number; lng: number } | null;
  loading: boolean;
}

export function useHomeGeo(uid: string | null): HomeGeoState {
  const [homeCity, setHomeCity] = useState<string | null>(null);
  const [homeGeo, setHomeGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(uid != null);
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setHomeCity(null);
    setHomeGeo(null);
    setLoading(uid != null);
  }

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const d = snap.data() as UserDoc | undefined;
        setHomeCity(d?.homeCity ?? null);
        setHomeGeo(d?.homeGeo ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setHomeCity(null);
        setHomeGeo(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [uid]);

  return { homeCity, homeGeo, loading };
}

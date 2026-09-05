"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import type { UserDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

export interface UseHomeGeoState {
  homeCity: string | null;
  homeGeo: { lat: number; lng: number } | null;
  loading: boolean;
}

// The account's saved home city and its coarsened center (Task 3's
// UserDoc.homeGeo/homeCity, written only by updateAccount). Read once via
// getDoc, not a live subscription: this value only changes when the fan
// saves the account card (Task 9), and that card reloads the page section
// itself, matching useGenrePickerGate's own genrePickerSeenAt read
// (GenrePicker.tsx) one field over. A permission error (or any other read
// failure) is swallowed into nulls rather than surfaced: a fan without a
// saved home city sees exactly the same thing as a fan the read failed for,
// today's unranked feed.
//
// No synchronous setState at the top of the effect (same
// react-hooks/set-state-in-effect rule ShowsList.tsx's own comment
// documents): every transition happens inside getDoc's own success/failure
// callback. Takes a plain string, not string | null, unlike
// useGenrePickerGate's uid param: this hook's one caller (ShowsList) always
// has a signed-in uid by the time it mounts, so there is no null branch to
// reset state for.
export function useHomeGeo(uid: string): UseHomeGeoState {
  const [homeCity, setHomeCity] = useState<string | null>(null);
  const [homeGeo, setHomeGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.exists() ? (snap.data() as UserDoc) : undefined;
        setHomeCity(data?.homeCity ?? null);
        setHomeGeo(data?.homeGeo ?? null);
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

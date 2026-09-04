"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

export type ProfileRole = "admin" | "member" | "none" | "loading";

// SP5c Task 9: the Earnings panel's role gate. Same shape as useRole in
// src/bookings/BookingThread.tsx (a one-shot getDoc on the caller's own
// profiles/{id}/members/{uid} doc, "loading" first), but scoped to a SINGLE
// profile and reading the doc's own `.role` field rather than just its
// existence: an admin gets the onboarding/cash-out/shares-editing controls, a
// plain member gets the read-only view. A denied read (not a member at all)
// and a missing doc both resolve to "none": the rules make those
// indistinguishable to the client (permission-denied, not a 404), so there is
// no honest way to tell "not a member" from "not allowed to know".
export function useProfileRole(profileId: string | undefined, uid: string | undefined): ProfileRole {
  const [role, setRole] = useState<ProfileRole>("loading");
  useEffect(() => {
    if (!profileId || !uid) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${profileId}/members/${uid}`))
      .then((snap) => {
        if (cancelled) return;
        const r = snap.data()?.role;
        setRole(r === "admin" ? "admin" : r === "member" ? "member" : "none");
      })
      .catch(() => { if (!cancelled) setRole("none"); });
    return () => { cancelled = true; };
  }, [profileId, uid]);
  return role;
}

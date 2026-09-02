"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, onSnapshot, query, where } from "firebase/firestore";
import { useAuth } from "../auth/AuthProvider";
import { getFirebase } from "../lib/firebase";

// Spec section 5.1: "Logged-in visitors are redirected to their dashboard."
// No prior implementation of this existed (task 3's own report explicitly
// left "/" out of its shell/auth-guard sweep, deferring it to this task:
// "'/' (landing): excluded per the brief, Task 4 owns its own variant").
// This mirrors the auth-guard effect already used by Dashboard and Join
// (app/dashboard/page.tsx, app/join/page.tsx), run in the opposite
// direction, but deliberately non-blocking: those are protected pages that
// must gate all render behind the auth check, while the landing page is
// public marketing content that anonymous visitors (the large majority of
// hits) need to see immediately. This renders nothing and only fires the
// redirect once Firebase confirms a signed-in user, instead of holding the
// whole page back while auth resolves.
//
// Sub-project 7 task 8 addition: a signed-in account with NO profile of any
// kind (a fan who has never created a musician or curator profile) has
// nothing useful waiting at /dashboard, so it now goes to /discover, the
// fan-facing signed-in home this task adds, instead. Everyone with at least
// one profile still lands on /dashboard exactly as before.
//
// useMyProfiles (src/shell/useMyProfiles.ts) can't answer "does this account
// have a profile" on its own: it returns [] both while signed out AND before
// its first snapshot arrives, so an empty array from that hook alone is
// ambiguous between "really has none" and "hasn't loaded yet" (that hook's
// own header comment documents the same tradeoff). Rather than import it
// and guess, this subscribes with the identical collectionGroup("members")
// query but tracks its own "resolved" flag (the first snapshot has arrived)
// so the redirect only ever fires once real data is in hand.
export function SignedInRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const uid = user?.uid ?? null;
  const [hasProfile, setHasProfile] = useState(false);
  const [resolved, setResolved] = useState(false);

  // Render-time reset on an identity change, not a synchronous setState at
  // the top of the effect below (eslint-config-next's React Compiler rules
  // flag the latter): the same idiom useMyProfiles.ts's own `trackedUid`
  // already uses for this exact "uid changed, so the old query's answer no
  // longer applies" case.
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setResolved(false);
    setHasProfile(false);
  }

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", uid)), (snap) => {
      if (cancelled) return;
      setHasProfile(!snap.empty);
      setResolved(true);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);

  useEffect(() => {
    if (loading || !uid || !resolved) return;
    router.replace(hasProfile ? "/dashboard" : "/discover");
  }, [uid, loading, resolved, hasProfile, router]);

  return null;
}

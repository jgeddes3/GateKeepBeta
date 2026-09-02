"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { parseGenreTarget, type FollowDoc, type FollowTargetType } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

export type FollowState = { targets: Set<string>; loading: boolean; genres: string[] };

// Live subscription on this signed-in user's own follows
// (follows/{uid}_{targetId}, readable only by their owner per
// firestore.rules: `where("uid","==",uid)` is the pin that read rule
// checks). `targets` is every followed targetId (profile ids and
// "genre:<name>" ids alike); `genres` pulls just the genre names back out
// via parseGenreTarget, for callers (the genre-picker gate) that only care
// about that subset. A signed-out visitor (uid null) gets a stable "nothing
// followed, not loading" result rather than an indefinite spinner: there is
// no query to run.
//
// Fix round 1 (Important, review of this task): this is the ONE place that
// actually opens the onSnapshot listener. Calling it directly, once per
// component, is what let ArtistsList's up-to-60 FollowButton rows each open
// their own independent listener on the identical query. It stays exported
// (a call site with no FollowsProvider ancestor still needs a working
// subscription, see useFollowsContext below), but every call site inside
// this task's own tree goes through the context instead.
export function useFollows(uid: string | null): FollowState {
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<string[]>([]);
  const [loading, setLoading] = useState(uid != null);
  // Render-time reset on an identity change, same idiom useMyProfiles.ts
  // and usePosterUrl.ts already use: adjusting state synchronously during
  // render (rather than in an effect) means React re-renders once more
  // before committing, so a follower switching accounts never paints a
  // stale previous account's follows.
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setTargets(new Set());
    setGenres([]);
    setLoading(uid != null);
  }

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(query(collection(db, "follows"), where("uid", "==", uid)), (snap) => {
      if (cancelled) return;
      const nextTargets = new Set<string>();
      const nextGenres: string[] = [];
      for (const d of snap.docs) {
        const data = d.data() as FollowDoc;
        nextTargets.add(data.targetId);
        const genre = parseGenreTarget(data.targetId);
        if (genre) nextGenres.push(genre);
      }
      setTargets(nextTargets);
      setGenres(nextGenres);
      setLoading(false);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);

  return { targets, loading, genres };
}

// Distinguishable from "no provider mounted" (useContext's default) even
// for a signed-out uid: FollowsProvider always supplies a real FollowState
// object (useFollows(null)'s own stable empty-and-not-loading shape), never
// `null` itself, so `null` unambiguously means "nothing above this render
// tree provides one".
const FollowsContext = createContext<FollowState | null>(null);

// Mounted once per page (this task: DiscoverClient's authenticated body) so
// every descendant that needs follow state shares ONE onSnapshot listener
// instead of opening its own. `uid` is read here, not derived from
// useAuth() internally, so a caller that already resolved auth (every
// mount site so far) doesn't pay a second context read for it.
export function FollowsProvider({ uid, children }: { uid: string | null; children: ReactNode }) {
  const state = useFollows(uid);
  return <FollowsContext.Provider value={state}>{children}</FollowsContext.Provider>;
}

// The hook every follow-aware component should call: FollowButton, and
// useGenrePickerGate below. Reads the nearest FollowsProvider's shared
// subscription when one is mounted; otherwise falls back to opening its own
// via useFollows(uid), so a page with no provider yet (a future /u/[handle]
// or /e/[eventId] call site, before Task 9 mounts one there) still works
// correctly, just without the sharing win. `useFollows(hasProvider ? null :
// uid)` keeps this hook's own call order and count identical on every
// render (rules of hooks): when a provider IS present, passing it `null`
// makes useFollows' own effect a no-op rather than opening a second,
// redundant listener alongside the provider's.
export function useFollowsContext(uid: string | null): FollowState {
  const provided = useContext(FollowsContext);
  const standalone = useFollows(provided ? null : uid);
  return provided ?? standalone;
}

export async function follow(targetId: string, targetType: FollowTargetType): Promise<void> {
  await httpsCallable(getFirebase().functions, "followTarget")({ targetId, targetType });
}

export async function unfollow(targetId: string): Promise<void> {
  await httpsCallable(getFirebase().functions, "unfollowTarget")({ targetId });
}

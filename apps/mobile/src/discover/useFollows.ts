import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { parseGenreTarget, type FollowDoc, type FollowTargetType } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

// SP7 Task 11: RN twin of apps/web/src/discover/useFollows.tsx's own
// useFollows/follow/unfollow. Mobile has no FollowsProvider/useFollowsContext
// split (that web machinery exists only to share ONE onSnapshot listener
// across up to 60 ArtistsList rows on a single page); this task's own screens
// (following.tsx, the venue screen) each mount at most a handful of
// FollowButtons, so every call site here just calls useFollows(uid) directly.
// A future task that needs the sharing win can add the same provider split
// then, without changing this hook's own contract.

export type FollowState = { targets: Set<string>; genres: string[]; loading: boolean };

// Live subscription on this signed-in user's own follows
// (follows/{uid}_{targetId}, readable only by their owner per
// firestore.rules: `where("uid","==",uid)` is the pin that read rule
// checks). `targets` is every followed targetId (profile ids and
// "genre:<name>" ids alike); `genres` pulls just the genre names back out via
// parseGenreTarget. A signed-out caller (uid null) gets a stable "nothing
// followed, not loading" result rather than an indefinite spinner: there is
// no query to run.
export function useFollows(uid: string | null): FollowState {
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<string[]>([]);
  const [loading, setLoading] = useState(uid != null);
  // Render-time reset on an identity change, same idiom this app's other
  // fetch hooks use (e.g. events/eventDisplay.ts's usePosterUrl `trackedPath`):
  // adjusting state synchronously during render means React re-renders once
  // more before committing, so a follower switching accounts never paints a
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

  return { targets, genres, loading };
}

export async function follow(targetId: string, targetType: FollowTargetType): Promise<void> {
  await httpsCallable(getFirebase().functions, "followTarget")({ targetId, targetType });
}

export async function unfollow(targetId: string): Promise<void> {
  await httpsCallable(getFirebase().functions, "unfollowTarget")({ targetId });
}

"use client";
import { useEffect, useState } from "react";
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

export async function follow(targetId: string, targetType: FollowTargetType): Promise<void> {
  await httpsCallable(getFirebase().functions, "followTarget")({ targetId, targetType });
}

export async function unfollow(targetId: string): Promise<void> {
  await httpsCallable(getFirebase().functions, "unfollowTarget")({ targetId });
}

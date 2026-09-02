import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { parseGenreTarget, type FollowDoc, type FollowTargetType } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";

// SP7 Task 11: RN twin of apps/web/src/discover/useFollows.tsx's own
// useFollows/FollowsProvider/useFollowsContext/follow/unfollow.
//
// Fix round 1 (review, Important): ArtistsList mounts a FollowButton per row
// (up to 60), and FollowButton reads follow state. Before this fix, that
// meant up to 60 near-identical onSnapshot listeners on `follows where uid
// ==`, one per row, the exact defect the web twin's own FollowsProvider
// exists to prevent. FollowsProvider is mounted ONCE, app-wide
// (app/_layout.tsx, inside ProfileProvider), reading the signed-in uid from
// useAuth itself rather than taking it as a prop (unlike the web twin, which
// leaves that to its one DiscoverClient call site): every screen that can
// mount a FollowButton or read follow state (Discover, Following, the event
// screen, the artist page, the venue screen) sits inside it already, so
// there's exactly one place this provider needs to be mounted. FollowButton,
// useGenrePickerGate, and following.tsx all read the shared subscription via
// useFollowsContext now instead of calling useFollows(uid) directly.
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

// Distinguishable from "no provider mounted" (useContext's default) even for
// a signed-out uid: FollowsProvider always supplies a real FollowState object
// (useFollows(null)'s own stable empty-and-not-loading shape), never `null`
// itself, so `null` unambiguously means "nothing above this render tree
// provides one".
const FollowsContext = createContext<FollowState | null>(null);

// Mounted once, app-wide (app/_layout.tsx, inside ProfileProvider so it can
// read useAuth) so every screen that can render a FollowButton or read
// follow state shares ONE onSnapshot listener instead of each opening its
// own. Reads the signed-in uid itself via useAuth rather than taking it as a
// prop: with exactly one mount site, there's no caller left that needs to
// pass it in.
export function FollowsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const state = useFollows(user?.uid ?? null);
  return <FollowsContext.Provider value={state}>{children}</FollowsContext.Provider>;
}

// The hook every follow-aware component should call: FollowButton, and
// useGenrePickerGate. Reads the app-wide FollowsProvider's shared
// subscription when one is mounted (every real screen in this app, since
// app/_layout.tsx mounts it above the signed-in Gate); otherwise falls back
// to opening its own via useFollows(uid), so a component rendered outside
// that tree (a future test harness, say) still works correctly, just without
// the sharing win. `useFollows(provided ? null : uid)` keeps this hook's own
// call order and count identical on every render (rules of hooks): when a
// provider IS present, passing it `null` makes useFollows' own effect a
// no-op rather than opening a second, redundant listener alongside the
// provider's.
export function useFollowsContext(): FollowState {
  const { user } = useAuth();
  const provided = useContext(FollowsContext);
  const standalone = useFollows(provided ? null : (user?.uid ?? null));
  return provided ?? standalone;
}

export async function follow(targetId: string, targetType: FollowTargetType): Promise<void> {
  await httpsCallable(getFirebase().functions, "followTarget")({ targetId, targetType });
}

export async function unfollow(targetId: string): Promise<void> {
  await httpsCallable(getFirebase().functions, "unfollowTarget")({ targetId });
}

import { useState } from "react";
import { View } from "react-native";
import { FOLLOW_LIMIT_MESSAGE, type FollowTargetType } from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { useFollowsContext, follow, unfollow } from "./useFollows";
import { Button, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";

// SP7 Task 11: RN twin of apps/web/src/discover/FollowButton.tsx. Reused
// everywhere a fan can follow a musician, curator, or genre (this task's own
// following.tsx and venue/[handle].tsx; Tasks 12/13 widen it to the discover
// lists and artist page). Every screen in this app already requires sign-in
// before it can mount (app/_layout.tsx's Gate redirects a signed-out user to
// (auth)/sign-in first), so unlike the web twin this never needs its own
// "sign in to follow" redirect branch.
//
// Fix round 1 (review, Important): ArtistsList can mount up to 60 of these
// in one screen. Reading follow state via useFollowsContext (the app-wide
// FollowsProvider mounted in app/_layout.tsx) instead of calling
// useFollows(uid) directly means all 60 share ONE onSnapshot listener
// instead of each opening its own.
export function FollowButton({ targetId, targetType, label, compact }: {
  targetId: string; targetType: FollowTargetType; label?: string; compact?: boolean;
}) {
  const { user } = useAuth();
  const { targets } = useFollowsContext();
  const isFollowing = targets.has(targetId);

  // Optimistic toggle: shows the clicked-toward state immediately, then
  // clears back to null (deferring to the live `isFollowing` above) once the
  // snapshot catches up. A failed callable clears it immediately instead (the
  // rollback), so the button snaps back to its pre-tap state rather than
  // sitting on a value the server never accepted. Same shape as the web
  // twin's own pendingOverride/trackedIsFollowing pair.
  const [pendingOverride, setPendingOverride] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const following = pendingOverride ?? isFollowing;

  const [trackedIsFollowing, setTrackedIsFollowing] = useState(isFollowing);
  if (isFollowing !== trackedIsFollowing) {
    setTrackedIsFollowing(isFollowing);
    if (pendingOverride !== null && pendingOverride === isFollowing) setPendingOverride(null);
  }

  const onPress = async () => {
    if (!user || pending) return;
    setError(null);
    const next = !following;
    setPendingOverride(next);
    setPending(true);
    try {
      if (next) await follow(targetId, targetType);
      else await unfollow(targetId);
    } catch (e) {
      setPendingOverride(null);
      const message = e instanceof Error ? e.message : "Could not update. Try again.";
      setError(message === FOLLOW_LIMIT_MESSAGE ? message : "Could not update. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <View style={{ gap: 4 }}>
      <Button
        variant={following ? "ghost" : "secondary"}
        title={following ? "Following" : (label ?? "Follow")}
        onPress={() => void onPress()}
        disabled={pending}
        style={compact ? { minHeight: 36, paddingHorizontal: tokens.space.sm } : undefined}
      />
      {error && <ErrorBanner message={error} />}
    </View>
  );
}

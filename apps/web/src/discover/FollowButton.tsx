"use client";
import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { FOLLOW_LIMIT_MESSAGE, type FollowTargetType } from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { useFollows, follow, unfollow } from "./useFollows";
import { Button } from "../ui/button";
import { IconCheck, IconPlus } from "../ui/icons";

// Reused everywhere a fan can follow a musician, curator, or genre (this
// task's own /discover lists; Task 9 widens it to /u/[handle] and
// /e/[eventId]). Owns its own live "am I already following this" read
// (useFollows) rather than taking it as a prop, so any call site can drop
// this in with just the three ids it already has on hand.
export function FollowButton({ targetId, targetType, label }: { targetId: string; targetType: FollowTargetType; label?: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { targets } = useFollows(user?.uid ?? null);
  const isFollowing = targets.has(targetId);

  // Optimistic toggle: shows the clicked-toward state immediately, then
  // clears back to null (deferring to the live `isFollowing` above) once
  // that snapshot catches up. A failed callable clears it immediately
  // instead (the rollback), so the button snaps back to its pre-click state
  // rather than sitting on a value the server never accepted.
  const [pendingOverride, setPendingOverride] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const following = pendingOverride ?? isFollowing;

  // Render-time reset (no effect: eslint-config-next's React Compiler rules
  // flag a synchronous setState inside an effect body, the same reason
  // useMyProfiles.ts/useFollows.ts reset via a tracked-value comparison
  // during render instead). Clears the override the moment `isFollowing`
  // itself changes to match it, so a live snapshot catching up to a pending
  // click never leaves the override stuck overriding some LATER, unrelated
  // change in `isFollowing`.
  const [trackedIsFollowing, setTrackedIsFollowing] = useState(isFollowing);
  if (isFollowing !== trackedIsFollowing) {
    setTrackedIsFollowing(isFollowing);
    if (pendingOverride !== null && pendingOverride === isFollowing) setPendingOverride(null);
  }

  async function onClick() {
    if (!user) {
      // pathname is always an existing same-origin app route (it comes from
      // usePathname(), never visitor-controlled input), so it needs no
      // isSafeNext-style validation before round-tripping it back through
      // `next`, the same reasoning BuyTicketsFlow's own sign-in redirect
      // already relies on.
      router.push(`/sign-in?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setError(null);
    const next = !following;
    setPendingOverride(next);
    try {
      if (next) await follow(targetId, targetType);
      else await unfollow(targetId);
    } catch (e) {
      setPendingOverride(null);
      const message = e instanceof Error ? e.message : "Could not update. Try again.";
      setError(message === FOLLOW_LIMIT_MESSAGE ? message : "Could not update. Try again.");
    }
  }

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant={following ? "ghost" : "secondary"}
        size="sm"
        onClick={() => { void onClick(); }}
        aria-pressed={following}
      >
        {following
          ? <><IconCheck size={16} aria-hidden="true" /> Following</>
          : <><IconPlus size={16} aria-hidden="true" /> {label ?? "Follow"}</>}
      </Button>
      {error && <p role="alert" className="font-sora text-xs text-gk-destructive">{error}</p>}
    </div>
  );
}

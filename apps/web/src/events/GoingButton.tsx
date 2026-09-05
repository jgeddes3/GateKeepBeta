"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { GOING_LABEL, type EventReactionDoc, type EventStatus } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../ui/button";

// SP12 (spec 3.2): the show's own "Going" toggle, next to the fan comment
// list it sits above (EventComments.tsx, mounted right after this in
// EventPageClient.tsx). The viewer's own reaction is read with a single
// getDoc on events/{eventId}/reactions/{uid} (firestore.rules: owner-only
// get, never a list, same posture as the lineup-post heart below), and the
// toggle itself is optimistic, reconciled from setGoing's own
// { going, goingCount } return so a racing second tab (or a rejected rate
// cap) can never leave the count silently wrong.
export function GoingButton({ eventId, eventStatus, initialCount }: {
  eventId: string; eventStatus: EventStatus; initialCount: number;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [going, setGoing] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lookup = user
      ? getDoc(doc(getFirebase().db, `events/${eventId}/reactions/${user.uid}`))
        .then((snap) => (snap.exists() ? (snap.data() as EventReactionDoc).going === true : false))
        .catch(() => false)
      : Promise.resolve(false);
    lookup.then((isGoing) => { if (!cancelled) setGoing(isGoing); });
    return () => { cancelled = true; };
  }, [eventId, user]);

  const toggle = async () => {
    if (!user) {
      router.push(`/sign-in?next=${encodeURIComponent(`/e/${eventId}`)}`);
      return;
    }
    const prevGoing = going;
    const prevCount = count;
    const next = !going;
    setGoing(next);
    setCount(Math.max(0, prevCount + (next ? 1 : -1)));
    setBusy(true);
    setError(null);
    try {
      const res = await callFn<{ eventId: string; going: boolean }, { going: boolean; goingCount: number }>(
        "setGoing", { eventId, going: next },
      );
      setGoing(res.data.going);
      setCount(res.data.goingCount);
    } catch (e) {
      setGoing(prevGoing);
      setCount(prevCount);
      setError(e instanceof Error ? e.message : "Could not update this. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // Comments close by the same event-status gate (spec 3.2); the reaction
  // row above them closes with it too, since a draft or cancelled event has
  // nothing to react to.
  if (eventStatus !== "published" && eventStatus !== "completed") return null;

  return (
    <div className="grid gap-1.5">
      <Button
        type="button"
        variant={going ? "default" : "secondary"}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={going}
        className="w-fit gap-1.5"
      >
        {GOING_LABEL}
        <span aria-hidden="true">{count}</span>
        <span className="sr-only">{count} going</span>
      </Button>
      {error && <p role="alert" className="font-sora text-xs text-gk-destructive">{error}</p>}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { ARTIST_TAG_BANNER_TITLE, type TaggedActStatus } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { Button } from "../ui/button";

// SP11 (spec 3.5, task 11): the artist side of a curator's "Tag a GateKeep
// artist" lineup entry. EventPageClient renders this above the poster so a
// tagged admin sees it before anything else on the event page.
//
// Only a PENDING tagged act whose musician profile this signed-in uid
// administers ever produces a panel: for each such act, a self-read of
// profiles/{musicianProfileId}/members/{uid} (the exact clause
// useProfileRole.ts leans on in firestore.rules) says whether this uid is a
// member at all, and only "admin" qualifies. Signed-out (uid null) or no
// admin match renders nothing. Accepted/declined acts never get a panel:
// the banner exists to collect a response, not to re-announce one, and
// EventPageClient never re-mounts this component after a route change, so
// there's no separate "already answered" state to represent here beyond the
// server's own ARTIST_TAG_ANSWERED_MESSAGE surfacing on a stale page.
export interface ArtistTagBannerAct { musicianProfileId: string; name: string; status: TaggedActStatus }

type ActState =
  | { phase: "idle" | "busy" }
  | { phase: "done"; status: "accepted" | "declined" }
  | { phase: "error"; message: string };

export function ArtistTagBanner({ eventId, acts, uid }: {
  eventId: string; acts: ArtistTagBannerAct[]; uid: string | null;
}) {
  const pending = acts.filter((a) => a.status === "pending");
  const pendingKey = pending.map((a) => a.musicianProfileId).join(",");
  const [adminActs, setAdminActs] = useState<ArtistTagBannerAct[]>([]);
  const [states, setStates] = useState<Record<string, ActState>>({});

  useEffect(() => {
    if (!uid || pending.length === 0) { setAdminActs([]); return; }
    let cancelled = false;
    const { db } = getFirebase();
    Promise.all(pending.map(async (act) => {
      try {
        const snap = await getDoc(doc(db, `profiles/${act.musicianProfileId}/members/${uid}`));
        return snap.data()?.role === "admin" ? act : null;
      } catch {
        // Denied or missing both mean "not an admin of this profile", the
        // same duck-typed shrug useProfileRole.ts's own catch takes.
        return null;
      }
    })).then((results) => {
      if (!cancelled) setAdminActs(results.filter((a): a is ArtistTagBannerAct => a !== null));
    });
    return () => { cancelled = true; };
    // pendingKey (not `pending`, a fresh array every render) is the real
    // dependency: it only changes when the SET of pending musicianProfileIds
    // actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, pendingKey]);

  if (adminActs.length === 0) return null;

  const respond = async (musicianProfileId: string, accept: boolean) => {
    setStates((prev) => ({ ...prev, [musicianProfileId]: { phase: "busy" } }));
    try {
      await callFn("respondToArtistTag", { eventId, musicianProfileId, accept });
      setStates((prev) => ({
        ...prev, [musicianProfileId]: { phase: "done", status: accept ? "accepted" : "declined" },
      }));
    } catch (e) {
      setStates((prev) => ({
        ...prev,
        [musicianProfileId]: { phase: "error", message: e instanceof Error ? e.message : "Could not respond to this tag." },
      }));
    }
  };

  return (
    <div className="mb-4 grid gap-3">
      {adminActs.map((act) => {
        const state: ActState = states[act.musicianProfileId] ?? { phase: "idle" };
        return (
          <div key={act.musicianProfileId} className="rounded-gk border border-gk-border bg-gk-surface p-4">
            <p className="font-syne text-sm font-semibold text-gk-text">{ARTIST_TAG_BANNER_TITLE}</p>
            {state.phase === "done" ? (
              <p className="mt-2 font-sora text-sm text-gk-muted">
                {state.status === "accepted" ? "Accepted" : "Declined"}
              </p>
            ) : (
              <>
                {state.phase === "error" && (
                  <p className="mt-2 font-sora text-sm text-gk-destructive">{state.message}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button size="sm" disabled={state.phase === "busy"} onClick={() => respond(act.musicianProfileId, true)}>
                    Accept
                  </Button>
                  <Button
                    size="sm" variant="secondary" disabled={state.phase === "busy"}
                    onClick={() => respond(act.musicianProfileId, false)}
                  >
                    Decline
                  </Button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

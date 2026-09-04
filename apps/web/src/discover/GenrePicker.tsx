"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { GENRES, genreTargetId, type UserDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { follow, useFollowsContext } from "./useFollows";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

async function callMarkGenrePickerSeen(): Promise<void> {
  await callFn("markGenrePickerSeen", {});
}

// Whether /discover (and, later, the post-purchase prompt) should open the
// genre picker for this account: it hasn't been shown before
// (users/{uid}.genrePickerSeenAt unset) AND the fan doesn't already follow
// any genre. genrePickerSeenAt is read once (getDoc, not a live
// subscription: it only ever needs to reflect "has this been shown", which
// this hook's own markSeen already updates optimistically for same-session
// callers), while the genre-follow check reuses useFollowsContext's live
// subscription (shared with FollowButton via FollowsProvider when one is
// mounted, own listener otherwise) so a fan who picks genres elsewhere
// never gets asked again mid-session either.
export function useGenrePickerGate(uid: string | null): { shouldShow: boolean; markSeen: () => Promise<void> } {
  const { genres, loading: followsLoading } = useFollowsContext(uid);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [seenLoaded, setSeenLoaded] = useState(false);
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setSeenAt(null);
    setSeenLoaded(false);
  }

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.exists() ? (snap.data() as UserDoc) : undefined;
        setSeenAt(data?.genrePickerSeenAt ?? null);
        setSeenLoaded(true);
      })
      .catch(() => { if (!cancelled) setSeenLoaded(true); });
    return () => { cancelled = true; };
  }, [uid]);

  const markSeen = async () => {
    setSeenAt(Date.now()); // optimistic: avoids a re-open flash before the callable round-trips
    await callMarkGenrePickerSeen();
  };

  const shouldShow = uid != null && !followsLoading && seenLoaded && seenAt === null && genres.length === 0;
  return { shouldShow, markSeen };
}

// A dialog offering the 22 GENRES as toggle chips. "Done" follows every
// selected genre, then marks the picker seen; "Skip" only marks it seen.
// Both paths, and any other dismissal (Escape, overlay click), close the
// dialog through the identical `dismiss` handler, so an accidental Escape
// counts as a skip rather than leaving the picker eligible to reopen next
// load.
export function GenrePicker({ open, onClose, preselected }: { open: boolean; onClose: () => void; preselected?: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(genre: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(genre)) next.delete(genre); else next.add(genre);
      return next;
    });
  }

  async function dismiss(withFollows: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (withFollows) {
        for (const genre of selected) await follow(genreTargetId(genre), "genre");
      }
      await callMarkGenrePickerSeen();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) void dismiss(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What do you listen to?</DialogTitle>
          <DialogDescription>Pick a few and the feed leans that way. You can change this any time.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {GENRES.map((g) => (
            <Chip key={g} active={selected.has(g)} onClick={() => toggle(g)} disabled={saving}>
              {formatChipLabel(g)}
            </Chip>
          ))}
        </div>
        {error && <p role="alert" className="font-sora text-sm text-gk-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => void dismiss(false)} disabled={saving}>Skip</Button>
          <Button type="button" onClick={() => void dismiss(true)} disabled={saving}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Task 9: the post-purchase nudge on the event page's own "You're in." state
// (BuyTicketsFlow.tsx's paid-done branch, the ONLY place that mounts this).
// A quiet banner, not an auto-opened dialog: unlike /discover's own
// GenrePicker mount (which opens the instant the gate says so), a fan who
// just finished checkout gets to look at their confirmation first and opens
// the picker on their own terms. Reads useGenrePickerGate itself (rather
// than taking `shouldShow` as a prop) so the banner and the dialog share one
// gate. GenrePicker's OWN dismiss handler (Skip, Done, or Escape/overlay)
// already calls the shared markGenrePickerSeen callable directly, without
// going through any particular useGenrePickerGate instance's local state, so
// THIS component's own gate never learns about it on its own: onClose below
// calls this instance's own `markSeen` too (an extra, harmless call to the
// same idempotent callable) so the local `shouldShow` this banner reads
// flips false immediately and the banner disappears with the dialog, rather
// than sitting there stale until a future reload re-fetches genrePickerSeenAt.
export function PostPurchaseGenrePrompt({ eventGenres }: { eventGenres: string[] }) {
  const { user } = useAuth();
  const { shouldShow, markSeen } = useGenrePickerGate(user?.uid ?? null);
  const [open, setOpen] = useState(false);

  if (!shouldShow) return null;

  return (
    <div className="mt-4 border-t border-gk-success/40 pt-4">
      <p className="font-syne text-sm font-semibold text-gk-text">Want more shows like this?</p>
      <p className="mt-1 font-sora text-sm text-gk-text">
        Pick a few genres and Discover leans that way. You can change this any time.
      </p>
      <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        Pick genres
      </Button>
      <GenrePicker open={open} onClose={() => { setOpen(false); void markSeen(); }} preselected={eventGenres} />
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { GENRES, genreTargetId, type UserDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { follow, useFollows } from "./useFollows";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

async function callMarkGenrePickerSeen(): Promise<void> {
  await httpsCallable(getFirebase().functions, "markGenrePickerSeen")({});
}

// Whether /discover (and, later, the post-purchase prompt) should open the
// genre picker for this account: it hasn't been shown before
// (users/{uid}.genrePickerSeenAt unset) AND the fan doesn't already follow
// any genre. genrePickerSeenAt is read once (getDoc, not a live
// subscription: it only ever needs to reflect "has this been shown", which
// this hook's own markSeen already updates optimistically for same-session
// callers), while the genre-follow check reuses useFollows' live
// subscription so a fan who picks genres elsewhere never gets asked again
// mid-session either.
export function useGenrePickerGate(uid: string | null): { shouldShow: boolean; markSeen: () => Promise<void> } {
  const { genres, loading: followsLoading } = useFollows(uid);
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

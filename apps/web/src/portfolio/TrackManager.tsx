"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { MAX_TRACKS, type TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from "../ui/icons";

type Row = TrackDoc & { id: string };

const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
};
// Same grouping as the pre-restyle inline colors: approved is the only
// success state, rejected/failed are the only destructive ones, and
// everything still in flight (processing or awaiting review) reads as the
// same in-progress warning tint.
const STATUS_VARIANT: Record<TrackDoc["status"], "success" | "warning" | "destructive"> = {
  processing: "warning", pending_review: "warning", approved: "success",
  rejected: "destructive", failed: "destructive",
};

export function TrackManager({ profileId }: { profileId: string }) {
  const [tracks, setTracks] = useState<Row[]>([]);
  // Single flag, not per-row: reorderTracks affects TWO rows at once (the
  // swapped pair), so a per-row lock wouldn't stop a second click from
  // racing the first move's still-in-flight call against a still-stale
  // `tracks` array. Locking every action button while ANY call is in
  // flight is simpler and fully covers that.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);

  const call = async (name: string, data: object) => {
    setBusy(true);
    try { await httpsCallable(getFirebase().functions, name)(data); }
    catch (e) { window.alert(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy || !tracks[i] || !tracks[i + dir]) return;
    // A single reorderTracks call with the whole reordered id list, not two
    // sequential updateTrack({ order }) calls: updateTrack no longer takes
    // an order field (reorderTracks owns ordering, atomically), and two
    // separate calls would be non-atomic (a reload between them leaves two
    // tracks sharing an order) and a no-op on ties.
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void call("reorderTracks", { profileId, trackIds: ids });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/{MAX_TRACKS})
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {tracks.length > 0 && (
          <div className="grid gap-2">
            {tracks.map((t, i) => (
              <div key={t.id} className="rounded-gk-sm border border-gk-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-sora text-sm font-semibold text-gk-text">{t.title}</span>
                  <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                </div>
                {(t.rejectionReason || t.failureReason) && (
                  <p className="mt-1 font-sora text-sm text-gk-destructive">
                    {t.rejectionReason ?? t.failureReason}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy || i === 0}
                    aria-label="Move track up"
                    onClick={() => move(i, -1)}
                  >
                    <IconArrowUp size={16} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy || i === tracks.length - 1}
                    aria-label="Move track down"
                    onClick={() => move(i, 1)}
                  >
                    <IconArrowDown size={16} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label="Rename track"
                    onClick={() => {
                      const title = window.prompt("New title:", t.title)?.trim();
                      if (title) void call("updateTrack", { profileId, trackId: t.id, title });
                    }}
                  >
                    <IconPencil size={16} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label="Delete track"
                    className="text-gk-destructive hover:bg-gk-destructive/14"
                    onClick={() => {
                      if (window.confirm(`Delete "${t.title}"?`)) void call("deleteTrack", { profileId, trackId: t.id });
                    }}
                  >
                    <IconTrash size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <TrimUploader profileId={profileId} onDone={() => { /* onSnapshot refreshes */ }} />
      </CardContent>
    </Card>
  );
}

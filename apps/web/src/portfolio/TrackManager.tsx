"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { MAX_TRACKS, type TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";

type Row = TrackDoc & { id: string };

const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
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
    catch (e) { window.alert(e instanceof Error ? e.message : "That didn't work — try again."); }
    finally { setBusy(false); }
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy || !tracks[i] || !tracks[i + dir]) return;
    // A single reorderTracks call with the whole reordered id list, not two
    // sequential updateTrack({ order }) calls — updateTrack no longer takes
    // an order field (reorderTracks owns ordering, atomically), and two
    // separate calls would be non-atomic (a reload between them leaves two
    // tracks sharing an order) and a no-op on ties.
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void call("reorderTracks", { profileId, trackIds: ids });
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/{MAX_TRACKS})</h2>
      {tracks.map((t, i) => (
        <div key={t.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <strong>{t.title}</strong>{" "}
          <span style={{ fontSize: 13, padding: "2px 8px", borderRadius: 10,
            background: t.status === "approved" ? "#dcfce7" : t.status === "rejected" || t.status === "failed" ? "#fee2e2" : "#fef9c3" }}>
            {STATUS_LABEL[t.status]}
          </span>
          {(t.rejectionReason || t.failureReason) && (
            <p style={{ margin: "4px 0 0", color: "#991b1b" }}>{t.rejectionReason ?? t.failureReason}</p>
          )}
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <button onClick={() => move(i, -1)} disabled={busy || i === 0}>↑</button>
            <button onClick={() => move(i, 1)} disabled={busy || i === tracks.length - 1}>↓</button>
            <button disabled={busy} onClick={() => {
              const title = window.prompt("New title:", t.title)?.trim();
              if (title) void call("updateTrack", { profileId, trackId: t.id, title });
            }}>Rename</button>
            <button disabled={busy} onClick={() => {
              if (window.confirm(`Delete "${t.title}"?`)) void call("deleteTrack", { profileId, trackId: t.id });
            }} style={{ color: "#dc2626" }}>Delete</button>
          </div>
        </div>
      ))}
      <TrimUploader profileId={profileId} onDone={() => { /* onSnapshot refreshes */ }} />
    </section>
  );
}

import { useEffect, useState } from "react";
import { View, Pressable, Alert } from "react-native";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { MAX_TRACKS, type TrackDoc } from "@gatekeep/shared";
import { TrimUploader } from "./TrimUploader";
import { Text, Input, Card, StatusBadge } from "../ui";
import { useTokens } from "../theme/ThemeProvider";

type Row = TrackDoc & { id: string };

const STATUS_LABEL: Record<TrackDoc["status"], string> = {
  processing: "Processing…", pending_review: "In review", approved: "Live",
  rejected: "Rejected", failed: "Failed",
};
// Presentation-only: maps each track status to its StatusBadge tone (was a
// raw hex-background map before the src/ui migration). Does not touch any
// status-driven behavior; it only picks the badge color family.
const STATUS_TONE: Record<TrackDoc["status"], "success" | "warning" | "destructive"> = {
  approved: "success", rejected: "destructive", failed: "destructive",
  processing: "warning", pending_review: "warning",
};

export function TrackManager({ profileId }: { profileId: string }) {
  const tok = useTokens();
  const [tracks, setTracks] = useState<Row[]>([]);
  // Single flag, not per-row: reorderTracks affects TWO rows at once (the
  // swapped pair), so a per-row lock wouldn't stop a second tap from racing
  // the first move's still-in-flight call against a still-stale `tracks`
  // array. Locking every action across every row while ANY call is in
  // flight is simpler and fully covers that.
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))),
      (e) => console.error("tracks onSnapshot failed", e));
  }, [profileId]);

  // Returns whether the call succeeded so callers that need to react to a
  // failure (saveRename re-opening its edit UI below) can, without every
  // fire-and-forget caller having to handle a return value it doesn't need.
  const call = async (name: string, data: object): Promise<boolean> => {
    setBusy(true);
    try { await callFn(name, data); return true; }
    catch (e) { Alert.alert("Error", e instanceof Error ? e.message : "That didn't work, try again."); return false; }
    finally { setBusy(false); }
  };

  const move = (i: number, dir: -1 | 1) => {
    if (busy || !tracks[i] || !tracks[i + dir]) return;
    // A single reorderTracks call with the whole reordered id list, not two
    // sequential updateTrack calls: reorderTracks owns ordering atomically;
    // two separate calls would be non-atomic (a reload between them leaves
    // two tracks sharing an order) and a no-op on ties.
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void call("reorderTracks", { profileId, trackIds: ids });
  };

  const startRename = (t: Row) => { setRenamingId(t.id); setRenameText(t.title); };
  // Exits rename mode immediately (mirroring a native prompt dismissing
  // itself synchronously) rather than waiting on the async call: the Alert
  // inside call() explains a failure, and re-opening below (pre-filled with
  // exactly what was typed, stashed BEFORE closing) means the musician
  // doesn't have to retype it after a transient network/server error.
  const saveRename = (trackId: string) => {
    const typed = renameText;
    const title = typed.trim();
    setRenamingId(null);
    if (!title) return;
    void call("updateTrack", { profileId, trackId, title }).then((ok) => {
      if (!ok) { setRenamingId(trackId); setRenameText(typed); }
    });
  };

  return (
    <View style={{ gap: 8 }}>
      <Text variant="title">
        Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/{MAX_TRACKS})
      </Text>
      {tracks.map((t, i) => (
        <Card key={t.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text variant="label" style={{ flex: 1 }}>{t.title}</Text>
            <StatusBadge label={STATUS_LABEL[t.status]} status={STATUS_TONE[t.status]} />
          </View>
          {(t.rejectionReason || t.failureReason) && (
            <Text color={tok.destructive}>{t.rejectionReason ?? t.failureReason}</Text>
          )}
          {renamingId === t.id ? (
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <Input value={renameText} onChangeText={setRenameText} maxLength={80} autoFocus
                returnKeyType="done" onSubmitEditing={() => saveRename(t.id)}
                style={{ flex: 1 }} />
              <Pressable disabled={busy} onPress={() => saveRename(t.id)}>
                <Text variant="label">Save</Text>
              </Pressable>
              <Pressable onPress={() => setRenamingId(null)}>
                <Text muted>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Pressable disabled={busy || i === 0} onPress={() => move(i, -1)} accessibilityRole="button" accessibilityLabel="Move up">
                <Text style={{ opacity: busy || i === 0 ? 0.4 : 1 }}>↑</Text>
              </Pressable>
              <Pressable disabled={busy || i === tracks.length - 1} onPress={() => move(i, 1)} accessibilityRole="button" accessibilityLabel="Move down">
                <Text style={{ opacity: busy || i === tracks.length - 1 ? 0.4 : 1 }}>↓</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => startRename(t)}>
                <Text style={{ opacity: busy ? 0.4 : 1 }}>Rename</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => Alert.alert("Delete track?", t.title, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive",
                    onPress: () => void call("deleteTrack", { profileId, trackId: t.id }) },
                ])}>
                <Text color={tok.destructive} style={{ opacity: busy ? 0.4 : 1 }}>Delete</Text>
              </Pressable>
            </View>
          )}
        </Card>
      ))}
      <TrimUploader profileId={profileId} onDone={() => { /* onSnapshot refreshes */ }} />
    </View>
  );
}

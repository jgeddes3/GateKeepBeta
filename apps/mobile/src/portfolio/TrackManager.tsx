import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
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
const STATUS_BG: Record<TrackDoc["status"], string> = {
  approved: "#dcfce7", rejected: "#fee2e2", failed: "#fee2e2",
  processing: "#fef9c3", pending_review: "#fef9c3",
};

export function TrackManager({ profileId }: { profileId: string }) {
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
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);

  const call = async (name: string, data: object) => {
    setBusy(true);
    try { await httpsCallable(getFirebase().functions, name)(data); }
    catch (e) { Alert.alert("Error", e instanceof Error ? e.message : "That didn't work — try again."); }
    finally { setBusy(false); }
  };

  const move = (i: number, dir: -1 | 1) => {
    if (busy || !tracks[i] || !tracks[i + dir]) return;
    // A single reorderTracks call with the whole reordered id list, not two
    // sequential updateTrack calls — reorderTracks owns ordering atomically;
    // two separate calls would be non-atomic (a reload between them leaves
    // two tracks sharing an order) and a no-op on ties.
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void call("reorderTracks", { profileId, trackIds: ids });
  };

  const startRename = (t: Row) => { setRenamingId(t.id); setRenameText(t.title); };
  // Exits rename mode immediately (mirroring a native prompt dismissing
  // itself synchronously) rather than waiting on the async call — if it
  // fails, the Alert inside call() explains why and the musician can tap
  // Rename again.
  const saveRename = (trackId: string) => {
    const title = renameText.trim();
    setRenamingId(null);
    if (title) void call("updateTrack", { profileId, trackId, title });
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>
        Tracks ({tracks.filter((t) => !["rejected", "failed"].includes(t.status)).length}/{MAX_TRACKS})
      </Text>
      {tracks.map((t, i) => (
        <View key={t.id} style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontWeight: "600", flex: 1 }}>{t.title}</Text>
            <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, backgroundColor: STATUS_BG[t.status] }}>
              <Text style={{ fontSize: 12 }}>{STATUS_LABEL[t.status]}</Text>
            </View>
          </View>
          {(t.rejectionReason || t.failureReason) && (
            <Text style={{ color: "#991b1b" }}>{t.rejectionReason ?? t.failureReason}</Text>
          )}
          {renamingId === t.id ? (
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={renameText} onChangeText={setRenameText} maxLength={80} autoFocus
                style={{ borderWidth: 1, borderRadius: 8, padding: 8, flex: 1 }} />
              <Pressable disabled={busy} onPress={() => saveRename(t.id)}>
                <Text style={{ fontWeight: "600" }}>Save</Text>
              </Pressable>
              <Pressable onPress={() => setRenamingId(null)}>
                <Text style={{ color: "#666" }}>Cancel</Text>
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
                <Text style={{ color: "#dc2626", opacity: busy ? 0.4 : 1 }}>Delete</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}
      <TrimUploader profileId={profileId} onDone={() => { /* onSnapshot refreshes */ }} />
    </View>
  );
}

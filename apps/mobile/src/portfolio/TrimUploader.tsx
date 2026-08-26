import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import Slider from "@react-native-community/slider";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  validateTrackCreate, AUDIO_CONTENT_TYPES, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput,
} from "@gatekeep/shared";

const UNREADABLE_MSG = "Couldn't read that audio file — try mp3, wav, m4a, aac, flac, or ogg.";
const UNSUPPORTED_MSG = "Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.";

type Picked = { uri: string; name: string; size: number; mimeType: string };

// Pick a local audio file, preview it, drag the 30s window, upload the original.
// The server pipeline trims/transcodes; we never keep the full track.
export function TrimUploader({ profileId, onDone }: { profileId: string; onDone?: () => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [title, setTitle] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // True once the CURRENT `picked` file is known to be unreadable/too-short —
  // set by the status effect below and cleared whenever a new file is picked.
  // Distinguishes "still loading metadata" (duration 0, not yet invalid) from
  // "loaded, but permanently unusable" so the effect fires its alert exactly
  // once per bad pick instead of on every subsequent status tick.
  const [invalid, setInvalid] = useState(false);

  const player = useAudioPlayer(picked ? { uri: picked.uri } : null);
  const status = useAudioPlayerStatus(player);

  // A NEW `picked.uri` always produces a brand-new native AudioPlayer instance
  // (expo-audio keys the underlying player on JSON.stringify(source)), so
  // `status` here starts from THAT player's own fresh status — duration
  // resets to 0 on its own whenever the file changes. Unlike web's
  // TrimUploader (one <audio> element whose `duration` state had to be
  // manually reset in pick() to avoid leaking the PREVIOUS file's length),
  // there's no separate local duration state that can go stale here.
  const rawDuration = status.duration;
  // Mirrors web's onloadedmetadata guard: a file can pass the content-type
  // check yet still be corrupt/unplayable, or report a non-finite/near-0
  // duration. Fold that into `duration` itself (not just into `invalid`) so
  // every consumer below — the render gate, the slider math — automatically
  // treats a bad file the same as "still loading" instead of rendering trim
  // controls against a nonsensical length. `< 1`, not `<= 0`: a sub-1-second
  // "clip" isn't practically previewable or trimmable either.
  const duration = !invalid && Number.isFinite(rawDuration) && rawDuration >= 1 ? rawDuration : 0;

  useEffect(() => {
    if (!picked || invalid) return;
    if (status.error) {
      setInvalid(true);
      Alert.alert("Couldn't read that file", UNREADABLE_MSG);
      return;
    }
    if (status.isLoaded && (!Number.isFinite(status.duration) || status.duration < 1)) {
      setInvalid(true);
      Alert.alert("Couldn't read that file", UNREADABLE_MSG);
    }
  }, [picked, invalid, status.error, status.isLoaded, status.duration]);

  // Stop preview at the end of the 30s window.
  useEffect(() => {
    if (status.playing && status.currentTime >= Math.min(startSec + MAX_CLIP_SECONDS, duration)) {
      player.pause();
    }
  }, [status.currentTime, status.playing, startSec, duration, player]);

  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    // Reject only a KNOWN-bad type — an empty/undefined mimeType is let
    // through on purpose: some OSes report nothing for legitimate but less
    // common containers (m4a, flac) instead of a proper audio/* MIME type,
    // and the server doesn't trust this field either way — ffmpeg sniffs the
    // actual container/codec from the bytes. This is only a cheap
    // client-side triage.
    if (a.mimeType && !(AUDIO_CONTENT_TYPES as readonly string[]).includes(a.mimeType)) {
      Alert.alert("Unsupported format", UNSUPPORTED_MSG);
      return;
    }
    if ((a.size ?? 0) > MAX_AUDIO_UPLOAD_BYTES) {
      Alert.alert("Too big", "Audio files must be under 50 MB.");
      return;
    }
    setInvalid(false);
    setPicked({ uri: a.uri, name: a.name, size: a.size ?? 0, mimeType: a.mimeType ?? "" });
    setStartSec(0);
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ""));
  };

  const preview = () => {
    void player.seekTo(startSec).then(() => player.play()).catch(() => {});
  };

  const upload = async () => {
    if (!picked) return;
    const input: CreateTrackInput = {
      profileId, title: title.trim(), startSec: Math.floor(startSec),
      // picked.mimeType can legitimately be "" (see pick()'s comment above) —
      // fall back to a generic-but-sniffable contentType rather than sending
      // an empty string the server would reject outright.
      sizeBytes: picked.size, contentType: picked.mimeType || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { Alert.alert("Check your track", v.reason); return; }
    setBusy("Requesting upload…");
    // Tracked outside the try so the catch below can tell "createTrack itself
    // failed" (created stays null — nothing to clean up) apart from "the
    // track doc exists but the storage upload after it failed" (created is
    // set — the doc must be cleaned up, or it lingers as a dead
    // "Processing…" row with nothing behind it).
    let created: { trackId: string; uploadPath: string } | null = null;
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      created = data;
      const blob = await (await fetch(picked.uri)).blob();
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), blob,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading… ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      // The try closes HERE, right after the upload itself resolves — every
      // success-path side effect below runs OUTSIDE the try/catch on
      // purpose. onDone() is a callback supplied by the parent; if it (or
      // anything else down here) were to throw while still inside the try,
      // the catch below would see `created` set and delete the track this
      // upload just successfully finished, mistaking a downstream error for
      // an upload failure.
    } catch (e) {
      setBusy(null);
      console.error(e); // the alerts below are deliberately generic — keep the real error in the console
      if (created) {
        try {
          await httpsCallable(getFirebase().functions, "deleteTrack")({ profileId, trackId: created.trackId });
          Alert.alert("Upload failed", "Try again.");
        } catch {
          // Best-effort cleanup itself failed — tell the musician exactly
          // what's left behind instead of a generic message that leaves a
          // dead "Processing…" row unexplained.
          Alert.alert("Upload failed", "Delete the stuck \"Processing…\" entry below and try again.");
        }
      } else {
        Alert.alert("Upload failed", e instanceof Error ? e.message : "Try again.");
      }
      return;
    }
    setBusy(null); setPicked(null); setTitle(""); setInvalid(false);
    onDone?.();
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const windowEnd = Math.min(startSec + MAX_CLIP_SECONDS, duration);
  const sliderMax = Math.max(0, Math.floor(duration - MAX_CLIP_SECONDS));
  // Also covers duration JUST over 30s (e.g. 30.4s): sliderMax would compute
  // to 0 — a degenerate range with nowhere to drag — so treat that the same
  // as "whole file" instead of rendering a slider that can't move.
  const wholeFileUsed = duration > 0 && (duration <= MAX_CLIP_SECONDS || sliderMax === 0);

  return (
    <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: "#bbb", borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ fontWeight: "700" }}>Add a track (30-second snippet)</Text>
      <Pressable onPress={() => void pick()} accessibilityRole="button" accessibilityLabel="Choose an audio file"
        style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
        <Text>{picked ? picked.name : "Choose audio file…"}</Text>
      </Pressable>
      {picked && duration > 0 && (
        <>
          <TextInput placeholder="Track title" value={title} onChangeText={setTitle} maxLength={80}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
          {wholeFileUsed ? (
            <Text>Whole file will be used (30 seconds or less)</Text>
          ) : (
            <>
              <Text>Clip window: {fmt(startSec)} – {fmt(windowEnd)} (of {fmt(duration)})</Text>
              <Slider minimumValue={0} maximumValue={sliderMax} step={1}
                value={startSec} onValueChange={setStartSec} />
            </>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={preview} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
              <Text>▶ Preview</Text>
            </Pressable>
            <Pressable onPress={() => player.pause()} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }}>
              <Text>Stop</Text>
            </Pressable>
            <Pressable onPress={() => void upload()} disabled={busy !== null}
              style={{ backgroundColor: "#111", padding: 10, borderRadius: 8 }}>
              <Text style={{ color: "#fff" }}>{busy ?? "Upload snippet"}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

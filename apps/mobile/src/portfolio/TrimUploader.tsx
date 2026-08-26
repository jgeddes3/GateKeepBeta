import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystemLegacy from "expo-file-system/legacy";
import Slider from "@react-native-community/slider";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  validateTrackCreate, AUDIO_CONTENT_TYPES, MAX_CLIP_SECONDS, type CreateTrackInput,
} from "@gatekeep/shared";

const UNREADABLE_MSG = "Couldn't read that audio file — try mp3, wav, m4a, aac, flac, or ogg.";
const UNSUPPORTED_MSG = "Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.";
// RULING (mobile-only, v1): upload() has no native streaming yet — it reads
// the whole picked file into memory via fetch().blob(), and the Firebase JS
// SDK's chunked resumable upload roughly doubles peak memory while that
// blob is in flight. That's a real Android OOM risk well under the
// SERVER's actual 50 MB cap (MAX_AUDIO_UPLOAD_BYTES, enforced by
// validateTrackCreate/shared and unchanged), so mobile enforces a
// stricter, client-only ceiling for now. Web is unchanged. Follow-up (Task
// 16): switch to expo-file-system's uploadAsync for native streaming and
// lift this cap.
const MOBILE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MOBILE_SIZE_MSG = "On this device, audio files must be under 25 MB — use the web app for larger files.";
// How long to wait, after a pick, for expo-audio to report either a real
// duration or an error before giving up on a file that's silently stuck.
const LOAD_TIMEOUT_MS = 15_000;

type Picked = {
  uri: string; name: string; mimeType: string;
  // null when neither expo-file-system nor the picker itself could confirm
  // a byte count at pick time (rare) — upload() resolves it from the
  // actually-fetched blob before doing anything server-side.
  size: number | null;
};

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
  // Persistent, visible alongside the (dismissable) Alert — a musician who
  // dismissed the alert shouldn't be left staring at a picker with no clue
  // why nothing happened next. Cleared whenever a new pick attempt starts.
  const [error, setError] = useState<string | null>(null);

  // updateInterval: 100, not the 500ms default — the preview-stop effect
  // below compares status.currentTime against the window end every tick;
  // the default interval lets playback run up to half a second past the
  // 30s boundary before it notices.
  const player = useAudioPlayer(picked ? { uri: picked.uri } : null, { updateInterval: 100 });
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

  const flagInvalid = useCallback((msg: string) => {
    setInvalid(true);
    setError(msg);
    Alert.alert("Couldn't read that file", msg);
  }, []);

  useEffect(() => {
    if (!picked || invalid) return;
    if (status.error) { flagInvalid(UNREADABLE_MSG); return; }
    // expo-audio's AudioStatus.duration is 0 "until determined" — that can
    // still be true even after isLoaded flips (per expo-audio's docs), so a
    // bare `duration < 1` check would misjudge a file that just hasn't
    // reported its length YET as unreadable. Only judge validity once a
    // REAL (nonzero) duration has actually come back.
    if (status.duration > 0 && (!Number.isFinite(status.duration) || status.duration < 1)) {
      flagInvalid(UNREADABLE_MSG);
    }
  }, [picked, invalid, status.error, status.duration, flagInvalid]);

  // Bounds the wait: a file that's neither erroring nor reporting a usable
  // duration within 15s (e.g. a container expo-audio can open but never
  // finishes probing) would otherwise leave the picker showing nothing,
  // forever, with no feedback — the same silent-dead-UI risk PhotoUploader's
  // 60s timeout guards against. Cleared as soon as the file resolves either
  // way (duration > 0, or the effect above already flagged it invalid) or a
  // new file is picked.
  useEffect(() => {
    if (!picked || invalid || duration > 0) return;
    const t = setTimeout(() => flagInvalid(UNREADABLE_MSG), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [picked, invalid, duration, flagInvalid]);

  // Stop preview at the end of the 30s window.
  useEffect(() => {
    if (status.playing && status.currentTime >= Math.min(startSec + MAX_CLIP_SECONDS, duration)) {
      player.pause();
    }
  }, [status.currentTime, status.playing, startSec, duration, player]);

  const pick = async () => {
    setError(null);
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
      setError(UNSUPPORTED_MSG);
      Alert.alert("Unsupported format", UNSUPPORTED_MSG);
      return;
    }
    // DocumentPickerAsset.size is OPTIONAL on Android — `a.size ?? 0` would
    // silently bypass the cap below and go on to send sizeBytes: 0 to
    // createTrack, producing a confusing "at most 50 MB" server error for a
    // file that was never actually oversized. The file was just copied to
    // cache (copyToCacheDirectory: true), so it's guaranteed to exist
    // locally — ask expo-file-system for its real, authoritative byte
    // count instead of trusting the picker's self-reported size.
    let size: number | null = null;
    try {
      const info = await FileSystemLegacy.getInfoAsync(a.uri);
      if (info.exists && info.size) size = info.size;
    } catch {
      // Fall through to the picker's own size, then to upload()'s
      // blob.size re-check.
    }
    if (size === null && typeof a.size === "number" && a.size > 0) size = a.size;
    if (size !== null && size > MOBILE_MAX_AUDIO_BYTES) {
      setError(MOBILE_SIZE_MSG);
      Alert.alert("Too big", MOBILE_SIZE_MSG);
      return;
    }
    setInvalid(false);
    setPicked({ uri: a.uri, name: a.name, size, mimeType: a.mimeType ?? "" });
    setStartSec(0);
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ""));
  };

  const preview = () => {
    void player.seekTo(startSec).then(() => player.play()).catch(() => {});
  };

  const upload = async () => {
    if (!picked || busy !== null) return;
    // Busy from the very first await: the rare size-unknown branch below
    // fetches the whole file before createTrack runs, and an enabled button
    // during that window would let a double-tap mint two track docs.
    setBusy("Checking file…");
    // Neither expo-file-system nor the picker could confirm a byte count at
    // pick time (rare) — resolve it now from the actual fetched bytes and
    // re-check the mobile cap BEFORE ever asking the server to create a
    // track doc for a file that turns out to be oversized.
    let sizeBytes = picked.size;
    let prefetchedBlob: Blob | null = null;
    if (sizeBytes === null) {
      try {
        prefetchedBlob = await (await fetch(picked.uri)).blob();
      } catch (e) {
        console.error(e);
        setBusy(null);
        setError(UNREADABLE_MSG);
        Alert.alert("Couldn't read that file", UNREADABLE_MSG);
        return;
      }
      sizeBytes = prefetchedBlob.size;
      if (sizeBytes > MOBILE_MAX_AUDIO_BYTES) {
        setBusy(null);
        setError(MOBILE_SIZE_MSG);
        Alert.alert("Too big", MOBILE_SIZE_MSG);
        return;
      }
    }
    // Never send a non-positive size — createTrack's validator would reject
    // it anyway, but catching it here keeps the message specific to what
    // actually went wrong instead of a generic validation failure.
    if (sizeBytes < 1) {
      setBusy(null);
      setError(UNREADABLE_MSG);
      Alert.alert("Couldn't read that file", UNREADABLE_MSG);
      return;
    }
    const input: CreateTrackInput = {
      profileId, title: title.trim(), startSec: Math.floor(startSec),
      // picked.mimeType can legitimately be "" (see pick()'s comment above) —
      // fall back to a generic-but-sniffable contentType rather than sending
      // an empty string the server would reject outright.
      sizeBytes, contentType: picked.mimeType || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { setBusy(null); Alert.alert("Check your track", v.reason); return; }
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
      const blob = prefetchedBlob ?? await (await fetch(picked.uri)).blob();
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
    setBusy(null); setPicked(null); setTitle(""); setInvalid(false); setError(null);
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
      {error && <Text style={{ color: "#dc2626" }}>{error}</Text>}
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
                value={startSec} onValueChange={setStartSec}
                accessibilityLabel="Clip window start time" accessibilityRole="adjustable" />
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

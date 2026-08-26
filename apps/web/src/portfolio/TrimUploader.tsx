"use client";
import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  validateTrackCreate, AUDIO_CONTENT_TYPES, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput,
} from "@gatekeep/shared";

const UNREADABLE_MSG = "Couldn't read that audio file — try mp3, wav, m4a, aac, flac, or ogg.";
const UNSUPPORTED_MSG = "Unsupported audio format — use mp3, wav, m4a, aac, flac, or ogg.";

// Pick a local audio file, preview it, drag the 30s window, upload the original.
// The server pipeline trims/transcodes; we never keep the full track.
export function TrimUploader({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  // ontimeupdate closes over state — keep the live value in a ref so the
  // handler (registered once per file, in pick()) always sees the current
  // slider position instead of the value at the time it was attached.
  const startRef = useRef(0);
  useEffect(() => { startRef.current = startSec; }, [startSec]);

  useEffect(() => () => { // revoke on unmount
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    audioRef.current?.pause();
  }, []);

  const pick = (f: File) => {
    setError(null);
    // Reset stale metadata from any previously picked file immediately —
    // otherwise a leftover `duration` from the last file renders a window
    // slider against the WRONG file's length until (if ever) this file's
    // onloadedmetadata fires.
    setDuration(0);
    // Reject only a KNOWN-bad type — a non-empty MIME type outside the
    // allowlist (e.g. "video/mp4", "text/plain"). An EMPTY f.type is let
    // through on purpose: some OSes/browsers report "" for legitimate but
    // less common containers (m4a, flac) instead of a proper audio/* MIME
    // type, and the server doesn't trust this field either way — ffmpeg
    // sniffs the actual container/codec from the bytes server-side. `pick`
    // is only a cheap client-side triage; gating on "empty" specifically
    // would reject real files this allowlist is supposed to accept. (See
    // upload() below, which falls back to "audio/mpeg" as a generic-but-
    // sniffable contentType for the empty case.)
    if (f.type && !(AUDIO_CONTENT_TYPES as readonly string[]).includes(f.type)) {
      setError(UNSUPPORTED_MSG);
      return;
    }
    if (f.size > MAX_AUDIO_UPLOAD_BYTES) { setError("File is over 50 MB."); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(f);
    const audio = new Audio(objectUrl.current);
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      // A file can pass the content-type check above yet still be
      // corrupt/unplayable (or report a nonsensical duration) — don't let
      // that silently produce a near-0-length or NaN clip window. `< 1`,
      // not `<= 0`: a sub-1-second "clip" isn't practically previewable or
      // trimmable either, so it's treated the same as unreadable.
      if (!Number.isFinite(d) || d < 1) { setError(UNREADABLE_MSG); return; }
      setDuration(d);
    };
    audio.onerror = () => setError(UNREADABLE_MSG);
    // Preview stops at the end of the 30s window.
    audio.ontimeupdate = () => {
      if (audio.currentTime >= Math.min(startRef.current + MAX_CLIP_SECONDS, audio.duration)) audio.pause();
    };
    audioRef.current?.pause();
    audioRef.current = audio;
    setFile(f);
    setStartSec(0);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const preview = () => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = startSec;
    void a.play();
  };

  const upload = async () => {
    if (!file) return;
    const input: CreateTrackInput = {
      profileId, title: title.trim(), startSec: Math.floor(startSec),
      // file.type can legitimately be "" (see pick()'s comment above) — fall
      // back to a generic-but-sniffable contentType rather than sending an
      // empty string the server would reject outright; ffmpeg determines
      // the real container/codec from the bytes regardless of this value.
      sizeBytes: file.size, contentType: file.type || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy("Requesting upload…"); setError(null);
    // Tracked outside the try so the catch below can tell "createTrack
    // itself failed" (created stays null — nothing to clean up) apart from
    // "the track doc exists but the storage upload after it failed" (created
    // is set — the doc must be cleaned up, or it lingers as a dead
    // "Processing…" row with nothing behind it).
    let created: { trackId: string; uploadPath: string } | null = null;
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      created = data;
      // uploadPath comes straight from createTrack's response — never
      // reconstructed client-side, so the client and server always agree on
      // the staging object path even if stagingAudioPath's shape changes.
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), file,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading… ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      // The try closes HERE, right after the upload itself resolves — the
      // success-path side effects below run OUTSIDE the try/catch on
      // purpose. onDone() is a callback supplied by the parent; if it (or
      // anything else down here) were to throw while still inside the try,
      // the catch below would see `created` set and delete the track this
      // upload just successfully finished, mistaking a downstream error for
      // an upload failure.
    } catch (e) {
      setBusy(null);
      console.error(e); // the alert below is deliberately generic — keep the real error in the console
      if (created) {
        try {
          await httpsCallable(getFirebase().functions, "deleteTrack")({ profileId, trackId: created.trackId });
          setError("Upload failed — try again.");
        } catch {
          // Best-effort cleanup itself failed — tell the musician exactly
          // what's left behind instead of a generic message that leaves a
          // dead "Processing…" row unexplained.
          setError("Upload failed — delete the stuck 'Processing…' entry below and try again.");
        }
      } else {
        setError(e instanceof Error ? e.message : "Upload failed — try again.");
      }
      return;
    }
    setBusy(null); setFile(null); setTitle("");
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
    onDone();
  };

  const windowEnd = Math.min(startSec + MAX_CLIP_SECONDS, duration);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const sliderMax = Math.max(0, Math.floor(duration - MAX_CLIP_SECONDS));
  // Also covers the case where duration is JUST over 30s (e.g. 30.4s): the
  // slider's max would compute to 0 — a degenerate range with nowhere to
  // drag — so treat that the same as "whole file" instead of rendering a
  // slider that can't move.
  const wholeFileUsed = duration > 0 && (duration <= MAX_CLIP_SECONDS || sliderMax === 0);
  return (
    <div style={{ border: "1px dashed #bbb", borderRadius: 8, padding: 16, display: "grid", gap: 8 }}>
      <strong>Add a track (30-second snippet)</strong>
      <input type="file" accept={AUDIO_CONTENT_TYPES.join(",")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allows re-picking the same file after an error/removal
          if (f) pick(f);
        }} />
      {file && duration > 0 && (
        <>
          <input placeholder="Track title" value={title} maxLength={80}
            onChange={(e) => setTitle(e.target.value)} />
          {wholeFileUsed ? (
            <p style={{ margin: 0 }}>Whole file will be used (30 seconds or less)</p>
          ) : (
            <label>
              Clip window: {fmt(startSec)} – {fmt(windowEnd)} (of {fmt(duration)})
              <input type="range" min={0} max={sliderMax} step={1}
                value={startSec} style={{ width: "100%" }}
                onChange={(e) => setStartSec(Number(e.target.value))} />
            </label>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={preview}>▶ Preview window</button>
            <button type="button" onClick={() => audioRef.current?.pause()}>Stop</button>
            <button type="button" onClick={upload} disabled={busy !== null}>{busy ?? "Upload snippet"}</button>
          </div>
        </>
      )}
      {error && <p style={{ color: "#dc2626", margin: 0 }}>{error}</p>}
    </div>
  );
}

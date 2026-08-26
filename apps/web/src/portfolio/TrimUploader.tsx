"use client";
import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { validateTrackCreate, MAX_CLIP_SECONDS, MAX_AUDIO_UPLOAD_BYTES, type CreateTrackInput } from "@gatekeep/shared";

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
    if (f.size > MAX_AUDIO_UPLOAD_BYTES) { setError("File is over 50 MB."); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(f);
    const audio = new Audio(objectUrl.current);
    audio.onloadedmetadata = () => setDuration(audio.duration);
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
      sizeBytes: file.size, contentType: file.type || "audio/mpeg",
    };
    const v = validateTrackCreate(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy("Requesting upload…"); setError(null);
    try {
      const { functions, storage } = getFirebase();
      const { data } = await httpsCallable<CreateTrackInput, { trackId: string; uploadPath: string }>(
        functions, "createTrack")(input);
      // uploadPath comes straight from createTrack's response — never
      // reconstructed client-side, so the client and server always agree on
      // the staging object path even if stagingAudioPath's shape changes.
      const task = uploadBytesResumable(storageRef(storage, data.uploadPath), file,
        { contentType: input.contentType });
      task.on("state_changed",
        (s) => setBusy(`Uploading… ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`));
      await task;
      setBusy(null); setFile(null); setTitle("");
      if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
      onDone();
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "Upload failed — try again.");
    }
  };

  const windowEnd = Math.min(startSec + MAX_CLIP_SECONDS, duration);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div style={{ border: "1px dashed #bbb", borderRadius: 8, padding: 16, display: "grid", gap: 8 }}>
      <strong>Add a track (30-second snippet)</strong>
      <input type="file" accept="audio/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
      {file && duration > 0 && (
        <>
          <input placeholder="Track title" value={title} maxLength={80}
            onChange={(e) => setTitle(e.target.value)} />
          <label>
            Clip window: {fmt(startSec)} – {fmt(windowEnd)} (of {fmt(duration)})
            <input type="range" min={0} max={Math.max(0, Math.floor(duration - 1))} step={1}
              value={startSec} style={{ width: "100%" }}
              onChange={(e) => setStartSec(Number(e.target.value))} />
          </label>
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

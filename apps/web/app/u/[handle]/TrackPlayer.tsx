"use client";
import { useEffect, useRef, useState } from "react";

// One clip playing at a time across the page.
let currentAudio: HTMLAudioElement | null = null;

// null → no measured duration yet (still show nothing); 0 is a real
// (if degenerate) duration and must render "0:00", not be treated as falsy.
function formatDuration(durationSec: number | null): string {
  if (durationSec === null) return "";
  return `${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, "0")}`;
}

export function TrackPlayer({ title, url, durationSec }: { title: string; url: string; durationSec: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Unmount cleanup: stop playback and release the module-level "now
  // playing" pointer so a departed track can't block the next one.
  useEffect(() => () => {
    audioRef.current?.pause();
    if (currentAudio === audioRef.current) currentAudio = null;
  }, []);

  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) { audio.pause(); return; }
    if (currentAudio && currentAudio !== audio) currentAudio.pause();
    currentAudio = audio;
    audio.play().catch(() => setPlaying(false));
    setPlaying(true);
  };
  return (
    <button className="trackRow" onClick={toggle} aria-pressed={playing} aria-label={`${playing ? "Pause" : "Play"} ${title}`}>
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      <span>{title}</span>
      <span className="trackDur">{formatDuration(durationSec)}</span>
    </button>
  );
}

"use client";
import { useRef, useState } from "react";

// One clip playing at a time across the page.
let currentAudio: HTMLAudioElement | null = null;

export function TrackPlayer({ title, url, durationSec }: { title: string; url: string; durationSec: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) { audio.pause(); return; }
    if (currentAudio && currentAudio !== audio) currentAudio.pause();
    currentAudio = audio;
    void audio.play();
    setPlaying(true);
  };
  return (
    <button className="trackRow" onClick={toggle} aria-label={`${playing ? "Pause" : "Play"} ${title}`}>
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      <span>{title}</span>
      <span className="trackDur">{durationSec ? `0:${String(Math.round(durationSec)).padStart(2, "0")}` : ""}</span>
    </button>
  );
}

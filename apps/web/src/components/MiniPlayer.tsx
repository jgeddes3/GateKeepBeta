"use client";
import { useEffect, useState } from "react";
import { toggleNowPlaying, useNowPlaying } from "./trackPlayback";
import { IconPause, IconPlay } from "../ui/icons";

// Sub-project 9A task 9: the sticky mini-player (spec section 4 + DESIGN.md
// "Glass cap"), glass use 2 of 2 product-wide. Reads and controls
// trackPlayback.ts's shared store; it creates no Audio element, calls no
// play()/pause() of its own logic beyond that store's toggleNowPlaying, and
// owns no playback state: everything here is presentation over state a
// TrackPlayer row (or the hero's instant-play button) already produced.
// Mounted once per artist page; appears the instant any track becomes
// current (DESIGN.md: "Appears when audio starts anywhere").
export function MiniPlayer({ artistName }: { artistName: string }) {
  const entry = useNowPlaying();
  const [progress, setProgress] = useState(0);

  // Render-time reset (not an effect body's synchronous setState, which
  // eslint-config-next's react-hooks/set-state-in-effect rule flags): the
  // same "adjust state when a dependency changes, during render" idiom
  // useMyProfiles.ts's own uid-change reset already uses. Without it, a
  // fresh track would show the previous one's scrub position for a frame
  // until the effect below's own update() call overwrites it.
  const [trackedId, setTrackedId] = useState(entry?.id ?? null);
  if ((entry?.id ?? null) !== trackedId) {
    setTrackedId(entry?.id ?? null);
    setProgress(0);
  }

  // Progress readout only: listens to the SAME <audio> element's native
  // timeupdate event, no new playback/seek logic.
  useEffect(() => {
    if (!entry) return;
    const audio = entry.audio;
    const update = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    update();
    audio.addEventListener("timeupdate", update);
    audio.addEventListener("loadedmetadata", update);
    return () => {
      audio.removeEventListener("timeupdate", update);
      audio.removeEventListener("loadedmetadata", update);
    };
  }, [entry, entry?.audio]);

  if (!entry) return null;

  return (
    <div
      role="region"
      aria-label="Now playing"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-gk-border/70 bg-gk-surface/75 backdrop-blur-md"
    >
      <div className="h-0.5 w-full bg-gk-border" role="progressbar" aria-label="Track progress"
        aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-gk-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={toggleNowPlaying}
          aria-label={entry.playing ? "Pause" : "Play"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gk-accent text-gk-on-accent outline-none transition-colors hover:bg-gk-accent/90 focus-visible:ring-2 focus-visible:ring-gk-focus"
        >
          {entry.playing ? <IconPause size={16} aria-hidden="true" /> : <IconPlay size={16} aria-hidden="true" />}
        </button>
        <div className="min-w-0">
          <p className="truncate font-sora text-sm font-medium text-gk-text">{entry.title}</p>
          <p className="truncate font-sora text-xs text-gk-muted">{artistName}</p>
        </div>
      </div>
    </div>
  );
}

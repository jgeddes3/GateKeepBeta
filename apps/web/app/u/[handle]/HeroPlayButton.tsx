"use client";
import { useTrackPlayback } from "../../../src/components/trackPlayback";
import { IconPause, IconPlay } from "../../../src/ui/icons";

// Sub-project 9A task 9: the hero's instant-play button (spec 6.4), which
// "plays the artist's FIRST approved track via the existing play mechanism
// and reveals the MiniPlayer." Calls the exact same useTrackPlayback hook the
// TRACKS section's own rows call (see TrackPlayer.tsx), pointed at track
// zero: not a second play mechanism, and the MiniPlayer's reveal is already
// a side effect of trackPlayback.ts's shared store gaining a current entry,
// not anything this button does directly.
export function HeroPlayButton({ id, title, url }: { id: string; title: string; url: string }) {
  const { playing, toggle } = useTrackPlayback(id, title, url);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={playing}
      aria-label={`${playing ? "Pause" : "Play"} ${title}`}
      className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gk-accent text-gk-on-accent outline-none transition-colors hover:bg-gk-accent/90 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      {playing ? <IconPause size={18} aria-hidden="true" /> : <IconPlay size={18} aria-hidden="true" />}
    </button>
  );
}

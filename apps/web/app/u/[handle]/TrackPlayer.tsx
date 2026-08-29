"use client";
import { useTrackPlayback } from "../../../src/components/trackPlayback";
import { IconPause, IconPlay } from "../../../src/ui/icons";

// Sub-project 9A task 9 restyle: the play/pause/audio-element mechanism
// (Audio() creation, currentAudio pointer, onended/onpause/onerror wiring)
// moved verbatim into src/components/trackPlayback.ts's useTrackPlayback so
// the new MiniPlayer can observe/control the same element (see that file's
// own comment). This component is presentation only now: a row, an icon, a
// title, a duration. `id` is a new required prop (previously unused beyond
// the call site's React `key`): the shared store needs it to tell tracks
// apart.

// null -> no measured duration yet (still show nothing); 0 is a real
// (if degenerate) duration and must render "0:00", not be treated as falsy.
function formatDuration(durationSec: number | null): string {
  if (durationSec === null) return "";
  return `${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, "0")}`;
}

export function TrackPlayer({ id, title, url, durationSec }: {
  id: string; title: string; url: string; durationSec: number | null;
}) {
  const { playing, toggle } = useTrackPlayback(id, title, url);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={playing}
      aria-label={`${playing ? "Pause" : "Play"} ${title}`}
      className="flex w-full items-center gap-3 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 text-left outline-none transition-colors hover:border-gk-accent/50 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      {/* Neutral (not ember): DESIGN.md's accent-dosage rule reserves ember
          for the single most important thing on a screen, and the hero's
          instant-play button already carries that role. bg-gk-accent/14 +
          text-gk-accent is Badge's "accent" variant, and that variant's own
          comment restricts it to sitting over --gk-scrim (always dark): a
          plain surface row like this one is exactly the case it excludes,
          since bare ember icon color fails AA on a light-theme surface. */}
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gk-border/60 text-gk-text"
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </span>
      <span className="min-w-0 flex-1 truncate font-sora text-sm text-gk-text">{title}</span>
      <span className="shrink-0 font-sora text-xs text-gk-muted">{formatDuration(durationSec)}</span>
    </button>
  );
}

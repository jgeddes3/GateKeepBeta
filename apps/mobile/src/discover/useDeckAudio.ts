import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAudioPlayer } from "expo-audio";
import { useFocusEffect } from "expo-router";
import type { DeckCard } from "@gatekeep/shared";
import { publicStorageUrl } from "./storageUrl";
import { readDeckMute, writeDeckMute } from "./deckPrefs";

// SP7 Task 12: the deck's single audio player (design spec section 6,
// "One `useAudioPlayer` at deck level"). The deck never mounts one player
// per card: `bind` swaps the source on the one instance as cards scroll
// past, exactly the way app/artist/[handle].tsx's track list swaps sources
// on its own single player.
//
// Loading is status-driven, not fire-and-forget. `replace()` returns
// nothing and does not throw on a URL that will 404, and `seekTo()` against
// a source that has not loaded yet rejects, so the sequence is:
//
//   bind -> replace(uri) -> wait for playbackStatusUpdate -> seekTo -> play
//
// The listener is the only place that starts playback, and every start
// re-checks `bound.current` identity first, so a fast swipe cannot apply an
// older card's seek or play over the newer card's.
//
// The same listener is what marks a card silent: a source that fails to
// load reports `status.error` rather than throwing anywhere this hook could
// catch it. Errors arriving in the first few hundred ms after a swap are
// ignored, since a queued error from the source just replaced would
// otherwise be blamed on the card that replaced it.
//
// Playback gate, in one place (`canPlay`): sound comes out only while the
// Discover tab is focused AND the app is foregrounded. That covers all three
// of the spec's stop conditions:
//   - tab blur: useFocusEffect's cleanup pauses and drops the gate
//   - app background: the AppState listener pauses and the gate re-checks
//     AppState.currentState on the way back
//   - flipping to List: DeckScreen calls stop()
// Returning to the tab (or to the foreground) resumes the card the fan left
// mid-play, since a deck that goes permanently silent until the next scroll
// would leave the mute toggle as the only way to hear anything again.
//
// Every player call is wrapped: a dev client built before expo-audio was
// linked throws on the first call rather than returning a dead object.

type BoundTrack = {
  id: string;
  uri: string;
  startSec: number;
  // Set once the status listener has taken this track through seek + play,
  // so a status tick every half second does not restart it.
  started: boolean;
  // When replace() was called for this track, for the stale-error window.
  replacedAt: number;
};

// A playback error reported within this many ms of a source swap is treated
// as belonging to the source that was just replaced, not to the new one. A
// real failure on a remote track cannot come back faster than a round trip.
const STALE_ERROR_MS = 300;

export interface DeckAudio {
  bind: (card: DeckCard | null) => void;
  muted: boolean;
  toggleMute: () => void;
  stop: () => void;
}

// expo-audio exposes mute as a property setter, and the React Compiler's
// immutability rule refuses a property assignment onto a hook's return value
// inside the hook body. Routing it through a module-level helper says the
// honest thing anyway: the native player is an external mutable resource,
// not React state.
function applyMute(target: { muted: boolean }, muted: boolean): void {
  target.muted = muted;
}

export function useDeckAudio(): DeckAudio {
  const player = useAudioPlayer(null);
  const [muted, setMuted] = useState(false);
  // The card whose preview is currently loaded. Kept in a ref, not state:
  // binding a card must not re-render the deck (the FlatList is already
  // re-rendering for the scroll that caused the bind).
  const bound = useRef<BoundTrack | null>(null);
  // Cards whose preview failed to load. Also a ref: the visible "No preview
  // yet" line is driven by `card.preview === null` at render time, so this
  // set only needs to stop a failing track being retried, not repaint.
  const silentIds = useRef<Set<string>>(new Set());
  const focused = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readDeckMute().then((v) => { if (!cancelled) setMuted(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      applyMute(player, muted);
    } catch (e) {
      console.warn("deck audio: could not apply mute", e);
    }
  }, [player, muted]);

  const pause = useCallback(() => {
    try {
      player.pause();
    } catch (e) {
      console.warn("deck audio: pause failed", e);
    }
  }, [player]);

  const markSilent = useCallback((track: BoundTrack, reason: unknown) => {
    console.warn("deck audio: preview unavailable", track.id, reason);
    silentIds.current.add(track.id);
    if (bound.current === track) bound.current = null;
    pause();
  }, [pause]);

  const canPlay = useCallback(() => focused.current && AppState.currentState === "active", []);

  // Second half of the load sequence, run from the status listener once the
  // source reports itself loaded. Every step re-checks that this track is
  // still the bound one (last swipe wins).
  const start = useCallback((track: BoundTrack) => {
    track.started = true;
    const playNow = () => {
      if (bound.current !== track || !canPlay()) return;
      try {
        player.play();
      } catch (e) {
        markSilent(track, e);
      }
    };
    if (track.startSec <= 0) {
      playNow();
      return;
    }
    try {
      player.seekTo(track.startSec).then(playNow).catch((e) => {
        // A refused seek is not a dead track: play the preview from the top
        // rather than dropping the card into silence.
        console.warn("deck audio: seek failed, playing from the start", track.id, e);
        playNow();
      });
    } catch (e) {
      markSilent(track, e);
    }
  }, [player, canPlay, markSilent]);

  const load = useCallback((track: BoundTrack) => {
    if (!canPlay()) return;
    track.started = false;
    track.replacedAt = Date.now();
    try {
      player.replace({ uri: track.uri });
    } catch (e) {
      markSilent(track, e);
    }
  }, [player, canPlay, markSilent]);

  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      const track = bound.current;
      if (!track) return;
      if (status.error) {
        if (Date.now() - track.replacedAt < STALE_ERROR_MS) return;
        markSilent(track, status.error);
        return;
      }
      if (status.isLoaded && !track.started) start(track);
    });
    return () => sub.remove();
  }, [player, start, markSilent]);

  const bind = useCallback((card: DeckCard | null) => {
    const preview = card?.preview ?? null;
    if (!card || !preview || silentIds.current.has(card.id)) {
      bound.current = null;
      pause();
      return;
    }
    if (bound.current?.id === card.id) return;
    const track: BoundTrack = {
      id: card.id,
      uri: publicStorageUrl(preview.trackPath),
      startSec: preview.startSec,
      started: false,
      replacedAt: 0,
    };
    bound.current = track;
    load(track);
  }, [load, pause]);

  // Back from a blur or from the background. A track that already reached
  // `started` only needs play(); one that never got that far is reloaded.
  const resume = useCallback(() => {
    const track = bound.current;
    if (!track || !canPlay()) return;
    if (!track.started) {
      load(track);
      return;
    }
    try {
      player.play();
    } catch (e) {
      markSilent(track, e);
    }
  }, [player, canPlay, load, markSilent]);

  // Public stop, for flipping to the List view: forgets the bound card too,
  // so coming back to the deck starts the visible card from its own
  // startSec rather than resuming a track the fan stopped hearing minutes
  // ago.
  const stop = useCallback(() => {
    bound.current = null;
    pause();
  }, [pause]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      void writeDeckMute(next);
      return next;
    });
  }, []);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    resume();
    return () => {
      focused.current = false;
      pause();
    };
  }, [resume, pause]));

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") resume();
      else pause();
    });
    return () => sub.remove();
  }, [resume, pause]);

  return { bind, muted, toggleMute, stop };
}

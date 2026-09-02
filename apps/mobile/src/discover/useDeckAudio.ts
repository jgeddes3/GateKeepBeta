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
// Playback gate, in one place (`play` below): sound comes out only while
// the Discover tab is focused AND the app is foregrounded. That covers all
// three of the spec's stop conditions:
//   - tab blur: useFocusEffect's cleanup pauses and drops the gate
//   - app background: the AppState listener pauses and the gate re-checks
//     AppState.currentState on the way back
//   - flipping to List: DeckScreen calls stop()
// Returning to the tab (or to the foreground) resumes the card the fan left
// mid-play, since a deck that goes permanently silent until the next scroll
// would leave the mute toggle as the only way to hear anything again.
//
// Every player call is wrapped: a dev client built before expo-audio was
// linked throws on the first call rather than returning a dead object, and
// a card whose track will not load is marked silent in `silentIds` so the
// deck never retries it on the way back up the list.

type BoundTrack = { id: string; uri: string; startSec: number };

// expo-audio exposes mute as a property setter, and the React Compiler's
// immutability rule refuses a property assignment onto a hook's return value
// inside the hook body. Routing it through a module-level helper says the
// honest thing anyway: the native player is an external mutable resource,
// not React state.
function applyMute(target: { muted: boolean }, muted: boolean): void {
  target.muted = muted;
}

export interface DeckAudio {
  bind: (card: DeckCard | null) => void;
  muted: boolean;
  toggleMute: () => void;
  stop: () => void;
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

  const play = useCallback((track: BoundTrack) => {
    if (!focused.current || AppState.currentState !== "active") return;
    try {
      player.replace({ uri: track.uri });
      if (track.startSec > 0) void player.seekTo(track.startSec);
      player.play();
    } catch (e) {
      console.warn("deck audio: could not play preview", track.id, e);
      silentIds.current.add(track.id);
      if (bound.current?.id === track.id) bound.current = null;
      pause();
    }
  }, [player, pause]);

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
    };
    bound.current = track;
    play(track);
  }, [play, pause]);

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
    if (bound.current) play(bound.current);
    return () => {
      focused.current = false;
      pause();
    };
  }, [play, pause]));

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (bound.current) play(bound.current);
      } else {
        pause();
      }
    });
    return () => sub.remove();
  }, [play, pause]);

  return { bind, muted, toggleMute, stop };
}

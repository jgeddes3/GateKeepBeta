"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";

// Sub-project 9A task 9: wraps the pre-restyle TrackPlayer.tsx's playback
// mechanism (SP2) in a tiny observable store so a SECOND surface, the new
// MiniPlayer, can show and control whatever track is current without a
// second play/pause/seek implementation of its own. The actual audio work
// below (creating one Audio() per track, calling play()/pause(), the
// onended/onpause/onerror wiring, and "starting a new track pauses whatever
// else was playing") is the exact SP2 mechanism, just relocated from a
// private module-level `currentAudio` variable (invisible outside
// TrackPlayer.tsx) to this shared, subscribable one. No new audio logic.

export type NowPlayingEntry = { id: string; title: string; audio: HTMLAudioElement; playing: boolean };

let current: NowPlayingEntry | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): NowPlayingEntry | null {
  return current;
}

// SSR-safe: this module only ever runs in "use client" components, but
// useSyncExternalStore still requires a server snapshot. No track is ever
// "current" on the server, matching every other client-only piece of state
// on this page (e.g. TrackPlayer's own pre-restyle useState(false)).
function getServerSnapshot(): NowPlayingEntry | null {
  return null;
}

export function useNowPlaying(): NowPlayingEntry | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function setCurrentPlaying(audio: HTMLAudioElement, playing: boolean) {
  // A different track has since become current (or nothing is): an event
  // firing on an ABANDONED <audio> element (e.g. a lingering onpause from
  // the track that just got paused-to-switch-away-from) must not clobber
  // whichever track actually owns `current` now.
  if (current?.audio !== audio) return;
  current = { ...current, playing };
  notify();
}

// MiniPlayer's own play/pause control: toggles the SAME Audio element
// useTrackPlayback below already created, the identical play()/pause()
// calls a track row's own button makes.
export function toggleNowPlaying() {
  if (!current) return;
  if (current.playing) { current.audio.pause(); return; }
  current = { ...current, playing: true };
  notify();
  current.audio.play().catch(() => setCurrentPlaying(current!.audio, false));
}

// One playable track. Used by both TrackPlayer's own row (this page's
// existing tracks list) and the hero's instant-play button (Task 9): both
// call this exact hook, pointed at different tracks, so "play the first
// approved track" is never a second, parallel play mechanism.
export function useTrackPlayback(id: string, title: string, url: string): { playing: boolean; toggle: () => void } {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playing = useSyncExternalStore(
    subscribe,
    () => current !== null && current.id === id && current.playing,
    () => false,
  );

  // Unmount cleanup: stop playback and release the shared pointer if this
  // track was the one playing, so a departed track can't block the next
  // one (identical rationale to the pre-restyle TrackPlayer's own cleanup).
  useEffect(() => () => {
    audioRef.current?.pause();
    if (current?.audio === audioRef.current) { current = null; notify(); }
  }, []);

  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.onended = () => setCurrentPlaying(audio!, false);
      audio.onpause = () => setCurrentPlaying(audio!, false);
      audio.onerror = () => setCurrentPlaying(audio!, false);
      audioRef.current = audio;
    }
    if (current?.audio === audio) {
      if (current.playing) { audio.pause(); return; }
      current = { ...current, playing: true };
      notify();
      audio.play().catch(() => setCurrentPlaying(audio!, false));
      return;
    }
    if (current) current.audio.pause(); // one clip playing at a time across the page
    current = { id, title, audio, playing: true };
    notify();
    audio.play().catch(() => setCurrentPlaying(audio!, false));
  };

  return { playing, toggle };
}

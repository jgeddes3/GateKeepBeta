"use client";
import { useCallback, useState } from "react";

export type BrowserLocationStatus = "idle" | "asking" | "granted" | "denied" | "unsupported";

export interface UseBrowserLocationState {
  location: { lat: number; lng: number } | null;
  status: BrowserLocationStatus;
  request: () => void;
}

// Rounded to 3 decimals (about 110m at the equator): plenty for a "near
// me" radius search, and coarse enough that this never reads as a precise
// address. Request-scoped only: this hook holds the position in React
// state alone, never localStorage or a Firestore write, so it evaporates
// the moment the tab closes (spec's "device location is request-scoped
// and never persisted").
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function useBrowserLocation(): UseBrowserLocationState {
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [status, setStatus] = useState<BrowserLocationStatus>("idle");

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unsupported");
      return;
    }
    setStatus("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: round3(pos.coords.latitude), lng: round3(pos.coords.longitude) });
        setStatus("granted");
      },
      () => setStatus("denied"),
      { maximumAge: 300_000, timeout: 10_000 },
    );
  }, []);

  return { location, status, request };
}

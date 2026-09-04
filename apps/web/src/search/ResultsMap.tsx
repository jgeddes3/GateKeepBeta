"use client";
import { useEffect, useRef, useState } from "react";
import type { SearchPin } from "@gatekeep/shared";

const SINGLE_PIN_ZOOM = 14;

// NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY has to be a literal property access,
// not a dynamic lookup (process.env["NEXT_PUBLIC_..."] or a computed key):
// Next.js only inlines literal NEXT_PUBLIC_* references at build time, so
// this exact expression is repeated verbatim in the loader effect below
// rather than factored through a variable that reads process.env itself.
export function hasMapsKey(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY);
}

// The app's own dark-mode rule (layout.tsx's pre-hydration script,
// ThemeToggle.tsx, globals.css): an explicit data-theme="light"/"dark"
// attribute on <html> always wins; with neither, globals.css's own bare
// :root block is dark and only a system light preference overrides it.
// Read once at map-creation time only (see the mount effect's own
// comment for why this doesn't track later theme changes).
function isDarkTheme(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light") return false;
  if (attr === "dark") return true;
  return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

// Results map for the fan Shows face and the musician Gigs panel: renders
// nothing (and never touches the Maps API) unless hasMapsKey() is true,
// checked by the caller before this even mounts. Classic google.maps.Marker
// (deprecated by Google but still functional) rather than
// AdvancedMarkerElement: advanced markers require a Cloud-console Map ID,
// which the project owner does not have yet.
export function ResultsMap({ pins, onSelect }: { pins: SearchPin[]; onSelect: (pin: SearchPin) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  // Always-current onSelect without making it a marker-effect dependency:
  // a caller that passes a fresh onSelect closure every render (FanFace's
  // setSelectedPin arrow) must never force this effect to tear down and
  // rebuild every marker on every render.
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // Loads the Maps JS API once per mount. Client-only by construction (the
  // "use client" directive plus this effect body, which only ever runs in
  // the browser); the typeof window guard below is the belt-and-suspenders
  // case where this component's effect somehow ran during a non-DOM
  // render environment.
  //
  // Theme is read once here, at map creation: google.maps.Map's colorScheme
  // is a construction-time option, and re-creating the whole map instance
  // on every theme toggle (destroying and rebuilding all markers, losing
  // pan/zoom) is not the "cheap" update the task allows skipping. A visitor
  // who toggles the app theme while the map view is already open keeps the
  // theme the map opened with until they leave and reopen the map.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;
    void (async () => {
      const { setOptions, importLibrary } = await import("@googlemaps/js-api-loader");
      setOptions({ key: apiKey, v: "weekly" });
      await importLibrary("maps");
      await importLibrary("marker");
      if (cancelled || !containerRef.current) return;
      mapRef.current = new google.maps.Map(containerRef.current, {
        colorScheme: isDarkTheme() ? google.maps.ColorScheme.DARK : google.maps.ColorScheme.LIGHT,
        mapTypeControl: false,
        streetViewControl: false,
      });
      setMapReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Markers: cleared before every rebuild so a filter/query change (a new
  // pins array) never leaves an earlier search's markers on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = pins.map((pin) => {
      const marker = new google.maps.Marker({ position: pin.geo, map, title: pin.title });
      marker.addListener("click", () => onSelectRef.current(pin));
      return marker;
    });

    if (pins.length === 1) {
      map.setCenter(pins[0].geo);
      map.setZoom(SINGLE_PIN_ZOOM);
    } else if (pins.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      pins.forEach((pin) => bounds.extend(pin.geo));
      map.fitBounds(bounds);
    }

    return () => { markersRef.current.forEach((marker) => marker.setMap(null)); };
  }, [pins, mapReady]);

  if (!hasMapsKey()) return null;

  return <div ref={containerRef} style={{ height: "min(70vh, 560px)" }} className="w-full rounded-gk border border-gk-border" />;
}

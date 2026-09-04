"use client";
import { MusicianFace } from "../../src/search/MusicianFace";
import { useBrowserLocation } from "../../src/search/useBrowserLocation";

// Client half of /gigs: page.tsx (a Server Component) keeps the route's
// metadata export and its heading, and renders this component for the
// actual interactive search. useBrowserLocation is created here (not inside
// MusicianFace itself) so a future "Venues" near-me search on this same
// page shares one device-location prompt, the same reasoning SearchFaces.tsx
// documents for its own call site.
//
// This route stays reachable signed-out (page.tsx's own comment); a
// signed-out visitor who types a query sees useSearch's own
// SEARCH_SIGN_IN_MESSAGE error line rather than a redirect, so no auth gate
// belongs here.
export function GigsClient() {
  const location = useBrowserLocation();
  return <MusicianFace location={location} />;
}

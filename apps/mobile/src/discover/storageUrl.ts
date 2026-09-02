import { getFirebase, EMU_HOST, usesEmulators } from "../lib/firebase";

// SP7 Task 11: a "world-gettable" storage path (every `public/...` path this
// app ever reads: poster/avatar/cover/gallery photos, once a photo has
// cleared the moderation pipeline and storage.rules' `public/{kind}/...`
// match grants an unauthenticated `get`) resolves to a stable URL that needs
// no round trip through getDownloadURL, unlike usePosterUrl's existing
// pattern (src/events/eventDisplay.ts): getDownloadURL always makes a network
// call to mint a fresh token, even for an already-public object. A
// hand-built REST URL is enough here and lets callers (ArtistsList,
// venue/[handle]) render an <Image> straight from `path` with no fetch-then-
// setState step.
//
// Production form: the standard Firebase Storage REST download URL, no
// token query param needed for a public object.
// Emulator form: the emulator's own REST endpoint (same path shape, `http`,
// `EMU_HOST:9199` instead of the public host). This device's own DEV branch
// of getFirebase() is exactly what wires the SDK to that emulator in the
// first place (`usesEmulators` mirrors that same `__DEV__` gate, see
// lib/firebase.ts's own comment).
export function publicStorageUrl(path: string): string {
  const bucket = getFirebase().app.options.storageBucket ?? "";
  const encoded = encodeURIComponent(path);
  return usesEmulators
    ? `http://${EMU_HOST}:9199/v0/b/${bucket}/o/${encoded}?alt=media`
    : `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media`;
}

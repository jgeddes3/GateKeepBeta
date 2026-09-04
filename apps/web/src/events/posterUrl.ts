import { firebaseConfig } from "../lib/firebaseConfig";

// Public poster URLs are BUILT from the path, never resolved with
// getDownloadURL (sp6 audit finding 16, spec 6.5). storage.rules'
// public/{kind}/{profileId}/{fileName} match already grants an unauthenticated
// read, and this REST form is exactly what Storage serves for a rules-allowed
// object with no token. The per-poster round trip disappears from every card,
// the server page can put the URL straight into og:image, and SP7's feed cards
// adopt this one helper.
//
// Plain module by design (no "use client", no hooks): the RSC boundary rule
// (server files never import values from "use client" modules) is what let
// the old hook-shaped file be client-only, and what forces this one to stay
// plain. The bucket itself comes from firebaseConfig.ts (also a plain, no
// "use client" module, so this Server Component import stays valid), the
// same single source of truth src/lib/firebase.ts's own getFirebase() reads
// for the SDK's own bucket, so the two can never disagree; in dev the
// Storage emulator serves the identical /v0/b/{bucket}/o/{object} shape on
// 9199, on the page's own hostname (the LAN-phone case firebase.ts documents)
// or localhost during SSR.
const USE_EMULATOR = process.env.NODE_ENV !== "production" || process.env.FIREBASE_EMULATORS === "1";

export function posterPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const base = USE_EMULATOR ? `http://${host}:9199` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${firebaseConfig.storageBucket}/o/${encodeURIComponent(path)}?alt=media`;
}

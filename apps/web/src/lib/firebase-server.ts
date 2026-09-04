import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";
import { firebaseConfig } from "./firebaseConfig";

// Server-side (RSC) Firebase: anonymous, public-rules reads only, the public
// portfolio page reads only what firestore.rules exposes to the world, so no
// admin credentials are needed on the web server (works the same on Vercel).

let cached: { app: FirebaseApp; db: Firestore; storage: FirebaseStorage } | null = null;

export function getServerFirebase() {
  if (cached) return cached;
  const app = getApps().some((a) => a.name === "server")
    ? getApp("server") : initializeApp(firebaseConfig, "server");
  const db = getFirestore(app);
  const storage = getStorage(app);
  // FIREBASE_EMULATORS=1 lets `next start` (a production build) still target
  // the emulators locally, useful for testing the production bundle without
  // pointing it at real Firebase.
  if (process.env.NODE_ENV !== "production" || process.env.FIREBASE_EMULATORS === "1") {
    connectFirestoreEmulator(db, "localhost", 8080);
    connectStorageEmulator(storage, "localhost", 9199);
  }
  cached = { app, db, storage };
  return cached;
}

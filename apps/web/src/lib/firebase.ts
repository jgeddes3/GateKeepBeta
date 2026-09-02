import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, type Functions } from "firebase/functions";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";

// Public web-app config from Firebase console → Project settings → Your apps.
// These values are NOT secrets; security comes from rules + App Check.
const firebaseConfig = {
  apiKey: "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU",
  authDomain: "gatekeep-dev-jg.firebaseapp.com",
  projectId: "gatekeep-dev-jg",
  storageBucket: "gatekeep-dev-jg.firebasestorage.app",
  appId: "1:894446689930:web:20531390a23a3804b05773",
};

// Follow the hostname the page was loaded from, so opening the dev server
// from a phone on the same Wi-Fi (http://<LAN-IP>:3000) reaches the
// emulators on the dev machine too, firebase.json binds them to 0.0.0.0
// for the same reason. window is absent during SSR/prerender; localhost is
// the correct fallback there (server-side code runs on the dev machine).
const EMU_HOST = typeof window !== "undefined" ? window.location.hostname : "localhost";

let cached: { app: FirebaseApp; auth: Auth; db: Firestore; functions: Functions; storage: FirebaseStorage } | null = null;

export function getFirebase() {
  if (cached) return cached;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  const storage = getStorage(app);
  if (process.env.NODE_ENV !== "production") {
    connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMU_HOST, 8080);
    connectFunctionsEmulator(functions, EMU_HOST, 5001);
    connectStorageEmulator(storage, EMU_HOST, 9199);
  }
  // App Check (spec §8): reCAPTCHA v3, browser-only, production-only, and only once a
  // site key is configured (Firebase console → App Check → register web app first).
  const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? "";
  if (typeof window !== "undefined" && process.env.NODE_ENV === "production" && recaptchaSiteKey !== "") {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  cached = { app, auth, db, functions, storage };
  return cached;
}

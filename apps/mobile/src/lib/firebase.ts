import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
// initializeAuth + AsyncStorage persistence: without this, RN sessions do NOT survive app restarts.
// NOTE: `firebase/auth`'s package.json "exports" map does not declare a "react-native" condition
// for this firebase version, so importing getReactNativePersistence from "firebase/auth" resolves
// to the browser build and the symbol is missing at both compile- and run-time. `@firebase/auth`
// (the underlying package) DOES declare a "react-native" condition, so we import from there instead.
// See: https://github.com/firebase/firebase-js-sdk/issues/7020
import {
  initializeAuth, getReactNativePersistence, connectAuthEmulator, type Auth,
} from "@firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, type Functions } from "firebase/functions";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";
import { Platform } from "react-native";
import Constants from "expo-constants";

// Public web-app config from Firebase console, Project settings, Your apps.
// These values are NOT secrets; security comes from rules + App Check.
// SP10 Task 24 (cross-cutting #7): EXPO_PUBLIC_FIREBASE_* overrides each
// value at bundle time; the dev project is the default (.env.example).
// Literal process.env.EXPO_PUBLIC_* accesses only: Metro inlines those.
const pick = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.length > 0 ? value : fallback;

const firebaseConfig = {
  apiKey: pick(process.env.EXPO_PUBLIC_FIREBASE_API_KEY, "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU"),
  authDomain: pick(process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN, "gatekeep-dev-jg.firebaseapp.com"),
  projectId: pick(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID, "gatekeep-dev-jg"),
  storageBucket: pick(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET, "gatekeep-dev-jg.firebasestorage.app"),
  messagingSenderId: pick(process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, "894446689930"),
  appId: pick(process.env.EXPO_PUBLIC_FIREBASE_APP_ID, "1:894446689930:web:20531390a23a3804b05773"),
};

// Exported for src/events/eventDisplay.ts's posterPublicUrl: a poster URL is
// built from the bucket name, never resolved through the SDK.
export const STORAGE_BUCKET = firebaseConfig.storageBucket;

// Where do the Firebase emulators live, from this device's point of view?
// A PHYSICAL phone must use the dev machine's LAN IP, which is exactly the
// host Metro served the bundle from (Constants.expoConfig.hostUri, e.g.
// "192.168.4.27:8081") whenever the app runs under `expo start`. When that's
// absent, fall back to the old per-platform loopbacks: the Android emulator
// reaches the host at 10.0.2.2, everything else at localhost. Dev-only code
// path either way (__DEV__ guard below).
const metroHost = Constants.expoConfig?.hostUri?.split(":")[0];
export const EMU_HOST = metroHost ?? (Platform.OS === "android" ? "10.0.2.2" : "localhost");

// SP7 Task 11: `__DEV__` is exactly the condition getFirebase() below gates
// its own connectStorageEmulator (and every other connect*Emulator) call on,
// so this constant, computed once at module scope from that same global,
// always agrees with whether THIS process actually wired up the emulators.
// Exported so storageUrl.ts's publicStorageUrl can pick the emulator vs.
// production URL form without reaching into getFirebase()'s private cache.
export const usesEmulators = __DEV__;

let cached: { app: FirebaseApp; auth: Auth; db: Firestore; functions: Functions; storage: FirebaseStorage } | null = null;

export function getFirebase() {
  if (cached) return cached;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  const storage = getStorage(app);
  if (__DEV__) {
    connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMU_HOST, 8080);
    connectFunctionsEmulator(functions, EMU_HOST, 5001);
    connectStorageEmulator(storage, EMU_HOST, 9199);
  }
  cached = { app, auth, db, functions, storage };
  return cached;
}

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

// Public web-app config from Firebase console → Project settings → Your apps.
// These values are NOT secrets; security comes from rules + App Check.
const firebaseConfig = {
  apiKey: "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU",
  authDomain: "gatekeep-dev-jg.firebaseapp.com",
  projectId: "gatekeep-dev-jg",
  storageBucket: "gatekeep-dev-jg.firebasestorage.app",
  appId: "1:894446689930:web:20531390a23a3804b05773",
};

// Android emulator reaches the host machine at 10.0.2.2, not localhost.
import { Platform } from "react-native";
const EMU_HOST = Platform.OS === "android" ? "10.0.2.2" : "localhost";

let cached: { app: FirebaseApp; auth: Auth; db: Firestore; functions: Functions } | null = null;

export function getFirebase() {
  if (cached) return cached;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  if (__DEV__) {
    connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMU_HOST, 8080);
    connectFunctionsEmulator(functions, EMU_HOST, 5001);
  }
  cached = { app, auth, db, functions };
  return cached;
}

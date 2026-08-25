import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, type User,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev-jg", apiKey: "fake-key", appId: "fake" });
export const auth = getAuth(app);
export const db = getFirestore(app);
const fns = getFunctions(app, "us-central1");
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "localhost", 8080);
connectFunctionsEmulator(fns, "localhost", 5001);

export async function signUpTestUser(email: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, "test-password-1");
  return { uid: cred.user.uid, idToken: await cred.user.getIdToken(), user: cred.user };
}

export async function callFn<T, R>(name: string, data: T, asUser?: User): Promise<R> {
  if (asUser) await auth.updateCurrentUser(asUser);
  const res = await httpsCallable<T, R>(fns, name)(data);
  return res.data;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

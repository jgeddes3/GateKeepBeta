import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, type User,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import * as adminApp from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";

// Needed before the admin app initializes below, so admin SDK auth calls
// (e.g. updateUser) target the emulator rather than production.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "localhost:9099";

const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev-jg", apiKey: "fake-key", appId: "fake" });
export const auth = getAuth(app);
export const db = getFirestore(app);
const fns = getFunctions(app, "us-central1");
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "localhost", 8080);
connectFunctionsEmulator(fns, "localhost", 5001);

// Guarded init consistent with the pattern in the *.test.ts files.
const adminAppInstance = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });

// Signs up a user via the client SDK (email/password, which the emulator
// starts as email_verified: false), then marks the account verified via the
// Admin SDK and force-refreshes the client ID token so the email_verified
// claim is present for callers that gate on it (createProfileDraft,
// inviteMember). Centralized here so every existing test — all of which go
// through this helper — keeps working without per-test changes.
export async function signUpTestUser(email: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, "test-password-1");
  await getAdminAuth(adminAppInstance).updateUser(cred.user.uid, { emailVerified: true });
  const idToken = await cred.user.getIdToken(true);
  return { uid: cred.user.uid, idToken, user: cred.user };
}

// Variant that leaves the account unverified, for exercising the
// email-verification gate itself.
export async function signUpUnverifiedTestUser(email: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, "test-password-1");
  return { uid: cred.user.uid, idToken: await cred.user.getIdToken(), user: cred.user };
}

export async function callFn<T, R>(name: string, data: T, asUser?: User): Promise<R> {
  // Explicitly sign out when no user is given so "unauthenticated" calls are
  // truly unauthenticated, regardless of which user a prior call in this
  // file left signed in on the shared `auth` instance.
  await auth.updateCurrentUser(asUser ?? null);
  const res = await httpsCallable<T, R>(fns, name)(data);
  return res.data;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// inviteMember now returns a uniform { ok: true } (anti-enumeration — see
// members.ts), so tests that need the created invite's doc id fetch it via
// the admin SDK instead. Filters on invitedUid via a single-field query
// (no composite index needed for tests), then narrows to the target
// profile's pending invite in application code — this correctly picks out
// a fresh invite even when an earlier invite to the same invitedUid already
// exists in a non-pending state (see the "already a member" test).
export async function fetchPendingInviteId(
  adb: Firestore, profileId: string, invitedUid: string,
): Promise<string> {
  const snap = await adb.collection("invites").where("invitedUid", "==", invitedUid).get();
  const pending = snap.docs.filter((d) => d.data().profileId === profileId && d.data().status === "pending");
  if (pending.length !== 1) {
    throw new Error(
      `expected exactly one pending invite for invitedUid=${invitedUid} profileId=${profileId}, found ${pending.length}`);
  }
  return pending[0].id;
}

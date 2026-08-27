import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, type User,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { getStorage as getClientStorage, connectStorageEmulator, ref as storageRef, uploadBytes } from "firebase/storage";
import * as adminApp from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore, type Firestore } from "firebase-admin/firestore";

// Needed before the admin app initializes below, so admin SDK auth calls
// (e.g. updateUser) target the emulator rather than production.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "localhost:9099";
// Admin SDK must target the storage emulator (mirrors the auth line above).
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";

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

// Signs up a fresh test user and grants the `admin` custom claim directly via
// the Admin SDK — bypasses grantAdmin's Google-linked-account-only rule,
// which is fine for tests (every review-flow test needs an admin caller
// without wiring up a fake Google OAuth provider). Centralized here so
// review.test.ts and tracks.test.ts share one implementation.
export async function makeAdminUser(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await getAdminAuth(adminAppInstance).setCustomUserClaims(uid, { admin: true });
  await user.getIdToken(true); // refresh claims
  return { user, uid };
}

// Makes both sides of a booking money-ready for the Task 5 gates: the
// curator gets a saved card (createSetupIntent's fake contract caches it on
// profiles/{curator}/private/stripe immediately — no separate Elements flow
// needed against the fake), and the musician gets an Express account whose
// transfer flags are force-enabled directly (createOnboardingLink alone only
// creates the account; onboarding completion is normally driven by the
// account.updated webhook, which nothing in these fixtures triggers). Both
// the fake's own object doc AND the cached private/stripe doc are flipped so
// every gate helper — which reads the cached doc, not the fake's live state —
// sees a payout-ready musician. As-built fake object path (see stripeClient.ts):
// `stripeFake/state/objects/{id}`, NOT the stale `stripeFake/objects/{id}`
// some earlier plan drafts show.
export async function makeMoneyReady(
  curator: { owner: { user: User }; profileId: string },
  musician: { owner: { user: User }; profileId: string },
): Promise<void> {
  await callFn("createSetupIntent", { profileId: curator.profileId }, curator.owner.user);
  await callFn("createOnboardingLink", { profileId: musician.profileId }, musician.owner.user);
  const adb = getAdminFirestore(adminAppInstance);
  const sp = (await adb.doc(`profiles/${musician.profileId}/private/stripe`).get()).data()!;
  // Review round 1: fail with a named error instead of silently writing a
  // junk `stripeFake/state/objects/undefined` doc if createOnboardingLink
  // somehow didn't persist an accountId.
  if (!sp?.accountId) {
    throw new Error(`makeMoneyReady: musician ${musician.profileId} has no accountId after createOnboardingLink.`);
  }
  await adb.doc(`stripeFake/state/objects/${sp.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  await adb.doc(`profiles/${musician.profileId}/private/stripe`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
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

export const storage = getClientStorage(app, "gs://gatekeep-dev-jg.firebasestorage.app");
connectStorageEmulator(storage, "localhost", 9199);

export async function uploadTestAudio(path: string, bytes: Uint8Array, contentType: string, asUser: User) {
  await auth.updateCurrentUser(asUser);
  await uploadBytes(storageRef(storage, path), bytes, { contentType });
}

// Generates a valid mono 16-bit PCM WAV of `seconds` at 8kHz — a real audio
// file ffmpeg can transcode, without committing a binary fixture.
export function makeWav(seconds: number): Uint8Array {
  const sampleRate = 8000;
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 12000), true);
  }
  return new Uint8Array(buf);
}

// Minimal admin-SDK shortcut for satisfying submitProfileForReview's curator
// content gate (Task 4) — analogous to the "avatar via admin SDK shortcut"
// pattern profiles.test.ts already uses for the musician gate (the photo
// pipeline's own behavior has its own tests). Tests whose subject is
// something else entirely (delete/submit mechanics, notification fan-out,
// anti-spam) call this to get a curator profile past the gate without
// re-deriving valid content inline. Always shaped as a "venue" (non-null
// address) so it also satisfies the stricter venue location requirement.
export async function seedCuratorGateContent(adb: Firestore, profileId: string): Promise<void> {
  await adb.doc(`profiles/${profileId}`).update({
    "curator.about": "A great room for live music.",
    "curator.photoPaths": ["public/photos/seed/cover-seed.jpg"],
    "curator.location": {
      address: "123 Main St, Austin, TX", city: "Austin", neighborhood: "Downtown",
      geo: { lat: 30.27, lng: -97.74 },
    },
    "curator.lookingFor": { genres: ["rock"], actSizes: ["band"], notes: null },
  });
}

// Polls a track doc until its status is one of `statuses` (transcode is async).
export async function waitForTrackStatus(
  adb: Firestore, docPath: string, statuses: string[], timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await adb.doc(docPath).get();
    const s = snap.data()?.status;
    if (s && statuses.includes(s)) return snap.data()!;
    if (Date.now() > deadline) throw new Error(`track ${docPath} stuck in "${s}" after ${timeoutMs}ms`);
    await wait(500);
  }
}

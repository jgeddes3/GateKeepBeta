// Seeds sub-project 7 (fan discovery) fixtures on top of the seeded test
// accounts: an approved demo track for @testmusician (the deck's audio
// preview needs a real track doc, and seed-test-accounts.ts deliberately
// gives @testmusician none), a second published event whose lineup is a
// real BOOKING act (not the external-only lineup seed-test-event.ts creates,
// which the musician-page "on the bill" query and the deck's per-artist
// preview both need a genuine confirmed booking behind), and test-fan
// following `genre:rock`.
//
// Usage (emulator only; run seed-test-accounts.ts FIRST, then this):
//   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
//     FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199 \
//     pnpm tsx scripts/seed-test-discovery.ts
//
// Idempotent-ish, same posture as seed-test-event.ts: the track doc (fixed
// id "seed-demo") overwrites cleanly on re-run, but the gig/booking/event
// chain has no natural idempotency key (createGig, like createEvent, has
// none), so re-running creates a FRESH gig/booking/event set each time. That
// is fine for a disposable local fixture recreated after an emulator
// restart wipes all data; it just means a long-lived emulator session
// re-seeded several times accumulates extra draft/filled gigs and events
// under the two test profiles, harmless for UI/device smoke.
import { initializeApp as initAdminApp, getApps as getAdminApps } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const PROJECT_ID = "gatekeep-dev-jg";
const STORAGE_BUCKET = "gatekeep-dev-jg.firebasestorage.app";
const PASSWORD = "GateKeep-Test1";
const MUSICIAN_EMAIL = "test-musician@gatekeep.dev";
const CURATOR_EMAIL = "test-curator@gatekeep.dev";
const FAN_EMAIL = "test-fan@gatekeep.dev";

const inEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST;
if (!inEmulator) {
  console.error(
    "Refusing: no emulator hosts set. This script authenticates as the seeded test accounts, whose\n" +
    "passwords are public in this repo: it must never run against a real project. Set\n" +
    "FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST, and FIREBASE_STORAGE_EMULATOR_HOST first\n" +
    "(see seed-test-accounts.ts's own usage comment).");
  process.exit(1);
}
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";

// Admin SDK: profile/uid lookups no onCall callable exists for, the track
// doc + audio upload (a real callable would require a real client-side
// transcode pipeline, out of scope for a fixture), and FakeStripe's
// Admin-SDK-only account flags (mirrors functions/test/helpers.ts's
// makeMoneyReady exactly, lines 73-91).
const adminApp = getAdminApps()[0] ?? initAdminApp({ projectId: PROJECT_ID });
const adb = getAdminFirestore(adminApp);
const aAuth = getAdminAuth(adminApp);
const bucket = getAdminStorage(adminApp).bucket(STORAGE_BUCKET);

const musicianHandle = await adb.doc("handles/testmusician").get();
const curatorHandle = await adb.doc("handles/testvenue").get();
if (!musicianHandle.exists || !curatorHandle.exists) {
  console.error("No @testmusician/@testvenue handle found. Run seed-test-accounts.ts first.");
  process.exit(1);
}
const musicianProfileId = musicianHandle.data()!.profileId as string;
const curatorProfileId = curatorHandle.data()!.profileId as string;
const musicianUser = await aAuth.getUserByEmail(MUSICIAN_EMAIL);

// --- Step 1: an approved demo track for @testmusician -----------------
// Generates a valid mono 16-bit PCM WAV of `seconds` at 8kHz, same
// implementation as functions/test/helpers.ts's makeWav (copied rather than
// imported: scripts/ stays independent of the functions/test/ directory).
function makeWav(seconds: number): Uint8Array {
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

const DEMO_DURATION_SEC = 8;
const trackStoragePath = `public/tracks/${musicianProfileId}/seed-demo.m4a`;
await bucket.file(trackStoragePath).save(Buffer.from(makeWav(DEMO_DURATION_SEC)), { contentType: "audio/mp4" });
const now = Date.now();
await adb.doc(`profiles/${musicianProfileId}/tracks/seed-demo`).set({
  title: "Seed Demo", status: "approved", uploaderUid: musicianUser.uid,
  startSec: 0, durationSec: DEMO_DURATION_SEC, storagePath: trackStoragePath,
  rejectionReason: null, failureReason: null, order: 0,
  createdAt: now, updatedAt: now,
});
console.warn(
  "WARNING: the seeded track's audio bytes are a generated sine-wave WAV placeholder saved with a\n" +
  "\".m4a\" storagePath/contentType, not a real transcoded m4a. It is enough for a decode/playback\n" +
  "smoke (the emulator never re-validates the payload against its declared type), but it is NOT\n" +
  "representative audio: a real upload through the actual track pipeline is needed to judge how the\n" +
  "deck sounds.");

// --- Step 2: client SDK, mirroring seed-test-event.ts's own wiring -----
const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID, apiKey: "fake-key", appId: "fake" });
const auth = getAuth(app);
const fns = getFunctions(app, "us-central1");
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "localhost", 5001);

let signedInAs: string | null = null;
async function callAs<T, R>(name: string, data: T, email: string): Promise<R> {
  if (signedInAs !== email) {
    await signInWithEmailAndPassword(auth, email, PASSWORD);
    signedInAs = email;
  }
  const res = await httpsCallable<T, R>(fns, name)(data);
  return res.data;
}

// --- Step 3: make both sides money-ready (Admin-SDK FakeStripe shortcuts,
// exactly functions/test/helpers.ts's makeMoneyReady, lines 73-91) --------
await callAs("createSetupIntent", { profileId: curatorProfileId }, CURATOR_EMAIL);
await callAs("createOnboardingLink", { profileId: musicianProfileId }, MUSICIAN_EMAIL);
const stripePriv = (await adb.doc(`profiles/${musicianProfileId}/private/stripe`).get()).data();
if (!stripePriv?.accountId) {
  console.error("seed-test-discovery: @testmusician has no Stripe accountId after createOnboardingLink.");
  process.exit(1);
}
await adb.doc(`stripeFake/state/objects/${stripePriv.accountId}`).set(
  { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
await adb.doc(`profiles/${musicianProfileId}/private/stripe`).set(
  { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });

// --- Step 4: a filled gig between @testvenue and @testmusician ---------
const gigStartsAt = Date.now() + 10 * 24 * 3_600_000; // ten days out
const { gigId } = await callAs<Record<string, unknown>, { gigId: string }>(
  "createGig",
  {
    profileId: curatorProfileId,
    title: "Seeded Discovery Night", description: "A seeded gig for the fan-discovery smoke: filled and promoted to an event.",
    wants: { genres: ["indie"], actSizes: ["solo"] }, durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: gigStartsAt,
  },
  CURATOR_EMAIL);
await callAs("publishGig", { gigId }, CURATOR_EMAIL);
const { bookingId } = await callAs<Record<string, unknown>, { bookingId: string }>(
  "applyToGig",
  { gigId, musicianProfileId, offer: { amountCents: 15_000, note: "Would love to play this one." } },
  MUSICIAN_EMAIL);
await callAs("acceptBooking", { bookingId }, CURATOR_EMAIL);

// --- Step 5: promote the filled gig to a published event with a real
// booking-kind lineup act (lineupMusicianProfileIds, the deck's per-artist
// preview, and the musician-page "on the bill" query all need this) -----
const eventStartsAt = Date.now() + 10 * 24 * 3_600_000;
const eventEndsAt = eventStartsAt + 3 * 3_600_000;
const { eventId } = await callAs<Record<string, unknown>, { eventId: string }>(
  "createEvent",
  {
    curatorProfileId, source: { kind: "gig", gigId },
    title: "Seeded Discovery Showcase", description: "A seeded, promoted-from-gig event for the fan-discovery smoke.",
    startsAt: eventStartsAt, endsAt: eventEndsAt,
    lineup: [{ kind: "booking", bookingId, musicianProfileId, name: "Test Musician" }],
  },
  CURATOR_EMAIL);
await callAs("setEventTiers", {
  curatorProfileId, eventId,
  tiers: [{ name: "General Admission", priceCents: 0, capacity: 100, saleStartsAt: null, saleEndsAt: null }],
}, CURATOR_EMAIL);
await callAs("publishEvent", { curatorProfileId, eventId }, CURATOR_EMAIL);

// --- Step 6: test-fan follows genre:rock --------------------------------
await callAs("followTarget", { targetId: "genre:rock", targetType: "genre" }, FAN_EMAIL);

// Leave the shared client auth instance signed out, same courtesy
// seed-test-event.ts's lack of a trailing user leaves implicitly (nothing
// downstream of this script depends on who is signed in when it exits).
await auth.updateCurrentUser(null);

const bucketHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "localhost:9199";
const publicUrl =
  `http://${bucketHost}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(trackStoragePath)}?alt=media`;

console.log(`\nevent:              ${eventId}`);
console.log(`gig:                 ${gigId}`);
console.log(`booking:             ${bookingId}`);
console.log(`deck preview path:   ${trackStoragePath}`);
console.log(`deck preview URL:    ${publicUrl}`);
console.log(`fan follow:          genre:rock (test-fan@gatekeep.dev)`);

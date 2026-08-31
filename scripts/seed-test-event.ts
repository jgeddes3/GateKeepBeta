// Seeds one published sub-project 6 event (a free tier + a paid tier),
// owned by the seeded test-curator@gatekeep.dev account's @testvenue
// profile (see seed-test-accounts.ts). Task 9 (the public event page and
// buy flow) needs a real published event to load /e/[eventId] against, and
// no curator-side UI to create one exists yet (that's Task 10): this
// script is the standalone alternative the task's own brief calls for.
// Generically useful beyond this one task: any later manual or scripted
// check of the public event page, the buy flow, or the two profile pages'
// "Upcoming events" sections needs a real published event to point at.
//
// The lineup is one EXTERNAL act only (no booking act): a real "booking"
// lineup entry requires an actual confirmed booking between the curator and
// a musician profile (events.ts's verifyLineupBookingActs checks this), which
// this script deliberately doesn't set up (out of scope for seeding a
// ticketing surface). This also means the musician page's own "Upcoming
// events" section (the lineupMusicianProfileIds array-contains query) has
// nothing to find for @testmusician against this particular seeded event:
// exercising that query path (it compiles and returns empty, not an error)
// is exactly what Task 9's own live-verification recipe asks for.
//
// Usage (emulator only, start `pnpm emu`, then seed-test-accounts.ts,
// FIRST):
//   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
//     pnpm tsx scripts/seed-test-event.ts
//
// Idempotent-ish: re-running creates a SECOND event each time (createEvent
// has no natural idempotency key to collide on, unlike seed-test-accounts.ts's
// handle-keyed profiles): harmless for its purpose (a disposable local
// fixture), just prints a fresh eventId/URL each run.
import { initializeApp as initAdminApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const PROJECT_ID = "gatekeep-dev-jg";
const CURATOR_EMAIL = "test-curator@gatekeep.dev";
const PASSWORD = "GateKeep-Test1";
// Overridable for a non-default `pnpm --filter @gatekeep/web dev` port
// (the task's own brief: "if port occupied use PORT=3002").
const WEB_PORT = process.env.WEB_PORT ?? "3000";

const inEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST;
if (!inEmulator) {
  console.error(
    "Refusing: no emulator hosts set. This script authenticates as the seeded test-curator account, whose\n" +
    "password is public in this repo: it must never run against a real project. Set FIREBASE_AUTH_EMULATOR_HOST\n" +
    "and FIRESTORE_EMULATOR_HOST first (see seed-test-accounts.ts's own usage comment).");
  process.exit(1);
}

// Admin SDK: only to resolve @testvenue's profileId (handles/{handle} ->
// profileId), the one lookup no onCall callable exists for. Every actual
// event/tier/publish write below goes through the real callables via the
// client SDK, exactly the path the web app itself uses.
const adminApp = getAdminApps()[0] ?? initAdminApp({ projectId: PROJECT_ID });
const adb = getAdminFirestore(adminApp);
const handleSnap = await adb.doc("handles/testvenue").get();
if (!handleSnap.exists) {
  console.error("No @testvenue handle found. Run seed-test-accounts.ts first.");
  process.exit(1);
}
const curatorProfileId = handleSnap.data()!.profileId as string;

// Client SDK, mirroring functions/test/helpers.ts's own emulator wiring
// (that file signs UP a fresh user per test; this signs IN as the
// already-seeded curator instead, the one difference from its pattern).
const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID, apiKey: "fake-key", appId: "fake" });
const auth = getAuth(app);
const fns = getFunctions(app, "us-central1");
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "localhost", 5001);

await signInWithEmailAndPassword(auth, CURATOR_EMAIL, PASSWORD);

const startsAt = Date.now() + 14 * 24 * 3_600_000; // two weeks out
const endsAt = startsAt + 3 * 3_600_000; // a 3-hour show

const { data: created } = await httpsCallable<
  { curatorProfileId: string; source: { kind: "standalone" }; title: string; description: string;
    startsAt: number; endsAt: number; lineup: Array<{ kind: "external"; name: string }> },
  { eventId: string }
>(fns, "createEvent")({
  curatorProfileId,
  // No `location` override: falls back to @testvenue's own seeded profile
  // address ("123 Test St", Testville), exactly like createGig's identical
  // fallback for a venue profile that omits one.
  source: { kind: "standalone" },
  title: "Test Venue Listening Room Night",
  description: "A seeded test event for /e/[eventId] verification: a free RSVP tier and a paid tier.",
  startsAt, endsAt,
  lineup: [{ kind: "external", name: "Seeded Test Act" }],
});
const eventId = created.eventId;

await httpsCallable(fns, "setEventTiers")({
  curatorProfileId, eventId,
  tiers: [
    { name: "General Admission", priceCents: 0, capacity: 100, saleStartsAt: null, saleEndsAt: null },
    { name: "VIP", priceCents: 2500, capacity: 20, saleStartsAt: null, saleEndsAt: null },
  ],
});

await httpsCallable(fns, "publishEvent")({ curatorProfileId, eventId });

console.log(`event: ${eventId}`);
console.log(`url:   http://localhost:${WEB_PORT}/e/${eventId}`);

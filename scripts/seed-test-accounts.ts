// Seeds three known test accounts for UI/device testing, all with password
// "GateKeep-Test1":
//   test-fan@gatekeep.dev      — plain user, no profile
//   test-musician@gatekeep.dev — admin of an APPROVED musician profile (@testmusician)
//   test-curator@gatekeep.dev  — admin of an APPROVED curator/venue profile (@testvenue)
//
// Usage (emulator — start `pnpm emu` first, or wrap in emulators:exec):
//   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 \
//     pnpm tsx scripts/seed-test-accounts.ts
// Usage (real dev project gatekeep-dev-jg):
//   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> pnpm tsx scripts/seed-test-accounts.ts
//
// Idempotent: re-running resets each account's password/emailVerified and
// re-asserts the profile docs (set with merge on the profile, so admin review
// state like lastRejectedAt is never resurrected/clobbered into duplicates).
//
// Fidelity notes (why each write looks the way it does):
// - users/{uid} mirrors onUserCreated's exact shape (functions/src/authTriggers.ts)
//   because auth triggers only fire where functions run — the emulator with the
//   functions emulator up, or a deployed project. Writing it here makes the seed
//   correct in every environment; the set() is skipped if the doc already exists
//   so a trigger-created doc (or one the user has since edited) is left alone.
// - Profile + handles/{handle} + members/{uid} mirror createProfileDraft's
//   transaction (functions/src/profiles.ts) field-for-field, then status is set
//   to "approved" directly — the seed bypasses submit/review on purpose.
// - emailVerified MUST be true: every callable runs requireVerifiedEmail.
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const PASSWORD = "GateKeep-Test1";
const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev-jg" });
const auth = getAuth(app);
const db = getFirestore(app);

const inEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST;
if (!inEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    "Refusing: no emulator hosts set and no GOOGLE_APPLICATION_CREDENTIALS.\n" +
    "Set FIREBASE_AUTH_EMULATOR_HOST + FIRESTORE_EMULATOR_HOST for the emulator,\n" +
    "or GOOGLE_APPLICATION_CREDENTIALS for the real dev project.");
  process.exit(1);
}

async function ensureUser(email: string, displayName: string): Promise<UserRecord> {
  let user: UserRecord;
  try {
    user = await auth.getUserByEmail(email);
    // Re-assert the knowns so a re-run always leaves a signable account.
    user = await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true, displayName });
  } catch {
    user = await auth.createUser({ email, password: PASSWORD, emailVerified: true, displayName });
  }
  // Mirror onUserCreated's doc — but never overwrite one that already exists
  // (the trigger may have written it, or the user may have edited homeCity).
  const userRef = db.doc(`users/${user.uid}`);
  if (!(await userRef.get()).exists) {
    await userRef.set({
      displayName,
      displayNameLower: displayName.toLowerCase(),
      email,
      photoUrl: null,
      homeCity: null,
      createdAt: Date.now(),
    });
  }
  return user;
}

// Mirrors createProfileDraft's transaction, then force-approves. Reuses the
// existing profile when the handle is already registered.
async function ensureApprovedProfile(uid: string, opts: {
  type: "musician" | "curator";
  subtype: "solo" | "band" | "venue" | "planner" | "individual_host";
  name: string;
  handle: string;
  details: Record<string, unknown>; // { portfolio } or { curator }
}): Promise<string> {
  const handleRef = db.doc(`handles/${opts.handle}`);
  const handleSnap = await handleRef.get();
  const now = Date.now();

  if (handleSnap.exists) {
    const profileId = handleSnap.data()!.profileId as string;
    const profileRef = db.doc(`profiles/${profileId}`);
    await profileRef.set({ status: "approved", rejectionReason: null, updatedAt: now }, { merge: true });
    await profileRef.collection("members").doc(uid)
      .set({ uid, role: "admin", label: "owner", joinedAt: now }, { merge: true });
    return profileId;
  }

  const profileRef = db.collection("profiles").doc();
  await db.runTransaction(async (tx) => {
    tx.set(profileRef, {
      type: opts.type, subtype: opts.subtype,
      name: opts.name, handle: opts.handle,
      status: "approved", rejectionReason: null,
      createdAt: now, updatedAt: now,
      publicBooking: null,
      ...opts.details,
    });
    tx.set(handleRef, { profileId: profileRef.id });
    tx.set(profileRef.collection("members").doc(uid), { uid, role: "admin", label: "owner", joinedAt: now });
  });
  return profileRef.id;
}

const fan = await ensureUser("test-fan@gatekeep.dev", "Test Fan");
console.log(`fan:      test-fan@gatekeep.dev (${fan.uid}) — no profile`);

const musician = await ensureUser("test-musician@gatekeep.dev", "Test Musician");
const musicianProfileId = await ensureApprovedProfile(musician.uid, {
  type: "musician", subtype: "solo", name: "Test Musician", handle: "testmusician",
  // createProfileDraft's empty portfolio shape, with enough content that the
  // portfolio/browse screens render something. Genres must come from GENRES
  // (packages/shared/src/types.ts).
  details: {
    portfolio: {
      bio: "Seeded test act: solo singer-songwriter for UI testing.",
      genres: ["indie", "singer-songwriter"],
      externalLinks: [],
      avatarPhotoPath: null,
      coverPhotoPath: null,
    },
  },
});
console.log(`musician: test-musician@gatekeep.dev (${musician.uid}) — approved profile ${musicianProfileId} (@testmusician)`);

const curator = await ensureUser("test-curator@gatekeep.dev", "Test Curator");
const curatorProfileId = await ensureApprovedProfile(curator.uid, {
  type: "curator", subtype: "venue", name: "Test Venue", handle: "testvenue",
  // createProfileDraft's CuratorDetails shape, filled to the same bar the
  // submit gate checks (about, location, lookingFor) so approved-only UI
  // renders realistically. photoPaths stays empty (no storage objects seeded).
  details: {
    curator: {
      about: "Seeded test venue: a small listening room for UI testing.",
      lookingFor: { genres: ["indie", "folk", "jazz"], actSizes: ["solo", "duo"], notes: null },
      amenities: { capacity: 80, hasPA: true, hasBackline: false, indoorOutdoor: "indoor", notes: null },
      advertisingInterest: false,
      location: { address: "123 Test St", city: "Testville", neighborhood: null, geo: null },
      photoPaths: [],
    },
  },
});
console.log(`curator:  test-curator@gatekeep.dev (${curator.uid}) — approved profile ${curatorProfileId} (@testvenue)`);
console.log(`\nAll passwords: ${PASSWORD}`);

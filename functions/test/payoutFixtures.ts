import { signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";

// SP5c Task 3 controller ruling: shared across the payout-splits test files
// (Task 3's payoutShares.test.ts, and later tasks per the same ruling), not
// exported from a test file. Adds `prefix`-`Date.now()`@test.com as a
// profile member directly via the admin SDK (skipping the invite/accept
// flow, which is not what these tests are exercising).
export async function addMember(profileId: string, prefix: string, role: "admin" | "member" = "member") {
  const u = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await adb.doc(`profiles/${profileId}/members/${u.uid}`).set({ uid: u.uid, role, label: "bass", joinedAt: Date.now() });
  return u;
}

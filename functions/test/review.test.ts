import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// This file's tests are the first to invoke "reviewProfile"/"grantAdmin" in
// the suite, so — like the cold-start note in authTriggers.test.ts — the
// Functions emulator's first invocation of each of those callables can take
// several seconds. Verified via `firebase emulators:exec ... vitest run
// test/review.test.ts --testTimeout=30000`: the emulator work itself
// completes (function execution logged at 20-100ms), the wall-clock cost is
// emulator cold start, not a hang — so raise the default 5s test timeout
// rather than mask a real failure.
vi.setConfig({ testTimeout: 15_000 });

async function makeAdminUser() {
  const t = await signUpTestUser(`admin-${Date.now()}@test.com`);
  await adminAuth(admin).setCustomUserClaims(t.uid, { admin: true });
  await t.user.getIdToken(true); // refresh claims
  return t;
}

async function pendingProfile(ownerEmailPrefix: string) {
  const owner = await signUpTestUser(`${ownerEmailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "Rooftop 21", handle: `roof_${Date.now()}` },
    owner.user);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  return { owner, profileId };
}

describe("reviewProfile", () => {
  it("admin approves; status flips; audit log written", async () => {
    const { profileId } = await pendingProfile("v1");
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_approved").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(adminUser.uid);
  });
  it("rejection requires a reason and stores it", async () => {
    const { profileId } = await pendingProfile("v2");
    const adminUser = await makeAdminUser();
    await expect(callFn("reviewProfile", { profileId, decision: "rejected" }, adminUser.user))
      .rejects.toThrow(/reason/i);
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "No photos" }, adminUser.user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.status).toBe("rejected");
    expect(p?.rejectionReason).toBe("No photos");
  });
  it("rejects a rejection reason longer than 500 characters", async () => {
    const { profileId } = await pendingProfile("v2b");
    const adminUser = await makeAdminUser();
    const tooLong = "x".repeat(501);
    await expect(callFn("reviewProfile", { profileId, decision: "rejected", reason: tooLong }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("non-admin callers are denied", async () => {
    const { owner, profileId } = await pendingProfile("v3");
    // The client SDK surfaces the HttpsError code as `functions/<code>` on
    // the rejected error's `.code`, not in `.message` (message is "Admin
    // access required.", which does not match /permission|denied/i) —
    // assert on the code, matching the pattern used in profiles.test.ts.
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects re-reviewing a profile that is no longer pending_review", async () => {
    const { profileId } = await pendingProfile("v4");
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

describe("grantAdmin", () => {
  it("admin grants claim to a Google-linked account + audit logged (custom claims merged, not replaced); non-admin denied", async () => {
    const adminUser = await makeAdminUser();
    const targetUid = `google-target-${Date.now()}`;
    const targetEmail = `t-${Date.now()}@test.com`;
    // The client SDK's createUserWithEmailAndPassword always yields a
    // "password" provider — importUsers is the only way (emulator or prod)
    // to seed a user with google.com provider data without a real OAuth
    // flow, so the failed-precondition Google-only gate can be exercised
    // on its passing branch.
    await adminAuth(admin).importUsers([{
      uid: targetUid,
      email: targetEmail,
      providerData: [{ uid: targetEmail, email: targetEmail, providerId: "google.com" }],
      customClaims: { betaTester: true },
    }]);
    await callFn("grantAdmin", { uid: targetUid }, adminUser.user);
    const rec = await adminAuth(admin).getUser(targetUid);
    expect(rec.customClaims?.admin).toBe(true);
    expect(rec.customClaims?.betaTester).toBe(true); // merged, not replaced
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", targetUid).where("action", "==", "admin_granted").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(adminUser.uid);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("grantAdmin", { uid: targetUid }, stranger.user)).rejects.toThrow();
  });

  it("rejects granting admin to a non-Google (password) account — spec §8's no-2FA compensating control", async () => {
    const adminUser = await makeAdminUser();
    const target = await signUpTestUser(`pw-${Date.now()}@test.com`);
    await expect(callFn("grantAdmin", { uid: target.uid }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    const rec = await adminAuth(admin).getUser(target.uid);
    expect(rec.customClaims?.admin).not.toBe(true);
  });

  it("rejects a missing/empty uid with invalid-argument", async () => {
    const adminUser = await makeAdminUser();
    await expect(callFn("grantAdmin", { uid: "" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

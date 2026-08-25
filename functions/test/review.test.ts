import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

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
  it("non-admin callers are denied", async () => {
    const { owner, profileId } = await pendingProfile("v3");
    // The client SDK surfaces the HttpsError code as `functions/<code>` on
    // the rejected error's `.code`, not in `.message` (message is "Admin
    // access required.", which does not match /permission|denied/i) —
    // assert on the code, matching the pattern used in profiles.test.ts.
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("grantAdmin", () => {
  it("admin grants claim + audit logged; non-admin denied", async () => {
    const adminUser = await makeAdminUser();
    const target = await signUpTestUser(`t-${Date.now()}@test.com`);
    await callFn("grantAdmin", { uid: target.uid }, adminUser.user);
    const rec = await adminAuth(admin).getUser(target.uid);
    expect(rec.customClaims?.admin).toBe(true);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("grantAdmin", { uid: stranger.uid }, stranger.user)).rejects.toThrow();
  });
});

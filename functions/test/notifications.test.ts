import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Function execution (reviewProfile -> notifyProfileMembers -> notifyUser) is async
// relative to the callable's resolved promise finishing its Firestore writes being
// visible to a separate admin-SDK read, and a cold-started Functions emulator can add
// latency on top of that. Poll instead of a single fixed sleep — same pattern as the
// cold-start note in authTriggers.test.ts.
vi.setConfig({ testTimeout: 15_000 });

describe("review notifications", () => {
  it("approving a profile writes an inbox notification for each member", async () => {
    const owner = await signUpTestUser(`n1-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Nova", handle: `nova_${Date.now()}` }, owner.user);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await signUpTestUser(`na-${Date.now()}@test.com`);
    await adminAuth(admin).setCustomUserClaims(adminUser.uid, { admin: true });
    await adminUser.user.getIdToken(true);
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    const deadline = Date.now() + 10_000;
    let notes = await adb.collection(`users/${owner.uid}/notifications`).get();
    while (notes.empty && Date.now() < deadline) {
      await wait(250);
      notes = await adb.collection(`users/${owner.uid}/notifications`).get();
    }

    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/approved/i);
  });
});

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput, MemberDoc } from "@gatekeep/shared";

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

// Poll a single user's notifications collection until it has at least one doc, or
// the deadline passes (returns whatever the last read found — possibly still empty,
// which the caller's assertions will then fail on with a clear message).
async function pollNotifications(uid: string) {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

async function makeAdminUser() {
  const t = await signUpTestUser(`na-${Date.now()}@test.com`);
  await adminAuth(admin).setCustomUserClaims(t.uid, { admin: true });
  await t.user.getIdToken(true); // refresh claims
  return t;
}

describe("review notifications", () => {
  it("approving a profile writes an inbox notification for each member", async () => {
    const owner = await signUpTestUser(`n1-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Nova", handle: `nova_${Date.now()}` }, owner.user);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    const notes = await pollNotifications(owner.uid);

    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/approved/i);
  });

  it("rejecting a profile writes a notification whose title and body reflect the decision and reason", async () => {
    const owner = await signUpTestUser(`n2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Comet", handle: `comet_${Date.now()}` }, owner.user);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    const reason = "Please add at least 3 photos and a bio";
    await callFn("reviewProfile", { profileId, decision: "rejected", reason }, adminUser.user);

    const notes = await pollNotifications(owner.uid);

    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/needs changes/i);
    expect(notes.docs[0].data().body).toContain(reason);
  });

  it("approving a profile with multiple members notifies every member's inbox", async () => {
    const owner = await signUpTestUser(`n3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "band", name: "Lunar Sound", handle: `lunar_${Date.now()}` }, owner.user);

    // Add a second member directly via the admin SDK, bypassing the invite-accept
    // callable flow — equivalent end state (a members subcollection doc), simpler
    // for the purposes of this fan-out test.
    const bandmate = await signUpTestUser(`n3b-${Date.now()}@test.com`);
    const member: MemberDoc = { uid: bandmate.uid, role: "member", label: "drummer", joinedAt: Date.now() };
    await adb.doc(`profiles/${profileId}/members/${bandmate.uid}`).set(member);

    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    const [ownerNotes, bandmateNotes] = await Promise.all([
      pollNotifications(owner.uid),
      pollNotifications(bandmate.uid),
    ]);

    for (const notes of [ownerNotes, bandmateNotes]) {
      expect(notes.size).toBe(1);
      expect(notes.docs[0].data().kind).toBe("profile_review");
      expect(notes.docs[0].data().title).toMatch(/approved/i);
    }
  });
});

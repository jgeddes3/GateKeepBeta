import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// The draft-cap and deleteProfile tests below make several sequential
// callable invocations per test; give them the same cold-start headroom
// used elsewhere in this suite (see members.test.ts / review.test.ts).
vi.setConfig({ testTimeout: 15_000 });

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

describe("createProfileDraft", () => {
  it("creates draft profile, claims handle, adds creator as admin member", async () => {
    const { user, uid } = await signUpTestUser(`m1-${Date.now()}@test.com`);
    const handle = `owls_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.status).toBe("draft");
    expect((await adb.doc(`handles/${handle}`).get()).data()?.profileId).toBe(profileId);
    const m = await adb.doc(`profiles/${profileId}/members/${uid}`).get();
    expect(m.data()?.role).toBe("admin");
  });
  it("rejects a taken handle and a reserved handle", async () => {
    const { user } = await signUpTestUser(`m2-${Date.now()}@test.com`);
    const handle = `dupe_${Date.now()}`;
    await callFn("createProfileDraft", draft(handle), user);
    await expect(callFn("createProfileDraft", draft(handle), user)).rejects.toThrow(/taken/i);
    await expect(callFn("createProfileDraft", draft("admin"), user)).rejects.toThrow(/reserved/i);
  });
  it("rejects unauthenticated calls", async () => {
    await expect(callFn("createProfileDraft", draft(`x_${Date.now()}`))).rejects.toThrow();
  });
  it("caps unsubmitted (draft/rejected) profiles per admin at 3, to prevent handle-squatting via never-submitted drafts", async () => {
    const { user } = await signUpTestUser(`cap-${Date.now()}@test.com`);
    for (let i = 0; i < 3; i++) {
      await callFn("createProfileDraft", draft(`cap${i}_${Date.now()}`), user);
    }
    await expect(callFn("createProfileDraft", draft(`cap3_${Date.now()}`), user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("deleteProfile", () => {
  it("a profile admin deletes the profile: profile, members, and handle are all gone; audit written", async () => {
    const { user, uid } = await signUpTestUser(`del1-${Date.now()}@test.com`);
    const handle = `delp_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`handles/${handle}`).get()).exists).toBe(false);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_deleted").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(uid);
  });

  it("a non-admin cannot delete the profile", async () => {
    const { user: admin } = await signUpTestUser(`del2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`delp2_${Date.now()}`), admin);
    const { user: outsider } = await signUpTestUser(`del3-${Date.now()}@test.com`);
    await expect(callFn("deleteProfile", { profileId }, outsider))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("resolves the deletion dead-end: after deleteProfile, a formerly-sole-admin user can then deleteAccount", async () => {
    const { user } = await signUpTestUser(`del4-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`delp4_${Date.now()}`), user);
    // Blocked while sole admin (deleteAccount's existing invariant, unchanged).
    await expect(callFn("deleteAccount", {}, user)).rejects.toThrow(/admin/i);
    await callFn("deleteProfile", { profileId }, user);
    await expect(callFn("deleteAccount", {}, user)).resolves.toMatchObject({ ok: true });
  });
});

describe("submitProfileForReview", () => {
  it("moves draft to pending_review; only member admins may submit", async () => {
    const { user } = await signUpTestUser(`m3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`sub_${Date.now()}`), user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    const { user: outsider } = await signUpTestUser(`m4-${Date.now()}@test.com`);
    await expect(callFn("submitProfileForReview", { profileId }, outsider)).rejects.toThrow();
  });

  it("rejects re-submitting a profile already in pending_review", async () => {
    const { user } = await signUpTestUser(`m5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`resub_${Date.now()}`), user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/pending_review|failed-precondition|Cannot submit/i);
  });

  it("rejects a non-admin member (role: member) trying to submit", async () => {
    const { user: admin } = await signUpTestUser(`m6-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`memb_${Date.now()}`), admin);
    const { uid: memberUid, user: member } = await signUpTestUser(`m7-${Date.now()}@test.com`);
    // Invite flow doesn't exist until Task 8 — seed the membership directly.
    await adb.doc(`profiles/${profileId}/members/${memberUid}`).set({
      uid: memberUid, role: "member", label: "x", joinedAt: Date.now(),
    });
    // The client SDK surfaces the HttpsError code as `functions/<code>` on
    // the rejected error's `.code`, not in `.message` — assert on that
    // rather than a message regex.
    await expect(callFn("submitProfileForReview", { profileId }, member))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

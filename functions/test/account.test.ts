import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait, fetchPendingInviteId } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Cold-start note (see review.test.ts / authTriggers.test.ts): the first
// invocation of a callable in this file can take several seconds in the
// Functions emulator, so raise the default 5s test timeout.
vi.setConfig({ testTimeout: 15_000 });

describe("deleteAccount", () => {
  it("rejects unauthenticated calls", async () => {
    await expect(callFn("deleteAccount", {})).rejects.toThrow();
  });

  it("deletes a plain fan account: auth user, users doc, subcollections", async () => {
    const fan = await signUpTestUser(`d1-${Date.now()}@test.com`);

    // onUserCreated (Task 5) runs async relative to sign-up resolving; poll
    // instead of a fixed sleep, matching the pattern in authTriggers.test.ts.
    const deadline = Date.now() + 10_000;
    let userSnap = await adb.doc(`users/${fan.uid}`).get();
    while (!userSnap.exists && Date.now() < deadline) {
      await wait(250);
      userSnap = await adb.doc(`users/${fan.uid}`).get();
    }
    expect(userSnap.exists).toBe(true);

    await adb.doc(`users/${fan.uid}/notifications/n1`).set({ title: "x", read: false });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`users/${fan.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`users/${fan.uid}/notifications/n1`).get()).exists).toBe(false);
    await expect(adminAuth(admin).getUser(fan.uid)).rejects.toThrow();
  });

  it("refuses while sole admin of a profile, naming it", async () => {
    const owner = await signUpTestUser(`d2-${Date.now()}@test.com`);
    await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `del_${Date.now()}` }, owner.user);
    await expect(callFn("deleteAccount", {}, owner.user)).rejects.toThrow(/Solo Act/);
  });

  it("succeeds after admin transfer; membership removed", async () => {
    const owner = await signUpTestUser(`d3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Loft", handle: `loft_${Date.now()}` }, owner.user);
    const email = `d4-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, co.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    await callFn("deleteAccount", {}, owner.user);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${co.uid}`).get()).exists).toBe(true);
  });
});

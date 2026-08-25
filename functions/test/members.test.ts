import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput, MemberRole } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Cold-start note (see review.test.ts / authTriggers.test.ts): the first
// invocation of a callable in this file can take several seconds in the
// Functions emulator, so raise the default 5s test timeout.
vi.setConfig({ testTimeout: 15_000 });

async function bandWithOwner(prefix: string) {
  const owner = await signUpTestUser(`${prefix}-own-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "band", name: "Band", handle: `${prefix}_${Date.now()}` },
    owner.user);
  return { owner, profileId };
}

describe("invites", () => {
  it("admin invites by email; invitee accepts and becomes member", async () => {
    const { owner, profileId } = await bandWithOwner("inv1");
    const drummerEmail = `drum-${Date.now()}@test.com`;
    const drummer = await signUpTestUser(drummerEmail);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email: drummerEmail, role: "member" as MemberRole, label: "drummer" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, drummer.user);
    const m = await adb.doc(`profiles/${profileId}/members/${drummer.uid}`).get();
    expect(m.data()?.label).toBe("drummer");
  });
  it("declining creates no membership; only invitee may respond; non-admin cannot invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv2");
    const email = `p-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("respondToInvite", { inviteId, accept: true }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("respondToInvite", { inviteId, accept: false }, invitee.user);
    expect((await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get()).exists).toBe(false);
    await expect(callFn("inviteMember", { profileId, email, role: "member", label: "x" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("inviting an email with no GateKeep account fails not-found", async () => {
    const { owner, profileId } = await bandWithOwner("inv3");
    await expect(callFn(
      "inviteMember", { profileId, email: `no-account-${Date.now()}@test.com`, role: "member", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
  it("responding twice to the same invite fails on the second call; invite doc fields/status are correct", async () => {
    const { owner, profileId } = await bandWithOwner("inv4");
    const email = `dup-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "sax" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    const inv = (await adb.doc(`invites/${inviteId}`).get()).data();
    expect(inv?.status).toBe("accepted");
    expect(inv?.invitedUid).toBe(invitee.uid);
    expect(inv?.profileId).toBe(profileId);
    await expect(callFn("respondToInvite", { inviteId, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("accepting an invite while already a member fails with already-exists, and does not overwrite the existing membership", async () => {
    const { owner, profileId } = await bandWithOwner("inv5");
    const email = `dup2-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId: first } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "sax" }, owner.user);
    await callFn("respondToInvite", { inviteId: first, accept: true }, invitee.user);
    // A second, independent invite to the same (now-member) email — accepting
    // it must not blindly .set() over the existing membership doc.
    const { inviteId: second } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "admin", label: "sax2" }, owner.user);
    await expect(callFn("respondToInvite", { inviteId: second, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/already-exists" });
    const m = await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get();
    expect(m.data()?.role).toBe("member");
    expect(m.data()?.label).toBe("sax");
  });

  it("inviting your own email is rejected (you're already on this profile)", async () => {
    const { owner, profileId } = await bandWithOwner("inv6");
    await expect(callFn("inviteMember", { profileId, email: owner.user.email!, role: "member", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("inviteMember rejects an invalid role, and a non-string/overlong label is handled (trimmed and capped)", async () => {
    const { owner, profileId } = await bandWithOwner("inv7");
    const email = `badrole-${Date.now()}@test.com`;
    await signUpTestUser(email);
    await expect(callFn("inviteMember", { profileId, email, role: "owner", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });

    const email2 = `longlabel-${Date.now()}@test.com`;
    const invitee2 = await signUpTestUser(email2);
    const longLabel = `  ${"x".repeat(90)}  `;
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email: email2, role: "member", label: longLabel }, owner.user);
    const inv = (await adb.doc(`invites/${inviteId}`).get()).data();
    expect(inv?.label.length).toBe(60);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee2.user);
  });

  it("respondToInvite rejects invites older than 14 days", async () => {
    const { owner, profileId } = await bandWithOwner("inv8");
    const email = `exp-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const oldCreatedAt = Date.now() - 15 * 86_400_000;
    const inviteRef = await adb.collection("invites").add({
      profileId, profileName: "Band", invitedUid: invitee.uid, role: "member",
      label: "x", invitedByUid: owner.uid, status: "pending", createdAt: oldCreatedAt,
    });
    await expect(callFn("respondToInvite", { inviteId: inviteRef.id, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("a profile admin can revoke a pending invite; the invitee can no longer accept it", async () => {
    const { owner, profileId } = await bandWithOwner("inv9");
    const email = `rev-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    await callFn("revokeInvite", { inviteId }, owner.user);
    expect((await adb.doc(`invites/${inviteId}`).get()).data()?.status).toBe("revoked");
    await expect(callFn("respondToInvite", { inviteId, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("a non-admin cannot revoke an invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv10");
    const email = `rev2-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    await expect(callFn("revokeInvite", { inviteId }, invitee.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("removal and admin transfer", () => {
  it("cannot remove the last admin; transfer then removal works", async () => {
    const { owner, profileId } = await bandWithOwner("rm1");
    // The client SDK surfaces the HttpsError message verbatim for known
    // codes (see review.test.ts note on .code vs .message for other
    // cases) — here the failed-precondition message literally contains
    // "last admin", so the brief's /last admin/i regex matches directly.
    await expect(callFn("removeMember", { profileId, uid: owner.uid }, owner.user))
      .rejects.toThrow(/last admin/i);
    const email = `co-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "keys" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    expect((await adb.doc(`profiles/${profileId}/members/${co.uid}`).get()).data()?.role).toBe("admin");
    await callFn("removeMember", { profileId, uid: owner.uid }, co.user);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
  });
  it("a non-last-admin member can remove themselves", async () => {
    const { owner, profileId } = await bandWithOwner("rm2");
    const email = `self-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await callFn("removeMember", { profileId, uid: member.uid }, member.user);
    expect((await adb.doc(`profiles/${profileId}/members/${member.uid}`).get()).exists).toBe(false);
  });
  it("a non-admin member cannot remove another member", async () => {
    const { owner, profileId } = await bandWithOwner("rm3");
    const email1 = `m1-${Date.now()}@test.com`;
    const member1 = await signUpTestUser(email1);
    const { inviteId: inv1 } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email: email1, role: "member", label: "bass" }, owner.user);
    await callFn("respondToInvite", { inviteId: inv1, accept: true }, member1.user);
    const email2 = `m2-${Date.now()}@test.com`;
    const member2 = await signUpTestUser(email2);
    const { inviteId: inv2 } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email: email2, role: "member", label: "sax" }, owner.user);
    await callFn("respondToInvite", { inviteId: inv2, accept: true }, member2.user);
    await expect(callFn("removeMember", { profileId, uid: member2.uid }, member1.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("a non-admin member cannot transfer admin", async () => {
    const { owner, profileId } = await bandWithOwner("rm4");
    const email = `m-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await expect(callFn("transferAdmin", { profileId, toUid: owner.uid }, member.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("transferAdmin to a non-member fails not-found", async () => {
    const { owner, profileId } = await bandWithOwner("rm5");
    const stranger = await signUpTestUser(`nf-${Date.now()}@test.com`);
    await expect(callFn("transferAdmin", { profileId, toUid: stranger.uid }, owner.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
  it("transferAdmin promotes the target without demoting the original admin", async () => {
    const { owner, profileId } = await bandWithOwner("rm6");
    const email = `co2-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "keys" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    const [ownerDoc, coDoc] = await Promise.all([
      adb.doc(`profiles/${profileId}/members/${owner.uid}`).get(),
      adb.doc(`profiles/${profileId}/members/${co.uid}`).get(),
    ]);
    expect(coDoc.data()?.role).toBe("admin");
    expect(ownerDoc.data()?.role).toBe("admin");
  });
});

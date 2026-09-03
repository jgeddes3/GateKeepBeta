import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, signUpUnverifiedTestUser, callFn, fetchPendingInviteId, makeAdminUser, seedCuratorGateContent,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput, MemberRole, InviteDoc } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Cold-start note (see review.test.ts / authTriggers.test.ts): the first
// invocation of a callable in this file can take several seconds in the
// Functions emulator, so raise the default 5s test timeout.
vi.setConfig({ testTimeout: 30_000 });

async function bandWithOwner(prefix: string) {
  const owner = await signUpTestUser(`${prefix}-own-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "band", name: "Band", handle: `${prefix}_${Date.now()}` },
    owner.user);
  return { owner, profileId };
}

// Approved curator profile fixture, for the curatorAccess touchpoint tests
// below, mirrors gigs.test.ts's/gigSeries.test.ts's identical helper.
async function approvedVenueWithOwner(prefix: string) {
  const owner = await signUpTestUser(`${prefix}-own-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "Venue", handle: `${prefix}_${Date.now()}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${prefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

describe("invites", () => {
  it("admin invites by email; invitee accepts and becomes member", async () => {
    const { owner, profileId } = await bandWithOwner("inv1");
    const drummerEmail = `drum-${Date.now()}@test.com`;
    const drummer = await signUpTestUser(drummerEmail);
    await callFn(
      "inviteMember", { profileId, email: drummerEmail, role: "member" as MemberRole, label: "drummer" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, drummer.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, drummer.user);
    const m = await adb.doc(`profiles/${profileId}/members/${drummer.uid}`).get();
    expect(m.data()?.label).toBe("drummer");
  });
  it("declining creates no membership; only invitee may respond; non-admin cannot invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv2");
    const email = `p-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("respondToInvite", { inviteId, accept: true }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("respondToInvite", { inviteId, accept: false }, invitee.user);
    expect((await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get()).exists).toBe(false);
    await expect(callFn("inviteMember", { profileId, email, role: "member", label: "x" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("inviting an email with no GateKeep account resolves { ok: true } (anti-enumeration) and creates no invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv3");
    const before = (await adb.collection("invites").where("profileId", "==", profileId).get()).size;
    const res = await callFn<object, { ok: true }>(
      "inviteMember", { profileId, email: `no-account-${Date.now()}@test.com`, role: "member", label: "x" }, owner.user);
    expect(res).toEqual({ ok: true });
    const after = (await adb.collection("invites").where("profileId", "==", profileId).get()).size;
    expect(after).toBe(before);
  });
  it("responding twice to the same invite fails on the second call; invite doc fields/status are correct", async () => {
    const { owner, profileId } = await bandWithOwner("inv4");
    const email = `dup-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "sax" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
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
    await callFn("inviteMember", { profileId, email, role: "member", label: "sax" }, owner.user);
    const first = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId: first, accept: true }, invitee.user);
    // A second, independent invite to the same (now-member) email, accepting
    // it must not blindly .set() over the existing membership doc.
    await callFn("inviteMember", { profileId, email, role: "admin", label: "sax2" }, owner.user);
    const second = await fetchPendingInviteId(adb, profileId, invitee.uid);
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
    await callFn("inviteMember", { profileId, email: email2, role: "member", label: longLabel }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee2.uid);
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
    await callFn("inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("revokeInvite", { inviteId }, owner.user);
    expect((await adb.doc(`invites/${inviteId}`).get()).data()?.status).toBe("revoked");
    await expect(callFn("respondToInvite", { inviteId, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("a non-admin cannot revoke an invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv10");
    const email = `rev2-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await expect(callFn("revokeInvite", { inviteId }, invitee.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("SP4 Task 13 (review): revokeInvite rejects a malformed inviteId with invalid-argument and requires a verified caller email", async () => {
    const { owner, profileId } = await bandWithOwner("inv13");
    const email = `rev3-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);

    await expect(callFn("revokeInvite", { inviteId: "bad/id" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });

    const unverified = await signUpUnverifiedTestUser(`rev3u-${Date.now()}@test.com`);
    await expect(callFn("revokeInvite", { inviteId }, unverified.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // Neither rejected call actually revoked the invite.
    expect((await adb.doc(`invites/${inviteId}`).get()).data()?.status).toBe("pending");
  });

  it("an unverified invitee cannot accept an invite (email verification required)", async () => {
    const { owner, profileId } = await bandWithOwner("inv12");
    const email = `unv-${Date.now()}@test.com`;
    const invitee = await signUpUnverifiedTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "x" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await expect(callFn("respondToInvite", { inviteId, accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("caps pending invites per profile at 20", async () => {
    const { owner, profileId } = await bandWithOwner("inv11");
    const now = Date.now();
    const batch = adb.batch();
    for (let i = 0; i < 20; i++) {
      const ref = adb.collection("invites").doc();
      const invite: InviteDoc = {
        profileId, profileName: "Band", invitedUid: `seed-uid-${i}-${now}`,
        role: "member", label: "seed", invitedByUid: owner.uid, status: "pending", createdAt: now,
      };
      batch.set(ref, invite);
    }
    await batch.commit();
    const email = `cap-${now}@test.com`;
    await signUpTestUser(email);
    await expect(callFn("inviteMember", { profileId, email, role: "member", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
    // The cap check runs before email resolution, so it fires uniformly,
    // an email with no account gets resource-exhausted too, not { ok: true
    // }, at/over the cap. Otherwise a caller could distinguish a resolving
    // email from an unknown one once 20 pending invites exist, reopening
    // the anti-enumeration oracle this endpoint is otherwise closed
    // against (see the "no GateKeep account" test above for the
    // below-cap behavior).
    await expect(callFn(
      "inviteMember", { profileId, email: `no-account-cap-${now}@test.com`, role: "member", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });

  it("SP5 Task 3: inviteMember rejects a malformed profileId with invalid-argument, and creates no invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv14");
    const email = `mal-${Date.now()}@test.com`;
    await signUpTestUser(email);
    await expect(callFn("inviteMember", { profileId: "a/b", email, role: "member", label: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    const invites = await adb.collection("invites").where("profileId", "==", profileId).get();
    expect(invites.size).toBe(0);
  });

  it("SP5 Task 3: respondToInvite rejects an overlong (80-char) inviteId with invalid-argument", async () => {
    const invitee = await signUpTestUser(`ov-${Date.now()}@test.com`);
    await expect(callFn("respondToInvite", { inviteId: "x".repeat(80), accept: true }, invitee.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("removal and admin transfer", () => {
  it("cannot remove the last admin; transfer then removal works", async () => {
    const { owner, profileId } = await bandWithOwner("rm1");
    // The client SDK surfaces the HttpsError message verbatim for known
    // codes (see review.test.ts note on .code vs .message for other
    // cases), here the failed-precondition message literally contains
    // "last admin", so the brief's /last admin/i regex matches directly.
    await expect(callFn("removeMember", { profileId, uid: owner.uid }, owner.user))
      .rejects.toThrow(/last admin/i);
    const email = `co-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "keys" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, co.uid);
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
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, member.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await callFn("removeMember", { profileId, uid: member.uid }, member.user);
    expect((await adb.doc(`profiles/${profileId}/members/${member.uid}`).get()).exists).toBe(false);
  });
  it("a non-admin member cannot remove another member", async () => {
    const { owner, profileId } = await bandWithOwner("rm3");
    const email1 = `m1-${Date.now()}@test.com`;
    const member1 = await signUpTestUser(email1);
    await callFn("inviteMember", { profileId, email: email1, role: "member", label: "bass" }, owner.user);
    const inv1 = await fetchPendingInviteId(adb, profileId, member1.uid);
    await callFn("respondToInvite", { inviteId: inv1, accept: true }, member1.user);
    const email2 = `m2-${Date.now()}@test.com`;
    const member2 = await signUpTestUser(email2);
    await callFn("inviteMember", { profileId, email: email2, role: "member", label: "sax" }, owner.user);
    const inv2 = await fetchPendingInviteId(adb, profileId, member2.uid);
    await callFn("respondToInvite", { inviteId: inv2, accept: true }, member2.user);
    await expect(callFn("removeMember", { profileId, uid: member2.uid }, member1.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("a non-admin member cannot transfer admin", async () => {
    const { owner, profileId } = await bandWithOwner("rm4");
    const email = `m-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, member.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await expect(callFn("transferAdmin", { profileId, toUid: owner.uid }, member.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("SP4 Task 13 (review): transferAdmin rejects a malformed profileId/toUid with invalid-argument and requires a verified caller email", async () => {
    const { owner, profileId } = await bandWithOwner("rm9");
    await expect(callFn("transferAdmin", { profileId: "bad/id", toUid: owner.uid }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("transferAdmin", { profileId, toUid: "bad/id" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });

    const unverified = await signUpUnverifiedTestUser(`rm9u-${Date.now()}@test.com`);
    await expect(callFn("transferAdmin", { profileId, toUid: owner.uid }, unverified.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // Owner is still the only admin, none of the rejected calls took effect.
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).data()?.role).toBe("admin");
  });
  it("transferAdmin to a non-member fails not-found", async () => {
    const { owner, profileId } = await bandWithOwner("rm5");
    const stranger = await signUpTestUser(`nf-${Date.now()}@test.com`);
    await expect(callFn("transferAdmin", { profileId, toUid: stranger.uid }, owner.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
  it("SP4 Task 13 item 3: removeMember rejects malformed profileId/uid with invalid-argument", async () => {
    const { owner, profileId } = await bandWithOwner("rm7");
    await expect(callFn("removeMember", { profileId: "bad/id", uid: owner.uid }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("removeMember", { profileId, uid: "bad/id" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("removeMember", { profileId: "", uid: owner.uid }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    // None of the rejected calls actually removed anything, owner is still
    // a member (and still admin) of the real profile.
    const ownerMember = await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get();
    expect(ownerMember.exists).toBe(true);
    expect(ownerMember.data()?.role).toBe("admin");
  });

  it("SP4 Task 13 item 3: removeMember requires a verified email on the caller", async () => {
    const { owner, profileId } = await bandWithOwner("rm8");
    const email = `rm8m-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, member.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);

    const unverified = await signUpUnverifiedTestUser(`rm8u-${Date.now()}@test.com`);
    await expect(callFn("removeMember", { profileId, uid: member.uid }, unverified.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    // The rejected call didn't remove the target member.
    expect((await adb.doc(`profiles/${profileId}/members/${member.uid}`).get()).exists).toBe(true);
  });

  it("transferAdmin promotes the target without demoting the original admin", async () => {
    const { owner, profileId } = await bandWithOwner("rm6");
    const email = `co2-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "keys" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, co.uid);
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

describe("curatorAccess touchpoints", () => {
  it("respondToInvite accept on an APPROVED curator profile sets a curatorAccess marker for the accepting uid", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("mca1");
    const email = `mca1-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true);
  });

  it("respondToInvite accept on a MUSICIAN profile sets no curatorAccess marker (negative control)", async () => {
    const { owner, profileId } = await bandWithOwner("mca2");
    const email = `mca2-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
  });

  it("removeMember from an APPROVED curator profile recomputes and clears the marker for a uid with no other approved curator membership", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("mca3");
    const email = `mca3-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true);

    await callFn("removeMember", { profileId, uid: invitee.uid }, owner.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
  });

  it("removeMember from an APPROVED curator profile PRESERVES the marker when the uid belongs to another approved curator profile too", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("mca4");
    const { owner: otherOwner, profileId: otherProfileId } = await approvedVenueWithOwner("mca4b");
    const email = `mca4-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    await callFn("inviteMember", { profileId: otherProfileId, email, role: "member", label: "manager" }, otherOwner.user);
    const otherInviteId = await fetchPendingInviteId(adb, otherProfileId, invitee.uid);
    await callFn("respondToInvite", { inviteId: otherInviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true);

    await callFn("removeMember", { profileId, uid: invitee.uid }, owner.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true); // still on otherProfileId
  });

  it("removeMember from a MUSICIAN profile does not touch curatorAccess (negative control)", async () => {
    const { owner, profileId } = await bandWithOwner("mca5");
    const email = `mca5-inv-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, member.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await callFn("removeMember", { profileId, uid: member.uid }, owner.user);
    expect((await adb.doc(`curatorAccess/${member.uid}`).get()).exists).toBe(false);
  });

  it("SP4 Task 13 item 6: respondToInvite's curatorAccess grant reflects the profile's status at completion, not the pre-transaction snapshot", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("rti1");
    const email = `rti1-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);

    // Genuine concurrency (not sequenced): fire the accept and a direct
    // status flip to "rejected" at (nearly) the same instant, unawaited
    // relative to each other, a best-effort discriminator, not a
    // deterministic one. respondToInvite's own membership transaction +
    // (post-fix) fresh re-read/recompute is several sequential round trips,
    // slower than this one direct admin write, so in PRACTICE the flip
    // reliably lands before respondToInvite's post-transaction curatorAccess
    // decision runs, and consistently does in this suite. But the true
    // regression this pins only manifests when the flip lands AFTER
    // respondToInvite's very FIRST profileSnap read (the one taken before
    // its own transaction), if the flip instead won THAT earlier race too,
    // even the OLD code's single pre-transaction read would already see
    // "rejected" and correctly skip granting the marker, and this test would
    // pass under both old and new code without having exercised the bug.
    // What's asserted below (marker absent once the profile ends up
    // rejected) is a real invariant either way, it just isn't a guaranteed
    // RED-under-old-code proof on every run, only a highly likely one.
    const [acceptOutcome] = await Promise.allSettled([
      callFn("respondToInvite", { inviteId, accept: true }, invitee.user),
      adb.doc(`profiles/${profileId}`).update({ status: "rejected" }),
    ]);
    expect(acceptOutcome.status).toBe("fulfilled"); // membership itself never depends on profile status

    expect((await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get()).exists).toBe(true);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("rejected");
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
  });

  it("S4: removing an already-removed member succeeds idempotently (no not-found) and still recomputes curatorAccess", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("mca6");
    const email = `mca6-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true);

    await callFn("removeMember", { profileId, uid: invitee.uid }, owner.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get()).exists).toBe(false);

    // Second removal on the now-gone member doc: S4 requires this to
    // succeed (not throw not-found) AND still run the recompute, proven
    // here by it simply not throwing (the recompute is a no-op re-affirming
    // the already-cleared marker).
    await expect(callFn("removeMember", { profileId, uid: invitee.uid }, owner.user))
      .resolves.toMatchObject({ ok: true });
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
  });

  it("SP4 Task 13 item 4 (S4 test gap): removeMember from an already-REJECTED curator profile still recomputes away a stale curatorAccess marker", async () => {
    const { owner, profileId } = await approvedVenueWithOwner("mca8");
    const email = `mca8-inv-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true);

    // Flip the profile to rejected directly (bypassing reviewProfile's own
    // reject-from-approved cascade entirely), this reproduces exactly the
    // "stale marker" state that cascade's own recompute failing (and being
    // queued to curatorAccessRetries rather than resolved inline) would
    // leave behind: an already-REJECTED curator profile whose member still
    // holds a curatorAccess marker earned while it was approved.
    await adb.doc(`profiles/${profileId}`).update({ status: "rejected" });
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(true); // still stale

    await callFn("removeMember", { profileId, uid: invitee.uid }, owner.user);
    expect((await adb.doc(`curatorAccess/${invitee.uid}`).get()).exists).toBe(false);
  });

  it("S4: a member removing themselves after they were already removed succeeds idempotently", async () => {
    const { owner, profileId } = await bandWithOwner("mca7");
    const email = `mca7-${Date.now()}@test.com`;
    const member = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, member.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, member.user);
    await callFn("removeMember", { profileId, uid: member.uid }, owner.user);
    await expect(callFn("removeMember", { profileId, uid: member.uid }, member.user))
      .resolves.toMatchObject({ ok: true });
  });
});

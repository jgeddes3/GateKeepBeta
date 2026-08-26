import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, callFn, makeAdminUser, seedCuratorGateContent, fetchPendingInviteId,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput, GigDoc, GigSeriesDoc } from "@gatekeep/shared";

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

async function pendingProfile(ownerEmailPrefix: string) {
  const owner = await signUpTestUser(`${ownerEmailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "Rooftop 21", handle: `roof_${Date.now()}` },
    owner.user);
  // Task 4 added a curator minimum-content gate to submitProfileForReview —
  // this fixture's subject is the review flow, not the gate, so seed the
  // gate's requirements directly rather than re-deriving them per test.
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  return { owner, profileId };
}

describe("reviewProfile", () => {
  it("admin approves; status flips; audit log written", async () => {
    const { profileId } = await pendingProfile("v1");
    const adminUser = await makeAdminUser("admin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_approved").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(adminUser.uid);
  });
  it("rejection requires a reason and stores it", async () => {
    const { profileId } = await pendingProfile("v2");
    const adminUser = await makeAdminUser("admin");
    await expect(callFn("reviewProfile", { profileId, decision: "rejected" }, adminUser.user))
      .rejects.toThrow(/reason/i);
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "No photos" }, adminUser.user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.status).toBe("rejected");
    expect(p?.rejectionReason).toBe("No photos");
  });
  it("rejects a rejection reason longer than 500 characters", async () => {
    const { profileId } = await pendingProfile("v2b");
    const adminUser = await makeAdminUser("admin");
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
    const adminUser = await makeAdminUser("admin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  // Spec §6: "admins can retroactively unpublish anything" — profiles didn't
  // have this path before (only reviewTrack did); reject now also accepts an
  // already-approved profile, flipping it to rejected so firestore.rules
  // hides it (and all its tracks, via profileApproved()) from public reads.
  it("retroactive unpublish: rejecting an approved profile flips it to rejected and records the prior status in the audit detail", async () => {
    const { profileId } = await pendingProfile("v5");
    const adminUser = await makeAdminUser("admin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Impersonation report" }, adminUser.user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.status).toBe("rejected");
    expect(p?.rejectionReason).toBe("Impersonation report");
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_rejected").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().detail).toBe("[was approved] Impersonation report");
  });
  it("approving an already-approved profile still fails failed-precondition (approve stays pending_review-only)", async () => {
    const { profileId } = await pendingProfile("v6");
    const adminUser = await makeAdminUser("admin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("P2: rejects an invalid decision value with invalid-argument", async () => {
    const { profileId } = await pendingProfile("v7");
    const adminUser = await makeAdminUser("admin");
    await expect(callFn("reviewProfile", { profileId, decision: "maybe" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("P2: rejects a malformed profileId with invalid-argument", async () => {
    const adminUser = await makeAdminUser("admin");
    await expect(callFn("reviewProfile", { profileId: "../etc", decision: "approved" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("reviewProfile", { profileId: "", decision: "approved" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("P2: approving a profile DELETES lastRejectedAt and resubmitCount (world-readable moderation-history leak)", async () => {
    const { owner, profileId } = await pendingProfile("v8");
    const adminUser = await makeAdminUser("admin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Round 1" }, adminUser.user);
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const beforeApprove = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(typeof beforeApprove?.lastRejectedAt).toBe("number");
    expect(beforeApprove?.resubmitCount).toBe(1);

    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    const approved = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(approved?.status).toBe("approved");
    expect(approved).not.toHaveProperty("lastRejectedAt");
    expect(approved).not.toHaveProperty("resubmitCount");
  });
});

const SEED_LOCATION = {
  venueName: "Rooftop 21", neighborhood: "Downtown", city: "Austin",
  geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: "123 Main St, Austin, TX",
};

async function seedOpenGig(curatorProfileId: string, overrides: Partial<GigDoc> = {}): Promise<string> {
  const ref = adb.collection("gigs").doc();
  const now = Date.now();
  const doc: GigDoc = {
    curatorProfileId, seriesId: null, detachedFromTemplate: false,
    title: "Seeded gig", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
    budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
    startsAt: now + 7 * 24 * 3600 * 1000, durationMinutes: 60,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    location: SEED_LOCATION as GigDoc["location"],
    status: "open", createdAt: now, updatedAt: now,
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

async function seedSeries(curatorProfileId: string, overrides: Partial<GigSeriesDoc> = {}): Promise<string> {
  const ref = adb.collection("gigSeries").doc();
  const now = Date.now();
  const doc: GigSeriesDoc = {
    curatorProfileId,
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    fillMode: "per_occurrence",
    template: {
      title: "Seeded series", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 1000, maxCents: 2000, structure: "perHour" }, durationMinutes: 60,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: SEED_LOCATION as GigDoc["location"],
    },
    templatePrivateLocation: { address: SEED_LOCATION.address, geo: SEED_LOCATION.geo },
    status: "active", materializedThrough: 0, createdAt: now, updatedAt: now,
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

describe("reviewProfile: curatorAccess maintenance + takedown cascade", () => {
  it("approving a curator profile sets a curatorAccess marker for every member, including one who joined before approval", async () => {
    const { owner, profileId } = await pendingProfile("ca1");
    // Note: pendingProfile already submitted for review — invite/accept a
    // colleague onto the still-pending profile before it's approved, so the
    // approve path's "every member" claim is actually exercised against more
    // than just the owner.
    const email = `ca1-colleague-${Date.now()}@test.com`;
    const colleague = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, colleague.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, colleague.user);
    expect((await adb.doc(`curatorAccess/${colleague.uid}`).get()).exists).toBe(false); // not yet — profile isn't approved

    const adminUser = await makeAdminUser("ca1a");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    expect((await adb.doc(`curatorAccess/${owner.uid}`).get()).exists).toBe(true);
    expect((await adb.doc(`curatorAccess/${colleague.uid}`).get()).exists).toBe(true);
  });

  it("approving a MUSICIAN profile creates no curatorAccess marker (negative control)", async () => {
    const owner = await signUpTestUser(`ca2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `ca2_${Date.now()}` },
      owner.user);
    await callFn("updatePortfolio", { profileId, bio: "x", genres: ["soul"] }, owner.user);
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    // Musicians' submit gate requires a listenable track too; this test's
    // subject is curatorAccess, not the gate — admin-approve directly is not
    // possible (approve requires pending_review), so seed status straight to
    // pending_review via the admin SDK rather than clearing the track gate.
    await adb.doc(`profiles/${profileId}`).update({ status: "pending_review" });
    const adminUser = await makeAdminUser("ca2a");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`curatorAccess/${owner.uid}`).get()).exists).toBe(false);
  });

  it("cascade: reject-from-approved on a curator profile closes its open gigs, pauses its active series, and recomputes curatorAccess for every member (audit detail carries the counts)", async () => {
    const { owner, profileId } = await pendingProfile("ca3");
    const email = `ca3-colleague-${Date.now()}@test.com`;
    const colleague = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, colleague.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, colleague.user);
    const adminUser = await makeAdminUser("ca3a");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`curatorAccess/${owner.uid}`).get()).exists).toBe(true);
    expect((await adb.doc(`curatorAccess/${colleague.uid}`).get()).exists).toBe(true);

    // The colleague ALSO belongs to a second, independently-approved curator
    // profile — their marker must survive profile A's rejection.
    const otherOwner = await signUpTestUser(`ca3-otherowner-${Date.now()}@test.com`);
    const { profileId: otherProfileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Other Venue", handle: `ca3other_${Date.now()}` },
      otherOwner.user);
    await seedCuratorGateContent(adb, otherProfileId);
    const otherEmail = colleague.user.email!;
    await callFn("inviteMember", { profileId: otherProfileId, email: otherEmail, role: "member", label: "manager" }, otherOwner.user);
    const otherInviteId = await fetchPendingInviteId(adb, otherProfileId, colleague.uid);
    await callFn("respondToInvite", { inviteId: otherInviteId, accept: true }, colleague.user);
    await callFn("submitProfileForReview", { profileId: otherProfileId }, otherOwner.user);
    const otherAdmin = await makeAdminUser("ca3b");
    await callFn("reviewProfile", { profileId: otherProfileId, decision: "approved" }, otherAdmin.user);

    // Seed live content on profile A: two open gigs, one draft gig (must NOT
    // be touched/counted), one active series, one already-paused series
    // (must stay paused, not double-counted).
    const openGig1 = await seedOpenGig(profileId);
    const openGig2 = await seedOpenGig(profileId);
    const draftGig = await seedOpenGig(profileId, { status: "draft" });
    const activeSeries = await seedSeries(profileId);
    const pausedSeries = await seedSeries(profileId, { status: "paused" });

    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, adminUser.user);

    expect((await adb.doc(`gigs/${openGig1}`).get()).data()?.status).toBe("closed");
    expect((await adb.doc(`gigs/${openGig2}`).get()).data()?.status).toBe("closed");
    expect((await adb.doc(`gigs/${draftGig}`).get()).data()?.status).toBe("draft"); // untouched
    expect((await adb.doc(`gigSeries/${activeSeries}`).get()).data()?.status).toBe("paused");
    expect((await adb.doc(`gigSeries/${pausedSeries}`).get()).data()?.status).toBe("paused"); // still paused

    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_rejected").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().detail).toBe("[was approved] Policy violation. (closed 2 gigs, paused 1 series)");

    // curatorAccess recompute: the owner belongs to no OTHER approved curator
    // profile — marker gone. The colleague still belongs to otherProfileId —
    // marker survives.
    expect((await adb.doc(`curatorAccess/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`curatorAccess/${colleague.uid}`).get()).exists).toBe(true);
  });

  it("rejecting an approved MUSICIAN profile appends no gig/series cascade counts to the audit detail (existing behavior untouched)", async () => {
    const owner = await signUpTestUser(`ca4-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `ca4_${Date.now()}` },
      owner.user);
    await adb.doc(`profiles/${profileId}`).update({ status: "approved" });
    const adminUser = await makeAdminUser("ca4a");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Reported content." }, adminUser.user);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_rejected").get();
    expect(logs.docs[0].data().detail).toBe("[was approved] Reported content.");
  });
});

describe("grantAdmin", () => {
  it("admin grants claim to a Google-linked account + audit logged (custom claims merged, not replaced); non-admin denied", async () => {
    const adminUser = await makeAdminUser("admin");
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
    const adminUser = await makeAdminUser("admin");
    const target = await signUpTestUser(`pw-${Date.now()}@test.com`);
    await expect(callFn("grantAdmin", { uid: target.uid }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    const rec = await adminAuth(admin).getUser(target.uid);
    expect(rec.customClaims?.admin).not.toBe(true);
  });

  it("rejects a missing/empty uid with invalid-argument", async () => {
    const adminUser = await makeAdminUser("admin");
    await expect(callFn("grantAdmin", { uid: "" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

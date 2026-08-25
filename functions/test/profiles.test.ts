import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, signUpUnverifiedTestUser, callFn, wait, uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import type { ProfileDraftInput, CreateTrackInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Admin SDK must target the storage emulator (mirrors helpers.ts) — needed
// by the deleteProfile storage cascade tests below.
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");

// The draft-cap and deleteProfile tests below make several sequential
// callable invocations per test; give them the same cold-start headroom
// used elsewhere in this suite (see members.test.ts / review.test.ts).
vi.setConfig({ testTimeout: 15_000 });

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

// For submitProfileForReview tests whose subject is the status transition
// itself (not the Task 9 musician minimum-content gate) — curators have no
// portfolio gate, so this fixture keeps those tests focused on submit/resubmit
// mechanics instead of needing to seed bio/genre/avatar/track content.
const curatorDraft = (handle: string): ProfileDraftInput =>
  ({ type: "curator", subtype: "venue", name: "The Rooftop", handle });

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
  it("rejects an unverified-email caller with failed-precondition", async () => {
    const { user } = await signUpUnverifiedTestUser(`unverified-${Date.now()}@test.com`);
    await expect(callFn("createProfileDraft", draft(`unv_${Date.now()}`), user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
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
      "createProfileDraft", curatorDraft(`sub_${Date.now()}`), user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    const { user: outsider } = await signUpTestUser(`m4-${Date.now()}@test.com`);
    await expect(callFn("submitProfileForReview", { profileId }, outsider)).rejects.toThrow();
  });

  it("rejects re-submitting a profile already in pending_review", async () => {
    const { user } = await signUpTestUser(`m5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`resub_${Date.now()}`), user);
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

describe("submitProfileForReview minimum content (musicians)", () => {
  it("refuses an empty musician draft, listing what's missing; passes once bio+genre+avatar+track exist", async () => {
    const { user } = await signUpTestUser(`gate-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `gate_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    // avatar via admin SDK shortcut (photo pipeline has its own tests)
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i); // still no track

    const wav = makeWav(12);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  }, 60_000);

  it("lists all four missing items when nothing has been filled in", async () => {
    const { user } = await signUpTestUser(`gatem-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Empty", handle: `gatem_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/bio.*genre.*photo.*track/i);
  });

  it("a track stuck in 'processing' (upload never completed) does not satisfy the gate", async () => {
    const { user } = await signUpTestUser(`gatep-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Stalled", handle: `gatep_${Date.now()}` }, user);
    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    // createTrack writes the doc (status: "processing") before any bytes are
    // uploaded — abandon it here, exactly as a musician who never finishes
    // the upload would. LISTENABLE_TRACK_STATUSES excludes "processing", so
    // this must not satisfy the gate.
    await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: 1000, contentType: "audio/wav" }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i);
  });

  it("curator drafts submit without portfolio checks (unchanged from foundation)", async () => {
    const { user } = await signUpTestUser(`gatec-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "The Room", handle: `gatec_${Date.now()}` }, user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });
});

describe("deleteProfile storage cascade", () => {
  it("deletes the profile's public/review storage objects along with the docs", async () => {
    const { user } = await signUpTestUser(`delc-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `delc_${Date.now()}` }, user);
    // Seed storage objects directly — exercising the full pipeline is Task 7's job.
    await abucket.file(`review/tracks/${profileId}/t1.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/tracks/${profileId}/t2.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/photos/${profileId}/avatar-x.jpg`).save(Buffer.from([1]), { contentType: "image/jpeg" });
    await callFn("deleteProfile", { profileId }, user);
    for (const p of [`review/tracks/${profileId}/t1.m4a`, `public/tracks/${profileId}/t2.m4a`,
                     `public/photos/${profileId}/avatar-x.jpg`]) {
      const [exists] = await abucket.file(p).exists();
      expect(exists).toBe(false);
    }
  }, 60_000);

  it("does not touch another profile's storage objects — negative control on the prefix sweep", async () => {
    const { user } = await signUpTestUser(`delcn-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava2", handle: `delcn_${Date.now()}` }, user);
    const { profileId: otherProfileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Bystander", handle: `delcn2_${Date.now()}` }, user);
    const survivor = `public/tracks/${otherProfileId}/t9.m4a`;
    await abucket.file(survivor).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await callFn("deleteProfile", { profileId }, user);
    const [exists] = await abucket.file(survivor).exists();
    expect(exists).toBe(true);
  }, 60_000);
});

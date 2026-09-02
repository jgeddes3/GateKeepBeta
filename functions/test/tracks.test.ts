import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, signUpUnverifiedTestUser, callFn, uploadTestAudio, makeWav, waitForTrackStatus, makeAdminUser,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import { stagingAudioPath, type ProfileDraftInput, type CreateTrackInput, MAX_TRACKS } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");
// 60s (not the file's original 20s): the reviewTrack tests below upload and
// wait on a real ffmpeg transcode via makePendingTrack, same as media.test.ts.
vi.setConfig({ testTimeout: 60_000 });

async function makeMusician(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
    { type: "musician", subtype: "solo", name: "Ava", handle: `${prefix}_${Date.now()}` }, user);
  return { user, uid, profileId };
}
const input = (profileId: string, title = "Song"): CreateTrackInput =>
  ({ profileId, title, startSec: 0, sizeBytes: 1000, contentType: "audio/wav" });

describe("createTrack", () => {
  it("creates a processing doc and returns the staging upload path", async () => {
    const { user, uid, profileId } = await makeMusician("ct1");
    const res = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", input(profileId, "Midnight Line"), user);
    expect(res.uploadPath).toBe(stagingAudioPath(uid, profileId, res.trackId));
    const t = await adb.doc(`profiles/${profileId}/tracks/${res.trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Midnight Line", status: "processing", uploaderUid: uid, startSec: 0 });
  });
  it("enforces the 10-track cap over non-dead tracks", async () => {
    const { user, profileId } = await makeMusician("ct2");
    for (let i = 0; i < MAX_TRACKS; i++) await callFn("createTrack", input(profileId, `T${i}`), user);
    await expect(callFn("createTrack", input(profileId, "over"), user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
    // rejected tracks free a slot
    const first = (await adb.collection(`profiles/${profileId}/tracks`).limit(1).get()).docs[0];
    await first.ref.update({ status: "rejected" });
    await callFn("createTrack", input(profileId, "fits-now"), user);
  });
  it("rejects a non-member with permission-denied", async () => {
    const { profileId } = await makeMusician("ct3");
    const { user: stranger } = await signUpTestUser(`ct3s-${Date.now()}@test.com`);
    await expect(callFn("createTrack", input(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects an unverified-email member with failed-precondition", async () => {
    // An unverified account cannot create its own profile (createProfileDraft
    // gates on it), so a verified owner creates the profile and the admin SDK
    // seeds the membership directly, mirrors portfolio.test.ts's pattern.
    const { profileId } = await makeMusician("ct4");
    const { uid: memberUid, user: memberUser } = await signUpUnverifiedTestUser(`ct4m-${Date.now()}@test.com`);
    await adb.doc(`profiles/${profileId}/members/${memberUid}`).set({
      uid: memberUid, role: "member", label: "x", joinedAt: Date.now(),
    });
    await expect(callFn("createTrack", input(profileId), memberUser))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("rejects a curator profile with failed-precondition", async () => {
    const { user } = await signUpTestUser(`ct5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "The Venue", handle: `ct5_${Date.now()}` }, user);
    await expect(callFn("createTrack", input(profileId), user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("caps concurrent creates at MAX_TRACKS instead of overcommitting (transaction serialization)", async () => {
    const { user, profileId } = await makeMusician("cc1");
    const tracksCol = adb.collection(`profiles/${profileId}/tracks`);
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      await tracksCol.add({
        title: `Seed${i}`, status: "processing", uploaderUid: "seed",
        startSec: 0, durationSec: null, storagePath: null,
        rejectionReason: null, failureReason: null, order: i,
        createdAt: now, updatedAt: now,
      });
    }
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => callFn("createTrack", input(profileId, `Race${i}`), user)));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "functions/resource-exhausted" });
    }
    const active = await tracksCol.where("status", "in", ["processing", "pending_review", "approved"]).get();
    expect(active.size).toBe(10);
  }, 30_000);
});

describe("updateTrack / deleteTrack", () => {
  it("member retitles; deleteTrack removes the doc", async () => {
    const { user, profileId } = await makeMusician("ut1");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    await callFn("updateTrack", { profileId, trackId, title: "Renamed" }, user);
    let t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Renamed" });
    await callFn("deleteTrack", { profileId, trackId }, user);
    t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.exists).toBe(false);
  });
  it("stranger cannot update or delete", async () => {
    const { user, profileId } = await makeMusician("ut2");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    const { user: stranger } = await signUpTestUser(`ut2s-${Date.now()}@test.com`);
    await expect(callFn("updateTrack", { profileId, trackId, title: "hax" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("deleteTrack", { profileId, trackId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("reorderTracks", () => {
  it("normalizes order for the given sequence, then heals the rest in prior relative order for a partial list", async () => {
    const { user, profileId } = await makeMusician("rt1");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { trackId } = await callFn<CreateTrackInput, { trackId: string }>(
        "createTrack", input(profileId, `T${i}`), user);
      ids.push(trackId);
    }
    const [t0, t1, t2] = ids;
    await callFn("reorderTracks", { profileId, trackIds: [t2, t0, t1] }, user);
    const afterFirst = await adb.collection(`profiles/${profileId}/tracks`).get();
    const orderOf = (docs: FirebaseFirestore.QuerySnapshot, id: string) =>
      docs.docs.find((d) => d.id === id)!.data().order;
    expect(orderOf(afterFirst, t2)).toBe(0);
    expect(orderOf(afterFirst, t0)).toBe(1);
    expect(orderOf(afterFirst, t1)).toBe(2);

    // Partial/stale list: only t1 is mentioned. t1 goes first; the rest
    // (t2, t0) keep their prior relative order (t2 before t0).
    await callFn("reorderTracks", { profileId, trackIds: [t1] }, user);
    const afterSecond = await adb.collection(`profiles/${profileId}/tracks`).get();
    expect(orderOf(afterSecond, t1)).toBe(0);
    expect(orderOf(afterSecond, t2)).toBe(1);
    expect(orderOf(afterSecond, t0)).toBe(2);
  });
  it("stranger cannot reorder", async () => {
    const { user, profileId } = await makeMusician("rt2");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    const { user: stranger } = await signUpTestUser(`rt2s-${Date.now()}@test.com`);
    await expect(callFn("reorderTracks", { profileId, trackIds: [trackId] }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("heals a duplicate order value left by rejecting the highest-order track then creating a new one", async () => {
    const { user, profileId } = await makeMusician("dh1");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { trackId } = await callFn<CreateTrackInput, { trackId: string }>(
        "createTrack", input(profileId, `T${i}`), user);
      ids.push(trackId);
    }
    const tracksCol = adb.collection(`profiles/${profileId}/tracks`);
    // Reject the highest-order (last-created) track, it drops out of the
    // "active" set used to compute the next order, but its own order field
    // is left untouched, so the next create can reuse that order number.
    await tracksCol.doc(ids[2]).update({ status: "rejected" });
    await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId, "New"), user);

    const beforeHeal = await tracksCol.get();
    const orders = beforeHeal.docs.map((d) => d.data().order);
    expect(new Set(orders).size).toBeLessThan(orders.length); // duplicate exists

    await callFn("reorderTracks", { profileId, trackIds: beforeHeal.docs.map((d) => d.id) }, user);
    const healed = await tracksCol.get();
    const healedOrders = healed.docs.map((d) => d.data().order as number).sort((a, b) => a - b);
    expect(healedOrders).toEqual(Array.from({ length: healed.size }, (_, i) => i));
    expect(new Set(healedOrders).size).toBe(healedOrders.length);
  });
  it("accepts a list spanning all docs beyond the old 20-id cap (10 active + 11 dead) and normalizes orders 0..20", async () => {
    const { user, profileId } = await makeMusician("big1");
    const tracksCol = adb.collection(`profiles/${profileId}/tracks`);
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ref = await tracksCol.add({
        title: `Active${i}`, status: "processing", uploaderUid: "seed",
        startSec: 0, durationSec: null, storagePath: null,
        rejectionReason: null, failureReason: null, order: i,
        createdAt: now, updatedAt: now,
      });
      ids.push(ref.id);
    }
    for (let i = 0; i < 11; i++) {
      const ref = await tracksCol.add({
        title: `Dead${i}`, status: "failed", uploaderUid: "seed",
        startSec: 0, durationSec: null, storagePath: null,
        rejectionReason: null, failureReason: "boom", order: i,
        createdAt: now, updatedAt: now,
      });
      ids.push(ref.id);
    }
    expect(ids.length).toBe(21);
    await callFn("reorderTracks", { profileId, trackIds: ids }, user);
    const after = await tracksCol.get();
    const orders = after.docs.map((d) => d.data().order as number).sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });
});

async function makePendingTrack(prefix: string) {
  const { user, uid, profileId } = await makeMusician(prefix);
  const wav = makeWav(35);
  const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
    "createTrack", { profileId, title: "For review", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
  await uploadTestAudio(uploadPath, wav, "audio/wav", user);
  await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
  return { user, uid, profileId, trackId };
}

describe("reviewTrack", () => {
  it("approve copies the clip to public, deletes review copy, flips status, audits, notifies", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv1");
    const { user: adminUser } = await makeAdminUser("rv1a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.status).toBe("approved");
    expect(t.data()?.storagePath).toBe(`public/tracks/${profileId}/${trackId}.m4a`);
    const [pub] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    const [rev] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pub).toBe(true);
    expect(rev).toBe(false);
    const audit = await adb.collection("auditLogs").where("targetId", "==", `${profileId}/${trackId}`).get();
    expect(audit.docs.some((d) => d.data().action === "track_approved")).toBe(true);
    // Pins the notification path: notifyProfileMembers writes an inbox
    // notification for every member (the sole musician member here).
    const notifs = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifs.empty).toBe(false);
  });
  it("reject requires a reason ≤500, deletes the clip, keeps the doc with the reason", async () => {
    const { profileId, trackId } = await makePendingTrack("rv2");
    const { user: adminUser } = await makeAdminUser("rv2a");
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "rejected" }, adminUser))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: "Sounds AI-generated." }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "Sounds AI-generated.", storagePath: null });
    const [rev] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(rev).toBe(false);
  });
  it("non-admin cannot review; a second 'approved' decision is refused (already approved, not pending)", async () => {
    const { user, profileId, trackId } = await makePendingTrack("rv3");
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const { user: adminUser } = await makeAdminUser("rv3a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    await expect(callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("reject also works on an already-approved track (retroactive takedown, spec §6): public object removed, storagePath cleared, audit records the prior state, musician notified", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv4");
    const { user: adminUser, uid: adminUid } = await makeAdminUser("rv4a");
    await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    const [pubBefore] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubBefore).toBe(true);
    await callFn("reviewTrack",
      { profileId, trackId, decision: "rejected", reason: "Copyright complaint." }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "Copyright complaint.", storagePath: null });
    const [pubAfter] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubAfter).toBe(false);
    const audit = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data().actorUid).toBe(adminUid);
    expect(audit.docs[0].data().detail).toMatch(/^\[was approved\]/);
    // Pins that a takedown's notification fires at claim time (right after
    // the transaction, alongside the audit) rather than after storage
    // cleanup, see reviewTrack's comment on that ordering: it exists so a
    // storage-cleanup failure (HttpsError "unavailable") can't swallow the
    // notification the way it could when notification lived at the very
    // end. Reproducing that exact storage failure isn't practical against
    // the real Storage emulator (the Admin SDK bypasses storage.rules, and
    // there's no supported way to force a non-404 delete error), so this
    // instead confirms the notification exists for the ordinary success
    // path at the new call site.
    const notifs = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifs.docs.some((d) => /removed from your portfolio/.test(d.data().title as string))).toBe(true);
  });
  it("approve fails cleanly when the review clip is already gone: failed-precondition, doc rolled back to pending_review", async () => {
    const { profileId, trackId } = await makePendingTrack("rv5");
    const { user: adminUser } = await makeAdminUser("rv5a");
    // Simulates storage/doc drift (e.g. a prior partial failure, or a
    // hand-edited emulator state), the doc says pending_review but the
    // review object backing it is gone.
    await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).delete();
    let err: unknown;
    try {
      await callFn("reviewTrack", { profileId, trackId, decision: "approved" }, adminUser);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "functions/failed-precondition" });
    expect((err as Error).message).toMatch(/review clip is missing/i);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.status).toBe("pending_review");
  });
  it("accepts a rejection reason of exactly 500 characters (checked/stored trimmed); 501 is invalid-argument", async () => {
    const { profileId, trackId } = await makePendingTrack("rv6");
    const { user: adminUser } = await makeAdminUser("rv6a");
    const padded = "  " + "x".repeat(500) + "  "; // trims to exactly 500
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: padded }, adminUser);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()?.rejectionReason).toBe("x".repeat(500));

    const { profileId: p2, trackId: t2 } = await makePendingTrack("rv6b");
    await expect(callFn("reviewTrack", { profileId: p2, trackId: t2, decision: "rejected", reason: "x".repeat(501) }, adminUser))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("rejecting an already-rejected track is an idempotent retry: storage re-attempted, no duplicate audit/notification", async () => {
    const { uid, profileId, trackId } = await makePendingTrack("rv7");
    const { user: adminUser } = await makeAdminUser("rv7a");
    await callFn("reviewTrack", { profileId, trackId, decision: "rejected", reason: "First reason." }, adminUser);

    // Simulates storage drift after the first reject (e.g. a stray copy that
    // landed here despite the doc already saying "rejected"), the retry
    // must still find and remove it, proving the retry re-attempts storage
    // work rather than short-circuiting on "already rejected".
    await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).save(Buffer.from([9]), { contentType: "audio/mp4" });

    const auditBefore = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    const notifsBefore = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();

    const res = await callFn<{ profileId: string; trackId: string; decision: "rejected"; reason: string },
      { ok: boolean }>("reviewTrack", { profileId, trackId, decision: "rejected", reason: "First reason." }, adminUser);
    expect(res.ok).toBe(true);
    const t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ status: "rejected", rejectionReason: "First reason.", storagePath: null });

    // Storage work was re-attempted: the stray public object is gone.
    const [pubExists] = await abucket.file(`public/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(pubExists).toBe(false);

    const auditAfter = await adb.collection("auditLogs")
      .where("targetId", "==", `${profileId}/${trackId}`).where("action", "==", "track_rejected").get();
    expect(auditAfter.size).toBe(auditBefore.size); // no duplicate audit row
    const notifsAfter = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "track_review").get();
    expect(notifsAfter.size).toBe(notifsBefore.size); // no duplicate notification
  });
});

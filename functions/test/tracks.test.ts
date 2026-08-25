import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, signUpUnverifiedTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { stagingAudioPath, type ProfileDraftInput, type CreateTrackInput, MAX_TRACKS } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 20_000 });

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
    // seeds the membership directly — mirrors portfolio.test.ts's pattern.
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
    // Reject the highest-order (last-created) track — it drops out of the
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
});

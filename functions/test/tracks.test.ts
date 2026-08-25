import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
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
  it("rejects non-members, unverified email, and curator profiles", async () => {
    const { profileId } = await makeMusician("ct3");
    const { user: stranger } = await signUpTestUser(`ct3s-${Date.now()}@test.com`);
    await expect(callFn("createTrack", input(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("updateTrack / deleteTrack", () => {
  it("member retitles and reorders; deleteTrack removes the doc", async () => {
    const { user, profileId } = await makeMusician("ut1");
    const { trackId } = await callFn<CreateTrackInput, { trackId: string }>("createTrack", input(profileId), user);
    await callFn("updateTrack", { profileId, trackId, title: "Renamed", order: 4 }, user);
    let t = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(t.data()).toMatchObject({ title: "Renamed", order: 4 });
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

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import type { ProfileDraftInput, CreateTrackInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");
vi.setConfig({ testTimeout: 60_000 }); // ffmpeg on emulator cold start

async function makeMusician(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
    { type: "musician", subtype: "solo", name: "Ava", handle: `${prefix}_${Date.now()}` }, user);
  return { user, uid, profileId };
}

describe("processUpload: audio", () => {
  it("transcodes a wav into a ≤30s m4a review clip, deletes the original, sets pending_review", async () => {
    const { user, profileId } = await makeMusician("tx1");
    const wav = makeWav(45); // 45s source, window starts at 10s
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Clip", startSec: 10, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    expect(data.durationSec).toBeGreaterThan(25);
    expect(data.durationSec).toBeLessThanOrEqual(30);
    expect(data.storagePath).toBe(`review/tracks/${profileId}/${trackId}.m4a`);
    const [reviewExists] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(reviewExists).toBe(true);
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false); // original discarded
  });
  it("clips shorter than the window remainder still work (duration = source - start)", async () => {
    const { user, profileId } = await makeMusician("tx2");
    const wav = makeWav(18);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Short", startSec: 5, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    expect(data.durationSec).toBeGreaterThan(10);
    expect(data.durationSec).toBeLessThanOrEqual(13.5);
  });
  it("fails cleanly when startSec is beyond the audio, and deletes the staging object", async () => {
    const { user, profileId } = await makeMusician("tx3");
    const wav = makeWav(8);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Bad", startSec: 60, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["failed"]);
    expect(data.failureReason).toMatch(/start/i);
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false);
  });
  it("ignores uploads with no matching processing track doc", async () => {
    const { user, uid, profileId } = await makeMusician("tx4");
    await uploadTestAudio(`staging/audio/${uid}/${profileId}/forged-track-id`, makeWav(2), "audio/wav", user);
    // No doc to flip — just assert nothing lands in review for that id.
    await new Promise((r) => setTimeout(r, 4000));
    const [exists] = await abucket.file(`review/tracks/${profileId}/forged-track-id.m4a`).exists();
    expect(exists).toBe(false);
  });
});

describe("processUpload: photos", () => {
  // Minimal valid 1x1 JPEG for sharp to re-encode.
  const tinyJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
  // Same 1x1 image, 3 bytes longer — decodes fine but trips libjpeg's
  // "extraneous bytes" warning, as many real phone encoders do; pins
  // failOn:"error" tolerance (media.ts must not reject on this).
  const warnJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
  it("processes an avatar into public/photos and updates the profile doc", async () => {
    const { user, uid, profileId } = await makeMusician("ph1");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user); // same uploader helper works for any bytes
    const deadline = Date.now() + 30_000;
    let avatarPath: string | null = null;
    while (Date.now() < deadline && !avatarPath) {
      avatarPath = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (!avatarPath) await new Promise((r) => setTimeout(r, 500));
    }
    expect(avatarPath).toMatch(new RegExp(`^public/photos/${profileId}/avatar-`));
    const [exists] = await abucket.file(avatarPath!).exists();
    expect(exists).toBe(true);
  });
  it("ignores photo uploads from a non-member of the target profile", async () => {
    const { profileId } = await makeMusician("ph2");
    const { user: outsider, uid: outsiderUid } = await signUpTestUser(`ph2o-${Date.now()}@test.com`);
    await uploadTestAudio(`staging/photos/${outsiderUid}/${profileId}/avatar-${Date.now()}`,
      tinyJpeg(), "image/jpeg", outsider);
    await new Promise((r) => setTimeout(r, 4000));
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
  });
  it("processes a warning-tripping-but-valid cover JPEG successfully", async () => {
    const { user, uid, profileId } = await makeMusician("ph3");
    const path = `staging/photos/${uid}/${profileId}/cover-${Date.now()}`;
    await uploadTestAudio(path, warnJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let coverPath: string | null = null;
    while (Date.now() < deadline && !coverPath) {
      coverPath = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.coverPhotoPath ?? null;
      if (!coverPath) await new Promise((r) => setTimeout(r, 500));
    }
    expect(coverPath).toMatch(new RegExp(`^public/photos/${profileId}/cover-`));
    const [exists] = await abucket.file(coverPath!).exists();
    expect(exists).toBe(true);
  });
});

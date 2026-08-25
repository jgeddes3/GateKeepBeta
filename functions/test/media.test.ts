import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import sharp from "sharp";
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
    const stagingPath = `staging/audio/${uid}/${profileId}/forged-track-id`;
    await uploadTestAudio(stagingPath, makeWav(2), "audio/wav", user);
    // No doc to flip — just assert nothing lands in review for that id.
    await new Promise((r) => setTimeout(r, 4000));
    const [exists] = await abucket.file(`review/tracks/${profileId}/forged-track-id.m4a`).exists();
    expect(exists).toBe(false);
    const [stagingExists] = await abucket.file(stagingPath).exists();
    expect(stagingExists).toBe(false); // forged staging object discarded too
  });
  it("ignores an upload whose object-path uid doesn't match the track doc's uploaderUid, even from a fellow member", async () => {
    const { user: userA, profileId } = await makeMusician("tx5a");
    const { user: userB, uid: uidB } = await signUpTestUser(`tx5b-${Date.now()}@test.com`);
    // B is a genuine member of the same profile — this isn't the
    // "non-member" rejection path, it's specifically the uploaderUid guard:
    // a fellow member still can't hijack another member's track slot by
    // uploading under their own uid segment into someone else's trackId.
    await adb.doc(`profiles/${profileId}/members/${uidB}`)
      .set({ uid: uidB, role: "member", label: "", joinedAt: Date.now() });
    const wav = makeWav(10);
    const { trackId } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Mismatch", startSec: 1, sizeBytes: wav.byteLength, contentType: "audio/wav" }, userA);
    const mismatchedPath = `staging/audio/${uidB}/${profileId}/${trackId}`;
    await uploadTestAudio(mismatchedPath, wav, "audio/wav", userB);
    await new Promise((r) => setTimeout(r, 4000));
    const doc = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(doc.data()?.status).toBe("processing");
    const [stagingExists] = await abucket.file(mismatchedPath).exists();
    expect(stagingExists).toBe(false);
    const [reviewExists] = await abucket.file(`review/tracks/${profileId}/${trackId}.m4a`).exists();
    expect(reviewExists).toBe(false);
  });
  it("holds the delete-during-transcode invariant: no review or staging object survives a track doc deleted immediately after upload", async () => {
    const { user, profileId } = await makeMusician("tx6");
    const wav = makeWav(20);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Race", startSec: 2, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    // Delete the track doc immediately — this races the trigger under
    // either interleaving (before it even reads the doc, mid-transcode, or
    // after the review upload but before the status write). The invariant
    // under test — no review object AND no staging object ever survive —
    // must hold no matter which interleaving actually happens.
    await adb.doc(`profiles/${profileId}/tracks/${trackId}`).delete();
    const reviewPath = `review/tracks/${profileId}/${trackId}.m4a`;
    const deadline = Date.now() + 15_000;
    let reviewGone = false;
    let stagingGone = false;
    while (Date.now() < deadline && !(reviewGone && stagingGone)) {
      reviewGone = !(await abucket.file(reviewPath).exists())[0];
      stagingGone = !(await abucket.file(uploadPath).exists())[0];
      if (!(reviewGone && stagingGone)) await new Promise((r) => setTimeout(r, 500));
    }
    expect(reviewGone).toBe(true);
    expect(stagingGone).toBe(true);
  });
  it("ignores a re-upload to the same staging path after the track already reached pending_review", async () => {
    const { user, profileId } = await makeMusician("tx7");
    const wav1 = makeWav(20);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Stable", startSec: 2, sizeBytes: wav1.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav1, "audio/wav", user);
    const data = await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review", "failed"]);
    expect(data.status).toBe("pending_review");
    const reviewPath = `review/tracks/${profileId}/${trackId}.m4a`;
    const [beforeMeta] = await abucket.file(reviewPath).getMetadata();
    const beforeGeneration = beforeMeta.generation;

    // Re-upload different bytes to the same (already-consumed) staging path.
    const wav2 = makeWav(9);
    await uploadTestAudio(uploadPath, wav2, "audio/wav", user);
    await new Promise((r) => setTimeout(r, 4000));

    const after = await adb.doc(`profiles/${profileId}/tracks/${trackId}`).get();
    expect(after.data()?.status).toBe("pending_review");
    const [afterMeta] = await abucket.file(reviewPath).getMetadata();
    expect(afterMeta.generation).toBe(beforeGeneration); // review clip untouched
    const [stagingExists] = await abucket.file(uploadPath).exists();
    expect(stagingExists).toBe(false); // the re-upload is still discarded
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

  // Shared poll helper for tests that just need the eventual value of one
  // portfolio photo field.
  async function waitForPortfolioField(
    profileId: string, field: "avatarPhotoPath" | "coverPhotoPath", timeoutMs = 30_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.[field] ?? null;
      if (v) return v as string;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`portfolio.${field} not set for profile ${profileId} after ${timeoutMs}ms`);
  }

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
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
  });
  it("processes a warning-tripping-but-valid cover JPEG successfully", async () => {
    const { user, uid, profileId } = await makeMusician("ph3");
    const path = `staging/photos/${uid}/${profileId}/cover-${Date.now()}`;
    await uploadTestAudio(path, warnJpeg(), "image/jpeg", user);
    const coverPath = await waitForPortfolioField(profileId, "coverPhotoPath");
    expect(coverPath).toMatch(new RegExp(`^public/photos/${profileId}/cover-`));
    const [exists] = await abucket.file(coverPath).exists();
    expect(exists).toBe(true);
  });
  it("strips EXIF metadata from an uploaded avatar", async () => {
    const { user, uid, profileId } = await makeMusician("ph4");
    const withExifJpeg = await sharp(Buffer.from(tinyJpeg()))
      .withExif({ IFD0: { ImageDescription: "gps-ish" } })
      .jpeg()
      .toBuffer();
    const srcMeta = await sharp(withExifJpeg).metadata();
    expect(srcMeta.exif).toBeDefined(); // sanity: the fixture really does carry EXIF before upload
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, withExifJpeg, "image/jpeg", user);
    const avatarPath = await waitForPortfolioField(profileId, "avatarPhotoPath");
    const [bytes] = await abucket.file(avatarPath).download();
    const outMeta = await sharp(bytes).metadata();
    expect(outMeta.exif).toBeUndefined();
  });
  it("deletes the old public photo when a new one replaces it", async () => {
    const { user, uid, profileId } = await makeMusician("ph5");
    await uploadTestAudio(`staging/photos/${uid}/${profileId}/avatar-${Date.now()}-a`, tinyJpeg(), "image/jpeg", user);
    const firstPath = await waitForPortfolioField(profileId, "avatarPhotoPath");
    const [firstExists] = await abucket.file(firstPath).exists();
    expect(firstExists).toBe(true);

    await uploadTestAudio(`staging/photos/${uid}/${profileId}/avatar-${Date.now()}-b`, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let secondPath: string | null = null;
    while (Date.now() < deadline && !secondPath) {
      const cur = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (cur && cur !== firstPath) secondPath = cur;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(secondPath).not.toBeNull();
    const [secondExists] = await abucket.file(secondPath!).exists();
    expect(secondExists).toBe(true);
    const [firstStillExists] = await abucket.file(firstPath).exists();
    expect(firstStillExists).toBe(false); // superseded photo cleaned up
  });
  it("holds the delete-during-photo-processing invariant: no public photo survives a profile doc deleted immediately after upload", async () => {
    const { user, uid, profileId } = await makeMusician("ph6");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    // Delete only the top-level profile doc (not a full recursiveDelete) so
    // the members subcollection survives — the trigger's membership check
    // still passes regardless of timing, and the only variable under test
    // is whether profileRef.update() lands before or after this delete.
    // Races the trigger under either interleaving; the assertion below is
    // eventually-consistent (poll up to 15s) rather than a fixed sleep.
    await adb.doc(`profiles/${profileId}`).delete();
    const deadline = Date.now() + 15_000;
    let clean = false;
    while (Date.now() < deadline && !clean) {
      const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
      clean = files.length === 0;
      if (!clean) await new Promise((r) => setTimeout(r, 500));
    }
    expect(clean).toBe(true);
  });
});

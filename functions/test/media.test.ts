import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, uploadTestAudio, makeWav, waitForTrackStatus } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import sharp from "sharp";
import { MAX_CURATOR_PHOTOS, type ProfileDraftInput, type CreateTrackInput } from "@gatekeep/shared";

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

async function makeCurator(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
    { type: "curator", subtype: "venue", name: "Test Room", handle: `${prefix}_${Date.now()}` }, user);
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
    // No doc to flip, just assert nothing lands in review for that id.
    await new Promise((r) => setTimeout(r, 4000));
    const [exists] = await abucket.file(`review/tracks/${profileId}/forged-track-id.m4a`).exists();
    expect(exists).toBe(false);
    const [stagingExists] = await abucket.file(stagingPath).exists();
    expect(stagingExists).toBe(false); // forged staging object discarded too
  });
  it("ignores an upload whose object-path uid doesn't match the track doc's uploaderUid, even from a fellow member", async () => {
    const { user: userA, profileId } = await makeMusician("tx5a");
    const { user: userB, uid: uidB } = await signUpTestUser(`tx5b-${Date.now()}@test.com`);
    // B is a genuine member of the same profile, this isn't the
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
    // Delete the track doc immediately, this races the trigger under
    // either interleaving (before it even reads the doc, mid-transcode, or
    // after the review upload but before the status write). The invariant
    // under test, no review object AND no staging object ever survive,
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
  // Same 1x1 image, 3 bytes longer, decodes fine but trips libjpeg's
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

  it("processes an avatar into public/photos, updates the profile doc, and upscales a tiny source to exactly 512x512", async () => {
    const { user, uid, profileId } = await makeMusician("ph1");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    // tinyJpeg is a 1x1 source, this doubles as the small-source case:
    // avatars deliberately upscale (no withoutEnlargement) because 512x512
    // is a fixed-size contract the rest of the app relies on.
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user); // same uploader helper works for any bytes
    const deadline = Date.now() + 30_000;
    let avatarPath: string | null = null;
    while (Date.now() < deadline && !avatarPath) {
      avatarPath = (await adb.doc(`profiles/${profileId}`).get()).data()?.portfolio?.avatarPhotoPath ?? null;
      if (!avatarPath) await new Promise((r) => setTimeout(r, 500));
    }
    expect(avatarPath).toMatch(new RegExp(`^public/photos/${profileId}/avatar-`));
    const [bytes] = await abucket.file(avatarPath!).download();
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
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
  it("rejects a disallowed image format (GIF), nothing is written to public/, staging is still cleaned up, portfolio untouched", async () => {
    const { user, uid, profileId } = await makeMusician("ph7");
    // storage.rules only checks the client-DECLARED contentType metadata
    // ('image/(jpeg|png|webp)'), it never inspects the actual bytes, so
    // "image/gif" bytes alone would be rejected at the rules layer before
    // ever reaching this trigger. The real attack (and what media.ts's
    // format allowlist must catch) is a spoofed declared type: real GIF
    // bytes uploaded claiming to be "image/jpeg", which sails past
    // storage.rules and lands here for sharp to actually decode.
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .gif().toBuffer();
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, gif, "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true); // finally still cleans up staging
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull(); // profile doc untouched
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0); // nothing written to public/
  });
  it("handles a corrupt/undecodable photo upload without throwing, staging still cleaned up, nothing written to public/, portfolio untouched", async () => {
    const { user, uid, profileId } = await makeMusician("ph7b");
    // Unlike the disallowed-format GIF above (which sharp decodes just
    // fine, the rejection is this app's OWN allowlist), this buffer isn't a
    // real image at all: sharp's .metadata() throws trying to read it. Task
    // 14 hardening for a pre-existing SP2 bug (found live in Task 9's
    // walkthrough) where that throw used to escape processPhoto unhandled
    // instead of being discarded like every other rejection path here.
    const garbage = Buffer.from("not an image, just garbage bytes".repeat(20));
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, garbage, "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true); // finally still cleans up staging, trigger never throws
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull(); // profile doc untouched
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0); // nothing written to public/
  });
  it("still accepts valid PNG and WebP avatars (the allowlist, not just JPEG)", async () => {
    const { user, uid, profileId } = await makeMusician("ph8");
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .png().toBuffer();
    await uploadTestAudio(`staging/photos/${uid}/${profileId}/avatar-${Date.now()}-png`, png, "image/png", user);
    const avatarPath = await waitForPortfolioField(profileId, "avatarPhotoPath");
    const [bytes] = await abucket.file(avatarPath).download();
    expect((await sharp(bytes).metadata()).format).toBe("jpeg"); // pipeline always re-encodes to jpeg

    const { uid: uid2, profileId: profileId2, user: user2 } = await makeMusician("ph8b");
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 7, g: 8, b: 9 } } })
      .webp().toBuffer();
    await uploadTestAudio(`staging/photos/${uid2}/${profileId2}/cover-${Date.now()}-webp`, webp, "image/webp", user2);
    const coverPath = await waitForPortfolioField(profileId2, "coverPhotoPath");
    const [exists] = await abucket.file(coverPath).exists();
    expect(exists).toBe(true);
  });
  it("holds the delete-during-photo-processing invariant: no public photo survives a profile doc deleted before the upload lands", async () => {
    const { user, uid, profileId } = await makeMusician("ph6");
    // Delete only the top-level profile doc (not a full recursiveDelete) so
    // the members subcollection survives, the trigger's membership check
    // still passes. Deleting BEFORE the upload (rather than racing it
    // afterward) makes profileRef.update() deterministically hit a missing
    // doc every run, instead of depending on upload/trigger timing: an
    // earlier version of this test deleted after uploading and asserted
    // public/photos/{profileId}/ was empty via a poll, that's vacuously
    // true at iteration 0 (nothing has been written yet) and would have
    // gone undetected as a false pass if the trigger ever won the race.
    await adb.doc(`profiles/${profileId}`).delete();
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    // Poll until staging is gone, that's the trigger's finally block
    // running, proof the whole pipeline (including the post-write cleanup)
    // has actually completed, not just that nothing has happened yet.
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true);
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
  });
});

describe("processUpload: curator gallery photos", () => {
  const tinyJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));

  async function waitForGalleryLength(profileId: string, length: number, timeoutMs = 30_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const paths = ((await adb.doc(`profiles/${profileId}`).get()).data()?.curator?.photoPaths
        ?? []) as string[];
      if (paths.length >= length) return paths;
      if (Date.now() > deadline) {
        throw new Error(`curator.photoPaths never reached length ${length} for ${profileId} (stuck at ${paths.length})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it("processes a gallery photo into public/photos and appends it to curator.photoPaths", async () => {
    const { user, uid, profileId } = await makeCurator("g1");
    const path = `staging/photos/${uid}/${profileId}/gallery-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const paths = await waitForGalleryLength(profileId, 1);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(new RegExp(`^public/photos/${profileId}/gallery-`));
    const [exists] = await abucket.file(paths[0]).exists();
    expect(exists).toBe(true);
  });

  it("a second gallery upload appends alongside the first, additive, not overwrite", async () => {
    const { user, uid, profileId } = await makeCurator("g2");
    await uploadTestAudio(`staging/photos/${uid}/${profileId}/gallery-${Date.now()}-a`, tinyJpeg(), "image/jpeg", user);
    await waitForGalleryLength(profileId, 1);
    await uploadTestAudio(`staging/photos/${uid}/${profileId}/gallery-${Date.now()}-b`, tinyJpeg(), "image/jpeg", user);
    const paths = await waitForGalleryLength(profileId, 2);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2); // two distinct objects, both still present
    for (const p of paths) {
      const [exists] = await abucket.file(p).exists();
      expect(exists).toBe(true);
    }
  });

  it("rejects a gallery upload aimed at a musician profile, no destination field for it", async () => {
    const { user, uid, profileId } = await makeMusician("g3");
    const path = `staging/photos/${uid}/${profileId}/gallery-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true); // finally still cleans up staging
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
    expect(p.data()?.portfolio?.coverPhotoPath ?? null).toBeNull();
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0); // nothing written to public/
  });

  it("rejects an avatar upload aimed at a curator profile, curators have no single-slot photo fields", async () => {
    const { user, uid, profileId } = await makeCurator("g4");
    const path = `staging/photos/${uid}/${profileId}/avatar-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator?.photoPaths ?? []).toHaveLength(0);
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
  });

  it("caps the gallery at MAX_CURATOR_PHOTOS entries, an upload past the cap is discarded, not appended", async () => {
    const { user, uid, profileId } = await makeCurator("g5");
    expect(MAX_CURATOR_PHOTOS).toBe(12);
    const seeded = Array.from({ length: MAX_CURATOR_PHOTOS }, (_, i) => `public/photos/${profileId}/gallery-seed-${i}`);
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": seeded });
    const path = `staging/photos/${uid}/${profileId}/gallery-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true); // finally still cleans up staging
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator?.photoPaths).toEqual(seeded); // unchanged, still exactly the 12 seeded entries
    // The rejected upload's own processed object (a real GCS write, unlike
    // the fake seeded Firestore-only entries above) must have been cleaned
    // up rather than left as an orphan.
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/gallery-` });
    expect(files).toHaveLength(0);
  });
});

// SP6 Task 4 (carried Task 1 finding): "poster" is a curator-side kind too,
// processed the same way as gallery (bounded 1600x1600, no upscale), but
// unlike gallery it has NO Firestore destination of its own here: createEvent/
// updateEvent are the ones that persist the resulting path, as EventDoc.posterPath.
describe("processUpload: curator poster photos", () => {
  const tinyJpeg = () => Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));

  it("processes a poster into public/photos, writes posterUploads/{uid}/uploads/{nonce}, and touches no profile field", async () => {
    const { user, uid, profileId } = await makeCurator("p1");
    const nonce = `${Date.now()}`;
    const path = `staging/photos/${uid}/${profileId}/poster-${nonce}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let files: { name: string }[] = [];
    while (Date.now() < deadline && files.length === 0) {
      [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/poster-` });
      if (files.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(files).toHaveLength(1);

    // SP10 Task 19: the processed path is handed to the client through a
    // doc it can watch (rules: owner read only).
    const uploadRef = adb.doc(`posterUploads/${uid}/uploads/${nonce}`);
    let uploadDoc = (await uploadRef.get()).data();
    while (Date.now() < deadline && !uploadDoc) {
      await new Promise((r) => setTimeout(r, 500));
      uploadDoc = (await uploadRef.get()).data();
    }
    expect(uploadDoc?.path).toBe(files[0].name);
    expect(uploadDoc?.createdAt).toBeTypeOf("number");

    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator?.photoPaths ?? []).toHaveLength(0);
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
  });

  it("rejects a poster upload aimed at a musician profile", async () => {
    const { user, uid, profileId } = await makeMusician("p2");
    const path = `staging/photos/${uid}/${profileId}/poster-${Date.now()}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let stagingGone = false;
    while (Date.now() < deadline && !stagingGone) {
      stagingGone = !(await abucket.file(path).exists())[0];
      if (!stagingGone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(stagingGone).toBe(true); // finally still cleans up staging
    const [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/` });
    expect(files).toHaveLength(0);
  });
});

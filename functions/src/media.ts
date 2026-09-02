import { onObjectFinalized, type StorageEvent } from "firebase-functions/v2/storage";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import {
  reviewTrackPath, publicPhotoPath, isValidDocId, MAX_CLIP_SECONDS, MAX_CURATOR_PHOTOS,
} from "@gatekeep/shared";
import { STORAGE_BUCKET, bucket, logDeleteFailure } from "./storage.js";

const run = promisify(execFile);

// A subprocess run against untrusted input (ffprobe/ffmpeg on a user-supplied
// file) that never returns would otherwise tie up the trigger until the
// 300s function timeout kills it mid-cleanup, leaving the track stuck in
// "processing" with no failureReason. Bounding it converts a hang into a
// clean "failed" status well before that cap.
const SUBPROCESS_TIMEOUT_MS = 120_000;

// ffmpeg-static's own types/index.d.ts declares `export default: string | null`,
// but under this package's NodeNext + "type":"module" setup TS resolves the
// default import as the whole CJS module namespace instead (a known
// ffmpeg-static/NodeNext interop quirk), the runtime value is still the raw
// string (or null) per Node's CJS/ESM interop, so assert the real type here
// rather than trust the inferred one.
const ffmpegPath = ffmpegPathRaw as unknown as string | null;

// Thrown only for conditions with a controlled, safe-to-display message (no
// file paths, no ffmpeg/ffprobe stderr), every other error in processAudio
// collapses to a generic failureReason so raw error text (which can carry
// local tmp paths or 100KB+ of subprocess stderr) never lands in a
// member-readable track doc.
class ClipValidationError extends Error {} // bad input from the musician (the clip window)
class ServerConfigError extends Error {}   // this deployment is broken, not the musician's upload

// ffmpeg-static's default export is `string | null`, null when the package
// has no prebuilt binary for this platform/arch. Fail loudly (and only) at
// first use, inside processAudio's try/catch, so a missing binary surfaces
// as a normal "failed" track rather than crashing every export in this
// module at deploy time. Thrown as ServerConfigError (not
// ClipValidationError): this is a deployment problem, not something wrong
// with the musician's upload, so it gets its own safe, accurate message
// instead of collapsing into the generic "file may be corrupt" reason.
function requireFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new ServerConfigError("Audio processing is temporarily unavailable. Try again later.");
  }
  return ffmpegPath;
}

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run(ffprobe.path, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { timeout: SUBPROCESS_TIMEOUT_MS });
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not read audio duration.");
  return d;
}

// generation is typed number in firebase-functions but arrives as a string at
// runtime (GCS serializes int64 as JSON string), accept both, coerce at use.
async function processAudio(objectName: string, generation: string | number): Promise<void> {
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });

  // staging/audio/{uid}/{profileId}/{trackId}, validated defensively (not
  // just trusted from storage.rules) before any of it is used to build
  // Firestore paths.
  const segments = objectName.split("/");
  const [, , uid, profileId, trackId] = segments;
  if (segments.length !== 5 || !isValidDocId(uid) || !isValidDocId(profileId) || !isValidDocId(trackId)) {
    await stagingFile.delete().catch(logDeleteFailure("processUpload", "malformed staging audio path", objectName));
    return;
  }

  const db = getFirestore();
  const trackRef = db.doc(`profiles/${profileId}/tracks/${trackId}`);

  // tmp/uploadedReviewPath are declared here (not inside the try) so the
  // shared finally below can always see them. The try now starts BEFORE the
  // Firestore guard read: a throwing read (network blip, emulator hiccup)
  // previously skipped the finally entirely and leaked the staging object
  // forever, now any exception from this point on still runs the cleanup.
  let tmp: string | null = null;
  let uploadedReviewPath: string | null = null;
  try {
    const snap = await trackRef.get();
    const data = snap.data();
    // Forged/mismatched uploads (no doc, wrong uploader, wrong state, or a
    // malformed startSec): discard the object and do nothing, createTrack
    // is the only path that arms this pipeline, and it always writes a
    // numeric startSec, so a non-number here means a corrupt/tampered doc,
    // not a real in-flight upload worth reporting back to the musician.
    if (!snap.exists || data?.uploaderUid !== uid || data?.status !== "processing"
        || typeof data?.startSec !== "number") {
      return;
    }
    const startSec = data.startSec;

    tmp = await mkdtemp(join(tmpdir(), "gk-audio-"));
    const inFile = join(tmp, "in");
    const outFile = join(tmp, "out.m4a");
    try {
      await stagingFile.download({ destination: inFile });
    } catch (err) {
      // NOTE: this is a STORAGE error, @google-cloud/storage ApiError carries
      // HTTP codes (404), unlike the Firestore gRPC code 5 checked elsewhere
      // in this file. Do not "fix" this back to 5.
      if ((err as { code?: number }).code === 404) {
        // Generation-pinned reads 404 only when the object no longer
        // exists, and the only thing that ever deletes a staging/audio
        // object is this trigger itself (storage.rules makes staging
        // deletes trigger-only). A 404 here means a prior/duplicate
        // delivery of this same event already consumed and cleaned up
        // this exact generation, Cloud Functions storage triggers are
        // at-least-once, so a second delivery racing (or arriving after)
        // the first is expected, not an error. Writing "failed" here would
        // risk clobbering whatever terminal status that other invocation
        // already reached (or is about to reach), so just log and stop,
        // no track-doc write at all.
        console.error("processUpload: staging object already consumed by another delivery", objectName, err);
        return;
      }
      throw err;
    }
    const sourceDuration = await probeDurationSec(inFile);
    if (startSec >= sourceDuration) {
      throw new ClipValidationError(
        `Clip start (${startSec}s) is past the end of the audio (${Math.floor(sourceDuration)}s).`);
    }
    if (sourceDuration - startSec < 1) {
      throw new ClipValidationError("Clip window is too close to the end of the audio.");
    }
    // -ss before -i = fast seek to the clip start. -t here is an INPUT
    // option (it precedes -i, so it bounds how much of the input is read
    // from that seek point) rather than an output duration cap, for a
    // straight single-stream re-encode like this the practical effect is
    // the same either way: the clip tops out at MAX_CLIP_SECONDS. -map
    // 0:a:0 pins the first audio stream explicitly (some containers carry
    // embedded cover art as a "video" stream ffmpeg would otherwise try to
    // touch). AAC 128k in an mp4 container streams natively everywhere.
    await run(requireFfmpegPath(), [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(startSec), "-t", String(MAX_CLIP_SECONDS), "-i", inFile,
      "-vn", "-map", "0:a:0", "-acodec", "aac", "-b:a", "128k", "-movflags", "+faststart",
      outFile,
    ], { timeout: SUBPROCESS_TIMEOUT_MS });
    const clipDuration = await probeDurationSec(outFile);
    const destPath = reviewTrackPath(profileId, trackId);
    await bucket().upload(outFile, { destination: destPath, metadata: { contentType: "audio/mp4" } });
    uploadedReviewPath = destPath;

    // A transcode can take several seconds, long enough for deleteTrack to
    // race it and remove the doc mid-flight. Re-read before writing
    // pending_review; if the doc is gone or someone else already moved it
    // off "processing" (e.g. deleteTrack ran), the upload above is now
    // orphaned, delete it and bail without writing. This narrows the race
    // to the few milliseconds between this read and the update() below,
    // not closes it outright; any residual orphan in that window is reaped
    // by deleteTrack's/deleteProfile's own best-effort storage cleanup.
    const postSnap = await trackRef.get();
    if (!postSnap.exists || postSnap.data()?.status !== "processing") {
      await bucket().file(destPath).delete().catch(logDeleteFailure("processUpload", "orphaned review (race)", destPath));
      return;
    }

    await trackRef.update({
      status: "pending_review",
      durationSec: Math.round(clipDuration * 10) / 10,
      storagePath: destPath,
      failureReason: null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error("processUpload: audio processing failed", objectName, e);
    const failureReason = (e instanceof ClipValidationError || e instanceof ServerConfigError
      ? e.message
      : "Audio processing failed: the file may be corrupt or unsupported."
    ).slice(0, 500);
    if (uploadedReviewPath) {
      await bucket().file(uploadedReviewPath).delete()
        .catch(logDeleteFailure("processUpload", "orphaned review (failed after upload)", uploadedReviewPath));
    }
    try {
      // Same status guard as the success path above: only write "failed" if
      // the doc is still there and still "processing", never blindly
      // overwrite a doc that deleteTrack (or a second trigger invocation)
      // already moved on from.
      const failSnap = await trackRef.get();
      if (failSnap.exists && failSnap.data()?.status === "processing") {
        await trackRef.update({ status: "failed", failureReason, updatedAt: Date.now() });
      }
    } catch (err) {
      // gRPC code 5 (NOT_FOUND): the doc vanished between the guard-read
      // above and this update, expected under the same delete race,
      // nothing to log. Anything else is unexpected; log it but still
      // swallow rather than rethrow, storage-trigger retry is off, so
      // rethrowing here buys nothing and would just strand the doc in
      // "processing" forever with staging already deleted.
      if ((err as { code?: number }).code !== 5) {
        console.error("processUpload: failed-status write failed", objectName, err);
      }
    }
  } finally {
    await stagingFile.delete().catch(logDeleteFailure("processUpload", "staging (audio, finally)", objectName));
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

// Mirrors storage.rules' staging/photos filename pattern, validated here
// too (not just trusted from the rules) before it's used to pick a Firestore
// field or an output path. "gallery" is the curator equivalent of
// avatar/cover (see storagePaths.ts's PhotoKind and the kind/type gating
// below). "poster" (SP6) is a curator-profile upload too, a single-photo
// slot on an EventDoc rather than an array/field on the profile itself, so
// it's processed like gallery but has no profile-doc write of its own (see
// the kind === "poster" branch below).
const PHOTO_FILENAME_RE = /^(avatar|cover|gallery|poster)-[A-Za-z0-9-]{1,80}$/;

async function processPhoto(objectName: string, generation: string | number): Promise<void> {
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });

  // staging/photos/{uid}/{profileId}/{kind}-{nonce}
  const segments = objectName.split("/");
  const [, , uid, profileId, fileName] = segments;
  const nameMatch = typeof fileName === "string" ? PHOTO_FILENAME_RE.exec(fileName) : null;
  if (segments.length !== 5 || !isValidDocId(uid) || !isValidDocId(profileId) || !nameMatch) {
    await stagingFile.delete().catch(logDeleteFailure("processUpload", "malformed staging photo path", objectName));
    return;
  }
  const kind = nameMatch[1] as "avatar" | "cover" | "gallery" | "poster";
  const db = getFirestore();
  const profileRef = db.doc(`profiles/${profileId}`);

  try {
    // Membership is derived from the OBJECT PATH's {uid}/{profileId}
    // segments, never from object.metadata (client-controlled and
    // untrusted, see storage.rules' note on staging paths). The read is
    // inside this try/finally (not before it) so a throwing read still
    // triggers the staging cleanup below, instead of leaking the object.
    const member = await db.doc(`profiles/${profileId}/members/${uid}`).get();
    if (!member.exists) {
      return; // non-member or malformed: discard, no further processing
    }

    // Each kind belongs to exactly one profile type's destination model:
    // avatar/cover are the musician portfolio's two single-photo slots;
    // gallery is the curator profile's append-only curator.photoPaths array;
    // poster (SP6) is also curator-side, uploaded against the curator
    // PROFILE, but it has no Firestore destination of its own here (see
    // below): createEvent/updateEvent take the processed path directly as
    // posterPath once the curator has it. Neither model has a field for the
    // other type's kind (CuratorDetails has no avatarPhotoPath/
    // coverPhotoPath, PortfolioData has no photoPaths), so a mismatched
    // kind/type pairing (forged, or a stale client pointed at the wrong
    // profile type) is discarded the same way a non-member upload is
    // above: nothing to write it into.
    const profileType = (await profileRef.get()).data()?.type;
    if ((kind === "avatar" || kind === "cover") && profileType !== "musician") return;
    if ((kind === "gallery" || kind === "poster") && profileType !== "curator") return;

    const [bytes] = await stagingFile.download();
    // Re-encode via sharp: strips EXIF (GPS!) and bounds dimensions.
    // failOn: "error" (sharp's default is "warning", the strictest level),
    // real-world phone/app JPEG encoders commonly emit warning-level defects
    // (e.g. libjpeg's "extraneous bytes before marker") on otherwise-valid
    // photos; the default "warning" level would reject those uploads.
    // "error" still rejects truncated/genuinely corrupt data, just not mere
    // warnings. limitInputPixels bounds decompression-bomb-style inputs.
    const sharpOpts = { failOn: "error" as const, limitInputPixels: 50_000_000 };

    // The whole decode/resize/encode step is wrapped in its own try/catch:
    // genuinely corrupt/undecodable bytes (not just an allowlist mismatch,
    // sharp can't even read metadata off them) throw from .metadata() or
    // .toBuffer() rather than returning a recognizable format string. Pre-
    // existing SP2 bug (found live in Task 9's walkthrough): that throw used
    // to propagate unhandled out of the trigger instead of being discarded
    // the same way every other rejection path in this function is (log +
    // return, staging cleanup left to the shared `finally` below), there's
    // no per-photo "failed" status doc to write (unlike processAudio's
    // tracks), so silent discard-with-log IS this pipeline's existing
    // failure style.
    let jpeg: Buffer;
    try {
      // Format allowlist: sharp/libvips happily decodes SVG (an XML format
      // with real parser/XXE-class attack surface), GIF, TIFF, and HEIF too,
      // none of that is gated by the staging upload's declared contentType,
      // which storage.rules only checks against the client-set Content-Type
      // header, not the actual bytes (trivially spoofable, upload arbitrary
      // bytes with `contentType: "image/jpeg"`). Probe the real decoded
      // format before running attacker-controlled bytes through the full
      // resize/encode pipeline below, and refuse anything outside the three
      // formats this app actually intends to accept.
      const { format } = await sharp(bytes, sharpOpts).metadata();
      if (!["jpeg", "png", "webp"].includes(format ?? "")) {
        console.error("processUpload: rejected disallowed photo format", objectName, format);
        return; // finally below still deletes the staging object
      }

      // Avatars intentionally do NOT set withoutEnlargement, the 512x512
      // output is a contract the rest of the app relies on (fixed-size crop
      // targets), so a tiny source still gets upscaled to fill it. Covers and
      // gallery photos both use withoutEnlargement since they're display-only
      // and any size up to 1600x1600 is fine, a gallery photo is just a
      // repeatable cover, sized identically.
      const pipeline = kind === "avatar"
        ? sharp(bytes, sharpOpts).rotate().resize(512, 512, { fit: "cover" })
        : sharp(bytes, sharpOpts).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
      jpeg = await pipeline.jpeg({ quality: 82 }).toBuffer();
    } catch (err) {
      console.error("processUpload: corrupt/undecodable photo upload", objectName, err);
      return; // finally below still deletes the staging object
    }
    const destPath = publicPhotoPath(profileId, kind, randomUUID());
    await bucket().file(destPath).save(jpeg, { contentType: "image/jpeg" });

    if (kind === "gallery") {
      // Append-with-cap, transactional: unlike avatar/cover's single-slot
      // overwrite (read-prev-then-write, an accepted narrow race elsewhere
      // in this function), a gallery upload is ADDITIVE, concurrent
      // uploads must not both read "11 photos" and both append past the
      // MAX_CURATOR_PHOTOS cap. The transaction makes the length check and
      // the append atomic.
      const outcome = await db.runTransaction<"ok" | "cap" | "gone">(async (tx) => {
        const snap = await tx.get(profileRef);
        if (!snap.exists) return "gone";
        const current = (snap.data()?.curator?.photoPaths as string[] | undefined) ?? [];
        if (current.length >= MAX_CURATOR_PHOTOS) return "cap";
        tx.update(profileRef, {
          "curator.photoPaths": FieldValue.arrayUnion(destPath),
          updatedAt: Date.now(),
        });
        return "ok";
      });
      if (outcome !== "ok") {
        // "cap": resource-exhausted-equivalent, mirrors the disallowed-format
        // branch above (console.error + discard, no client-visible error:
        // this is an async trigger, not a callable). "gone": profile deleted
        // mid-flight (deleteProfile's recursiveDelete racing this trigger),
        // same as the avatar/cover orphan-cleanup case below, no live doc
        // to append to any more.
        if (outcome === "cap") {
          console.error("processUpload: curator gallery photo rejected, MAX_CURATOR_PHOTOS reached", objectName);
        }
        await bucket().file(destPath).delete()
          .catch(logDeleteFailure("processUpload",
            outcome === "cap" ? "gallery cap reached" : "orphaned public gallery photo (profile gone)", destPath));
      }
      return;
    }

    if (kind === "poster") {
      // No Firestore write here at all: a poster has no destination field
      // on the profile doc (it isn't the profile's own photo). The curator
      // passes this processed destPath straight back to createEvent/
      // updateEvent as posterPath once the upload finishes; those callables
      // are the ones that persist it, on an EventDoc, after their own
      // string-prefix ownership check against it.
      return;
    }

    const field = kind === "avatar" ? "portfolio.avatarPhotoPath" : "portfolio.coverPhotoPath";
    const prev = (await profileRef.get()).data()?.portfolio?.[`${kind}PhotoPath`] as string | null | undefined;
    try {
      await profileRef.update({ [field]: destPath, updatedAt: Date.now() });
    } catch (err) {
      // Profile can be deleted mid-flight too (deleteProfile's
      // recursiveDelete races this trigger), gRPC code 5 (NOT_FOUND).
      // There's no live doc to point at destPath any more, so the
      // freshly-written public object would otherwise survive as an orphan
      // even after the profile is gone; clean it up regardless of the
      // error's cause. Same swallow-not-rethrow reasoning as the audio
      // failure path, only log when the cause wasn't the expected
      // "doc is gone" case.
      await bucket().file(destPath).delete().catch(logDeleteFailure("processUpload", "orphaned public photo", destPath));
      if ((err as { code?: number }).code !== 5) {
        console.error("processUpload: profile photo update failed", objectName, err);
      }
      return;
    }
    if (prev) {
      await bucket().file(prev).delete().catch(logDeleteFailure("processUpload", "old photo", prev));
    }
  } finally {
    await stagingFile.delete().catch(logDeleteFailure("processUpload", "staging (photo, finally)", objectName));
  }
}

export const processUpload = onObjectFinalized(
  { region: "us-central1", bucket: STORAGE_BUCKET, memory: "1GiB", timeoutSeconds: 300 },
  async (event: StorageEvent) => {
    const name = event.data.name ?? "";
    const generation = event.data.generation;
    if (name.startsWith("staging/audio/")) return processAudio(name, generation);
    if (name.startsWith("staging/photos/")) return processPhoto(name, generation);
  });

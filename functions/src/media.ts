import { onObjectFinalized, type StorageEvent } from "firebase-functions/v2/storage";
import { getFirestore } from "firebase-admin/firestore";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import { reviewTrackPath, publicPhotoPath, MAX_CLIP_SECONDS } from "@gatekeep/shared";
import { STORAGE_BUCKET, bucket } from "./storage.js";

const run = promisify(execFile);

// ffmpeg-static's own types/index.d.ts declares `export default: string | null`,
// but under this package's NodeNext + "type":"module" setup TS resolves the
// default import as the whole CJS module namespace instead (a known
// ffmpeg-static/NodeNext interop quirk) — the runtime value is still the raw
// string (or null) per Node's CJS/ESM interop, so assert the real type here
// rather than trust the inferred one.
const ffmpegPath = ffmpegPathRaw as unknown as string | null;

// ffmpeg-static's default export is `string | null` — null when the package
// has no prebuilt binary for this platform/arch. Fail loudly (and only) at
// first use, inside processAudio's try/catch, so a missing binary surfaces
// as a normal "failed" track with a clear reason instead of crashing every
// export in this module at deploy time.
function requireFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not resolve a binary for this platform/architecture.");
  }
  return ffmpegPath;
}

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run(ffprobe.path, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not read audio duration.");
  return d;
}

// generation is typed number in firebase-functions but arrives as a string at
// runtime (GCS serializes int64 as JSON string) — accept both, coerce at use.
async function processAudio(objectName: string, generation: string | number): Promise<void> {
  // staging/audio/{uid}/{profileId}/{trackId}
  const [, , uid, profileId, trackId] = objectName.split("/");
  if (!uid || !profileId || !trackId) return;
  const db = getFirestore();
  const trackRef = db.doc(`profiles/${profileId}/tracks/${trackId}`);
  const snap = await trackRef.get();
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });
  // Forged/mismatched uploads (no doc, wrong uploader, wrong state): discard the
  // object and do nothing — createTrack is the only path that arms this pipeline.
  if (!snap.exists || snap.data()?.uploaderUid !== uid || snap.data()?.status !== "processing") {
    await stagingFile.delete().catch(() => {});
    return;
  }
  const startSec = snap.data()?.startSec as number;

  const tmp = await mkdtemp(join(tmpdir(), "gk-audio-"));
  try {
    const inFile = join(tmp, "in");
    const outFile = join(tmp, "out.m4a");
    await stagingFile.download({ destination: inFile });
    const sourceDuration = await probeDurationSec(inFile);
    if (startSec >= sourceDuration) {
      throw new Error(`Clip start (${startSec}s) is past the end of the audio (${Math.floor(sourceDuration)}s).`);
    }
    // -ss before -i = fast seek; -t caps the clip at 30s; AAC 128k in an mp4
    // container streams natively in every target player.
    await run(requireFfmpegPath(), [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(startSec), "-t", String(MAX_CLIP_SECONDS), "-i", inFile,
      "-vn", "-acodec", "aac", "-b:a", "128k", "-movflags", "+faststart",
      outFile,
    ]);
    const clipDuration = await probeDurationSec(outFile);
    const destPath = reviewTrackPath(profileId, trackId);
    await bucket().upload(outFile, { destination: destPath, metadata: { contentType: "audio/mp4" } });

    // A transcode can take several seconds — long enough for deleteTrack to
    // race it and remove the doc mid-flight. Re-read before writing
    // pending_review; if the doc is gone or someone else already moved it
    // off "processing" (e.g. deleteTrack ran), the upload above is now
    // orphaned — delete it and bail without writing.
    const postSnap = await trackRef.get();
    if (!postSnap.exists || postSnap.data()?.status !== "processing") {
      await bucket().file(destPath).delete().catch(() => {});
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
    const failureReason = e instanceof Error ? e.message : "Audio processing failed.";
    try {
      await trackRef.update({ status: "failed", failureReason, updatedAt: Date.now() });
    } catch (err) {
      // The doc can be gone here too (deleteTrack raced the failure path, not
      // just the success path). update() then throws NOT_FOUND (gRPC code 5,
      // same mapping as updateTrack in tracks.ts) — swallow only that code;
      // anything else is a real error and must not be silently dropped.
      if ((err as { code?: number }).code !== 5) throw err;
    }
  } finally {
    await stagingFile.delete().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
}

async function processPhoto(objectName: string, generation: string | number): Promise<void> {
  // staging/photos/{uid}/{profileId}/{kind}-{nonce}
  const [, , uid, profileId, fileName] = objectName.split("/");
  if (!uid || !profileId || !fileName) return;
  const kind = fileName.startsWith("avatar-") ? "avatar" : fileName.startsWith("cover-") ? "cover" : null;
  const db = getFirestore();
  // pin the generation: retry overwrites must not race an in-flight transcode of older bytes
  const stagingFile = bucket().file(objectName, { generation: Number(generation) });
  // Membership is derived from the OBJECT PATH's {uid}/{profileId} segments,
  // never from object.metadata (client-controlled and untrusted — see
  // storage.rules' note on staging paths).
  const member = kind ? await db.doc(`profiles/${profileId}/members/${uid}`).get() : null;
  if (!kind || !member?.exists) {
    await stagingFile.delete().catch(() => {}); // non-member or malformed: discard
    return;
  }
  try {
    const [bytes] = await stagingFile.download();
    // Re-encode via sharp: strips EXIF (GPS!) and bounds dimensions.
    // failOn: "error" (sharp's default is "warning", the strictest level) —
    // real-world phone/app JPEG encoders routinely emit spec-noncompliant but
    // harmless warnings (e.g. libjpeg's "extraneous bytes before marker");
    // rejecting on any warning would bounce legitimate uploads. "error" still
    // rejects truncated/genuinely corrupt data, just not benign warnings.
    const sharpOpts = { failOn: "error" as const };
    const pipeline = kind === "avatar"
      ? sharp(bytes, sharpOpts).rotate().resize(512, 512, { fit: "cover" })
      : sharp(bytes, sharpOpts).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
    const jpeg = await pipeline.jpeg({ quality: 82 }).toBuffer();
    const destPath = publicPhotoPath(profileId, kind, randomUUID());
    await bucket().file(destPath).save(jpeg, { contentType: "image/jpeg" });

    const profileRef = db.doc(`profiles/${profileId}`);
    const field = kind === "avatar" ? "portfolio.avatarPhotoPath" : "portfolio.coverPhotoPath";
    const prev = (await profileRef.get()).data()?.portfolio?.[`${kind}PhotoPath`] as string | null | undefined;
    await profileRef.update({ [field]: destPath, updatedAt: Date.now() });
    if (prev) await bucket().file(prev).delete().catch(() => {});
  } finally {
    await stagingFile.delete().catch(() => {});
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

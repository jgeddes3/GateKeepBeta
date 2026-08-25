import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, stagingAudioPath, reviewTrackPath, publicTrackPath, MAX_TRACKS,
  type CreateTrackInput, type TrackDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";
import { bucket } from "./storage.js";

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count.
const ACTIVE_TRACK_STATUSES = ["processing", "pending_review", "approved"] as const;

export const createTrack = onCall<CreateTrackInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateTrackCreate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);

  const db = getFirestore();
  const tracksCol = db.collection(`profiles/${input.profileId}/tracks`);
  const trackRef = tracksCol.doc();
  await db.runTransaction(async (tx) => {
    const active = await tx.get(tracksCol.where("status", "in", [...ACTIVE_TRACK_STATUSES]));
    if (active.size >= MAX_TRACKS) {
      throw new HttpsError("resource-exhausted",
        `Portfolios hold at most ${MAX_TRACKS} tracks — delete one first.`);
    }
    const now = Date.now();
    const doc: TrackDoc = {
      title: input.title.trim(), status: "processing", uploaderUid: uid,
      startSec: input.startSec, durationSec: null, storagePath: null,
      rejectionReason: null, failureReason: null, order: active.size,
      createdAt: now, updatedAt: now,
    };
    tx.set(trackRef, doc);
  });
  return { trackId: trackRef.id, uploadPath: stagingAudioPath(uid, input.profileId, trackRef.id) };
});

export const updateTrack = onCall<{ profileId: string; trackId: string; title?: string; order?: number }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, trackId, title, order } = req.data;
    if (typeof profileId !== "string" || typeof trackId !== "string") {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    if (title === undefined && order === undefined) {
      throw new HttpsError("invalid-argument", "Nothing to update.");
    }
    if (title !== undefined && (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 80)) {
      throw new HttpsError("invalid-argument", "Track titles are 1-80 characters.");
    }
    if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 100)) {
      throw new HttpsError("invalid-argument", "Invalid order.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (title !== undefined) updates.title = title.trim();
    if (order !== undefined) updates.order = order;
    await ref.update(updates);
    return { ok: true };
  });

export const deleteTrack = onCall<{ profileId: string; trackId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, trackId } = req.data;
    if (typeof profileId !== "string" || typeof trackId !== "string") {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    // Storage cleanup is best-effort: the doc is the source of truth, and the
    // objects are unreachable once it's gone (public path is only listed via docs).
    await Promise.allSettled([
      bucket().file(reviewTrackPath(profileId, trackId)).delete(),
      bucket().file(publicTrackPath(profileId, trackId)).delete(),
    ]);
    await ref.delete();
    return { ok: true };
  });

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, isValidDocId, stagingAudioPath, reviewTrackPath, publicTrackPath, MAX_TRACKS,
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
      rejectionReason: null, failureReason: null,
      // Max ACTIVE order + 1, not active.size — delete-then-add otherwise
      // produces duplicate order values once a track has ever been removed.
      // The max is only over active docs, so a reject-then-create can still
      // collide with a dead (rejected/failed) doc's leftover order value —
      // accepted, since reorderTracks heals it on the next reorder (see the
      // duplicate-order-healing test).
      order: Math.max(-1, ...active.docs.map((d) => (d.data().order as number) ?? -1)) + 1,
      createdAt: now, updatedAt: now,
    };
    tx.set(trackRef, doc);
  });
  return { trackId: trackRef.id, uploadPath: stagingAudioPath(uid, input.profileId, trackRef.id) };
});

export const updateTrack = onCall<{ profileId: string; trackId: string; title?: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackId, title } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)) {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    if (title === undefined) {
      throw new HttpsError("invalid-argument", "Nothing to update.");
    }
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 80) {
      throw new HttpsError("invalid-argument", "Track titles are 1-80 characters.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    try {
      await ref.update({ title: title.trim(), updatedAt: Date.now() });
    } catch (err) {
      // Firestore's NOT_FOUND status maps to gRPC code 5 — thrown by update()
      // against a missing doc instead of a separate pre-read, since a plain
      // get()-then-update() has a TOCTOU gap (the doc can vanish between the
      // two calls, e.g. a racing deleteTrack).
      if ((err as { code?: number }).code === 5) {
        throw new HttpsError("not-found", "Track not found.");
      }
      throw err;
    }
    return { ok: true };
  });

export const deleteTrack = onCall<{ profileId: string; trackId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackId } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)) {
      throw new HttpsError("invalid-argument", "profileId and trackId are required.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`profiles/${profileId}/tracks/${trackId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Track not found.");
    // Storage cleanup is best-effort: a transcode in flight when the doc is
    // deleted can still write a review clip afterwards — Task 7's trigger
    // must re-check the doc after transcoding and remove its own output if
    // the doc is gone (see plan Task 7).
    await Promise.allSettled([
      bucket().file(reviewTrackPath(profileId, trackId)).delete(),
      bucket().file(publicTrackPath(profileId, trackId)).delete(),
    ]);
    await ref.delete();
    return { ok: true };
  });

export const reorderTracks = onCall<{ profileId: string; trackIds: string[] }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, trackIds } = req.data;
    if (!isValidDocId(profileId) || !Array.isArray(trackIds) || trackIds.length < 1
        || !trackIds.every((t) => isValidDocId(t))
        || new Set(trackIds).size !== trackIds.length) {
      throw new HttpsError("invalid-argument", "A profile id and a list of unique track ids are required.");
    }
    // The reordered list spans every doc in the collection, not just the 10
    // active ones — rejected/failed tracks persist by design (for the reason
    // display), so ordinary reject-then-create churn can reach 21+ docs over
    // a profile's lifetime. 200 stays comfortably clear of Firestore's
    // 500-writes-per-transaction limit.
    if (trackIds.length > 200) {
      throw new HttpsError("invalid-argument", "Too many tracks to reorder at once.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    // Normalizes order to 0..n-1 in one transaction: the given ids first (in the
    // given order), then any unmentioned tracks in their current order. Also
    // heals any duplicate order values left by historic delete-then-add.
    await db.runTransaction(async (tx) => {
      const col = db.collection(`profiles/${profileId}/tracks`);
      const all = await tx.get(col);
      const byId = new Map(all.docs.map((d) => [d.id, d]));
      const mentioned = trackIds.filter((id) => byId.has(id));
      const mentionedSet = new Set(mentioned);
      const rest = all.docs
        .filter((d) => !mentionedSet.has(d.id))
        .sort((a, b) => ((a.data().order ?? 0) - (b.data().order ?? 0)) || a.id.localeCompare(b.id))
        .map((d) => d.id);
      [...mentioned, ...rest].forEach((id, i) => {
        const d = byId.get(id)!;
        if (d.data().order !== i) tx.update(d.ref, { order: i, updatedAt: Date.now() });
      });
    });
    return { ok: true };
  });

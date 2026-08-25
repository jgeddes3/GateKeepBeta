import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, isValidDocId, stagingAudioPath, reviewTrackPath, publicTrackPath, MAX_TRACKS,
  type CreateTrackInput, type TrackDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";
import { bucket, logDeleteFailure } from "./storage.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count. Exported so Task 9's submit
// minimum-content gate can import it instead of re-hardcoding the list.
export const ACTIVE_TRACK_STATUSES = ["processing", "pending_review", "approved"] as const;

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

export const reviewTrack = onCall<{ profileId: string; trackId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, trackId, decision, reason } = req.data;
    if (!isValidDocId(profileId) || !isValidDocId(trackId)
        || (decision !== "approved" && decision !== "rejected")) {
      throw new HttpsError("invalid-argument", "profileId, trackId, and a decision are required.");
    }
    if (decision === "rejected" && !reason?.trim()) {
      throw new HttpsError("invalid-argument", "A rejection reason is required.");
    }
    if (decision === "rejected" && reason!.trim().length > 500) {
      throw new HttpsError("invalid-argument", "Rejection reason must be 500 characters or fewer.");
    }

    const db = getFirestore();
    const ref = db.doc(`profiles/${profileId}/tracks/${trackId}`);

    // Claims the decision (flips status/storagePath/rejectionReason) inside a
    // transaction BEFORE any storage work, so two concurrent reviews of the
    // same track can't both pass their precondition check and both go on to
    // touch storage. Whichever transaction commits first claims the track;
    // Firestore silently retries the loser's read against the now-updated
    // doc, so it sees the new status and fails its own precondition check.
    // The Functions emulator serializes concurrent invocations of the same
    // callable, so this race is untestable there — the transaction itself is
    // the guarantee, deliberately with no accompanying test.
    const prior = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Track not found.");
      const data = snap.data() as TrackDoc;
      if (decision === "approved" && data.status !== "pending_review") {
        throw new HttpsError("failed-precondition", "Track is not pending review.");
      }
      // Reject also accepts "approved" (retroactive takedown, spec §6) AND a
      // second "rejected" (idempotent retry — lets an admin re-run a
      // takedown whose storage cleanup failed the first time; see the
      // "unavailable" throw below).
      if (decision === "rejected" && data.status !== "pending_review"
          && data.status !== "approved" && data.status !== "rejected") {
        throw new HttpsError("failed-precondition", "Track is not reviewable.");
      }
      if (decision === "approved") {
        tx.update(ref, {
          status: "approved", storagePath: publicTrackPath(profileId, trackId),
          rejectionReason: null, updatedAt: Date.now(),
        });
      } else {
        tx.update(ref, {
          status: "rejected", storagePath: null,
          rejectionReason: reason!.trim(), updatedAt: Date.now(),
        });
      }
      return data;
    });

    const reviewFile = bucket().file(reviewTrackPath(profileId, trackId));
    const publicFile = bucket().file(publicTrackPath(profileId, trackId));

    if (decision === "approved") {
      try {
        // Copy-then-delete keeps the public-path invariant: the clip appears
        // in public/ only as part of an approval that already committed.
        await reviewFile.copy(publicFile);
      } catch (err) {
        // The Firestore claim above already committed "approved" — if the
        // copy itself fails, roll the doc back to pending_review (and its
        // prior storagePath) so the track isn't left stuck "approved" with
        // no public object behind it.
        await ref.update({
          status: "pending_review", storagePath: prior.storagePath ?? null, updatedAt: Date.now(),
        }).catch(logDeleteFailure("approve rollback", `${profileId}/${trackId}`));
        // @google-cloud/storage surfaces a missing source object as an
        // ApiError with HTTP code 404 (unlike Firestore's gRPC code 5 used
        // elsewhere) — the review clip was already gone (a race, or a prior
        // partial failure that already consumed it). That's a recoverable
        // admin action (reject + ask for a re-upload), not a server error.
        if ((err as { code?: number }).code === 404) {
          throw new HttpsError("failed-precondition",
            "The review clip is missing — reject this track and ask the musician to re-upload.");
        }
        throw err;
      }
      await reviewFile.delete()
        .catch(logDeleteFailure("review copy after approve", reviewTrackPath(profileId, trackId)));
    } else {
      const [reviewResult, publicResult] = await Promise.allSettled([reviewFile.delete(), publicFile.delete()]);
      if (reviewResult.status === "rejected" && (reviewResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reject: review delete", reviewTrackPath(profileId, trackId))(reviewResult.reason);
      }
      if (publicResult.status === "rejected" && (publicResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reject: public delete", publicTrackPath(profileId, trackId))(publicResult.reason);
      }
      // The doc already says "rejected" (the claim above committed it) — but
      // if this track was previously "approved" and the PUBLIC object failed
      // to delete for a reason other than "already gone" (404), the clip may
      // still be publicly reachable even though the doc says otherwise.
      // Surface that to the admin as a retryable failure instead of quietly
      // reporting success: the transactional claim above accepts
      // reject-from-rejected, so a second reviewTrack("rejected") call
      // safely re-attempts the same delete.
      if (prior.status === "approved" && publicResult.status === "rejected"
          && (publicResult.reason as { code?: number })?.code !== 404) {
        throw new HttpsError("unavailable",
          "Takedown incomplete — the public clip could not be removed. Try again.");
      }
    }

    // Storage work finishes asynchronously after the transactional claim
    // committed — deleteTrack (or deleteProfile's cascade) can race in
    // between and remove the doc entirely. Re-read before writing an audit
    // entry or notifying members about a track that's already gone; on
    // approve, also clean up the public object just written (any cleanup
    // deleteTrack/deleteProfile already did ran before this copy landed, so
    // it can't have caught this one).
    const postSnap = await ref.get();
    if (!postSnap.exists) {
      if (decision === "approved") {
        await publicFile.delete()
          .catch(logDeleteFailure("orphaned public (post-review race)", publicTrackPath(profileId, trackId)));
      }
      return { ok: true };
    }

    await writeAudit({
      actorUid,
      action: decision === "approved" ? "track_approved" : "track_rejected",
      // Reject's detail records the prior status too — a takedown trail
      // (was "approved" and live, vs. a routine first-time reject from
      // "pending_review") is worth more to an auditor than the reason alone.
      detail: decision === "approved" ? (prior.title ?? "") : `[was ${prior.status}] ${reason!.trim()}`,
      targetId: `${profileId}/${trackId}`,
    });
    const title = prior.title ?? "Your track";
    const wasApproved = prior.status === "approved";
    await notifyProfileMembers(profileId, {
      kind: "track_review",
      title: decision === "approved"
        ? `"${title}" is live!`
        : wasApproved ? `"${title}" was removed from your portfolio` : `"${title}" needs attention`,
      body: decision === "approved"
        ? "Your track passed review and now plays on your public portfolio."
        : wasApproved
          ? `Reviewer note: ${reason!.trim()} — this track is no longer on your public page. You can delete it and upload a replacement.`
          : `Reviewer note: ${reason!.trim()} — you can delete it and upload a replacement.`,
    });
    return { ok: true };
  });

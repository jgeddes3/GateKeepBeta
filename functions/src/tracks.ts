import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateTrackCreate, isValidDocId, stagingAudioPath, reviewTrackPath, publicTrackPath, MAX_TRACKS,
  type CreateTrackInput, type TrackDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";
import { bucket, logDeleteFailure } from "./storage.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";
import { notifyFollowers } from "./follows.js";
import { newMusicNote } from "./announce.js";

// Statuses that occupy one of the 10 slots. rejected/failed tracks keep their
// docs (for the reason display) but don't count. This is slot occupancy for
// the 10-track cap, NOT listenability — see profiles.ts's
// LISTENABLE_TRACK_STATUSES, which deliberately excludes "processing".
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

    // Reject's decision is final the instant the transaction above commits —
    // unlike approve (which can still be rolled back below if the copy
    // fails), nothing downstream undoes "rejected". Write the audit AND
    // notify the musician right here, unconditionally-once at claim time —
    // not gated on the storage outcome below. This used to live at the very
    // end, alongside approve's notification, but the storage-cleanup step
    // below can throw HttpsError("unavailable", ...) when the public delete
    // fails for a non-404 reason (see that throw's comment) — that aborts
    // the call before ever reaching a post-storage notification block, so a
    // takedown whose first storage attempt failed would silently never
    // notify the musician, even on a successful retry (the retry's `prior`
    // is already "rejected" by then, which is exactly the idempotency guard
    // below and correctly suppresses a second notification). Firing both
    // here instead — before any storage work — means the musician always
    // hears about a reject exactly once, regardless of how storage cleanup
    // goes. Both are guarded on prior.status !== "rejected" so an idempotent
    // reject-from-rejected retry doesn't produce a duplicate audit row or
    // tell the musician twice.
    if (decision === "rejected" && prior.status !== "rejected") {
      await writeAudit({
        actorUid,
        action: "track_rejected",
        // Detail records the prior status too — a takedown trail (was
        // "approved" and live, vs. a routine first-time reject from
        // "pending_review") is worth more to an auditor than the reason alone.
        detail: `[was ${prior.status}] ${reason!.trim()}`,
        targetId: `${profileId}/${trackId}`,
      });
      const rejectTitle = prior.title ?? "Your track";
      const wasApproved = prior.status === "approved";
      await notifyProfileMembers(profileId, {
        kind: "track_review",
        title: wasApproved ? `"${rejectTitle}" was removed from your portfolio` : `"${rejectTitle}" needs attention`,
        body: wasApproved
          ? `Reviewer note: ${reason!.trim()} — this track is no longer on your public page. You can delete it and upload a replacement.`
          : `Reviewer note: ${reason!.trim()} — you can delete it and upload a replacement.`,
      });
    }

    const reviewFile = bucket().file(reviewTrackPath(profileId, trackId));
    const publicFile = bucket().file(publicTrackPath(profileId, trackId));

    if (decision === "approved") {
      try {
        // Copy-then-delete keeps the public-path invariant: the clip appears
        // in public/ only as part of an approval that already committed.
        await reviewFile.copy(publicFile);
      } catch (err) {
        // The Firestore claim above already committed "approved" — if the
        // copy itself fails, roll the doc back to pending_review inside its
        // own transaction, and only if it's still OUR claim: a concurrent
        // reject (often the very thing that deleted the review clip and
        // made this copy fail) may have already taken the track down, and
        // that decision must stand rather than being clobbered back to
        // pending_review by a plain unconditional update.
        await db.runTransaction(async (tx) => {
          const s = await tx.get(ref);
          // Only roll back OUR claim. If another admin has since taken the
          // track down — often the very thing that deleted the clip and
          // made the copy fail — their decision stands.
          if (!s.exists || s.data()?.status !== "approved") return;
          tx.update(ref, { status: "pending_review", storagePath: prior.storagePath ?? null, updatedAt: Date.now() });
        }).catch((e) => console.error("reviewTrack: approve rollback failed", `${profileId}/${trackId}`, e));
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
        .catch(logDeleteFailure("reviewTrack", "review copy after approve", reviewTrackPath(profileId, trackId)));
    } else {
      const [reviewResult, publicResult] = await Promise.allSettled([reviewFile.delete(), publicFile.delete()]);
      if (reviewResult.status === "rejected" && (reviewResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reviewTrack", "reject: review delete", reviewTrackPath(profileId, trackId))(reviewResult.reason);
      }
      if (publicResult.status === "rejected" && (publicResult.reason as { code?: number })?.code !== 404) {
        logDeleteFailure("reviewTrack", "reject: public delete", publicTrackPath(profileId, trackId))(publicResult.reason);
      }
      // A pending track's public object shouldn't exist, so its delete 404s
      // harmlessly. If the public delete fails for any OTHER reason — for
      // ANY prior status, not just a retroactive takedown from "approved" —
      // the object may still exist and be publicly reachable even though
      // the doc says "rejected"; surface that to the admin as a retryable
      // failure instead of quietly reporting success. The audit row for
      // this decision is already written above; the transactional claim
      // accepts reject-from-rejected, so a second reviewTrack("rejected")
      // call safely re-attempts the same delete without duplicating it.
      if (publicResult.status === "rejected" && (publicResult.reason as { code?: number })?.code !== 404) {
        throw new HttpsError("unavailable",
          "Takedown incomplete — the public clip could not be removed. Try again.");
      }
    }

    // Storage work finishes asynchronously after the transactional claim
    // committed — a concurrent review of the SAME track (e.g. another admin
    // rejects it while this approve's copy is still in flight) can move the
    // status again before we get here, or deleteTrack/deleteProfile's
    // cascade can remove the doc entirely. Re-read and require the status to
    // still match what THIS call claimed, not just that the doc exists — an
    // existence-only check would let a superseded approve still write its
    // audit/notification and leave the public object it just copied behind
    // as the only trace of a decision that no longer stands.
    const postSnap = await ref.get();
    const stillOurs = postSnap.exists && postSnap.data()?.status === decision;
    if (!stillOurs) {
      if (decision === "approved") {
        await publicFile.delete()
          .catch(logDeleteFailure("reviewTrack", "superseded public (post-review race)", publicTrackPath(profileId, trackId)));
      }
      // Only approve's audit/notify are skipped here — the other admin's
      // decision stands. Reject's already fired unconditionally above,
      // before this re-read, so there's nothing to skip for it.
      return { ok: true };
    }

    // Reject's audit + notification already ran (right after the
    // transaction, above, unconditionally-once at claim time — see the
    // comment there for why). Approve's are gated here instead because
    // approve — unlike reject — can still be superseded by a concurrent
    // reject between the copy finishing and this re-read; the `stillOurs`
    // check above already returned early without audit/notify if so.
    if (decision === "approved") {
      await writeAudit({
        actorUid,
        action: "track_approved",
        detail: prior.title ?? "",
        targetId: `${profileId}/${trackId}`,
      });
      await notifyProfileMembers(profileId, {
        kind: "track_review",
        title: `"${prior.title ?? "Your track"}" is live!`,
        body: "Your track passed review and now plays on your public portfolio.",
      });
      // SP7 Task 5: fan-out to the artist's followers, distinct from the
      // profile-member notification just above (that one tells the
      // musician their own track is live; this tells fans of the profile
      // there's new music). Best-effort, post-commit notification. A
      // failure here must never surface as an error on an already-committed
      // approve.
      try {
        const profileSnap = await db.doc(`profiles/${profileId}`).get();
        const artistName = (profileSnap.data() as ProfileDoc | undefined)?.name ?? "An artist you follow";
        await notifyFollowers([profileId], newMusicNote(profileId, artistName, prior.title ?? "New track"), `track:${trackId}`);
      } catch (e) {
        console.error(`reviewTrack: new-music fan-out failed for track ${profileId}/${trackId}`, e);
      }
    }
    return { ok: true };
  });

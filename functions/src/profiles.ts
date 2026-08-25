import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateProfileDraft, type ProfileDraftInput, type ProfileDoc, type MemberDoc, type PortfolioData,
} from "@gatekeep/shared";
import { writeAudit } from "./review.js";
import { bucket, logDeleteFailure } from "./storage.js";

const MAX_UNSUBMITTED_PROFILES = 3;
const UNSUBMITTED_STATUSES: ReadonlySet<string> = new Set(["draft", "rejected"]);

// Distinct from tracks.ts's ACTIVE_TRACK_STATUSES (which is slot-occupancy —
// "processing" counts against the 10-track cap). This gate cares about
// actually-uploaded, listenable content: createTrack writes the doc BEFORE
// the client uploads bytes, so a "processing" track can be an abandoned
// upload with nothing behind it — that must not satisfy the gate.
const LISTENABLE_TRACK_STATUSES = ["pending_review", "approved"] as const;

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

function requireVerifiedEmail(req: { auth?: { token?: Record<string, unknown> } }): void {
  if (req.auth?.token?.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Please verify your email address first.");
  }
}

export async function requireProfileAdmin(profileId: string, uid: string) {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists || m.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Only profile admins can do that.");
  }
}

export const createProfileDraft = onCall<ProfileDraftInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateProfileDraft(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  const db = getFirestore();

  // Cap unsubmitted (draft/rejected) profiles per admin to prevent unlimited
  // handle squatting via never-submitted drafts. Mirrors deleteAccount.ts's
  // pattern: query the collection-group by uid (already index-enabled) and
  // filter admin role / status in application code rather than adding a
  // second equality clause that would need its own collection-group index.
  const myMemberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  let unsubmittedCount = 0;
  for (const m of myMemberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent;
    if (!profileRef) continue;
    const p = await profileRef.get();
    if (UNSUBMITTED_STATUSES.has(p.data()?.status)) unsubmittedCount++;
  }
  if (unsubmittedCount >= MAX_UNSUBMITTED_PROFILES) {
    throw new HttpsError("resource-exhausted",
      "Too many unsubmitted profiles — finish or delete an existing draft first.");
  }

  const profileRef = db.collection("profiles").doc();
  const handleRef = db.doc(`handles/${input.handle}`);

  await db.runTransaction(async (tx) => {
    if ((await tx.get(handleRef)).exists) {
      throw new HttpsError("already-exists", "That handle is taken.");
    }
    const now = Date.now();
    const profile: ProfileDoc = {
      type: input.type, subtype: input.subtype as ProfileDoc["subtype"],
      name: input.name.trim(), handle: input.handle,
      status: "draft", rejectionReason: null, createdAt: now, updatedAt: now,
      ...(input.type === "musician"
        ? { portfolio: { bio: "", genres: [], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null } }
        : {}),
    };
    const member: MemberDoc = { uid, role: "admin", label: "owner", joinedAt: now };
    tx.set(profileRef, profile);
    tx.set(handleRef, { profileId: profileRef.id });
    tx.set(profileRef.collection("members").doc(uid), member);
  });
  return { profileId: profileRef.id };
});

export const submitProfileForReview = onCall<{ profileId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const { profileId } = req.data;
  await requireProfileAdmin(profileId, uid);
  const ref = getFirestore().doc(`profiles/${profileId}`);
  const snap = await ref.get();
  const status = snap.data()?.status;
  if (status !== "draft" && status !== "rejected") {
    throw new HttpsError("failed-precondition", `Cannot submit a profile in status "${status}".`);
  }

  // Spec §6 minimum content: reviewers approve a *portfolio* — there must be
  // something to look at and listen to. Musicians only; curators are sub-3.
  if (snap.data()?.type === "musician") {
    const p = snap.data()?.portfolio as PortfolioData | undefined;
    const missing: string[] = [];
    if (!p?.bio?.trim()) missing.push("a bio");
    if (!p?.genres?.length) missing.push("at least one genre");
    if (!p?.avatarPhotoPath) missing.push("a profile photo");
    // This read (and the status check above) is not transactional with the
    // ref.update below — a deleteTrack racing this call could remove the
    // one qualifying track between the query and the update. That leaves
    // the profile pending_review with no listenable content, which
    // self-heals: an admin rejects it as empty and the musician resubmits.
    // Accepted rather than wrapping the whole gate in a transaction.
    const tracksSnap = await ref.collection("tracks")
      .where("status", "in", [...LISTENABLE_TRACK_STATUSES]).limit(1).get();
    if (tracksSnap.empty) missing.push("at least one track");
    if (missing.length > 0) {
      const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing);
      throw new HttpsError("failed-precondition", `Add ${list} before submitting.`);
    }
  }

  await ref.update({ status: "pending_review", rejectionReason: null, updatedAt: Date.now() });
  return { ok: true };
});

// Resolves the spec §4 deletion dead-end: deleteAccount refuses while the
// caller is a sole admin anywhere, but until now there was no way to act on
// that — a sole admin of an unwanted/never-submitted profile had no path to
// give up the handle and then delete their account. Also gives admins a way
// to remediate handle-squatting drafts.
export const deleteProfile = onCall<{ profileId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const { profileId } = req.data;
  if (typeof profileId !== "string" || profileId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A profile id is required.");
  }
  await requireProfileAdmin(profileId, uid);
  const db = getFirestore();
  const profileRef = db.doc(`profiles/${profileId}`);
  const snap = await profileRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
  const handle = snap.data()?.handle as string | undefined;
  const name = snap.data()?.name as string | undefined;

  if (handle) await db.doc(`handles/${handle}`).delete();
  await db.recursiveDelete(profileRef); // deletes the profile doc + its members, tracks, and private/booking subcollections

  // Storage cascade — best-effort. force: true is required: without it,
  // deleteFiles aborts the ENTIRE prefix sweep on the first per-object
  // error, silently abandoning every remaining object in that prefix; with
  // it, deletion continues past individual failures and collects them
  // instead. staging/audio/{uid}/... and staging/photos/{uid}/... are
  // deliberately NOT swept here even though every {uid} is technically
  // reachable — a members subcollection query, run before recursiveDelete
  // removes it, would enumerate them — but the processUpload trigger always
  // deletes its own staging object in a `finally` on every path (success,
  // validation failure, or a crash-recovery retry), so a residual staging
  // object means the trigger never fired at all, not that this cascade
  // missed it. Those are backstopped by the Storage bucket's 24h lifecycle
  // rule on staging/, which is a LAUNCH BLOCKER follow-up (not yet
  // configured — tracked in the SP2 plan's manual follow-ups; Task 16 owes
  // the README entry).
  const cascadeTargets = [
    `public/tracks/${profileId}/`,
    `review/tracks/${profileId}/`,
    `public/photos/${profileId}/`,
  ];
  const results = await Promise.allSettled(
    cascadeTargets.map((prefix) => bucket().deleteFiles({ prefix, force: true })));
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    // force: true's rejection reason is an ARRAY of per-object errors
    // (@google-cloud/storage collects them), not a single Error — log each
    // one individually rather than dumping the array as one opaque entry.
    // The non-array fallback is NOT dead code: a listing failure still
    // rejects with a single Error even under force: true.
    const errors = Array.isArray(r.reason) ? r.reason : [r.reason];
    for (const e of errors) {
      logDeleteFailure("deleteProfile", "storage cascade", cascadeTargets[i])(e);
    }
  });

  await writeAudit({ actorUid: uid, action: "profile_deleted", targetId: profileId, detail: name ?? "" });
  return { ok: true };
});

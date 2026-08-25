import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { validateProfileDraft, type ProfileDraftInput, type ProfileDoc, type MemberDoc } from "@gatekeep/shared";
import { writeAudit } from "./review.js";

const MAX_UNSUBMITTED_PROFILES = 3;
const UNSUBMITTED_STATUSES: ReadonlySet<string> = new Set(["draft", "rejected"]);

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
  await db.recursiveDelete(profileRef); // deletes the profile doc + its members subcollection

  await writeAudit({ actorUid: uid, action: "profile_deleted", targetId: profileId, detail: name ?? "" });
  return { ok: true };
});

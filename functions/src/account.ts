import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// Consumes membership invariants (Task 8: never-zero-admins per profile) and
// the users/{uid} tree created by onUserCreated (Task 5).
//
// Known limitation (v1, accepted per task dispatch): the sole-admin check
// below is a plain read, not transactional like removeMember's (Task 8).
// Account deletion is a rare, user-initiated action, so a race between two
// concurrent deletions/removals is an acceptable risk for now rather than a
// reason to add transactional complexity here.
export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();

  // Block deletion while sole admin anywhere (spec §4).
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0) {
    throw new HttpsError("failed-precondition",
      `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
  }

  // Remove the curatorAccess marker (+ any pending retry doc), then
  // memberships, then the user doc tree, then the auth account. Each phase
  // is independently retry-idempotent (re-deleting an already-deleted
  // membership/doc, or re-deleting an already-deleted auth user, is a no-op
  // or a clean not-found) — so on partial failure we don't attempt a
  // compensating rollback. Instead we log which phase failed for diagnosis
  // and tell the client it's safe to call deleteAccount again, rather than
  // surfacing a raw internal error or silently leaving things half-deleted.
  //
  // S5: curatorAccess/{uid} is deleted FIRST, before memberships — once this
  // account is gone, the marker must never keep granting
  // isApprovedCuratorMember() access to a uid the Auth user for no longer
  // exists (deleteUser below can't be undone if a later phase fails, but a
  // stale-but-harmless leftover membership doc is a smaller residual risk
  // than a stale-but-ACTIVE-privilege marker surviving the account it
  // describes).
  try {
    await Promise.all([
      db.doc(`curatorAccess/${uid}`).delete(),
      db.doc(`curatorAccessRetries/${uid}`).delete(),
    ]);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "curatorAccess" }, e);
    throw new HttpsError("internal", "Account deletion did not complete — it is safe to try again.");
  }
  try {
    await Promise.all(memberships.docs.map((m) => m.ref.delete()));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "memberships" }, e);
    throw new HttpsError("internal", "Account deletion did not complete — it is safe to try again.");
  }
  try {
    await db.recursiveDelete(db.doc(`users/${uid}`));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "firestore" }, e);
    throw new HttpsError("internal", "Account deletion did not complete — it is safe to try again.");
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "auth" }, e);
    throw new HttpsError("internal", "Account deletion did not complete — it is safe to try again.");
  }
  return { ok: true };
});

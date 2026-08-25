import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { requireProfileAdmin } from "./profiles.js";
import type { InviteDoc, MemberDoc, MemberRole } from "@gatekeep/shared";

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

function requireVerifiedEmail(req: { auth?: { token?: Record<string, unknown> } }): void {
  if (req.auth?.token?.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Please verify your email address first.");
  }
}

const MAX_PENDING_INVITES_PER_PROFILE = 20;

export const inviteMember = onCall<{ profileId: string; email: string; role: MemberRole; label: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    requireVerifiedEmail(req);
    const { profileId, email, role, label } = req.data;
    // Defensive runtime guards: onCall's generic type parameter does not
    // validate the untrusted request payload at runtime.
    if (typeof email !== "string" || email.trim().length === 0) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }
    if (role !== "admin" && role !== "member") {
      throw new HttpsError("invalid-argument", "Role must be \"admin\" or \"member\".");
    }
    if (typeof label !== "string") {
      throw new HttpsError("invalid-argument", "Label must be a string.");
    }
    const trimmedLabel = label.trim().slice(0, 60);
    await requireProfileAdmin(profileId, uid);
    const db = getFirestore();
    // Cap check runs BEFORE email resolution, and unconditionally (does not
    // depend on whether the email resolves). If it ran after resolution —
    // or only on the resolved-email path — then at/over the cap a caller
    // could distinguish a resolving email (resource-exhausted) from an
    // unknown one ({ ok: true }), reopening the anti-enumeration oracle
    // this endpoint is otherwise closed against. Running it here keeps the
    // response uniform at the cap: every call gets resource-exhausted,
    // known email or not.
    const pending = await db.collection("invites")
      .where("profileId", "==", profileId).where("status", "==", "pending").get();
    if (pending.size >= MAX_PENDING_INVITES_PER_PROFILE) {
      throw new HttpsError("resource-exhausted", "Too many pending invites for this profile.");
    }
    // Anti-enumeration: an unknown email must be indistinguishable from a
    // known one to any signed-up caller. Resolve the email, but on failure
    // fall through to a uniform { ok: true } rather than throwing — never
    // reveal via response shape/error code whether an account exists for
    // a given email.
    let invited;
    try { invited = await getAuth().getUserByEmail(email); }
    catch { return { ok: true as const }; }
    if (invited.uid === uid) {
      throw new HttpsError("failed-precondition", "You're already on this profile.");
    }
    const profile = await db.doc(`profiles/${profileId}`).get();
    const invite: InviteDoc = {
      profileId, profileName: profile.data()?.name ?? "", invitedUid: invited.uid,
      role, label: trimmedLabel, invitedByUid: uid, status: "pending", createdAt: Date.now(),
    };
    await db.collection("invites").add(invite);
    return { ok: true as const };
  });

const INVITE_MAX_AGE_MS = 14 * 86_400_000; // 14 days

export const respondToInvite = onCall<{ inviteId: string; accept: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    const { inviteId, accept } = req.data;
    const db = getFirestore();
    const ref = db.doc(`invites/${inviteId}`);
    const snap = await ref.get();
    const inv = snap.data() as InviteDoc | undefined;
    if (!inv) throw new HttpsError("not-found", "Invite not found.");
    if (inv.invitedUid !== uid) throw new HttpsError("permission-denied", "Not your invite.");
    if (inv.status !== "pending") throw new HttpsError("failed-precondition", "Invite already handled.");
    if (Date.now() - inv.createdAt > INVITE_MAX_AGE_MS) {
      throw new HttpsError("failed-precondition", "This invite has expired.");
    }
    const profileSnap = await db.doc(`profiles/${inv.profileId}`).get();
    if (!profileSnap.exists) throw new HttpsError("not-found", "Profile no longer exists.");
    if (accept) {
      const memberRef = db.doc(`profiles/${inv.profileId}/members/${uid}`);
      // Transactional: read-then-write must be atomic, otherwise an accept
      // can blindly .set() over an existing membership doc — e.g. a sole
      // admin who was already re-added by another flow — silently demoting
      // or discarding their role and permanently bricking the profile if
      // they were the only admin.
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(memberRef);
        if (existing.exists) {
          throw new HttpsError("already-exists", "Already a member of this profile.");
        }
        const member: MemberDoc = { uid, role: inv.role, label: inv.label, joinedAt: Date.now() };
        tx.set(memberRef, member);
        tx.update(ref, { status: "accepted" });
      });
    } else {
      await ref.update({ status: "declined" });
    }
    return { ok: true };
  });

export const revokeInvite = onCall<{ inviteId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    const { inviteId } = req.data;
    const db = getFirestore();
    const ref = db.doc(`invites/${inviteId}`);
    const snap = await ref.get();
    const inv = snap.data() as InviteDoc | undefined;
    if (!inv) throw new HttpsError("not-found", "Invite not found.");
    await requireProfileAdmin(inv.profileId, uid);
    if (inv.status !== "pending") throw new HttpsError("failed-precondition", "Invite already handled.");
    await ref.update({ status: "revoked" });
    return { ok: true };
  });

export const removeMember = onCall<{ profileId: string; uid: string }>(
  { region: "us-central1" }, async (req) => {
    const actor = requireAuth(req.auth?.uid);
    const { profileId, uid } = req.data;
    // Members may remove themselves; otherwise admin required. This check can
    // stay outside the transaction — it doesn't participate in the
    // last-admin race (it only reads the actor's own membership, which
    // removeMember never mutates on the actor's behalf).
    if (actor !== uid) await requireProfileAdmin(profileId, actor);
    const db = getFirestore();
    const memberRef = db.doc(`profiles/${profileId}/members/${uid}`);
    const adminsQuery = db.collection(`profiles/${profileId}/members`).where("role", "==", "admin");
    // Transactional: the last-admin check and the delete must be read- and
    // write-consistent within one transaction, otherwise two concurrent
    // removals of the last two admins can both read adminCount > 1 and both
    // proceed, violating the never-zero-admins invariant.
    await db.runTransaction(async (tx) => {
      const target = await tx.get(memberRef);
      if (!target.exists) throw new HttpsError("not-found", "Not a member.");
      if (target.data()?.role === "admin") {
        const admins = await tx.get(adminsQuery);
        if (admins.size <= 1) {
          throw new HttpsError("failed-precondition",
            "Cannot remove the last admin. Transfer admin first or delete the profile.");
        }
      }
      tx.delete(memberRef);
    });
    return { ok: true };
  });

export const transferAdmin = onCall<{ profileId: string; toUid: string }>(
  { region: "us-central1" }, async (req) => {
    const actor = requireAuth(req.auth?.uid);
    const { profileId, toUid } = req.data;
    await requireProfileAdmin(profileId, actor);
    const db = getFirestore();
    const target = await db.doc(`profiles/${profileId}/members/${toUid}`).get();
    if (!target.exists) throw new HttpsError("not-found", "Target is not a member of this profile.");
    await db.doc(`profiles/${profileId}/members/${toUid}`).update({ role: "admin" });
    return { ok: true };
  });

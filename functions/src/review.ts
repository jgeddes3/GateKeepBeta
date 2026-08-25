import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { AuditLogDoc } from "@gatekeep/shared";

function requireAdmin(req: { auth?: { uid?: string; token?: Record<string, unknown> } }): string {
  const uid = req.auth?.uid;
  if (!uid || req.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  return uid;
}

export async function writeAudit(entry: Omit<AuditLogDoc, "at">) {
  const log: AuditLogDoc = { ...entry, at: Date.now() };
  await getFirestore().collection("auditLogs").add(log);
}

export const reviewProfile = onCall<{ profileId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, decision, reason } = req.data;
    if (decision === "rejected" && !reason?.trim()) {
      throw new HttpsError("invalid-argument", "A rejection reason is required.");
    }
    const ref = getFirestore().doc(`profiles/${profileId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
    if (snap.data()?.status !== "pending_review") {
      throw new HttpsError("failed-precondition", "Profile is not pending review.");
    }
    await ref.update({
      status: decision,
      rejectionReason: decision === "rejected" ? reason!.trim() : null,
      updatedAt: Date.now(),
    });
    await writeAudit({
      actorUid,
      action: decision === "approved" ? "profile_approved" : "profile_rejected",
      targetId: profileId,
      detail: decision === "rejected" ? reason!.trim() : snap.data()?.name ?? "",
    });
    return { ok: true };
  });

export const grantAdmin = onCall<{ uid: string }>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { uid } = req.data;
  await getAuth().setCustomUserClaims(uid, { admin: true });
  await writeAudit({ actorUid, action: "admin_granted", targetId: uid, detail: "" });
  return { ok: true };
});

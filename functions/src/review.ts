import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { AuditLogDoc } from "@gatekeep/shared";
import { notifyProfileMembers } from "./notifications.js";
import { syncCuratorAccess } from "./curator.js";

export function requireAdmin(req: { auth?: { uid?: string; token?: Record<string, unknown> } }): string {
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
    if (decision === "rejected" && reason!.trim().length > 500) {
      throw new HttpsError("invalid-argument", "Rejection reason must be 500 characters or fewer.");
    }
    const db = getFirestore();
    const ref = db.doc(`profiles/${profileId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
    const priorStatus = snap.data()?.status;
    if (decision === "approved" && priorStatus !== "pending_review") {
      throw new HttpsError("failed-precondition", "Profile is not pending review.");
    }
    // Reject also accepts "approved" — spec §6's "admins can retroactively
    // unpublish anything", which reviewTrack already supports for tracks but
    // profiles didn't. Flipping an approved profile to rejected is enough:
    // firestore.rules' profileApproved()-gated reads then hide the profile
    // AND (via the same check) every one of its tracks from public
    // automatically, with no separate takedown of each track needed.
    //
    // Deliberately does NOT delete the public/ track+photo objects: this same
    // path is the routine "please revise and resubmit" editorial reject, where
    // scrubbing the musician's transcoded clips would force a full re-upload +
    // re-transcode + re-review on resubmit (and orphan the still-"approved"
    // track docs that point at them). Unpublish here removes DISCOVERY (page
    // 404s, listing denied); a true abuse/impersonation takedown is the
    // deliberate two-step reject → deleteProfile, whose cascade scrubs the
    // public/review objects (unblocked now that the profile is rejected).
    // Residual: a direct getDownloadURL obtained while live keeps working
    // between the two steps — accepted; the admin performs both promptly.
    if (decision === "rejected" && priorStatus !== "pending_review" && priorStatus !== "approved") {
      throw new HttpsError("failed-precondition", "Profile is not pending review or approved.");
    }
    const wasApproved = priorStatus === "approved";
    const isCurator = snap.data()?.type === "curator";
    const now = Date.now();

    const batch = db.batch();
    batch.update(ref, {
      status: decision,
      rejectionReason: decision === "rejected" ? reason!.trim() : null,
      updatedAt: now,
      // Anti-spam (Task 4): submitProfileForReview reads this to enforce a
      // 24h resubmit cooldown after a rejection. Only stamped on reject —
      // omitted (not cleared) on approve, so an earlier reject's timestamp
      // stays put through a later approve.
      ...(decision === "rejected" ? { lastRejectedAt: now } : {}),
    });

    // curatorAccess/{uid} + takedown cascade (Task 6) — curator profiles
    // only; musicians have no gigs/series and no curatorAccess implication.
    let memberUids: string[] = [];
    let closedGigs = 0;
    let pausedSeries = 0;
    if (isCurator) {
      const membersSnap = await db.collection(`profiles/${profileId}/members`).get();
      memberUids = membersSnap.docs.map((d) => d.id);

      if (decision === "approved") {
        // Fast path: approval can only GAIN a member access, never lose it —
        // a direct set is correct without the full recompute (contrast the
        // reject-from-approved branch below, which must NOT blindly delete:
        // a member may hold access via another approved curator profile).
        for (const memberUid of memberUids) batch.set(db.doc(`curatorAccess/${memberUid}`), {});
      } else if (decision === "rejected" && wasApproved) {
        // Cascade: this approved curator profile is going dark — close its
        // open gigs, pause its active series (same series-pause precedent
        // as gigs.ts's takedownGig), batched with the status flip, before
        // the notification below (SP2 retroactive-unpublish ordering: the
        // content stops being live before anyone is told).
        const openGigsSnap = await db.collection("gigs")
          .where("curatorProfileId", "==", profileId).where("status", "==", "open").get();
        for (const doc of openGigsSnap.docs) {
          batch.update(doc.ref, { status: "closed", updatedAt: now });
          closedGigs++;
        }
        const activeSeriesSnap = await db.collection("gigSeries")
          .where("curatorProfileId", "==", profileId).where("status", "==", "active").get();
        for (const doc of activeSeriesSnap.docs) {
          batch.update(doc.ref, { status: "paused", updatedAt: now });
          pausedSeries++;
        }
      }
    }

    await batch.commit();

    // curatorAccess recompute for reject-from-approved runs AFTER the batch
    // commits: syncCuratorAccess re-reads each member's profiles live, and
    // needs this profile's just-flipped "rejected" status to be visible so
    // a member who belongs to no OTHER approved curator profile correctly
    // loses the marker (a member who does belong to another keeps it).
    // Best-effort per member (allSettled, not all) — matches deleteProfile's
    // cascade-cleanup style: one member's recompute failing (e.g. a
    // transient Firestore error) must not fail the whole review decision,
    // which has already committed. A re-trigger mechanism for a failed
    // recompute is deliberately out of scope here — the next membership or
    // approval-status event that touches that uid (another reviewProfile
    // call, respondToInvite, removeMember) re-syncs it via its own
    // touchpoint, so a stale marker is self-healing, not permanent.
    if (isCurator && decision === "rejected" && wasApproved) {
      const results = await Promise.allSettled(memberUids.map((memberUid) => syncCuratorAccess(memberUid)));
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          console.error("curatorAccess recompute failed", { profileId, memberUid: memberUids[i] }, result.reason);
        }
      });
    }

    await writeAudit({
      actorUid,
      action: decision === "approved" ? "profile_approved" : "profile_rejected",
      targetId: profileId,
      // Mirrors reviewTrack's retroactive-takedown detail shape: recording
      // the prior status distinguishes a takedown of a live profile from a
      // routine first-time reject from pending_review. The cascade counts
      // are appended only when the cascade above actually affected
      // something — a curator profile with no live gigs/series at reject
      // time (the common case for a same-day approve-then-reject, e.g. the
      // pre-Task-6 "retroactive unpublish" contract) gets the plain
      // pre-Task-6 detail string, not noisy "(closed 0 gigs, paused 0
      // series)" text.
      detail: decision === "rejected"
        ? (wasApproved
            ? `[was approved] ${reason!.trim()}${
                isCurator && (closedGigs > 0 || pausedSeries > 0)
                  ? ` (closed ${closedGigs} gigs, paused ${pausedSeries} series)` : ""}`
            : reason!.trim())
        : snap.data()?.name ?? "",
    });
    const profileName = snap.data()?.name ?? "Your profile";
    await notifyProfileMembers(profileId, {
      kind: "profile_review",
      title: decision === "approved" ? `${profileName} is approved!` : `${profileName} needs changes`,
      body: decision === "approved"
        ? "Your profile is live on GateKeep."
        : `Reviewer note: ${reason!.trim()} — update and resubmit anytime.`,
    });
    return { ok: true };
  });

export const grantAdmin = onCall<{ uid: string }>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { uid } = req.data;
  if (typeof uid !== "string" || uid.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A user id is required.");
  }
  let target;
  try { target = await getAuth().getUser(uid); }
  catch { throw new HttpsError("not-found", "No such user."); }
  // Spec §8's compensating control for no built-in 2FA: admin accounts must
  // be Google sign-in accounts (inherits Google's account-level 2FA).
  const isGoogleLinked = target.providerData.some((p) => p.providerId === "google.com");
  if (!isGoogleLinked) {
    throw new HttpsError("failed-precondition", "Admin accounts must use Google sign-in.");
  }
  // Merge rather than replace — a bare setCustomUserClaims(uid, { admin: true })
  // would silently drop any other custom claims already set on the account.
  await getAuth().setCustomUserClaims(uid, { ...target.customClaims, admin: true });
  await writeAudit({ actorUid, action: "admin_granted", targetId: uid, detail: "" });
  return { ok: true };
});

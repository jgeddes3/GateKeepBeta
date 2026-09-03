import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { isValidDocId, type AuditLogDoc } from "@gatekeep/shared";
import { notifyProfileMembers } from "./notifications.js";
import { syncCuratorAccess } from "./curator.js";
import { unwindBookingsForModeration } from "./bookingLifecycle.js";
import { cancelAndRefundEventForModeration, ORGANIZER_INACTIVE_REASON, type EventCascadeRetryDoc } from "./events.js";
import { stripeSecretKey } from "./stripeClient.js";

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

async function cascadeEventsForUnpublishedProfile(
  db: FirebaseFirestore.Firestore, profileId: string, now: number,
): Promise<{ cancelled: number; queued: number }> {
  // Served by the existing events (curatorProfileId, status, startsAt) composite.
  const [publishedSnap, draftSnap] = await Promise.all([
    db.collection("events").where("curatorProfileId", "==", profileId)
      .where("status", "==", "published").where("startsAt", ">", now).get(),
    db.collection("events").where("curatorProfileId", "==", profileId).where("status", "==", "draft").get(),
  ]);
  let cancelled = 0;
  let queued = 0;
  for (const doc of [...publishedSnap.docs, ...draftSnap.docs]) {
    try {
      const result = await cancelAndRefundEventForModeration(
        doc.id, ORGANIZER_INACTIVE_REASON, { kind: "system", cause: "profile_unpublished" });
      if (result.outcome === "cancelled") cancelled++;
    } catch (e) {
      queued++;
      console.error("event cascade failed; queued for dailySweep step 9", { profileId, eventId: doc.id }, e);
      const retry: EventCascadeRetryDoc = {
        profileId, reason: ORGANIZER_INACTIVE_REASON, attempts: 1,
        lastError: e instanceof Error ? e.message : String(e), createdAt: now,
      };
      try {
        await db.doc(`eventCascadeRetries/${doc.id}`).set(retry);
      } catch (writeError) {
        console.error("eventCascadeRetries write failed", { eventId: doc.id }, writeError);
      }
    }
  }
  return { cancelled, queued };
}

// The pre-SP10 "(closed N gigs, paused M series)" suffix is preserved
// byte-for-byte when no events were touched (review.test.ts:307 asserts it);
// event counts are appended only when the cascade actually cancelled or
// queued something.
function cascadeSummary(isCurator: boolean, closedGigs: number, pausedSeries: number, eventsCancelled: number, eventsQueued: number): string {
  if (!isCurator) return "";
  const parts: string[] = [];
  if (closedGigs > 0 || pausedSeries > 0) parts.push(`closed ${closedGigs} gigs, paused ${pausedSeries} series`);
  if (eventsCancelled > 0) parts.push(`cancelled ${eventsCancelled} events`);
  if (eventsQueued > 0) parts.push(`${eventsQueued} events queued for retry`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export const reviewProfile = onCall<{ profileId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, decision, reason } = req.data;
    // P2: enum-guard `decision` and shape-guard `profileId`, untrusted
    // onCall payload, same defensive-runtime rationale used throughout this
    // codebase (an admin caller's client bug, not necessarily malice, could
    // otherwise send an arbitrary string through to the status field below).
    if (decision !== "approved" && decision !== "rejected") {
      throw new HttpsError("invalid-argument", 'Decision must be "approved" or "rejected".');
    }
    if (!isValidDocId(profileId)) {
      throw new HttpsError("invalid-argument", "A profile id is required.");
    }
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
    // Reject also accepts "approved", spec §6's "admins can retroactively
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
    // between the two steps, accepted; the admin performs both promptly.
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
      // 24h resubmit cooldown after a rejection. Only stamped on reject.
      // P2: on approve, DELETE both fields rather than leaving them in
      // place, profiles/{id} becomes world-readable once approved
      // (firestore.rules), so a lingering lastRejectedAt/resubmitCount from
      // an earlier reject cycle was a moderation-history leak (anyone could
      // see how many times, and how recently, this profile got rejected
      // before finally clearing review). No schema churn: both fields are
      // already optional on ProfileDoc, and submitProfileForReview treats
      // `lastRejectedAt === undefined` as "never rejected" / omits
      // resubmitCount on a genuine first submission either way.
      ...(decision === "rejected"
        ? { lastRejectedAt: now }
        : { lastRejectedAt: FieldValue.delete(), resubmitCount: FieldValue.delete() }),
    });

    // curatorAccess/{uid} + takedown cascade (Task 6), curator profiles
    // only; musicians have no gigs/series and no curatorAccess implication.
    let memberUids: string[] = [];
    let closedGigs = 0;
    let pausedSeries = 0;
    if (isCurator) {
      const membersSnap = await db.collection(`profiles/${profileId}/members`).get();
      memberUids = membersSnap.docs.map((d) => d.id);

      if (decision === "approved") {
        // Fast path: approval can only GAIN a member access, never lose it,
        // a direct set is correct without the full recompute (contrast the
        // reject-from-approved branch below, which must NOT blindly delete:
        // a member may hold access via another approved curator profile).
        for (const memberUid of memberUids) batch.set(db.doc(`curatorAccess/${memberUid}`), {});
      } else if (decision === "rejected" && wasApproved) {
        // Cascade: this approved curator profile is going dark, close its
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
        // SP4 (Task 7 amendment): a FILLED gig is not reached by the
        // "open"-only query above. Its confirmed booking is expired by the
        // unwindBookingsForModeration call below, but left alone the GIG
        // doc itself would still read status:"filled", which is publicly
        // readable unconditionally (the gigs read rule's status=='filled'
        // disjunct is not gated on the curator profile's own approval
        // status), and a FUTURE-dated one would keep rendering as a
        // phantom "upcoming show" on the booked musician's own public Shows
        // section (Task 11 queries filled+closed gigs by linkage). Close it
        // and clear its booking linkage here: a closed gig with
        // bookedMusicianProfileId:null fails BOTH public-read disjuncts
        // (status=='filled' no longer applies, and the status=='closed'
        // disjunct requires a non-null bookedMusicianProfileId), so it stops
        // being publicly readable at all. A PAST-dated filled gig is left
        // COMPLETELY untouched instead, the show really happened, the
        // musician's Shows HISTORY legitimately retains it, and a full
        // scrub (deleting the gig outright) remains the deliberate two-step
        // reject -> deleteProfile, exactly like SP2's content-takedown
        // model. (unwindBookingsForModeration's own series-level
        // activeBookingId/bookedMusicianProfileId clear is idempotent
        // regardless of whether it runs before or after this gig-side
        // write, since it re-reads the series fresh and only acts if the
        // series still names the just-expired booking.)
        // Minor fix (Task 7 quality review): unbounded (no .limit()),
        // accepted at v1 scale, same as the openGigsSnap query just above;
        // a single profile's live "filled" occurrence count is bounded by
        // its own MAX_OPEN_GIGS_PER_PROFILE-shaped usage in practice, and
        // this batch (openGigsSnap + filledGigsSnap + activeSeriesSnap
        // combined) must stay under Firestore's 500-write-per-batch ceiling
        // regardless, a curator with enough simultaneously-live content to
        // approach that ceiling is itself a v2 pagination problem, not a
        // v1 one.
        const filledGigsSnap = await db.collection("gigs")
          .where("curatorProfileId", "==", profileId).where("status", "==", "filled").get();
        for (const doc of filledGigsSnap.docs) {
          const startsAt = doc.data().startsAt as number;
          if (startsAt > now) {
            batch.update(doc.ref, {
              status: "closed", bookingId: null, bookedMusicianProfileId: null, updatedAt: now,
            });
            closedGigs++;
          }
          // past-dated: left entirely alone, see comment above.
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

    // SP4 (Task 7): unwind every booking naming this profile as EITHER side
    //, added regardless of isCurator (a musician profile's own confirmed
    // bookings need this exactly as much as a curator's do; the isCurator
    // branch above only ever touched gigs/series, never bookings).
    if (decision === "rejected" && wasApproved) {
      await unwindBookingsForModeration({ profileId });
    }

    // SP10 Task 10 (spec section 5.1): events follow the profile. Every
    // published future event is cancelled and refunded in full, drafts are
    // cancelled, completed and already-cancelled events are untouched. Each
    // event is its own try/catch: one poisoned event lands in
    // eventCascadeRetries for the daily sweep's step 9, never blocks the rest.
    let eventsCancelled = 0;
    let eventsQueued = 0;
    if (isCurator && decision === "rejected" && wasApproved) {
      const cascade = await cascadeEventsForUnpublishedProfile(db, profileId, now);
      eventsCancelled = cascade.cancelled;
      eventsQueued = cascade.queued;
    }

    // curatorAccess recompute for reject-from-approved runs AFTER the batch
    // commits: syncCuratorAccess re-reads each member's profiles live, and
    // needs this profile's just-flipped "rejected" status to be visible so
    // a member who belongs to no OTHER approved curator profile correctly
    // loses the marker (a member who does belong to another keeps it).
    // Best-effort per member (allSettled, not all), matches deleteProfile's
    // cascade-cleanup style: one member's recompute failing (e.g. a
    // transient Firestore error) must not fail the whole review decision,
    // which has already committed. S4 CORRECTION: this used to claim a
    // failed recompute "self-heals" via the next membership/approval-status
    // touchpoint for that uid, false whenever this rejected profile was
    // that uid's ONLY curator membership, since no such touchpoint will
    // ever fire again for them (no more invites/removals/reviews touch a
    // uid with zero remaining curator profiles). A failed recompute is
    // instead recorded to curatorAccessRetries/{uid} below, which the daily
    // sweep's retry step (functions/src/scheduled.ts) retries until it
    // succeeds, deleting the retry doc on success.
    if (isCurator && decision === "rejected" && wasApproved) {
      const results = await Promise.allSettled(memberUids.map((memberUid) => syncCuratorAccess(memberUid)));
      await Promise.allSettled(results.map(async (result, i) => {
        if (result.status !== "rejected") return;
        const memberUid = memberUids[i];
        console.error("curatorAccess recompute failed", { profileId, memberUid }, result.reason);
        try {
          await getFirestore().doc(`curatorAccessRetries/${memberUid}`).set({ createdAt: Date.now() });
        } catch (e) {
          console.error("curatorAccessRetries write failed", { memberUid }, e);
        }
      }));
    }

    await writeAudit({
      actorUid,
      action: decision === "approved" ? "profile_approved" : "profile_rejected",
      targetId: profileId,
      // Mirrors reviewTrack's retroactive-takedown detail shape: recording
      // the prior status distinguishes a takedown of a live profile from a
      // routine first-time reject from pending_review. The cascade counts
      // are appended only when the cascade above actually affected
      // something, a curator profile with no live gigs/series at reject
      // time (the common case for a same-day approve-then-reject, e.g. the
      // pre-Task-6 "retroactive unpublish" contract) gets the plain
      // pre-Task-6 detail string, not noisy "(closed 0 gigs, paused 0
      // series)" text.
      detail: decision === "rejected"
        ? (wasApproved
            ? `[was approved] ${reason!.trim()}${cascadeSummary(isCurator, closedGigs, pausedSeries, eventsCancelled, eventsQueued)}`
            : reason!.trim())
        : snap.data()?.name ?? "",
    });
    const profileName = snap.data()?.name ?? "Your profile";
    await notifyProfileMembers(profileId, {
      kind: "profile_review",
      title: decision === "approved" ? `${profileName} is approved!` : `${profileName} needs changes`,
      body: decision === "approved"
        ? "Your profile is live on GateKeep."
        : `Reviewer note: ${reason!.trim()}. Update and resubmit anytime.`,
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
  // Merge rather than replace, a bare setCustomUserClaims(uid, { admin: true })
  // would silently drop any other custom claims already set on the account.
  await getAuth().setCustomUserClaims(uid, { ...target.customClaims, admin: true });
  await writeAudit({ actorUid, action: "admin_granted", targetId: uid, detail: "" });
  return { ok: true };
});

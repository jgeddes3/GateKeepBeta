import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  validateProfileDraft, isValidDocId, validateLookingFor,
  MAX_PENDING_CURATOR_PROFILES, RESUBMIT_COOLDOWN_MS,
  type ProfileDraftInput, type ProfileDoc, type MemberDoc, type PortfolioData,
  type CuratorDetails, type CuratorSubtype,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { writeAudit } from "./review.js";
import { bucket, logDeleteFailure } from "./storage.js";
import { syncCuratorAccess } from "./curator.js";

const MAX_UNSUBMITTED_PROFILES = 3;
const UNSUBMITTED_STATUSES: ReadonlySet<string> = new Set(["draft", "rejected"]);

// Distinct from tracks.ts's ACTIVE_TRACK_STATUSES (which is slot-occupancy —
// "processing" counts against the 10-track cap). This gate cares about
// actually-uploaded, listenable content: createTrack writes the doc BEFORE
// the client uploads bytes, so a "processing" track can be an abandoned
// upload with nothing behind it — that must not satisfy the gate.
const LISTENABLE_TRACK_STATUSES = ["pending_review", "approved"] as const;

export async function requireProfileAdmin(profileId: string, uid: string) {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists || m.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Only profile admins can do that.");
  }
}

// S6 deleteProfile cascade helpers — page in PAGE-sized chunks (not one
// unbounded .get()) since a prolific curator's gig/series history can be
// arbitrarily large. Re-querying with the same `.limit(PAGE)` after each
// page's docs are deleted naturally returns the NEXT page — deleted docs
// never reappear in the next `.get()` — so no `startAfter` cursor is needed.
const DELETE_CASCADE_PAGE_SIZE = 200;

async function deleteGigsForProfile(db: FirebaseFirestore.Firestore, profileId: string): Promise<void> {
  for (;;) {
    const snap = await db.collection("gigs")
      .where("curatorProfileId", "==", profileId).limit(DELETE_CASCADE_PAGE_SIZE).get();
    if (snap.empty) return;
    // recursiveDelete per gig (not a batched plain delete): each gig doc
    // also owns a private/location subdoc that only recursiveDelete reaches.
    for (const gigDoc of snap.docs) {
      await db.recursiveDelete(gigDoc.ref);
    }
    if (snap.docs.length < DELETE_CASCADE_PAGE_SIZE) return;
  }
}

async function deleteSeriesForProfile(db: FirebaseFirestore.Firestore, profileId: string): Promise<void> {
  for (;;) {
    const snap = await db.collection("gigSeries")
      .where("curatorProfileId", "==", profileId).limit(DELETE_CASCADE_PAGE_SIZE).get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref); // gigSeries has no subcollections — a plain delete suffices
    await batch.commit();
    if (snap.docs.length < DELETE_CASCADE_PAGE_SIZE) return;
  }
}

export const createProfileDraft = onCall<ProfileDraftInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
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
        : input.type === "curator"
        ? { curator: {
            about: "",
            lookingFor: { genres: [], actSizes: [], notes: null },
            amenities: { capacity: null, hasPA: null, hasBackline: null, indoorOutdoor: null, notes: null },
            advertisingInterest: false,
            location: { address: null, city: "", neighborhood: null, geo: null },
            photoPaths: [],
          } as CuratorDetails }
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
  const uid = requireAuthUid(req);
  const { profileId } = req.data;
  await requireProfileAdmin(profileId, uid);
  const ref = getFirestore().doc(`profiles/${profileId}`);
  const snap = await ref.get();
  const data = snap.data();
  const status = data?.status;
  if (status !== "draft" && status !== "rejected") {
    throw new HttpsError("failed-precondition", `Cannot submit a profile in status "${status}".`);
  }

  // Anti-spam: resubmitting too soon after a rejection is blocked regardless
  // of profile type — reviewProfile stamps lastRejectedAt on every reject
  // (routine "revise and resubmit" and retroactive-unpublish alike).
  const lastRejectedAt = data?.lastRejectedAt;
  if (lastRejectedAt !== undefined && Date.now() - lastRejectedAt < RESUBMIT_COOLDOWN_MS) {
    throw new HttpsError("failed-precondition", "You can resubmit 24 hours after a rejection.");
  }

  // Anti-spam: at most MAX_PENDING_CURATOR_PROFILES curator profiles pending
  // review per admin at once, to prevent a spam wave of low-effort
  // venue/planner listings. Same collection-group-scan pattern as
  // createProfileDraft's unsubmitted-drafts cap above.
  if (data?.type === "curator") {
    const myMemberships = await getFirestore().collectionGroup("members").where("uid", "==", uid).get();
    let pendingCuratorCount = 0;
    for (const m of myMemberships.docs) {
      if (m.data().role !== "admin") continue;
      const profileRef = m.ref.parent.parent;
      if (!profileRef) continue;
      const p = await profileRef.get();
      if (p.data()?.type === "curator" && p.data()?.status === "pending_review") pendingCuratorCount++;
    }
    if (pendingCuratorCount >= MAX_PENDING_CURATOR_PROFILES) {
      throw new HttpsError("resource-exhausted",
        "You already have a curator profile pending review — wait for that decision first.");
    }
  }

  // Spec §6 minimum content: reviewers approve a *portfolio* — there must be
  // something to look at (and, for musicians, listen to).
  if (data?.type === "musician") {
    const p = data?.portfolio as PortfolioData | undefined;
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

  if (data?.type === "curator") {
    const c = data?.curator as CuratorDetails | undefined;
    const subtype = data?.subtype as CuratorSubtype;
    const missing: string[] = [];
    if (!c?.about?.trim()) missing.push("an about description");
    if (!c?.photoPaths?.length) missing.push("at least one photo");
    // Venues need a real street address; planners/hosts only ever have a
    // city-level pin, so a non-empty city satisfies the gate for them.
    const hasLocation = subtype === "venue" ? !!c?.location?.address : !!c?.location?.city;
    if (!hasLocation) missing.push("a location");
    if (!validateLookingFor(c?.lookingFor ?? { genres: [], actSizes: [], notes: null }).ok) {
      missing.push("what you're looking for");
    }
    if (missing.length > 0) {
      const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing);
      throw new HttpsError("failed-precondition", `Add ${list} before submitting.`);
    }
  }

  // Task 8: resubmitCount lets the admin queue render "resubmitted Nth
  // time" — only stamped when this submission is a genuine resubmit (status
  // was "rejected"), never on the first-ever draft -> pending_review
  // submission, which isn't a resubmit of anything.
  await ref.update({
    status: "pending_review", rejectionReason: null, updatedAt: Date.now(),
    ...(status === "rejected" ? { resubmitCount: FieldValue.increment(1) } : {}),
  });
  return { ok: true };
});

// Resolves the spec §4 deletion dead-end: deleteAccount refuses while the
// caller is a sole admin anywhere, but until now there was no way to act on
// that — a sole admin of an unwanted/never-submitted profile had no path to
// give up the handle and then delete their account. Also gives admins a way
// to remediate handle-squatting drafts.
export const deleteProfile = onCall<{ profileId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { profileId } = req.data;
  if (!isValidDocId(profileId)) {
    throw new HttpsError("invalid-argument", "A profile id is required.");
  }
  await requireProfileAdmin(profileId, uid);
  const db = getFirestore();
  const profileRef = db.doc(`profiles/${profileId}`);
  const snap = await profileRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
  // Finding 3: this used to be enforced client-side only — a co-admin could
  // call deleteProfile directly on a LIVE approved profile and immediately
  // free its handle for takeover. draft/rejected are the only statuses with
  // nothing publicly live to lose; pending_review and approved profiles must
  // go through reviewProfile's reject (which now supports retroactive
  // unpublish of an approved profile too) before they're deletable.
  const status = snap.data()?.status;
  if (status !== "draft" && status !== "rejected") {
    throw new HttpsError("failed-precondition",
      "Approved or in-review profiles can't be deleted — contact support / unpublish first.");
  }
  const handle = snap.data()?.handle as string | undefined;
  const name = snap.data()?.name as string | undefined;
  const isCurator = snap.data()?.type === "curator";

  if (handle) await db.doc(`handles/${handle}`).delete();

  // S6: collect member uids BEFORE the profile's own recursiveDelete removes
  // the members subcollection — syncCuratorAccess (post-delete, below) needs
  // to run for each of them once this profile's membership docs are truly
  // gone, so a member whose ONLY approved-curator access came from this
  // profile correctly loses the marker (a member who belongs to another
  // approved curator profile keeps it, exactly like removeMember's and
  // reviewProfile's reject cascade).
  let memberUids: string[] = [];
  if (isCurator) {
    const membersSnap = await db.collection(`profiles/${profileId}/members`).get();
    memberUids = membersSnap.docs.map((d) => d.id);
  }

  // S6: cascade-delete this curator's gigs and series before the profile's
  // own recursiveDelete — deleteProfile only ever runs on a draft/rejected
  // profile (the gate above), but a profile reaches "rejected" either
  // straight from draft (never approved, so never any gigs/series — createGig
  // requires an approved profile) or via reviewProfile's retroactive
  // reject-from-approved, which CLOSES/PAUSES live gigs/series but does not
  // delete them — deleting the profile is the deliberate second step for a
  // full scrub (README's "Content takedown is a two-step" note), and those
  // closed/paused docs (plus their exact private addresses) must not survive
  // it. Each gig gets its own recursiveDelete (not a plain doc delete) so its
  // private/location subdoc is reached too; gigSeries has no subcollections,
  // so a plain batched delete suffices. Both queries page in PAGE-sized
  // chunks rather than fetching the whole collection in one unbounded read —
  // a prolific curator's cancelled/closed/taken_down gig history is
  // otherwise unbounded (unlike MAX_OPEN_GIGS_PER_PROFILE, which only caps
  // "open" gigs).
  if (isCurator) {
    await deleteGigsForProfile(db, profileId);
    await deleteSeriesForProfile(db, profileId);
  }

  await db.recursiveDelete(profileRef); // deletes the profile doc + its members, tracks, and private/booking subcollections

  // S6: post-deletion recompute — now that the membership docs are truly
  // gone, syncCuratorAccess's collectionGroup('members') scan for each
  // former member no longer finds this profile, so a member whose only
  // curator access came from here correctly loses the marker. Best-effort
  // (allSettled), matching reviewProfile's identical reject-cascade
  // rationale — deleting a profile is a rare, admin/owner-initiated action
  // (unlike reviewProfile's automatic cascade on every reject), so a failed
  // recompute here is logged rather than queued to curatorAccessRetries; the
  // far more common path to a marker needing recompute (reviewProfile's
  // reject-from-approved) already runs and retries BEFORE deleteProfile can
  // even be called (this profile must already be "rejected" to pass the
  // gate above).
  if (isCurator && memberUids.length > 0) {
    const results = await Promise.allSettled(memberUids.map((memberUid) => syncCuratorAccess(memberUid)));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error("curatorAccess recompute failed", { profileId, memberUid: memberUids[i] }, result.reason);
      }
    });
  }

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

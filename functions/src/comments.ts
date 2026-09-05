import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  getFirestore, FieldValue,
  type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction,
} from "firebase-admin/firestore";
import {
  validateCommentText, isValidDocId,
  COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS, REACTION_RATE_MAX,
  COMMENTS_CLOSED_MESSAGE, COMMENT_UNDER_REVIEW_MESSAGE, MESSAGE_RATE_MESSAGE,
  MESSAGE_PREVIEW_CHARS, commentReplyNotificationTitle,
  type CommentRole, type CommentWindowDoc, type EventCommentDoc, type EventDoc,
  type EventReactionDoc, type PostHeartDoc, type ShowPostDoc, type UserDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { notifyUser } from "./notifications.js";

// SP12 (spec sections 3.2 and 5). Fan comments and reactions on the PUBLIC
// event page. Everything here is per-event and per-user; nothing touches
// money, tickets, or the event's own lifecycle.

// An event is open for comments and reactions while it is published or
// completed. Draft is not public yet, and cancel and takedown both land on
// "cancelled" (cancelEventCore), which closes the composer; the comments
// themselves are never deleted by the event cascade (spec section 5), so the
// thread stays readable.
function requireOpenEvent(event: EventDoc): void {
  if (event.status !== "published" && event.status !== "completed") {
    throw new HttpsError("failed-precondition", COMMENTS_CLOSED_MESSAGE);
  }
}

// Curator member > artist member > fan. "Artist" means a member of a profile
// on lineupMusicianProfileIds, which is the projection isLinkableAct already
// maintains (booking acts plus ACCEPTED tagged acts, sp11 ruling 12): a
// pending tag is not yet on the bill, so its members comment as fans. Read off
// the event doc rather than re-derived from the lineup array, because the
// server keeps that field in step with every lineup write and one source
// cannot disagree with itself.
export async function deriveCommentRole(
  db: Firestore, uid: string, event: EventDoc,
): Promise<{ role: CommentRole; profileId: string | null }> {
  const ids = event.lineupMusicianProfileIds ?? [];
  // One getAll, not one get per act: the curator's membership doc and every
  // lineup profile's membership doc are fetched in a single round trip, so
  // role derivation stays a constant number of trips however long the bill is.
  const snaps = await db.getAll(
    db.doc(`profiles/${event.curatorProfileId}/members/${uid}`),
    ...ids.map((id) => db.doc(`profiles/${id}/members/${uid}`)),
  );
  if (snaps[0].exists) return { role: "curator", profileId: event.curatorProfileId };
  const hit = snaps.findIndex((s, i) => i > 0 && s.exists);
  if (hit > 0) return { role: "artist", profileId: ids[hit - 1] };
  return { role: "fan", profileId: null };
}

// The two rolling windows live on ONE per-user doc, commentWindows/{uid}: a
// per-USER counter, not a field on the event, because both caps span every
// event and no doc these writes already touch could hold them. Same posture
// and rules stance as messageWindows and geocodeBudgets. This half does the
// reading and the refusing; the caller writes the returned array, so the
// window snapshot can be fetched alongside every other read a transaction
// needs and no read ever follows a write.
function nextWindow(
  snap: DocumentSnapshot, field: "at" | "reactions", max: number, now: number,
): number[] {
  const prior = (snap.data() as CommentWindowDoc | undefined)?.[field] ?? [];
  const recent = prior.filter((t) => now - t < COMMENT_RATE_WINDOW_MS);
  if (recent.length >= max) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
  // slice keeps the array bounded forever, so a busy user never grows an
  // unbounded field.
  return [...recent, now].slice(-max);
}

// Merged, never replaced: the comment window and the reaction window share the
// doc and must not overwrite each other.
function writeWindow(
  tx: Transaction, ref: DocumentReference, field: "at" | "reactions", value: number[],
): void {
  tx.set(ref, { [field]: value }, { merge: true });
}

export const postComment = onCall<{ eventId: string; text: string; parentId?: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, parentId } = req.data ?? {};
    if (!isValidDocId(eventId)) throw new HttpsError("invalid-argument", "An event is required.");
    if (parentId !== undefined && !isValidDocId(parentId)) {
      throw new HttpsError("invalid-argument", "A parent comment id is required.");
    }
    const check = validateCommentText(req.data?.text);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const text = (req.data.text as string).trim();

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    requireOpenEvent(event);

    // One level only (spec 3.2): a reply's parent must itself be top-level.
    // The parent is looked up UNDER this event, so a comment id borrowed from
    // another event is simply absent here. A hidden parent counts as gone:
    // moderation removes the thread from view, and a reply would drag it back.
    let parent: EventCommentDoc | null = null;
    if (parentId) {
      const parentSnap = await eventRef.collection("comments").doc(parentId).get();
      if (!parentSnap.exists) throw new HttpsError("not-found", "That comment is gone.");
      parent = parentSnap.data() as EventCommentDoc;
      if (parent.hidden) throw new HttpsError("not-found", "That comment is gone.");
      if (parent.parentId !== null) {
        throw new HttpsError("failed-precondition", "Replies go on the top comment, not on another reply.");
      }
    }

    const { role, profileId } = await deriveCommentRole(db, uid, event);
    const user = (await db.doc(`users/${uid}`).get()).data() as UserDoc | undefined;
    const now = Date.now();
    const comment: EventCommentDoc = {
      authorUid: uid,
      // Snapshotted, like ticket and attendee names: an old comment keeps the
      // name it was posted under.
      authorName: user?.displayName?.trim() || "A GateKeep fan",
      authorRole: role, authorProfileId: profileId,
      parentId: parentId ?? null, text,
      hidden: false, hiddenBy: null, openReports: 0, at: now,
    };

    // The cap is read, trimmed and re-written INSIDE the same transaction as
    // the comment, so a refused post never spends budget and an accepted one
    // is never counted twice.
    const windowRef = db.doc(`commentWindows/${uid}`);
    const commentRef = eventRef.collection("comments").doc();
    await db.runTransaction(async (tx) => {
      const windowSnap = await tx.get(windowRef); // the only read, so it precedes every write
      const at = nextWindow(windowSnap, "at", COMMENT_RATE_MAX, now);
      tx.set(commentRef, comment);
      tx.update(eventRef, { commentCount: FieldValue.increment(1) });
      writeWindow(tx, windowRef, "at", at);
    });

    // Post-commit, best-effort (sp7 ruling 3). ONLY a curator or artist reply
    // to a FAN's comment notifies (spec 3.2): fan-to-fan replies never do, a
    // reply between two profile-side people is shop talk neither of them asked
    // to be paged about, and reactions never notify at all.
    if (parent && role !== "fan" && parent.authorRole === "fan" && parent.authorUid !== uid) {
      try {
        await notifyUser(parent.authorUid, {
          kind: "comment_reply", refId: eventId, refKind: "event",
          title: commentReplyNotificationTitle(comment.authorName),
          body: text.length > MESSAGE_PREVIEW_CHARS ? `${text.slice(0, MESSAGE_PREVIEW_CHARS - 3)}...` : text,
        }, `comment_reply:${commentRef.id}`);
      } catch (e) {
        console.error("postComment: reply fan-out failed", commentRef.id, e);
      }
    }
    return { commentId: commentRef.id, role };
  });

export const hideComment = onCall<{ eventId: string; commentId: string; hidden?: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, commentId, hidden } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    if (hidden !== undefined && typeof hidden !== "boolean") {
      throw new HttpsError("invalid-argument", "A hidden flag is required.");
    }
    // Absent means hide: every curator and artist caller sends only the two
    // ids, and unhiding is the deliberate, admin-only opt-in below.
    const wantHidden = hidden ?? true;

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;

    // Admins moderate anything (the Reports panel's "Hide comment" runs this
    // same callable); otherwise the caller must be a curator or artist member
    // of THIS event. Hiding is allowed on a closed event: moderation must
    // outlive the show.
    const isAdmin = req.auth?.token?.admin === true;
    const role: CommentRole | "admin" = isAdmin ? "admin" : (await deriveCommentRole(db, uid, event)).role;
    if (role === "fan") {
      throw new HttpsError("permission-denied", "Only the organizer or the artists can hide a comment.");
    }
    // Unhiding is admin only (review ruling 6). A curator or artist can take a
    // comment down but cannot put back one an admin removed, so their reach
    // stops at their own event and never overrides moderation.
    if (!wantHidden && !isAdmin) {
      throw new HttpsError("permission-denied", "Only an admin can unhide a comment.");
    }

    const ref = eventRef.collection("comments").doc(commentId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "That comment is gone.");
      const comment = snap.data() as EventCommentDoc;
      if (comment.hidden === wantHidden) return; // idempotent, and no counter drift
      tx.update(ref, wantHidden
        ? { hidden: true, hiddenBy: { uid, role } }
        : { hidden: false, hiddenBy: null });
      // commentCount is the VISIBLE count (ruling 5), so it moves with every
      // visibility change, not just with posts and deletes.
      tx.update(eventRef, { commentCount: FieldValue.increment(wantHidden ? -1 : 1) });
    });
    return { ok: true as const };
  });

export const deleteComment = onCall<{ eventId: string; commentId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const db = getFirestore();
    const ref = db.doc(`events/${eventId}/comments/${commentId}`);
    const eventRef = db.doc(`events/${eventId}`);
    // Author only (spec 3.2): a curator or artist who wants it gone hides it,
    // which leaves the moderation trail hideComment writes. Replies to a
    // deleted comment stay and render COMMENT_DELETED_LINE as their quoted
    // parent, so nothing cascades here.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return; // idempotent: a second delete is a no-op
      const comment = snap.data() as EventCommentDoc;
      if (comment.authorUid !== uid) {
        throw new HttpsError("permission-denied", "Only the author can delete a comment.");
      }
      // A hidden or reported comment is evidence: the author must not be able
      // to delete the thing an admin is still looking at (review ruling 4).
      if (comment.hidden || comment.openReports > 0) {
        throw new HttpsError("failed-precondition", COMMENT_UNDER_REVIEW_MESSAGE);
      }
      tx.delete(ref);
      // A hidden comment was already subtracted from the visible count when it
      // was hidden. Deleting one is refused above, so this guard is belt and
      // braces against ever double-subtracting.
      if (!comment.hidden) tx.update(eventRef, { commentCount: FieldValue.increment(-1) });
    });
    return { ok: true as const };
  });

export const setGoing = onCall<{ eventId: string; going: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    // Spec 3.2 gates the whole surface on "any signed-in user with a verified
    // email", reactions included (review ruling 2).
    requireVerifiedEmail(req);
    const { eventId, going } = req.data ?? {};
    if (!isValidDocId(eventId) || typeof going !== "boolean") {
      throw new HttpsError("invalid-argument", "An event and a going flag are required.");
    }
    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const reactionRef = eventRef.collection("reactions").doc(uid);
    const windowRef = db.doc(`commentWindows/${uid}`);
    const now = Date.now();
    // One transaction reads the current per-user doc and adjusts the counter
    // only on a real transition, so a double tap (or a retried call) is
    // idempotent and the count can never drift or go negative.
    const goingCount = await db.runTransaction(async (tx) => {
      const [eventSnap, reactionSnap, windowSnap] = await Promise.all([
        tx.get(eventRef), tx.get(reactionRef), tx.get(windowRef),
      ]);
      if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
      const event = eventSnap.data() as EventDoc;
      requireOpenEvent(event);
      const reactions = nextWindow(windowSnap, "reactions", REACTION_RATE_MAX, now);
      const was = (reactionSnap.data() as EventReactionDoc | undefined)?.going === true;
      const current = event.goingCount ?? 0;
      // A no-op tap writes nothing at all, so it costs no budget either: the
      // cap exists to bound WRITES, and only a real transition makes one.
      if (was === going) return current;
      const next = Math.max(0, current + (going ? 1 : -1));
      tx.set(reactionRef, { going, at: now } satisfies EventReactionDoc);
      tx.update(eventRef, { goingCount: next });
      writeWindow(tx, windowRef, "reactions", reactions);
      return next;
    });
    return { going, goingCount };
  });

export const setPostHeart = onCall<{ eventId: string; postId: string; hearted: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, postId, hearted } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(postId) || typeof hearted !== "boolean") {
      throw new HttpsError("invalid-argument", "An event, a post, and a hearted flag are required.");
    }
    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const postRef = eventRef.collection("posts").doc(postId);
    const heartRef = postRef.collection("hearts").doc(uid);
    const windowRef = db.doc(`commentWindows/${uid}`);
    const now = Date.now();
    // Presence of the heart doc IS the heart, so the transition test is
    // exists() rather than a stored boolean; same idempotence as setGoing.
    const heartCount = await db.runTransaction(async (tx) => {
      const [eventSnap, postSnap, heartSnap, windowSnap] = await Promise.all([
        tx.get(eventRef), tx.get(postRef), tx.get(heartRef), tx.get(windowRef),
      ]);
      if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
      if (!postSnap.exists) throw new HttpsError("not-found", "Post not found.");
      // The same event gate setGoing uses, plus the post's own state: a
      // removed post keeps its heart docs but stops taking new ones.
      requireOpenEvent(eventSnap.data() as EventDoc);
      const post = postSnap.data() as ShowPostDoc;
      if (post.status !== "live") {
        throw new HttpsError("failed-precondition", "That post is no longer available.");
      }
      const reactions = nextWindow(windowSnap, "reactions", REACTION_RATE_MAX, now);
      const current = post.heartCount ?? 0;
      if (heartSnap.exists === hearted) return current;
      const next = Math.max(0, current + (hearted ? 1 : -1));
      if (hearted) tx.set(heartRef, { at: now } satisfies PostHeartDoc); else tx.delete(heartRef);
      tx.update(postRef, { heartCount: next });
      writeWindow(tx, windowRef, "reactions", reactions);
      return next;
    });
    return { hearted, heartCount };
  });

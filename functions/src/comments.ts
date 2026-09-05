import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  validateCommentText, isValidDocId,
  COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS, COMMENTS_CLOSED_MESSAGE, MESSAGE_RATE_MESSAGE,
  MESSAGE_PREVIEW_CHARS, commentReplyNotificationTitle,
  type CommentRole, type EventCommentDoc, type EventDoc, type EventReactionDoc,
  type PostHeartDoc, type ShowPostDoc, type UserDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { notifyUser } from "./notifications.js";

// SP12 (spec sections 3.2 and 5). Fan comments and reactions on the PUBLIC
// event page. Everything here is per-event and per-user; nothing touches
// money, tickets, or the event's own lifecycle.

// An event is open for comments while it is published or completed. Draft is
// not public yet, and cancel and takedown both land on "cancelled"
// (cancelEventCore), which closes the composer; the comments themselves are
// never deleted by the event cascade (spec section 5), so the thread stays
// readable.
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
  const curatorMember = await db.doc(`profiles/${event.curatorProfileId}/members/${uid}`).get();
  if (curatorMember.exists) return { role: "curator", profileId: event.curatorProfileId };
  const ids = event.lineupMusicianProfileIds ?? [];
  const snaps = await Promise.all(ids.map((id) => db.doc(`profiles/${id}/members/${uid}`).get()));
  const hit = snaps.findIndex((s) => s.exists);
  if (hit >= 0) return { role: "artist", profileId: ids[hit] };
  return { role: "fan", profileId: null };
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
    let parent: EventCommentDoc | null = null;
    if (parentId) {
      const parentSnap = await eventRef.collection("comments").doc(parentId).get();
      if (!parentSnap.exists) throw new HttpsError("not-found", "That comment is gone.");
      parent = parentSnap.data() as EventCommentDoc;
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

    // The rolling 10-minute cap lives in commentWindows/{uid}: a per-USER
    // counter doc, not a field on the event, because the cap spans every event
    // and no doc this write already touches could hold it. Same posture and
    // rules stance as messageWindows and geocodeBudgets. It is read, trimmed,
    // and re-written INSIDE the same transaction as the comment, so a refused
    // post never spends budget and an accepted one can never be counted twice.
    const windowRef = db.doc(`commentWindows/${uid}`);
    const commentRef = eventRef.collection("comments").doc();
    await db.runTransaction(async (tx) => {
      const windowSnap = await tx.get(windowRef); // the only read, so it precedes every write
      const prior = (windowSnap.data() as { at?: number[] } | undefined)?.at ?? [];
      const recent = prior.filter((t) => now - t < COMMENT_RATE_WINDOW_MS);
      if (recent.length >= COMMENT_RATE_MAX) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
      recent.push(now);
      tx.set(commentRef, comment);
      tx.update(eventRef, { commentCount: FieldValue.increment(1) });
      // slice keeps the array bounded at COMMENT_RATE_MAX entries forever, so
      // a busy commenter never grows an unbounded field.
      tx.set(windowRef, { at: recent.slice(-COMMENT_RATE_MAX) });
    });

    // Post-commit, best-effort (sp7 ruling 3). Only a curator or artist reply
    // to somebody ELSE's comment notifies; fan-to-fan replies never do
    // (spec 3.2), and reactions never do at all.
    if (parent && role !== "fan" && parent.authorUid !== uid) {
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

export const hideComment = onCall<{ eventId: string; commentId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const db = getFirestore();
    const eventSnap = await db.doc(`events/${eventId}`).get();
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

    const ref = db.doc(`events/${eventId}/comments/${commentId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That comment is gone.");
    if ((snap.data() as EventCommentDoc).hidden) return { ok: true as const }; // idempotent
    await ref.update({ hidden: true, hiddenBy: { uid, role } });
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
      tx.delete(ref);
      tx.update(eventRef, { commentCount: FieldValue.increment(-1) });
    });
    return { ok: true as const };
  });

export const setGoing = onCall<{ eventId: string; going: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, going } = req.data ?? {};
    if (!isValidDocId(eventId) || typeof going !== "boolean") {
      throw new HttpsError("invalid-argument", "An event and a going flag are required.");
    }
    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const reactionRef = eventRef.collection("reactions").doc(uid);
    // One transaction reads the current per-user doc and adjusts the counter
    // only on a real transition, so a double tap (or a retried call) is
    // idempotent and the count can never drift or go negative.
    const goingCount = await db.runTransaction(async (tx) => {
      const [eventSnap, reactionSnap] = await Promise.all([tx.get(eventRef), tx.get(reactionRef)]);
      if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
      const event = eventSnap.data() as EventDoc;
      requireOpenEvent(event);
      const was = (reactionSnap.data() as EventReactionDoc | undefined)?.going === true;
      const current = event.goingCount ?? 0;
      if (was === going) return current;
      const next = Math.max(0, current + (going ? 1 : -1));
      tx.set(reactionRef, { going, at: Date.now() } satisfies EventReactionDoc);
      tx.update(eventRef, { goingCount: next });
      return next;
    });
    return { going, goingCount };
  });

export const setPostHeart = onCall<{ eventId: string; postId: string; hearted: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, postId, hearted } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(postId) || typeof hearted !== "boolean") {
      throw new HttpsError("invalid-argument", "An event, a post, and a hearted flag are required.");
    }
    const db = getFirestore();
    const postRef = db.doc(`events/${eventId}/posts/${postId}`);
    const heartRef = postRef.collection("hearts").doc(uid);
    // Presence of the heart doc IS the heart, so the transition test is
    // exists() rather than a stored boolean; same idempotence as setGoing.
    const heartCount = await db.runTransaction(async (tx) => {
      const [postSnap, heartSnap] = await Promise.all([tx.get(postRef), tx.get(heartRef)]);
      if (!postSnap.exists) throw new HttpsError("not-found", "Post not found.");
      const post = postSnap.data() as ShowPostDoc;
      const current = post.heartCount ?? 0;
      if (heartSnap.exists === hearted) return current;
      const next = Math.max(0, current + (hearted ? 1 : -1));
      if (hearted) tx.set(heartRef, { at: Date.now() } satisfies PostHeartDoc); else tx.delete(heartRef);
      tx.update(postRef, { heartCount: next });
      return next;
    });
    return { hearted, heartCount };
  });

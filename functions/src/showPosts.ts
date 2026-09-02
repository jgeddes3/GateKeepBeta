import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, SHOW_POST_MAX_CHARS, SHOW_POST_MAX_PER_EVENT, SHOW_POST_MIN_INTERVAL_MS,
  SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE,
  type EventDoc, type ShowPostDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireProfileMember } from "./guards.js";
import { notifyFollowers } from "./follows.js";
import { writeAudit } from "./review.js";

function isAdminReq(req: { auth?: { token?: Record<string, unknown> } }): boolean {
  return req.auth?.token?.admin === true;
}

export const createShowPost = onCall<{ eventId: string; musicianProfileId: string; text: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(musicianProfileId)) throw new HttpsError("invalid-argument", "An event and a profile are required.");
    const text = typeof req.data?.text === "string" ? req.data.text.trim() : "";
    if (text.length < 1 || text.length > SHOW_POST_MAX_CHARS) {
      throw new HttpsError("invalid-argument", `Posts are 1-${SHOW_POST_MAX_CHARS} characters.`);
    }
    await requireProfileMember(musicianProfileId, uid);

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const postsRef = eventRef.collection("posts");
    const now = Date.now();
    const postId = await db.runTransaction(async (tx) => {
      const ev = await tx.get(eventRef);
      if (!ev.exists) throw new HttpsError("not-found", "Event not found.");
      const event = ev.data() as EventDoc;
      if (event.status !== "published" || event.endsAt <= now) {
        throw new HttpsError("failed-precondition", SHOW_POST_EVENT_CLOSED_MESSAGE);
      }
      if (!event.lineupMusicianProfileIds.includes(musicianProfileId)) {
        throw new HttpsError("permission-denied", "This profile is not on the lineup.");
      }
      // Rate limit considers EVERY post by this profile on this event, live or
      // removed: a remove-then-repost must not dodge the cooldown. The 3-post
      // cap, by contrast, counts only live posts (a removed post frees its slot).
      const mine = await tx.get(postsRef.where("musicianProfileId", "==", musicianProfileId));
      const liveCount = mine.docs.filter((d) => (d.data() as ShowPostDoc).status === "live").length;
      if (liveCount >= SHOW_POST_MAX_PER_EVENT) throw new HttpsError("failed-precondition", SHOW_POST_LIMIT_MESSAGE);
      const latest = mine.docs.reduce((max, d) => Math.max(max, (d.data() as ShowPostDoc).createdAt), 0);
      if (now - latest < SHOW_POST_MIN_INTERVAL_MS) throw new HttpsError("failed-precondition", SHOW_POST_RATE_MESSAGE);
      const ref = postsRef.doc();
      const post: ShowPostDoc = { eventId, musicianProfileId, authorUid: uid, text, createdAt: now, status: "live" };
      tx.set(ref, post);
      return ref.id;
    });

    const profile = (await db.doc(`profiles/${musicianProfileId}`).get()).data() as ProfileDoc | undefined;
    const event = (await eventRef.get()).data() as EventDoc;
    // Post-commit fan-out is best-effort (Task 5 controller ruling): the post
    // is already written, so a notify failure here must never surface as an
    // error on it.
    try {
      await notifyFollowers([musicianProfileId], {
        kind: "show_post", refId: eventId,
        title: `${profile?.name ?? "An artist you follow"} on ${event.title}`,
        body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
      }, `post:${postId}`);
    } catch (e) {
      console.error("createShowPost: fan-out failed", postId, e);
    }
    return { postId };
  });

export const removeShowPost = onCall<{ eventId: string; postId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const { eventId, postId } = req.data ?? {};
  if (!isValidDocId(eventId) || !isValidDocId(postId)) throw new HttpsError("invalid-argument", "An event and a post are required.");
  const db = getFirestore();
  const ref = db.doc(`events/${eventId}/posts/${postId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Post not found.");
  const post = snap.data() as ShowPostDoc;
  const admin = isAdminReq(req);
  if (!admin) await requireProfileMember(post.musicianProfileId, uid);
  if (post.status === "removed") return { ok: true }; // idempotent
  await ref.update({ status: "removed", removedBy: admin ? "admin" : "author", removedAt: Date.now() });
  if (admin) {
    await writeAudit({ actorUid: uid, action: "show_post_removed", targetId: `${eventId}/${postId}`, detail: post.text.slice(0, 200) });
  }
  return { ok: true };
});

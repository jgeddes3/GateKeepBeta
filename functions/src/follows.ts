import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  isValidDocId, parseGenreTarget, MAX_FOLLOWS_PER_USER, FOLLOW_LIMIT_MESSAGE,
  type FollowDoc, type FollowTargetType, type ProfileDoc, type NotificationDoc,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { notifyUser } from "./notifications.js";

export function followDocId(uid: string, targetId: string): string { return `${uid}_${targetId}`; }

function validateTargetId(targetId: unknown): string {
  if (typeof targetId !== "string") throw new HttpsError("invalid-argument", "A target is required.");
  if (parseGenreTarget(targetId) !== null) return targetId;
  if (!isValidDocId(targetId)) throw new HttpsError("invalid-argument", "A target is required.");
  return targetId;
}

export const followTarget = onCall<{ targetId: string; targetType: FollowTargetType }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const targetId = validateTargetId(req.data?.targetId);
    const targetType = req.data?.targetType;
    if (targetType !== "musician" && targetType !== "curator" && targetType !== "genre") {
      throw new HttpsError("invalid-argument", "Unknown target type.");
    }
    const isGenre = parseGenreTarget(targetId) !== null;
    if (isGenre !== (targetType === "genre")) throw new HttpsError("invalid-argument", "Target and type disagree.");

    const db = getFirestore();
    const followRef = db.doc(`follows/${followDocId(uid, targetId)}`);
    const profileRef = isGenre ? null : db.doc(`profiles/${targetId}`);
    // Ruling: this repo's installed firebase-admin (12.7.0) rejects an
    // AggregateQuery passed to Transaction.get, so the follow-count read
    // happens as a plain read immediately before the transaction rather than
    // inside it. That makes the cap best-effort (a race can let a caller
    // squeak past MAX_FOLLOWS_PER_USER by a follow or two) rather than
    // exact, which is acceptable for this limit.
    const countSnap = await db.collection("follows").where("uid", "==", uid).count().get();
    const atCap = countSnap.data().count >= MAX_FOLLOWS_PER_USER;
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(followRef);
      if (existing.exists) return; // idempotent: already-following bypasses the cap
      // The cap check runs only after confirming this is a NEW follow, so a
      // user already at the cap can still re-follow (no-op) a target they
      // already follow without hitting FOLLOW_LIMIT_MESSAGE.
      if (atCap) throw new HttpsError("failed-precondition", FOLLOW_LIMIT_MESSAGE);
      if (profileRef) {
        const p = await tx.get(profileRef);
        const data = p.data() as ProfileDoc | undefined;
        // "not-found" for missing, wrong-type, AND unapproved: never confirm a
        // draft/pending profile's existence to a stranger.
        if (!p.exists || !data || data.type !== targetType || data.status !== "approved") {
          throw new HttpsError("not-found", "That profile is not available.");
        }
      }
      const follow: FollowDoc = { uid, targetId, targetType, createdAt: Date.now() };
      tx.set(followRef, follow);
      if (profileRef) tx.update(profileRef, { followerCount: FieldValue.increment(1) });
    });
    return { ok: true };
  });

export const unfollowTarget = onCall<{ targetId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const targetId = validateTargetId(req.data?.targetId);
  const db = getFirestore();
  const followRef = db.doc(`follows/${followDocId(uid, targetId)}`);
  const profileRef = db.doc(`profiles/${targetId}`);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(followRef);
    if (!existing.exists) return; // idempotent
    const follow = existing.data() as FollowDoc;
    // Firestore transactions require every read before any write, so read
    // the profile (when relevant) before the tx.delete/tx.update below.
    const p = follow.targetType !== "genre" ? await tx.get(profileRef) : null;
    tx.delete(followRef);
    if (p && p.exists) {
      // Floor at zero: a profile whose counter never existed (pre-SP7) must not go negative.
      tx.update(profileRef, { followerCount: Math.max(0, ((p.data() as ProfileDoc).followerCount ?? 0) - 1) });
    }
  });
  return { ok: true };
});

export const markGenrePickerSeen = onCall<Record<string, never>>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  await getFirestore().doc(`users/${uid}`).set({ genrePickerSeenAt: Date.now() }, { merge: true });
  return { ok: true };
});

const FANOUT_PAGE = 200;
const FANOUT_BATCH = 50;

// Unions every follower of every target (plus extraUids), then notifies each
// once under dedupeKey. Pages follows by targetId so a popular target never
// loads into memory at once; a crash mid-run leaves some fans unnotified
// rather than double-notified, and a retry is safe by the key.
export async function notifyFollowers(
  targetIds: string[], note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey: string, extraUids: string[] = [],
): Promise<number> {
  const db = getFirestore();
  const uids = new Set<string>(extraUids);
  for (const targetId of [...new Set(targetIds)]) {
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let q = db.collection("follows").where("targetId", "==", targetId).orderBy("__name__").limit(FANOUT_PAGE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      for (const d of snap.docs) uids.add((d.data() as FollowDoc).uid);
      if (snap.docs.length < FANOUT_PAGE) break;
      last = snap.docs[snap.docs.length - 1];
    }
  }
  let written = 0;
  const all = [...uids];
  for (let i = 0; i < all.length; i += FANOUT_BATCH) {
    const results = await Promise.all(all.slice(i, i + FANOUT_BATCH).map((uid) => notifyUser(uid, note, dedupeKey)));
    written += results.filter(Boolean).length;
  }
  return written;
}

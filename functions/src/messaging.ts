import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import {
  conversationPairId, validateMessageText, isValidDocId,
  MESSAGE_RATE_MAX, MESSAGE_RATE_WINDOW_MS, MESSAGE_PREVIEW_CHARS, MESSAGE_NOTIFY_BUCKET_MS,
  MESSAGE_RATE_MESSAGE, MESSAGE_UNAPPROVED_MESSAGE, CONVERSATION_CLOSED_MESSAGE,
  messageNotificationTitle,
  type ConversationDoc, type ConversationRefDoc, type MessageDoc, type MessageWindowDoc,
  type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileMembers } from "./notifications.js";

// SP12 (spec sections 3.1, 4 and 5). Conversations are between exactly one
// musician profile and one curator profile; either side may start one and
// every member of either side can read and reply. Fans are not part of chat
// at all, which is why every entry point here is a profile id, never a uid.
//
// TWO docs describe one conversation, and both are written together:
//
//   conversations/{pairId}                     the shared truth: participants,
//                                              lastMessage, the unread MAP,
//                                              blockedBy, openReports.
//   profiles/{profileId}/conversations/{pairId} one MIRROR per participant
//                                              (ConversationRefDoc), the row
//                                              the inbox list renders.
//
// The mirror exists because firestore.rules cannot prove a list rule for a
// top-level `participants array-contains` query (see the rules file's own
// comment), so the inbox lists the mirror, ordered by lastMessageAt, and
// opens the top-level doc by id. Each mirror is written from ITS OWN profile's
// point of view: `unread` is that profile's single count out of the map, and
// `blockedByMe` says whether THIS profile blocked the pair. It never says
// whether the other side did, because a block is silent (spec 3.1): the
// blocked side must not be able to tell a block from silence. Task 6 (web
// inbox) and Task 10 (mobile inbox) read these rows; Task 5's reports bump
// `openReports` on both mirrors through writeConversationMirrors below.

interface SendMessageInput { fromProfileId: string; toProfileId: string; text: string }

// Writes BOTH participants' mirrors from one already-computed conversation
// state, inside the caller's transaction. `names` maps a profile id to that
// profile's display name; a side whose name is absent keeps the name its
// mirror already carries (merge), so a caller that has not read the profile
// docs (Task 5's report bump) does not have to.
export function writeConversationMirrors(
  tx: Transaction, conversation: ConversationDoc, names: Record<string, string | undefined>,
): void {
  const db = getFirestore();
  const pairId = conversationPairId(conversation.musicianProfileId, conversation.curatorProfileId);
  const sides = [
    { me: conversation.musicianProfileId, other: conversation.curatorProfileId, otherType: "curator" as const },
    { me: conversation.curatorProfileId, other: conversation.musicianProfileId, otherType: "musician" as const },
  ];
  for (const side of sides) {
    const row: Partial<ConversationRefDoc> = {
      pairId,
      otherProfileId: side.other,
      otherProfileType: side.otherType,
      lastMessage: conversation.lastMessage,
      lastMessageAt: conversation.lastMessageAt,
      unread: conversation.unread?.[side.me] ?? 0,
      blockedByMe: conversation.blockedBy.includes(side.me),
      openReports: conversation.openReports,
      updatedAt: conversation.updatedAt,
      ...(names[side.other] === undefined ? {} : { otherProfileName: names[side.other] }),
    };
    tx.set(db.doc(`profiles/${side.me}/conversations/${pairId}`), row, { merge: true });
  }
}

// The pair, in canonical order, plus both profile docs. Throws the spec's own
// refusals: a pair that is not one musician and one curator is a
// failed-precondition, and an unapproved profile on either side gets
// MESSAGE_UNAPPROVED_MESSAGE (a curator whose approval was pulled must not be
// reachable, and an unapproved musician has no public act yet).
async function resolvePair(fromProfileId: string, toProfileId: string) {
  const db = getFirestore();
  const [from, to] = await Promise.all([
    db.doc(`profiles/${fromProfileId}`).get(), db.doc(`profiles/${toProfileId}`).get(),
  ]);
  if (!from.exists || !to.exists) throw new HttpsError("not-found", "Profile not found.");
  const fromDoc = from.data() as ProfileDoc;
  const toDoc = to.data() as ProfileDoc;
  if (fromDoc.type === toDoc.type) {
    throw new HttpsError("failed-precondition", "Chat is between a musician profile and a curator profile.");
  }
  if (fromDoc.status !== "approved" || toDoc.status !== "approved") {
    throw new HttpsError("failed-precondition", MESSAGE_UNAPPROVED_MESSAGE);
  }
  const musicianProfileId = fromDoc.type === "musician" ? fromProfileId : toProfileId;
  const curatorProfileId = fromDoc.type === "curator" ? fromProfileId : toProfileId;
  return { musicianProfileId, curatorProfileId, fromDoc, toDoc };
}

export const sendMessage = onCall<SendMessageInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { fromProfileId, toProfileId } = req.data ?? {};
  if (!isValidDocId(fromProfileId) || !isValidDocId(toProfileId) || fromProfileId === toProfileId) {
    throw new HttpsError("invalid-argument", "Two profiles are required.");
  }
  const check = validateMessageText(req.data?.text);
  if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
  const text = (req.data.text as string).trim();

  await requireProfileMember(fromProfileId, uid);
  const { musicianProfileId, curatorProfileId, fromDoc, toDoc } = await resolvePair(fromProfileId, toProfileId);
  const pairId = conversationPairId(musicianProfileId, curatorProfileId);

  const db = getFirestore();
  const convRef = db.doc(`conversations/${pairId}`);
  // The rate window belongs to the SENDER PROFILE, not to this pair: the cap
  // is 30 per 10 minutes per sender profile across every conversation it
  // takes part in (spec 5). A window kept on the conversation doc would have
  // been one read cheaper and completely wrong: a spammer would simply open a
  // new thread with the next venue and get another 30. Same posture and rules
  // stance as commentWindows/{uid} and geocodeBudgets/{uid}.
  const windowRef = db.doc(`messageWindows/${fromProfileId}`);
  const now = Date.now();

  // One transaction does the whole write: read the conversation (or decide it
  // is new) AND the sender's window, check the block list and the cap, append
  // the message, roll lastMessage/lastMessageAt, increment the RECIPIENT's
  // unread counter, refresh both mirrors, and trim the window. Both reads
  // precede every write (sp7 ruling 4), which is why they are issued together
  // up top, and no external call happens inside.
  const messageId = await db.runTransaction(async (tx) => {
    const [snap, windowSnap] = await Promise.all([tx.get(convRef), tx.get(windowRef)]);
    const existing = snap.exists ? (snap.data() as ConversationDoc) : null;
    if (existing && existing.blockedBy.length > 0) {
      // Neutral in BOTH directions: the blocked side must not learn it was
      // blocked, and the blocking side sees its own banner client-side.
      throw new HttpsError("failed-precondition", CONVERSATION_CLOSED_MESSAGE);
    }
    const prior = (windowSnap.data() as MessageWindowDoc | undefined)?.at ?? [];
    const recent = prior.filter((t) => now - t < MESSAGE_RATE_WINDOW_MS);
    if (recent.length >= MESSAGE_RATE_MAX) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
    recent.push(now);

    const msgRef = convRef.collection("messages").doc();
    const message: MessageDoc = { senderProfileId: fromProfileId, senderUid: uid, text, at: now };
    tx.set(msgRef, message);
    // slice keeps the array bounded at MESSAGE_RATE_MAX entries forever, so a
    // busy profile never grows an unbounded field.
    tx.set(windowRef, { at: recent.slice(-MESSAGE_RATE_MAX) } satisfies MessageWindowDoc);

    // The whole post-send doc is computed here rather than patched with dotted
    // field paths, because the mirrors below need exactly this state and
    // deriving it twice is how the two copies drift apart. Spreading
    // `existing` inside the transaction keeps blockedBy, openReports and
    // createdAt intact; a concurrent change to any of them retries the whole
    // thing, mirrors included.
    const next: ConversationDoc = existing
      ? {
        ...existing,
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        unread: { ...existing.unread, [toProfileId]: (existing.unread?.[toProfileId] ?? 0) + 1 },
        updatedAt: now,
      }
      : {
        musicianProfileId, curatorProfileId,
        participants: [musicianProfileId, curatorProfileId],
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        unread: { [musicianProfileId]: 0, [curatorProfileId]: 0, [toProfileId]: 1 },
        blockedBy: [], openReports: 0,
        createdAt: now, updatedAt: now,
      };
    tx.set(convRef, next);
    writeConversationMirrors(tx, next, { [fromProfileId]: fromDoc.name, [toProfileId]: toDoc.name });
    return msgRef.id;
  });

  // Post-commit, best-effort fan-out (sp7 ruling 3). One notification per
  // conversation per recipient profile per MESSAGE_NOTIFY_BUCKET_MS: the
  // dedupe key carries the bucket index and notifyUser creates if absent, so
  // a burst does not flood every member's inbox.
  try {
    const bucket = Math.floor(now / MESSAGE_NOTIFY_BUCKET_MS);
    await notifyProfileMembers(toProfileId, {
      kind: "message", refId: pairId,
      refKind: toDoc.type === "curator" ? "curator" : "musician",
      title: messageNotificationTitle(fromDoc.name, toDoc.name),
      body: text.length > MESSAGE_PREVIEW_CHARS ? `${text.slice(0, MESSAGE_PREVIEW_CHARS - 3)}...` : text,
    }, `message:${pairId}:${bucket}`);
  } catch (e) {
    console.error("sendMessage: fan-out failed", pairId, e);
  }

  return { conversationId: pairId, messageId };
});

export const markConversationRead = onCall<{ profileId: string; conversationId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, conversationId } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId)) {
      throw new HttpsError("invalid-argument", "A profile and a conversation are required.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    const ref = db.doc(`conversations/${conversationId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Conversation not found.");
    const conv = snap.data() as ConversationDoc;
    if (!conv.participants.includes(profileId)) {
      throw new HttpsError("permission-denied", "That profile is not in this conversation.");
    }
    // Zeroes only this profile's own counter, on the doc and on this profile's
    // mirror. A batch, not a transaction: both writes touch only this
    // profile's key, so a concurrent send incrementing the OTHER profile's
    // key does not collide, and a send to THIS profile racing the read simply
    // lands as a new unread the next snapshot shows.
    const now = Date.now();
    const batch = db.batch();
    batch.update(ref, { [`unread.${profileId}`]: 0, updatedAt: now });
    batch.set(db.doc(`profiles/${profileId}/conversations/${conversationId}`),
      { unread: 0, updatedAt: now }, { merge: true });
    await batch.commit();
    return { ok: true as const };
  });

export const setConversationBlock = onCall<{ profileId: string; conversationId: string; blocked: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, conversationId, blocked } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId) || typeof blocked !== "boolean") {
      throw new HttpsError("invalid-argument", "A profile, a conversation, and a blocked flag are required.");
    }
    // Admin, not member (spec 3.1): blocking closes the pair for every member
    // of both profiles, so it is a profile-level decision.
    await requireProfileAdmin(profileId, uid);
    const db = getFirestore();
    const ref = db.doc(`conversations/${conversationId}`);
    const blockedBy = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Conversation not found.");
      const conv = snap.data() as ConversationDoc;
      if (!conv.participants.includes(profileId)) {
        throw new HttpsError("permission-denied", "That profile is not in this conversation.");
      }
      // A profile only ever adds or removes its OWN id, so one side cannot
      // lift the other side's block.
      const next = blocked
        ? [...new Set([...conv.blockedBy, profileId])]
        : conv.blockedBy.filter((id) => id !== profileId);
      const now = Date.now();
      tx.update(ref, { blockedBy: next, updatedAt: now });
      // Only the BLOCKER's mirror moves. Writing the other side's row too
      // would be the one place a blocked profile could read a block off its
      // own inbox, which is exactly what spec 3.1 forbids: the block is
      // silent, and the blocked side sees an ordinary thread whose sends are
      // refused with the neutral CONVERSATION_CLOSED_MESSAGE.
      tx.set(db.doc(`profiles/${profileId}/conversations/${conversationId}`),
        { blockedByMe: next.includes(profileId), updatedAt: now }, { merge: true });
      return next;
    });
    return { ok: true as const, blockedBy };
  });

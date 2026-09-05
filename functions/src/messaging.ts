import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Transaction } from "firebase-admin/firestore";
import {
  conversationPairId, validateMessageText, isValidDocId,
  MESSAGE_RATE_MAX, MESSAGE_RATE_WINDOW_MS, MESSAGE_PREVIEW_CHARS, MESSAGE_NOTIFY_BUCKET_MS,
  MESSAGE_RATE_MESSAGE, MESSAGE_UNAPPROVED_MESSAGE, CONVERSATION_CLOSED_MESSAGE,
  messageNotificationTitle,
  type ConversationDoc, type ConversationRefDoc, type ConversationStateDoc,
  type MessageDoc, type MessageWindowDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileMembers } from "./notifications.js";

// SP12 (spec sections 3.1, 4 and 5). Conversations are between exactly one
// musician profile and one curator profile; either side may start one and
// every member of either side can read and reply. Fans are not part of chat
// at all, which is why every entry point here is a profile id, never a uid.
//
// THREE docs describe one conversation, and they are written together:
//
//   conversations/{pairId}                      what BOTH sides may see:
//                                               participants, lastMessage,
//                                               lastMessageAt, openReports.
//   conversations/{pairId}/private/state        the block list. No rule
//                                               matches this path, so
//                                               firestore.rules' terminal
//                                               deny closes it to every
//                                               client, admins included.
//   profiles/{profileId}/conversations/{pairId} one MIRROR per participant
//                                               (ConversationRefDoc), the row
//                                               the inbox list renders, and
//                                               the only home of that
//                                               profile's unread count.
//
// The split is a privacy boundary, not a denormalization for speed. The
// mirror exists because firestore.rules cannot prove a list rule for a
// top-level `participants array-contains` query (see the rules file's own
// comment), so the inbox lists the mirror, ordered by lastMessageAt, and
// opens the top-level doc by id. But "readable by members of either side" is
// also why two fields may NOT sit on the shared doc: an unread MAP would let
// each side watch the other's read activity, and a blockedBy ARRAY would name
// the blocker to the profile it blocked, which spec 3.1 forbids outright (a
// block must be indistinguishable from an unanswered thread). So `unread` is
// per mirror, one number that only that profile's members can read, and
// `blockedBy` is in the private state doc, surfaced to a blocker as
// `blockedByMe` on its OWN mirror and to nobody else in any form.
//
// Task 6 (web inbox) and Task 10 (mobile inbox) read the mirrors; Task 5's
// reports bump `openReports` on both mirrors through writeConversationMirrors.

interface SendMessageInput { fromProfileId: string; toProfileId: string; text: string }

// One sentence for every "you may not touch this conversation" refusal:
// not a member of the profile you are acting as, that profile is not in this
// pair, or the conversation does not exist. Deliberately the SAME text
// requireProfileMember throws, because a pairId is built from two PUBLIC
// profile ids: anyone can construct one, so any difference between these
// three answers would be an oracle telling a stranger which pairs of profiles
// are talking to each other.
// Exported for reports.ts, which has to refuse in exactly the same words for
// exactly the same reason.
export const CONVERSATION_DENIED_MESSAGE = "Only profile members can do that.";

// A mirror write carries FieldValue.increment for `unread` (see below), which
// the plain ConversationRefDoc field type cannot express; every other field
// still gets checked against the real doc shape.
type MirrorWrite = Omit<Partial<ConversationRefDoc>, "unread"> & { unread?: FieldValue };

// Writes BOTH participants' mirrors from one already-computed conversation
// state, inside the caller's transaction.
//
// `blockedBy` comes from the private state doc rather than the conversation,
// and only ever reaches the mirror of a profile that is IN it: each side's
// `blockedByMe` says whether IT blocked the pair, never whether the other
// side did.
//
// `names` maps a profile id to that profile's display name. It may omit a
// side ONLY when that side's mirror already exists (`opts.mirrorExists`),
// because a merge into a missing doc would CREATE a nameless row the inbox
// would render blank; a caller that has neither is refused rather than
// allowed to write a half-formed mirror.
//
// `opts.unreadIncrementFor` names the profile whose unread count goes up by
// one. Every other side gets increment(0), which initializes the field to 0
// on a fresh mirror and leaves an existing count exactly where it was. That
// is why no mirror read is needed to keep the two counts independent.
//
// `opts.skipProfileIds` names sides with NO mirror to write at all, because
// the profile itself is gone: deleteProfile recursively deletes the profile
// doc together with its `conversations` subcollection, so a deleted
// participant has neither a name nor a row, and the rule above would refuse
// the whole write. That refusal used to strand the surviving side (a report
// on the thread failed with `internal`, and the resolve that would have
// cleared it failed the same way, so the row never left the admin panel).
// The counter change on the shared conversation doc is the caller's, and it
// still happens; only the vanished profile's row is skipped.
export function writeConversationMirrors(
  tx: Transaction,
  conversation: ConversationDoc,
  blockedBy: string[],
  names: Record<string, string | undefined>,
  opts: {
    unreadIncrementFor?: string;
    mirrorExists?: Record<string, boolean>;
    skipProfileIds?: string[];
  } = {},
): void {
  const db = getFirestore();
  const pairId = conversationPairId(conversation.musicianProfileId, conversation.curatorProfileId);
  const sides = [
    { me: conversation.musicianProfileId, other: conversation.curatorProfileId, otherType: "curator" as const },
    { me: conversation.curatorProfileId, other: conversation.musicianProfileId, otherType: "musician" as const },
  ];
  for (const side of sides) {
    if (opts.skipProfileIds?.includes(side.me)) continue;
    const otherProfileName = names[side.other];
    if (otherProfileName === undefined && opts.mirrorExists?.[side.me] !== true) {
      throw new HttpsError("internal", "A new conversation mirror needs the other profile's name.");
    }
    const row: MirrorWrite = {
      pairId,
      otherProfileId: side.other,
      otherProfileType: side.otherType,
      lastMessage: conversation.lastMessage,
      lastMessageAt: conversation.lastMessageAt,
      unread: FieldValue.increment(opts.unreadIncrementFor === side.me ? 1 : 0),
      blockedByMe: blockedBy.includes(side.me),
      openReports: conversation.openReports,
      updatedAt: conversation.updatedAt,
      ...(otherProfileName === undefined ? {} : { otherProfileName }),
    };
    tx.set(db.doc(`profiles/${side.me}/conversations/${pairId}`), row, { merge: true });
  }
}

// The two profile ids a conversation id names, or null when the id is not a
// well-formed pair id. Pure string work: it runs BEFORE any read, so an
// unauthorized caller is turned away without the server ever looking up
// whether the conversation exists.
function parsePairId(conversationId: string): { musicianProfileId: string; curatorProfileId: string } | null {
  const parts = conversationId.split("__");
  if (parts.length !== 2) return null;
  const [musicianProfileId, curatorProfileId] = parts;
  if (!isValidDocId(musicianProfileId) || !isValidDocId(curatorProfileId)) return null;
  if (conversationPairId(musicianProfileId, curatorProfileId) !== conversationId) return null;
  return { musicianProfileId, curatorProfileId };
}

// Authorizes a caller against a conversation id with NO read at all: the pair
// ids are in the id itself, so the acting profile either is one of them or it
// is not, and requireProfileMember/Admin proves the caller speaks for it.
// Every failure is the same sentence, so a stranger probing a constructed
// pairId learns nothing about who talks to whom.
//
// Exported for reports.ts: reportConversation authorizes the same way, and a
// second copy of this reasoning is a second chance to get it wrong.
export async function requireConversationParticipant(
  profileId: string, conversationId: string, uid: string, as: "member" | "admin",
): Promise<void> {
  const pair = parsePairId(conversationId);
  if (!pair || (pair.musicianProfileId !== profileId && pair.curatorProfileId !== profileId)) {
    throw new HttpsError("permission-denied", CONVERSATION_DENIED_MESSAGE);
  }
  try {
    if (as === "admin") await requireProfileAdmin(profileId, uid);
    else await requireProfileMember(profileId, uid);
  } catch {
    throw new HttpsError("permission-denied", CONVERSATION_DENIED_MESSAGE);
  }
}

// The pair, in canonical order, plus both profile docs. APPROVAL is checked
// before type, and a missing profile is folded into the same refusal as an
// unapproved one: an approved profile is public, so "this profile is not
// approved" gives nothing away, while "no such profile" would confirm or deny
// the existence of an id a caller only guessed at. Only the same-type
// refusal stays distinct, because both profiles are approved and public by
// the time it can fire.
async function resolvePair(fromProfileId: string, toProfileId: string) {
  const db = getFirestore();
  const [from, to] = await Promise.all([
    db.doc(`profiles/${fromProfileId}`).get(), db.doc(`profiles/${toProfileId}`).get(),
  ]);
  const fromDoc = from.data() as ProfileDoc | undefined;
  const toDoc = to.data() as ProfileDoc | undefined;
  if (fromDoc?.status !== "approved" || toDoc?.status !== "approved") {
    throw new HttpsError("failed-precondition", MESSAGE_UNAPPROVED_MESSAGE);
  }
  if (fromDoc.type === toDoc.type) {
    throw new HttpsError("failed-precondition", "Chat is between a musician profile and a curator profile.");
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
  const stateRef = convRef.collection("private").doc("state");
  // The rate window belongs to the SENDER PROFILE, not to this pair: the cap
  // is 30 per 10 minutes per sender profile across every conversation it
  // takes part in (spec 5). A window kept on the conversation doc would have
  // been one read cheaper and completely wrong: a spammer would simply open a
  // new thread with the next venue and get another 30. Same posture and rules
  // stance as commentWindows/{uid} and geocodeBudgets/{uid}.
  const windowRef = db.doc(`messageWindows/${fromProfileId}`);
  const now = Date.now();

  // One transaction does the whole write: read the conversation (or decide it
  // is new), the private block state, AND the sender's window, check the
  // block list and the cap, append the message, roll lastMessage /
  // lastMessageAt, refresh both mirrors (incrementing only the RECIPIENT's
  // unread), and trim the window. All THREE reads precede every write
  // (sp7 ruling 4), which is why they are issued together up top, and no
  // external call happens inside.
  const messageId = await db.runTransaction(async (tx) => {
    const [snap, stateSnap, windowSnap] = await Promise.all([
      tx.get(convRef), tx.get(stateRef), tx.get(windowRef),
    ]);
    const existing = snap.exists ? (snap.data() as ConversationDoc) : null;
    const blockedBy = (stateSnap.data() as ConversationStateDoc | undefined)?.blockedBy ?? [];
    if (blockedBy.length > 0) {
      // Neutral in BOTH directions: the blocked side must not learn it was
      // blocked, and the blocking side sees its own banner client-side, off
      // its own mirror's blockedByMe.
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
    // deriving it twice is how the copies drift apart. Spreading `existing`
    // inside the transaction keeps openReports and createdAt intact; a
    // concurrent change to either retries the whole thing, mirrors included.
    const next: ConversationDoc = existing
      ? {
        ...existing,
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        updatedAt: now,
      }
      : {
        musicianProfileId, curatorProfileId,
        participants: [musicianProfileId, curatorProfileId],
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        openReports: 0,
        createdAt: now, updatedAt: now,
      };
    tx.set(convRef, next);
    // The state doc is created with the conversation and then only ever
    // touched by setConversationBlock, so a send never rewrites a block.
    if (!stateSnap.exists) {
      tx.set(stateRef, { blockedBy: [], updatedAt: now } satisfies ConversationStateDoc);
    }
    writeConversationMirrors(tx, next, blockedBy,
      { [fromProfileId]: fromDoc.name, [toProfileId]: toDoc.name },
      { unreadIncrementFor: toProfileId });
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
    await requireConversationParticipant(profileId, conversationId, uid, "member");

    // The unread count lives only on this profile's own mirror now, so this
    // touches exactly one doc and cannot disturb the other side's count. A
    // missing conversation answers with the same refusal as a missing
    // membership (no not-found anywhere on this callable, see
    // CONVERSATION_DENIED_MESSAGE), and a missing mirror is left missing
    // rather than conjured into a nameless row.
    const db = getFirestore();
    if (!(await db.doc(`conversations/${conversationId}`).get()).exists) {
      throw new HttpsError("permission-denied", CONVERSATION_DENIED_MESSAGE);
    }
    const mirrorRef = db.doc(`profiles/${profileId}/conversations/${conversationId}`);
    if (!(await mirrorRef.get()).exists) return { ok: true as const };
    await mirrorRef.update({ unread: 0, updatedAt: Date.now() });
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
    // of both profiles, so it is a profile-level decision. Authorized off the
    // pair id before any read, like markConversationRead above.
    await requireConversationParticipant(profileId, conversationId, uid, "admin");

    const db = getFirestore();
    const stateRef = db.doc(`conversations/${conversationId}`).collection("private").doc("state");
    const mirrorRef = db.doc(`profiles/${profileId}/conversations/${conversationId}`);
    const blockedBy = await db.runTransaction(async (tx) => {
      const [stateSnap, mirrorSnap] = await Promise.all([tx.get(stateRef), tx.get(mirrorRef)]);
      // The state doc is created with the conversation, so its absence means
      // there is no conversation: same refusal as every other one here.
      if (!stateSnap.exists) throw new HttpsError("permission-denied", CONVERSATION_DENIED_MESSAGE);
      const state = stateSnap.data() as ConversationStateDoc;
      // A profile only ever adds or removes its OWN id, so one side cannot
      // lift the other side's block.
      const next = blocked
        ? [...new Set([...state.blockedBy, profileId])]
        : state.blockedBy.filter((id) => id !== profileId);
      const now = Date.now();
      tx.set(stateRef, { blockedBy: next, updatedAt: now } satisfies ConversationStateDoc);
      // Only the BLOCKER's mirror moves, and it is the only place a block is
      // visible to anyone. Writing the other side's row would be the one
      // place a blocked profile could read a block off its own inbox, which
      // is exactly what spec 3.1 forbids: the block is silent, and the
      // blocked side sees an ordinary thread whose sends are refused with the
      // neutral CONVERSATION_CLOSED_MESSAGE.
      if (mirrorSnap.exists) {
        tx.update(mirrorRef, { blockedByMe: next.includes(profileId), updatedAt: now });
      }
      return next;
    });
    // Deliberately NOT the whole block list. The brief's produces contract
    // said `{ ok, blockedBy: string[] }`, but that array can contain the
    // OTHER side's id, and handing it back to this caller would leak, through
    // the callable's return value, exactly what fix round 1 just moved off
    // the readable conversation doc. A blocker only ever needs its own state,
    // which is also what its mirror carries.
    return { ok: true as const, blockedByMe: blockedBy.includes(profileId) };
  });

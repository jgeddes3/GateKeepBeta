import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection, collectionGroup, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where,
} from "firebase/firestore";

// Sub-project 12 rules matrix. Everything below is read-only for clients:
// sendMessage, postComment, the report callables, and resolveReport own
// every write, so each block also proves the client cannot write.

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

const PAIR = "mus1__cur1";

// The two profiles and their owning members, and nothing else: the state of
// a pair that has never exchanged a message.
async function seedProfiles() {
  await seed("profiles/mus1", { type: "musician", status: "approved", name: "The Act" });
  await seed("profiles/cur1", { type: "curator", status: "approved", name: "The Room" });
  await seed("profiles/mus1/members/mo", { uid: "mo", role: "admin", label: "", joinedAt: 1 });
  await seed("profiles/cur1/members/co", { uid: "co", role: "admin", label: "", joinedAt: 1 });
}

async function seedPair() {
  await seedProfiles();
  // Task 3 fix round 1: the conversation doc carries ONLY what both sides may
  // see. The unread map and the block list moved off it (a member of either
  // side can read this doc, which made the map a read-receipt leak and the
  // list a way for a blocked profile to learn it was blocked).
  await seed(`conversations/${PAIR}`, {
    musicianProfileId: "mus1", curatorProfileId: "cur1", participants: ["mus1", "cur1"],
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    openReports: 0, createdAt: 1, updatedAt: 2,
  });
  await seed(`conversations/${PAIR}/private/state`, { blockedBy: ["cur1"], updatedAt: 3 });
  await seed(`conversations/${PAIR}/messages/m1`, { senderProfileId: "mus1", senderUid: "mo", text: "hi", at: 2 });
  // Per-profile mirrors, written by the same messaging callable transaction
  // that writes the top-level doc (Task 3): the inbox list query targets
  // these, never the top-level collection, since a top-level
  // participants array-contains list can't be proven by security rules.
  // They also hold the two per-side fields, each readable only by its own
  // profile's members.
  await seed(`profiles/mus1/conversations/${PAIR}`, {
    pairId: PAIR, otherProfileId: "cur1", otherProfileName: "The Room", otherProfileType: "curator",
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: 0, blockedByMe: false, openReports: 0, updatedAt: 2,
  });
  await seed(`profiles/cur1/conversations/${PAIR}`, {
    pairId: PAIR, otherProfileId: "mus1", otherProfileName: "The Act", otherProfileType: "musician",
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: 1, blockedByMe: true, openReports: 0, updatedAt: 3,
  });
}

describe("conversations and messages", () => {
  it("lets members of either side get the doc, the message, and list their own messages", async () => {
    await seedPair();
    for (const uid of ["mo", "co"]) {
      const db = env.authenticatedContext(uid).firestore();
      await assertSucceeds(getDoc(doc(db, `conversations/${PAIR}`)));
      await assertSucceeds(getDoc(doc(db, `conversations/${PAIR}/messages/m1`)));
      await assertSucceeds(getDocs(query(collection(db, `conversations/${PAIR}/messages`), orderBy("at", "asc"))));
    }
  });

  it("denies a messages listen on a pair that has never been messaged", async () => {
    await seedProfiles();
    // No conversations/{PAIR} doc, because nobody has sent anything yet. The
    // messages rule proves its audience with a get() on that parent, and a
    // get() on a doc that does not exist yields no data to read
    // musicianProfileId off, so the listen is denied even for a real member of
    // either side.
    //
    // That denial is the intended posture, not a bug: the web and mobile
    // thread screens attach the messages listener only once this profile's
    // mirror row exists, and the mirror is written in the same transaction as
    // the first message. A rule that answered "allowed, empty" for a
    // non-existent parent would have to fall back to something other than the
    // parent's participant ids, and the only candidates (a path-derived pair
    // id, an unbound resource.data) are exactly what the comments above this
    // block rule out.
    for (const uid of ["mo", "co"]) {
      const db = env.authenticatedContext(uid).firestore();
      await assertFails(getDocs(query(collection(db, `conversations/${PAIR}/messages`), orderBy("at"))));
    }
  });

  it("lists a profile's own conversation mirror only, never another profile's, a stranger's, or an admin's", async () => {
    await seedPair();
    const mine = env.authenticatedContext("mo").firestore();
    await assertSucceeds(getDocs(query(
      collection(mine, "profiles/mus1/conversations"), orderBy("lastMessageAt", "desc"))));
    // co is a real member, just of the OTHER profile in this pair.
    const otherSide = env.authenticatedContext("co").firestore();
    await assertFails(getDocs(query(
      collection(otherSide, "profiles/mus1/conversations"), orderBy("lastMessageAt", "desc"))));
    const stranger = env.authenticatedContext("zz").firestore();
    await assertFails(getDocs(query(
      collection(stranger, "profiles/mus1/conversations"), orderBy("lastMessageAt", "desc"))));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDocs(query(
      collection(admin, "profiles/mus1/conversations"), orderBy("lastMessageAt", "desc"))));
    // An anonymous caller cannot list the mirror either; membership needs a
    // signed-in uid, not merely a wildcard-scoped path.
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(
      collection(anon, "profiles/mus1/conversations"), orderBy("lastMessageAt", "desc"))));
    // The mirror is server-written only, even for a genuine member.
    await assertFails(setDoc(doc(mine, `profiles/mus1/conversations/${PAIR}`), { unread: 0 }));
  });

  it("nobody lists top-level conversations; strangers, anonymous callers, and every client write are refused", async () => {
    await seedPair();
    const stranger = env.authenticatedContext("zz").firestore();
    await assertFails(getDoc(doc(stranger, `conversations/${PAIR}`)));
    await assertFails(getDoc(doc(stranger, `conversations/${PAIR}/messages/m1`)));
    await assertFails(getDocs(query(
      collection(stranger, "conversations"),
      where("participants", "array-contains", "mus1"), orderBy("lastMessageAt", "desc"))));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, `conversations/${PAIR}`)));
    const member = env.authenticatedContext("mo").firestore();
    // List is closed outright (allow list: if false), even for a real
    // member of the exact conversation the filter targets.
    await assertFails(getDocs(query(
      collection(member, "conversations"),
      where("participants", "array-contains", "mus1"), orderBy("lastMessageAt", "desc"))));
    await assertFails(updateDoc(doc(member, `conversations/${PAIR}`), { lastMessageAt: 99 }));
    await assertFails(setDoc(doc(member, `conversations/${PAIR}/messages/m2`),
      { senderProfileId: "mus1", senderUid: "mo", text: "sneak", at: 3 }));
  });

  it("hides the private block state from BOTH participants, an admin, and a stranger", async () => {
    await seedPair();
    // No rule matches conversations/{pairId}/private/{doc}, so the terminal
    // `match /{document=**}` deny closes it. That is the whole point of
    // moving blockedBy here: cur1 blocked mus1, and mus1's members must not
    // be able to tell a block from an unanswered thread (spec 3.1). The
    // blocker learns its own state from its own mirror instead, which is why
    // profiles/cur1/conversations/{PAIR}.blockedByMe is readable above and
    // profiles/mus1's copy says nothing.
    for (const uid of ["mo", "co", "zz"]) {
      const db = env.authenticatedContext(uid).firestore();
      await assertFails(getDoc(doc(db, `conversations/${PAIR}/private/state`)));
      await assertFails(getDocs(collection(db, `conversations/${PAIR}/private`)));
      await assertFails(setDoc(doc(db, `conversations/${PAIR}/private/state`), { blockedBy: [], updatedAt: 9 }));
    }
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, `conversations/${PAIR}/private/state`)));
    // Even on a REPORTED conversation, which is the one case an admin may get
    // the parent doc, the block state stays closed.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `conversations/${PAIR}`), { openReports: 1 });
    });
    await assertSucceeds(getDoc(doc(admin, `conversations/${PAIR}`)));
    await assertFails(getDoc(doc(admin, `conversations/${PAIR}/private/state`)));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, `conversations/${PAIR}/private/state`)));
  });

  it("lets an admin get a REPORTED conversation only", async () => {
    await seedPair();
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, `conversations/${PAIR}`)));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `conversations/${PAIR}`), { openReports: 1 });
    });
    await assertSucceeds(getDoc(doc(admin, `conversations/${PAIR}`)));
    await assertSucceeds(getDoc(doc(admin, `conversations/${PAIR}/messages/m1`)));
    // List is closed outright, reported or not; an admin still cannot scan
    // the collection, only get() one conversation at a time by id.
    await assertFails(getDocs(collection(admin, "conversations")));
  });
});

describe("collection-group queries stay scoped to their parent, never a cross-cutting scan", () => {
  it("a signed-in member cannot collectionGroup messages, comments, or conversations", async () => {
    await seedPair();
    await seed("events/ev1", {
      curatorProfileId: "cur1", title: "Night", status: "published",
      lineup: [], lineupMusicianProfileIds: [], startsAt: 10, endsAt: 20,
    });
    await seed("events/ev1/comments/c1", {
      authorUid: "fan1", authorName: "Fan", authorRole: "fan", authorProfileId: null,
      parentId: null, text: "great", hidden: false, hiddenBy: null, openReports: 0, at: 5,
    });
    const member = env.authenticatedContext("mo").firestore();
    // "messages" exists only nested under one conversation, "comments" only
    // nested under one event, and "conversations" exists both top-level
    // (list closed outright) and under profiles/{id} (list needs a bound
    // profileId): none of the three can be proven across the whole
    // database, so a bare collectionGroup scan fails for all of them.
    await assertFails(getDocs(collectionGroup(member, "messages")));
    await assertFails(getDocs(collectionGroup(member, "comments")));
    await assertFails(getDocs(collectionGroup(member, "conversations")));
  });
});

describe("reports", () => {
  it("is admin-read and client-unwritable", async () => {
    await seed("reports/r1", {
      kind: "comment", targetPath: "events/ev1/comments/c1", reporterUid: "fan1",
      reporterProfileId: null, offenderUid: "fan2", reason: "spam", status: "open",
      resolvedBy: null, resolvedAt: null,
      // Task 5 fix round 1: a reopen keeps the resolution it followed rather
      // than overwriting it, so every report row carries this history.
      reopenCount: 0, lastResolvedBy: null, lastResolvedAt: null, createdAt: 1,
    });
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "reports/r1")));
    await assertSucceeds(getDocs(query(
      collection(admin, "reports"), where("status", "==", "open"), orderBy("createdAt", "desc"))));
    const fan = env.authenticatedContext("fan1").firestore();
    await assertFails(getDoc(doc(fan, "reports/r1")));
    await assertFails(setDoc(doc(fan, "reports/r2"), { kind: "comment", status: "open" }));
    await assertFails(updateDoc(doc(admin, "reports/r1"), { status: "resolved" }));
  });
});

describe("event comments, reactions, and post hearts", () => {
  const seedEvent = async () => {
    await seed("events/ev1", {
      curatorProfileId: "cur1", title: "Night", status: "published",
      lineup: [], lineupMusicianProfileIds: [], startsAt: 10, endsAt: 20,
    });
    await seed("events/ev1/comments/c1", {
      authorUid: "fan1", authorName: "Fan", authorRole: "fan", authorProfileId: null,
      parentId: null, text: "great", hidden: false, hiddenBy: null, openReports: 0, at: 5,
    });
    await seed("events/ev1/comments/c2", {
      authorUid: "fan2", authorName: "Other", authorRole: "fan", authorProfileId: null,
      parentId: null, text: "bad", hidden: true, hiddenBy: { uid: "co", role: "curator" }, openReports: 1, at: 6,
    });
    await seed("events/ev1/reactions/fan1", { going: true, at: 5 });
    await seed("events/ev1/posts/p1", {
      eventId: "ev1", musicianProfileId: "mus1", authorUid: "mo", text: "see you",
      createdAt: 4, status: "live", heartCount: 1,
    });
    await seed("events/ev1/posts/p1/hearts/fan1", { at: 5 });
  };

  it("shows visible comments to any signed-in caller and hides hidden ones from non-admins", async () => {
    await seedEvent();
    const fan = env.authenticatedContext("fan1").firestore();
    await assertSucceeds(getDoc(doc(fan, "events/ev1/comments/c1")));
    await assertFails(getDoc(doc(fan, "events/ev1/comments/c2")));
    await assertSucceeds(getDocs(query(
      collection(fan, "events/ev1/comments"), where("hidden", "==", false), orderBy("at", "desc"))));
    // An unpinned list would include the hidden doc, so it must fail.
    await assertFails(getDocs(query(collection(fan, "events/ev1/comments"), orderBy("at", "desc"))));
    // Even fan2, who wrote comment c2, cannot read it once it's hidden:
    // hidden means hidden from the author too, not just other fans.
    const author = env.authenticatedContext("fan2").firestore();
    await assertFails(getDoc(doc(author, "events/ev1/comments/c2")));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "events/ev1/comments/c1")));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "events/ev1/comments/c2")));
    await assertSucceeds(getDocs(query(collection(admin, "events/ev1/comments"), orderBy("at", "desc"))));
  });

  it("lets only the reacting or hearting uid, or an admin, read that one doc; refuses every list and every client write", async () => {
    await seedEvent();
    const fan = env.authenticatedContext("fan1").firestore();
    await assertSucceeds(getDoc(doc(fan, "events/ev1/reactions/fan1")));
    await assertSucceeds(getDoc(doc(fan, "events/ev1/posts/p1/hearts/fan1")));
    // Nobody signed in may list the roster of who reacted or hearted; the
    // counts on the parent event/post docs are the only public aggregate.
    await assertFails(getDocs(collection(fan, "events/ev1/reactions")));
    await assertFails(getDocs(collection(fan, "events/ev1/posts/p1/hearts")));
    // A stranger cannot read fan1's reaction or heart by uid either.
    const stranger = env.authenticatedContext("zz").firestore();
    await assertFails(getDoc(doc(stranger, "events/ev1/reactions/fan1")));
    await assertFails(getDoc(doc(stranger, "events/ev1/posts/p1/hearts/fan1")));
    // An admin, exercising the isAdmin() branch, may still get either.
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "events/ev1/reactions/fan1")));
    await assertSucceeds(getDoc(doc(admin, "events/ev1/posts/p1/hearts/fan1")));
    await assertFails(setDoc(doc(fan, "events/ev1/reactions/fan1"), { going: false, at: 9 }));
    await assertFails(setDoc(doc(fan, "events/ev1/posts/p1/hearts/fan1"), { at: 9 }));
    await assertFails(setDoc(doc(fan, "events/ev1/comments/c3"),
      { authorUid: "fan1", text: "sneak", hidden: false, at: 9 }));
    await assertFails(updateDoc(doc(fan, "events/ev1/comments/c1"), { hidden: true }));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "events/ev1/reactions/fan1")));
  });
});

describe("the rate-limit windows", () => {
  it("keeps commentWindows, messageWindows, and reportWindows invisible to owners, members, and admins", async () => {
    await seedPair();
    await seed("commentWindows/fan1", { at: [1, 2, 3] });
    await seed("messageWindows/mus1", { at: [1, 2, 3] });
    await seed("reportWindows/fan1", { at: [1, 2, 3] });
    const fan = env.authenticatedContext("fan1").firestore();
    await assertFails(getDoc(doc(fan, "commentWindows/fan1")));
    await assertFails(setDoc(doc(fan, "commentWindows/fan1"), { at: [] }));
    // The report cap is server bookkeeping too: a reporter cannot read how
    // much of their own window is left, or clear it.
    await assertFails(getDoc(doc(fan, "reportWindows/fan1")));
    await assertFails(setDoc(doc(fan, "reportWindows/fan1"), { at: [] }));
    // A member of the very profile the window belongs to still cannot read
    // it: the window is server bookkeeping, not a user-facing quota display.
    const member = env.authenticatedContext("mo").firestore();
    await assertFails(getDoc(doc(member, "messageWindows/mus1")));
    await assertFails(setDoc(doc(member, "messageWindows/mus1"), { at: [] }));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, "commentWindows/fan1")));
    await assertFails(getDoc(doc(admin, "messageWindows/mus1")));
    await assertFails(getDoc(doc(admin, "reportWindows/fan1")));
  });
});

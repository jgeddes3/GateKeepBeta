import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";

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

async function seedPair() {
  await seed("profiles/mus1", { type: "musician", status: "approved", name: "The Act" });
  await seed("profiles/cur1", { type: "curator", status: "approved", name: "The Room" });
  await seed("profiles/mus1/members/mo", { uid: "mo", role: "admin", label: "", joinedAt: 1 });
  await seed("profiles/cur1/members/co", { uid: "co", role: "admin", label: "", joinedAt: 1 });
  await seed(`conversations/${PAIR}`, {
    musicianProfileId: "mus1", curatorProfileId: "cur1", participants: ["mus1", "cur1"],
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: { cur1: 1 }, blockedBy: [], openReports: 0, createdAt: 1, updatedAt: 2,
  });
  await seed(`conversations/${PAIR}/messages/m1`, { senderProfileId: "mus1", senderUid: "mo", text: "hi", at: 2 });
  // Per-profile mirrors, written by the same messaging callable transaction
  // that writes the top-level doc (Task 3): the inbox list query targets
  // these, never the top-level collection, since a top-level
  // participants array-contains list can't be proven by security rules.
  await seed(`profiles/mus1/conversations/${PAIR}`, {
    otherProfileId: "cur1", otherProfileName: "The Room", otherProfileType: "curator",
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: 0, blockedByMe: false, openReports: 0,
  });
  await seed(`profiles/cur1/conversations/${PAIR}`, {
    otherProfileId: "mus1", otherProfileName: "The Act", otherProfileType: "musician",
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: 1, blockedByMe: false, openReports: 0,
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
    // The mirror is server-written only, even for a genuine member.
    await assertFails(setDoc(doc(mine, `profiles/mus1/conversations/${PAIR}`), { unread: 0 }));
  });

  it("refuses strangers, anonymous callers, and every client write", async () => {
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
    await assertFails(updateDoc(doc(member, `conversations/${PAIR}`), { unread: { cur1: 0 } }));
    await assertFails(setDoc(doc(member, `conversations/${PAIR}/messages/m2`),
      { senderProfileId: "mus1", senderUid: "mo", text: "sneak", at: 3 }));
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
    // Still no bulk sweep of every conversation, reported or not.
    await assertFails(getDocs(collection(admin, "conversations")));
  });
});

describe("reports", () => {
  it("is admin-read and client-unwritable", async () => {
    await seed("reports/r1", {
      kind: "comment", targetPath: "events/ev1/comments/c1", reporterUid: "fan1",
      reporterProfileId: null, reason: "spam", status: "open",
      resolvedBy: null, resolvedAt: null, createdAt: 1,
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
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "events/ev1/comments/c1")));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "events/ev1/comments/c2")));
    await assertSucceeds(getDocs(query(collection(admin, "events/ev1/comments"), orderBy("at", "desc"))));
  });

  it("shows reactions and hearts to any signed-in caller and refuses every client write", async () => {
    await seedEvent();
    const fan = env.authenticatedContext("fan1").firestore();
    await assertSucceeds(getDoc(doc(fan, "events/ev1/reactions/fan1")));
    await assertSucceeds(getDoc(doc(fan, "events/ev1/posts/p1/hearts/fan1")));
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
  it("keeps commentWindows and messageWindows invisible to owners, members, and admins", async () => {
    await seedPair();
    await seed("commentWindows/fan1", { at: [1, 2, 3] });
    await seed("messageWindows/mus1", { at: [1, 2, 3] });
    const fan = env.authenticatedContext("fan1").firestore();
    await assertFails(getDoc(doc(fan, "commentWindows/fan1")));
    await assertFails(setDoc(doc(fan, "commentWindows/fan1"), { at: [] }));
    // A member of the very profile the window belongs to still cannot read
    // it: the window is server bookkeeping, not a user-facing quota display.
    const member = env.authenticatedContext("mo").firestore();
    await assertFails(getDoc(doc(member, "messageWindows/mus1")));
    await assertFails(setDoc(doc(member, "messageWindows/mus1"), { at: [] }));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, "commentWindows/fan1")));
    await assertFails(getDoc(doc(admin, "messageWindows/mus1")));
  });
});

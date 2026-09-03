import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where,
} from "firebase/firestore";

// Sub-project 7 (fan discovery) rules matrix: follows/{uid}_{targetId} and
// events/{eventId}/posts/{postId}, plus the discovery list queries (events by
// genre/free flag, profiles by genre/type) that must stay list-provable on
// the existing rules those collections already carry.
//
// Its own file rather than more describes in rules.test.ts, same reasoning
// as events.rules.test.ts: a fresh matrix deserves its own file rather than
// growing the already-large rules.test.ts further. Same harness, same
// seeding idiom, same projectId; the suite runs with --no-file-parallelism
// (tests-rules/package.json), so this file never shares emulator state with
// the others.

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
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
};

const seedFollow = (uid: string, targetId: string, targetType = "musician") =>
  seed(`follows/${uid}_${targetId}`, { uid, targetId, targetType, createdAt: 1 });
const seedEvent = (id: string, status = "published", curatorProfileId = "prof1") =>
  seed(`events/${id}`, { curatorProfileId, title: "T", description: "", status, startsAt: 1, endsAt: 2,
    location: { venueName: "V", neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
    posterPath: null, maxTicketsPerBuyer: 8, lineup: [], lineupMusicianProfileIds: [], gigId: null, createdAt: 1, updatedAt: 1 });
const seedPost = (eventId: string, postId: string, status = "live", musicianProfileId = "mus1") =>
  seed(`events/${eventId}/posts/${postId}`, { eventId, musicianProfileId, authorUid: "musowner", text: "See you there", createdAt: 1, status });

describe("follows", () => {
  it("owner can get and list their own follows; others cannot", async () => {
    await seedFollow("bob", "mus1");
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(bob, "follows/bob_mus1")));
    await assertSucceeds(getDocs(query(collection(bob, "follows"), where("uid", "==", "bob"))));
    const carol = env.authenticatedContext("carol").firestore();
    await assertFails(getDoc(doc(carol, "follows/bob_mus1")));
    await assertFails(getDocs(query(collection(carol, "follows"), where("uid", "==", "bob"))));
    await assertFails(getDocs(query(collection(carol, "follows"), where("targetId", "==", "mus1"))));
  });
  it("nobody writes follows from a client, not even admin", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(setDoc(doc(bob, "follows/bob_mus2"), { uid: "bob", targetId: "mus2", targetType: "musician", createdAt: 1 }));
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(root, "follows/bob_mus2"), { uid: "bob", targetId: "mus2", targetType: "musician", createdAt: 1 }));
  });
});

describe("show posts", () => {
  beforeEach(async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/mus1/members/musowner", { uid: "musowner", role: "admin" });
  });
  it("anyone reads a live post on a published event, including anonymous", async () => {
    await seedEvent("ev1"); await seedPost("ev1", "p1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev1/posts/p1")));
    await assertSucceeds(getDocs(query(collection(anon, "events/ev1/posts"), where("status", "==", "live"))));
  });
  it("the per-act thread query (status plus musicianProfileId) lists anonymously", async () => {
    // ShowPosts.tsx's own fetchLivePosts on both platforms: two equality
    // clauses, no orderBy. The status pin the rules require is still in the
    // query, so narrowing to one act does not cost the proof.
    await seedEvent("ev1"); await seedPost("ev1", "p1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDocs(query(collection(anon, "events/ev1/posts"),
      where("status", "==", "live"), where("musicianProfileId", "==", "mus1"))));
  });
  it("a removed post is hidden from the public but visible to the author profile, curator members, and admin", async () => {
    await seedEvent("ev1"); await seedPost("ev1", "p1", "removed");
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "events/ev1/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("root", { admin: true }).firestore(), "events/ev1/posts/p1")));
  });
  it("a live post on a draft event is not public", async () => {
    await seedEvent("ev2", "draft"); await seedPost("ev2", "p1");
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "events/ev2/posts/p1")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "events/ev2/posts/p1")));
  });
  it("a signed-in stranger who is no one's member is denied a removed post and a live post on a draft event", async () => {
    await seedEvent("ev1"); await seedPost("ev1", "p1", "removed");
    const dave = env.authenticatedContext("dave").firestore();
    await assertFails(getDoc(doc(dave, "events/ev1/posts/p1")));
    await seedEvent("ev2", "draft"); await seedPost("ev2", "p1");
    await assertFails(getDoc(doc(dave, "events/ev2/posts/p1")));
  });
  it("anyone reads a live post on a completed event, including anonymous", async () => {
    await seedEvent("ev3", "completed"); await seedPost("ev3", "p1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev3/posts/p1")));
    await assertSucceeds(getDocs(query(collection(anon, "events/ev3/posts"), where("status", "==", "live"))));
  });
  it("no client writes posts", async () => {
    await seedEvent("ev1");
    await assertFails(setDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p9"),
      { eventId: "ev1", musicianProfileId: "mus1", authorUid: "musowner", text: "hi", createdAt: 1, status: "live" }));
    await seedPost("ev1", "p1");
    await assertFails(updateDoc(doc(env.authenticatedContext("root", { admin: true }).firestore(), "events/ev1/posts/p1"), { status: "removed" }));
    await assertFails(deleteDoc(doc(env.authenticatedContext("musowner").firestore(), "events/ev1/posts/p1")));
  });
});

describe("discovery list queries stay provable", () => {
  it("published events by genre and by free flag list anonymously", async () => {
    await seedEvent("ev1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDocs(query(collection(anon, "events"), where("status", "==", "published"), where("genres", "array-contains", "jazz"))));
    await assertSucceeds(getDocs(query(collection(anon, "events"), where("status", "==", "published"), where("hasFreeTier", "==", true))));
    await assertFails(getDocs(query(collection(anon, "events"), where("genres", "array-contains", "jazz"))));
  });
  it("approved musicians by genre list anonymously; unpinned profile lists fail", async () => {
    await seed("profiles/mus1", { type: "musician", subtype: "solo", name: "A", handle: "a", status: "approved", portfolio: { genres: ["jazz"] } });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDocs(query(collection(anon, "profiles"), where("type", "==", "musician"), where("status", "==", "approved"), where("portfolio.genres", "array-contains", "jazz"))));
    await assertFails(getDocs(query(collection(anon, "profiles"), where("type", "==", "musician"))));
  });
});

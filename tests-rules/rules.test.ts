import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, collectionGroup, query, where, orderBy } from "firebase/firestore";

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

describe("users", () => {
  it("owner reads and updates own doc; strangers cannot", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "users/alice")));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { displayName: "Alice L" }));
    await assertFails(getDoc(doc(bob, "users/alice")));
    await assertFails(updateDoc(doc(bob, "users/alice"), { displayName: "hacked" }));
  });
  it("clients cannot create users docs (functions do)", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "users/alice"), { displayName: "Alice" }));
  });
  it("owner cannot update email via hasOnly-restricted update", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice"), { email: "changed@x.com" }));
  });
  it("owner update enforces type/size constraints on displayName, photoUrl, homeCity", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "x".repeat(81) }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { displayName: "x".repeat(80) }));
    await assertFails(updateDoc(doc(alice, "users/alice"), { photoUrl: "http://insecure.example/pic.png" }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { photoUrl: "https://example.com/pic.png" }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { photoUrl: null }));
    await assertFails(updateDoc(doc(alice, "users/alice"), { homeCity: "x".repeat(81) }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { homeCity: "Austin" }));
  });
});

describe("pushTokens", () => {
  it("owner reads own pushTokens; stranger cannot", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/pushTokens/ExponentPushToken[abc123]", { createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "users/alice/pushTokens/ExponentPushToken[abc123]")));
    await assertFails(getDoc(doc(bob, "users/alice/pushTokens/ExponentPushToken[abc123]")));
  });
  it("owner may only write well-formed token ids with a createdAt-only payload; stranger cannot write at all", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(setDoc(doc(alice, "users/alice/pushTokens/ExponentPushToken[xyz789]"), { createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, "users/alice/pushTokens/not-a-token"), { createdAt: Date.now() }));
    await assertFails(setDoc(
      doc(alice, "users/alice/pushTokens/ExponentPushToken[extrafield]"),
      { createdAt: Date.now(), token: "sneaking-in-an-extra-field" },
    ));
    await assertFails(setDoc(doc(bob, "users/alice/pushTokens/ExponentPushToken[hacked]"), { createdAt: Date.now() }));
  });
});

describe("profiles", () => {
  it("anyone (even signed out) reads approved; only members read pending", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    await seed("profiles/p2", { name: "Secret", status: "pending_review" });
    await seed("profiles/p2/members/alice", { uid: "alice", role: "admin" });
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/p1")));
    await assertSucceeds(getDoc(doc(alice, "profiles/p2")));
    await assertFails(getDoc(doc(bob, "profiles/p2")));
  });
  it("no client may write profiles, members, handles, auditLogs, invites", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "profiles/p1"), { status: "approved" }));
    await assertFails(setDoc(doc(alice, "profiles/p1/members/alice"), { role: "admin" }));
    await assertFails(setDoc(doc(alice, "handles/owls"), { profileId: "p1" }));
    await assertFails(setDoc(doc(alice, "auditLogs/x"), { action: "profile_approved" }));
    await assertFails(setDoc(doc(alice, "invites/i1"), { invitedUid: "alice" }));
  });
  it("members are get-readable by anyone for approved profiles, but LIST is restricted to members/admins", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    await seed("profiles/p1/members/alice", { uid: "alice", role: "admin", label: "vocals" });
    const anon = env.unauthenticatedContext().firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const alice = env.authenticatedContext("alice").firestore();
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();
    // Single-doc get by known id stays world-readable for approved profiles...
    await assertSucceeds(getDoc(doc(anon, "profiles/p1/members/alice")));
    // ...but listing the whole roster (which would dump every member, even
    // of an approved profile, to anyone) is restricted to members/admins.
    await assertFails(getDocs(collection(anon, "profiles/p1/members")));
    await assertFails(getDocs(collection(bob, "profiles/p1/members")));
    await assertSucceeds(getDocs(collection(alice, "profiles/p1/members")));
    await assertSucceeds(getDocs(collection(adminCtx, "profiles/p1/members")));
  });
  it("member self-read: reads own member doc under a non-approved profile; a stranger cannot", async () => {
    await seed("profiles/p3", { name: "Hidden", status: "pending_review" });
    await seed("profiles/p3/members/alice", { uid: "alice", role: "admin", label: "guitar" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "profiles/p3/members/alice")));
    await assertFails(getDoc(doc(bob, "profiles/p3/members/alice")));
  });
});

describe("handles", () => {
  it("get succeeds for anyone (the public profile page's lookup path); list is denied", async () => {
    await seed("handles/owls", { profileId: "p1" });
    await seed("handles/other", { profileId: "p2" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "handles/owls")));
    // Listing would dump every handle, including draft/rejected profiles'
    // handles, to any unauthenticated caller.
    await assertFails(getDocs(collection(anon, "handles")));
  });
});

describe("collection-group members query", () => {
  it("member finds their own membership doc via collectionGroup('members'); a stranger's query for someone else's uid fails; admin's query for another uid succeeds", async () => {
    await seed("profiles/p3", { name: "Hidden", status: "pending_review" });
    await seed("profiles/p3/members/alice", { uid: "alice", role: "admin", label: "guitar" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();

    const aliceSnap = await assertSucceeds(
      getDocs(query(collectionGroup(alice, "members"), where("uid", "==", "alice")))
    );
    if (aliceSnap.empty) throw new Error("expected alice's membership doc to be returned by the collection-group query");

    await assertFails(getDocs(query(collectionGroup(bob, "members"), where("uid", "==", "alice"))));

    // Admin dashboard's per-user "profiles and statuses" lookup relies on
    // this: an admin can run the same collection-group query for any uid.
    const adminSnap = await assertSucceeds(
      getDocs(query(collectionGroup(adminCtx, "members"), where("uid", "==", "alice")))
    );
    if (adminSnap.empty) throw new Error("expected admin's collection-group query to return alice's membership doc");
  });
});

describe("admin reads", () => {
  it("admin token reads pending profiles, auditLogs, any user; non-admin cannot", async () => {
    await seed("profiles/p9", { name: "Pending", status: "pending_review" });
    await seed("auditLogs/l1", { action: "profile_approved", actorUid: "x" });
    await seed("users/target", { displayName: "T", email: "t@x.com" });
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();
    const normal = env.authenticatedContext("norm").firestore();
    await assertSucceeds(getDoc(doc(adminCtx, "profiles/p9")));
    await assertSucceeds(getDoc(doc(adminCtx, "auditLogs/l1")));
    await assertSucceeds(getDoc(doc(adminCtx, "users/target")));
    await assertFails(getDoc(doc(normal, "auditLogs/l1")));
  });
  it("admin token reads a non-member's nested member doc under a non-approved profile; non-admin cannot", async () => {
    await seed("profiles/p10", { name: "Hidden", status: "pending_review" });
    await seed("profiles/p10/members/alice", { uid: "alice", role: "admin", label: "guitar" });
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();
    const normal = env.authenticatedContext("norm").firestore();
    await assertSucceeds(getDoc(doc(adminCtx, "profiles/p10/members/alice")));
    await assertFails(getDoc(doc(normal, "profiles/p10/members/alice")));
  });
  it("admin cannot write auditLogs (read-only widened, write stays false)", async () => {
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(adminCtx, "auditLogs/x"), { action: "profile_approved" }));
  });
});

describe("invites and notifications", () => {
  it("invitee reads own invite; others cannot", async () => {
    await seed("invites/i1", { invitedUid: "bob", profileId: "p1", status: "pending" });
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    await assertSucceeds(getDoc(doc(bob, "invites/i1")));
    await assertFails(getDoc(doc(carol, "invites/i1")));
  });
  it("owner reads own notifications and may mark read, not create", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", read: false });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: true }));
    await assertFails(getDoc(doc(bob, "users/alice/notifications/n1")));
    await assertFails(setDoc(doc(alice, "users/alice/notifications/n2"), { title: "fake" }));
  });
  it("owner cannot update title on own notification via hasOnly-restricted update", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", read: false });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { title: "Hacked!" }));
  });
});

describe("tracks", () => {
  const seedProfile = async (status: string) => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
  };
  it("public reads approved tracks of approved profiles only", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Pending", status: "pending_review", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t2")));
    await assertSucceeds(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where("status", "==", "approved"), orderBy("order"))));
    await assertFails(getDocs(collection(anon, "profiles/prof1/tracks"))); // unfiltered list
  });
  it("no public track reads on a non-approved profile; members read all their own", async () => {
    await seedProfile("draft");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Rejected", status: "rejected", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
    // Even the production-shaped filtered+ordered list query must fail here —
    // the profile itself is not approved, so no list shape helps.
    await assertFails(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where("status", "==", "approved"), orderBy("order"))));
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/tracks/t2")));
    await assertSucceeds(getDocs(collection(alice, "profiles/prof1/tracks")));
  });
  it("clients cannot write tracks; admin collection-group read works", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "x", status: "pending_review", order: 0 });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "profiles/prof1/tracks/hax"), { title: "h", status: "approved" }));
    await assertFails(updateDoc(doc(alice, "profiles/prof1/tracks/t1"), { status: "approved" }));
    // Admins get elevated read, never write — writes stay Cloud Functions only.
    await assertFails(setDoc(doc(admin, "profiles/prof1/tracks/hax2"), { title: "h", status: "approved" }));
    await assertSucceeds(getDocs(query(
      collectionGroup(admin, "tracks"), where("status", "==", "pending_review"))));
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDocs(query(
      collectionGroup(bob, "tracks"), where("status", "==", "pending_review"))));
  });
  it("membership does not leak across profiles", async () => {
    await seedProfile("approved"); // prof1 / alice, as the existing helper does
    await seed("profiles/prof2", { type: "musician", name: "B", handle: "b", status: "approved" });
    await seed("profiles/prof2/tracks/p", { title: "SECRET", status: "pending_review", order: 0 });
    await seed("profiles/prof2/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "profiles/prof2/tracks/p")));
    await assertFails(getDocs(collection(alice, "profiles/prof2/tracks")));
    await assertFails(getDoc(doc(alice, "profiles/prof2/private/booking")));
  });
});

describe("private booking subdoc", () => {
  it("members and admins read; strangers and anon cannot; nobody writes", async () => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status: "approved" });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/prof1/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    // A sibling doc under private/ — pins that the rule is scoped to the
    // literal `booking` doc id, not a wildcard over all of private/.
    await seed("profiles/prof1/private/secrets", { apiKey: "nope" });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/private/booking")));
    await assertSucceeds(getDoc(doc(admin, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(bob, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(anon, "profiles/prof1/private/booking")));
    await assertFails(getDoc(doc(alice, "profiles/prof1/private/secrets")));
    await assertFails(getDoc(doc(admin, "profiles/prof1/private/secrets")));
    await assertFails(setDoc(doc(alice, "profiles/prof1/private/booking"), { rates: {} }));
    await assertFails(setDoc(doc(admin, "profiles/prof1/private/booking"), { rates: {} }));
  });
});

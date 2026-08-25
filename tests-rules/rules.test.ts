import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, getDocs, setDoc, updateDoc, collectionGroup, query, where } from "firebase/firestore";

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
});

describe("pushTokens", () => {
  it("owner reads and writes own pushTokens; stranger cannot", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/pushTokens/t1", { token: "abc123" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "users/alice/pushTokens/t1")));
    await assertSucceeds(setDoc(doc(alice, "users/alice/pushTokens/t2"), { token: "xyz789" }));
    await assertFails(getDoc(doc(bob, "users/alice/pushTokens/t1")));
    await assertFails(setDoc(doc(bob, "users/alice/pushTokens/t3"), { token: "hacked" }));
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
  it("members are readable by profile members and by anyone for approved profiles", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    await seed("profiles/p1/members/alice", { uid: "alice", role: "admin", label: "vocals" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/p1/members/alice")));
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

describe("collection-group members query", () => {
  it("member finds their own membership doc via collectionGroup('members'); a stranger's query for someone else's uid fails", async () => {
    await seed("profiles/p3", { name: "Hidden", status: "pending_review" });
    await seed("profiles/p3/members/alice", { uid: "alice", role: "admin", label: "guitar" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();

    const aliceSnap = await assertSucceeds(
      getDocs(query(collectionGroup(alice, "members"), where("uid", "==", "alice")))
    );
    if (aliceSnap.empty) throw new Error("expected alice's membership doc to be returned by the collection-group query");

    await assertFails(getDocs(query(collectionGroup(bob, "members"), where("uid", "==", "alice"))));
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

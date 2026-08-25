import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

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
});

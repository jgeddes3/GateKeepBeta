import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, deleteField } from "firebase/firestore";

// SP10 hardening rules matrix (spec section 5.5, rules F3/F7/F8/F9/F15, and
// the three new server-only or admin-only collections in spec section 7).
// Own file, same reasoning as events.rules.test.ts.

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

const TOKEN = "ExponentPushToken[abc123]";

describe("pushTokens (F3, F9)", () => {
  it("owner may delete their own token doc; a stranger may not", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed(`users/alice/pushTokens/${TOKEN}`, { createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(deleteDoc(doc(bob, `users/alice/pushTokens/${TOKEN}`)));
    await assertSucceeds(deleteDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`)));
  });
  it("token id is bounded to 200 characters inside the brackets", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    const ok = `ExponentPushToken[${"a".repeat(200)}]`;
    const tooLong = `ExponentPushToken[${"a".repeat(201)}]`;
    await assertSucceeds(setDoc(doc(alice, `users/alice/pushTokens/${ok}`), { createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${tooLong}`), { createdAt: Date.now() }));
  });
  it("createdAt must be an int", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: "now" }));
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: 1.5 }));
    await assertSucceeds(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: 1700000000000 }));
  });
  // The create path is covered above; the UPDATE half of the same rule is a
  // separate branch (request.resource is the MERGED result there), so it gets
  // its own coverage against an already-seeded doc.
  it("update of a seeded doc still refuses a non-int createdAt and any extra key", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed(`users/alice/pushTokens/${TOKEN}`, { createdAt: 1700000000000 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: "now" }));
    await assertFails(updateDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { platform: "ios" }));
    await assertSucceeds(updateDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: 1700000000001 }));
  });
  it("an empty payload is refused: createdAt is required, not merely typed", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), {}));
  });
});

describe("notifications.read (F8)", () => {
  it("read must be a bool", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", body: "", kind: "system", read: false, createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: "yes" }));
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: 1 }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: true }));
  });
  it("read cannot be deleted, may be set false, and a stranger cannot touch it", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", body: "", kind: "system", read: true, createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    // deleteField() passes the hasOnly(['read']) affectedKeys check but leaves
    // no bool behind, so the type check is what has to refuse it.
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: deleteField() }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: false }));
    await assertFails(updateDoc(doc(bob, "users/alice/notifications/n1"), { read: true }));
  });
});

describe("users.displayName (F7)", () => {
  it("SP11: owner cannot update displayName, homeCity, or homeGeo", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: deleteField() })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "" })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: 42 })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "A" })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "x".repeat(80) })); // SP11: displayName and homeCity are written only by updateAccount
    // A photoUrl-only update must still pass: displayName stays present in the resulting doc.
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { photoUrl: "https://example.com/a.jpg" }));
    await assertFails(updateDoc(doc(alice, "users/alice"), { homeCity: "Austin" })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { homeGeo: { lat: 30.27, lng: -97.74 } })); // SP11: homeGeo is written only by updateAccount
  });
  it("a whitespace-only displayName cannot be set in SP11", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: " " })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "     " })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: " Alice " })); // SP11: displayName and homeCity are written only by updateAccount
  });
  it("a doc with NO displayName still cannot be patched in SP11", async () => {
    // SP11: displayName is no longer owner-updatable, only written by updateAccount.
    // A seeded doc without displayName can update photoUrl only, not homeCity.
    await seed("users/nameless", { email: "n@x.com", homeCity: null });
    const nameless = env.authenticatedContext("nameless").firestore();
    await assertFails(updateDoc(doc(nameless, "users/nameless"), { homeCity: "Austin" })); // SP11: displayName and homeCity are written only by updateAccount
    await assertFails(updateDoc(doc(nameless, "users/nameless"), { displayName: "Nameless", homeCity: "Austin" })); // SP11: displayName and homeCity are written only by updateAccount
  });
});

describe("invites admin read (F15)", () => {
  it("admin reads any invite; an uninvolved signed-in user still cannot", async () => {
    await seed("invites/i1", { invitedUid: "bob", invitedByUid: "alice", profileId: "p1", status: "pending" });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const carol = env.authenticatedContext("carol").firestore();
    await assertSucceeds(getDoc(doc(admin, "invites/i1")));
    await assertSucceeds(getDocs(collection(admin, "invites")));
    await assertFails(getDoc(doc(carol, "invites/i1")));
    await assertFails(setDoc(doc(admin, "invites/i2"), { invitedUid: "bob" }));
  });
  it("the inviter reads their own invite; a non-admin cannot list the collection", async () => {
    await seed("invites/i1", { invitedUid: "bob", invitedByUid: "alice", profileId: "p1", status: "pending" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "invites/i1")));
    await assertSucceeds(getDoc(doc(bob, "invites/i1")));
    // An unfiltered list has no per-doc resource.data to test, so only the
    // isAdmin() disjunct can ever satisfy it.
    await assertFails(getDocs(collection(bob, "invites")));
  });
});

describe("posterUploads/{uid}/uploads/{nonce}", () => {
  it("owner gets by id only; listing, strangers, anon, and every write are denied", async () => {
    await seed("posterUploads/alice/uploads/n1", { path: "public/photos/p1/poster-n1.jpg", createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "posterUploads/alice/uploads/n1")));
    // Rules audit: both PosterField components listen to ONE known nonce and
    // the reaper runs on the Admin SDK, so nothing legitimate ever lists this
    // collection; leaving list open only handed the owner an upload history.
    await assertFails(getDocs(collection(alice, "posterUploads/alice/uploads")));
    await assertFails(getDoc(doc(bob, "posterUploads/alice/uploads/n1")));
    await assertFails(getDocs(collection(bob, "posterUploads/alice/uploads")));
    await assertFails(getDoc(doc(anon, "posterUploads/alice/uploads/n1")));
    await assertFails(setDoc(doc(alice, "posterUploads/alice/uploads/n2"), { path: "x", createdAt: 2 }));
    await assertFails(updateDoc(doc(alice, "posterUploads/alice/uploads/n1"), { path: "elsewhere" }));
    await assertFails(deleteDoc(doc(alice, "posterUploads/alice/uploads/n1")));
  });
  it("an admin has no read here either: this is owner-scoped plumbing, not moderation data", async () => {
    await seed("posterUploads/alice/uploads/n1", { path: "public/photos/p1/poster-n1.jpg", createdAt: 1 });
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(getDoc(doc(root, "posterUploads/alice/uploads/n1")));
  });
});

describe("disputes", () => {
  it("admin reads; owner-shaped users cannot; nobody writes", async () => {
    await seed("disputes/dp1", {
      chargeId: "ch_1", intentId: "pi_1", purpose: "tickets", orderId: "o1",
      amountCents: 2000, feeCents: 239, reason: "fraudulent", status: "open", openedAt: 1,
    });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(admin, "disputes/dp1")));
    await assertSucceeds(getDocs(collection(admin, "disputes")));
    await assertFails(getDoc(doc(alice, "disputes/dp1")));
    await assertFails(setDoc(doc(admin, "disputes/dp2"), { status: "open" }));
  });
  it("an anonymous caller reads nothing (isAdmin() must not throw on a null token)", async () => {
    await seed("disputes/dp1", {
      chargeId: "ch_1", intentId: "pi_1", purpose: "tickets", orderId: "o1",
      amountCents: 2000, feeCents: 239, reason: "fraudulent", status: "open", openedAt: 1,
    });
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "disputes/dp1")));
    await assertFails(getDocs(collection(anon, "disputes")));
  });
});

describe("eventCascadeRetries", () => {
  it("nobody reads or writes, not even an admin", async () => {
    await seed("eventCascadeRetries/ev1", { profileId: "p1", reason: "r", attempts: 1, lastError: "x", createdAt: 1 });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(admin, "eventCascadeRetries/ev1")));
    await assertFails(getDoc(doc(alice, "eventCascadeRetries/ev1")));
    await assertFails(setDoc(doc(admin, "eventCascadeRetries/ev1"), { attempts: 2 }));
    await assertFails(deleteDoc(doc(admin, "eventCascadeRetries/ev1")));
  });
});

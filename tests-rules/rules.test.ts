import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, collectionGroup, query, where, orderBy, documentId, deleteDoc,
} from "firebase/firestore";

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

// Sub-project 3: gigs/gigSeries doc-shape helpers (packages/shared's
// GigDoc/GigSeriesDoc), defaulted to a plausible open, prof1-owned doc so
// each test only needs to override the fields it's actually exercising.
const seedGig = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`gigs/${id}`, {
    curatorProfileId: "prof1", seriesId: null, detachedFromTemplate: false,
    title: "Friday night", description: "", wants: { genres: [], actSizes: [] },
    budget: { minCents: 0, maxCents: 0, structure: "perHour" },
    startsAt: 1000, durationMinutes: 60,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    location: {
      venueName: null, neighborhood: null, city: "Austin", geo: null,
      addressVisibility: "neighborhood", address: null,
    },
    status: "open", createdAt: 1, updatedAt: 1,
    ...overrides,
  });
};
const seedSeries = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`gigSeries/${id}`, {
    curatorProfileId: "prof1",
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    fillMode: "per_occurrence", template: {},
    status: "active", materializedThrough: 0, createdAt: 1, updatedAt: 1,
    ...overrides,
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
  it("'in'-status and documentId()-pinned list queries are DENIED on an approved profile that also has a pending track", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    await seed("profiles/prof1/tracks/t2", { title: "Pending", status: "pending_review", order: 1 });
    const anon = env.unauthenticatedContext().firestore();
    // An "in" filter covering both statuses would, if it worked, hand back
    // the not-yet-public pending track alongside the approved one — rules
    // evaluate the read clause per matched doc, so t2's status ("pending_review",
    // not "approved") fails its own check and the whole query is denied.
    await assertFails(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where("status", "in", ["approved", "pending_review"]))));
    // Pinning by documentId() doesn't route around the same per-doc check —
    // a query naming both ids directly still fails for the same reason.
    await assertFails(getDocs(query(
      collection(anon, "profiles/prof1/tracks"), where(documentId(), "in", ["t1", "t2"]))));
  });
  it("fail-closed: a track surviving under a deleted parent profile doc is not publicly readable", async () => {
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "Live", status: "approved", order: 0 });
    // Simulate a partial/failed cascade delete: the profile doc is gone but
    // one of its track docs was left behind. profileApproved()'s get() on a
    // missing doc makes `.data.status` throw during rule evaluation — that
    // must deny the read, not silently pass through.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "profiles/prof1"));
    });
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "profiles/prof1/tracks/t1")));
  });
  it("a profile member (not a platform admin) cannot run collectionGroup('tracks')", async () => {
    // alice is prof1's own profile-admin (seedProfile's member doc), but that
    // is unrelated to the platform-level isAdmin() the collection-group rule
    // requires — membership in one profile must not grant a cross-profile
    // collection-group read.
    await seedProfile("approved");
    await seed("profiles/prof1/tracks/t1", { title: "x", status: "pending_review", order: 0 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDocs(query(collectionGroup(alice, "tracks"), where("status", "==", "pending_review"))));
  });
  it("membership does not leak across profiles", async () => {
    await seedProfile("approved"); // prof1 / alice, as the existing helper does
    await seed("profiles/prof2", { type: "musician", name: "B", handle: "b", status: "approved" });
    await seed("profiles/prof2/tracks/p", { title: "SECRET", status: "pending_review", order: 0 });
    await seed("profiles/prof2/tracks/pub", { title: "Public", status: "approved", order: 1 });
    await seed("profiles/prof2/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "profiles/prof2/tracks/p")));
    await assertFails(getDocs(collection(alice, "profiles/prof2/tracks")));
    await assertFails(getDoc(doc(alice, "profiles/prof2/private/booking")));
    // Positive control: alice is not a member of prof2, but prof2 is approved,
    // so the public-approved path (not membership) is what allows this read.
    await assertSucceeds(getDoc(doc(alice, "profiles/prof2/tracks/pub")));
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
  it("SP3 widening: a caller with a seeded curatorAccess marker reads ANY profile's booking; without the marker they cannot; member/admin paths are unchanged", async () => {
    await seed("profiles/prof1", { type: "musician", name: "Band", handle: "band", status: "approved" });
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seed("profiles/prof1/private/booking", { rates: {}, preferences: {}, updatedAt: 1 });
    // carol is not a member of prof1, but she IS a member of >=1 *approved
    // curator* profile elsewhere — represented here by a seeded curatorAccess
    // marker. The live write path that keeps this marker in sync (curator
    // approval / unpublish / membership-change cascade) lands in Task 4/6;
    // this task only lands the rule, so the marker is seeded directly via
    // withSecurityRulesDisabled to test the read boundary in isolation.
    await seed("curatorAccess/carol", {});
    const alice = env.authenticatedContext("alice").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    const dave = env.authenticatedContext("dave").firestore(); // no marker, no membership
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "profiles/prof1/private/booking"))); // member, as before
    await assertSucceeds(getDoc(doc(admin, "profiles/prof1/private/booking"))); // admin, as before
    await assertSucceeds(getDoc(doc(carol, "profiles/prof1/private/booking"))); // NEW: approved-curator-member widening
    await assertFails(getDoc(doc(dave, "profiles/prof1/private/booking")));
    await assertFails(setDoc(doc(carol, "profiles/prof1/private/booking"), { rates: {} })); // still no client writes
  });
});

describe("gigs", () => {
  it("anon reads an open gig; draft and taken_down are denied", async () => {
    await seedGig("g-open", { status: "open" });
    await seedGig("g-draft", { status: "draft" });
    await seedGig("g-taken", { status: "taken_down" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "gigs/g-open")));
    await assertFails(getDoc(doc(anon, "gigs/g-draft")));
    await assertFails(getDoc(doc(anon, "gigs/g-taken")));
  });

  it("clients cannot write gigs (callables only)", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "gigs/hax"), { curatorProfileId: "prof1", status: "open" }));
  });

  it("member reads own non-open gig by get; a stranger cannot; admin can", async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seedGig("g-draft2", { status: "draft" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "gigs/g-draft2")));
    await assertFails(getDoc(doc(bob, "gigs/g-draft2")));
    await assertSucceeds(getDoc(doc(admin, "gigs/g-draft2")));
  });

  describe("list provability", () => {
    it("public status=='open' [+orderBy startsAt] list succeeds for anon; unfiltered and ordered-only lists fail", async () => {
      await seedGig("g1", { status: "open", startsAt: 100 });
      await seedGig("g2", { status: "draft", startsAt: 200 });
      const anon = env.unauthenticatedContext().firestore();
      const openSnap = await assertSucceeds(getDocs(query(
        collection(anon, "gigs"), where("status", "==", "open"), orderBy("startsAt"))));
      if (openSnap.empty) throw new Error("expected the open gig back from the filtered list");
      // Unfiltered list: status is unconstrained by the query, so the
      // status=='open' disjunct isn't provable across the whole result set.
      await assertFails(getDocs(collection(anon, "gigs")));
      // Ordered but not filtered: orderBy alone doesn't pin a field value.
      await assertFails(getDocs(query(collection(anon, "gigs"), orderBy("startsAt"))));
    });

    it("public open-gigs list may add a curatorProfileId equality filter (a curator's public page's 'open gigs' section)", async () => {
      await seedGig("g3", { status: "open", curatorProfileId: "prof1" });
      const anon = env.unauthenticatedContext().firestore();
      const snap = await assertSucceeds(getDocs(query(
        collection(anon, "gigs"), where("status", "==", "open"), where("curatorProfileId", "==", "prof1"))));
      if (snap.empty) throw new Error("expected g3 back");
    });

    it("curator dashboard: a member lists every status for their own curatorProfileId (no status filter); the identical query fails for a stranger", async () => {
      await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
      await seedGig("g4", { status: "draft" });
      await seedGig("g5", { status: "open" });
      const alice = env.authenticatedContext("alice").firestore();
      const bob = env.authenticatedContext("bob").firestore();
      // curatorProfileId is pinned to 'prof1' by the query's equality filter,
      // so isMember('prof1') is evaluated once as a query-wide constant —
      // provable regardless of each doc's actual (unconstrained) status.
      const dashSnap = await assertSucceeds(getDocs(
        query(collection(alice, "gigs"), where("curatorProfileId", "==", "prof1"))));
      if (dashSnap.size < 2) throw new Error("expected both the draft and open gig back for the member's dashboard query");
      // Same query shape, but bob isn't a member of prof1: isMember('prof1')
      // is a provable-but-false constant, and status is still unconstrained,
      // so no disjunct is provable — the whole list is denied.
      await assertFails(getDocs(query(collection(bob, "gigs"), where("curatorProfileId", "==", "prof1"))));
    });

    it("admin lists gigs with no filter at all; a non-admin's identical unfiltered list still fails", async () => {
      await seedGig("g6", { status: "draft" });
      const admin = env.authenticatedContext("root", { admin: true }).firestore();
      const bob = env.authenticatedContext("bob").firestore();
      const snap = await assertSucceeds(getDocs(collection(admin, "gigs")));
      if (snap.empty) throw new Error("expected admin's unfiltered list to return the draft gig");
      await assertFails(getDocs(collection(bob, "gigs")));
    });
  });
});

describe("gigs/private/location", () => {
  it("member reads; stranger and anon cannot; admin can", async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seedGig("g-loc");
    await seed("gigs/g-loc/private/location", { address: "123 Main St", geo: { lat: 1, lng: 2 } });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "gigs/g-loc/private/location")));
    await assertFails(getDoc(doc(bob, "gigs/g-loc/private/location")));
    await assertFails(getDoc(doc(anon, "gigs/g-loc/private/location")));
    await assertSucceeds(getDoc(doc(admin, "gigs/g-loc/private/location")));
  });
  it("clients cannot write gigs/private/location", async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seedGig("g-loc2");
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "gigs/g-loc2/private/location"), { address: "hack" }));
    await assertFails(setDoc(doc(admin, "gigs/g-loc2/private/location"), { address: "hack" }));
  });
});

describe("gigSeries", () => {
  it("stranger cannot read; member and admin can", async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seedSeries("s1");
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "gigSeries/s1")));
    await assertFails(getDoc(doc(bob, "gigSeries/s1")));
    await assertSucceeds(getDoc(doc(admin, "gigSeries/s1")));
  });
  it("clients cannot write gigSeries", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "gigSeries/hax"), { curatorProfileId: "prof1", status: "active" }));
  });
  it("list provability: a member lists series for their own curatorProfileId; a stranger's identical query fails; admin lists unfiltered", async () => {
    await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
    await seedSeries("s2", { status: "active" });
    await seedSeries("s3", { status: "paused" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const dashSnap = await assertSucceeds(getDocs(
      query(collection(alice, "gigSeries"), where("curatorProfileId", "==", "prof1"))));
    if (dashSnap.size < 2) throw new Error("expected both series back for the member's dashboard query");
    await assertFails(getDocs(query(collection(bob, "gigSeries"), where("curatorProfileId", "==", "prof1"))));
    const adminSnap = await assertSucceeds(getDocs(collection(admin, "gigSeries")));
    if (adminSnap.size < 2) throw new Error("expected admin's unfiltered list to return both series");
  });
});

describe("adminNotes", () => {
  it("admin reads; non-admin cannot; nobody writes", async () => {
    await seed("adminNotes/prof1", { notes: [{ byUid: "root", at: 1, text: "watch this one" }] });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(admin, "adminNotes/prof1")));
    await assertFails(getDoc(doc(alice, "adminNotes/prof1")));
    await assertFails(setDoc(doc(admin, "adminNotes/prof1"), { notes: [] }));
  });
});

describe("curatorAccess", () => {
  it("owner reads own marker; a stranger cannot; admin can; nobody writes", async () => {
    await seed("curatorAccess/alice", {});
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "curatorAccess/alice")));
    await assertFails(getDoc(doc(bob, "curatorAccess/alice")));
    await assertSucceeds(getDoc(doc(admin, "curatorAccess/alice")));
    await assertFails(setDoc(doc(alice, "curatorAccess/alice"), {}));
    await assertFails(setDoc(doc(admin, "curatorAccess/alice"), {}));
  });
});

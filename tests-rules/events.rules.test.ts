import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where,
} from "firebase/firestore";

// Sub-project 6 (events and ticketing) rules matrix: the six new
// collections firestore.rules gained in its "Sub-project 6: events and
// ticketing" section: events/{eventId} (+tiers, private/address, attendees
// subcollections), orders/{orderId}, users/{uid}/tickets/{ticketId},
// users/{uid}/ticketIndex/{eventId}, and transfers/{transferId}.
//
// Its own file rather than more describes in rules.test.ts, same reasoning
// as payments.rules.test.ts: a fresh matrix deserves its own file rather than
// growing the already-large rules.test.ts further. Same harness, same
// seeding idiom, same projectId; the suite runs with --no-file-parallelism
// (tests-rules/package.json), so this file never shares emulator state with
// the others.
//
// All six collections are callable-only for writes (Cloud Functions mint
// tickets, run the payout/refund/transfer sagas): every test below that
// touches create/update/delete expects assertFails, including for a curator
// member or an admin.

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

// The cast of characters used by every test below:
//   alice: member of prof1, the CURATOR profile behind ev1
//   bob:   the buyer/ticket-holder/attendee in most tests
//   carol: member of prof3, a profile with no part in ev1
//   dave:  signed in, member of nothing, holds no ticket
//   root:  platform admin (admin custom claim)
const seedCast = async () => {
  await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
  await seed("profiles/prof3/members/carol", { uid: "carol", role: "admin" });
};

// SP6's EventDoc (packages/shared/src/types.ts), defaulted to a published
// prof1-curated event so each test only overrides what it's actually
// exercising.
const seedEvent = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`events/${id}`, {
    curatorProfileId: "prof1", title: "Friday Night", description: "",
    location: {
      venueName: "The Venue", neighborhood: "Downtown", city: "Austin",
      geo: { lat: 1, lng: 2 }, addressVisibility: "neighborhood", address: null,
    },
    startsAt: 1_800_000_000_000, endsAt: 1_800_010_000_000,
    posterPath: null, status: "published", maxTicketsPerBuyer: 8,
    lineup: [], lineupMusicianProfileIds: [], gigId: null,
    createdAt: 1, updatedAt: 1,
    ...overrides,
  });
};

const seedTier = async (eventId: string, tierId: string, overrides: Record<string, unknown> = {}) => {
  await seed(`events/${eventId}/tiers/${tierId}`, {
    name: "General", priceCents: 2_000, capacity: 100, soldCount: 0,
    saleStartsAt: null, saleEndsAt: null, sortOrder: 0,
    ...overrides,
  });
};

const seedOrder = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`orders/${id}`, {
    buyerUid: "bob", eventId: "ev1", curatorProfileId: "prof1",
    items: [{ tierId: "t1", quantity: 1, unitPriceCents: 2_000, tierName: "General" }],
    faceTotalCents: 2_000, serviceFeeCents: 250,
    feePolicy: { ticketFeePct: 0.08, ticketFeeFixedCents: 100, ticketFeeCapCents: 2_000 },
    paymentIntentId: "pi_x", status: "paid",
    refundedTicketIds: [], refundedCents: 0, refundedFaceCents: 0,
    createdAt: 1, expiresAt: 1_000_000, paidAt: 1,
    ...overrides,
  });
};

const seedTicket = async (uid: string, ticketId: string, overrides: Record<string, unknown> = {}) => {
  await seed(`users/${uid}/tickets/${ticketId}`, {
    eventId: "ev1", tierId: "t1", tierName: "General", orderId: "ord1",
    curatorProfileId: "prof1", qrSecret: "secret123", status: "valid",
    createdAt: 1,
    ...overrides,
  });
};

const seedAttendee = async (eventId: string, ticketId: string, overrides: Record<string, unknown> = {}) => {
  await seed(`events/${eventId}/attendees/${ticketId}`, {
    ownerUid: "bob", ownerName: "Bob", tierId: "t1", tierName: "General",
    status: "valid",
    ...overrides,
  });
};

const seedTransfer = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`transfers/${id}`, {
    ticketId: "tk1", eventId: "ev1", fromUid: "bob", toUid: "carol",
    status: "offered", createdAt: 1, expiresAt: 1_000_000,
    ...overrides,
  });
};

describe("events", () => {
  it("anon reads a published event; a draft is denied", async () => {
    await seedEvent("ev-pub", { status: "published" });
    await seedEvent("ev-draft", { status: "draft" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev-pub")));
    await assertFails(getDoc(doc(anon, "events/ev-draft")));
  });

  it("anon reads a completed event; a cancelled event is denied", async () => {
    await seedEvent("ev-done", { status: "completed" });
    await seedEvent("ev-cancelled", { status: "cancelled" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev-done")));
    await assertFails(getDoc(doc(anon, "events/ev-cancelled")));
  });

  it("curator member reads own draft event; a stranger cannot; admin can", async () => {
    await seedCast();
    await seedEvent("ev-draft2", { status: "draft" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "events/ev-draft2")));
    await assertFails(getDoc(doc(bob, "events/ev-draft2")));
    await assertSucceeds(getDoc(doc(admin, "events/ev-draft2")));
  });

  it("no client writes events, not even a curator member or an admin (callable-only)", async () => {
    await seedCast();
    await seedEvent("ev1");
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "events/hax"), { curatorProfileId: "prof1", status: "draft" }));
    await assertFails(updateDoc(doc(alice, "events/ev1"), { status: "published" }));
    await assertFails(updateDoc(doc(admin, "events/ev1"), { status: "cancelled" }));
    await assertFails(deleteDoc(doc(alice, "events/ev1")));
    await assertFails(deleteDoc(doc(admin, "events/ev1")));
  });
});

describe("events/tiers", () => {
  it("anon reads tiers of a published event; tiers of a draft event are denied", async () => {
    await seedEvent("ev-pub", { status: "published" });
    await seedEvent("ev-draft", { status: "draft" });
    await seedTier("ev-pub", "t1");
    await seedTier("ev-draft", "t1");
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "events/ev-pub/tiers/t1")));
    await assertFails(getDoc(doc(anon, "events/ev-draft/tiers/t1")));
  });

  it("curator member reads tiers of own draft event; a stranger cannot; admin can", async () => {
    await seedCast();
    await seedEvent("ev-draft2", { status: "draft" });
    await seedTier("ev-draft2", "t1");
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "events/ev-draft2/tiers/t1")));
    await assertFails(getDoc(doc(bob, "events/ev-draft2/tiers/t1")));
    await assertSucceeds(getDoc(doc(admin, "events/ev-draft2/tiers/t1")));
  });

  it("no client writes tiers, not even a curator member or an admin", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seedTier("ev1", "t1");
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "events/ev1/tiers/hax"), { name: "hack", priceCents: 0 }));
    await assertFails(updateDoc(doc(alice, "events/ev1/tiers/t1"), { soldCount: 999 }));
    await assertFails(updateDoc(doc(admin, "events/ev1/tiers/t1"), { soldCount: 999 }));
    await assertFails(deleteDoc(doc(alice, "events/ev1/tiers/t1")));
  });
});

describe("events/private/address", () => {
  it("a stranger cannot read; curator member can; admin can", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seed("events/ev1/private/address", { address: "123 Main St", geo: { lat: 1, lng: 2 } });
    const alice = env.authenticatedContext("alice").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "events/ev1/private/address")));
    await assertFails(getDoc(doc(dave, "events/ev1/private/address")));
    await assertSucceeds(getDoc(doc(admin, "events/ev1/private/address")));
    await assertFails(getDoc(doc(anon, "events/ev1/private/address")));
  });

  it("a ticket-holder (proven by users/{uid}/ticketIndex/{eventId}) reads; a caller without that index doc cannot", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seed("events/ev1/private/address", { address: "123 Main St", geo: { lat: 1, lng: 2 } });
    // The server-maintained valid-ticket proof (TicketIndexDoc), seeded
    // directly via the admin context, exactly as the mint/refund/transfer
    // callables would maintain it (Tasks 5, 6, 8).
    await seed("users/bob/ticketIndex/ev1", { count: 1 });
    const bob = env.authenticatedContext("bob").firestore();
    const dave = env.authenticatedContext("dave").firestore(); // signed in, no index doc
    await assertSucceeds(getDoc(doc(bob, "events/ev1/private/address")));
    await assertFails(getDoc(doc(dave, "events/ev1/private/address")));
  });

  it("a ticketIndex doc for a DIFFERENT event does not prove access to this one", async () => {
    await seedEvent("ev1");
    await seedEvent("ev2");
    await seed("events/ev1/private/address", { address: "123 Main St", geo: { lat: 1, lng: 2 } });
    await seed("users/bob/ticketIndex/ev2", { count: 1 }); // holds a ticket for ev2, not ev1
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, "events/ev1/private/address")));
  });

  it("no client writes events/private/address, not even a curator member, a ticket-holder, or an admin", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seed("events/ev1/private/address", { address: "123 Main St", geo: { lat: 1, lng: 2 } });
    await seed("users/bob/ticketIndex/ev1", { count: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "events/ev1/private/address"), { address: "hack" }));
    await assertFails(setDoc(doc(bob, "events/ev1/private/address"), { address: "hack" }));
    await assertFails(setDoc(doc(admin, "events/ev1/private/address"), { address: "hack" }));
  });
});

describe("events/attendees", () => {
  it("curator member reads the roster; a ticket-holding attendee (not a curator member) cannot; a stranger cannot; admin can", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seedAttendee("ev1", "tk1", { ownerUid: "bob" });
    await seed("users/bob/ticketIndex/ev1", { count: 1 }); // bob holds a ticket, but is not a curator member
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(alice, "events/ev1/attendees/tk1")));
    await assertFails(getDoc(doc(bob, "events/ev1/attendees/tk1"))); // owning the ticket doesn't grant the roster
    await assertFails(getDoc(doc(dave, "events/ev1/attendees/tk1")));
    await assertSucceeds(getDoc(doc(admin, "events/ev1/attendees/tk1")));
  });

  it("curator member LISTs the whole roster; a stranger and anon cannot", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seedAttendee("ev1", "tk1");
    await seedAttendee("ev1", "tk2", { ownerUid: "carol", ownerName: "Carol" });
    const alice = env.authenticatedContext("alice").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const anon = env.unauthenticatedContext().firestore();
    const snap = await assertSucceeds(getDocs(collection(alice, "events/ev1/attendees")));
    if (snap.size < 2) throw new Error("expected both attendee docs back for the curator member's roster list");
    await assertFails(getDocs(collection(dave, "events/ev1/attendees")));
    await assertFails(getDocs(collection(anon, "events/ev1/attendees")));
  });

  it("no client writes events/attendees, not even a curator member or an admin", async () => {
    await seedCast();
    await seedEvent("ev1");
    await seedAttendee("ev1", "tk1");
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(alice, "events/ev1/attendees/hax"), { ownerUid: "alice" }));
    await assertFails(updateDoc(doc(alice, "events/ev1/attendees/tk1"), { status: "checked_in" }));
    await assertFails(updateDoc(doc(admin, "events/ev1/attendees/tk1"), { status: "checked_in" }));
    await assertFails(deleteDoc(doc(alice, "events/ev1/attendees/tk1")));
  });
});

describe("orders", () => {
  it("the buyer reads own order; curator-side member reads it; a stranger cannot; admin can", async () => {
    await seedCast();
    await seedOrder("ord1");
    const bob = env.authenticatedContext("bob").firestore();     // buyer
    const alice = env.authenticatedContext("alice").firestore(); // curator-side member
    const carol = env.authenticatedContext("carol").firestore(); // member of an unrelated profile
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bob, "orders/ord1")));
    await assertSucceeds(getDoc(doc(alice, "orders/ord1")));
    await assertFails(getDoc(doc(carol, "orders/ord1")));
    await assertSucceeds(getDoc(doc(admin, "orders/ord1")));
    await assertFails(getDoc(doc(anon, "orders/ord1")));
  });

  it("list-query provability: a buyer's own-uid-pinned list succeeds; an unfiltered list, and a stranger's list pinned to someone else's buyerUid, are denied; a curator member's own-profile-pinned list succeeds", async () => {
    await seedCast();
    await seedOrder("ord1", { buyerUid: "bob", curatorProfileId: "prof1" });
    await seedOrder("ord2", { buyerUid: "bob", curatorProfileId: "prof1", eventId: "ev2" });
    const bob = env.authenticatedContext("bob").firestore();     // the buyer
    const carol = env.authenticatedContext("carol").firestore(); // a stranger to both orders
    const alice = env.authenticatedContext("alice").firestore(); // curator-side member of prof1

    // Pinning buyerUid == <own uid> makes the buyer disjunct a query-wide
    // constant, so this is provable regardless of curatorProfileId. This is
    // the shape a buyer's "my orders" list ships as.
    const buyerSnap = await assertSucceeds(getDocs(query(collection(bob, "orders"), where("buyerUid", "==", "bob"))));
    if (buyerSnap.size < 2) throw new Error("expected both of bob's orders back for his own-uid-pinned list");

    // Unfiltered: buyerUid and curatorProfileId are both unconstrained, so
    // neither disjunct is provable query-wide, even for the real buyer.
    await assertFails(getDocs(collection(bob, "orders")));

    // A stranger pinning the query to someone ELSE's buyerUid does not fool
    // the rule: buyerUid == request.auth.uid still evaluates false for every
    // doc (carol's uid is not "bob"), and carol is not a curator-side member
    // of prof1 either. This is the exact crafted-query probe the read rule's
    // resource.data equality checks need pinned against a regression.
    await assertFails(getDocs(query(collection(carol, "orders"), where("buyerUid", "==", "bob"))));

    // Curator-side member pinning to their own curatorProfileId: isMember
    // ('prof1') is a query-wide constant, provable for every result,
    // regardless of each doc's (unconstrained by this query) buyerUid.
    const curatorSnap = await assertSucceeds(
      getDocs(query(collection(alice, "orders"), where("curatorProfileId", "==", "prof1"))));
    if (curatorSnap.size < 2) throw new Error("expected both orders back for the curator member's profile-pinned list");
  });

  it("no client writes orders, not even the buyer, a curator member, or an admin", async () => {
    await seedCast();
    await seedOrder("ord1");
    const bob = env.authenticatedContext("bob").firestore();
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(bob, "orders/hax"), { buyerUid: "bob", eventId: "ev1" }));
    await assertFails(updateDoc(doc(bob, "orders/ord1"), { status: "paid" }));
    await assertFails(updateDoc(doc(alice, "orders/ord1"), { status: "cancelled_refunded" }));
    await assertFails(updateDoc(doc(admin, "orders/ord1"), { status: "paid" }));
    await assertFails(deleteDoc(doc(bob, "orders/ord1")));
  });
});

describe("users/{uid}/tickets", () => {
  it("owner reads own ticket; a stranger cannot; admin cannot (owner-only, mirrors pushTokens' shape, no admin disjunct)", async () => {
    await seedTicket("bob", "tk1");
    const bob = env.authenticatedContext("bob").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(bob, "users/bob/tickets/tk1")));
    await assertFails(getDoc(doc(dave, "users/bob/tickets/tk1")));
    await assertFails(getDoc(doc(admin, "users/bob/tickets/tk1")));
  });

  it("owner LISTs own tickets; a stranger cannot", async () => {
    await seedTicket("bob", "tk1");
    await seedTicket("bob", "tk2", { tierId: "t2", tierName: "VIP" });
    const bob = env.authenticatedContext("bob").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const snap = await assertSucceeds(getDocs(collection(bob, "users/bob/tickets")));
    if (snap.size < 2) throw new Error("expected both ticket docs back for the owner's list");
    await assertFails(getDocs(collection(dave, "users/bob/tickets")));
  });

  it("no client writes users/{uid}/tickets, not even the owner or an admin", async () => {
    await seedTicket("bob", "tk1");
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(bob, "users/bob/tickets/hax"), { eventId: "ev1", status: "valid" }));
    await assertFails(updateDoc(doc(bob, "users/bob/tickets/tk1"), { status: "checked_in" }));
    await assertFails(updateDoc(doc(admin, "users/bob/tickets/tk1"), { status: "checked_in" }));
    await assertFails(deleteDoc(doc(bob, "users/bob/tickets/tk1")));
  });
});

describe("users/{uid}/ticketIndex", () => {
  it("owner reads own ticketIndex doc; a stranger cannot; admin cannot (owner-only)", async () => {
    await seed("users/bob/ticketIndex/ev1", { count: 1 });
    const bob = env.authenticatedContext("bob").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(bob, "users/bob/ticketIndex/ev1")));
    await assertFails(getDoc(doc(dave, "users/bob/ticketIndex/ev1")));
    await assertFails(getDoc(doc(admin, "users/bob/ticketIndex/ev1")));
  });

  it("no client writes users/{uid}/ticketIndex, not even the owner or an admin (this is the address gate's proof doc)", async () => {
    await seed("users/bob/ticketIndex/ev1", { count: 1 });
    const bob = env.authenticatedContext("bob").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    // A forged count here (or a forged doc for an event never bought) would
    // fabricate the valid-ticket proof private/address's read rule trusts.
    await assertFails(setDoc(doc(bob, "users/bob/ticketIndex/ev2"), { count: 1 }));
    await assertFails(updateDoc(doc(bob, "users/bob/ticketIndex/ev1"), { count: 99 }));
    await assertFails(updateDoc(doc(admin, "users/bob/ticketIndex/ev1"), { count: 99 }));
    await assertFails(deleteDoc(doc(bob, "users/bob/ticketIndex/ev1")));
  });
});

describe("transfers", () => {
  it("both the sender and the recipient read; an unrelated stranger cannot; admin can", async () => {
    await seedTransfer("tr1", { fromUid: "bob", toUid: "carol" });
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bob, "transfers/tr1")));
    await assertSucceeds(getDoc(doc(carol, "transfers/tr1")));
    await assertFails(getDoc(doc(dave, "transfers/tr1")));
    await assertSucceeds(getDoc(doc(admin, "transfers/tr1")));
    await assertFails(getDoc(doc(anon, "transfers/tr1")));
  });

  it("list-query provability: fromUid- and toUid-pinned lists succeed for the respective party; an unfiltered list is denied for a non-admin", async () => {
    await seedTransfer("tr1", { fromUid: "bob", toUid: "carol" });
    await seedTransfer("tr2", { fromUid: "bob", toUid: "dave", ticketId: "tk2" });
    const bob = env.authenticatedContext("bob").firestore();     // sender of both
    const carol = env.authenticatedContext("carol").firestore(); // recipient of tr1 only

    // Pinning fromUid == <own uid> makes the sender disjunct a query-wide
    // constant, provable regardless of toUid. This is bob's "transfers I
    // sent" list.
    const fromSnap = await assertSucceeds(getDocs(query(collection(bob, "transfers"), where("fromUid", "==", "bob"))));
    if (fromSnap.size < 2) throw new Error("expected both of bob's outgoing transfers back for his fromUid-pinned list");

    // Pinning toUid == <own uid> makes the recipient disjunct a query-wide
    // constant. Carol only appears as toUid on tr1.
    const toSnap = await assertSucceeds(getDocs(query(collection(carol, "transfers"), where("toUid", "==", "carol"))));
    if (toSnap.size < 1) throw new Error("expected carol's incoming transfer back for her toUid-pinned list");

    // Unfiltered: fromUid and toUid are both unconstrained, so neither
    // disjunct is provable query-wide, even for a real party to tr1/tr2.
    await assertFails(getDocs(collection(bob, "transfers")));
  });

  it("no client writes transfers, not even either party or an admin", async () => {
    await seedTransfer("tr1", { fromUid: "bob", toUid: "carol" });
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    await assertFails(setDoc(doc(bob, "transfers/hax"), { fromUid: "bob", toUid: "carol", status: "offered" }));
    await assertFails(updateDoc(doc(bob, "transfers/tr1"), { status: "expired" }));
    await assertFails(updateDoc(doc(carol, "transfers/tr1"), { status: "accepted" }));
    await assertFails(updateDoc(doc(admin, "transfers/tr1"), { status: "accepted" }));
    await assertFails(deleteDoc(doc(bob, "transfers/tr1")));
  });
});

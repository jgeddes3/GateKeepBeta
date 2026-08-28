import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

// Sub-project 5 (payments) rules matrix — the money collections
// firestore.rules gained in its "Sub-project 5: payments" section:
// bookings/{id}/payments/{gigId}, profiles/{id}/private/stripe, stripeEvents,
// ledger, adminAlerts, and stripeFake/**.
//
// Its own file rather than more describes in rules.test.ts: that file is
// already 700+ lines covering sub-projects 1-4, and money data has ZERO
// public tier (spec §2) — the whole point of this matrix is that it is
// read-together-able. Same harness, same seeding idiom, same projectId; the
// suite runs with `--no-file-parallelism` (tests-rules/package.json), so the
// two files never share an emulator state.

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
//   alice — member of prof1, the CURATOR side of bk1
//   bob   — member of prof2, the MUSICIAN side of bk1
//   carol — member of prof3, a profile with no part in bk1 (and, where it
//           matters, a curatorAccess marker holder)
//   dave  — signed in, member of nothing
//   root  — platform admin (admin custom claim)
const seedCast = async () => {
  await seed("profiles/prof1/members/alice", { uid: "alice", role: "admin" });
  await seed("profiles/prof2/members/bob", { uid: "bob", role: "admin" });
  await seed("profiles/prof3/members/carol", { uid: "carol", role: "admin" });
};

// SP4's BookingRequestDoc, defaulted to a confirmed prof1(curator) <-> prof2
// (musician) booking — the only state that ever HAS payment docs, since
// acceptBooking's saga is what stages the subcollection.
const seedBooking = async (id: string, overrides: Record<string, unknown> = {}) => {
  await seed(`bookings/${id}`, {
    gigId: "g1", seriesId: null,
    curatorProfileId: "prof1", musicianProfileId: "prof2",
    initiatedBy: "musician", structure: "perHour",
    thread: [], awaitingSide: "curator", status: "confirmed",
    acceptedTerms: null, deposit: null, cancellation: null,
    createdAt: 1, updatedAt: 1, confirmedAt: 1, resolvedAt: null,
    ...overrides,
  });
};

// SP5's PaymentDoc (packages/shared/src/types.ts) — one doc per occurrence,
// server-written only. Defaulted to a deposit-held, settlement-not-due date
// so a test only overrides what it's actually exercising.
const seedPayment = async (bookingId: string, gigId: string, overrides: Record<string, unknown> = {}) => {
  await seed(`bookings/${bookingId}/payments/${gigId}`, {
    bookingId, gigId, occurrenceStartsAt: 1_800_000_000_000,
    curatorProfileId: "prof1", musicianProfileId: "prof2", selfDeal: false,
    baseCents: 100_000,
    deposit: {
      sliceCents: 35_000, feeShareCents: 3_850, intentId: "pi_x", chargeId: "ch_x",
      status: "held", chargedAt: 1, resolvedAt: null, forfeitTransferId: null,
    },
    settlement: {
      status: "not_due", settleAfter: null, computedCents: null, feeShareCents: null,
      trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
      lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
    },
    transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
    createdAt: 1, updatedAt: 1,
    ...overrides,
  });
};

describe("payments subcollection (bookings/{id}/payments/{gigId})", () => {
  it("both sides' members and admins read a payment doc; another profile's member, a stranger, and anon cannot", async () => {
    await seedCast();
    await seedBooking("bk1");
    await seedPayment("bk1", "g1");
    // An ORPHAN payment doc whose parent booking does not exist — the read
    // rule's get()s resolve to null there, so every membership disjunct
    // errors out and the whole rule denies. Pins that the audience is
    // derived from the LIVE parent booking, never from the payment doc's own
    // (server-written, but still self-declared) curatorProfileId/
    // musicianProfileId fields.
    await seedPayment("nosuchbooking", "g1");

    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(alice, "bookings/bk1/payments/g1"))); // curator-side member
    await assertSucceeds(getDoc(doc(bob, "bookings/bk1/payments/g1")));   // musician-side member
    await assertSucceeds(getDoc(doc(root, "bookings/bk1/payments/g1")));  // admin
    await assertFails(getDoc(doc(carol, "bookings/bk1/payments/g1")));    // member of an unrelated profile
    await assertFails(getDoc(doc(dave, "bookings/bk1/payments/g1")));     // signed in, member of nothing
    await assertFails(getDoc(doc(anon, "bookings/bk1/payments/g1")));     // unauthenticated
    await assertFails(getDoc(doc(alice, "bookings/nosuchbooking/payments/g1"))); // parent-derived audience
  });

  it("a side member can LIST the payments under one booking; outsiders and anon cannot", async () => {
    await seedCast();
    await seedBooking("bk1");
    await seedPayment("bk1", "g1");
    await seedPayment("bk1", "g2", { occurrenceStartsAt: 1_800_600_000_000 });

    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    // Provable BECAUSE the query is scoped under one booking path: the
    // rule's get()s pin to the {bookingId} path segment, so the membership
    // check is a single query-wide constant rather than a per-doc field
    // comparison. This is the exact query both clients ship
    // (apps/web/src/payments/PaymentsPanel.tsx's usePaymentRows and
    // apps/mobile/src/bookings/PaymentStatus.tsx's).
    await assertSucceeds(getDocs(collection(alice, "bookings/bk1/payments")));
    await assertSucceeds(getDocs(collection(bob, "bookings/bk1/payments")));
    await assertSucceeds(getDocs(collection(root, "bookings/bk1/payments")));
    await assertFails(getDocs(collection(carol, "bookings/bk1/payments")));
    await assertFails(getDocs(collection(anon, "bookings/bk1/payments")));
  });

  it("no client writes payment docs — not either side, not an admin, not create/update/delete", async () => {
    await seedCast();
    await seedBooking("bk1");
    await seedPayment("bk1", "g1");

    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();

    // update: the shapes that would actually be worth forging — marking a
    // settlement paid, or a deposit refunded, without any money moving.
    await assertFails(updateDoc(doc(alice, "bookings/bk1/payments/g1"), { "settlement.status": "paid" }));
    await assertFails(updateDoc(doc(bob, "bookings/bk1/payments/g1"), { "deposit.status": "forfeited" }));
    await assertFails(updateDoc(doc(root, "bookings/bk1/payments/g1"), { "settlement.status": "waived" }));
    // create (a date that has no payment doc yet) and delete (erasing a debt)
    await assertFails(setDoc(doc(alice, "bookings/bk1/payments/g2"), { baseCents: 0 }));
    await assertFails(setDoc(doc(bob, "bookings/bk1/payments/g2"), { baseCents: 0 }));
    await assertFails(setDoc(doc(root, "bookings/bk1/payments/g2"), { baseCents: 0 }));
    await assertFails(deleteDoc(doc(alice, "bookings/bk1/payments/g1")));
    await assertFails(deleteDoc(doc(root, "bookings/bk1/payments/g1")));
  });
});

describe("private/stripe subdoc", () => {
  it("members and admins read; another profile's member, a curatorAccess holder, and anon cannot; nobody writes", async () => {
    await seedCast();
    await seed("profiles/prof2", { type: "musician", name: "Band", handle: "band", status: "approved" });
    await seed("profiles/prof2/private/stripe", {
      customerId: "cus_x", defaultPaymentMethodId: "pm_x", cardBrand: "visa", cardLast4: "4242",
      accountId: "acct_x", payoutsEnabled: true, transfersEnabled: true, delinquent: false, updatedAt: 1,
    });
    // carol holds the curatorAccess marker — the thing that DOES grant a
    // read of profiles/{id}/private/curatorBooking (the curator-shopping
    // projection). private/stripe is deliberately NOT a shopping surface:
    // payment identity, card fingerprints and gate flags are member/admin
    // only, exactly like private/booking and private/reliability. Same
    // assertion shape as rules.test.ts's "private reliability subdoc" block.
    await seed("curatorAccess/carol", {});

    const bob = env.authenticatedContext("bob").firestore();     // member of prof2
    const carol = env.authenticatedContext("carol").firestore(); // curatorAccess marker, not a member
    const alice = env.authenticatedContext("alice").firestore(); // member of a DIFFERENT profile
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(bob, "profiles/prof2/private/stripe")));
    await assertSucceeds(getDoc(doc(root, "profiles/prof2/private/stripe")));
    await assertFails(getDoc(doc(carol, "profiles/prof2/private/stripe")));
    await assertFails(getDoc(doc(alice, "profiles/prof2/private/stripe")));
    await assertFails(getDoc(doc(anon, "profiles/prof2/private/stripe")));

    // Server-write only. A forged `delinquent: false` would clear the
    // booking gate; a forged accountId would redirect payouts.
    await assertFails(updateDoc(doc(bob, "profiles/prof2/private/stripe"), { delinquent: false }));
    await assertFails(updateDoc(doc(bob, "profiles/prof2/private/stripe"), { accountId: "acct_attacker" }));
    await assertFails(updateDoc(doc(root, "profiles/prof2/private/stripe"), { delinquent: false }));
    await assertFails(deleteDoc(doc(bob, "profiles/prof2/private/stripe")));
  });
});

describe("stripeEvents (webhook idempotency ledger)", () => {
  it("admin reads and lists; members, strangers and anon cannot; nobody writes", async () => {
    await seedCast();
    await seed("stripeEvents/evt_1", { type: "payment_intent.succeeded", receivedAt: 1, expireAt: 2 });

    const alice = env.authenticatedContext("alice").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(root, "stripeEvents/evt_1")));
    await assertSucceeds(getDocs(collection(root, "stripeEvents")));
    await assertFails(getDoc(doc(alice, "stripeEvents/evt_1")));
    await assertFails(getDocs(collection(alice, "stripeEvents")));
    await assertFails(getDoc(doc(dave, "stripeEvents/evt_1")));
    await assertFails(getDoc(doc(anon, "stripeEvents/evt_1")));
    // Writing here is a replay-protection bypass: pre-seeding an event id
    // makes the webhook treat the real event as already handled.
    await assertFails(setDoc(doc(alice, "stripeEvents/evt_2"), { type: "x" }));
    await assertFails(setDoc(doc(root, "stripeEvents/evt_2"), { type: "x" }));
    await assertFails(deleteDoc(doc(root, "stripeEvents/evt_1")));
  });
});

describe("ledger (append-only money audit)", () => {
  it("admin reads and lists; members, strangers and anon cannot; nobody writes", async () => {
    await seedCast();
    await seed("ledger/entry1", {
      kind: "deposit_charge", bookingId: "bk1", gigId: "g1", amountCents: 35_000, at: 1,
    });

    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(root, "ledger/entry1")));
    await assertSucceeds(getDocs(collection(root, "ledger")));
    // Both SIDES of the booking this entry describes are denied — the ledger
    // is the platform's own audit trail, not a customer-facing receipt.
    await assertFails(getDoc(doc(alice, "ledger/entry1")));
    await assertFails(getDoc(doc(bob, "ledger/entry1")));
    await assertFails(getDocs(collection(bob, "ledger")));
    await assertFails(getDoc(doc(anon, "ledger/entry1")));
    await assertFails(setDoc(doc(alice, "ledger/entry2"), { kind: "forged" }));
    await assertFails(setDoc(doc(root, "ledger/entry2"), { kind: "forged" }));
    await assertFails(updateDoc(doc(root, "ledger/entry1"), { amountCents: 1 }));
    await assertFails(deleteDoc(doc(root, "ledger/entry1")));
  });
});

describe("adminAlerts (the sweep's escalation queue)", () => {
  it("admin reads and lists; members, strangers and anon cannot; nobody writes", async () => {
    await seedCast();
    await seed("adminAlerts/alert1", {
      kind: "stuck_saga", bookingId: "bk1", gigId: "g1", createdAt: 1, resolvedAt: null,
    });

    const alice = env.authenticatedContext("alice").firestore();
    const dave = env.authenticatedContext("dave").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(root, "adminAlerts/alert1")));
    await assertSucceeds(getDocs(collection(root, "adminAlerts")));
    await assertFails(getDoc(doc(alice, "adminAlerts/alert1")));
    await assertFails(getDoc(doc(dave, "adminAlerts/alert1")));
    await assertFails(getDocs(collection(dave, "adminAlerts")));
    await assertFails(getDoc(doc(anon, "adminAlerts/alert1")));
    // Resolution goes through the releaseStuckSaga callable, never a direct
    // client write — a forged resolvedAt would retire a money alert nobody
    // actually looked at.
    await assertFails(updateDoc(doc(root, "adminAlerts/alert1"), { resolvedAt: 2 }));
    await assertFails(setDoc(doc(alice, "adminAlerts/alert2"), { kind: "x" }));
    await assertFails(deleteDoc(doc(root, "adminAlerts/alert1")));
  });
});

describe("stripeFake (emulator-only fake Stripe state)", () => {
  it("is unreachable for every caller at every depth — including admins", async () => {
    await seedCast();
    await seed("stripeFake/config", { declineAll: false, declineCustomerIds: [] });
    // Nested: the recursive {doc=**} wildcard must deny below the top level
    // too, where FakeStripe actually keeps its objects.
    await seed("stripeFake/state/objects/ch_1", { kind: "charge", amountCents: 100 });

    const alice = env.authenticatedContext("alice").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    const anon = env.unauthenticatedContext().firestore();

    for (const db of [alice, root, anon]) {
      await assertFails(getDoc(doc(db, "stripeFake/config")));
      await assertFails(getDoc(doc(db, "stripeFake/state/objects/ch_1")));
      await assertFails(getDocs(collection(db, "stripeFake/state/objects")));
      // The decline knob is the interesting write: flipping declineAll (or
      // seeding a fake balance) would be free money if this collection ever
      // existed in production.
      await assertFails(setDoc(doc(db, "stripeFake/config"), { declineAll: true }));
      await assertFails(setDoc(doc(db, "stripeFake/state/objects/acct_1"), { balanceCents: 999_999 }));
      await assertFails(deleteDoc(doc(db, "stripeFake/config")));
    }
  });
});

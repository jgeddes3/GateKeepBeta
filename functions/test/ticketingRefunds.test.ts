import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { type TicketOrderDoc, type TicketDoc, type AttendeeDoc, type EventDoc } from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// Chain-heavy fixtures (profile + review + event + tiers + purchases + a
// cancellation), same rationale/budget as ticketing.test.ts's identical setConfig.
vi.setConfig({ testTimeout: 20_000 });

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<Record<string, unknown>, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

function eventContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = Date.now() + 7 * 24 * 3600 * 1000;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * 3600 * 1000,
    lineup: [{ kind: "external", name: "The Quartet" }],
    ...overrides,
  };
}

async function makeDraftEvent(prefix: string, overrides: Record<string, unknown> = {}) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent(overrides) }, owner.user);
  return { owner, profileId, eventId };
}

async function addTiersAndPublish(
  profileId: string, eventId: string, user: import("firebase/auth").User, tiers: Record<string, unknown>[],
): Promise<void> {
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId, tiers }, user);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, user);
}

async function tierIdByName(eventId: string, name: string): Promise<string> {
  const snap = await adb.collection(`events/${eventId}/tiers`).get();
  const doc = snap.docs.find((d) => d.data().name === name);
  if (!doc) throw new Error(`tier "${name}" not found for event ${eventId}`);
  return doc.id;
}

function makeBuyer(prefix: string) {
  return signUpTestUser(`${prefix}-${Date.now()}@test.com`);
}

type CreateOrderResult = { orderId: string; clientSecret: string | null };

// Same FakeStripe test hook ticketing.test.ts uses: the emulator has no
// browser Elements flow, so "the buyer confirmed" is simulated by flipping
// the fake intent's own stored status.
async function confirmFakeIntent(clientSecret: string): Promise<string> {
  const intentId = clientSecret.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded" });
  return intentId;
}

// Buys `quantity` of `tierId` for `buyerUser` and drives it to "paid",
// confirming the fake intent and finalizing for a paid tier, or trusting
// createTicketOrder's own inline completion for a free one. Returns the
// order id.
async function payOrder(
  eventId: string, tierId: string, quantity: number, buyerUser: import("firebase/auth").User,
): Promise<string> {
  const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
    "createTicketOrder", { eventId, items: [{ tierId, quantity }] }, buyerUser);
  if (clientSecret) {
    await confirmFakeIntent(clientSecret);
    await callFn("finalizeTicketOrder", { orderId }, buyerUser);
  }
  return orderId;
}

async function ticketsForOrder(buyerUid: string, orderId: string): Promise<Array<{ id: string; data: TicketDoc }>> {
  const snap = await adb.collection(`users/${buyerUid}/tickets`).where("orderId", "==", orderId).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as TicketDoc }));
}

async function refundDocsForIntent(intentId: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await adb.collection("stripeFake/state/objects")
    .where("kind", "==", "refund").where("intentId", "==", intentId).get();
  return snap.docs;
}

// Simulates the (not-yet-implemented) ticket transfer's end state directly
// via the admin SDK, the same "flip status directly" precedent events.test.ts
// uses for a cancelled event before cancelEvent existed. Moves the live
// ticket doc to the new owner's subcollection, marks the original
// "transferred", repoints the attendee projection's ownerUid, and moves the
// ticketIndex count, exactly the shape a real transferTicket callable would
// leave behind.
async function simulateTransfer(
  eventId: string, ticketId: string, fromUid: string, toUid: string, toName: string,
): Promise<void> {
  const fromTicketRef = adb.doc(`users/${fromUid}/tickets/${ticketId}`);
  const ticket = (await fromTicketRef.get()).data() as TicketDoc;
  await adb.doc(`users/${toUid}/tickets/${ticketId}`).set({ ...ticket, status: "valid" });
  await fromTicketRef.update({ status: "transferred", transferredTo: toUid });
  await adb.doc(`events/${eventId}/attendees/${ticketId}`).update({ ownerUid: toUid, ownerName: toName });

  const fromIdxRef = adb.doc(`users/${fromUid}/ticketIndex/${eventId}`);
  const fromCount = ((await fromIdxRef.get()).data()?.count as number | undefined) ?? 1;
  if (fromCount - 1 <= 0) await fromIdxRef.delete(); else await fromIdxRef.update({ count: fromCount - 1 });

  const toIdxRef = adb.doc(`users/${toUid}/ticketIndex/${eventId}`);
  const toCount = ((await toIdxRef.get()).data()?.count as number | undefined) ?? 0;
  await toIdxRef.set({ count: toCount + 1 });
}

describe("cancelEvent", () => {
  it("refunds 2 paid orders and 1 free order fully, tears down tickets/index, writes ledger + notifications", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cx1");
    await addTiersAndPublish(profileId, eventId, owner.user, [
      { name: "General", priceCents: 2000, capacity: 100, saleStartsAt: null, saleEndsAt: null },
      { name: "Free RSVP", priceCents: 0, capacity: 100, saleStartsAt: null, saleEndsAt: null },
    ]);
    const generalId = await tierIdByName(eventId, "General");
    const freeId = await tierIdByName(eventId, "Free RSVP");

    const buyerA = await makeBuyer("cx1a");
    const buyerB = await makeBuyer("cx1b");
    const buyerC = await makeBuyer("cx1c");
    const orderAId = await payOrder(eventId, generalId, 1, buyerA.user);
    const orderBId = await payOrder(eventId, generalId, 1, buyerB.user);
    const orderCId = await payOrder(eventId, freeId, 1, buyerC.user);

    const orderABefore = (await adb.doc(`orders/${orderAId}`).get()).data() as TicketOrderDoc;
    expect(orderABefore.faceTotalCents).toBe(2000);
    expect(orderABefore.serviceFeeCents).toBe(239); // min(round(2000*7%)+99, 399) = min(239,399)
    const totalA = orderABefore.faceTotalCents + orderABefore.serviceFeeCents;
    const intentA = orderABefore.paymentIntentId!;

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(result.ok).toBe(true);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("cancelled");
    expect(event.cancelledAt).toBeTypeOf("number");

    for (const [orderId, buyer, total] of [
      [orderAId, buyerA, totalA] as const,
      [orderBId, buyerB, totalA] as const,
    ]) {
      const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
      expect(order.status).toBe("cancelled_refunded");
      expect(order.refundedCents).toBe(total);
      expect(order.refundedFaceCents).toBe(2000);
      expect(order.refundedTicketIds).toHaveLength(1);

      const tickets = await ticketsForOrder(buyer.uid, orderId);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].data.status).toBe("refunded");

      const attendee = (await adb.doc(`events/${eventId}/attendees/${tickets[0].id}`).get()).data() as AttendeeDoc;
      expect(attendee.status).toBe("refunded");

      const idx = await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).get();
      expect(idx.exists).toBe(false); // count reached 0 -> deleted

      const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", orderId).get();
      const refundRow = ledgerSnap.docs.find((d) => d.data().kind === "ticket_cancel_refund");
      expect(refundRow?.data().amountCents).toBe(total);
      expect(refundRow?.data().eventId).toBe(eventId);
      expect(refundRow?.data().buyerUid).toBe(buyer.uid);

      const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
      expect(notifSnap.docs.some((d) => d.data().kind === "ticket" && d.data().title === "Event cancelled")).toBe(true);
    }

    // FakeStripe actually recorded the refund against orderA's PaymentIntent.
    const piA = (await adb.doc(`stripeFake/state/objects/${intentA}`).get()).data();
    expect(piA?.refundedCents).toBe(totalA);
    const refundDocs = await refundDocsForIntent(intentA);
    expect(refundDocs).toHaveLength(1);
    expect(refundDocs[0].data().amountCents).toBe(totalA);

    // The free order: doc updates only, no Stripe call, still one $0 ledger row.
    const orderC = (await adb.doc(`orders/${orderCId}`).get()).data() as TicketOrderDoc;
    expect(orderC.status).toBe("cancelled_refunded");
    expect(orderC.refundedCents).toBe(0);
    expect(orderC.paymentIntentId).toBeNull();
    const ledgerC = await adb.collection("ledger").where("stripeId", "==", orderCId).get();
    expect(ledgerC.docs.find((d) => d.data().kind === "ticket_cancel_refund")?.data().amountCents).toBe(0);
  });

  it("is idempotent: a second call refunds nothing new", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cx2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cx2buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const order0 = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const intentId = order0.paymentIntentId!;

    await callFn("cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    const afterFirst = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(afterFirst.status).toBe("cancelled_refunded");
    const refundsAfterFirst = await refundDocsForIntent(intentId);
    expect(refundsAfterFirst).toHaveLength(1);
    const ledgerAfterFirst = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    const ledgerCountFirst = ledgerAfterFirst.docs.length;

    const cancelledAtBefore = ((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).cancelledAt;

    // Second call: the status flip is skipped (already cancelled), and the
    // refund loop finds nothing left in "paid" or "pending" for this event.
    const second = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(second.ok).toBe(true);

    const afterSecond = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(afterSecond.status).toBe("cancelled_refunded");
    expect(afterSecond.refundedCents).toBe(afterFirst.refundedCents);
    const refundsAfterSecond = await refundDocsForIntent(intentId);
    expect(refundsAfterSecond).toHaveLength(1); // no second refund object
    const ledgerAfterSecond = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    expect(ledgerAfterSecond.docs).toHaveLength(ledgerCountFirst); // no duplicate row

    const cancelledAtAfter = ((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).cancelledAt;
    expect(cancelledAtAfter).toBe(cancelledAtBefore); // the flip itself did not re-run
  });

  it("cancels a still-pending order too: releases inventory and cancels its PaymentIntent", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cx3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cx3buyer");

    // Left pending on purpose: never confirmed/finalized.
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");

    const tierBefore = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierBefore?.soldCount).toBe(2);

    await callFn("cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("expired");
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(0);
    const intent = (await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data();
    expect(intent?.status).toBe("canceled");
  });

  it("cancels a draft event with nothing to refund (no money loop)", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cx4");
    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(result.ok).toBe(true);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("cancelled");
    const ledgerSnap = await adb.collection("ledger").where("eventId", "==", eventId).get();
    expect(ledgerSnap.docs).toHaveLength(0);
  });

  it("rejects a non-member", async () => {
    const { profileId, eventId } = await makeDraftEvent("cx5");
    const stranger = await makeBuyer("cx5stranger");
    await expect(callFn("cancelEvent", { curatorProfileId: profileId, eventId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("draft");
  });
});

describe("paymentsSweep: retry cancelled-event ticket refunds", () => {
  it("finishes a cancelled event's still-paid order left behind by a crashed refund loop", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cx6");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cx6buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const order0 = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const totalCents = order0.faceTotalCents + order0.serviceFeeCents;

    // Simulate the status flip having landed without its refund loop ever
    // running (a crash between the two): direct admin write, bypassing the
    // cancelEvent callable entirely, same "flip status directly" precedent
    // events.test.ts uses.
    const now = Date.now();
    await adb.doc(`events/${eventId}`).update({ status: "cancelled", cancelledAt: now, updatedAt: now });

    const report = await runPaymentsSweep(Date.now());
    expect(report.cancelledEventOrdersRefunded).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("cancelled_refunded");
    expect(order.refundedCents).toBe(totalCents);
    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    expect(ledgerSnap.docs.some((d) => d.data().kind === "ticket_cancel_refund")).toBe(true);
  });
});

describe("refundTicket", () => {
  it("returns face+fee for one ticket only, re-releases its seat, and leaves the order paid", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rt1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 2, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rt1buyer");
    const orderId = await payOrder(eventId, tierId, 2, buyer.user);
    const order0 = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const intentId = order0.paymentIntentId!;

    const tickets = await ticketsForOrder(buyer.uid, orderId);
    expect(tickets).toHaveLength(2);
    const [ticket1, ticket2] = tickets;

    const tierBefore = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierBefore?.soldCount).toBe(2); // sold out

    const idxBefore = (await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).get()).data();
    expect(idxBefore?.count).toBe(2);

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "refundTicket", { curatorProfileId: profileId, eventId, ticketId: ticket1.id }, owner.user);
    expect(result.ok).toBe(true);

    // 1000 face + fee(min(round(1000*7%)+99,399)=169) = 1169.
    const expectedAmount = 1169;

    const t1After = (await adb.doc(`users/${buyer.uid}/tickets/${ticket1.id}`).get()).data() as TicketDoc;
    expect(t1After.status).toBe("refunded");
    const t2After = (await adb.doc(`users/${buyer.uid}/tickets/${ticket2.id}`).get()).data() as TicketDoc;
    expect(t2After.status).toBe("valid"); // the OTHER ticket untouched

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid"); // stays paid, not cancelled
    expect(order.refundedTicketIds).toEqual([ticket1.id]);
    expect(order.refundedCents).toBe(expectedAmount);
    expect(order.refundedFaceCents).toBe(1000);

    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(1); // inventory re-released

    const idxAfter = (await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).get()).data();
    expect(idxAfter?.count).toBe(1);

    // A new buyer can now purchase the re-released seat.
    const newBuyer = await makeBuyer("rt1newbuyer");
    const { orderId: newOrderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, newBuyer.user);
    expect(newOrderId).toBeTruthy();

    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticket1.id}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("refunded");

    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", ticket1.id).get();
    const row = ledgerSnap.docs.find((d) => d.data().kind === "ticket_grace_refund");
    expect(row?.data().amountCents).toBe(expectedAmount);

    const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notifSnap.docs.some((d) => d.data().kind === "ticket" && d.data().title === "Ticket refunded")).toBe(true);

    const piAfter = (await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data();
    expect(piAfter?.refundedCents).toBe(expectedAmount);
  });

  it("a transferred-away ticket targets the current owner's index; money still returns to the order's buyer", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rt2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const originalBuyer = await makeBuyer("rt2buyer");
    const newOwner = await makeBuyer("rt2newowner");
    const orderId = await payOrder(eventId, tierId, 1, originalBuyer.user);

    const tickets = await ticketsForOrder(originalBuyer.uid, orderId);
    expect(tickets).toHaveLength(1);
    const ticketId = tickets[0].id;

    await simulateTransfer(eventId, ticketId, originalBuyer.uid, newOwner.uid, "New Owner");

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "refundTicket", { curatorProfileId: profileId, eventId, ticketId }, owner.user);
    expect(result.ok).toBe(true);

    // 1500 face + fee(min(round(1500*7%)+99,399)=204) = 1704.
    const expectedAmount = 1704;

    const newOwnerTicket = (await adb.doc(`users/${newOwner.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(newOwnerTicket.status).toBe("refunded");

    // The original (transferred-away) doc is untouched: refundTicket only
    // ever acts on the CURRENT owner's live copy.
    const originalTicket = (await adb.doc(`users/${originalBuyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(originalTicket.status).toBe("transferred");

    const newOwnerIdx = await adb.doc(`users/${newOwner.uid}/ticketIndex/${eventId}`).get();
    expect(newOwnerIdx.exists).toBe(false); // count was 1 -> deleted

    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticketId}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("refunded");
    expect(attendee.ownerUid).toBe(newOwner.uid);

    // Money attribution: the ledger row still names the ORDER's buyer (the
    // person who actually paid Stripe), not the ticket's current owner.
    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", ticketId).get();
    const row = ledgerSnap.docs.find((d) => d.data().kind === "ticket_grace_refund");
    expect(row?.data().amountCents).toBe(expectedAmount);
    expect(row?.data().buyerUid).toBe(originalBuyer.uid);

    // The notification goes to the CURRENT owner, not the original buyer.
    const newOwnerNotifs = await adb.collection(`users/${newOwner.uid}/notifications`).get();
    expect(newOwnerNotifs.docs.some((d) => d.data().kind === "ticket" && d.data().title === "Ticket refunded")).toBe(true);
    const originalBuyerNotifs = await adb.collection(`users/${originalBuyer.uid}/notifications`).get();
    expect(originalBuyerNotifs.docs.some((d) => d.data().title === "Ticket refunded")).toBe(false);
  });

  it("is rejected on a cancelled event", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rt3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rt3buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;

    // Direct admin flip, isolating this guard from cancelEvent's own refund
    // loop (which would otherwise already have refunded this exact ticket).
    await adb.doc(`events/${eventId}`).update({ status: "cancelled", cancelledAt: Date.now(), updatedAt: Date.now() });

    await expect(callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This event has been cancelled." });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid"); // untouched
  });
});

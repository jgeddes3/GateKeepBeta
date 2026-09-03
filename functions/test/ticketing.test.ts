import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  type TicketOrderDoc, type TicketDoc, type AdminAlertDoc, TICKET_ORDER_STUCK_AFTER_MS, EVENT_NOT_ON_SALE_MESSAGE,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { ticketOrderStuckAlertId } from "../src/eventsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// Chain-heavy fixtures (profile + review + event + tiers + a purchase),
// same rationale/budget as events.test.ts's identical setConfig.
vi.setConfig({ testTimeout: 20_000 });

const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";
function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}
async function postWebhook(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "fake" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

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

async function addTiers(
  profileId: string, eventId: string, user: import("firebase/auth").User, tiers: Record<string, unknown>[],
): Promise<void> {
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId, tiers }, user);
}

// Sets tiers, then publishes: the shape every test in this file needs except
// the one that specifically exercises an unpublished event.
async function addTiersAndPublish(
  profileId: string, eventId: string, user: import("firebase/auth").User, tiers: Record<string, unknown>[],
): Promise<void> {
  await addTiers(profileId, eventId, user, tiers);
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
type FinalizeResult = { orderStatus: string };

// FakeStripe test hook (same idiom payments.test.ts uses for its own account
// object docs): the emulator has no browser Elements flow, so "the buyer
// confirmed" is simulated by flipping the fake intent's own stored status.
async function confirmFakeIntent(clientSecret: string): Promise<string> {
  const intentId = clientSecret.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded" });
  return intentId;
}

describe("createTicketOrder + finalizeTicketOrder", () => {
  it("happy path: pays, mints tickets/attendees/ticketIndex, and writes one ledger row", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("hp1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("hp1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    expect(clientSecret).toBeTruthy();

    const pending = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(pending.status).toBe("pending");
    expect(pending.faceTotalCents).toBe(5000);
    expect(pending.paymentIntentId).toBeTruthy();
    expect(pending.refundedTicketIds).toEqual([]);
    expect(pending.refundedCents).toBe(0);
    expect(pending.refundedFaceCents).toBe(0);

    await confirmFakeIntent(clientSecret!);

    const { orderStatus } = await callFn<Record<string, unknown>, FinalizeResult>(
      "finalizeTicketOrder", { orderId }, buyer.user);
    expect(orderStatus).toBe("paid");

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    expect(order.paidAt).toBeTypeOf("number");

    const ticketsSnap = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(ticketsSnap.docs).toHaveLength(2);
    expect(ticketsSnap.docs.every((d) => (d.data() as TicketDoc).status === "valid")).toBe(true);
    expect(ticketsSnap.docs.every((d) => typeof (d.data() as TicketDoc).qrSecret === "string" && (d.data() as TicketDoc).qrSecret.length > 0)).toBe(true);

    const attendeesSnap = await adb.collection(`events/${eventId}/attendees`).get();
    expect(attendeesSnap.docs).toHaveLength(2);
    expect(attendeesSnap.docs.every((d) => d.data().ownerUid === buyer.uid)).toBe(true);

    const ticketIndex = (await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).get()).data();
    expect(ticketIndex?.count).toBe(2);

    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(2);

    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    expect(ledgerSnap.docs).toHaveLength(1);
    expect(ledgerSnap.docs[0].data().kind).toBe("ticket_sale");
    expect(ledgerSnap.docs[0].data().amountCents).toBe(order.faceTotalCents + order.serviceFeeCents);
    expect(ledgerSnap.docs[0].data().profileId).toBe(profileId);

    const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notifSnap.docs.some((d) => d.data().kind === "ticket" && d.data().refId === eventId)).toBe(true);
  });

  it("a free tier completes inline: null clientSecret, no PaymentIntent, ticket minted immediately", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("free1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "Free RSVP", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "Free RSVP");
    const buyer = await makeBuyer("free1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    expect(clientSecret).toBeNull();

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    expect(order.paymentIntentId).toBeNull();
    expect(order.faceTotalCents).toBe(0);
    expect(order.serviceFeeCents).toBe(0);

    const ticketsSnap = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(ticketsSnap.docs).toHaveLength(1);
    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    expect(ledgerSnap.docs).toHaveLength(1);
  });

  it("rejects when a tier is sold out", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("so1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "VIP", priceCents: 1000, capacity: 3, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "VIP");
    await adb.doc(`events/${eventId}/tiers/${tierId}`).update({ soldCount: 3 });
    const buyer = await makeBuyer("so1buyer");

    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This tier is sold out." });

    // No partial reservation left behind by the rejected attempt.
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(3);
  });

  it("rejects over the per-buyer cap, counting tickets the buyer already holds", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cap1", { maxTicketsPerBuyer: 2 });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cap1buyer");
    await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).set({ count: 2 });

    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "You have reached the ticket limit for this event." });
  });

  it("rejects cap laundering via a second PENDING order (parallel tabs/devices), and allows it again once the first order expires", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cap2", { maxTicketsPerBuyer: 4 });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cap2buyer");

    // First order: 3 tickets, under the cap of 4, left pending (never paid).
    const first = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 3 }] }, buyer.user);
    const firstOrder = (await adb.doc(`orders/${first.orderId}`).get()).data() as TicketOrderDoc;
    expect(firstOrder.status).toBe("pending");

    // A second, concurrent order for 2 more would total 5 held+pending
    // tickets against a cap of 4 (ticketIndex.count is still 0; the first
    // order hasn't paid). Rejected even though ticketIndex alone says
    // nothing is held yet: the guard must count the buyer's OTHER pending
    // orders for this event, not just minted tickets.
    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "You have reached the ticket limit for this event." });

    // Expire the first order (backdate + sweep, the real release path) and
    // confirm the SAME request that was just rejected is allowed again.
    await adb.doc(`orders/${first.orderId}`).update({ expiresAt: Date.now() - 1000 });
    await runPaymentsSweep(Date.now());
    const expiredFirst = (await adb.doc(`orders/${first.orderId}`).get()).data() as TicketOrderDoc;
    expect(expiredFirst.status).toBe("expired");

    const second = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    const secondOrder = (await adb.doc(`orders/${second.orderId}`).get()).data() as TicketOrderDoc;
    expect(secondOrder.status).toBe("pending");
  });

  it("rejects when a tier's sale window is closed", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("sw1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "Early Bird", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: Date.now() - 60_000 }]);
    const tierId = await tierIdByName(eventId, "Early Bird");
    const buyer = await makeBuyer("sw1buyer");

    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Ticket sales for this tier are closed." });
  });

  it("rejects buying tickets for an event that isn't published", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("np1");
    // Tiers only, deliberately no publishEvent call: createEvent leaves the
    // event a draft, which is exactly the state this test exercises.
    await addTiers(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("np1buyer");

    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This event is not on sale." });
  });

  it("a second finalizeTicketOrder call is a no-op: no duplicate tickets or inventory movement", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("df1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("df1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);

    const first = await callFn<Record<string, unknown>, FinalizeResult>("finalizeTicketOrder", { orderId }, buyer.user);
    expect(first.orderStatus).toBe("paid");
    const second = await callFn<Record<string, unknown>, FinalizeResult>("finalizeTicketOrder", { orderId }, buyer.user);
    expect(second.orderStatus).toBe("paid");

    const ticketsSnap = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(ticketsSnap.docs).toHaveLength(1);
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(1);
    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", orderId).get();
    expect(ledgerSnap.docs).toHaveLength(1);
  });

  it("a buyer cannot finalize another buyer's order", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("perm1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("perm1buyer");
    const stranger = await makeBuyer("perm1stranger");

    const { orderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);

    await expect(callFn("finalizeTicketOrder", { orderId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("refuses to sell when the curator profile is no longer approved (EVENT_NOT_ON_SALE_MESSAGE)", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ctounappr");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    // Flipped directly: the reviewProfile cascade would cancel the event, and
    // this test's subject is the sale-time gate for an event the cascade missed.
    await adb.doc(`profiles/${profileId}`).update({ status: "rejected" });
    const buyer = await makeBuyer("cto_unapproved_buyer");
    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: EVENT_NOT_ON_SALE_MESSAGE });
  });
});

describe("payment_intent.succeeded webhook (purpose: tickets)", () => {
  it("completes a pending order exactly once, and no-ops on a duplicate/replayed event", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("wh1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1200, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("wh1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");

    const evt = fakeEvent("payment_intent.succeeded", { id: intentId, metadata: { purpose: "tickets", orderId } });
    expect((await postWebhook(evt)).status).toBe(200);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    const ticketsSnap = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(ticketsSnap.docs).toHaveLength(1);

    // Same event id: deduped outright by the webhook's own claim machine.
    expect((await postWebhook(evt)).text).toBe("duplicate");
    // A fresh event id carrying the same intent still reaches the handler,
    // which must no-op on an already-"paid" order.
    const replay = fakeEvent("payment_intent.succeeded", { id: intentId, metadata: { purpose: "tickets", orderId } });
    expect((await postWebhook(replay)).status).toBe(200);
    const afterReplay = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(afterReplay.docs).toHaveLength(1);
  });

  it("drops a payment_intent.succeeded with no metadata.orderId (logged, not thrown, event still marked processed)", async () => {
    const evt = fakeEvent("payment_intent.succeeded", { id: "pi_missing_order_id", metadata: { purpose: "tickets" } });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.data()?.processed).toBe(true);
  });
});

describe("ticket order expiry sweep", () => {
  it("expires a stale pending order: releases tier inventory and cancels the PaymentIntent", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("exp1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("exp1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");

    const tierBefore = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierBefore?.soldCount).toBe(2);

    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });
    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketOrdersExpired).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("expired");
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(0);

    const intent = (await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data();
    expect(intent?.status).toBe("canceled");
  });

  it("recovers from the cancel-then-transaction-fail crash window: a prior pass's successful cancel that never committed its own expiry write is finished, not deferred forever", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("exp4");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("exp4buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");

    // Force the crash window directly: a PRIOR sweep pass's cancelIntent
    // already succeeded (the intent is canceled), but its own Firestore
    // transaction never committed, so the order is still "pending" and the
    // tier still holds the reservation. A same-intent cancel on the next
    // pass would otherwise throw "already canceled" forever and strand this
    // order pending with its inventory held.
    await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "canceled" });
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketOrdersExpired).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("expired");
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(0);

    // A second pass is a no-op: the order is no longer "pending", so the
    // sweep's own query never revisits it, and inventory is released
    // exactly once.
    await runPaymentsSweep(Date.now());
    const tierStill = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierStill?.soldCount).toBe(0);
  });

  it("a free order (no PaymentIntent) that never should have stayed pending is unaffected: paid orders are never touched", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("exp3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "Free RSVP", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "Free RSVP");
    const buyer = await makeBuyer("exp3buyer");

    const { orderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    // Already "paid" (free orders complete inline), backdate expiresAt to
    // confirm the sweep leaves a non-pending order alone.
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    await runPaymentsSweep(Date.now());

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(1);
  });

  it("money always wins over expiry: an already-succeeded PaymentIntent is completed by the sweep, never expired, and finalize is then a no-op", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("exp2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("exp2buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketOrdersReconciled).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    const tierAfter = (await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data();
    expect(tierAfter?.soldCount).toBe(1);

    const { orderStatus } = await callFn<Record<string, unknown>, FinalizeResult>(
      "finalizeTicketOrder", { orderId }, buyer.user);
    expect(orderStatus).toBe("paid");
  });

  it("SP10 Task 8 (sp6 #5): an expired order whose intent already succeeded is COMPLETED by the sweep: ticket minted, buyer notified", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rec1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rec1buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketOrdersReconciled).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    const tickets = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(tickets.size).toBe(2);
    const notes = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notes.docs.some((d) => d.data().title === "Tickets confirmed")).toBe(true);
    expect((await adb.doc(`ledger/ticket_sale:${orderId}`).get()).exists).toBe(true);
    // A later finalize is the ordinary no-op.
    const { orderStatus } = await callFn<Record<string, unknown>, FinalizeResult>("finalizeTicketOrder", { orderId }, buyer.user);
    expect(orderStatus).toBe("paid");
    expect((await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get()).size).toBe(2);
  });

  it("SP10 Task 8 (sp6 #5): a pending order whose intent is neither canceled nor succeeded, older than two hours, raises ticket_order_stuck", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("stk1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("stk1buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");
    // An intent Stripe cannot cancel and has not settled: `processing`.
    await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "processing" });

    // Fresh: deferred, no alert yet.
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });
    const first = await runPaymentsSweep(Date.now());
    expect(first.ticketOrdersExpiryDeferred).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`adminAlerts/ticket-order-stuck:${orderId}`).get()).exists).toBe(false);

    // Two hours old: still deferred, and now escalated.
    await adb.doc(`orders/${orderId}`).update({ createdAt: Date.now() - TICKET_ORDER_STUCK_AFTER_MS - 60_000 });
    const second = await runPaymentsSweep(Date.now());
    expect(second.ticketOrdersStuck).toBeGreaterThanOrEqual(1);
    const alert = (await adb.doc(`adminAlerts/ticket-order-stuck:${orderId}`).get()).data() as AdminAlertDoc;
    expect(alert.kind).toBe("ticket_order_stuck");
    expect(alert.bookingId).toBeNull();
    expect(alert.detail).toContain(orderId);
    expect(alert.detail).toContain("processing");
    expect(((await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc).status).toBe("pending");
  });

  it("SP10 Task 9 controller addition: a reconcile whose completeOrderTx cannot complete still alerts and counts as an error", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("stk2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("stk2buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);
    // Money already moved (the intent succeeded), but completeOrderTx's own
    // transaction can never finish this time: corrupt the order's `items` so
    // the for-loop it iterates over throws instead of minting a ticket.
    // completeOrderTx never reads the tier doc at all (it only writes new
    // ticket/attendee docs off order.items, already captured at order
    // creation), so deleting the tier does not reach this transaction; this
    // reproduces the same "money moved, completion cannot finish" shape
    // directly on the order it fans out from.
    await adb.doc(`orders/${orderId}`).update({ items: FieldValue.delete() });
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.errors.ticketOrderExpire ?? 0).toBeGreaterThanOrEqual(1);
    const alert = (await adb.doc(`adminAlerts/${ticketOrderStuckAlertId(orderId)}`).get()).data() as AdminAlertDoc | undefined;
    expect(alert?.kind).toBe("ticket_order_stuck");
    expect(alert?.detail).toContain(orderId);
    expect(alert?.detail).toContain("completing it failed");
    // Untouched: the failed completion made no write of its own.
    expect(((await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc).status).toBe("pending");
  });
});

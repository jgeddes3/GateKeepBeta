import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  type TicketOrderDoc, type TicketDoc, type AttendeeDoc, type TicketIndexDoc, type TicketTransferDoc,
  type AdminAlertDoc, ticketServiceFeeCents,
  TICKET_ALREADY_CHECKED_IN_MESSAGE, TICKET_NOT_VALID_MESSAGE, TRANSFER_OFFER_SENT_MESSAGE, EVENT_BUYER_CAP_MESSAGE,
  CHECK_IN_TOO_EARLY_MESSAGE,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { applyTicketRefund } from "../src/ticketing.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// Chain-heavy fixtures (profile + review + event + tiers + purchases + a
// transfer saga), same rationale/budget as ticketingRefunds.test.ts's
// identical setConfig.
vi.setConfig({ testTimeout: 20_000 });

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<Record<string, unknown>, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
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

// Same FakeStripe test hook every ticketing test file uses: the emulator has
// no browser Elements flow, so "the buyer confirmed" is simulated by
// flipping the fake intent's own stored status.
async function confirmFakeIntent(clientSecret: string): Promise<string> {
  const intentId = clientSecret.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded" });
  return intentId;
}

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

// Finds the single "offered" transfer for a ticket, freshly created by
// offerTransfer above (which returns only a generic { message } and never
// the transfer's own id, per its anti-enumeration contract).
async function openOfferIdFor(ticketId: string): Promise<string> {
  const snap = await adb.collection("transfers")
    .where("ticketId", "==", ticketId).where("status", "==", "offered").get();
  if (snap.docs.length !== 1) {
    throw new Error(`expected exactly one open offer for ticket ${ticketId}, found ${snap.docs.length}`);
  }
  return snap.docs[0].id;
}

// SP10 Task 20: checkInTicket refuses a scan more than CHECK_IN_OPENS_BEFORE_MS
// (12h) before startsAt. Every fixture event starts 7 days out (eventContent),
// so a door test moves the event to 6h out right before scanning. Admin-SDK
// flip, same precedent as the "flip status directly" cases below.
async function openDoors(eventId: string): Promise<void> {
  const startsAt = Date.now() + 6 * 3_600_000;
  await adb.doc(`events/${eventId}`).update({ startsAt, endsAt: startsAt + 3 * 3_600_000, updatedAt: Date.now() });
}

describe("checkInTicket", () => {
  it("happy path: checks a valid ticket in and mirrors the attendee doc", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci1buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    await openDoors(eventId);
    const result = await callFn<Record<string, unknown>, { ownerName: string; tierName: string; checkedInAt: number }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);
    expect(result.tierName).toBe("General");
    expect(result.checkedInAt).toBeTypeOf("number");

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("checked_in");
    expect(ticket.checkedInAt).toBe(result.checkedInAt);

    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticketId}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("checked_in");
    expect(attendee.checkedInAt).toBe(result.checkedInAt);
  });

  it("a duplicate scan returns already-checked-in with the original time", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci2buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    await openDoors(eventId);
    const first = await callFn<Record<string, unknown>, { checkedInAt: number }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);

    await expect(callFn("checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: TICKET_ALREADY_CHECKED_IN_MESSAGE,
        details: { checkedInAt: first.checkedInAt },
      });
  });

  it("a wrong qrSecret is rejected and leaves the ticket untouched", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci3buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;

    await openDoors(eventId);
    await expect(callFn(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret: "not-the-real-secret" }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: TICKET_NOT_VALID_MESSAGE });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });

  it("override skips the secret for the list fallback", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci4");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci4buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;

    await openDoors(eventId);
    const result = await callFn<Record<string, unknown>, { checkedInAt: number }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, override: true }, owner.user);
    expect(result.checkedInAt).toBeTypeOf("number");

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("checked_in");
  });

  it("denies a curator who is not a member of the event's profile", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci5");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci5buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    const stranger = await makeBuyer("ci5stranger");
    await openDoors(eventId);
    await expect(callFn(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });

  it("rejects check-in on a non-published event", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci6");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci6buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    await openDoors(eventId);
    // Direct admin flip, same "flip status directly" precedent
    // ticketingRefunds.test.ts uses.
    await adb.doc(`events/${eventId}`).update({ status: "cancelled", cancelledAt: Date.now(), updatedAt: Date.now() });

    await expect(callFn(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("SP10 Task 20: refuses a scan more than 12h before startsAt with CHECK_IN_TOO_EARLY_MESSAGE and leaves the ticket valid", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci7");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci7buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    // No openDoors: the event still starts 7 days out.
    await expect(callFn("checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: expect.stringContaining(CHECK_IN_TOO_EARLY_MESSAGE) });
    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });
});

describe("undoCheckIn (SP10 Task 20)", () => {
  it("flips a checked-in ticket back to valid on both docs, clears checkedInAt, and the ticket scans again", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc1buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;
    await openDoors(eventId);
    await callFn("checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);

    const result = await callFn<Record<string, unknown>, { ok: true }>("undoCheckIn", { eventId, ticketId }, owner.user);
    expect(result.ok).toBe(true);

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
    expect(ticket.checkedInAt).toBeUndefined();
    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticketId}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("valid");
    expect(attendee.checkedInAt).toBeUndefined();

    const again = await callFn<Record<string, unknown>, { checkedInAt: number }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);
    expect(again.checkedInAt).toBeTypeOf("number");
  });

  it("refuses a ticket that is not checked in", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc2buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const ticketId = (await ticketsForOrder(buyer.uid, orderId))[0].id;
    await expect(callFn("undoCheckIn", { eventId, ticketId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("denies a caller who is not a member of the event's curator profile", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc3buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const ticketId = (await ticketsForOrder(buyer.uid, orderId))[0].id;
    const stranger = await makeBuyer("uc3stranger");
    await expect(callFn("undoCheckIn", { eventId, ticketId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("offerTransfer + respondToTransfer", () => {
  it("full lifecycle: offer notifies the recipient, accept mints a fresh ticket with a different qrSecret, the old ticket dies, and both indices move", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx1sender");
    const recipient = await makeBuyer("tx1recipient");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const oldTicketId = tickets[0].id;
    const oldSecret = tickets[0].data.qrSecret;

    const senderIdxBefore = (await adb.doc(`users/${sender.uid}/ticketIndex/${eventId}`).get()).data() as TicketIndexDoc;
    expect(senderIdxBefore.count).toBe(1);

    const offerResult = await callFn<Record<string, unknown>, { message: string }>(
      "offerTransfer", { ticketId: oldTicketId, target: recipient.user.email }, sender.user);
    expect(offerResult.message).toBe(TRANSFER_OFFER_SENT_MESSAGE);

    const recipientNotifs = await adb.collection(`users/${recipient.uid}/notifications`).get();
    expect(recipientNotifs.docs.some((d) => d.data().kind === "ticket" && d.data().title === "You've been offered a ticket"))
      .toBe(true);

    const transferId = await openOfferIdFor(oldTicketId);
    const transferBefore = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferBefore.fromUid).toBe(sender.uid);
    expect(transferBefore.toUid).toBe(recipient.uid);
    expect(transferBefore.status).toBe("offered");

    const acceptResult = await callFn<Record<string, unknown>, { ok: boolean; newTicketId: string | null }>(
      "respondToTransfer", { transferId, accept: true }, recipient.user);
    expect(acceptResult.ok).toBe(true);
    const newTicketId = acceptResult.newTicketId;
    expect(newTicketId).toBeTruthy();
    expect(newTicketId).not.toBe(oldTicketId);

    const newTicket = (await adb.doc(`users/${recipient.uid}/tickets/${newTicketId}`).get()).data() as TicketDoc;
    expect(newTicket.status).toBe("valid");
    expect(newTicket.qrSecret).not.toBe(oldSecret);
    expect(newTicket.tierId).toBe(tierId);
    expect(newTicket.orderId).toBe(orderId);

    const oldTicketAfter = (await adb.doc(`users/${sender.uid}/tickets/${oldTicketId}`).get()).data() as TicketDoc;
    expect(oldTicketAfter.status).toBe("transferred");
    expect(oldTicketAfter.transferredTo).toBe(recipient.uid);

    const oldAttendee = await adb.doc(`events/${eventId}/attendees/${oldTicketId}`).get();
    expect(oldAttendee.exists).toBe(false);
    const newAttendee = (await adb.doc(`events/${eventId}/attendees/${newTicketId}`).get()).data() as AttendeeDoc;
    expect(newAttendee.ownerUid).toBe(recipient.uid);
    expect(newAttendee.status).toBe("valid");

    const senderIdxAfter = await adb.doc(`users/${sender.uid}/ticketIndex/${eventId}`).get();
    expect(senderIdxAfter.exists).toBe(false);
    const recipientIdx = (await adb.doc(`users/${recipient.uid}/ticketIndex/${eventId}`).get()).data() as TicketIndexDoc;
    expect(recipientIdx.count).toBe(1);

    const transferAfter = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferAfter.status).toBe("accepted");
    expect(transferAfter.resolvedAt).toBeTypeOf("number");

    const senderNotifs = await adb.collection(`users/${sender.uid}/notifications`).get();
    expect(senderNotifs.docs.some((d) => d.data().title === "Ticket transfer accepted")).toBe(true);

    await openDoors(eventId);
    // The old QR is dead: the attendee doc it resolved through no longer exists.
    await expect(callFn(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId: oldTicketId, qrSecret: oldSecret }, owner.user))
      .rejects.toMatchObject({ code: "functions/not-found" });

    // The new QR works at the door.
    const scan = await callFn<Record<string, unknown>, { tierName: string }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId: newTicketId, qrSecret: newTicket.qrSecret }, owner.user);
    expect(scan.tierName).toBe("General");
  });

  it("a self-transfer is rejected before an offer to another account was even attempted", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx1s");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx1sself");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    await expect(callFn("offerTransfer", { ticketId, target: sender.user.email }, sender.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "You can't transfer a ticket to yourself." });

    const transferSnap = await adb.collection("transfers").where("ticketId", "==", ticketId).get();
    expect(transferSnap.docs).toHaveLength(0);
  });

  it("decline flips the transfer to declined and touches nothing else", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx2sender");
    const recipient = await makeBuyer("tx2recipient");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId, target: recipient.user.email }, sender.user);
    const transferId = await openOfferIdFor(ticketId);

    const result = await callFn<Record<string, unknown>, { ok: boolean; newTicketId: string | null }>(
      "respondToTransfer", { transferId, accept: false }, recipient.user);
    expect(result.ok).toBe(true);
    expect(result.newTicketId).toBeNull();

    const transferAfter = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferAfter.status).toBe("declined");

    const ticket = (await adb.doc(`users/${sender.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticketId}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("valid");
    const idx = (await adb.doc(`users/${sender.uid}/ticketIndex/${eventId}`).get()).data() as TicketIndexDoc;
    expect(idx.count).toBe(1);

    const senderNotifs = await adb.collection(`users/${sender.uid}/notifications`).get();
    expect(senderNotifs.docs.some((d) => d.data().title === "Ticket transfer declined")).toBe(true);
  });

  it("the expiry sweep expires a stale offer and frees the ticket to be offered again", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx3sender");
    const recipient = await makeBuyer("tx3recipient");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId, target: recipient.user.email }, sender.user);
    const transferId = await openOfferIdFor(ticketId);
    await adb.doc(`transfers/${transferId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketTransfersExpired).toBeGreaterThanOrEqual(1);

    const transferAfter = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferAfter.status).toBe("expired");

    const ticket = (await adb.doc(`users/${sender.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");

    // The stale (now-expired) offer no longer blocks a fresh one on the same ticket.
    const secondOffer = await callFn<Record<string, unknown>, { message: string }>(
      "offerTransfer", { ticketId, target: recipient.user.email }, sender.user);
    expect(secondOffer.message).toBe(TRANSFER_OFFER_SENT_MESSAGE);
  });

  it("a ticket already carrying an open offer cannot get a second one", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx3d");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx3dsender");
    const recipientA = await makeBuyer("tx3drecipientA");
    const recipientB = await makeBuyer("tx3drecipientB");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId, target: recipientA.user.email }, sender.user);
    await expect(callFn("offerTransfer", { ticketId, target: recipientB.user.email }, sender.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This ticket already has a pending transfer offer." });
  });

  it("cap blocks accept when the recipient reaches their ticket limit via a separate purchase made after the offer (laundering)", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx4", { maxTicketsPerBuyer: 1 });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx4sender");
    const recipient = await makeBuyer("tx4recipient");

    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    // The offer succeeds: the recipient holds nothing yet.
    await callFn("offerTransfer", { ticketId, target: recipient.user.email }, sender.user);
    const transferId = await openOfferIdFor(ticketId);

    // The recipient independently reaches the cap of 1 via their own
    // purchase, AFTER the offer was already made.
    await payOrder(eventId, tierId, 1, recipient.user);

    await expect(callFn("respondToTransfer", { transferId, accept: true }, recipient.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: EVENT_BUYER_CAP_MESSAGE });

    const ticket = (await adb.doc(`users/${sender.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
    const transferAfter = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferAfter.status).toBe("offered");
  });

  it("an offer to a nonexistent email returns the generic message and creates nothing", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx5");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const sender = await makeBuyer("tx5sender");
    const orderId = await payOrder(eventId, tierId, 1, sender.user);
    const tickets = await ticketsForOrder(sender.uid, orderId);
    const ticketId = tickets[0].id;

    const result = await callFn<Record<string, unknown>, { message: string }>(
      "offerTransfer", { ticketId, target: `nobody-${Date.now()}@nowhere.test` }, sender.user);
    expect(result.message).toBe(TRANSFER_OFFER_SENT_MESSAGE);

    const transferSnap = await adb.collection("transfers").where("ticketId", "==", ticketId).get();
    expect(transferSnap.docs).toHaveLength(0);
    const ticket = (await adb.doc(`users/${sender.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });
});

describe("cancelEvent widened resolution for a transferred ticket (Task 8 regression)", () => {
  it("tears down the RECIPIENT's live (transferred-in) ticket and notifies them, while the money still returns to the ORIGINAL buyer", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tx7");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("tx7buyer");
    const recipient = await makeBuyer("tx7recipient");

    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const order0 = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const intentId = order0.paymentIntentId!;
    const totalCents = order0.faceTotalCents + order0.serviceFeeCents;

    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const oldTicketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId: oldTicketId, target: recipient.user.email }, buyer.user);
    const transferId = await openOfferIdFor(oldTicketId);
    const acceptResult = await callFn<Record<string, unknown>, { ok: boolean; newTicketId: string | null }>(
      "respondToTransfer", { transferId, accept: true }, recipient.user);
    const newTicketId = acceptResult.newTicketId!;

    // Sanity: the recipient now holds the live ticket, the buyer holds none.
    const recipientIdxBefore = (await adb.doc(`users/${recipient.uid}/ticketIndex/${eventId}`).get()).data() as TicketIndexDoc;
    expect(recipientIdxBefore.count).toBe(1);
    const buyerIdxBefore = await adb.doc(`users/${buyer.uid}/ticketIndex/${eventId}`).get();
    expect(buyerIdxBefore.exists).toBe(false);

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(result.ok).toBe(true);

    // The RECIPIENT's ticket flips to refunded, and their attendee mirror and
    // ticketIndex are torn down.
    const recipientTicket = (await adb.doc(`users/${recipient.uid}/tickets/${newTicketId}`).get()).data() as TicketDoc;
    expect(recipientTicket.status).toBe("refunded");
    const recipientAttendee = (await adb.doc(`events/${eventId}/attendees/${newTicketId}`).get()).data() as AttendeeDoc;
    expect(recipientAttendee.status).toBe("refunded");
    const recipientIdxAfter = await adb.doc(`users/${recipient.uid}/ticketIndex/${eventId}`).get();
    expect(recipientIdxAfter.exists).toBe(false);

    // The recipient is notified, with no mention of a refund (they never paid).
    const recipientNotifs = await adb.collection(`users/${recipient.uid}/notifications`).get();
    const recipientCancelNotif = recipientNotifs.docs.find(
      (d) => d.data().kind === "ticket" && d.data().title === "Event cancelled");
    expect(recipientCancelNotif).toBeTruthy();
    expect(recipientCancelNotif!.data().body).not.toContain("refunded");

    // The BUYER receives the money (the order, and Stripe's own refund object).
    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("cancelled_refunded");
    expect(order.refundedCents).toBe(totalCents);
    expect(order.refundedTicketIds).toEqual([newTicketId]); // the CURRENT ticket, not the dead old one
    const piAfter = (await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data();
    expect(piAfter?.refundedCents).toBe(totalCents);

    // The buyer is separately notified, and THEIR body does mention the refund.
    const buyerNotifs = await adb.collection(`users/${buyer.uid}/notifications`).get();
    const buyerCancelNotif = buyerNotifs.docs.find((d) => d.data().kind === "ticket" && d.data().title === "Event cancelled");
    expect(buyerCancelNotif).toBeTruthy();
    expect(buyerCancelNotif!.data().body).toContain("refunded");

    // The old, dead ("transferred") ticket doc is left exactly as it was.
    const oldTicket = (await adb.doc(`users/${buyer.uid}/tickets/${oldTicketId}`).get()).data() as TicketDoc;
    expect(oldTicket.status).toBe("transferred");
  });
});

// Security review, fix round 1: refundTicket's Stripe refund used to run
// with nothing between it and its books-resolution transaction, so a
// transfer accept racing into that window would leave Stripe money moved and
// the books untouched, silently ({ ok: true }). Fixed in two layers:
// refundTicket's own pre-phase transaction (exercised end-to-end below, test
// "voids an open offer"), and applyTicketRefund's convergence branch
// (exercised directly below, since the emulator's Functions process is a
// separate sandbox no test can pause mid-call to inject a genuine network
// race, so "simulate the raced state, then run the post-Stripe resolution"
// is the practical equivalent.
function refundAmountsFor(order: TicketOrderDoc, tierId: string): { amountCents: number; unitPriceCents: number } {
  const item = order.items.find((it) => it.tierId === tierId);
  if (!item) throw new Error(`refundAmountsFor: no order item for tier ${tierId}`);
  const unitPriceCents = item.unitPriceCents;
  return { amountCents: unitPriceCents + ticketServiceFeeCents(unitPriceCents, order.feePolicy), unitPriceCents };
}

describe("refundTicket vs transfer race (security review fix round 1)", () => {
  it("voids an open transfer offer, notifies the would-be recipient, and a subsequent accept fails", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rtx1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rtx1buyer");
    const recipient = await makeBuyer("rtx1recipient");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId, target: recipient.user.email }, buyer.user);
    const transferId = await openOfferIdFor(ticketId);

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "refundTicket", { curatorProfileId: profileId, eventId, ticketId }, owner.user);
    expect(result.ok).toBe(true);

    const transferAfter = (await adb.doc(`transfers/${transferId}`).get()).data() as TicketTransferDoc;
    expect(transferAfter.status).toBe("voided");
    expect(transferAfter.resolvedAt).toBeTypeOf("number");

    const recipientNotifs = await adb.collection(`users/${recipient.uid}/notifications`).get();
    expect(recipientNotifs.docs.some((d) => d.data().kind === "ticket" && d.data().title === "Ticket offer withdrawn"))
      .toBe(true);

    await expect(callFn("respondToTransfer", { transferId, accept: true }, recipient.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("refunded");
  });

  it("apply-tx convergence: a raced-transferred ticket's CURRENT live descendant is torn down instead, and order counters update exactly once", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rtx2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rtx2buyer");
    const recipient = await makeBuyer("rtx2recipient");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const { amountCents, unitPriceCents } = refundAmountsFor(order, tierId);

    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const oldTicketId = tickets[0].id;

    // Constructs, via the REAL transfer flow, the exact end state a transfer
    // accept completing DURING refundTicket's Stripe call would leave
    // behind: the old ticket "transferred", a fresh live ticket minted
    // under the recipient sharing the same orderId.
    await callFn("offerTransfer", { ticketId: oldTicketId, target: recipient.user.email }, buyer.user);
    const transferId = await openOfferIdFor(oldTicketId);
    const acceptResult = await callFn<Record<string, unknown>, { ok: boolean; newTicketId: string | null }>(
      "respondToTransfer", { transferId, accept: true }, recipient.user);
    const liveTicketId = acceptResult.newTicketId!;

    // Simulates "the Stripe call already succeeded against the OLD ticket's
    // identity; now resolve the books" by calling the post-Stripe step
    // refundTicket itself calls, directly.
    await applyTicketRefund({
      eventId, ticketId: oldTicketId, ownerUid: buyer.uid, tierId, tierName: "General",
      curatorProfileId: profileId, orderId, buyerUid: buyer.uid, amountCents, unitPriceCents,
    });

    const liveTicket = (await adb.doc(`users/${recipient.uid}/tickets/${liveTicketId}`).get()).data() as TicketDoc;
    expect(liveTicket.status).toBe("refunded");
    const liveAttendee = (await adb.doc(`events/${eventId}/attendees/${liveTicketId}`).get()).data() as AttendeeDoc;
    expect(liveAttendee.status).toBe("refunded");
    const recipientIdx = await adb.doc(`users/${recipient.uid}/ticketIndex/${eventId}`).get();
    expect(recipientIdx.exists).toBe(false); // count was 1 -> deleted

    // The old (still "transferred") ticket doc is left exactly as it was.
    const oldTicket = (await adb.doc(`users/${buyer.uid}/tickets/${oldTicketId}`).get()).data() as TicketDoc;
    expect(oldTicket.status).toBe("transferred");

    const orderAfter = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(orderAfter.refundedCents).toBe(amountCents);
    expect(orderAfter.refundedFaceCents).toBe(unitPriceCents);
    expect(orderAfter.refundedTicketIds).toEqual([liveTicketId]); // the LIVE doc, not the dead old one

    const ledgerSnap = await adb.collection("ledger").where("stripeId", "==", oldTicketId).get();
    const row = ledgerSnap.docs.find((d) => d.data().kind === "ticket_grace_refund");
    expect(row?.data().amountCents).toBe(amountCents);

    const recipientNotifs = await adb.collection(`users/${recipient.uid}/notifications`).get();
    expect(recipientNotifs.docs.some((d) => d.data().kind === "ticket" && d.data().title === "Ticket refunded")).toBe(true);

    // A retry (crash recovery, a duplicate call) converges to the same
    // idempotent no-op: no double count, no second ledger row.
    await applyTicketRefund({
      eventId, ticketId: oldTicketId, ownerUid: buyer.uid, tierId, tierName: "General",
      curatorProfileId: profileId, orderId, buyerUid: buyer.uid, amountCents, unitPriceCents,
    });
    const orderAfterRetry = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(orderAfterRetry.refundedCents).toBe(amountCents);
    const ledgerSnapAfterRetry = await adb.collection("ledger").where("stripeId", "==", oldTicketId).get();
    expect(ledgerSnapAfterRetry.docs.filter((d) => d.data().kind === "ticket_grace_refund")).toHaveLength(1);
  });

  it("alerts and throws instead of silently no-op'ing when the live descendant is already checked in", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rtx3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1200, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rtx3buyer");
    const recipient = await makeBuyer("rtx3recipient");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    const { amountCents, unitPriceCents } = refundAmountsFor(order, tierId);

    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const oldTicketId = tickets[0].id;

    await callFn("offerTransfer", { ticketId: oldTicketId, target: recipient.user.email }, buyer.user);
    const transferId = await openOfferIdFor(oldTicketId);
    const acceptResult = await callFn<Record<string, unknown>, { ok: boolean; newTicketId: string | null }>(
      "respondToTransfer", { transferId, accept: true }, recipient.user);
    const liveTicketId = acceptResult.newTicketId!;

    // The recipient's live descendant is already checked in by the time the
    // (simulated) raced refund tries to resolve.
    const liveTicketBefore = (await adb.doc(`users/${recipient.uid}/tickets/${liveTicketId}`).get()).data() as TicketDoc;
    await openDoors(eventId);
    await callFn("checkInTicket",
      { curatorProfileId: profileId, eventId, ticketId: liveTicketId, qrSecret: liveTicketBefore.qrSecret }, owner.user);

    await expect(applyTicketRefund({
      eventId, ticketId: oldTicketId, ownerUid: buyer.uid, tierId, tierName: "General",
      curatorProfileId: profileId, orderId, buyerUid: buyer.uid, amountCents, unitPriceCents,
    })).rejects.toMatchObject({ code: "internal" });

    // Nothing moves in the books: the order's refund fields stay at zero,
    // and the live ticket's checked-in state is untouched, exactly the
    // "never a silent no-op" contract (this test never calls Stripe itself,
    // since it exercises the post-Stripe resolution step directly).
    const orderAfter = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(orderAfter.refundedCents).toBe(0);
    expect(orderAfter.refundedTicketIds).toEqual([]);
    const liveTicketAfter = (await adb.doc(`users/${recipient.uid}/tickets/${liveTicketId}`).get()).data() as TicketDoc;
    expect(liveTicketAfter.status).toBe("checked_in");

    const alert = (await adb.doc(`adminAlerts/ticket-refund-converge:${oldTicketId}`).get()).data() as AdminAlertDoc | undefined;
    expect(alert).toBeTruthy();
    expect(alert?.kind).toBe("ticket_refund_convergence_failed");
    expect(alert?.resolvedAt).toBeNull();
    expect(alert?.bookingId).toBeNull();
    expect(alert?.gigId).toBeNull();
  });

  it("checkInTicket's override gate is strict: a truthy non-boolean value never skips the secret check", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rtx4");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rtx4buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;

    await openDoors(eventId);
    await expect(callFn(
      "checkInTicket",
      { curatorProfileId: profileId, eventId, ticketId, qrSecret: "definitely-wrong", override: "not-literally-true" },
      owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: TICKET_NOT_VALID_MESSAGE });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });
});

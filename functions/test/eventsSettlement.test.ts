import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  type TicketOrderDoc, type EventDoc, type AdminAlertDoc, type AttendeeDoc, type TicketDoc,
  TICKET_REFUND_WINDOW_CLOSED_MESSAGE,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { runDailySweep } from "../src/scheduled.js";
import { EVENT_SETTLE_DELAY_MS, ticketSettlementBlockedAlertId } from "../src/eventsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// Chain-heavy fixtures (profile + review + event + tiers + purchases +
// onboarding), same rationale/budget as ticketingRefunds.test.ts's identical
// setConfig.
vi.setConfig({ testTimeout: 20_000 });

const HOUR_MS = 3_600_000;

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
  const startsAt = Date.now() + 7 * 24 * HOUR_MS;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * HOUR_MS,
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

// Same FakeStripe test hook ticketing.test.ts/ticketingRefunds.test.ts use:
// the emulator has no browser Elements flow, so "the buyer confirmed" is
// simulated by flipping the fake intent's own stored status.
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

async function ticketsForOrder(buyerUid: string, orderId: string): Promise<Array<{ id: string }>> {
  const snap = await adb.collection(`users/${buyerUid}/tickets`).where("orderId", "==", orderId).get();
  return snap.docs.map((d) => ({ id: d.id }));
}

// Makes the CURATOR profile payout-ready for a T+1 ticket settlement
// transfer: an Express account whose transfer flags are force-enabled
// directly, same shortcut helpers.ts's makeMoneyReady takes for the
// musician side of an SP5 booking (the account.updated webhook that would
// normally flip these flags is never triggered by these fixtures).
async function makeCuratorPayoutReady(profileId: string, ownerUser: import("firebase/auth").User): Promise<void> {
  await callFn("createOnboardingLink", { profileId }, ownerUser);
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data();
  if (!sp?.accountId) {
    throw new Error(`makeCuratorPayoutReady: profile ${profileId} has no accountId after createOnboardingLink.`);
  }
  await adb.doc(`stripeFake/state/objects/${sp.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  await adb.doc(`profiles/${profileId}/private/stripe`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  return sp.accountId;
}

// Pushes an event's endsAt to `hoursPastSettle` hours beyond the T+1 window
// (default just past it), called immediately before the sweep under test,
// same "move the timestamp via admin SDK right before the boundary-sensitive
// call" precedent helpers.ts's setGigStartsAt establishes. Ticket sales must
// already be complete before this runs: createTicketOrder refuses once
// startsAt has elapsed.
async function pushEventPastSettleWindow(eventId: string, hoursPastSettle = 1): Promise<void> {
  await adb.doc(`events/${eventId}`).update({
    endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - hoursPastSettle * HOUR_MS,
  });
}

async function ledgerRowsForEvent(eventId: string, kind: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await adb.collection("ledger").where("eventId", "==", eventId).get();
  return snap.docs.filter((d) => d.data().kind === kind);
}

describe("paymentsSweep: post-event ticket settlement", () => {
  it("settles the face value of the non-refunded tickets, transfers to the curator, and completes the event", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set1buyer");
    const orderId = await payOrder(eventId, tierId, 3, buyer.user);

    const tickets = await ticketsForOrder(buyer.uid, orderId);
    expect(tickets).toHaveLength(3);
    // Grace-refund one of the three before settlement: the settled face value
    // must be the value of the two REMAINING tickets, not all three.
    await callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId: tickets[0].id }, owner.user);
    const afterGrace = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(afterGrace.refundedFaceCents).toBe(1000);

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketSettlementsCompleted).toBeGreaterThanOrEqual(1);
    expect(report.ticketSettlementsTransferred).toBeGreaterThanOrEqual(1);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("completed");
    expect(event.completedAt).toBeTypeOf("number");
    expect(event.settlementStartedAt).toBeTypeOf("number"); // claimed before the transfer

    // FakeStripe actually recorded the transfer: the curator's connected
    // account balance moved by exactly the face value of the 2 remaining
    // tickets (2000), not 3.
    const acct = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acct?.balanceCents).toBe(2000);

    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(1);
    expect(rows[0].data().amountCents).toBe(2000);
    expect(rows[0].data().profileId).toBe(profileId);
  });

  it("completes a free-RSVP-only event with no transfer and no ledger row", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "Free RSVP", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "Free RSVP");
    const buyer = await makeBuyer("set2buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    await pushEventPastSettleWindow(eventId);
    await runPaymentsSweep(Date.now());

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("completed");
    expect(event.completedAt).toBeTypeOf("number");
    // No transfer was ever attempted for a zero-revenue event, so the
    // settlement-start claim (which only runs immediately before the Stripe
    // call) is never stamped.
    expect(event.settlementStartedAt).toBeUndefined();

    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(0);
  });

  it("leaves an event not yet T+1 past its end untouched", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set3buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    // Ended recently, well inside the T+1 window.
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - HOUR_MS });
    await runPaymentsSweep(Date.now());

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("published");
    expect(event.completedAt).toBeUndefined();
    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(0);
  });

  it("leaves a curator-without-Stripe event published, raises an adminAlert, and notifies the curator at most once a day", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set4");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set4buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    // Deliberately NO makeCuratorPayoutReady call: this curator has no
    // connected account at all.
    await pushEventPastSettleWindow(eventId);
    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketSettlementsBlocked).toBeGreaterThanOrEqual(1);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("published"); // left for retry, never wedged
    expect(event.completedAt).toBeUndefined();
    expect(event.settlementStartedAt).toBeUndefined(); // never claimed: no transfer was attempted

    const alertId = ticketSettlementBlockedAlertId(eventId);
    const alert = (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc | undefined;
    expect(alert?.kind).toBe("ticket_settlement_blocked");
    expect(alert?.resolvedAt).toBeNull();
    expect(alert?.runCount).toBe(1);

    const blockedNotifs = () => adb.collection(`users/${owner.uid}/notifications`).get().then((snap) => snap.docs
      .filter((d) => d.data().kind === "ticket" && d.data().refId === eventId
        && d.data().title === "Finish payout setup to receive ticket revenue"));
    expect(await blockedNotifs()).toHaveLength(1);

    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(0);

    // Money review Important 3: a second sweep pass within the SAME day must
    // not send a second nudge, even though the curator is still blocked and
    // the alert row is observed again (runCount advances). The notification
    // is gated on recordAdminAlert's own day-boundary/kind-change throttle,
    // the same signal the console.error line uses.
    const report2 = await runPaymentsSweep(Date.now());
    expect(report2.ticketSettlementsBlocked).toBeGreaterThanOrEqual(1);
    const alertAfterSecond = (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc;
    expect(alertAfterSecond.runCount).toBe(2); // the row still tracks every observation
    expect(await blockedNotifs()).toHaveLength(1); // still just the one nudge
  });

  it("is idempotent on a sweep re-run: no second transfer, no duplicate ledger row", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set5");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set5buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);

    await runPaymentsSweep(Date.now());
    const afterFirst = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(afterFirst.status).toBe("completed");
    const acctAfterFirst = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acctAfterFirst?.balanceCents).toBe(1500);

    // Second run: the query only ever selects "published" events, so an
    // already-completed event is not even re-examined.
    await runPaymentsSweep(Date.now());
    const acctAfterSecond = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acctAfterSecond?.balanceCents).toBe(1500); // unchanged
    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(1); // no duplicate row
  });

  it("does not double-transfer when the completion write is retried, and refunds are frozen so the recomputed amount cannot drift", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set6");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1200, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set6buyer");
    const orderId = await payOrder(eventId, tierId, 2, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);

    await runPaymentsSweep(Date.now());
    const afterFirst = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(afterFirst.status).toBe("completed");
    expect(afterFirst.settlementStartedAt).toBeTypeOf("number");
    const acctAfterFirst = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acctAfterFirst?.balanceCents).toBe(2400);

    // A grace refund attempted DURING the crash window below is refused
    // (endsAt already passed before the first sweep pass): this is the money
    // review's Critical 1 fix, and it is what guarantees the retry recomputes
    // the exact same amount rather than a drifted one.
    await expect(callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId: tickets[0].id }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: TICKET_REFUND_WINDOW_CLOSED_MESSAGE });

    // Simulate the "transfer succeeded, then the completion transaction was
    // lost" crash this step's own contract must survive: revert the event
    // back to "published" by hand, leaving settlementStartedAt (and
    // completedAt) behind, as a real crash between the transfer and the flip
    // would.
    await adb.doc(`events/${eventId}`).update({ status: "published" });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketSettlementsCompleted).toBeGreaterThanOrEqual(1);
    // If the recomputed amount had drifted, FakeStripe's idempotency-key
    // fingerprint check (same key, different amount) would reject the retry
    // and this step would count it as a failed transfer instead of a clean
    // replay.
    expect(report.errors.ticketSettlementTransfer ?? 0).toBe(0);

    const afterRetry = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(afterRetry.status).toBe("completed");
    expect(afterRetry.settlementStartedAt).toBe(afterFirst.settlementStartedAt); // claimed once, never re-stamped

    // The idempotency key (`ticket_settlement:{eventId}`) protected the
    // retry: Stripe replayed the SAME transfer instead of minting a second
    // one, so the account balance moved by 2400 total, not 4800.
    const acct = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acct?.balanceCents).toBe(2400);
    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(1);

    const failedAlert = await adb.doc(`adminAlerts/ticket-settlement-failed:${eventId}`).get();
    expect(failedAlert.exists).toBe(false);
  });
});

describe("cancelEvent: blocked once ticket settlement has started", () => {
  it("rejects cancellation once settlementStartedAt is stamped, even if the completion write has not landed yet", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("csv1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("csv1buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);
    await runPaymentsSweep(Date.now());

    const afterSettle = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(afterSettle.status).toBe("completed");
    expect(afterSettle.settlementStartedAt).toBeTypeOf("number");

    // Simulate the crash window (same technique as the double-transfer test
    // above): the transfer succeeded and settlementStartedAt is stamped, but
    // the completion write is reverted, leaving the event "published" again
    // as it would be mid-crash.
    await adb.doc(`events/${eventId}`).update({ status: "published" });

    await expect(callFn("cancelEvent", { curatorProfileId: profileId, eventId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("published"); // untouched by the rejected cancel
    expect(event.cancelledAt).toBeUndefined();
  });

  it("still allows cancelling an ended event whose settlement has not started yet", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("csv2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("csv2buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    // Ended, but well inside the T+1 window: settlement has not begun.
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - HOUR_MS });

    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(result.ok).toBe(true);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("cancelled");
  });
});

describe("refundTicket: settlement freeze window", () => {
  it("rejects a grace refund once the event has ended", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rtf1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rtf1buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);

    // Push endsAt into the past: the event has ended, well before it is even
    // T+1-eligible for settlement.
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - HOUR_MS });

    await expect(callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId: tickets[0].id }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: TICKET_REFUND_WINDOW_CLOSED_MESSAGE });

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${tickets[0].id}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid"); // untouched
  });
});

describe("dailySweep: event-tomorrow reminders", () => {
  it("notifies each distinct ticket-holder once and stamps reminderSentAt; a second run sends nothing new", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rem1", {
      startsAt: Date.now() + 20 * HOUR_MS, endsAt: Date.now() + 23 * HOUR_MS,
    });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyerA = await makeBuyer("rem1a");
    const buyerB = await makeBuyer("rem1b");
    // buyerA holds 2 tickets on one order, and must still get exactly ONE
    // reminder notification, not two.
    await payOrder(eventId, tierId, 2, buyerA.user);
    await payOrder(eventId, tierId, 1, buyerB.user);

    await runDailySweep(Date.now());

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.reminderSentAt).toBeTypeOf("number");

    // Filtered on the reminder's own exact title, never a body substring:
    // both the purchase-confirmation notification (completeOrderTx) and the
    // reminder are kind "ticket" with refId=eventId, and both bodies mention
    // the event title, so only the title distinguishes them.
    for (const buyer of [buyerA, buyerB]) {
      const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
      const reminders = notifSnap.docs.filter((d) => d.data().kind === "ticket" && d.data().refId === eventId
        && d.data().title === "Event tomorrow");
      expect(reminders).toHaveLength(1);
    }

    // Second run: reminderSentAt is already set, so nothing new is sent.
    await runDailySweep(Date.now());
    for (const buyer of [buyerA, buyerB]) {
      const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
      const reminders = notifSnap.docs.filter((d) => d.data().kind === "ticket" && d.data().refId === eventId
        && d.data().title === "Event tomorrow");
      expect(reminders).toHaveLength(1); // still just the one
    }
  });

  it("does not remind an event more than 24h out", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rem2", {
      startsAt: Date.now() + 48 * HOUR_MS, endsAt: Date.now() + 51 * HOUR_MS,
    });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rem2buyer");
    await payOrder(eventId, tierId, 1, buyer.user);

    await runDailySweep(Date.now());

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.reminderSentAt).toBeUndefined();
    // The buyer's purchase-confirmation notification (kind "ticket",
    // refId=eventId) legitimately exists from payOrder; only the reminder's
    // own exact title tells the two apart.
    const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notifSnap.docs.some((d) => d.data().title === "Event tomorrow")).toBe(false);
  });

  it("does not remind an event with only refunded attendees", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rem3", {
      startsAt: Date.now() + 20 * HOUR_MS, endsAt: Date.now() + 23 * HOUR_MS,
    });
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rem3buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    await callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId: tickets[0].id }, owner.user);

    await runDailySweep(Date.now());

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    // The event itself is still reminder-eligible (it stamps reminderSentAt
    // either way, so it is never re-scanned every day forever), but nobody
    // gets notified: every attendee projection row is "refunded".
    expect(event.reminderSentAt).toBeTypeOf("number");
    const attendeesSnap = await adb.collection(`events/${eventId}/attendees`).get();
    expect(attendeesSnap.docs.every((d) => (d.data() as AttendeeDoc).status === "refunded")).toBe(true);
    const notifSnap = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notifSnap.docs.some((d) => d.data().title === "Event tomorrow")).toBe(false);
  });
});

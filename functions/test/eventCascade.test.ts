import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { TicketOrderDoc, EventDoc, AdminAlertDoc } from "@gatekeep/shared";
import { runDailySweep } from "../src/scheduled.js";
import { ORGANIZER_INACTIVE_REASON, type EventCascadeRetryDoc } from "../src/events.js";
import { eventCascadeStuckAlertId } from "../src/eventsCore.js";
import { cascadeEventsForUnpublishedProfile } from "../src/review.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 30_000 });

async function adminAlert(alertId: string): Promise<AdminAlertDoc | undefined> {
  return (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc | undefined;
}

// Fixtures copied from ticketingRefunds.test.ts lines 15-88.

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

async function pollNotifications(uid: string, predicate: (d: FirebaseFirestore.DocumentData) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const notes = await adb.collection(`users/${uid}/notifications`).get();
    const hit = notes.docs.find((d) => predicate(d.data()));
    if (hit || Date.now() > deadline) return hit;
    await wait(250);
  }
}

describe("reviewProfile reject-from-approved: events cascade", () => {
  it("cancels and refunds a published future event, cancels a draft, leaves a completed event alone, and queues a poisoned event", async () => {
    const { owner, profileId, eventId: liveId } = await makeDraftEvent("evc1");
    await addTiersAndPublish(profileId, liveId, owner.user,
      [{ name: "General", priceCents: 2000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(liveId, "General");
    const buyer = await makeBuyer("evc1buyer");
    const orderId = await payOrder(liveId, tierId, 1, buyer.user);

    const { eventId: draftId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Draft night" }) }, owner.user);
    const { eventId: doneId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Done night" }) }, owner.user);
    await adb.doc(`events/${doneId}`).update({ status: "completed", completedAt: Date.now() });
    // Poisoned: published, future, but settlement already claimed, so
    // cancelEventCore refuses (events.ts:469-472). Seeded via the admin SDK;
    // unreachable through the callables for a future-dated event.
    const { eventId: poisonId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Poisoned night" }) }, owner.user);
    await adb.doc(`events/${poisonId}`).update({ status: "published", settlementStartedAt: Date.now() });

    const reviewer = await makeAdminUser("evc1r");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, reviewer.user);

    expect((await adb.doc(`events/${liveId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`events/${draftId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`events/${doneId}`).get()).data()?.status).toBe("completed");
    expect((await adb.doc(`events/${poisonId}`).get()).data()?.status).toBe("published");

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("cancelled_refunded");
    expect(order.refundedCents).toBe(order.faceTotalCents + order.serviceFeeCents);

    const note = await pollNotifications(buyer.uid, (d) => d.kind === "ticket" && d.title === "Event cancelled");
    expect(note).toBeDefined();
    expect(note!.data().body).toContain(ORGANIZER_INACTIVE_REASON);

    const retry = (await adb.doc(`eventCascadeRetries/${poisonId}`).get()).data() as EventCascadeRetryDoc | undefined;
    expect(retry).toBeDefined();
    expect(retry!.profileId).toBe(profileId);
    expect(retry!.reason).toBe(ORGANIZER_INACTIVE_REASON);
    expect(retry!.attempts).toBe(1);
    expect(retry!.lastError).toMatch(/settlement/i);

    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_rejected").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().detail).toContain("cancelled 2 events");
    expect(logs.docs[0].data().detail).toContain("1 events queued for retry");
  });
});

describe("dailySweep step 9: drainEventCascadeRetries", () => {
  it("cancels a queued event and deletes its retry doc; a still-poisoned event stays queued with attempts bumped", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("evc2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const { eventId: poisonId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Still poisoned" }) }, owner.user);
    await adb.doc(`events/${poisonId}`).update({ status: "published", settlementStartedAt: Date.now() });
    const seed: EventCascadeRetryDoc = { profileId, reason: ORGANIZER_INACTIVE_REASON, attempts: 1, lastError: "seeded", createdAt: Date.now() };
    await adb.doc(`eventCascadeRetries/${eventId}`).set(seed);
    await adb.doc(`eventCascadeRetries/${poisonId}`).set(seed);

    const report = await runDailySweep(Date.now());
    expect(report.eventCascadeRetried).toBeGreaterThanOrEqual(1);
    expect(report.errors.eventCascadeRetries).toBeGreaterThanOrEqual(1);

    expect((await adb.doc(`events/${eventId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`eventCascadeRetries/${eventId}`).get()).exists).toBe(false);
    const stuck = (await adb.doc(`eventCascadeRetries/${poisonId}`).get()).data() as EventCascadeRetryDoc;
    expect(stuck.attempts).toBe(2);
    expect(stuck.lastError).toMatch(/settlement/i);
  });
});

describe("fix round 1: a permanently poisoned retry doc escalates", () => {
  it("alerts event_cascade_stuck once attempts reach the max, and keeps alerting on later runs", async () => {
    const eventId = `evc-ghost-${Date.now()}`;
    const seed: EventCascadeRetryDoc = {
      profileId: "ghost-profile", reason: ORGANIZER_INACTIVE_REASON, attempts: 2,
      lastError: "seeded", createdAt: Date.now(),
    };
    await adb.doc(`eventCascadeRetries/${eventId}`).set(seed);

    await runDailySweep(Date.now());

    const afterFirst = (await adb.doc(`eventCascadeRetries/${eventId}`).get()).data() as EventCascadeRetryDoc;
    expect(afterFirst.attempts).toBe(3);
    const alertId = eventCascadeStuckAlertId(eventId);
    const alert = await adminAlert(alertId);
    expect(alert).toBeDefined();
    expect(alert!.kind).toBe("event_cascade_stuck");
    expect(alert!.runCount).toBe(1);

    await runDailySweep(Date.now());

    const afterSecond = (await adb.doc(`eventCascadeRetries/${eventId}`).get()).data() as EventCascadeRetryDoc;
    expect(afterSecond.attempts).toBe(4);
    const alertAfterSecond = await adminAlert(alertId);
    expect(alertAfterSecond!.kind).toBe("event_cascade_stuck");
    expect(alertAfterSecond!.runCount).toBe(2);
  });
});

describe("fix round 1: a re-queued event keeps its attempts count", () => {
  it("increments attempts instead of resetting to 1 when the retry doc already exists", async () => {
    const { profileId, eventId } = await makeDraftEvent("evc3");
    // Simulate the event already having failed cascade once before (e.g. a
    // prior reject-from-approved cycle for the same profile): pre-seed a
    // retry doc with an old createdAt and attempts already at 1.
    const oldCreatedAt = Date.now() - 999_000;
    await adb.doc(`eventCascadeRetries/${eventId}`).set({
      profileId, reason: ORGANIZER_INACTIVE_REASON, attempts: 1,
      lastError: "first failure", createdAt: oldCreatedAt,
    });
    // Poison the event so a fresh cascade attempt fails again the same way
    // the brief's poisoned-event fixture does.
    await adb.doc(`events/${eventId}`).update({ status: "published", settlementStartedAt: Date.now() });

    const now = Date.now();
    const result = await cascadeEventsForUnpublishedProfile(adb as unknown as FirebaseFirestore.Firestore, profileId, now);
    expect(result.queued).toBeGreaterThanOrEqual(1);

    const retry = (await adb.doc(`eventCascadeRetries/${eventId}`).get()).data() as EventCascadeRetryDoc;
    expect(retry.attempts).toBe(2);
    expect(retry.createdAt).toBe(oldCreatedAt);
    expect(retry.lastError).toMatch(/settlement/i);
  });
});

describe("fix round 1: the cascade recovers if its listing queries throw", () => {
  it("returns an empty summary instead of throwing, and alerts event_cascade_stuck for the profile", async () => {
    function throwingCollection(): FirebaseFirestore.Query {
      const chain = {
        where: () => chain,
        get: () => Promise.reject(new Error("firestore listing boom")),
      };
      return chain as unknown as FirebaseFirestore.Query;
    }
    const throwingDb = { collection: () => throwingCollection() } as unknown as FirebaseFirestore.Firestore;
    const profileId = `evc-throw-profile-${Date.now()}`;

    const result = await cascadeEventsForUnpublishedProfile(throwingDb, profileId, Date.now());
    expect(result).toEqual({ cancelled: 0, queued: 0 });

    const alertId = `event_cascade_stuck:profile:${profileId}`;
    const alert = await adminAlert(alertId);
    expect(alert).toBeDefined();
    expect(alert!.kind).toBe("event_cascade_stuck");
    expect(alert!.detail).toContain(profileId);
  });
});

/**
 * SP5c Task 7: copies of the event/ticket-settlement fixtures
 * `eventsSettlement.test.ts` already carries as its own locals
 * (`makeApprovedCuratorProfile`, `eventContent`, `makeDraftEvent`,
 * `addTiersAndPublish`, `tierIdByName`, `makeBuyer`, `confirmFakeIntent`,
 * `payOrder`, `makeCuratorPayoutReady`, `pushEventPastSettleWindow`,
 * `ledgerRowsForEvent`), pulled out here so `eventsSettlementOrders.test.ts`
 * can share them without importing test-local functions across files.
 * `eventsSettlement.test.ts` keeps its own copies unchanged; this file is
 * NOT imported by it.
 */
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import { adb } from "./discoverFixtures";
import { EVENT_SETTLE_DELAY_MS } from "../src/eventsCore.js";

const HOUR_MS = 3_600_000;

export async function makeApprovedCuratorProfile(emailPrefix: string) {
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

export function eventContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = Date.now() + 7 * 24 * HOUR_MS;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * HOUR_MS,
    lineup: [{ kind: "external", name: "The Quartet" }],
    ...overrides,
  };
}

export async function makeDraftEvent(prefix: string, overrides: Record<string, unknown> = {}) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent(overrides) }, owner.user);
  return { owner, profileId, eventId };
}

export async function addTiersAndPublish(
  profileId: string, eventId: string, user: import("firebase/auth").User, tiers: Record<string, unknown>[],
): Promise<void> {
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId, tiers }, user);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, user);
}

export async function tierIdByName(eventId: string, name: string): Promise<string> {
  const snap = await adb.collection(`events/${eventId}/tiers`).get();
  const doc = snap.docs.find((d) => d.data().name === name);
  if (!doc) throw new Error(`tier "${name}" not found for event ${eventId}`);
  return doc.id;
}

export function makeBuyer(prefix: string) {
  return signUpTestUser(`${prefix}-${Date.now()}@test.com`);
}

type CreateOrderResult = { orderId: string; clientSecret: string | null };

// Same FakeStripe test hook ticketing.test.ts/ticketingRefunds.test.ts use:
// the emulator has no browser Elements flow, so "the buyer confirmed" is
// simulated by flipping the fake intent's own stored status. Also stamps a
// `chargeId` (same convention paymentsDisputes.test.ts's own confirm helper
// uses): real Stripe always attaches a Charge to a succeeded PaymentIntent,
// and this file's tests (SP5c Task 7) need one on the order for per-order
// sourced settlement, which eventsSettlement.test.ts's own copy of this
// helper never had to provide before this task.
export async function confirmFakeIntent(clientSecret: string): Promise<string> {
  const intentId = clientSecret.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded", chargeId: `ch_${intentId}` });
  return intentId;
}

export async function payOrder(
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

// Makes the CURATOR profile payout-ready for a T+1 ticket settlement
// transfer: an Express account whose transfer flags are force-enabled
// directly, same shortcut helpers.ts's makeMoneyReady takes for the
// musician side of an SP5 booking (the account.updated webhook that would
// normally flip these flags is never triggered by these fixtures).
export async function makeCuratorPayoutReady(profileId: string, ownerUser: import("firebase/auth").User): Promise<string> {
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
export async function pushEventPastSettleWindow(eventId: string, hoursPastSettle = 1): Promise<void> {
  await adb.doc(`events/${eventId}`).update({
    endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - hoursPastSettle * HOUR_MS,
  });
}

export async function ledgerRowsForEvent(eventId: string, kind: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await adb.collection("ledger").where("eventId", "==", eventId).get();
  return snap.docs.filter((d) => d.data().kind === kind);
}

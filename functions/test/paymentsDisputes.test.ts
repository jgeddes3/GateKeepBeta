import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt, ageConfirmedAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  computeDepositCents, computeExpectedTotalCents, computeFeeShareCents, DEFAULT_FEE_POLICY, SETTLEMENT_CLAIM_STALE_MS,
  type AdminAlertDoc, type DisputeRecord, type LedgerEntry, type NotificationDoc, type PaymentDoc,
  type ProfileDraftInput, type StripeProfileDoc, type TicketOrderDoc, type EventDoc,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { disputeAlertId, disputeReversalAlertId, externalRefundAlertId } from "../src/paymentsCore.js";
import { EVENT_SETTLE_DELAY_MS } from "../src/eventsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";
vi.setConfig({ testTimeout: 60_000 });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FEE = DEFAULT_FEE_POLICY;
const RATE_CENTS = 15_000;
const DURATION_MINUTES = 90;
const BASE_CENTS = computeExpectedTotalCents("perHour", RATE_CENTS, { durationMinutes: DURATION_MINUTES });
const SLICE_CENTS = computeDepositCents(BASE_CENTS);
const DEPOSIT_CHARGE_CENTS = SLICE_CENTS + computeFeeShareCents(SLICE_CENTS, FEE.curatorFeePct);

// ---------- fixtures (the paymentsSettlement.test.ts and eventsSettlement.test.ts shapes) ----------

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.", "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid, startSec: 0, durationSec: 20,
    storagePath: "public/tracks/seed/demo.m4a", rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz", description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] }, durationMinutes: DURATION_MINUTES,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * DAY_MS, ...overrides,
  };
}

async function createOpenGig(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>("createGig", { profileId, ...gigContent(overrides) }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

async function makeConfirmedBooking(prefix: string, opts: { pastStartHours?: number } = {}) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: { amountCents: RATE_CENTS, note: "Hi" } }, musician.owner.user);
  // SP10 Task 22 (sp4 #24): applyToGig now refuses an already-elapsed
  // startsAt, so the past-dating must happen AFTER the offer, not before.
  if (opts.pastStartHours != null) await setGigStartsAt(gigId, -opts.pastStartHours);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

// A whole-run booking (the payments.test.ts fixture, same "never leave an
// active series behind in the shared emulator" contract: every caller flips it
// to "ended" in a finally). ONE deposit intent funds BOTH occurrences, which is
// the only way a single disputed charge can sit behind two forfeit transfers.
function seedSeries(curatorProfileId: string) {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode: "whole_run", status: "active",
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    template: {
      title: "Friday Night Jazz", description: "A cozy weekly set.",
      wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
      durationMinutes: DURATION_MINUTES,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: {
        venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
        geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: "123 Main St, Austin, TX",
      },
    },
    templatePrivateLocation: { address: "123 Main St, Austin, TX", geo: { lat: 30.27, lng: -97.74 } },
    materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
    activeBookingId: null, bookedMusicianProfileId: null,
  }).then(() => ref);
}

async function makeConfirmedRunBooking(prefix: string, offsetsHours: number[]) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const series = await seedSeries(curator.profileId);
  const gigIds: string[] = [];
  for (const hours of offsetsHours) {
    const gigId = await createOpenGig(curator.profileId, curator.owner.user, { startsAt: Date.now() + hours * HOUR_MS });
    await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });
    gigIds.push(gigId);
  }
  // A whole-run accept stages EVERY open occurrence of the series behind one
  // deposit intent, whichever one the offer came in on.
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId: gigIds[0], musicianProfileId: musician.profileId, offer: { amountCents: RATE_CENTS, note: "Hi" } },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, series, gigIds, bookingId };
}

async function settleBooking(bookingId: string, gigId: string): Promise<PaymentDoc> {
  await runPaymentsSweep(Date.now()); // step 4 schedules
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).update({ "settlement.settleAfter": Date.now() - 1000 });
  await runPaymentsSweep(Date.now()); // step 5 charges and transfers
  const p = (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc;
  expect(p.settlement.status).toBe("paid");
  return p;
}

async function getPayment(bookingId: string, gigId: string): Promise<PaymentDoc> {
  return (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc;
}
async function getStripeDoc(profileId: string): Promise<StripeProfileDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;
}
async function fakeObject(id: string): Promise<Record<string, unknown> | undefined> {
  return (await adb.doc(`stripeFake/state/objects/${id}`).get()).data();
}
async function accountBalanceCents(accountId: string): Promise<number> {
  return ((await fakeObject(accountId))?.balanceCents as number | undefined) ?? 0;
}
async function ledgerRow(id: string): Promise<LedgerEntry | undefined> {
  return (await adb.doc(`ledger/${id}`).get()).data() as LedgerEntry | undefined;
}
async function adminAlert(alertId: string): Promise<AdminAlertDoc | undefined> {
  return (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc | undefined;
}
async function disputeDoc(disputeId: string): Promise<DisputeRecord | undefined> {
  return (await adb.doc(`disputes/${disputeId}`).get()).data() as DisputeRecord | undefined;
}
async function notificationsFor(uid: string): Promise<NotificationDoc[]> {
  return (await adb.collection(`users/${uid}/notifications`).get()).docs.map((d) => d.data() as NotificationDoc);
}

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

// A Stripe Dispute object as the webhook delivers it (the fields the handlers read).
function disputeObject(p: {
  id: string; intentId: string; chargeId: string | null; amountCents: number; status: string; feeCents?: number;
}): Record<string, unknown> {
  return {
    id: p.id, object: "dispute", amount: p.amountCents, charge: p.chargeId, payment_intent: p.intentId,
    reason: "fraudulent", status: p.status, currency: "usd",
    balance_transactions: [{ id: `txn_${p.id}`, fee: p.feeCents ?? 1500, amount: -p.amountCents }],
  };
}
function newDisputeId(): string { return `dp_fake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }

// ---------- ticket fixtures ----------
function eventContent(): Record<string, unknown> {
  const startsAt = Date.now() + 7 * DAY_MS;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * HOUR_MS, lineup: [{ kind: "external", name: "The Quartet" }],
  };
}
async function makePublishedEvent(prefix: string, priceCents: number) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user);
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId,
    tiers: [{ name: "General", priceCents, capacity: 50, saleStartsAt: null, saleEndsAt: null }] }, owner.user);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user);
  const tiers = await adb.collection(`events/${eventId}/tiers`).get();
  return { owner, profileId, eventId, tierId: tiers.docs[0].id };
}
async function payOrder(eventId: string, tierId: string, quantity: number, prefix: string) {
  const buyer = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { orderId, clientSecret } = await callFn<Record<string, unknown>, { orderId: string; clientSecret: string | null }>(
    "createTicketOrder", { eventId, items: [{ tierId, quantity }] }, buyer.user);
  const intentId = clientSecret!.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded", chargeId: `ch_${intentId}` });
  await callFn("finalizeTicketOrder", { orderId }, buyer.user);
  return { buyer, orderId, intentId, chargeId: `ch_${intentId}` };
}
async function makeCuratorPayoutReady(profileId: string, ownerUser: import("firebase/auth").User): Promise<string> {
  await callFn("createOnboardingLink", { profileId }, ownerUser);
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data();
  await adb.doc(`stripeFake/state/objects/${sp!.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  await adb.doc(`profiles/${profileId}/private/stripe`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  return sp!.accountId as string;
}

describe("SP10 Task 5: charge.dispute.created", () => {
  it("deposit charge: ledger row, alert, delinquency, notification, dispute record", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dc1");
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("held");
    const disputeId = newDisputeId();
    const evt = fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "needs_response",
    }));
    expect((await postWebhook(evt)).status).toBe(200);

    const row = await ledgerRow(`dispute_opened:${disputeId}`);
    expect(row?.kind).toBe("dispute_opened");
    expect(row?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(row?.bookingId).toBe(bookingId);
    expect(row?.profileId).toBe(curator.profileId);
    expect(row?.detail).toContain("fee 1500c");
    expect(row?.detail).toContain("fraudulent");

    const alert = await adminAlert(disputeAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_opened");
    expect(alert?.bookingId).toBe(bookingId);
    expect(alert?.resolvedAt).toBeNull();

    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    expect((await notificationsFor(curator.owner.uid)).some((n) => n.title === "A payment was disputed")).toBe(true);

    const rec = await disputeDoc(disputeId);
    expect(rec).toMatchObject({
      chargeId: p.deposit.chargeId, intentId: p.deposit.intentId, purpose: "deposit", bookingId,
      amountCents: DEPOSIT_CHARGE_CENTS, feeCents: 1500, reason: "fraudulent", status: "open",
      curatorProfileId: curator.profileId,
    });
    expect(typeof rec?.openedAt).toBe("number");

    // A settlement paid for another date must NOT lift the dispute gate: the
    // open dispute is a debt clearDelinquencyIfSettled now sees.
    await adb.doc(`profiles/${curator.profileId}/private/stripe`).set({ delinquent: true }, { merge: true });
    const { clearDelinquencyIfSettled } = await import("../src/paymentsCore.js");
    await clearDelinquencyIfSettled(curator.profileId, Date.now());
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);

    // A fresh event id for the same dispute: the ledger row dedupes, the alert counts a recurrence.
    expect((await postWebhook(fakeEvent("charge.dispute.created", evt.data.object))).status).toBe(200);
    expect((await adminAlert(disputeAlertId(disputeId)))?.runCount).toBe(2);
    expect((await adb.collection("ledger").where("stripeId", "==", disputeId).get()).size).toBe(1);
  });

  it("settlement charge: the dispute record names the occurrence and the curator", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dc2", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    const disputeId = newDisputeId();
    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 1000, status: "needs_response",
    })))).status).toBe(200);
    expect(await disputeDoc(disputeId)).toMatchObject({ purpose: "settlement", bookingId, gigId, curatorProfileId: curator.profileId, status: "open" });
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
  });

  it("ticket order: the order is stamped open and no curator is flagged", async () => {
    const { profileId, eventId, tierId } = await makePublishedEvent("dc3", 1000);
    const { orderId, intentId, chargeId } = await payOrder(eventId, tierId, 2, "dc3buyer");
    const disputeId = newDisputeId();
    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId, chargeId, amountCents: 2000, status: "needs_response",
    })))).status).toBe(200);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.disputeId).toBe(disputeId);
    expect(order.disputeStatus).toBe("open");
    expect(await disputeDoc(disputeId)).toMatchObject({ purpose: "tickets", orderId, status: "open", curatorProfileId: null });
    expect((await getStripeDoc(profileId))?.delinquent).not.toBe(true);
    expect((await adminAlert(disputeAlertId(disputeId)))?.kind).toBe("dispute_opened");
  });

  it("a dispute on an intent Stripe does not know is recorded (200) and escalated, never thrown", async () => {
    const disputeId = newDisputeId();
    const evt = fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: "pi_unknown_1", chargeId: "ch_unknown_1", amountCents: 500, status: "needs_response",
    }));
    expect((await postWebhook(evt)).status).toBe(200);
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.processed).toBe(true);
    const alert = await adminAlert(disputeAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_opened");
    expect(alert?.detail).toContain("could not be resolved");
    expect(await disputeDoc(disputeId)).toBeUndefined();
  });

  it("review round 1 (Important 1/2): a redelivered dispute (two event ids) declares delinquency and notifies the curator exactly once", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dc5");
    const p = await getPayment(bookingId, gigId);
    const disputeId = newDisputeId();
    const object = disputeObject({
      id: disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "needs_response",
    });
    expect((await postWebhook(fakeEvent("charge.dispute.created", object))).status).toBe(200);
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    const firstDelinquentSince = (await getStripeDoc(curator.profileId))?.delinquentSince;

    // A fresh event id for the SAME dispute: the redelivery must not
    // re-declare delinquency (declareCuratorDelinquent's own idempotent
    // no-write when already delinquent) or send a second notification.
    expect((await postWebhook(fakeEvent("charge.dispute.created", object))).status).toBe(200);
    expect((await getStripeDoc(curator.profileId))?.delinquentSince).toBe(firstDelinquentSince);

    const notes = (await notificationsFor(curator.owner.uid)).filter((n) => n.title === "A payment was disputed");
    expect(notes.length).toBe(1);
  });

  it("review round 1 (Important 1): a late created behind an already-decided dispute does not re-flag the curator or reopen the order", async () => {
    const { profileId, eventId, tierId } = await makePublishedEvent("dc6", 1000);
    const { orderId, intentId, chargeId } = await payOrder(eventId, tierId, 2, "dc6buyer");
    const disputeId = newDisputeId();
    // Pre-seed a DECIDED dispute record, as if Task 6's charge.dispute.closed
    // handler already resolved it and this "created" arrived late, behind
    // the resolution (a redelivery, or an out-of-order webhook delivery).
    const wonRecord: DisputeRecord = {
      chargeId, intentId, purpose: "tickets", orderId, curatorProfileId: null,
      amountCents: 2000, feeCents: 1500, reason: "fraudulent", status: "won",
      openedAt: Date.now() - 10_000, closedAt: Date.now(),
    };
    await adb.doc(`disputes/${disputeId}`).set(wonRecord);

    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId, chargeId, amountCents: 2000, status: "needs_response",
    })))).status).toBe(200);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.disputeStatus).toBeUndefined();
    expect((await getStripeDoc(profileId))?.delinquent).not.toBe(true);
    expect((await disputeDoc(disputeId))?.status).toBe("won");
  });
});

async function openDispute(p: { intentId: string; chargeId: string | null; amountCents: number }): Promise<string> {
  const disputeId = newDisputeId();
  expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
    id: disputeId, intentId: p.intentId, chargeId: p.chargeId, amountCents: p.amountCents, status: "needs_response",
  })))).status).toBe(200);
  return disputeId;
}
async function closeDispute(p: { disputeId: string; intentId: string; chargeId: string | null; amountCents: number; status: "won" | "lost" }) {
  return postWebhook(fakeEvent("charge.dispute.closed", disputeObject({
    id: p.disputeId, intentId: p.intentId, chargeId: p.chargeId, amountCents: p.amountCents, status: p.status,
  })));
}

describe("SP10 Task 6: charge.dispute.closed", () => {
  it("lost settlement: the earnings transfer is reversed, the doc says so, the record closes", async () => {
    const { musician, gigId, bookingId } = await makeConfirmedBooking("dl1", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
    const before = await accountBalanceCents(accountId);
    expect(before).toBe(paid.transfer.amountCents);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    // A chargeback covering at least the whole earnings transfer: the reversal
    // is capped at the disputed amount, so this is the FULL-reversal case and
    // the account empties. Reversing only part of a transfer (a partial
    // chargeback, and also the ordinary case where the settlement charge is
    // smaller than the transfer it helped fund, because the deposit paid the
    // rest) is its own test below.
    const disputeCents = paid.transfer.amountCents!;
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: disputeCents });

    const res = await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: disputeCents, status: "lost" });
    expect(res.status).toBe(200);

    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(paid.transfer.id!).then((t) => t?.reversed)).toBe(true);
    const after = await getPayment(bookingId, gigId);
    expect(after.transfer.status).toBe("reversed");
    const rec = await disputeDoc(disputeId);
    expect(rec?.status).toBe("lost");
    expect(rec?.reversalTransferId).toBeTruthy();
    expect(typeof rec?.closedAt).toBe("number");
    const row = await ledgerRow(`dispute_lost:${disputeId}`);
    expect(row?.amountCents).toBe(disputeCents);
    expect(row?.detail).toContain(rec!.reversalTransferId!);
    expect(await adb.doc(`stripeFake/state/idem/${encodeURIComponent(`dispute_reverse:${disputeId}`)}`).get().then((s) => s.exists)).toBe(true);
    // Redelivery: nothing moves twice.
    expect((await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: disputeCents, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(0);
  });

  it("lost deposit with a forfeit: the forfeit transfer is reversed", async () => {
    const { curator, musician, gigId, bookingId } = await makeConfirmedBooking("dl2");
    await setGigStartsAt(gigId, 10);
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Venue flooded." }, curator.owner.user);
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("forfeited");
    const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
    expect(await accountBalanceCents(accountId)).toBe(SLICE_CENTS);

    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(p.deposit.forfeitTransferId!).then((t) => t?.reversed)).toBe(true);
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
  });

  // Fix round 2 (item 2): one deposit intent, TWO forfeit transfers. Capping
  // each reversal at the dispute amount independently would take that amount
  // back TWICE, more than the bank ever took off the platform.
  it("lost deposit with TWO forfeits under one intent: the reversals together never exceed the dispute", async () => {
    // Three dates on one run, two of them cancelled late one at a time (a
    // whole-run cancel forfeits only the NEXT date, so it can never produce
    // two forfeits). The third keeps its escrow and stays out of this.
    const { curator, musician, series, gigIds, bookingId } = await makeConfirmedRunBooking("dlrun", [10, 20, 200]);
    try {
      await ageConfirmedAt(bookingId);
      for (const gigId of gigIds.slice(0, 2)) {
        await callFn("cancelOccurrence", { bookingId, gigId, reason: "Room double-booked." }, curator.owner.user);
      }

      const byGig = new Map((await adb.collection(`bookings/${bookingId}/payments`).get()).docs
        .map((d) => [d.id, d.data() as PaymentDoc]));
      expect(byGig.size).toBe(3);
      const forfeited = gigIds.slice(0, 2).map((id) => byGig.get(id)!);
      expect(forfeited.every((p) => p.deposit.status === "forfeited" && p.deposit.forfeitTransferId !== null)).toBe(true);
      expect(byGig.get(gigIds[2])!.deposit.status).toBe("held");
      const intentId = forfeited[0].deposit.intentId!;
      expect(forfeited[1].deposit.intentId).toBe(intentId); // one charge behind both
      const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
      expect(await accountBalanceCents(accountId)).toBe(2 * SLICE_CENTS);

      // The bank took back MORE than one slice but LESS than both together.
      const disputeCents = SLICE_CENTS + 500;
      const chargeId = forfeited[0].deposit.chargeId;
      const disputeId = await openDispute({ intentId, chargeId, amountCents: disputeCents });
      expect((await closeDispute({ disputeId, intentId, chargeId, amountCents: disputeCents, status: "lost" })).status).toBe(200);

      // Exactly the disputed amount comes back in total, spread across the two
      // forfeits: the first is reversed whole, the second only for the rest.
      expect(await accountBalanceCents(accountId)).toBe(2 * SLICE_CENTS - disputeCents);
      const reversed = await Promise.all(forfeited.map(
        (p) => fakeObject(p.deposit.forfeitTransferId!).then((t) => (t?.reversedCents as number | undefined) ?? 0)));
      expect(reversed.reduce((a, b) => a + b, 0)).toBe(disputeCents);
      expect(reversed.filter((c) => c > 0)).toHaveLength(2);
      // Fix round 2 (item 3): the operator can read the cap off the row.
      const row = await ledgerRow(`dispute_lost:${disputeId}`);
      expect(row?.detail).toContain(`reversed ${disputeCents}c of the ${2 * SLICE_CENTS}c transfer`);
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  }, 60_000);

  // Branch audit (LOW): a PARTIAL chargeback. The reversal used to be
  // amount-less, i.e. "reverse the whole transfer", which claws back more from
  // the musician than the bank actually took off the platform.
  it("lost settlement for LESS than the transfer: only the disputed amount is reversed", async () => {
    const { musician, gigId, bookingId } = await makeConfirmedBooking("dlp1", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
    const transferred = paid.transfer.amountCents!;
    expect(await accountBalanceCents(accountId)).toBe(transferred);
    const partial = Math.floor(transferred / 3);
    expect(partial).toBeGreaterThan(0);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: partial });

    expect((await closeDispute({
      disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: partial, status: "lost",
    })).status).toBe(200);

    expect(await accountBalanceCents(accountId)).toBe(transferred - partial);
    const t = await fakeObject(paid.transfer.id!);
    expect(t?.reversedCents).toBe(partial);
    expect(t?.reversed).toBe(false); // still partly live, not a full reversal
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
    // Fix round 2 (item 3): what came back, against what had gone out, on the
    // one row an operator reads when the cap bites.
    expect((await ledgerRow(`dispute_lost:${disputeId}`))?.detail)
      .toContain(`reversed ${partial}c of the ${transferred}c transfer`);
  });

  it("lost deposit with NO transfer (still held): dispute_reversal_failed, nothing moves", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dl3");
    const p = await getPayment(bookingId, gigId);
    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "lost" })).status).toBe(200);
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("no transfer");
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
    expect((await ledgerRow(`dispute_lost:${disputeId}`))?.kind).toBe("dispute_lost");
  });

  it("lost settlement whose reversal Stripe refuses: dispute_reversal_failed", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dl4", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    // Reverse it first by hand (a dashboard reversal): the dispute's reversal then throws "already reversed".
    await adb.doc(`stripeFake/state/objects/${paid.transfer.id}`).update({ reversed: true });
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: 1000 });
    expect((await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 1000, status: "lost" })).status).toBe(200);
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("already been reversed");
  });

  it("lost ticket dispute AFTER settlement: a partial reversal of the ticket_settlement transfer for the order's face value", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("dl5", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl5a");
    await payOrder(eventId, tierId, 3, "dl5b");
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    expect(((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).status).toBe("completed");
    expect(await accountBalanceCents(accountId)).toBe(5000);

    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2000 + 2 * 169 });
    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2000 + 2 * 169, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(3000); // 5000 minus this order's 2000 face
    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.reversalTransferId).toBeTruthy();
  });

  it("lost ticket dispute BEFORE settlement: the pending settlement basis shrinks by the order's face value", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("dl6", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl6a");
    await payOrder(eventId, tierId, 3, "dl6b");
    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338 });
    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);
    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(2000);
    // SP10 Task 6 fix round 1 (Important 2): refundedCents must move in step,
    // so refundOrderForCancelledEvent's own "remaining" math (faceTotalCents
    // + serviceFeeCents - refundedCents) stays consistent with this reduction.
    expect(order.refundedCents).toBe(2000);
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.reversalTransferId).toBeUndefined();

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    expect(await accountBalanceCents(accountId)).toBe(3000); // only the undisputed order settles
  });

  // SP10 Task 6 fix round 1 (Important 2), updated for SP5c Task 7's
  // per-order settlement: settled is now `order.settledAt`, not the event's
  // own `settlementStartedAt`, and settleOneEvent's per-order loop stamps
  // `settledAt` BEFORE its best-effort `ticket_settlement` ledger write
  // lands (never inside the same transaction, an SP5 money invariant). This
  // simulates the race by pre-setting `settledAt` on the order directly
  // (as that loop would, mid-write) with no matching ledger row: the
  // reversal must never silently shrink refundedFaceCents once THIS ORDER
  // is marked settled, it must instead surface as a failed reversal.
  it("lost ticket dispute race: this order's settledAt lands before its ledger row, so the basis is never silently reduced", async () => {
    const { eventId, tierId } = await makePublishedEvent("dl7", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl7a");
    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338 });
    await adb.doc(`orders/${a.orderId}`).update({ settledAt: Date.now() });

    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);

    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(0); // never silently reduced
    expect(order.disputeStatus).toBe("lost");
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("no transfer");
  });

  // SP10 Task 9 fix round 1 (Critical 1): between claimSettlementStart's write
  // and settleOneEvent's post-transfer stamp, the event carries a FRESH
  // settlementClaimedAt and NO settlementStartedAt. The transfer may be in
  // flight, or may already have landed with only the stamp write outstanding,
  // so reducing the face basis here would drift the amount the static
  // `ticket_settlement:{eventId}` key is replayed with (real Stripe answers a
  // changed amount under a used key with idempotency_error). The reversal must
  // fail loudly instead, so an operator finishes it in Stripe.
  it("lost ticket dispute during a fresh settlement claim: the basis is not reduced and the reversal is flagged", async () => {
    const { eventId, tierId } = await makePublishedEvent("dl8", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl8a");
    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338 });
    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: Date.now() });

    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);

    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(0);
    expect(order.refundedCents).toBe(0);
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
    expect((await ledgerRow(`dispute_lost:${disputeId}`))?.kind).toBe("dispute_lost");
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("settlement in progress");
  });

  it("lost ticket dispute under a STALE settlement claim: the pre-settlement basis reduction still applies", async () => {
    const { eventId, tierId } = await makePublishedEvent("dl9", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl9a");
    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338 });
    // A claim this old belongs to a settlement that kept failing: the sweep
    // will re-claim it, and cancelEventCore already lets a cancel through.
    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: Date.now() - SETTLEMENT_CLAIM_STALE_MS - 1000 });

    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);

    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(2000);
    expect(order.refundedCents).toBe(2000);
    expect(await adminAlert(disputeReversalAlertId(disputeId))).toBeUndefined();
  });

  // SP5c Task 7 fix round 2: `event.settlementStartedAt != null` alone is
  // NOT a legacy signal once an event can carry more than one order, since
  // the per-order code stamps that field the moment the FIRST order of any
  // pass settles (Ruling A), long before every sibling order is done. This
  // fabricates exactly that shape (order A already settled under the NEW
  // per-order code, order B still pending, a STALE settlementClaimedAt so
  // there is no in-flight pass to defer to) and asserts a lost dispute on
  // the still-pending order B is treated as ordinary pre-settlement basis
  // reduction, the same outcome dl9 asserts, not the legacy no-op.
  it("lost ticket dispute on a still-pending sibling order of an event already partly settled under the new per-order code", async () => {
    const { profileId, eventId, tierId } = await makePublishedEvent("dl10", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl10a");
    const b = await payOrder(eventId, tierId, 2, "dl10b");

    const settledAt = Date.now();
    await adb.doc(`events/${eventId}`).update({
      settlementStartedAt: settledAt, settlementClaimedAt: settledAt - SETTLEMENT_CLAIM_STALE_MS - 1000,
    });
    await adb.doc(`orders/${a.orderId}`).update({ settledAt, settlementLegs: 1, settlementProfileCents: 2000 });
    // A new-style ticket_settlement row: it carries `orderId`, unlike the
    // legacy shape (no `orderId` key at all) settleOneEvent's own migration
    // guard, and this fix round's new check, both key on.
    await adb.collection("ledger").doc("ticket_settlement:tr_dl10_fake").set({
      kind: "ticket_settlement", amountCents: 2000, bookingId: null, gigId: null,
      profileId, stripeId: "tr_dl10_fake", detail: "per-order ticket settlement (test fixture)",
      eventId, orderId: a.orderId, buyerUid: null, at: settledAt,
    });

    const disputeId = await openDispute({ intentId: b.intentId, chargeId: b.chargeId, amountCents: 2338 });
    expect((await closeDispute({ disputeId, intentId: b.intentId, chargeId: b.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);

    const order = (await adb.doc(`orders/${b.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(2000);
    expect(order.refundedCents).toBe(2000);
    expect(await adminAlert(disputeReversalAlertId(disputeId))).toBeUndefined();
  });

  it("won: ledger dispute_won, record closed, curator gate lifted, order stamped won", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dw1");
    const p = await getPayment(bookingId, gigId);
    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "won" })).status).toBe(200);
    expect((await ledgerRow(`dispute_won:${disputeId}`))?.kind).toBe("dispute_won");
    expect((await disputeDoc(disputeId))?.status).toBe("won");
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(false);

    const { eventId, tierId } = await makePublishedEvent("dw2", 1000);
    const t = await payOrder(eventId, tierId, 1, "dw2a");
    const ticketDispute = await openDispute({ intentId: t.intentId, chargeId: t.chargeId, amountCents: 1169 });
    expect((await closeDispute({ disputeId: ticketDispute, intentId: t.intentId, chargeId: t.chargeId, amountCents: 1169, status: "won" })).status).toBe(200);
    expect(((await adb.doc(`orders/${t.orderId}`).get()).data() as TicketOrderDoc).disputeStatus).toBe("won");
  });

  // Branch audit (LOW): a redelivered `created` behind a decided dispute used
  // to run recordAdminAlert, whose "never silence a live condition" rule
  // clears resolvedAt and overwrites the detail. For a DECIDED dispute there
  // is no live condition left, so the resolved row must stay resolved.
  it("a late created behind a WON dispute leaves the resolved alert resolved", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dlate1", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const intentId = paid.settlement.intentId!;
    const chargeId = (await fakeObject(intentId))?.chargeId as string;
    const disputeId = await openDispute({ intentId, chargeId, amountCents: 1000 });
    expect((await closeDispute({ disputeId, intentId, chargeId, amountCents: 1000, status: "won" })).status).toBe(200);

    const alertId = disputeAlertId(disputeId);
    const resolved = await adminAlert(alertId);
    expect(typeof resolved?.resolvedAt).toBe("number");
    const resolvedAt = resolved!.resolvedAt;

    // The late redelivery.
    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId, chargeId, amountCents: 1000, status: "needs_response",
    })))).status).toBe(200);

    const after = await adminAlert(alertId);
    expect(after?.resolvedAt).toBe(resolvedAt);
    expect(after?.detail).toContain("WON");
    expect((await disputeDoc(disputeId))?.status).toBe("won");
  });

  it("closed for a dispute `created` never saw resolves the target itself", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dw3");
    const p = await getPayment(bookingId, gigId);
    const disputeId = newDisputeId();
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: 100, status: "won" })).status).toBe(200);
    expect((await disputeDoc(disputeId))).toMatchObject({ purpose: "deposit", bookingId, status: "won" });
  });
});

// SP10 Task 6 fix round 1 (Important 3): nothing else in this codebase stops
// refundedFaceCents from exceeding faceTotalCents on one order (a compounding
// dispute/grace-refund edge); paymentsSweep.ts's per-order settlement term
// must not let that go negative and drag down every OTHER order's payout in
// the same event.
describe("SP10 Task 6 fix round 1: paymentsSweep clamps a negative per-order settlement term", () => {
  it("an over-refunded order contributes 0, not a negative amount, to the event's settlement", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("cl1", 1000);
    const a = await payOrder(eventId, tierId, 2, "cl1a"); // 2000c face
    await payOrder(eventId, tierId, 3, "cl1b"); // 3000c face
    // Direct admin write, simulating the over-refunded state a compounding
    // dispute/grace-refund edge could otherwise reach: refundedFaceCents
    // (3000) exceeds this order's own faceTotalCents (2000).
    await adb.doc(`orders/${a.orderId}`).update({ refundedFaceCents: 3000 });

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    // Order a's term clamps to 0 (not -1000); only order b's 3000c settles.
    expect(await accountBalanceCents(accountId)).toBe(3000);
  });
});

describe("SP10 Task 6: charge.refunded", () => {
  // SP10 Task 6 fix round 1 (Critical 1): a real Charge webhook payload never
  // carries an expanded `refunds` list (and this client's pinned API version
  // no longer attaches it by default even on a direct fetch), so the payload
  // built here deliberately carries none; the handler must ask Stripe
  // (FakeStripe, in these tests) for the refund list directly.
  function chargeObject(p: { chargeId: string; intentId: string; amountRefundedCents: number }) {
    return { id: p.chargeId, object: "charge", payment_intent: p.intentId, amount_refunded: p.amountRefundedCents };
  }
  // Seeds a refund object FakeStripe itself knows about, the way a real
  // dashboard refund would exist in Stripe's own system regardless of whether
  // this codebase issued it; `listRefunds` reads exactly this back.
  async function fakeRefund(p: { chargeId: string; intentId: string; amountCents: number }): Promise<string> {
    const refundId = `re_dash_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await adb.doc(`stripeFake/state/objects/${refundId}`).set({
      kind: "refund", intentId: p.intentId, chargeId: p.chargeId, amountCents: p.amountCents,
    });
    return refundId;
  }

  it("payload carries no refunds field; the handler lists refunds from Stripe directly", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("xr1");
    const p = await getPayment(bookingId, gigId);
    const refundId = await fakeRefund({ chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, amountCents: DEPOSIT_CHARGE_CENTS });
    const payload = chargeObject({ chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, amountRefundedCents: DEPOSIT_CHARGE_CENTS });
    expect("refunds" in payload).toBe(false);
    expect((await postWebhook(fakeEvent("charge.refunded", payload))).status).toBe(200);
    const row = await ledgerRow(`external_refund:${refundId}`);
    expect(row?.kind).toBe("external_refund");
    expect(row?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(row?.bookingId).toBe(bookingId);
    const alert = await adminAlert(externalRefundAlertId(refundId));
    expect(alert?.kind).toBe("external_refund");
    expect(alert?.detail).toContain("still reads held");
  });

  it("our own refund (ledger row present) is not an external refund", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("xr2");
    await setGigStartsAt(gigId, 200);
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Plans changed." }, curator.owner.user);
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("refunded");
    const refundRow = (await adb.collection("ledger").where("bookingId", "==", bookingId).get()).docs
      .map((d) => d.data() as LedgerEntry).find((r) => r.kind === "refund")!;
    // cancelBooking's own refund call already created a real FakeStripe
    // refund object (stamped with chargeId at creation time); no seeding
    // needed, and the dedup must hold on the ledger row alone.
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, amountRefundedCents: refundRow.amountCents,
    })))).status).toBe(200);
    expect(await ledgerRow(`external_refund:${refundRow.stripeId}`)).toBeUndefined();
    expect(await adminAlert(externalRefundAlertId(refundRow.stripeId!))).toBeUndefined();
  });

  // SP10 Task 6 fix round 2 (Important 1): a curator grace refund's ledger
  // row (`ticket_grace_refund`) is keyed on the TICKET id, not the Stripe
  // refund id (ticketing.ts), so the `stripeId == refund.id` ledger-row check
  // alone would never match it. The refund object's own `metadata.purpose`
  // (ticketing.ts's refund() call sets it) must be checked FIRST.
  it("a curator grace refund is not misread as an external refund", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("xr5", 1000);
    const t = await payOrder(eventId, tierId, 1, "xr5a");
    const ticketSnap = await adb.collection(`users/${t.buyer.uid}/tickets`).where("orderId", "==", t.orderId).get();
    const ticketId = ticketSnap.docs[0].id;
    await callFn("refundTicket", { curatorProfileId: profileId, eventId, ticketId }, owner.user);
    const grace = (await adb.collection("ledger").where("stripeId", "==", ticketId).get()).docs
      .map((d) => d.data() as LedgerEntry).find((r) => r.kind === "ticket_grace_refund");
    expect(grace).toBeTruthy();

    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, amountRefundedCents: 1169,
    })))).status).toBe(200);
    const refundDocs = await adb.collection("stripeFake/state/objects")
      .where("kind", "==", "refund").where("chargeId", "==", t.chargeId).get();
    const refundId = refundDocs.docs[0].id;
    expect(await ledgerRow(`external_refund:${refundId}`)).toBeUndefined();
    expect(await adminAlert(externalRefundAlertId(refundId))).toBeUndefined();
  });

  it("a dashboard refund on a paid ticket order alerts; on an already refunded order it only records", async () => {
    const { eventId, tierId } = await makePublishedEvent("xr3", 1000);
    const t = await payOrder(eventId, tierId, 1, "xr3a");
    const refundId = await fakeRefund({ chargeId: t.chargeId, intentId: t.intentId, amountCents: 1169 });
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, amountRefundedCents: 1169,
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refundId}`))?.buyerUid).toBe(t.buyer.uid);
    expect((await adminAlert(externalRefundAlertId(refundId)))?.detail).toContain("still reads paid");

    await adb.doc(`orders/${t.orderId}`).update({ status: "cancelled_refunded" });
    const refund2 = await fakeRefund({ chargeId: t.chargeId, intentId: t.intentId, amountCents: 1169 });
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, amountRefundedCents: 1169 * 2,
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refund2}`))?.kind).toBe("external_refund");
    expect(await adminAlert(externalRefundAlertId(refund2))).toBeUndefined();
  });

  it("amount_refunded positive but Stripe's own refund list comes back empty: alerts on the charge id itself", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("xr4");
    const p = await getPayment(bookingId, gigId);
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, amountRefundedCents: DEPOSIT_CHARGE_CENTS,
    })))).status).toBe(200);
    const alert = await adminAlert(externalRefundAlertId(p.deposit.chargeId!));
    expect(alert?.kind).toBe("external_refund");
    expect(alert?.detail).toContain("came back");
  });
});

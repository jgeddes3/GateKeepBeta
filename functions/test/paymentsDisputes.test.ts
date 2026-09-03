import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt, ageConfirmedAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  computeDepositCents, computeExpectedTotalCents, computeFeeShareCents, DEFAULT_FEE_POLICY,
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

async function createOpenGig(profileId: string, user: import("firebase/auth").User): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>("createGig", { profileId, ...gigContent() }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

async function makeConfirmedBooking(prefix: string, opts: { pastStartHours?: number } = {}) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user);
  if (opts.pastStartHours != null) await setGigStartsAt(gigId, -opts.pastStartHours);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: { amountCents: RATE_CENTS, note: "Hi" } }, musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
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
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: 5000 });

    const res = await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 5000, status: "lost" });
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
    expect(row?.amountCents).toBe(5000);
    expect(row?.detail).toContain(rec!.reversalTransferId!);
    expect(await adb.doc(`stripeFake/state/idem/${encodeURIComponent(`dispute_reverse:${disputeId}`)}`).get().then((s) => s.exists)).toBe(true);
    // Redelivery: nothing moves twice.
    expect((await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 5000, status: "lost" })).status).toBe(200);
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
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.reversalTransferId).toBeUndefined();

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    expect(await accountBalanceCents(accountId)).toBe(3000); // only the undisputed order settles
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

  it("closed for a dispute `created` never saw resolves the target itself", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dw3");
    const p = await getPayment(bookingId, gigId);
    const disputeId = newDisputeId();
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: 100, status: "won" })).status).toBe(200);
    expect((await disputeDoc(disputeId))).toMatchObject({ purpose: "deposit", bookingId, status: "won" });
  });
});

describe("SP10 Task 6: charge.refunded", () => {
  function chargeObject(p: { chargeId: string; intentId: string; refunds: Array<{ id: string; amount: number; metadata?: Record<string, string> }> }) {
    return {
      id: p.chargeId, object: "charge", payment_intent: p.intentId,
      amount_refunded: p.refunds.reduce((s, r) => s + r.amount, 0),
      refunds: { object: "list", data: p.refunds.map((r) => ({ id: r.id, object: "refund", amount: r.amount, metadata: r.metadata ?? {} })) },
    };
  }

  it("a dashboard refund on a held deposit: external_refund ledger row and alert", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("xr1");
    const p = await getPayment(bookingId, gigId);
    const refundId = `re_dash_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, refunds: [{ id: refundId, amount: DEPOSIT_CHARGE_CENTS }],
    })))).status).toBe(200);
    const row = await ledgerRow(`external_refund:${refundId}`);
    expect(row?.kind).toBe("external_refund");
    expect(row?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(row?.bookingId).toBe(bookingId);
    const alert = await adminAlert(externalRefundAlertId(refundId));
    expect(alert?.kind).toBe("external_refund");
    expect(alert?.detail).toContain("still reads held");
  });

  it("our own refund (metadata.purpose set, ledger row present) is not an external refund", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("xr2");
    await setGigStartsAt(gigId, 200);
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Plans changed." }, curator.owner.user);
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("refunded");
    const refundRow = (await adb.collection("ledger").where("bookingId", "==", bookingId).get()).docs
      .map((d) => d.data() as LedgerEntry).find((r) => r.kind === "refund")!;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!,
      refunds: [{ id: refundRow.stripeId!, amount: refundRow.amountCents, metadata: { bookingId, gigId, purpose: "deposit_refund" } }],
    })))).status).toBe(200);
    expect(await ledgerRow(`external_refund:${refundRow.stripeId}`)).toBeUndefined();
    expect(await adminAlert(externalRefundAlertId(refundRow.stripeId!))).toBeUndefined();
  });

  it("a dashboard refund on a paid ticket order alerts; on an already refunded order it only records", async () => {
    const { eventId, tierId } = await makePublishedEvent("xr3", 1000);
    const t = await payOrder(eventId, tierId, 1, "xr3a");
    const refundId = `re_dash_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, refunds: [{ id: refundId, amount: 1169 }],
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refundId}`))?.buyerUid).toBe(t.buyer.uid);
    expect((await adminAlert(externalRefundAlertId(refundId)))?.detail).toContain("still reads paid");

    await adb.doc(`orders/${t.orderId}`).update({ status: "cancelled_refunded" });
    const refund2 = `re_dash2_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, refunds: [{ id: refund2, amount: 1169 }],
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refund2}`))?.kind).toBe("external_refund");
    expect(await adminAlert(externalRefundAlertId(refund2))).toBeUndefined();
  });
});

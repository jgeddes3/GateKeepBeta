import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  computeDepositCents, computeEarningsCents, computeExpectedTotalCents, computeFeeShareCents,
  computeLateFeeSplit, DEFAULT_FEE_POLICY, SETTLEMENT_DELAY_MS, SETTLEMENT_RETRY_OFFSETS_MS,
  type AdminAlertDoc, type BookingRequestDoc, type GigDoc, type LedgerEntry, type NotificationDoc,
  type PaymentDoc, type ProfileDraftInput, type StripeProfileDoc,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { CURATOR_DELINQUENT_MESSAGE, IDEMPOTENCY_WINDOW_MS } from "../src/paymentsCore.js";
import { PAYDUE_CONFIRM_WINDOW_MS } from "../src/paymentsSettlement.js";
import {
  PAY_PAST_DUE_NOT_OVERDUE_MESSAGE, PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE,
} from "../src/payments.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// 120s, double the settlement suite's: every case here walks the dunning
// ladder, which is FOUR sweep runs on top of the usual two-profile +
// gig + accept setup chain — and the second case builds two bookings.
vi.setConfig({ testTimeout: 120_000 });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Expected money, DERIVED (never transcribed) — same rule as the settlement
// suite: every figure comes out of the shared helpers the server itself uses,
// so a change to a fee constant or a rounding law moves the assertion and the
// implementation together.
// ---------------------------------------------------------------------------
const FEE = DEFAULT_FEE_POLICY;

const RATE_CENTS = 15_000;
const DURATION_MINUTES = 90;
const BASE_CENTS = computeExpectedTotalCents("perHour", RATE_CENTS, { durationMinutes: DURATION_MINUTES });
const SLICE_CENTS = computeDepositCents(BASE_CENTS);
// The DEPOSIT debt — what an exhausted birth deposit still owes.
const DEPOSIT_FEE_CENTS = computeFeeShareCents(SLICE_CENTS, FEE.curatorFeePct);
const DEPOSIT_CHARGE_CENTS = SLICE_CENTS + DEPOSIT_FEE_CENTS;
// The attempts counter a birth deposit carries once its retry schedule has run
// out — the same terminator the sweep's step 3 and clearDelinquencyIfSettled
// both use, derived rather than transcribed.
const EXHAUSTED_DEPOSIT_ATTEMPTS = SETTLEMENT_RETRY_OFFSETS_MS.length + 1;

// What a date settles for when its deposit was NEVER paid: no slice credit, so
// the settlement charges the FULL base plus commission on all of it.
const ABSORBED_DUE_CENTS = BASE_CENTS;
const ABSORBED_FEE_CENTS = computeFeeShareCents(ABSORBED_DUE_CENTS, FEE.curatorFeePct);
const ABSORBED_CHARGE_CENTS = ABSORBED_DUE_CENTS + ABSORBED_FEE_CENTS;

// The no-true-up settlement of that fixture: what the ladder keeps failing to
// charge, and therefore what the late fee is a percentage OF.
const DUE_CENTS = BASE_CENTS - SLICE_CENTS;
const FEE_SHARE_CENTS = computeFeeShareCents(DUE_CENTS, FEE.curatorFeePct);
const OUTSTANDING_CENTS = DUE_CENTS + FEE_SHARE_CENTS;
const LATE = computeLateFeeSplit(OUTSTANDING_CENTS, FEE.lateFeePct, FEE.lateFeeMusicianPct);
// What payPastDue must charge once delinquent: the debt PLUS the late fee.
const RECOVERY_CHARGE_CENTS = OUTSTANDING_CENTS + LATE.lateFeeCents;
// ...and what the musician receives for the date: their 98% of the full base
// PLUS their 7-of-10 points of the late fee.
const EARNINGS_CENTS = computeEarningsCents(BASE_CENTS, FEE.musicianFeePct);
const RECOVERY_EARNINGS_CENTS = EARNINGS_CENTS + LATE.musicianCents;

// ---------- fixtures (mirroring paymentsSettlement.test.ts's) ----------

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
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: DURATION_MINUTES,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * DAY_MS,
    ...overrides,
  };
}

async function createOpenGig(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId, ...gigContent(overrides) }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

function offerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { amountCents: RATE_CENTS, note: "Looking forward to it!", ...overrides };
}

type Profile = { owner: { user: import("firebase/auth").User; uid: string }; profileId: string };

// One confirmed booking on a date that has already ENDED, between profiles the
// caller already has. Split out of makeEndedBooking so a case can put TWO
// bookings on ONE curator — which is what "the flag stays until EVERY debt is
// settled" needs.
async function makeEndedBookingFor(
  curator: Profile, musician: Profile,
  opts: { gig?: Record<string, unknown>; offer?: Record<string, unknown> } = {},
): Promise<{ gigId: string; bookingId: string }> {
  const gigId = await createOpenGig(curator.profileId, curator.owner.user, opts.gig ?? {});
  // BEFORE the accept: a payment doc's `occurrenceStartsAt` is stamped at
  // accept time and never follows a later gig edit.
  await setGigStartsAt(gigId, -5);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId, musicianProfileId: musician.profileId, offer: opts.offer ?? offerPayload() },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { gigId, bookingId };
}

async function makeEndedBooking(prefix: string) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const { gigId, bookingId } = await makeEndedBookingFor(curator, musician);
  return { curator, musician, gigId, bookingId };
}

// A confirmed booking whose date is still a WEEK OUT — the shape a birth
// deposit belongs to (deposits are owed before the night, settlements after).
async function makeFutureBooking(prefix: string) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

// SEEDED, not walked. Producing a genuinely exhausted birth deposit through the
// app needs a whole-run series, the materializer, and four declining sweep runs
// against a FUTURE date — minutes of fixture for a state that is four field
// values. These cases are about what happens AFTER exhaustion (payPastDue and
// the delinquency lift), so the state is written directly and the shape is
// taken from the sweep's own dunning writer: `unpaid`, no intent, the attempts
// counter past the end of the retry schedule, and no retry clock (exhaustion
// nulls it, which is why the counter — not the clock — is the terminator).
async function seedExhaustedBirthDeposit(bookingId: string, gigId: string): Promise<void> {
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).update({
    "deposit.status": "unpaid", "deposit.intentId": null, "deposit.chargeId": null,
    "deposit.chargedAt": null, "deposit.depositAttempts": EXHAUSTED_DEPOSIT_ATTEMPTS,
    "deposit.depositNextRetryAt": null, updatedAt: Date.now(),
  });
}

// ...and the flag that exhaustion would have raised (declareCuratorDelinquent's
// exact write shape).
async function seedDelinquent(profileId: string): Promise<void> {
  const now = Date.now();
  await adb.doc(`profiles/${profileId}/private/stripe`).set(
    { delinquent: true, delinquentSince: now, updatedAt: now }, { merge: true });
}

async function getBooking(bookingId: string): Promise<BookingRequestDoc> {
  return (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
}

async function getPayment(bookingId: string, gigId: string): Promise<PaymentDoc | undefined> {
  return (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc | undefined;
}

async function getGig(gigId: string): Promise<GigDoc> {
  return (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
}

async function getStripeDoc(profileId: string): Promise<StripeProfileDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;
}

async function curatorCustomerId(profileId: string): Promise<string> {
  const sp = await getStripeDoc(profileId);
  if (!sp?.customerId) throw new Error(`no customerId cached for curator profile ${profileId}`);
  return sp.customerId;
}

async function musicianAccountId(profileId: string): Promise<string> {
  const sp = await getStripeDoc(profileId);
  if (!sp?.accountId) throw new Error(`no accountId cached for musician profile ${profileId}`);
  return sp.accountId;
}

// Scoped charge knobs (as-built contract #6): ALWAYS this test's OWN
// customerId, never the global declineCharges flag — stripeFake/config is
// shared with every other suite running against this emulator.
async function setChargeKnob(
  knob: "declineCustomerIds" | "pendingCustomerIds", customerId: string, on: boolean,
): Promise<void> {
  await adb.doc("stripeFake/config").set(
    { [knob]: on ? FieldValue.arrayUnion(customerId) : FieldValue.arrayRemove(customerId) },
    { merge: true });
}

async function fakeObject(id: string): Promise<Record<string, unknown> | undefined> {
  return (await adb.doc(`stripeFake/state/objects/${id}`).get()).data();
}

async function accountBalanceCents(accountId: string): Promise<number> {
  return ((await fakeObject(accountId))?.balanceCents as number | undefined) ?? 0;
}

async function idemUsed(key: string): Promise<boolean> {
  return (await adb.doc(`stripeFake/state/idem/${encodeURIComponent(key)}`).get()).exists;
}

// The durable escalation queue — a refusal that isn't recorded here is a
// refusal nobody will ever action.
async function adminAlert(alertId: string): Promise<AdminAlertDoc | undefined> {
  return (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc | undefined;
}

async function ledgerRows(bookingId: string): Promise<LedgerEntry[]> {
  const snap = await adb.collection("ledger").where("bookingId", "==", bookingId).get();
  return snap.docs.map((d) => d.data() as LedgerEntry);
}

async function notificationsFor(uid: string): Promise<NotificationDoc[]> {
  const snap = await adb.collection(`users/${uid}/notifications`).get();
  return snap.docs.map((d) => d.data() as NotificationDoc);
}

// Step 4 opens the settlement window; this is the T+3 wait, compressed. The
// due CLOCK is pulled back rather than the sweep's `now` pushed forward — `now`
// also drives the staleness guards and every other step's window.
async function makeSettlementDue(bookingId: string, gigId: string): Promise<void> {
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`)
    .update({ "settlement.settleAfter": Date.now() - 1000 });
}

// The dunning-retry equivalent: make the NEXT rung due now.
async function makeRetryDue(bookingId: string, gigId: string): Promise<void> {
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`)
    .update({ "settlement.nextRetryAt": Date.now() - 1000 });
}

// Parks a doc's retry far enough out that the sweep never selects it — how a
// case keeps ONE booking at rung 1 while it walks ANOTHER down the ladder.
async function parkRetry(bookingId: string, gigId: string): Promise<void> {
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`)
    .update({ "settlement.nextRetryAt": Date.now() + 30 * DAY_MS });
}

async function scheduleSettlement(bookingId: string, gigId: string): Promise<void> {
  const gig = await getGig(gigId);
  const gigEnd = gig.startsAt + gig.durationMinutes * 60_000;
  if ((await getPayment(bookingId, gigId))?.settlement.status === "not_due") {
    await runPaymentsSweep(Date.now());
  }
  const scheduled = await getPayment(bookingId, gigId);
  expect(scheduled?.settlement.status).toBe("pending");
  expect(scheduled?.settlement.settleAfter).toBe(gigEnd + SETTLEMENT_DELAY_MS);
  expect(scheduled?.settlement.attempts).toBe(0);
  expect(scheduled?.deposit.status).toBe("held");
}

// ---------------------------------------------------------------------------

describe("dunning — the ladder to delinquency", () => {
  it("retries at +1d/+2d/+2d and then declares delinquency with the exact 7/3 late fee, gating the curator", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("dunlad");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    try {
      await setChargeKnob("declineCustomerIds", customerId, true);

      // ---- rung 1: the T+3 charge is declined ----
      const t1 = Date.now();
      const run1 = await runPaymentsSweep(t1);
      expect(run1.settlementsDeclined).toBeGreaterThanOrEqual(1);

      const rung1 = await getPayment(bookingId, gigId);
      expect(rung1?.settlement.status).toBe("past_due");
      expect(rung1?.settlement.attempts).toBe(1);
      expect(rung1?.settlement.nextRetryAt).toBe(t1 + SETTLEMENT_RETRY_OFFSETS_MS[0]);
      // Nothing moved, and no late fee yet — the ladder is not delinquency.
      expect(rung1?.settlement.lateFeeCents).toBeNull();
      expect(rung1?.settlement.delinquentAt).toBeNull();
      expect(rung1?.deposit.status).toBe("held");
      expect(rung1?.transfer.status).toBe("none");
      expect(await accountBalanceCents(accountId)).toBe(0);
      // past_due, but NOT delinquent: the aggregate distinguishes the two.
      expect((await getBooking(bookingId)).paymentSummary?.state).toBe("past_due");
      expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(false);
      expect((await notificationsFor(curator.owner.uid)).some((n) => n.title === "Payment failed")).toBe(true);

      // BEFORE the retry is due, step 6 must not attempt anything — the next
      // attempt's key is the honest witness for "no charge was even tried".
      await runPaymentsSweep(Date.now());
      expect((await getPayment(bookingId, gigId))?.settlement.attempts).toBe(1);
      expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(false);

      // ---- rung 2: +2d ----
      await makeRetryDue(bookingId, gigId);
      const t2 = Date.now();
      const run2 = await runPaymentsSweep(t2);
      expect(run2.retriesAttempted).toBeGreaterThanOrEqual(1);
      const rung2 = await getPayment(bookingId, gigId);
      expect(rung2?.settlement.attempts).toBe(2);
      expect(rung2?.settlement.nextRetryAt).toBe(t2 + SETTLEMENT_RETRY_OFFSETS_MS[1]);
      // Each retry carries a FRESH key: both real Stripe and the fake cache a
      // decline under the key that produced it.
      expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(true);

      // ---- rung 3: +2d ----
      await makeRetryDue(bookingId, gigId);
      const t3 = Date.now();
      await runPaymentsSweep(t3);
      const rung3 = await getPayment(bookingId, gigId);
      expect(rung3?.settlement.attempts).toBe(3);
      expect(rung3?.settlement.nextRetryAt).toBe(t3 + SETTLEMENT_RETRY_OFFSETS_MS[2]);
      expect(rung3?.settlement.delinquentAt).toBeNull();

      // ---- the 4th failure: delinquency ----
      await makeRetryDue(bookingId, gigId);
      const t4 = Date.now();
      const run4 = await runPaymentsSweep(t4);
      expect(run4.delinquenciesDeclared).toBeGreaterThanOrEqual(1);

      const due = await getPayment(bookingId, gigId);
      expect(due?.settlement.status).toBe("past_due");
      expect(due?.settlement.attempts).toBe(4);
      // The automatic ladder is over — payPastDue is the only exit.
      expect(due?.settlement.nextRetryAt).toBeNull();
      expect(due?.settlement.delinquentAt).toBeGreaterThanOrEqual(t4);

      // THE SPLIT, re-derived from the constants rather than transcribed.
      expect(due?.settlement.lateFeeCents).toBe(LATE.lateFeeCents);
      expect(due?.settlement.lateFeeMusicianCents).toBe(LATE.musicianCents);
      // ...and stated a second way, independently of computeLateFeeSplit: 10%
      // of the outstanding debt, of which 7 of the 10 points are the
      // musician's and the remaining 3 the platform's.
      expect(due?.settlement.lateFeeCents).toBe(Math.ceil(OUTSTANDING_CENTS * FEE.lateFeePct / 100));
      expect(due?.settlement.lateFeeMusicianCents)
        .toBe(Math.floor(LATE.lateFeeCents * FEE.lateFeeMusicianPct / FEE.lateFeePct));
      expect(LATE.platformCents).toBe(LATE.lateFeeCents - LATE.musicianCents);
      // The fee is NOT charged now — it rides the next successful charge.
      expect(due?.deposit.status).toBe("held");
      expect(due?.transfer.status).toBe("none");
      expect(await accountBalanceCents(accountId)).toBe(0);

      // The profile-level flag, and the aggregate's own delinquency state.
      const sp = await getStripeDoc(curator.profileId);
      expect(sp?.delinquent).toBe(true);
      expect(sp?.delinquentSince).toBeGreaterThanOrEqual(t4);
      expect((await getBooking(bookingId)).paymentSummary?.state).toBe("delinquent");

      // The audit row, on its deterministic pseudo-stripeId (a late fee has no
      // Stripe object, and the declaring path can re-enter).
      const lateRow = (await ledgerRows(bookingId)).find((r) => r.kind === "late_fee");
      expect(lateRow?.amountCents).toBe(LATE.lateFeeCents);
      expect(lateRow?.profileId).toBe(curator.profileId);
      expect(lateRow?.stripeId).toBe(`latefee:${bookingId}:${gigId}`);

      // BOTH sides are told, and told different things.
      expect((await notificationsFor(curator.owner.uid)).some((n) => n.title === "Payment overdue")).toBe(true);
      expect((await notificationsFor(musician.owner.uid)).some((n) => n.title === "Payment delayed")).toBe(true);

      // No more automatic attempts, ever: with `nextRetryAt` null the sweep
      // does not even select this doc.
      await runPaymentsSweep(Date.now());
      const after = await getPayment(bookingId, gigId);
      expect(after?.settlement.attempts).toBe(4);
      expect(after?.settlement.lateFeeCents).toBe(LATE.lateFeeCents);   // never compounded
      expect(await idemUsed(`${bookingId}:${gigId}:settle:4`)).toBe(false);
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }

    // THE GATE IS LIVE: a delinquent curator cannot book anyone new, and the
    // message is the specific one (the curator side is who can act on it).
    const freshGig = await createOpenGig(curator.profileId, curator.owner.user);
    await expect(callFn("offerGig",
      { gigId: freshGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: CURATOR_DELINQUENT_MESSAGE });
  });
});

describe("payPastDue — the way out", () => {
  it("charges the debt WITH the late fee, pays the musician their share, and lifts the flag only once EVERY debt is settled", async () => {
    // ONE curator, TWO bookings: the delinquency comes from booking A, and
    // booking B is left merely past_due so that paying A off must NOT lift the
    // flag on its own.
    const curator = await makeApprovedCuratorProfile("dunpayc");
    const musician = await makeApprovedMusicianProfile("dunpaym");
    await makeMoneyReady(curator, musician);
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);
    const a = await makeEndedBookingFor(curator, musician);
    const b = await makeEndedBookingFor(curator, musician);

    await scheduleSettlement(a.bookingId, a.gigId);
    await scheduleSettlement(b.bookingId, b.gigId);
    await makeSettlementDue(a.bookingId, a.gigId);
    await makeSettlementDue(b.bookingId, b.gigId);

    try {
      await setChargeKnob("declineCustomerIds", customerId, true);
      // One declining run takes BOTH docs to rung 1 (step 5 is a
      // collection-group query, not a per-doc call).
      await runPaymentsSweep(Date.now());
      expect((await getPayment(a.bookingId, a.gigId))?.settlement.attempts).toBe(1);
      expect((await getPayment(b.bookingId, b.gigId))?.settlement.attempts).toBe(1);
      // B is parked at rung 1 while A walks the rest of the ladder.
      await parkRetry(b.bookingId, b.gigId);
      for (let rung = 2; rung <= 4; rung++) {
        await makeRetryDue(a.bookingId, a.gigId);
        await runPaymentsSweep(Date.now());
      }
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }

    const delinquent = await getPayment(a.bookingId, a.gigId);
    expect(delinquent?.settlement.attempts).toBe(4);
    expect(delinquent?.settlement.lateFeeCents).toBe(LATE.lateFeeCents);
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    expect((await getPayment(b.bookingId, b.gigId))?.settlement.status).toBe("past_due");

    // ---- payPastDue on A ----
    // The card is good again (the knob is off); the amount is SERVER-computed
    // and includes the late fee, which the caller never sends.
    const paid = await callFn<{ bookingId: string; gigId: string }, { done: boolean; amountCents: number }>(
      "payPastDue", { bookingId: a.bookingId, gigId: a.gigId }, curator.owner.user);
    expect(paid.done).toBe(true);
    expect(paid.amountCents).toBe(RECOVERY_CHARGE_CENTS);

    const settled = await getPayment(a.bookingId, a.gigId);
    expect(settled?.settlement.status).toBe("paid");
    expect(settled?.settlement.computedCents).toBe(DUE_CENTS);
    expect(settled?.settlement.feeShareCents).toBe(FEE_SHARE_CENTS);
    expect(settled?.settlement.nextRetryAt).toBeNull();
    // The intent is the on-session one this callable minted, mirrored into the
    // field that lets a later call prove it is ours to replace.
    const payDueIntentId = settled!.settlement.intentId!;
    expect(payDueIntentId).toBeTruthy();
    expect(settled?.settlement.payDueIntentId).toBe(payDueIntentId);
    expect(await idemUsed(`${a.bookingId}:${a.gigId}:paydue:4`)).toBe(true);
    // THE LATE FEE WAS ACTUALLY CHARGED — the debt plus 10% of it.
    expect(await fakeObject(payDueIntentId).then((i) => i?.amountCents)).toBe(RECOVERY_CHARGE_CENTS);
    // ...and the musician's 7-of-10 points rode out on the transfer, on the
    // attempt-scoped earnings key for the attempt that finally settled.
    expect(settled?.deposit.status).toBe("applied");
    expect(settled?.transfer.status).toBe("transferred");
    expect(settled?.transfer.amountCents).toBe(RECOVERY_EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(RECOVERY_EARNINGS_CENTS);
    expect(await idemUsed(`${a.bookingId}:${a.gigId}:earn:4`)).toBe(true);

    const rows = await ledgerRows(a.bookingId);
    expect(rows.find((r) => r.kind === "settlement_charged")?.amountCents).toBe(RECOVERY_CHARGE_CENTS);
    expect(rows.find((r) => r.kind === "settlement_charged")?.stripeId).toBe(payDueIntentId);
    expect(rows.find((r) => r.kind === "earnings_transfer")?.amountCents).toBe(RECOVERY_EARNINGS_CENTS);
    expect((await getBooking(a.bookingId)).paymentSummary?.state).toBe("current");
    expect((await notificationsFor(musician.owner.uid)).some((n) => n.title === "You've been paid")).toBe(true);

    // ---- the flag does NOT lift while booking B is still past_due ----
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    const stillGated = await createOpenGig(curator.profileId, curator.owner.user);
    await expect(callFn("offerGig",
      { gigId: stillGated, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: CURATOR_DELINQUENT_MESSAGE });

    // ---- paying B (still on rung 1, no late fee) clears the last debt ----
    const paidB = await callFn<{ bookingId: string; gigId: string }, { done: boolean; amountCents: number }>(
      "payPastDue", { bookingId: b.bookingId, gigId: b.gigId }, curator.owner.user);
    expect(paidB.done).toBe(true);
    // No late fee on this one — it never reached delinquency.
    expect(paidB.amountCents).toBe(OUTSTANDING_CENTS);
    const settledB = await getPayment(b.bookingId, b.gigId);
    expect(settledB?.settlement.status).toBe("paid");
    expect(settledB?.settlement.lateFeeCents).toBeNull();
    expect(settledB?.transfer.amountCents).toBe(EARNINGS_CENTS);

    // NOW the profile is clean, and the gates open again.
    const cleared = await getStripeDoc(curator.profileId);
    expect(cleared?.delinquent).toBe(false);
    expect(cleared?.delinquentSince).toBeNull();
    const openGig = await createOpenGig(curator.profileId, curator.owner.user);
    await callFn("offerGig",
      { gigId: openGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user);
  });

  it("refuses the musician side, a date that isn't past_due, someone else's intent, and a charge in flight", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("dunref");
    const customerId = await curatorCustomerId(curator.profileId);
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${gigId}`);

    await scheduleSettlement(bookingId, gigId);
    // Still `pending`: there is no overdue debt to pay yet.
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: PAY_PAST_DUE_NOT_OVERDUE_MESSAGE });

    await makeSettlementDue(bookingId, gigId);
    try {
      await setChargeKnob("declineCustomerIds", customerId, true);
      await runPaymentsSweep(Date.now());
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("past_due");

    // The musician side never pays the curator's bill — and never learns the
    // amount by asking.
    await expect(callFn("payPastDue", { bookingId, gigId }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    // THE DOUBLE-CHARGE REFUSAL: an intent that is NOT payPastDue's own is
    // already outstanding on this occurrence (an off-session settlement charge
    // left processing is the real route; seeded here, since that state only
    // exists inside one awaited chargeSettlement call). Minting a second,
    // confirmable intent beside it would let the curator pay the night twice.
    await paymentRef.update({ "settlement.intentId": "pi_someone_elses" });
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE,
      });
    // Refused BEFORE any Stripe call: no paydue key was consumed.
    expect(await idemUsed(`${bookingId}:${gigId}:paydue:1`)).toBe(false);
    await paymentRef.update({ "settlement.intentId": null });

    // A CHARGE IN FLIGHT RIGHT NOW: a sweep run has claimed this doc and is
    // inside its chargeOffSession call. An on-session intent minted beside it
    // would be a second charge for the same debt.
    await paymentRef.update({ "settlement.chargingSince": Date.now() });
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE,
      });
    expect(await idemUsed(`${bookingId}:${gigId}:paydue:1`)).toBe(false);

    // ...but that refusal is WINDOW-BOUNDED, and the bound is load-bearing. A
    // claim older than Stripe's idempotency window is chargeSettlement's
    // PERMANENT refusal; if it were permanent here too, the curator would be
    // gated by a debt nothing will ever collect and which they cannot pay.
    await paymentRef.update({ "settlement.chargingSince": Date.now() - IDEMPOTENCY_WINDOW_MS - 1000 });
    const rescued = await callFn<{ bookingId: string; gigId: string }, { done: boolean }>(
      "payPastDue", { bookingId, gigId }, curator.owner.user);
    expect(rescued.done).toBe(true);
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("paid");
  });

  it("parks the retry clock instead of nulling it, escalates an abandoned attempt, and replays the SAME intent on a retry", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("dunaband");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);
    const musicianStripeRef = adb.doc(`profiles/${musician.profileId}/private/stripe`);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);
    try {
      await setChargeKnob("declineCustomerIds", customerId, true);
      await runPaymentsSweep(Date.now());
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }
    expect((await getPayment(bookingId, gigId))?.settlement.attempts).toBe(1);

    // To OBSERVE the parked clock the settlement must not immediately finalize
    // (the terminal write nulls `nextRetryAt` like any other). Removing the
    // musician's payout account makes finalizeSettlementSuccess stop before the
    // transfer — which is also the real shape of an attempt that gets stuck.
    await musicianStripeRef.set({ accountId: null }, { merge: true });
    const t0 = Date.now();
    const parkedResult = await callFn<{ bookingId: string; gigId: string }, { done: boolean }>(
      "payPastDue", { bookingId, gigId }, curator.owner.user);
    expect(parkedResult.done).toBe(false);

    const parked = await getPayment(bookingId, gigId);
    expect(parked?.settlement.status).toBe("past_due");
    // THE POINT: parked, NOT null. A null clock would drop this debt out of the
    // sweep's step-6 query forever, silently ending dunning for it.
    expect(parked?.settlement.nextRetryAt).not.toBeNull();
    expect(parked?.settlement.nextRetryAt).toBeGreaterThanOrEqual(t0 + PAYDUE_CONFIRM_WINDOW_MS);
    expect(parked?.settlement.nextRetryAt).toBeLessThan(Date.now() + PAYDUE_CONFIRM_WINDOW_MS + 1000);
    const firstIntentId = parked!.settlement.intentId!;
    expect(firstIntentId).toBeTruthy();
    expect(parked?.settlement.payDueIntentId).toBe(firstIntentId);

    // The curator walks away. An hour later the sweep re-selects the doc and
    // must ESCALATE the abandoned intent — never charge past it, because a tab
    // left open could still confirm it.
    await makeRetryDue(bookingId, gigId);
    const abandonedRun = await runPaymentsSweep(Date.now());
    expect(abandonedRun.settlementsPending).toBeGreaterThanOrEqual(1);
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("past_due");
    expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(false);
    expect(await accountBalanceCents(accountId)).toBe(0);
    const alert = await adminAlert(`settlement-pending:${bookingId}:${gigId}`);
    expect(alert?.kind).toBe("settlement_pending_stuck");
    expect(alert?.detail).toContain("abandoned pay-now attempt");
    expect(alert?.resolvedAt).toBeNull();

    // The curator comes back. The key is deterministic per attempt, so Stripe
    // REPLAYS the same intent rather than minting a rival one beside it — the
    // property that makes overwriting `settlement.intentId` safe at all.
    await musicianStripeRef.set({ accountId }, { merge: true });
    const resumed = await callFn<{ bookingId: string; gigId: string }, { done: boolean; amountCents: number }>(
      "payPastDue", { bookingId, gigId }, curator.owner.user);
    expect(resumed.done).toBe(true);
    expect(resumed.amountCents).toBe(OUTSTANDING_CENTS);   // rung 1: no late fee yet

    const settled = await getPayment(bookingId, gigId);
    expect(settled?.settlement.status).toBe("paid");
    expect(settled?.settlement.intentId).toBe(firstIntentId);   // the SAME intent
    expect(settled?.settlement.nextRetryAt).toBeNull();
    expect(await accountBalanceCents(accountId)).toBe(EARNINGS_CENTS);
  });
});

// ---------------------------------------------------------------------------
// A curator whose ONLY debt is a birth deposit that ran out its retry schedule
// is delinquent exactly like one who failed a settlement — but leaves no
// `past_due` settlement behind. Without a way to pay it, and without a lift
// that asks about it, that curator could never book again.
// ---------------------------------------------------------------------------

describe("payPastDue — an exhausted birth deposit", () => {
  it("charges the frozen slice + fee on-session, holds the escrow, and lifts the gate", async () => {
    const { curator, musician, gigId, bookingId } = await makeFutureBooking("dundep");
    await seedExhaustedBirthDeposit(bookingId, gigId);
    await seedDelinquent(curator.profileId);

    // The gate is live, and nothing about the SETTLEMENT is overdue — this
    // curator's only debt is the deposit.
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("not_due");
    const gatedGig = await createOpenGig(curator.profileId, curator.owner.user);
    await expect(callFn("offerGig",
      { gigId: gatedGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: CURATOR_DELINQUENT_MESSAGE });

    const paid = await callFn<{ bookingId: string; gigId: string }, { done: boolean; amountCents: number }>(
      "payPastDue", { bookingId, gigId }, curator.owner.user);
    expect(paid.done).toBe(true);
    // Slice + fee share, both frozen at staging — never re-derived from a live
    // constant.
    expect(paid.amountCents).toBe(DEPOSIT_CHARGE_CENTS);

    const held = await getPayment(bookingId, gigId);
    expect(held?.deposit.status).toBe("held");
    expect(typeof held?.deposit.chargedAt).toBe("number");
    expect(held?.deposit.depositNextRetryAt).toBeNull();
    const intentId = held!.deposit.intentId!;
    expect(intentId).toBeTruthy();
    expect(held?.deposit.payDueIntentId).toBe(intentId);
    expect(await fakeObject(intentId).then((i) => i?.amountCents)).toBe(DEPOSIT_CHARGE_CENTS);
    // A key of its own: a pay-now deposit must never collide with — or replay —
    // one of the sweep's off-session `deposit:` attempts.
    expect(await idemUsed(`${bookingId}:${gigId}:paydue-deposit:${EXHAUSTED_DEPOSIT_ATTEMPTS}`)).toBe(true);
    // The settlement is untouched: a deposit paid late is still just a deposit.
    expect(held?.settlement.status).toBe("not_due");

    const depositRow = (await ledgerRows(bookingId)).find((r) => r.kind === "deposit_charged" && r.stripeId === intentId);
    expect(depositRow?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(depositRow?.profileId).toBe(curator.profileId);
    expect((await getBooking(bookingId)).paymentSummary?.heldCents).toBe(SLICE_CENTS);

    // THE POINT: the lift asks the DEPOSIT question too, so the gate opens.
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(false);
    const openGig = await createOpenGig(curator.profileId, curator.owner.user);
    await callFn("offerGig",
      { gigId: openGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user);
  });

  it("refuses a staged accept saga's doc (rule 3) and a doc carrying someone else's intent", async () => {
    const { curator, gigId, bookingId } = await makeFutureBooking("dundref");
    await seedExhaustedBirthDeposit(bookingId, gigId);
    const bookingRef = adb.doc(`bookings/${bookingId}`);
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${gigId}`);
    const payDueKey = `${bookingId}:${gigId}:paydue-deposit:${EXHAUSTED_DEPOSIT_ATTEMPTS}`;

    // RULE 3: an `unpaid` doc under a booking carrying the accept-saga marker
    // belongs to step 1 alone — a charge is in flight against exactly that
    // staged set, and charging one of its docs on a key that saga knows nothing
    // about is how one accept becomes two charges.
    await bookingRef.update({ depositChargePending: true });
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE,
      });
    expect(await idemUsed(payDueKey)).toBe(false);
    await bookingRef.update({ depositChargePending: false });

    // ...and an `unpaid` deposit already carrying an intent that is NOT this
    // callable's own: a birth charge left `processing` by the sweep can still
    // capture, so a second confirmable intent beside it would double-charge.
    await paymentRef.update({ "deposit.intentId": "pi_someone_elses" });
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE,
      });
    expect(await idemUsed(payDueKey)).toBe(false);
    await paymentRef.update({ "deposit.intentId": null });
  });

  // Case B: the debt is extinguished by being CANCELLED rather than paid. A
  // curator gated over a date nobody owes any more could otherwise never book.
  it("lifts the gate when the occurrence is cancelled instead — an extinguished debt is not an unpaid one", async () => {
    const { curator, musician, gigId, bookingId } = await makeFutureBooking("duncanc");
    await seedExhaustedBirthDeposit(bookingId, gigId);
    await seedDelinquent(curator.profileId);
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);

    // The curator cancels a week out: a plain refund, and this deposit was
    // never charged, so it resolves terminal with no Stripe call at all.
    await callFn("cancelBooking", { bookingId, reason: "Venue flooded." }, curator.owner.user);

    const cancelled = await getPayment(bookingId, gigId);
    expect(cancelled?.deposit.status).toBe("refunded");
    expect(cancelled?.settlement.status).toBe("waived");
    // Nothing is owed any more, so nothing gates.
    const cleared = await getStripeDoc(curator.profileId);
    expect(cleared?.delinquent).toBe(false);
    expect(cleared?.delinquentSince).toBeNull();
    const openGig = await createOpenGig(curator.profileId, curator.owner.user);
    await callFn("offerGig",
      { gigId: openGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user);
  });

  // The third way the debt goes away, and the one that used to strand a curator
  // forever: the date is PERFORMED. With no deposit in escrow the settlement
  // gets no slice credit, so it charges the FULL base — the deposit is absorbed
  // into that one charge. If the doc were left `unpaid` afterwards it would
  // still answer clearDelinquencyIfSettled's deposit-debt query, gating a
  // curator over money they had demonstrably just paid in full.
  it("absorbs the debt when the date settles at full base — the deposit resolves and the gate opens", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("dunabs");
    const accountId = await musicianAccountId(musician.profileId);
    await seedExhaustedBirthDeposit(bookingId, gigId);
    await seedDelinquent(curator.profileId);

    // Step 4 schedules the performed date (scheduleSettlement's helper asserts
    // a `held` deposit, which is exactly what this case does not have).
    await runPaymentsSweep(Date.now());
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("pending");
    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());

    const settled = await getPayment(bookingId, gigId);
    expect(settled?.settlement.status).toBe("paid");
    // NO slice credit: the full base, plus commission on all of it.
    expect(settled?.settlement.computedCents).toBe(ABSORBED_DUE_CENTS);
    expect(settled?.settlement.feeShareCents).toBe(ABSORBED_FEE_CENTS);
    expect(await fakeObject(settled!.settlement.intentId!).then((i) => i?.amountCents)).toBe(ABSORBED_CHARGE_CENTS);
    expect(settled?.transfer.amountCents).toBe(EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(EARNINGS_CENTS);

    // THE FIX: the absorbed deposit is retired rather than left `unpaid`.
    // `refunded` is the "no escrow of ours is outstanding" terminal state — no
    // money moved, because none ever did.
    expect(settled?.deposit.status).toBe("refunded");
    expect(typeof settled?.deposit.resolvedAt).toBe("number");
    expect(settled?.deposit.depositNextRetryAt).toBeNull();
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "refund")).toBe(false);

    // ...so both debt questions now answer "nothing", and the gate opens.
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(false);
    const openGig = await createOpenGig(curator.profileId, curator.owner.user);
    await callFn("offerGig",
      { gigId: openGig, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user);

    // And the debt cannot be charged a SECOND time through the deposit mode:
    // that predicate now requires an unsettled date.
    await expect(callFn("payPastDue", { bookingId, gigId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: PAY_PAST_DUE_NOT_OVERDUE_MESSAGE });

    // The aggregate agrees: nothing held, the settlement charge accounted for,
    // and the refunded deposit contributing nothing.
    const summary = (await getBooking(bookingId)).paymentSummary;
    expect(summary?.state).toBe("current");
    expect(summary?.heldCents).toBe(0);
    expect(summary?.paidCents).toBe(ABSORBED_CHARGE_CENTS);
    expect(summary?.transferredCents).toBe(EARNINGS_CENTS);
  });
});

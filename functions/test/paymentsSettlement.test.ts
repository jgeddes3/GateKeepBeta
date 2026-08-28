import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  computeDepositCents, computeEarningsCents, computeExpectedTotalCents, computeFeeShareCents,
  computeSettlementBaseCents, DEFAULT_FEE_POLICY,
  SETTLEMENT_DELAY_MS, SETTLEMENT_RETRY_OFFSETS_MS,
  type AdminAlertDoc, type BookingRequestDoc, type GigDoc, type LedgerEntry, type NotificationDoc,
  type PaymentDoc, type ProfileDraftInput, type ReliabilityDoc, type StripeProfileDoc,
} from "@gatekeep/shared";
// The sweep drives steps 5/6; chargeSettlement is invoked DIRECTLY for the
// cases whose preconditions can't be produced through the app's own callables
// (a deposit slice larger than the date is worth). Same direct-invoke style as
// paymentsSweep.test.ts.
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { clawbackAlertId, IDEMPOTENCY_WINDOW_MS } from "../src/paymentsCore.js";
import { chargeSettlement, clawbackSettledOccurrence } from "../src/paymentsSettlement.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

// 60s: every case chains two approved profiles, makeMoneyReady, a
// createGig/publishGig pair and a real accept BEFORE the two sweep runs it
// actually asserts on (schedule, then charge) — same budget paymentsSweep.ts's
// suite runs on, for the same reason.
vi.setConfig({ testTimeout: 60_000 });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Expected money, DERIVED (never transcribed). Every figure below comes out of
// the same shared helpers the server uses, applied to the fixtures' own frozen
// terms — so a change to a fee constant or a rounding law moves the assertion
// and the implementation together, and a test can never quietly enshrine a
// number the money layer no longer produces.
// ---------------------------------------------------------------------------
const FEE = DEFAULT_FEE_POLICY;

// perHour, $150/hr over a 90-minute gig: the standard SP5 fixture.
const RATE_CENTS = 15_000;
const DURATION_MINUTES = 90;
const BASE_CENTS = computeExpectedTotalCents("perHour", RATE_CENTS, { durationMinutes: DURATION_MINUTES });
const SLICE_CENTS = computeDepositCents(BASE_CENTS);
const DEPOSIT_FEE_CENTS = computeFeeShareCents(SLICE_CENTS, FEE.curatorFeePct);
const DEPOSIT_CHARGE_CENTS = SLICE_CENTS + DEPOSIT_FEE_CENTS;

// ...and what it settles for once the curator reports 30 extra minutes.
const EXTRA_MINUTES = 30;
const FINAL_BASE_CENTS = computeSettlementBaseCents("perHour", RATE_CENTS, {
  durationMinutes: DURATION_MINUTES, extraMinutes: EXTRA_MINUTES, songCount: null, extraSongs: 0,
});
const DUE_CENTS = FINAL_BASE_CENTS - SLICE_CENTS;
const SETTLE_FEE_CENTS = computeFeeShareCents(DUE_CENTS, FEE.curatorFeePct);
const SETTLE_CHARGE_CENTS = DUE_CENTS + SETTLE_FEE_CENTS;
const EARNINGS_CENTS = computeEarningsCents(FINAL_BASE_CENTS, FEE.musicianFeePct);

// The no-true-up settlement of the same fixture (the waive/pending/cancelled
// cases never report actuals).
const FLAT_DUE_CENTS = BASE_CENTS - SLICE_CENTS;
const FLAT_FEE_CENTS = computeFeeShareCents(FLAT_DUE_CENTS, FEE.curatorFeePct);
const FLAT_CHARGE_CENTS = FLAT_DUE_CENTS + FLAT_FEE_CENTS;
const FLAT_EARNINGS_CENTS = computeEarningsCents(BASE_CENTS, FEE.musicianFeePct);

// Task 12: what the SAME date costs when NO deposit slice is credited against
// it — the shape both a post-clawback restore re-run and an absorbed deposit
// settle on. The full base plus commission on the full base, which is strictly
// more than FLAT_CHARGE_CENTS above (the slice is no longer paying for part of
// the night). The musician's earnings are unchanged either way: they are a
// percentage of the base, not of what the card happened to be charged.
const FULL_FEE_CENTS = computeFeeShareCents(BASE_CENTS, FEE.curatorFeePct);
const FULL_CHARGE_CENTS = BASE_CENTS + FULL_FEE_CENTS;

// ---------- fixtures (mirroring paymentsSweep.test.ts's) ----------

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

async function endSeriesQuietly(seriesId: string): Promise<void> {
  await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" }).catch(() => {});
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

// FakeStripe's running per-account balance — the only honest way to assert
// that money actually reached the musician (a transfer object alone would also
// exist if the balance write had been lost).
async function accountBalanceCents(accountId: string): Promise<number> {
  return ((await fakeObject(accountId))?.balanceCents as number | undefined) ?? 0;
}

async function idemUsed(key: string): Promise<boolean> {
  return (await adb.doc(`stripeFake/state/idem/${encodeURIComponent(key)}`).get()).exists;
}

// FakeStripe's keys never expire; REAL Stripe's do, after 24h. Dropping the
// cached entry is how a test reproduces that expiry — past it the same key is
// brand new, so anything that "retries" on it mints a genuinely second charge.
async function expireIdemKey(key: string): Promise<void> {
  await adb.doc(`stripeFake/state/idem/${encodeURIComponent(key)}`).delete();
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

// A real, fully confirmed single-gig booking whose date has already ENDED
// (`pastStartHours` pushes the gig into the past BEFORE the accept — a payment
// doc's own `occurrenceStartsAt` is stamped at accept time and never follows a
// later gig edit).
async function makeEndedBooking(
  prefix: string,
  opts: { pastStartHours?: number; gig?: Record<string, unknown>; offer?: Record<string, unknown> } = {},
) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user, opts.gig ?? {});
  await setGigStartsAt(gigId, -(opts.pastStartHours ?? 5));
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId, musicianProfileId: musician.profileId, offer: opts.offer ?? offerPayload() },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

// Step 4 opens the settlement window; this is the T+3 wait, compressed. The
// due CLOCK is pulled back rather than the sweep's `now` pushed forward —
// `now` also drives the staleness guards and every other step's window, and
// moving it days ahead would silently change what those do to the shared
// emulator's world (the idiom paymentsSweep.test.ts's dunning case uses).
async function makeSettlementDue(bookingId: string, gigId: string): Promise<void> {
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`)
    .update({ "settlement.settleAfter": Date.now() - 1000 });
}

// Schedules the settlement (sweep step 4) and asserts the T+3 window it opens.
// Guarded on the doc's own state rather than run unconditionally: a case with
// TWO fixtures has both scheduled by the first sweep (step 4 is a
// collection-group query, not a per-doc call), so a second unconditional run
// would find nothing left to schedule.
async function scheduleSettlement(bookingId: string, gigId: string): Promise<void> {
  const gig = await getGig(gigId);
  const gigEnd = gig.startsAt + gig.durationMinutes * 60_000;
  if ((await getPayment(bookingId, gigId))?.settlement.status === "not_due") {
    await runPaymentsSweep(Date.now());
  }
  const scheduled = await getPayment(bookingId, gigId);
  expect(scheduled?.settlement.status).toBe("pending");
  // T+3 from the gig's END, not its start.
  expect(scheduled?.settlement.settleAfter).toBe(gigEnd + SETTLEMENT_DELAY_MS);
  expect(scheduled?.settlement.attempts).toBe(0);
  expect(scheduled?.deposit.status).toBe("held");
}

// ---------------------------------------------------------------------------

describe("settlement — the full T+3 pipeline", () => {
  it("perHour: schedules, takes the curator's +30min true-up, then charges final − slice + fee and transfers the earnings", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("stfull");
    const accountId = await musicianAccountId(musician.profileId);
    expect(await accountBalanceCents(accountId)).toBe(0);

    // --- step 4: the date ended, so the actuals window opens ---
    await scheduleSettlement(bookingId, gigId);

    // --- the true-up, and who may report it ---
    // The musician side never reports the curator's own bill.
    await expect(callFn("confirmOccurrenceActuals",
      { bookingId, gigId, extraMinutes: EXTRA_MINUTES }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: EXTRA_MINUTES }, curator.owner.user);
    const reported = await getPayment(bookingId, gigId);
    expect(reported?.settlement.trueUp?.extraMinutes).toBe(EXTRA_MINUTES);
    expect(reported?.settlement.trueUp?.extraSongs).toBe(0);
    expect(typeof reported?.settlement.trueUp?.reportedAt).toBe("number");

    // INCREASE-ONLY: a curator can never talk their own bill back down.
    await expect(callFn("confirmOccurrenceActuals",
      { bookingId, gigId, extraMinutes: EXTRA_MINUTES - 20 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    // ...and a repeat at the same value is a no-op replace, not an accumulate.
    await callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: EXTRA_MINUTES }, curator.owner.user);
    expect((await getPayment(bookingId, gigId))?.settlement.trueUp?.extraMinutes).toBe(EXTRA_MINUTES);

    // The window also closes for the duration of a charge that is IN FLIGHT —
    // the one-write-wide gap between the amount being computed and the intent
    // id being recorded. Seeded directly, because the real marker only exists
    // inside a single awaited chargeSettlement call.
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${gigId}`);
    await paymentRef.update({ "settlement.chargingSince": Date.now() });
    await expect(callFn("confirmOccurrenceActuals",
      { bookingId, gigId, extraMinutes: EXTRA_MINUTES }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    // ...but only for as long as the charge behind it could still be replayed.
    // A marker left by an instance that died mid-charge must not lock the
    // curator out of reporting actuals forever.
    await paymentRef.update({ "settlement.chargingSince": Date.now() - IDEMPOTENCY_WINDOW_MS - 1000 });
    await callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: EXTRA_MINUTES }, curator.owner.user);
    expect((await getPayment(bookingId, gigId))?.settlement.trueUp?.extraMinutes).toBe(EXTRA_MINUTES);
    // ...and the seeded marker is CLEARED before this case goes on to settle
    // normally. Leaving it set would hand the sweep below a doc that looks
    // like an instance died mid-charge on it, which chargeSettlement refuses
    // outright (the stale-claim terminator) — this case is about the ordinary
    // charge, and the refusal has its own case in the dunning suite.
    await paymentRef.update({ "settlement.chargingSince": null });

    // --- step 5: the charge + the transfer ---
    await makeSettlementDue(bookingId, gigId);
    const report = await runPaymentsSweep(Date.now());
    expect(report.settlementsCharged).toBeGreaterThanOrEqual(1);
    expect(report.transfersMade).toBeGreaterThanOrEqual(1);

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.computedCents).toBe(DUE_CENTS);
    expect(paid?.settlement.feeShareCents).toBe(SETTLE_FEE_CENTS);
    expect(paid?.settlement.nextRetryAt).toBeNull();
    // The escrow was consumed by this settlement, not refunded.
    expect(paid?.deposit.status).toBe("applied");
    expect(typeof paid?.deposit.resolvedAt).toBe("number");
    expect(paid?.transfer.status).toBe("transferred");
    expect(paid?.transfer.amountCents).toBe(EARNINGS_CENTS);
    expect(typeof paid?.transfer.transferredAt).toBe("number");

    // The card was charged exactly (final − slice) + commission, on the
    // attempt-scoped key, and it is NOT the deposit's intent.
    const settleIntentId = paid!.settlement.intentId!;
    expect(settleIntentId).toBeTruthy();
    expect(settleIntentId).not.toBe(paid!.deposit.intentId);
    expect(await fakeObject(settleIntentId).then((i) => i?.amountCents)).toBe(SETTLE_CHARGE_CENTS);
    expect(await idemUsed(`${bookingId}:${gigId}:settle:0`)).toBe(true);
    expect(await idemUsed(`${bookingId}:${gigId}:earn:0`)).toBe(true);

    // The musician's balance actually moved — and the transfer is backed by
    // the settlement charge (as-built contract #3's sourceChargeId).
    expect(await accountBalanceCents(accountId)).toBe(EARNINGS_CENTS);
    const transferObj = await fakeObject(paid!.transfer.id!);
    expect(transferObj?.amountCents).toBe(EARNINGS_CENTS);
    expect(transferObj?.sourceChargeId).toBe(await fakeObject(settleIntentId).then((i) => i?.chargeId));

    // Ledger: one row for each side of the move.
    const rows = await ledgerRows(bookingId);
    const chargeRow = rows.find((r) => r.kind === "settlement_charged");
    expect(chargeRow?.amountCents).toBe(SETTLE_CHARGE_CENTS);
    expect(chargeRow?.profileId).toBe(curator.profileId);
    expect(chargeRow?.stripeId).toBe(settleIntentId);
    const earnRow = rows.find((r) => r.kind === "earnings_transfer");
    expect(earnRow?.amountCents).toBe(EARNINGS_CENTS);
    expect(earnRow?.profileId).toBe(musician.profileId);
    expect(earnRow?.stripeId).toBe(paid!.transfer.id);

    // The booking aggregate: nothing held, nothing overdue.
    const summary = (await getBooking(bookingId)).paymentSummary;
    expect(summary?.state).toBe("current");
    expect(summary?.heldCents).toBe(0);
    expect(summary?.paidCents).toBe(DEPOSIT_CHARGE_CENTS + DUE_CENTS + SETTLE_FEE_CENTS);
    expect(summary?.transferredCents).toBe(EARNINGS_CENTS);

    expect((await notificationsFor(musician.owner.uid)).some((n) => n.title === "You've been paid")).toBe(true);

    // A true-up AFTER the charge is refused — the window is closed for good.
    await expect(callFn("confirmOccurrenceActuals",
      { bookingId, gigId, extraMinutes: EXTRA_MINUTES + 15 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // And a second sweep must not re-charge or re-transfer a `paid` doc.
    await runPaymentsSweep(Date.now());
    expect(await accountBalanceCents(accountId)).toBe(EARNINGS_CENTS);
    expect((await getPayment(bookingId, gigId))?.transfer.transferredAt).toBe(paid!.transfer.transferredAt);
  });

  it("perSong: the true-up adds songs at the frozen per-song rate", async () => {
    const songRate = 800;
    const songCount = 10;
    const extraSongs = 5;
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("stsong", {
      gig: { budget: { minCents: 5_000, maxCents: 20_000, structure: "perSong" } },
      offer: offerPayload({ amountCents: songRate, expectedQuantity: songCount }),
    });
    const accountId = await musicianAccountId(musician.profileId);

    const finalBase = computeSettlementBaseCents("perSong", songRate, {
      durationMinutes: DURATION_MINUTES, extraMinutes: 0, songCount, extraSongs,
    });
    const slice = computeDepositCents(computeExpectedTotalCents("perSong", songRate, { songCount }));
    const due = finalBase - slice;
    const fee = computeFeeShareCents(due, FEE.curatorFeePct);
    const earnings = computeEarningsCents(finalBase, FEE.musicianFeePct);

    await scheduleSettlement(bookingId, gigId);
    // A perSong booking bills songs — minutes are not its unit.
    await expect(callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: 30 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await callFn("confirmOccurrenceActuals", { bookingId, gigId, extraSongs }, curator.owner.user);

    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.computedCents).toBe(due);
    expect(paid?.settlement.feeShareCents).toBe(fee);
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.amountCents)).toBe(due + fee);
    expect(paid?.transfer.amountCents).toBe(earnings);
    expect(await accountBalanceCents(accountId)).toBe(earnings);
  });

  it("perSet: settles flat, and refuses a true-up outright", async () => {
    const setRate = 15_000;
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("stset", {
      gig: { budget: { minCents: 10_000, maxCents: 50_000, structure: "perSet" } },
      offer: offerPayload({ amountCents: setRate }),
    });
    const accountId = await musicianAccountId(musician.profileId);

    const finalBase = computeSettlementBaseCents("perSet", setRate, {
      durationMinutes: DURATION_MINUTES, extraMinutes: 0, songCount: null, extraSongs: 0,
    });
    const slice = computeDepositCents(finalBase);
    const due = finalBase - slice;
    const fee = computeFeeShareCents(due, FEE.curatorFeePct);
    const earnings = computeEarningsCents(finalBase, FEE.musicianFeePct);

    await scheduleSettlement(bookingId, gigId);
    // Nothing to report: a per-set deal is the whole deal.
    await expect(callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: 30 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(callFn("confirmOccurrenceActuals", { bookingId, gigId, extraSongs: 3 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.computedCents).toBe(due);
    expect(paid?.settlement.trueUp).toBeNull();
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.amountCents)).toBe(due + fee);
    expect(await accountBalanceCents(accountId)).toBe(earnings);
  });

  it("a selfDeal booking settles identically — the fees apply to a venue booking itself", async () => {
    const curator = await makeApprovedCuratorProfile("stselfc");
    const musician = await makeApprovedMusicianProfile("stselfm");
    await makeMoneyReady(curator, musician);
    // The overlap direction bookings.test.ts's F5 case uses: the MUSICIAN's
    // uid also sits on the curator profile, so the curator's own callables
    // still resolve unambiguously to the curator side.
    await adb.doc(`profiles/${curator.profileId}/members/${musician.owner.uid}`).set({
      uid: musician.owner.uid, role: "member", label: "also here", joinedAt: Date.now(),
    });
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    await setGigStartsAt(gigId, -5);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
    await callFn("acceptBooking", { bookingId }, curator.owner.user);
    expect((await getBooking(bookingId)).selfDeal).toBe(true);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.selfDeal).toBe(true);
    // EXACTLY the ordinary no-true-up amounts — selfDeal excludes a booking
    // from the trust metric (SP4 F5), never from the money.
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.computedCents).toBe(FLAT_DUE_CENTS);
    expect(paid?.settlement.feeShareCents).toBe(FLAT_FEE_CENTS);
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.amountCents)).toBe(FLAT_CHARGE_CENTS);
    expect(paid?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
  });
});

describe("settlement — defenses", () => {
  it("waives (and refunds) an occurrence whose gig left this booking after the settlement was scheduled", async () => {
    const { musician, gigId, bookingId } = await makeEndedBooking("stwaive");
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    const depositIntentId = (await getPayment(bookingId, gigId))!.deposit.intentId!;

    // The date is no longer this booking's (cancelOccurrence's shape) —
    // charging it would bill a curator for a night nobody owes them.
    await adb.doc(`gigs/${gigId}`).update({ status: "open", bookingId: null, bookedMusicianProfileId: null });
    await makeSettlementDue(bookingId, gigId);

    const report = await runPaymentsSweep(Date.now());
    expect(report.settlementsWaived).toBeGreaterThanOrEqual(1);

    const waived = await getPayment(bookingId, gigId);
    expect(waived?.settlement.status).toBe("waived");
    expect(waived?.settlement.intentId).toBeNull();
    // The held escrow went back through refund_pending and was resolved.
    expect(waived?.deposit.status).toBe("refunded");
    expect(typeof waived?.deposit.resolvedAt).toBe("number");
    expect(waived?.transfer.status).toBe("none");
    expect(await fakeObject(depositIntentId).then((i) => i?.refundedCents)).toBe(DEPOSIT_CHARGE_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await idemUsed(`${bookingId}:${gigId}:settle:0`)).toBe(false);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "settlement_charged")).toBe(false);
  });

  // Rule 1, the invariant the whole settlement sweep is built around: a
  // cancelled booking's PAST-start date still settles. The musician played
  // that night — only the paperwork moved on.
  it("settles a CANCELLED booking's past-start occurrence normally (never gated on booking.status)", async () => {
    const curator = await makeApprovedCuratorProfile("stcanc");
    const musician = await makeApprovedMusicianProfile("stcanm");
    await makeMoneyReady(curator, musician);
    const series = await seedSeries(curator.profileId);
    try {
      const pastGigId = await createOpenGig(curator.profileId, curator.owner.user);
      await setGigStartsAt(pastGigId, -5);
      const futureGigId = await createOpenGig(curator.profileId, curator.owner.user,
        { startsAt: Date.now() + 48 * HOUR_MS });
      for (const id of [pastGigId, futureGigId]) {
        await adb.doc(`gigs/${id}`).update({ seriesId: series.id });
      }
      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: futureGigId, musicianProfileId: musician.profileId, offer: offerPayload() },
        musician.owner.user);
      await callFn("acceptBooking", { bookingId }, curator.owner.user);
      const accountId = await musicianAccountId(musician.profileId);

      // The musician cancels the rest of the run (48h out — outside the mark
      // window, so this is a plain refund of the FUTURE date only).
      await callFn("cancelBooking", { bookingId, reason: "Van broke down." }, musician.owner.user);
      const cancelled = await getBooking(bookingId);
      expect(cancelled.status).toBe("cancelled_by_musician");
      // Task 8 leaves the past-start doc entirely alone.
      const untouched = await getPayment(bookingId, pastGigId);
      expect(untouched?.deposit.status).toBe("held");
      expect(untouched?.settlement.status).toBe("not_due");
      expect((await getPayment(bookingId, futureGigId))?.settlement.status).toBe("waived");

      // ...and the sweep schedules + settles it exactly like any other
      // performed date, on the strength of the GIG's linkage alone.
      expect((await getGig(pastGigId)).status).toBe("filled");
      await scheduleSettlement(bookingId, pastGigId);
      await makeSettlementDue(bookingId, pastGigId);
      await runPaymentsSweep(Date.now());

      const paid = await getPayment(bookingId, pastGigId);
      expect(paid?.settlement.status).toBe("paid");
      expect(paid?.settlement.computedCents).toBe(FLAT_DUE_CENTS);
      expect(paid?.deposit.status).toBe("applied");
      expect(paid?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
      expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
    } finally {
      await endSeriesQuietly(series.id);
    }
  });

  // The R8 branch (spec §4's below-deposit rule) is UNREACHABLE through the
  // app: true-ups only increase, and the slice is a fraction of the base. It
  // is exercised by seeding the only state that produces it — a slice larger
  // than the date is finally worth — and calling chargeSettlement directly.
  it("a settlement at or below the deposit slice charges nothing, refunds any excess, and still transfers", async () => {
    const zero = await makeEndedBooking("stzero");
    const below = await makeEndedBooking("stbelow");
    const zeroAccount = await musicianAccountId(zero.musician.profileId);
    const belowAccount = await musicianAccountId(below.musician.profileId);

    await scheduleSettlement(zero.bookingId, zero.gigId);
    await scheduleSettlement(below.bookingId, below.gigId);
    const zeroDeposit = (await getPayment(zero.bookingId, zero.gigId))!;
    const belowDeposit = (await getPayment(below.bookingId, below.gigId))!;

    // Exactly covered: due === 0, so nothing is charged at all.
    await adb.doc(`bookings/${zero.bookingId}/payments/${zero.gigId}`)
      .update({ "deposit.sliceCents": BASE_CENTS });
    // Over-covered by 2500c: the difference comes BACK on the deposit intent.
    const excess = 2_500;
    await adb.doc(`bookings/${below.bookingId}/payments/${below.gigId}`)
      .update({ "deposit.sliceCents": BASE_CENTS + excess });

    expect(await chargeSettlement({ bookingId: zero.bookingId, gigId: zero.gigId, now: Date.now() }))
      .toEqual({ outcome: "charged", transferred: true });
    expect(await chargeSettlement({ bookingId: below.bookingId, gigId: below.gigId, now: Date.now() }))
      .toEqual({ outcome: "charged", transferred: true });

    const zeroPaid = await getPayment(zero.bookingId, zero.gigId);
    expect(zeroPaid?.settlement.status).toBe("paid");
    expect(zeroPaid?.settlement.computedCents).toBe(0);
    expect(zeroPaid?.settlement.feeShareCents).toBe(0);
    expect(zeroPaid?.settlement.intentId).toBeNull();          // no charge happened
    expect(await idemUsed(`${zero.bookingId}:${zero.gigId}:settle:0`)).toBe(false);
    expect(zeroPaid?.deposit.status).toBe("applied");
    expect(await fakeObject(zeroDeposit.deposit.intentId!).then((i) => i?.refundedCents)).toBe(0);
    // The musician is still owed the full base — and with no fresh charge to
    // draw on, the transfer is backed by the DEPOSIT's charge instead.
    expect(zeroPaid?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(await accountBalanceCents(zeroAccount)).toBe(FLAT_EARNINGS_CENTS);
    expect(await fakeObject(zeroPaid!.transfer.id!).then((t) => t?.sourceChargeId))
      .toBe(zeroDeposit.deposit.chargeId);
    expect((await ledgerRows(zero.bookingId)).some((r) => r.kind === "settlement_charged")).toBe(false);

    const belowPaid = await getPayment(below.bookingId, below.gigId);
    expect(belowPaid?.settlement.status).toBe("paid");
    expect(belowPaid?.settlement.computedCents).toBe(0);       // never negative
    expect(belowPaid?.deposit.status).toBe("applied");
    expect(await fakeObject(belowDeposit.deposit.intentId!).then((i) => i?.refundedCents)).toBe(excess);
    expect(await idemUsed(`${below.bookingId}:${below.gigId}:settle-down`)).toBe(true);
    expect(belowPaid?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(await accountBalanceCents(belowAccount)).toBe(FLAT_EARNINGS_CENTS);
    const refundRow = (await ledgerRows(below.bookingId)).find((r) => r.kind === "refund");
    expect(refundRow?.amountCents).toBe(excess);
    expect(refundRow?.detail).toBe("below-deposit settlement refund");
  });

  // M5 (branch audit): the no_customer / gig_missing refusals used to be
  // console-only. SP5's rule is "never refuse silently" — both must leave a
  // durable row an operator works. Testing the no_customer branch here.
  it("M5: chargeSettlement with no curator Stripe customer refuses AND raises a durable alert — not a silent console-only refusal", async () => {
    const { curator, gigId, bookingId } = await makeEndedBooking("m5nocust");
    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    // Strip the curator's cached customerId — the "nothing to charge against"
    // anomaly (normally unreachable, since accept gates on a chargeable curator,
    // which is exactly why a silent refusal here would never be seen).
    await adb.doc(`profiles/${curator.profileId}/private/stripe`).update({ customerId: FieldValue.delete() });

    const result = await chargeSettlement({ bookingId, gigId, now: Date.now() });
    expect(result.reason).toBe("no_customer");
    // Nothing charged, and the true-up window re-opened (chargingSince cleared).
    const after = await getPayment(bookingId, gigId);
    expect(after?.settlement.status).toBe("pending");
    expect(after?.settlement.chargingSince).toBeNull();

    const alert = await adminAlert(`settlement-pending:${bookingId}:${gigId}`);
    expect(alert?.kind).toBe("settlement_pending_stuck");
    expect(alert?.detail).toContain("no Stripe customer");
    expect(alert?.bookingId).toBe(bookingId);
    expect(alert?.gigId).toBe(gigId);
    expect(alert?.resolvedAt).toBeNull();
  });
});

describe("settlement — a charge left processing", () => {
  it("persists the intent and finalizes via payment_intent.succeeded; a replay is a no-op", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("stpend");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    let report;
    try {
      await setChargeKnob("pendingCustomerIds", customerId, true);
      report = await runPaymentsSweep(Date.now());
    } finally {
      await setChargeKnob("pendingCustomerIds", customerId, false);
    }
    expect(report.settlementsPending).toBeGreaterThanOrEqual(1);

    // Not a failure and not a success: the intent exists and is settling, so
    // the settlement stays `pending` with NO retry bookkeeping (a same-key
    // retry is impossible — the cached `processing` outcome replays forever),
    // and nothing has been transferred.
    const pending = await getPayment(bookingId, gigId);
    expect(pending?.settlement.status).toBe("pending");
    expect(pending?.settlement.attempts).toBe(0);
    expect(pending?.settlement.nextRetryAt).toBeNull();
    expect(pending?.deposit.status).toBe("held");
    expect(pending?.transfer.status).toBe("none");
    const intentId = pending!.settlement.intentId!;
    expect(intentId).toBeTruthy();
    expect(await fakeObject(intentId).then((i) => i?.status)).toBe("processing");
    expect(await accountBalanceCents(accountId)).toBe(0);

    // The window is closed while a charge is outstanding: a true-up here would
    // settle the doc for an amount that was never charged.
    await expect(callFn("confirmOccurrenceActuals", { bookingId, gigId, extraMinutes: 30 }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // THE DOUBLE-CHARGE TERMINATOR. This doc is still `pending` with its
    // `settleAfter` in the past, so every hourly run finds it again — and it
    // must never be charged a second time. Reproduced under the condition that
    // makes it dangerous: the idempotency key EXPIRED (real Stripe drops it
    // after 24h; the fake's never do, so the test drops it by hand) and the
    // card is now perfectly good. Without the guard this run would mint a
    // brand-new intent and charge the curator twice for one night.
    await expireIdemKey(`${bookingId}:${gigId}:settle:0`);
    const secondRun = await runPaymentsSweep(Date.now());
    expect(secondRun.settlementsPending).toBeGreaterThanOrEqual(1);

    const stillPending = await getPayment(bookingId, gigId);
    expect(stillPending?.settlement.status).toBe("pending");
    expect(stillPending?.settlement.intentId).toBe(intentId);      // the SAME intent, not a new one
    expect(stillPending?.settlement.attempts).toBe(0);
    expect(stillPending?.transfer.status).toBe("none");
    // No charge was even ATTEMPTED: the key the attempt would have used is
    // still absent, and nothing reached the musician.
    expect(await idemUsed(`${bookingId}:${gigId}:settle:0`)).toBe(false);
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "settlement_charged")).toBe(false);
    // Refusing is correct; refusing silently is not.
    const stuckAlert = await adminAlert(`settlement-pending:${bookingId}:${gigId}`);
    expect(stuckAlert?.kind).toBe("settlement_pending_stuck");
    expect(stuckAlert?.bookingId).toBe(bookingId);
    expect(stuckAlert?.gigId).toBe(gigId);
    expect(stuckAlert?.resolvedAt).toBeNull();

    // Stripe confirms it — the settlement finishes out-of-band, exactly as the
    // synchronous path would have.
    const evt = fakeEvent("payment_intent.succeeded", {
      id: intentId, amount: FLAT_CHARGE_CENTS, amount_received: FLAT_CHARGE_CENTS,
      metadata: { bookingId, gigId, purpose: "settlement" },
    });
    expect((await postWebhook(evt)).status).toBe(200);

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.intentId).toBe(intentId);
    expect(paid?.settlement.computedCents).toBe(FLAT_DUE_CENTS);
    expect(paid?.settlement.feeShareCents).toBe(FLAT_FEE_CENTS);
    expect(paid?.deposit.status).toBe("applied");
    expect(paid?.transfer.status).toBe("transferred");
    expect(paid?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "earnings_transfer")).toBe(true);
    expect((await notificationsFor(musician.owner.uid)).some((n) => n.title === "You've been paid")).toBe(true);

    // Same event id: deduped by the webhook's claim machine outright.
    expect((await postWebhook(evt)).text).toBe("duplicate");
    // A FRESH event id carrying the same intent still reaches the handler,
    // which must no-op on an already-`paid` settlement.
    const replay = fakeEvent("payment_intent.succeeded", {
      id: intentId, amount: FLAT_CHARGE_CENTS, amount_received: FLAT_CHARGE_CENTS,
      metadata: { bookingId, gigId, purpose: "settlement" },
    });
    expect((await postWebhook(replay)).status).toBe(200);
    const afterReplay = await getPayment(bookingId, gigId);
    expect(afterReplay?.transfer.transferredAt).toBe(paid!.transfer.transferredAt);
    expect(afterReplay?.transfer.id).toBe(paid!.transfer.id);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
  });

  // The PRE-TRANSFER race, end to end. A charge is outstanding when the
  // curator reports a no-show, which waives the very occurrence the charge was
  // for. When the intent then succeeds, the musician must NOT be paid — but
  // the curator's money did move, so it has to be recorded and escalated
  // rather than dropped.
  it("a no-show waive landing under an outstanding charge blocks the transfer, records the charge, and escalates", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("strace");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);
    try {
      await setChargeKnob("pendingCustomerIds", customerId, true);
      await runPaymentsSweep(Date.now());
    } finally {
      await setChargeKnob("pendingCustomerIds", customerId, false);
    }
    const intentId = (await getPayment(bookingId, gigId))!.settlement.intentId!;
    expect(intentId).toBeTruthy();

    // The curator reports the no-show while that intent is still settling.
    // Task 8 waives the reported occurrence's settlement and sends its deposit
    // back — it is the one path that knows this date did not happen.
    await callFn("reportNoShow", { bookingId, reason: "The act never turned up." }, curator.owner.user);
    const waived = await getPayment(bookingId, gigId);
    expect(waived?.settlement.status).toBe("waived");
    expect(waived?.deposit.status).toBe("refunded");

    // ...and now Stripe confirms the charge.
    const evt = fakeEvent("payment_intent.succeeded", {
      id: intentId, amount: FLAT_CHARGE_CENTS, amount_received: FLAT_CHARGE_CENTS,
      metadata: { bookingId, gigId, purpose: "settlement" },
    });
    expect((await postWebhook(evt)).status).toBe(200);

    const after = await getPayment(bookingId, gigId);
    // THE assertion: the musician was never paid for a night they didn't play.
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(after?.transfer.status).toBe("none");
    expect(after?.transfer.id).toBeNull();
    // The waive stands — the raced write is merge-only and touches no status
    // the racer owns.
    expect(after?.settlement.status).toBe("waived");
    expect(after?.deposit.status).toBe("refunded");
    expect(after?.settlement.intentId).toBe(intentId);
    expect(after?.settlement.chargingSince).toBeNull();
    // The curator's money DID move, so the audit row exists regardless of the
    // exceptional exit — an operator reconciling the alert reads the ledger.
    const chargeRow = (await ledgerRows(bookingId)).find((r) => r.kind === "settlement_charged");
    expect(chargeRow?.amountCents).toBe(FLAT_CHARGE_CENTS);
    expect(chargeRow?.stripeId).toBe(intentId);
    expect(chargeRow?.profileId).toBe(curator.profileId);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "earnings_transfer")).toBe(false);
    // ...and it is escalated, with the unambiguous "just refund it" wording
    // (nothing went out to the musician, so no reversal is involved).
    const alert = await adminAlert(`settlement-raced:${bookingId}:${gigId}`);
    expect(alert?.kind).toBe("settlement_raced");
    expect(alert?.detail).toContain("NO transfer was made");
    expect(alert?.resolvedAt).toBeNull();
  });

  // M2 (branch audit): the LAST pay-the-musician-twice path. The webhook finalize
  // holds no pre-charge claim of its own, so a redelivery that lands past Stripe's
  // idempotency window would re-derive the SAME attempt-scoped `earn:{attempts}`
  // key on a now-stale key and transfer a SECOND time. The finalize path must
  // refuse (and escalate) instead of re-transferring.
  it("M2: a >24h webhook redelivery finalizing under a STALE chargingSince claim does NOT re-transfer — it refuses and escalates", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("m2stale");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    // Leave the settlement "processing": the charge is outstanding, its intent is
    // recorded, and chargingSince stays set from the pre-charge claim. Nothing has
    // been transferred.
    try {
      await setChargeKnob("pendingCustomerIds", customerId, true);
      await runPaymentsSweep(Date.now());
    } finally {
      await setChargeKnob("pendingCustomerIds", customerId, false);
    }
    const pending = await getPayment(bookingId, gigId);
    expect(pending?.settlement.status).toBe("pending");
    const intentId = pending!.settlement.intentId!;
    expect(intentId).toBeTruthy();
    expect(await accountBalanceCents(accountId)).toBe(0);

    // Simulate the dangerous shape: the FIRST finalize's terminal write never
    // landed (the doc is still pending), and the redelivery arrives with its
    // pre-charge claim already older than Stripe's key window — so the
    // `earn:{attempts}` key can no longer replay the original transfer, and
    // re-deriving it would be a genuine SECOND payout.
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${gigId}`);
    await paymentRef.update({ "settlement.chargingSince": Date.now() - IDEMPOTENCY_WINDOW_MS - 1000 });

    const evt = fakeEvent("payment_intent.succeeded", {
      id: intentId, amount: FLAT_CHARGE_CENTS, amount_received: FLAT_CHARGE_CENTS,
      metadata: { bookingId, gigId, purpose: "settlement" },
    });
    expect((await postWebhook(evt)).status).toBe(200);

    // THE assertion: no second transfer. The musician's balance never moved on
    // this delivery, the earn:0 key was never used, no earnings ledger row, and
    // the settlement is left for a human rather than flipped `paid` off an
    // un-spanned transfer.
    const after = await getPayment(bookingId, gigId);
    expect(after?.settlement.status).toBe("pending");
    expect(after?.transfer.status).toBe("none");
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await idemUsed(`${bookingId}:${gigId}:earn:0`)).toBe(false);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "earnings_transfer")).toBe(false);

    // Refusing is correct; refusing silently is not.
    const raced = await adminAlert(`settlement-raced:${bookingId}:${gigId}`);
    expect(raced?.kind).toBe("settlement_raced");
    expect(raced?.resolvedAt).toBeNull();
  });
});

describe("settlement — a declined charge (Task 11 owns the ladder from here)", () => {
  it("goes past_due with one attempt and the first retry scheduled, and the retry uses a FRESH key", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("stdecl");
    const customerId = await curatorCustomerId(curator.profileId);
    const accountId = await musicianAccountId(musician.profileId);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    const t0 = Date.now();
    let report;
    try {
      await setChargeKnob("declineCustomerIds", customerId, true);
      report = await runPaymentsSweep(t0);
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }
    expect(report.settlementsDeclined).toBeGreaterThanOrEqual(1);

    const declined = await getPayment(bookingId, gigId);
    expect(declined?.settlement.status).toBe("past_due");
    expect(declined?.settlement.attempts).toBe(1);
    expect(declined?.settlement.nextRetryAt).toBeGreaterThanOrEqual(t0 + SETTLEMENT_RETRY_OFFSETS_MS[0]);
    expect(declined?.settlement.nextRetryAt).toBeLessThan(t0 + SETTLEMENT_RETRY_OFFSETS_MS[0] + 60_000);
    // Nothing moved: the escrow is untouched and the musician was not paid.
    expect(declined?.deposit.status).toBe("held");
    expect(declined?.transfer.status).toBe("none");
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect((await getBooking(bookingId)).paymentSummary?.state).toBe("past_due");

    // Before its retry is due, step 6 must not attempt anything.
    await runPaymentsSweep(Date.now());
    expect((await getPayment(bookingId, gigId))?.settlement.attempts).toBe(1);
    expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(false);

    // At the retry's due time, on a good card: the key MUST differ — both real
    // Stripe and the fake cache the decline under the key that produced it.
    await adb.doc(`bookings/${bookingId}/payments/${gigId}`)
      .update({ "settlement.nextRetryAt": Date.now() - 1000 });
    const retry = await runPaymentsSweep(Date.now());
    expect(retry.retriesAttempted).toBeGreaterThanOrEqual(1);

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.nextRetryAt).toBeNull();
    expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(true);
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.amountCents)).toBe(FLAT_CHARGE_CENTS);
    // The earnings key is attempt-scoped too, so the retry's transfer is a
    // genuinely new one rather than a replay of a consumed key.
    expect(await idemUsed(`${bookingId}:${gigId}:earn:1`)).toBe(true);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
    expect((await getBooking(bookingId)).paymentSummary?.state).toBe("current");
    expect((await notificationsFor(musician.owner.uid)).some((n) => n.title === "You've been paid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 12 — the post-transfer no-show clawback and its mark-removal re-run
// ---------------------------------------------------------------------------

// A booking taken all the way through the ordinary pipeline: charged at T+3 and
// the earnings transferred. The starting position for every clawback case —
// the clawback only exists for money that has ALREADY moved in both directions.
async function settleFully(prefix: string) {
  const f = await makeEndedBooking(prefix);
  await scheduleSettlement(f.bookingId, f.gigId);
  await makeSettlementDue(f.bookingId, f.gigId);
  await runPaymentsSweep(Date.now());
  const paid = (await getPayment(f.bookingId, f.gigId))!;
  expect(paid.settlement.status).toBe("paid");
  expect(paid.transfer.status).toBe("transferred");
  return { ...f, paid, accountId: await musicianAccountId(f.musician.profileId) };
}

async function reliabilityFor(profileId: string): Promise<ReliabilityDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/private/reliability`).get()).data() as ReliabilityDoc | undefined;
}

describe("settlement — the post-transfer no-show clawback", () => {
  it("reverses the transfer, refunds the settlement AND the applied deposit, then re-settles in full when an admin reverses the report", async () => {
    const { curator, musician, gigId, bookingId, paid, accountId } = await settleFully("clawpipe");
    const settleIntentId = paid.settlement.intentId!;
    const depositIntentId = paid.deposit.intentId!;
    const transferId = paid.transfer.id!;
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);

    // R1's precondition: the sweep has already resolved this booking to
    // "completed" and credited it once. Seeded directly — scheduled.test.ts
    // owns step 7 itself; this case is about what the report does to that.
    await adb.doc(`bookings/${bookingId}`).update({ status: "completed", resolvedAt: Date.now() });
    await adb.doc(`profiles/${musician.profileId}/private/reliability`)
      .set({ marks: [], completedCount: 1, updatedAt: Date.now() });

    // --- the report, inside the 14-day window, AFTER the money moved ---
    await callFn("reportNoShow",
      { bookingId, reason: "They never turned up — and I've already been billed for it." }, curator.owner.user);

    const clawed = await getPayment(bookingId, gigId);
    expect(clawed?.settlement.status).toBe("waived");
    expect(clawed?.transfer.status).toBe("reversed");
    // The reversed transfer's own record is deliberately KEPT — it is what the
    // reversal undid, and the ledger row keys off the reversal's own id.
    expect(clawed?.transfer.id).toBe(transferId);
    expect(clawed?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(clawed?.deposit.status).toBe("refunded");
    expect(typeof clawed?.deposit.resolvedAt).toBe("number");
    // The consumed charge handle stays until the RESTORE clears it (the
    // outstanding-intent guard's contract) — the clawback never clears it.
    expect(clawed?.settlement.intentId).toBe(settleIntentId);
    expect(clawed?.settlement.chargingSince).toBeNull();

    // THE MONEY, both directions. The musician's balance is debited by exactly
    // what they were paid, and the curator gets back the settlement charge AND
    // the deposit that rode the same economics.
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(transferId).then((t) => t?.reversed)).toBe(true);
    expect(await fakeObject(settleIntentId).then((i) => i?.refundedCents)).toBe(FLAT_CHARGE_CENTS);
    expect(await fakeObject(depositIntentId).then((i) => i?.refundedCents)).toBe(DEPOSIT_CHARGE_CENTS);
    expect(await idemUsed(`${bookingId}:${gigId}:clawback`)).toBe(true);
    expect(await idemUsed(`${bookingId}:${gigId}:clawback-refund`)).toBe(true);
    expect(await idemUsed(`${bookingId}:${gigId}:clawback-deposit`)).toBe(true);

    // Three audit rows for three Stripe objects.
    const rows = await ledgerRows(bookingId);
    const reversalRow = rows.find((r) => r.kind === "transfer_reversal");
    expect(reversalRow?.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(reversalRow?.profileId).toBe(musician.profileId);
    expect(reversalRow?.gigId).toBe(gigId);
    const refunds = rows.filter((r) => r.kind === "refund");
    expect(refunds.map((r) => r.amountCents).sort((a, b) => a - b))
      .toEqual([DEPOSIT_CHARGE_CENTS, FLAT_CHARGE_CENTS].sort((a, b) => a - b));
    expect(refunds.every((r) => r.profileId === curator.profileId)).toBe(true);

    // Nothing of this booking's money is outstanding any more.
    expect((await getBooking(bookingId)).paymentSummary)
      .toEqual({ state: "current", heldCents: 0, paidCents: 0, transferredCents: 0 });
    // SP4 R1 is intact underneath: the report clawed the completion credit back.
    expect((await reliabilityFor(musician.profileId))?.completedCount).toBe(0);
    expect((await getBooking(bookingId)).status).toBe("cancelled_by_musician");

    // A SECOND clawback is a silent no-op — the CAS refuses a doc that is no
    // longer paid/transferred, so nothing moves and no ticket is raised.
    await clawbackSettledOccurrence(bookingId, gigId, Date.now());
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(settleIntentId).then((i) => i?.refundedCents)).toBe(FLAT_CHARGE_CENTS);
    expect(await adminAlert(clawbackAlertId(bookingId, gigId))).toBeUndefined();

    // Stripe's own `transfer.reversed` for the reversal WE made: both rows key
    // off the reversal object's id, so the webhook's is deduped away.
    expect((await postWebhook(fakeEvent("transfer.reversed", {
      id: transferId, amount: FLAT_EARNINGS_CENTS, amount_reversed: FLAT_EARNINGS_CENTS,
      metadata: { bookingId, gigId, purpose: "earnings" },
      reversals: { data: [{ id: reversalRow!.stripeId }] },
    }))).status).toBe(200);
    expect((await ledgerRows(bookingId)).filter((r) => r.kind === "transfer_reversal").length).toBe(1);

    // --- the report was FALSE: an admin removes the mark (SP4 F4) ---
    const admin = await makeAdminUser("clawpipea");
    await callFn("removeReliabilityMark",
      { musicianProfileId: musician.profileId, bookingId, kind: "reported_no_show" }, admin.user);

    expect((await getBooking(bookingId)).status).toBe("completed");
    expect((await reliabilityFor(musician.profileId))?.completedCount).toBe(1);

    // ...and the MONEY is re-opened with it: the date is due again, on a fresh
    // attempt so its Stripe keys are new, with the pre-clawback late-fee
    // bookkeeping cleared and the refunded deposit left refunded.
    const reopened = await getPayment(bookingId, gigId);
    expect(reopened?.settlement.status).toBe("pending");
    expect(reopened?.settlement.settleAfter).toBeLessThanOrEqual(Date.now());
    expect(reopened?.settlement.intentId).toBeNull();
    expect(reopened?.settlement.attempts).toBe(1);
    expect(reopened?.settlement.nextRetryAt).toBeNull();
    expect(reopened?.settlement.chargingSince).toBeNull();
    expect(reopened?.settlement.lateFeeCents).toBeNull();
    expect(reopened?.settlement.lateFeeMusicianCents).toBeNull();
    expect(reopened?.settlement.delinquentAt).toBeNull();
    expect(reopened?.deposit.status).toBe("refunded");
    expect(reopened?.transfer.status).toBe("reversed");

    // --- and the next sweep settles it all over again, from scratch ---
    const rerun = await runPaymentsSweep(Date.now());
    expect(rerun.settlementsCharged).toBeGreaterThanOrEqual(1);
    expect(rerun.transfersMade).toBeGreaterThanOrEqual(1);

    const resettled = await getPayment(bookingId, gigId);
    expect(resettled?.settlement.status).toBe("paid");
    // THE FULL BASE, with no slice credit: that deposit went back in the
    // clawback, so there is no escrow left to count against the date.
    expect(resettled?.settlement.computedCents).toBe(BASE_CENTS);
    expect(resettled?.settlement.feeShareCents).toBe(FULL_FEE_CENTS);
    expect(resettled?.settlement.intentId).not.toBe(settleIntentId);
    expect(await fakeObject(resettled!.settlement.intentId!).then((i) => i?.amountCents)).toBe(FULL_CHARGE_CENTS);
    // Fresh, attempt-scoped keys on both legs — without the attempts bump these
    // would replay the consumed originals and no money would move.
    expect(await idemUsed(`${bookingId}:${gigId}:settle:1`)).toBe(true);
    expect(await idemUsed(`${bookingId}:${gigId}:earn:1`)).toBe(true);
    // The musician is paid the same earnings again, on a genuinely new transfer.
    expect(resettled?.transfer.status).toBe("transferred");
    expect(resettled?.transfer.id).not.toBe(transferId);
    expect(resettled?.transfer.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
    // The deposit is never re-applied — claiming escrow that came back would be
    // a second, phantom credit against the same date.
    expect(resettled?.deposit.status).toBe("refunded");
    expect(await fakeObject(depositIntentId).then((i) => i?.refundedCents)).toBe(DEPOSIT_CHARGE_CENTS);
    expect((await getBooking(bookingId)).paymentSummary?.transferredCents).toBe(FLAT_EARNINGS_CENTS);
  });

  it("issues NO second deposit refund when the settlement had already absorbed the deposit", async () => {
    const { curator, musician, gigId, bookingId } = await makeEndedBooking("clawabs");
    const accountId = await musicianAccountId(musician.profileId);
    const depositIntentId = (await getPayment(bookingId, gigId))!.deposit.intentId!;

    // The ABSORPTION shape: an `unpaid` deposit carrying no intent by the time
    // the date settles (a birth deposit the sweep never got to). settlementMath
    // credits no slice, so the settlement charges the FULL base and
    // finalizeSettlementSuccess retires the deposit as `refunded` with no money
    // moving. Seeded, because the app cannot produce it on a past-dated
    // occurrence — step 3 only charges future-dated deposits.
    await adb.doc(`bookings/${bookingId}/payments/${gigId}`).update({
      "deposit.status": "unpaid", "deposit.intentId": null,
      "deposit.chargeId": null, "deposit.chargedAt": null,
    });
    await runPaymentsSweep(Date.now());                    // step 4 schedules it
    expect((await getPayment(bookingId, gigId))?.settlement.status).toBe("pending");
    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());                    // step 5 charges + transfers

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(paid?.settlement.computedCents).toBe(BASE_CENTS);   // the full base was charged
    expect(paid?.deposit.status).toBe("refunded");             // absorbed, not applied
    expect(paid?.transfer.status).toBe("transferred");
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);

    await callFn("reportNoShow", { bookingId, reason: "Nobody showed." }, curator.owner.user);

    const clawed = await getPayment(bookingId, gigId);
    expect(clawed?.settlement.status).toBe("waived");
    expect(clawed?.transfer.status).toBe("reversed");
    expect(clawed?.deposit.status).toBe("refunded");
    expect(await accountBalanceCents(accountId)).toBe(0);
    // The settlement refund already covered the WHOLE date...
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.refundedCents)).toBe(FULL_CHARGE_CENTS);
    // ...so the deposit's own accept-time charge is untouched. A second refund
    // here would be a refund of money this occurrence never kept.
    expect(await fakeObject(depositIntentId).then((i) => i?.refundedCents)).toBe(0);
    expect(await idemUsed(`${bookingId}:${gigId}:clawback-deposit`)).toBe(false);
    expect((await ledgerRows(bookingId)).filter((r) => r.kind === "refund").length).toBe(1);
  });

  it("escalates instead of moving money when Stripe refuses the reversal", async () => {
    const { curator, gigId, bookingId, paid, accountId } = await settleFully("clawdbl");
    const alertId = clawbackAlertId(bookingId, gigId);

    await callFn("reportNoShow", { bookingId, reason: "Did not play." }, curator.owner.user);
    expect((await getPayment(bookingId, gigId))?.transfer.status).toBe("reversed");
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await adminAlert(alertId)).toBeUndefined();

    // The shape the CAS cannot see: the doc is back to paid/transferred (an
    // operator's repair, a restored backup) against a transfer Stripe has
    // ALREADY reversed — and with the key that would replay our own reversal
    // expired, exactly as real Stripe drops it after 24h.
    await adb.doc(`bookings/${bookingId}/payments/${gigId}`).update({
      "settlement.status": "paid", "transfer.status": "transferred", "deposit.status": "applied",
    });
    await expireIdemKey(`${bookingId}:${gigId}:clawback`);
    await clawbackSettledOccurrence(bookingId, gigId, Date.now());

    const alert = await adminAlert(alertId);
    expect(alert?.kind).toBe("clawback_failed");
    expect(alert?.detail).toContain("already been reversed");
    // The step report says the sequence never got past its first leg, so an
    // operator knows nothing has been refunded yet.
    expect(alert?.detail).toContain(`reversal (${FLAT_EARNINGS_CENTS}c) ✗`);
    expect(alert?.detail).toContain(`settlement refund (${FLAT_CHARGE_CENTS}c) ✗`);
    expect(alert?.detail).toContain("doc write ✗");
    expect(alert?.bookingId).toBe(bookingId);
    expect(alert?.gigId).toBe(gigId);
    expect(alert?.resolvedAt).toBeNull();
    // NOTHING moved on the failed run: the refusal comes before either refund.
    const after = await getPayment(bookingId, gigId);
    expect(after?.settlement.status).toBe("paid");
    expect(after?.transfer.status).toBe("transferred");
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(paid.settlement.intentId!).then((i) => i?.refundedCents)).toBe(FLAT_CHARGE_CENTS);
    expect(await fakeObject(paid.deposit.intentId!).then((i) => i?.refundedCents)).toBe(DEPOSIT_CHARGE_CENTS);
  });

  it("keeps the audit trail for the legs that DID move when one of them is refused mid-sequence", async () => {
    const { gigId, bookingId, paid, accountId } = await settleFully("clawpart");
    const settleIntentId = paid.settlement.intentId!;
    const depositIntentId = paid.deposit.intentId!;

    // THE TRIGGER, deterministic and honest: this deposit's charge has already
    // been refunded in full by something else (an operator in the dashboard, a
    // whole-run sibling's own unwind), so the clawback's slice+fee refund would
    // take that intent past what it still holds — FakeStripe's "refund exceeds
    // charge" guard, and real Stripe's 400. Seeded on the fake's intent OBJECT
    // rather than by poisoning an idempotency key, so the refusal comes from
    // the money rule under test rather than from test plumbing. It is also the
    // exact shape the R8 (below-deposit) interaction produces in the wild.
    const depositCharged = (await fakeObject(depositIntentId))!.amountCents as number;
    expect(depositCharged).toBe(DEPOSIT_CHARGE_CENTS);
    await adb.doc(`stripeFake/state/objects/${depositIntentId}`).update({ refundedCents: depositCharged });

    await clawbackSettledOccurrence(bookingId, gigId, Date.now());

    // The two legs that SUCCEEDED both moved money AND left their audit row —
    // the whole point of writing each row as its call returns rather than
    // batching them after the terminal write that never happens.
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(paid.transfer.id!).then((t) => t?.reversed)).toBe(true);
    expect(await fakeObject(settleIntentId).then((i) => i?.refundedCents)).toBe(FLAT_CHARGE_CENTS);
    const rows = await ledgerRows(bookingId);
    expect(rows.find((r) => r.kind === "transfer_reversal")?.amountCents).toBe(FLAT_EARNINGS_CENTS);
    const refunds = rows.filter((r) => r.kind === "refund");
    expect(refunds.length).toBe(1);                        // the deposit's row is absent, correctly
    expect(refunds[0].amountCents).toBe(FLAT_CHARGE_CENTS);

    // ...and the ticket names every leg's outcome, with BOTH intent handles.
    const alert = await adminAlert(clawbackAlertId(bookingId, gigId));
    expect(alert?.kind).toBe("clawback_failed");
    expect(alert?.detail).toContain(`reversal (${FLAT_EARNINGS_CENTS}c) ✓`);
    expect(alert?.detail).toContain(`settlement refund (${FLAT_CHARGE_CENTS}c) ✓`);
    expect(alert?.detail).toContain(`deposit refund (${DEPOSIT_CHARGE_CENTS}c) ✗`);
    expect(alert?.detail).toContain("doc write ✗");
    expect(alert?.detail).toContain(`settlement intent ${settleIntentId}`);
    expect(alert?.detail).toContain(`deposit intent ${depositIntentId}`);
    expect(alert?.resolvedAt).toBeNull();

    // NO terminal write: the doc still reads paid/transferred/applied, which is
    // what stops anything downstream from believing the unwind completed.
    const after = await getPayment(bookingId, gigId);
    expect(after?.settlement.status).toBe("paid");
    expect(after?.transfer.status).toBe("transferred");
    expect(after?.deposit.status).toBe("applied");
  });

  it("records a FOREIGN transfer.reversed as a ledger row only, and dedupes every replay of it", async () => {
    const { musician, gigId, bookingId, paid } = await settleFully("clawwh");
    const transferId = paid.transfer.id!;
    // A reversal nothing in this codebase made — an operator reversing our
    // transfer by hand in the Stripe dashboard.
    const reversalId = `trr_dashboard_${Date.now()}`;
    const object = {
      id: transferId, amount: FLAT_EARNINGS_CENTS, amount_reversed: FLAT_EARNINGS_CENTS,
      metadata: { bookingId, gigId, purpose: "earnings" },
      reversals: { data: [{ id: reversalId }] },
    };
    const evt = fakeEvent("transfer.reversed", object);
    expect((await postWebhook(evt)).status).toBe(200);

    const row = (await ledgerRows(bookingId)).find((r) => r.kind === "transfer_reversal");
    expect(row?.amountCents).toBe(FLAT_EARNINGS_CENTS);
    expect(row?.stripeId).toBe(reversalId);
    expect(row?.profileId).toBe(musician.profileId);
    expect(row?.gigId).toBe(gigId);

    // LEDGER ONLY: the payment doc is deliberately untouched — half-applying
    // someone else's decision (flipping the transfer while leaving the curator
    // charged) is worse than recording it and saying so.
    const after = await getPayment(bookingId, gigId);
    expect(after?.settlement.status).toBe("paid");
    expect(after?.transfer.status).toBe("transferred");

    // Same event id: the claim machine dedupes it before the handler runs.
    expect((await postWebhook(evt)).text).toBe("duplicate");
    // A FRESH event id carrying the same reversal DOES reach the handler — and
    // the deterministic ledger id collapses it into the row above.
    expect((await postWebhook(fakeEvent("transfer.reversed", object))).status).toBe(200);
    expect((await ledgerRows(bookingId)).filter((r) => r.kind === "transfer_reversal").length).toBe(1);
  });
});

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
  type BookingRequestDoc, type GigDoc, type LedgerEntry, type NotificationDoc,
  type PaymentDoc, type ProfileDraftInput, type StripeProfileDoc,
} from "@gatekeep/shared";
// The sweep drives steps 5/6; chargeSettlement is invoked DIRECTLY for the
// cases whose preconditions can't be produced through the app's own callables
// (a deposit slice larger than the date is worth). Same direct-invoke style as
// paymentsSweep.test.ts.
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { chargeSettlement } from "../src/paymentsCore.js";

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
      .toBe("charged");
    expect(await chargeSettlement({ bookingId: below.bookingId, gigId: below.gigId, now: Date.now() }))
      .toBe("charged");

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

import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  SETTLEMENT_DELAY_MS, SETTLEMENT_RETRY_OFFSETS_MS,
  type BookingRequestDoc, type GigDoc, type LedgerEntry, type NotificationDoc, type PaymentDoc,
  type ProfileDraftInput, type StripeProfileDoc,
} from "@gatekeep/shared";
// The sweep under test — invoked DIRECTLY with an injected clock, exactly like
// scheduled.test.ts drives runDailySweep: no scheduler emulator config, no
// wall-clock races, and the report is returned rather than logged.
import { runPaymentsSweep } from "../src/paymentsSweep.js";
// The materializer, whose birth-deposit staging is part of this task.
import { runDailySweep } from "../src/scheduled.js";
// Called directly (as bookingLifecycle.test.ts does) to produce a genuinely
// moderation-expired booking — the exact shape step 7 is the backstop for.
import { unwindBookingsForModeration } from "../src/bookingLifecycle.js";
import { buildPaymentDoc, currentFeePolicy } from "../src/paymentsCore.js";
// The test process has FIRESTORE_EMULATOR_HOST set, so this resolves to
// FakeStripe — the same instance the sweep itself gets.
import { getStripe } from "../src/stripeClient.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// 60s: every case here chains two approved profiles, makeMoneyReady, one or
// more createGig/publishGig pairs and a real accept BEFORE the sweep it
// actually asserts on — and two of them additionally run the whole daily
// sweep or four consecutive payments sweeps.
vi.setConfig({ testTimeout: 60_000 });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// perHour $150/hr over 90 minutes, the standard fixture across the SP5 suites:
// base 22500, deposit slice ceil(35%) = 7875, curator fee share ceil(11%) = 867.
const SLICE_CENTS = 7875;
const FEE_SHARE_CENTS = 867;
const CHARGE_CENTS = SLICE_CENTS + FEE_SHARE_CENTS;

// ---------- fixtures (mirroring payments.test.ts's, this suite's subject is
// the sweep, not profile/booking mechanics) ----------

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
    durationMinutes: 90,
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

function offerPayload(): Record<string, unknown> {
  return { amountCents: 15000, note: "Looking forward to it!" };
}

// A whole_run series. `recurrence` is passed WHOLE (all five fields) — same
// convention as every other series fixture in this repo. Callers MUST flip it
// to "ended" in a finally: the shared emulator's daily sweep scans active
// series, and a leftover one materializes into every later suite's world.
function seedSeries(curatorProfileId: string, recurrence?: Record<string, unknown>) {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode: "whole_run", status: "active",
    recurrence: recurrence ?? { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    template: {
      title: "Friday Night Jazz", description: "A cozy weekly set.",
      wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
      durationMinutes: 90,
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

async function getStripeDoc(profileId: string): Promise<StripeProfileDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;
}

async function curatorCustomerId(profileId: string): Promise<string> {
  const sp = await getStripeDoc(profileId);
  if (!sp?.customerId) throw new Error(`no customerId cached for curator profile ${profileId}`);
  return sp.customerId;
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

// FakeStripe's idempotency ledger — the honest way to assert WHICH key an
// attempt used (and, for a skipped retry, that no attempt happened at all).
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

// A real, fully confirmed single-gig booking (genuine applyToGig ->
// acceptBooking, so the deposit is genuinely charged and `held`).
// `pastStartHours` pushes the gig into the past BEFORE the accept — the only
// way to get a payment doc whose own occurrenceStartsAt is past, since that
// field is stamped at accept time.
async function makeConfirmedSingleBooking(prefix: string, opts: { pastStartHours?: number } = {}) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user);
  if (opts.pastStartHours != null) await setGigStartsAt(gigId, -opts.pastStartHours);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

// A confirmed whole-run booking with one occurrence per entry in
// `offsetsHours` (negative = already started). Callers MUST end the series.
async function makeConfirmedRun(prefix: string, offsetsHours: number[], recurrence?: Record<string, unknown>) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const series = await seedSeries(curator.profileId, recurrence);
  const gigIds: string[] = [];
  for (const hours of offsetsHours) {
    const gigId = await createOpenGig(curator.profileId, curator.owner.user,
      hours > 0 ? { startsAt: Date.now() + hours * HOUR_MS } : {});
    if (hours <= 0) await setGigStartsAt(gigId, hours);
    await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });
    gigIds.push(gigId);
  }
  const initiatingGigId = gigIds[offsetsHours.findIndex((h) => h > 0)];
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId: initiatingGigId, musicianProfileId: musician.profileId, offer: offerPayload() },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, series, gigIds, bookingId };
}

// Replicates the materializer's birth staging EXACTLY (same buildPaymentDoc
// call, same frozen terms off the booking) without paying for a whole daily
// sweep — used by the dunning cases, whose subject is the retry machinery, not
// the materializer. The materializer's own staging is covered end-to-end by
// the first test below.
async function seedBirthDeposit(bookingId: string, gigId: string, startsAt: number): Promise<void> {
  const booking = await getBooking(bookingId);
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).set(buildPaymentDoc({
    booking, bookingId,
    occ: { gigId, startsAt, durationMinutes: 90 },
    amountCents: booking.acceptedTerms!.amountCents,
    expectedQuantity: booking.acceptedTerms!.expectedQuantity,
    structure: booking.structure, feePolicy: booking.feePolicy ?? currentFeePolicy(),
    selfDeal: false, now: Date.now(),
  }));
}

// Replicates the accept saga's transaction A: the staged payment doc plus the
// crash marker, with NO charge and NO commit — i.e. exactly the state an
// instance that died mid-saga leaves behind. Written through the same
// buildPaymentDoc the real transaction uses, so the commit's baseCents
// re-derivation matches.
async function stageAcceptManually(bookingId: string, gigId: string, attempt = 1): Promise<void> {
  const booking = await getBooking(bookingId);
  const gig = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
  const last = booking.thread[booking.thread.length - 1];
  const feePolicy = currentFeePolicy();
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).set(buildPaymentDoc({
    booking, bookingId,
    occ: { gigId, startsAt: gig.startsAt, durationMinutes: gig.durationMinutes },
    amountCents: last.amountCents, expectedQuantity: last.expectedQuantity,
    structure: booking.structure, feePolicy, selfDeal: false, now: Date.now(),
  }));
  await adb.doc(`bookings/${bookingId}`).update({
    depositChargePending: true, depositChargeAttempt: attempt, depositChargeIntentId: null,
    feePolicy, updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------

describe("payments sweep — birth deposits (step 3)", () => {
  it("the materializer stages a born occurrence's deposit unpaid, and the sweep charges it on the attempt-0 key", async () => {
    // A recurrence whose first grid point is ~3 days out, capped by an endDate
    // one cadence step later so the materializer births EXACTLY one occurrence
    // (candidates are 7 days apart; a 7-day window can hold only one).
    const target = new Date(Date.now() + 3 * DAY_MS);
    const recurrence = {
      weekday: target.getUTCDay(), hour: target.getUTCHours(), minute: target.getUTCMinutes(),
      cadence: "weekly", endDate: Date.now() + 7 * DAY_MS,
    };
    const { curator, series, gigIds, bookingId } = await makeConfirmedRun("swbirth", [48], recurrence);
    try {
      expect((await getBooking(bookingId)).status).toBe("confirmed");

      await runDailySweep(Date.now());

      const born = (await adb.collection("gigs").where("seriesId", "==", series.id).get()).docs
        .filter((d) => !gigIds.includes(d.id));
      expect(born).toHaveLength(1);
      const bornGigId = born[0].id;
      const bornGig = born[0].data() as GigDoc;
      // Born already committed to this run — SP4 behavior, unchanged.
      expect(bornGig.status).toBe("filled");
      expect(bornGig.bookingId).toBe(bookingId);

      // ...and now owing its own deposit, staged but deliberately uncharged:
      // the materializer's write path is one batch, so no Stripe call happens
      // inside it.
      const staged = await getPayment(bookingId, bornGigId);
      expect(staged?.deposit.status).toBe("unpaid");
      expect(staged?.deposit.intentId).toBeNull();
      expect(staged?.deposit.sliceCents).toBe(SLICE_CENTS);
      expect(staged?.deposit.feeShareCents).toBe(FEE_SHARE_CENTS);
      expect(staged?.occurrenceStartsAt).toBe(bornGig.startsAt);
      expect(staged?.settlement.status).toBe("not_due");

      const report = await runPaymentsSweep(Date.now());
      expect(report.birthDepositsCharged).toBeGreaterThanOrEqual(1);

      const charged = await getPayment(bookingId, bornGigId);
      expect(charged?.deposit.status).toBe("held");
      expect(charged?.deposit.intentId).toBeTruthy();
      expect(charged?.deposit.chargeId).toBeTruthy();
      expect(typeof charged?.deposit.chargedAt).toBe("number");
      // The counter is persisted BEFORE the attempt it names, so a crash
      // mid-charge replays the same key rather than charging twice.
      expect(charged?.deposit.depositAttempts).toBe(0);
      expect(await idemUsed(`${bookingId}:${bornGigId}:deposit:0`)).toBe(true);

      // Its OWN intent, not the accept batch's, for exactly slice + fee share.
      const acceptDoc = await getPayment(bookingId, gigIds[0]);
      expect(charged?.deposit.intentId).not.toBe(acceptDoc?.deposit.intentId);
      expect(await fakeObject(charged!.deposit.intentId!).then((i) => i?.amountCents)).toBe(CHARGE_CENTS);

      const birthRow = (await ledgerRows(bookingId))
        .find((r) => r.kind === "deposit_charged" && r.gigId === bornGigId);
      expect(birthRow?.amountCents).toBe(CHARGE_CENTS);
      expect(birthRow?.profileId).toBe(curator.profileId);
      expect(birthRow?.detail).toBe("birth deposit (materialized occurrence)");

      // The booking aggregate followed the new escrow (two held deposits now).
      expect((await getBooking(bookingId)).paymentSummary?.heldCents).toBe(SLICE_CENTS * 2);
    } finally {
      await endSeriesQuietly(series.id);
    }
  });

  it("a declined birth deposit stays unpaid, backs off one day, is skipped before its retry is due, then succeeds on a FRESH key", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedSingleBooking("swdecl");
    const customerId = await curatorCustomerId(curator.profileId);
    const bornGigId = `swdeclborn${Date.now()}`;
    await seedBirthDeposit(bookingId, bornGigId, Date.now() + 14 * DAY_MS);

    try {
      await setChargeKnob("declineCustomerIds", customerId, true);
      const t0 = Date.now();
      const declineReport = await runPaymentsSweep(t0);
      expect(declineReport.birthDepositsDeclined).toBeGreaterThanOrEqual(1);

      const declined = await getPayment(bookingId, bornGigId);
      // A decline is NOT a state change — only the attempt counter and the
      // retry clock move.
      expect(declined?.deposit.status).toBe("unpaid");
      expect(declined?.deposit.intentId).toBeNull();
      expect(declined?.deposit.depositAttempts).toBe(1);
      expect(declined?.deposit.depositNextRetryAt).toBeGreaterThanOrEqual(t0 + SETTLEMENT_RETRY_OFFSETS_MS[0]);
      expect(declined?.deposit.depositNextRetryAt).toBeLessThan(t0 + SETTLEMENT_RETRY_OFFSETS_MS[0] + 60_000);
      // The accept's own held deposit is untouched by the birth-deposit step.
      expect((await getPayment(bookingId, gigId))?.deposit.status).toBe("held");

      // Before the retry is due: no attempt at all — not a second decline.
      await runPaymentsSweep(Date.now());
      expect((await getPayment(bookingId, bornGigId))?.deposit.depositAttempts).toBe(1);
      expect(await idemUsed(`${bookingId}:${bornGigId}:deposit:1`)).toBe(false);

      // Knob off, and the clock at the retry's due time. The retry MUST use a
      // different key: both real Stripe and the fake cache the decline under
      // the key that produced it, so an attempt-0 replay would decline forever
      // (as-built contract #2).
      await setChargeKnob("declineCustomerIds", customerId, false);
      const retryAt = (await getPayment(bookingId, bornGigId))!.deposit.depositNextRetryAt!;
      await runPaymentsSweep(retryAt);

      const held = await getPayment(bookingId, bornGigId);
      expect(held?.deposit.status).toBe("held");
      expect(held?.deposit.intentId).toBeTruthy();
      expect(held?.deposit.depositNextRetryAt).toBeNull();
      expect(await idemUsed(`${bookingId}:${bornGigId}:deposit:1`)).toBe(true);
      expect(await fakeObject(held!.deposit.intentId!).then((i) => i?.amountCents)).toBe(CHARGE_CENTS);
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }
  });

  it("dunning: once the retry schedule runs out the curator is flagged delinquent (and no late fee is charged on a deposit)", async () => {
    const { curator, musician, bookingId } = await makeConfirmedSingleBooking("swdun");
    const customerId = await curatorCustomerId(curator.profileId);
    const bornGigId = `swdunborn${Date.now()}`;
    await seedBirthDeposit(bookingId, bornGigId, Date.now() + 14 * DAY_MS);
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${bornGigId}`);

    try {
      await setChargeKnob("declineCustomerIds", customerId, true);

      // The initial attempt plus all three SETTLEMENT_RETRY_OFFSETS_MS retries.
      // Between runs the retry clock is pulled back rather than the sweep's
      // `now` pushed forward: `now` also drives the >24h staleness guards and
      // the settlement-scheduling window, and moving it days ahead would
      // silently change what the OTHER steps do to this fixture.
      for (let attempt = 0; attempt <= SETTLEMENT_RETRY_OFFSETS_MS.length; attempt++) {
        await runPaymentsSweep(Date.now());
        const after = await getPayment(bookingId, bornGigId);
        expect(after?.deposit.status).toBe("unpaid");
        expect(after?.deposit.depositAttempts).toBe(attempt + 1);
        if (after?.deposit.depositNextRetryAt != null) {
          await paymentRef.update({ "deposit.depositNextRetryAt": Date.now() - 1000 });
        }
      }

      const exhausted = await getPayment(bookingId, bornGigId);
      expect(exhausted?.deposit.depositAttempts).toBe(SETTLEMENT_RETRY_OFFSETS_MS.length + 1);
      expect(exhausted?.deposit.depositNextRetryAt).toBeNull();   // no further retry scheduled

      const sp = await getStripeDoc(curator.profileId);
      expect(sp?.delinquent).toBe(true);
      expect(typeof sp?.delinquentSince).toBe("number");
      // Late fees are a SETTLEMENT concept (spec §4) — a deposit never carries one.
      expect(exhausted?.settlement.lateFeeCents).toBeNull();
      expect(exhausted?.settlement.status).toBe("not_due");

      const curatorNotes = await notificationsFor(curator.owner.uid);
      expect(curatorNotes.some((n) => n.title === "Deposit payment failed")).toBe(true);
      const musicianNotes = await notificationsFor(musician.owner.uid);
      expect(musicianNotes.some((n) => n.title === "A deposit didn't go through")).toBe(true);

      // THE TERMINATOR (review round 1). Exhaustion clears depositNextRetryAt
      // to null, which a clock-only gate would read as "due now" — so this
      // doc would be re-charged on a fresh key every single hour, forever,
      // spamming both sides. One more sweep, and nothing may move.
      const curatorNoteCount = curatorNotes.length;
      const musicianNoteCount = musicianNotes.length;
      await runPaymentsSweep(Date.now());

      const stillExhausted = await getPayment(bookingId, bornGigId);
      expect(stillExhausted?.deposit.depositAttempts).toBe(SETTLEMENT_RETRY_OFFSETS_MS.length + 1);
      expect(await idemUsed(`${bookingId}:${bornGigId}:deposit:${SETTLEMENT_RETRY_OFFSETS_MS.length + 1}`)).toBe(false);
      expect((await notificationsFor(curator.owner.uid))).toHaveLength(curatorNoteCount);
      expect((await notificationsFor(musician.owner.uid))).toHaveLength(musicianNoteCount);
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }
  });

  it("a birth deposit left `processing` records its intent and is NEVER re-charged", async () => {
    const { curator, bookingId } = await makeConfirmedSingleBooking("swpend");
    const customerId = await curatorCustomerId(curator.profileId);
    const bornGigId = `swpendborn${Date.now()}`;
    await seedBirthDeposit(bookingId, bornGigId, Date.now() + 14 * DAY_MS);

    try {
      await setChargeKnob("pendingCustomerIds", customerId, true);
      const report = await runPaymentsSweep(Date.now());
      expect(report.birthDepositsPending).toBeGreaterThanOrEqual(1);

      const pending = await getPayment(bookingId, bornGigId);
      // Not a decline and not a success: the intent exists and is settling, so
      // the doc stays unpaid, the counter does NOT move (a decline is the only
      // thing that consumes a key), and the intent id is persisted as the
      // handle to whatever it becomes.
      expect(pending?.deposit.status).toBe("unpaid");
      expect(pending?.deposit.intentId).toBeTruthy();
      expect(pending?.deposit.depositAttempts).toBe(0);
      expect(pending?.deposit.chargedAt).toBeNull();
      const intentId = pending!.deposit.intentId!;
      expect(await fakeObject(intentId).then((i) => i?.status)).toBe("processing");

      // Knob off — a perfectly good card now. It must STILL not be charged:
      // the outstanding intent can still succeed, so a fresh-key charge would
      // be a genuine double charge.
      await setChargeKnob("pendingCustomerIds", customerId, false);
      await runPaymentsSweep(Date.now());

      const after = await getPayment(bookingId, bornGigId);
      expect(after?.deposit.status).toBe("unpaid");
      expect(after?.deposit.intentId).toBe(intentId);
      expect(after?.deposit.depositAttempts).toBe(0);
      expect(await idemUsed(`${bookingId}:${bornGigId}:deposit:1`)).toBe(false);
    } finally {
      await setChargeKnob("pendingCustomerIds", customerId, false);
    }
  });
});

describe("payments sweep — stuck *_pending deposits (step 2)", () => {
  it("resolves a fresh refund_pending doc and REFUSES one older than the 24h idempotency window", async () => {
    const fresh = await makeConfirmedSingleBooking("swpfresh");
    const stale = await makeConfirmedSingleBooking("swpstale");

    const freshPayment = (await getPayment(fresh.bookingId, fresh.gigId))!;
    const stalePayment = (await getPayment(stale.bookingId, stale.gigId))!;

    // The crash window Task 8 documents: the cancellation transaction wrote
    // the intent-to-move-money marker and the post-commit executor never ran.
    await adb.doc(`bookings/${fresh.bookingId}/payments/${fresh.gigId}`).update({
      "deposit.status": "refund_pending", "settlement.status": "waived", updatedAt: Date.now(),
    });
    await adb.doc(`bookings/${stale.bookingId}/payments/${stale.gigId}`).update({
      "deposit.status": "refund_pending", "settlement.status": "waived", updatedAt: Date.now() - 25 * HOUR_MS,
    });

    const report = await runPaymentsSweep(Date.now());
    expect(report.pendingResolved).toBeGreaterThanOrEqual(1);
    expect(report.pendingStale).toBeGreaterThanOrEqual(1);

    const resolved = await getPayment(fresh.bookingId, fresh.gigId);
    expect(resolved?.deposit.status).toBe("refunded");
    expect(typeof resolved?.deposit.resolvedAt).toBe("number");
    expect(await fakeObject(freshPayment.deposit.intentId!).then((i) => i?.refundedCents)).toBe(CHARGE_CENTS);

    // Past 24h the idempotency key is no longer a replay handle: re-issuing on
    // it would mint a SECOND refund. Left exactly as it was, for an operator.
    const untouched = await getPayment(stale.bookingId, stale.gigId);
    expect(untouched?.deposit.status).toBe("refund_pending");
    expect(untouched?.deposit.resolvedAt).toBeNull();
    expect(await fakeObject(stalePayment.deposit.intentId!).then((i) => i?.refundedCents)).toBe(0);
  });
});

describe("payments sweep — accept-saga reconciliation (step 1)", () => {
  it("completes a crashed saga by REPLAYING the original charge key — the same intent, never a second charge", async () => {
    const curator = await makeApprovedCuratorProfile("swrecc");
    const musician = await makeApprovedMusicianProfile("swrecm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await stageAcceptManually(bookingId, gigId, 1);
    // The charge landed, then the instance died before it could record the
    // outcome — the exact window DEPOSIT_RECONCILING_MESSAGE describes. Issued
    // here on the SAME key transaction A persisted.
    const original = await getStripe().chargeOffSession({
      customerId: await curatorCustomerId(curator.profileId), amountCents: CHARGE_CENTS,
      idempotencyKey: `${bookingId}:accept:deposit:1`, meta: { bookingId, purpose: "deposit" },
    });

    const report = await runPaymentsSweep(Date.now());
    expect(report.acceptSagasReconciled).toBeGreaterThanOrEqual(1);

    const booking = await getBooking(bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.depositChargePending).toBe(false);
    expect(booking.deposit?.status).toBe("held");

    const payment = await getPayment(bookingId, gigId);
    expect(payment?.deposit.status).toBe("held");
    // THE assertion: the replay adopted the original intent rather than
    // charging the curator a second time.
    expect(payment?.deposit.intentId).toBe(original.id);
    expect(await fakeObject(original.id).then((i) => i?.amountCents)).toBe(CHARGE_CENTS);

    // The gig is genuinely filled, and the post-commit tail ran.
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("filled");
    expect((await notificationsFor(musician.owner.uid)).some((n) => n.title.startsWith("Booking confirmed"))).toBe(true);
  });

  it("refuses to replay a saga staged more than 24h ago, leaving it staged and counted", async () => {
    const curator = await makeApprovedCuratorProfile("swstalec");
    const musician = await makeApprovedMusicianProfile("swstalem");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await stageAcceptManually(bookingId, gigId, 7);
    // `updatedAt` is the sweep's "first seen staged" proxy — every transition
    // into the staged state bumps it.
    await adb.doc(`bookings/${bookingId}`).update({ updatedAt: Date.now() - 25 * HOUR_MS });

    const report = await runPaymentsSweep(Date.now());
    expect(report.acceptSagasStale).toBeGreaterThanOrEqual(1);

    const booking = await getBooking(bookingId);
    expect(booking.status).toBe("open");
    expect(booking.depositChargePending).toBe(true);   // left for an operator, not silently released
    expect((await getPayment(bookingId, gigId))?.deposit.status).toBe("unpaid");
    // Nothing was charged: the expired key was never used.
    expect(await idemUsed(`${bookingId}:accept:deposit:7`)).toBe(false);
  });

  // The safety property behind commitAcceptAfterCharge's contract point 2 and
  // abortAcceptAfterFailedCommit's caller-beware note: the sweep must never
  // refund a deposit that belongs to a CONFIRMED accept.
  //
  // The genuine `racedOut` branch (a racer commits between the sweep's query
  // read and its post-commit re-read) is not deterministically seedable
  // without hooking the sweep mid-flight. What IS seedable — and is the same
  // hazard from the other end — is a confirmed booking still carrying the
  // marker, which step 1's very first guard rejects before it can charge or
  // refund anything.
  it("never touches a CONFIRMED booking's escrow: a stale saga marker on it is refused and surfaced, not reconciled", async () => {
    const { gigId, bookingId } = await makeConfirmedSingleBooking("swracer");
    const before = (await getPayment(bookingId, gigId))!;
    expect(before.deposit.status).toBe("held");

    // A lost write: the accept committed (the commit clears this flag in the
    // very same transaction that confirms), but the marker somehow survived.
    await adb.doc(`bookings/${bookingId}`).update({ depositChargePending: true });

    const report = await runPaymentsSweep(Date.now());
    expect(report.errors.reconcileStuckMarker ?? 0).toBeGreaterThanOrEqual(1);

    const after = await getBooking(bookingId);
    expect(after.status).toBe("confirmed");
    const payment = await getPayment(bookingId, gigId);
    expect(payment?.deposit.status).toBe("held");
    expect(payment?.deposit.intentId).toBe(before.deposit.intentId);
    // Not a cent moved, in either direction.
    expect(await fakeObject(before.deposit.intentId!).then((i) => i?.refundedCents)).toBe(0);
    expect((await ledgerRows(bookingId)).some((r) => r.kind === "refund")).toBe(false);
  });

  it("a saga whose accept can no longer commit is charged, re-read, then REFUNDED and unstaged", async () => {
    const curator = await makeApprovedCuratorProfile("swabortc");
    const musician = await makeApprovedMusicianProfile("swabortm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await stageAcceptManually(bookingId, gigId, 1);
    // The world moved under the staged saga: the gig closed, so transaction B
    // can never validate. The re-read confirms the booking is still open and
    // still pending — i.e. no racer committed — which is what makes the refund
    // safe (commitAcceptAfterCharge contract point 2).
    await adb.doc(`gigs/${gigId}`).update({ status: "closed" });

    const report = await runPaymentsSweep(Date.now());
    expect(report.acceptSagasAborted).toBeGreaterThanOrEqual(1);

    const booking = await getBooking(bookingId);
    expect(booking.status).toBe("open");
    expect(booking.depositChargePending).toBe(false);
    expect(await getPayment(bookingId, gigId)).toBeUndefined();   // staging removed

    const refundRow = (await ledgerRows(bookingId)).find((r) => r.kind === "refund");
    expect(refundRow?.amountCents).toBe(CHARGE_CENTS);
    expect(refundRow?.detail).toBe("accept abort — booking no longer confirmable");
    const chargeRow = (await ledgerRows(bookingId)).find((r) => r.kind === "deposit_charged");
    expect(await fakeObject(chargeRow!.stripeId!).then((i) => i?.refundedCents)).toBe(CHARGE_CENTS);
  });
});

describe("payments sweep — settlement scheduling (step 4)", () => {
  it("schedules a performed date, waives a reopened/taken-down/vanished one, and never touches an applied deposit", async () => {
    // One run, five dates: four already ended (each set up differently) and one
    // still in the future.
    const { curator, series, gigIds, bookingId } = await makeConfirmedRun("swsched", [-5, -6, -7, -8, 48]);
    const [performed, reopened, takenDown, appliedGig, future] = gigIds;
    try {
      const before = await getPayment(bookingId, performed);
      const batchIntentId = before!.deposit.intentId!;

      // Reopened: the date left this booking (cancelOccurrence's shape).
      await adb.doc(`gigs/${reopened}`).update({ status: "open", bookingId: null, bookedMusicianProfileId: null });
      // Taken down with the deposit never charged — the admin-takedown case
      // that must resolve WITHOUT a Stripe call.
      await adb.doc(`gigs/${takenDown}`).update({ status: "taken_down" });
      await adb.doc(`bookings/${bookingId}/payments/${takenDown}`).update({
        "deposit.status": "unpaid", "deposit.intentId": null, "deposit.chargeId": null, "deposit.chargedAt": null,
      });
      // An APPLIED deposit (escrow already consumed by a settlement) on a date
      // that then reopened: Task 12's clawback territory, never a refund here.
      await adb.doc(`gigs/${appliedGig}`).update({ status: "open", bookingId: null, bookedMusicianProfileId: null });
      await adb.doc(`bookings/${bookingId}/payments/${appliedGig}`).update({ "deposit.status": "applied" });

      const now = Date.now();
      const gig = (await adb.doc(`gigs/${performed}`).get()).data() as GigDoc;
      const gigEnd = gig.startsAt + gig.durationMinutes * 60_000;

      const report = await runPaymentsSweep(now);
      expect(report.settlementsScheduled).toBeGreaterThanOrEqual(1);
      expect(report.settlementsWaived).toBeGreaterThanOrEqual(3);

      // Performed: settlement opens, due T+3 after the gig ENDED (not started).
      const performedDoc = await getPayment(bookingId, performed);
      expect(performedDoc?.settlement.status).toBe("pending");
      expect(performedDoc?.settlement.settleAfter).toBe(gigEnd + SETTLEMENT_DELAY_MS);
      expect(performedDoc?.deposit.status).toBe("held");   // escrow stays put until settlement consumes it
      expect((await notificationsFor(curator.owner.uid)).some((n) => n.title.startsWith("Report actuals"))).toBe(true);

      // Reopened: waived, and the held deposit came back in full.
      const reopenedDoc = await getPayment(bookingId, reopened);
      expect(reopenedDoc?.settlement.status).toBe("waived");
      expect(reopenedDoc?.deposit.status).toBe("refunded");
      expect(typeof reopenedDoc?.deposit.resolvedAt).toBe("number");

      // Taken down + never charged: terminal with no money movement at all.
      const takenDownDoc = await getPayment(bookingId, takenDown);
      expect(takenDownDoc?.settlement.status).toBe("waived");
      expect(takenDownDoc?.deposit.status).toBe("refunded");
      expect(takenDownDoc?.deposit.intentId).toBeNull();

      // Exactly ONE refund landed against the shared accept intent — the
      // reopened date's. The never-charged date contributed nothing.
      expect(await fakeObject(batchIntentId).then((i) => i?.refundedCents)).toBe(CHARGE_CENTS);

      // Applied: settlement waived, deposit deliberately left alone.
      const appliedDoc = await getPayment(bookingId, appliedGig);
      expect(appliedDoc?.settlement.status).toBe("waived");
      expect(appliedDoc?.deposit.status).toBe("applied");

      // The future date is not due for anything yet.
      const futureDoc = await getPayment(bookingId, future);
      expect(futureDoc?.settlement.status).toBe("not_due");
      expect(futureDoc?.deposit.status).toBe("held");
    } finally {
      await endSeriesQuietly(series.id);
    }
  });
});

describe("payments sweep — expired-booking refund backstop (step 7)", () => {
  it("refunds a moderation-expired booking's FUTURE deposits and leaves its past-dated one held to settle", async () => {
    const { musician, series, gigIds, bookingId } = await makeConfirmedRun("swexp", [-5, 48]);
    const [pastGigId, futureGigId] = gigIds;
    try {
      expect((await getPayment(bookingId, pastGigId))?.deposit.status).toBe("held");
      expect((await getPayment(bookingId, futureGigId))?.deposit.status).toBe("held");

      // The moderation cascade: expires the booking and reopens the innocent
      // curator's FUTURE dates — and deliberately touches no money at all.
      await unwindBookingsForModeration({ profileId: musician.profileId });
      expect((await getBooking(bookingId)).status).toBe("expired");
      expect((await getPayment(bookingId, futureGigId))?.deposit.status).toBe("held");

      const report = await runPaymentsSweep(Date.now());
      expect(report.expiredRefunds).toBeGreaterThanOrEqual(1);

      // Future date: never happening, so the deposit goes back.
      const futureDoc = await getPayment(bookingId, futureGigId);
      expect(futureDoc?.deposit.status).toBe("refunded");
      expect(futureDoc?.settlement.status).toBe("waived");

      // PAST date: the musician may well have played that night. Its deposit
      // is NOT refunded by the backstop — it settles like any other performed
      // date (step 4 scheduled it in this same run, on settlement fields
      // alone, without caring that the booking is now "expired").
      const pastDoc = await getPayment(bookingId, pastGigId);
      expect(pastDoc?.deposit.status).toBe("held");
      expect(pastDoc?.settlement.status).toBe("pending");
    } finally {
      await endSeriesQuietly(series.id);
    }
  });
});

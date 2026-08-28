import { describe, it, expect } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { writeLedger, recomputePaymentSummary, currentFeePolicy, buildPaymentDoc } from "../src/paymentsCore.js";
import {
  CURATOR_FEE_PCT, MUSICIAN_FEE_PCT, INSTANT_FEE_PCT, LATE_FEE_PCT, LATE_FEE_MUSICIAN_PCT,
  type BookingRequestDoc, type FeePolicy, type PaymentDoc,
} from "@gatekeep/shared";

// Unit-style: calls writeLedger/recomputePaymentSummary directly against the
// Firestore emulator (no callable/HTTP layer involved) — these are internal
// helpers, not endpoints.
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

function basePaymentDoc(overrides: Partial<PaymentDoc> & { gigId: string }): PaymentDoc {
  const now = Date.now();
  return {
    bookingId: "b1", occurrenceStartsAt: now,
    curatorProfileId: "cur1", musicianProfileId: "mus1", selfDeal: false,
    baseCents: 10000,
    deposit: { sliceCents: 0, feeShareCents: 0, intentId: null, chargeId: null, status: "unpaid", chargedAt: null, resolvedAt: null, forfeitTransferId: null },
    settlement: {
      status: "not_due", settleAfter: null, computedCents: null, feeShareCents: null,
      trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
      lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
    },
    transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

// Minimal booking shell — buildPaymentDoc only reads the two profile ids off
// it; everything else about the money comes from its explicit params.
function seedBooking(overrides: Partial<BookingRequestDoc> = {}): BookingRequestDoc {
  const now = Date.now();
  return {
    gigId: "g1", seriesId: null, curatorProfileId: "cur1", musicianProfileId: "mus1",
    initiatedBy: "musician", structure: "perHour",
    thread: [], awaitingSide: "curator", status: "open",
    acceptedTerms: null, deposit: null, cancellation: null,
    createdAt: now, updatedAt: now, confirmedAt: null, resolvedAt: null,
    ...overrides,
  };
}

describe("currentFeePolicy", () => {
  it("snapshots all five live fee constants", () => {
    expect(currentFeePolicy()).toEqual({
      curatorFeePct: CURATOR_FEE_PCT, musicianFeePct: MUSICIAN_FEE_PCT,
      instantFeePct: INSTANT_FEE_PCT, lateFeePct: LATE_FEE_PCT, lateFeeMusicianPct: LATE_FEE_MUSICIAN_PCT,
    });
  });

  it("returns a fresh, mutable copy each call — never shared's frozen DEFAULT_FEE_POLICY by reference", () => {
    const a = currentFeePolicy();
    const b = currentFeePolicy();
    expect(a).not.toBe(b);
    // Frozen would mean a stray write on a warm Functions instance either
    // throws or (worse) corrupts resolveFeePolicy's fallback for every later
    // caller in that process.
    expect(Object.isFrozen(a)).toBe(false);
  });
});

describe("buildPaymentDoc", () => {
  const now = 1_700_000_000_000;
  const policy = currentFeePolicy();

  it("perHour: prices from the OCCURRENCE's own duration and fills every field at its zero state", () => {
    const doc = buildPaymentDoc({
      booking: seedBooking(), bookingId: "bk1",
      occ: { gigId: "gig90", startsAt: now + 86_400_000, durationMinutes: 90 },
      amountCents: 15000, expectedQuantity: 1.5, structure: "perHour",
      feePolicy: policy, selfDeal: false, now,
    });
    // 15000c/hr x 1.5h => 22500; slice ceil(22500 * 35%) = 7875;
    // fee ceil(7875 * 11%) = ceil(866.25) = 867.
    expect(doc).toEqual({
      bookingId: "bk1", gigId: "gig90", occurrenceStartsAt: now + 86_400_000,
      curatorProfileId: "cur1", musicianProfileId: "mus1", selfDeal: false,
      baseCents: 22500,
      deposit: {
        sliceCents: 7875, feeShareCents: 867, intentId: null, chargeId: null, status: "unpaid",
        chargedAt: null, resolvedAt: null, forfeitTransferId: null,
      },
      settlement: {
        status: "not_due", settleAfter: null, computedCents: null, feeShareCents: null,
        trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
        lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
      },
      transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
      createdAt: now, updatedAt: now,
    });
  });

  it("perHour: two occurrences of ONE booking price independently off their own durations", () => {
    const shared = {
      booking: seedBooking(), bookingId: "bk1", amountCents: 15000, expectedQuantity: 1.5,
      structure: "perHour" as const, feePolicy: policy, selfDeal: false, now,
    };
    const short = buildPaymentDoc({ ...shared, occ: { gigId: "a", startsAt: now, durationMinutes: 60 } });
    const long = buildPaymentDoc({ ...shared, occ: { gigId: "b", startsAt: now, durationMinutes: 120 } });
    expect(short.baseCents).toBe(15000);
    expect(short.deposit).toMatchObject({ sliceCents: 5250, feeShareCents: 578 });  // ceil(577.5)
    expect(long.baseCents).toBe(30000);
    expect(long.deposit).toMatchObject({ sliceCents: 10500, feeShareCents: 1155 });
  });

  it("perSong: prices from the frozen songCount, ignoring the occurrence's duration", () => {
    const doc = buildPaymentDoc({
      booking: seedBooking({ structure: "perSong" }), bookingId: "bk1",
      occ: { gigId: "g", startsAt: now, durationMinutes: 600 },   // deliberately huge — must not matter
      amountCents: 933, expectedQuantity: 7, structure: "perSong",
      feePolicy: policy, selfDeal: false, now,
    });
    // 933 x 7 = 6531; slice ceil(2285.85) = 2286; fee ceil(251.46) = 252.
    expect(doc.baseCents).toBe(6531);
    expect(doc.deposit.sliceCents).toBe(2286);
    expect(doc.deposit.feeShareCents).toBe(252);
  });

  it("perSet: the flat amount, ignoring both duration and quantity", () => {
    const doc = buildPaymentDoc({
      booking: seedBooking({ structure: "perSet" }), bookingId: "bk1",
      occ: { gigId: "g", startsAt: now, durationMinutes: 45 },
      amountCents: 12345, expectedQuantity: null, structure: "perSet",
      feePolicy: policy, selfDeal: false, now,
    });
    // slice ceil(12345 * 35%) = ceil(4320.75) = 4321; fee ceil(475.31) = 476.
    expect(doc.baseCents).toBe(12345);
    expect(doc.deposit.sliceCents).toBe(4321);
    expect(doc.deposit.feeShareCents).toBe(476);
  });

  it("the fee share comes from the PASSED policy snapshot, not the live constant", () => {
    // A booking accepted under an older/newer fee regime must keep paying its
    // own snapshot's rate — the whole reason feePolicy is frozen onto the
    // booking at accept.
    const doubled: FeePolicy = { ...policy, curatorFeePct: 22 };
    const doc = buildPaymentDoc({
      booking: seedBooking(), bookingId: "bk1",
      occ: { gigId: "g", startsAt: now, durationMinutes: 90 },
      amountCents: 15000, expectedQuantity: 1.5, structure: "perHour",
      feePolicy: doubled, selfDeal: false, now,
    });
    expect(doc.deposit.sliceCents).toBe(7875);
    expect(doc.deposit.feeShareCents).toBe(1733);   // ceil(7875 * 22%) = ceil(1732.5)
    expect(doc.deposit.feeShareCents).not.toBe(867);
  });

  it("carries selfDeal onto the occurrence doc", () => {
    const doc = buildPaymentDoc({
      booking: seedBooking(), bookingId: "bk1",
      occ: { gigId: "g", startsAt: now, durationMinutes: 90 },
      amountCents: 15000, expectedQuantity: 1.5, structure: "perHour",
      feePolicy: policy, selfDeal: true, now,
    });
    expect(doc.selfDeal).toBe(true);
  });
});

describe("recomputePaymentSummary", () => {
  it("aggregates held/paid/transferred across a held, an applied+paid+transferred, and a forfeited occurrence", async () => {
    const bookingId = `pcs-booking-${Date.now()}`;
    await adb.doc(`bookings/${bookingId}`).set({
      curatorProfileId: "cur1", musicianProfileId: "mus1", status: "accepted",
      createdAt: Date.now(), updatedAt: 1, // deliberately stale — recompute must NOT touch this
    });

    // Occurrence 1: deposit held, nothing else in flight.
    await adb.doc(`bookings/${bookingId}/payments/g1`).set(basePaymentDoc({
      gigId: "g1",
      deposit: { sliceCents: 1000, feeShareCents: 100, intentId: "pi_1", chargeId: "ch_fixture", status: "held", chargedAt: Date.now(), resolvedAt: null, forfeitTransferId: null },
    }));

    // Occurrence 2: deposit applied into settlement, settlement paid, transfer transferred.
    await adb.doc(`bookings/${bookingId}/payments/g2`).set(basePaymentDoc({
      gigId: "g2",
      deposit: { sliceCents: 1000, feeShareCents: 100, intentId: "pi_2", chargeId: "ch_fixture", status: "applied", chargedAt: Date.now(), resolvedAt: Date.now(), forfeitTransferId: null },
      settlement: {
        status: "paid", settleAfter: Date.now(), computedCents: 5000, feeShareCents: 500,
        trueUp: null, intentId: "pi_2s", attempts: 1, nextRetryAt: null,
        lateFeeCents: 0, lateFeeMusicianCents: 0, delinquentAt: null,
      },
      transfer: { status: "transferred", id: "tr_2", amountCents: 4400, transferredAt: Date.now() },
    }));

    // Occurrence 3: deposit forfeited — a forfeit IS a transfer to the musician.
    await adb.doc(`bookings/${bookingId}/payments/g3`).set(basePaymentDoc({
      gigId: "g3",
      deposit: { sliceCents: 2000, feeShareCents: 200, intentId: "pi_3", chargeId: "ch_fixture", status: "forfeited", chargedAt: Date.now(), resolvedAt: Date.now(), forfeitTransferId: "tr_3" },
    }));

    await recomputePaymentSummary(bookingId);

    const booking = await adb.doc(`bookings/${bookingId}`).get();
    const summary = booking.data()?.paymentSummary;
    // heldCents: ONLY occurrence 1's slice — "applied" and "forfeited" are no
    // longer live escrow, even though they're still "paid" below.
    expect(summary.heldCents).toBe(1000);
    // paidCents: (1000+100 held) + (1000+100 applied) + (5000+500+0 paid
    // settlement) + (2000+200 forfeited) = 1100 + 1100 + 5500 + 2200 = 9900.
    expect(summary.paidCents).toBe(9900);
    // transferredCents: 4400 (transfer.transferred) + 2000 (forfeited
    // deposit slice — counted as a transfer on top of transfer.status).
    expect(summary.transferredCents).toBe(6400);
    expect(summary.state).toBe("current");
    // updatedAt must be untouched by the recompute (only paymentSummary is
    // written) — still the deliberately stale seed value.
    expect(booking.data()?.updatedAt).toBe(1);
  });

  it("marks past_due and delinquent from settlement.status/delinquentAt, independent of a zero-cents lateFeeCents", async () => {
    const bookingId = `pcs-delinq-${Date.now()}`;
    await adb.doc(`bookings/${bookingId}`).set({ curatorProfileId: "c", musicianProfileId: "m", updatedAt: 1 });
    await adb.doc(`bookings/${bookingId}/payments/g1`).set(basePaymentDoc({
      gigId: "g1",
      settlement: {
        status: "past_due", settleAfter: Date.now(), computedCents: 5000, feeShareCents: 500,
        trueUp: null, intentId: null, attempts: 1, nextRetryAt: Date.now(),
        lateFeeCents: 0, lateFeeMusicianCents: 0, delinquentAt: Date.now(), // zero-cents late fee, but delinquentAt IS set
      },
    }));
    await recomputePaymentSummary(bookingId);
    const summary = (await adb.doc(`bookings/${bookingId}`).get()).data()?.paymentSummary;
    expect(summary.state).toBe("delinquent");
  });

  it("refund_pending and forfeit_pending contribute to paidCents only; refunded contributes nothing anywhere", async () => {
    const bookingId = `pcs-statuses-${Date.now()}`;
    await adb.doc(`bookings/${bookingId}`).set({ curatorProfileId: "c", musicianProfileId: "m", updatedAt: 1 });

    await adb.doc(`bookings/${bookingId}/payments/g1`).set(basePaymentDoc({
      gigId: "g1",
      deposit: { sliceCents: 1000, feeShareCents: 100, intentId: "pi_1", chargeId: "ch_fixture", status: "refund_pending", chargedAt: Date.now(), resolvedAt: null, forfeitTransferId: null },
    }));
    await adb.doc(`bookings/${bookingId}/payments/g2`).set(basePaymentDoc({
      gigId: "g2",
      deposit: { sliceCents: 2000, feeShareCents: 200, intentId: "pi_2", chargeId: "ch_fixture", status: "forfeit_pending", chargedAt: Date.now(), resolvedAt: null, forfeitTransferId: null },
    }));
    await adb.doc(`bookings/${bookingId}/payments/g3`).set(basePaymentDoc({
      gigId: "g3",
      deposit: { sliceCents: 3000, feeShareCents: 300, intentId: "pi_3", chargeId: "ch_fixture", status: "refunded", chargedAt: Date.now(), resolvedAt: Date.now(), forfeitTransferId: null },
    }));

    await recomputePaymentSummary(bookingId);
    const summary = (await adb.doc(`bookings/${bookingId}`).get()).data()?.paymentSummary;
    // heldCents: none of these three statuses is "held".
    expect(summary.heldCents).toBe(0);
    // paidCents: refund_pending (1000+100) + forfeit_pending (2000+200); refunded contributes 0.
    expect(summary.paidCents).toBe(3300);
    // transferredCents: 0 — only "forfeited" (not forfeit_pending) or
    // transfer.status === "transferred" ever contribute here.
    expect(summary.transferredCents).toBe(0);
  });
});

describe("writeLedger", () => {
  it("dedupes on the same kind+stripeId — a second write for the same underlying Stripe object doesn't create a second row", async () => {
    const stripeId = `pi_dedupe_${Date.now()}`;
    await writeLedger({ kind: "deposit_charged", amountCents: 500, bookingId: "b1", gigId: "g1", profileId: "cur1", stripeId, detail: "first" });
    await writeLedger({ kind: "deposit_charged", amountCents: 500, bookingId: "b1", gigId: "g1", profileId: "cur1", stripeId, detail: "second (should be suppressed)" });
    const rows = await adb.collection("ledger").where("stripeId", "==", stripeId).get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].data().detail).toBe("first");
  });

  it("writes a fresh random-id row (no dedupe) each time when stripeId is null", async () => {
    const detail = `no-stripe-id-${Date.now()}`;
    await writeLedger({ kind: "refund", amountCents: 100, bookingId: null, gigId: null, profileId: null, stripeId: null, detail });
    await writeLedger({ kind: "refund", amountCents: 100, bookingId: null, gigId: null, profileId: null, stripeId: null, detail });
    const rows = await adb.collection("ledger").where("detail", "==", detail).get();
    expect(rows.size).toBe(2);
  });
});

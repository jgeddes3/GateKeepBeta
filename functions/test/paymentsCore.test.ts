import { describe, it, expect } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { writeLedger, recomputePaymentSummary } from "../src/paymentsCore.js";
import type { PaymentDoc } from "@gatekeep/shared";

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
    deposit: { sliceCents: 0, feeShareCents: 0, intentId: null, status: "unpaid", chargedAt: null, resolvedAt: null, forfeitTransferId: null },
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
      deposit: { sliceCents: 1000, feeShareCents: 100, intentId: "pi_1", status: "held", chargedAt: Date.now(), resolvedAt: null, forfeitTransferId: null },
    }));

    // Occurrence 2: deposit applied into settlement, settlement paid, transfer transferred.
    await adb.doc(`bookings/${bookingId}/payments/g2`).set(basePaymentDoc({
      gigId: "g2",
      deposit: { sliceCents: 1000, feeShareCents: 100, intentId: "pi_2", status: "applied", chargedAt: Date.now(), resolvedAt: Date.now(), forfeitTransferId: null },
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
      deposit: { sliceCents: 2000, feeShareCents: 200, intentId: "pi_3", status: "forfeited", chargedAt: Date.now(), resolvedAt: Date.now(), forfeitTransferId: "tr_3" },
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

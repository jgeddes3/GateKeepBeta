/**
 * SP5c Task 7: per-order ticket settlement. `settleOneEvent`
 * (paymentsSweep.ts) now walks an event's still-pending "paid" orders one at
 * a time, transferring each order's own face value through
 * `distributeEarnings` under its own `ticket_settlement:{eventId}:{orderId}`
 * idempotency key, rather than summing every order into one event-wide
 * transfer. `eventsSettlement.test.ts` keeps the single-order-per-event
 * scenarios (still exercising this same code path); this file is the
 * multi-order behavior: independent per-order sourcing, a refused transfer
 * that does not complete the event, and resumption on the next pass settling
 * every order still pending.
 *
 * The transfer failure below is induced via FakeStripe's account-level
 * `failTransferAccountIds` knob (the same mechanism `eventsSettlement.test.ts`'s
 * own wedge-recovery tests use), never by corrupting an order's own
 * `chargeId`: FakeStripe caches any `"FakeStripe:"`-prefixed failure
 * (`isCacheableStripeError`, stripeClient.ts) under the call's idempotency
 * key together with a fingerprint of its params, so "corrupt the charge,
 * fail, restore the charge, retry" would permanently wedge THIS order's
 * static `ticket_settlement:{eventId}:{orderId}` key behind a
 * fingerprint-mismatch error instead of genuinely retrying, since that key
 * carries no attempt counter to mint a fresh one (Ruling E/F). A knob-driven
 * refusal, like a real transient Stripe error, is never cached and always
 * safe to retry on the exact same key once the condition clears.
 */
import { describe, it, expect, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { adb } from "./discoverFixtures";
import {
  makeDraftEvent, addTiersAndPublish, tierIdByName, makeBuyer, payOrder, makeCuratorPayoutReady,
  pushEventPastSettleWindow, ledgerRowsForEvent,
} from "./ticketFixtures";
import { runPaymentsSweep } from "../src/paymentsSweep.js";

vi.setConfig({ testTimeout: 20_000 });

// Same knob eventsSettlement.test.ts's own wedge-recovery describe block
// uses: a definite Stripe refusal (a `code`-bearing, non-"FakeStripe:"-
// prefixed error), never cached, always safe to retry on the same key.
async function setTransferKnob(accountId: string, on: boolean): Promise<void> {
  await adb.doc("stripeFake/config").set(
    { failTransferAccountIds: on ? FieldValue.arrayUnion(accountId) : FieldValue.arrayRemove(accountId) }, { merge: true });
}

describe("per-order ticket settlement", () => {
  it("settles each paid order with its own sourced transfer, skips free orders, and resumes every pending order after a transfer refusal", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ord1");
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user, [
      { name: "GA", priceCents: 2000, capacity: 50, saleStartsAt: null, saleEndsAt: null },
      { name: "Free", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null },
    ]);
    const ga = await tierIdByName(eventId, "GA"); const free = await tierIdByName(eventId, "Free");
    const a = await makeBuyer("ord1a"); const b = await makeBuyer("ord1b"); const c = await makeBuyer("ord1c");
    const orderA = await payOrder(eventId, ga, 2, a.user);
    const orderB = await payOrder(eventId, ga, 1, b.user);
    const orderF = await payOrder(eventId, free, 1, c.user);
    // completeOrderTx (ticketing.ts) stamps the order's own charge at
    // completion time; per-order settlement sources its transfer off it.
    expect((await adb.doc(`orders/${orderA}`).get()).data()?.chargeId).toMatch(/^ch/);
    expect((await adb.doc(`orders/${orderB}`).get()).data()?.chargeId).toMatch(/^ch/);

    await pushEventPastSettleWindow(eventId);

    // First pass: every transfer this curator account attempts refuses.
    // Orders settle oldest-first (paymentsSweep.ts sorts `pending` by
    // `createdAt`), so order A's transfer is the one that fails and the
    // pass returns without ever reaching orders B or F.
    let report;
    try {
      await setTransferKnob(accountId, true);
      report = await runPaymentsSweep(Date.now());
    } finally {
      await setTransferKnob(accountId, false);
    }
    expect(report.errors.ticketSettlementTransfer).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`orders/${orderA}`).get()).data()!.settledAt).toBeUndefined();
    expect((await adb.doc(`orders/${orderB}`).get()).data()!.settledAt).toBeUndefined();
    expect((await adb.doc(`events/${eventId}`).get()).data()!.status).toBe("published");

    // Second pass, refusal cleared: every still-pending order (A, B, and the
    // free order F) settles in this one pass, and the event completes.
    await runPaymentsSweep(Date.now());
    const ev = (await adb.doc(`events/${eventId}`).get()).data()!;
    expect(ev.status).toBe("completed");

    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows.map((r) => r.data().orderId).sort()).toEqual([orderA, orderB].sort());
    expect(rows.every((r) => r.data().sourced === true)).toBe(true);
    expect(rows.reduce((s, r) => s + (r.data().amountCents as number), 0)).toBe(6000);

    expect((await adb.doc(`orders/${orderF}`).get()).data()!.settlementLegs).toBe(0);
    const oa = (await adb.doc(`orders/${orderA}`).get()).data()!;
    expect(oa.settlementLegs).toBe(1);
    const ob = (await adb.doc(`orders/${orderB}`).get()).data()!;
    expect(ob.settlementLegs).toBe(1);
  });

  // Fix round 1 (Critical, migration): an event whose ONE event-wide
  // transfer already succeeded under the pre-Task-7 code, before this
  // deploy ever ran, is still "published" (its completion write never
  // landed) with `settlementStartedAt` set but no order stamped with its
  // own `settledAt` (that field did not exist yet). Recognised by the
  // legacy `ticket_settlement` ledger row (no `orderId`, the old code's own
  // shape): the sweep must stamp the order to match, WITHOUT attempting a
  // second transfer.
  it("recognises an event settled under the old per-event key and stamps its order without a second transfer", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("leg1");
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "GA", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const ga = await tierIdByName(eventId, "GA");
    const a = await makeBuyer("leg1a");
    const orderA = await payOrder(eventId, ga, 1, a.user);
    await pushEventPastSettleWindow(eventId);

    // Fabricate the legacy state: settlementStartedAt set (the old single
    // transfer succeeded), the order has NO settledAt, and a legacy
    // ticket_settlement ledger row with no orderId.
    await adb.doc(`events/${eventId}`).update({ settlementStartedAt: Date.now(), settlementClaimedAt: Date.now() });
    await adb.collection("ledger").doc("legacy-ticket-settlement-row").set({
      kind: "ticket_settlement", amountCents: 1000, bookingId: null, gigId: null,
      profileId, stripeId: "tr_legacy_fake", detail: "legacy ticket settlement (pre Task 7)",
      eventId, buyerUid: null, at: Date.now(),
    });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketSettlementsCompleted).toBeGreaterThanOrEqual(1);

    const ev = (await adb.doc(`events/${eventId}`).get()).data()!;
    expect(ev.status).toBe("completed");

    const oa = (await adb.doc(`orders/${orderA}`).get()).data()!;
    expect(oa.settledAt).toBeTypeOf("number");
    expect(oa.settlementLegs).toBe(1);
    expect(oa.settlementProfileCents).toBe(1000);

    // No second transfer: the curator's fake connected-account balance never
    // moved for this pass (the legacy transfer this test fabricates was
    // never itself credited to the fake account, so 0 is the correct proof
    // that nothing moved just now).
    const acct = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acct?.balanceCents ?? 0).toBe(0);

    // Still exactly the one legacy row: no new per-order row was written.
    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("legacy-ticket-settlement-row");
  });

  // Fix round 1 (Important 5): the genuine idempotent-replay case, distinct
  // from the legacy-migration test above (that one's ledger row carries no
  // orderId; this order's own row does, so the sweep must NOT treat this as
  // a legacy event, it must replay the SAME per-order transfer).
  it("replays cleanly after a crash between a successful transfer and its settledAt stamp", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rep1");
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "GA", priceCents: 1500, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const ga = await tierIdByName(eventId, "GA");
    const a = await makeBuyer("rep1a");
    const orderA = await payOrder(eventId, ga, 1, a.user);
    await pushEventPastSettleWindow(eventId);

    await runPaymentsSweep(Date.now());
    const afterFirst = (await adb.doc(`events/${eventId}`).get()).data()!;
    expect(afterFirst.status).toBe("completed");
    const acctAfterFirst = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acctAfterFirst?.balanceCents).toBe(1500);

    // Simulate the crash window: the transfer succeeded and the ledger row
    // landed, but the order's own settledAt stamp (and the event's own
    // completion) never made it, by hand-reverting both.
    await adb.doc(`orders/${orderA}`).update({ settledAt: FieldValue.delete() });
    await adb.doc(`events/${eventId}`).update({ status: "published" });

    const report = await runPaymentsSweep(Date.now());
    expect(report.errors.ticketSettlementTransfer ?? 0).toBe(0);

    const afterRetry = (await adb.doc(`events/${eventId}`).get()).data()!;
    expect(afterRetry.status).toBe("completed");
    // Unchanged: the SAME per-order idempotency key replayed the SAME
    // transfer instead of minting a second one.
    const acctAfterRetry = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acctAfterRetry?.balanceCents).toBe(1500);

    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    const orderRows = rows.filter((r) => r.data().orderId === orderA);
    expect(orderRows).toHaveLength(1);
  });
});

/**
 * SP6 events/ticketing Task 5: the ticket checkout engine, the money-critical
 * core of this sub-project. Owns:
 *  - createTicketOrder: reserves inventory and mints a pending order, then
 *    (for a paid order) a PaymentIntent the buyer confirms client-side;
 *  - finalizeTicketOrder: a synchronous, buyer-facing confirm-then-verify
 *    callable, so the client does not have to wait on the webhook;
 *  - completeOrderTx: the one idempotent completion transaction all three
 *    completion paths (the free-order inline path, finalizeTicketOrder, and
 *    the payment_intent.succeeded webhook) funnel through;
 *  - completeOrderTicketsHandler: the webhook registration for
 *    metadata.purpose === "tickets", wired into paymentsWebhook.ts's
 *    registry there (not here, per that file's own registration style for
 *    this task).
 *
 * Money invariants mirrored from SP5 (see paymentsCore.ts, paymentsSweep.ts):
 *  - all money writes are server-only, amounts are integer cents;
 *  - fee math ONLY via ticketOrderTotals/ticketServiceFeeCents and the
 *    currentTicketFeePolicy() snapshot, taken once at order creation and
 *    stamped onto the order so a later policy change never touches it;
 *  - completeOrderTx is idempotent: it only transitions an order out of
 *    "pending"; any other status is a silent no-op;
 *  - inventory (a tier's soldCount) only ever moves inside a transaction: a
 *    pending order holds its reservation, and the expiry sweep (see
 *    paymentsSweep.ts) releases it exactly once, and never after money has
 *    actually moved (see that step's "money always wins over expiry" note).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  isValidDocId, ticketOrderTotals,
  EVENT_NOT_ON_SALE_MESSAGE, EVENT_SALE_CLOSED_MESSAGE, EVENT_SOLD_OUT_MESSAGE, EVENT_BUYER_CAP_MESSAGE,
  type EventDoc, type TicketTierDoc, type TicketOrderDoc, type TicketOrderStatus,
  type TicketIndexDoc, type TicketDoc, type AttendeeDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { ORDER_TTL_MS, mintQrSecret, currentTicketFeePolicy, tierOnSale, buildOrderItems } from "./eventsCore.js";
import { getStripe, stripeSecretKey } from "./stripeClient.js";
import { writeLedger } from "./paymentsCore.js";
import { notifyUser } from "./notifications.js";

const MAX_ORDER_ITEMS = 20;

export interface CreateTicketOrderInput {
  eventId: string; items: Array<{ tierId: string; quantity: number }>;
}
// clientSecret is null for a free order, which completeOrderTx has already
// run inline by the time this returns (see Task 5 brief's ruling: this shape
// is what Tasks 9/11's clients branch on).
export interface CreateTicketOrderResult { orderId: string; clientSecret: string | null; }

export const createTicketOrder = onCall<CreateTicketOrderInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<CreateTicketOrderResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, items: reqItems } = req.data ?? ({} as CreateTicketOrderInput);
    if (!isValidDocId(eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (!Array.isArray(reqItems) || reqItems.length < 1 || reqItems.length > MAX_ORDER_ITEMS) {
      throw new HttpsError("invalid-argument", "At least one ticket tier is required.");
    }
    // Defensive-runtime shape check BEFORE any tierId is used to build a
    // Firestore doc path (an untrusted onCall payload, not a trusted param
    // type; same rationale as every other isValidDocId gate in this codebase,
    // e.g. eventsCore.ts's own validators).
    for (const it of reqItems) {
      const tierId = (it as { tierId?: unknown } | null)?.tierId;
      if (typeof tierId !== "string" || !isValidDocId(tierId)) {
        throw new HttpsError("invalid-argument", "Invalid ticket tier.");
      }
    }

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    if (event.status !== "published" || event.startsAt <= Date.now()) {
      throw new HttpsError("failed-precondition", EVENT_NOT_ON_SALE_MESSAGE);
    }

    const now = Date.now();
    const orderRef = db.collection("orders").doc();
    const uniqueTierIds = [...new Set(reqItems.map((it) => it.tierId))];
    const tierRefs = uniqueTierIds.map((id) => eventRef.collection("tiers").doc(id));
    const ticketIndexRef = db.doc(`users/${uid}/ticketIndex/${eventId}`);
    // Cap-laundering guard: a buyer opening several PENDING orders for the
    // same event in parallel (multiple tabs/devices, each individually under
    // the cap) must not be able to jointly exceed maxTicketsPerBuyer just
    // because none of them has paid yet. ticketIndex.count alone only counts
    // tickets already MINTED, so it is blind to reservations still in
    // flight; this query closes that gap. Bounded by the buyer's own pending
    // orders for ONE event, which is small.
    const pendingOrdersQuery = db.collection("orders")
      .where("buyerUid", "==", uid).where("eventId", "==", eventId).where("status", "==", "pending");

    let faceTotalCents = 0;
    let serviceFeeCents = 0;

    await db.runTransaction(async (tx) => {
      const [tierSnaps, ticketIndexSnap, pendingOrdersSnap] = await Promise.all([
        Promise.all(tierRefs.map((ref) => tx.get(ref))), tx.get(ticketIndexRef), tx.get(pendingOrdersQuery),
      ]);
      const tiers = new Map<string, TicketTierDoc>();
      tierSnaps.forEach((snap) => { if (snap.exists) tiers.set(snap.id, snap.data() as TicketTierDoc); });

      // buildOrderItems validates quantity shape/range, duplicate tiers, and
      // (via the map lookup) that every requested tier actually exists.
      const items = buildOrderItems(tiers, reqItems);

      for (const item of items) {
        const tier = tiers.get(item.tierId)!;
        if (!tierOnSale(tier, now)) {
          throw new HttpsError("failed-precondition", EVENT_SALE_CLOSED_MESSAGE);
        }
        if (tier.soldCount + item.quantity > tier.capacity) {
          throw new HttpsError("failed-precondition", EVENT_SOLD_OUT_MESSAGE);
        }
      }

      const totalQty = items.reduce((sum, it) => sum + it.quantity, 0);
      const heldCount = (ticketIndexSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
      const pendingQty = pendingOrdersSnap.docs.reduce((sum, d) => {
        const o = d.data() as TicketOrderDoc;
        return sum + o.items.reduce((s, it) => s + it.quantity, 0);
      }, 0);
      if (heldCount + pendingQty + totalQty > event.maxTicketsPerBuyer) {
        throw new HttpsError("failed-precondition", EVENT_BUYER_CAP_MESSAGE);
      }

      for (const item of items) {
        tx.update(eventRef.collection("tiers").doc(item.tierId), { soldCount: FieldValue.increment(item.quantity) });
      }

      const feePolicy = currentTicketFeePolicy();
      const totals = ticketOrderTotals(items, feePolicy);
      faceTotalCents = totals.faceTotalCents;
      serviceFeeCents = totals.serviceFeeCents;

      const order: TicketOrderDoc = {
        buyerUid: uid, eventId, curatorProfileId: event.curatorProfileId,
        items, faceTotalCents: totals.faceTotalCents, serviceFeeCents: totals.serviceFeeCents,
        feePolicy, paymentIntentId: null, status: "pending",
        refundedTicketIds: [], refundedCents: 0, refundedFaceCents: 0,
        createdAt: now, expiresAt: now + ORDER_TTL_MS,
      };
      tx.set(orderRef, order);
    });

    // Stripe calls never run inside a Firestore transaction (SP5 invariant,
    // see paymentsCore.ts's claimStripeId). A free order (every line item
    // priced at 0) never needs one at all: complete it inline right here and
    // hand back a null clientSecret so the caller knows there is nothing left
    // to confirm.
    if (faceTotalCents + serviceFeeCents === 0) {
      await completeOrderTx(orderRef.id);
      return { orderId: orderRef.id, clientSecret: null };
    }

    const intent = await getStripe().createIntent({
      amountCents: faceTotalCents + serviceFeeCents,
      idempotencyKey: `tickets:${orderRef.id}`,
      meta: { purpose: "tickets", orderId: orderRef.id },
    });
    await orderRef.update({ paymentIntentId: intent.id });
    return { orderId: orderRef.id, clientSecret: intent.clientSecret };
  });

export interface FinalizeTicketOrderInput { orderId: string; }
export interface FinalizeTicketOrderResult { orderStatus: TicketOrderStatus; }

// Buyer-only, synchronous confirm-then-verify: called right after the
// client's own Elements confirmation succeeds, so the buyer sees their order
// complete without waiting on the payment_intent.succeeded webhook. NEVER
// trusts the client's own claim of success: it retrieves the PaymentIntent's
// status from Stripe itself before treating the order as paid. The webhook
// remains the backstop for a client that never calls back (dropped
// connection, closed tab): completeOrderTx is the same idempotent
// transaction either way, so whichever path gets there first wins and the
// other is a silent no-op.
export const finalizeTicketOrder = onCall<FinalizeTicketOrderInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<FinalizeTicketOrderResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { orderId } = req.data ?? ({} as FinalizeTicketOrderInput);
    if (!isValidDocId(orderId)) throw new HttpsError("invalid-argument", "An order id is required.");

    const db = getFirestore();
    const orderRef = db.doc(`orders/${orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnap.data() as TicketOrderDoc;
    if (order.buyerUid !== uid) throw new HttpsError("permission-denied", "This order does not belong to you.");

    // Already resolved (paid by a racing webhook call, expired, or refunded)
    // one way or another: nothing left for this call to verify.
    if (order.status !== "pending") return { orderStatus: order.status };
    // A free order never reaches "pending" without also being completed
    // inline by createTicketOrder, so this is a defensive branch only: no
    // PaymentIntent to retrieve means there is nothing to verify yet.
    if (!order.paymentIntentId) return { orderStatus: order.status };

    const { status } = await getStripe().retrieveIntentStatus(order.paymentIntentId);
    if (status === "succeeded") {
      await completeOrderTx(orderId);
      return { orderStatus: "paid" };
    }
    return { orderStatus: "pending" };
  });

// The one idempotent completion transaction. Callable directly (the free-
// order inline path in createTicketOrder above), from finalizeTicketOrder,
// and from completeOrderTicketsHandler below (the payment_intent.succeeded
// webhook): all three race-safe against each other because this only ever
// transitions an order OUT of "pending"; anything else already reflects a
// prior (or concurrent, now-committed) completion and is a silent no-op.
export async function completeOrderTx(orderId: string): Promise<void> {
  const db = getFirestore();
  const orderRef = db.doc(`orders/${orderId}`);

  const completed = await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return null;
    const order = orderSnap.data() as TicketOrderDoc;
    if (order.status !== "pending") return null; // idempotent no-op

    const [buyerSnap, eventSnap] = await Promise.all([
      tx.get(db.doc(`users/${order.buyerUid}`)), tx.get(db.doc(`events/${order.eventId}`)),
    ]);
    const ownerName = (buyerSnap.data() as { displayName?: string } | undefined)?.displayName ?? "Guest";
    const eventTitle = (eventSnap.data() as EventDoc | undefined)?.title ?? "the event";

    const now = Date.now();
    let totalQty = 0;
    for (const item of order.items) {
      for (let i = 0; i < item.quantity; i++) {
        const ticketRef = db.collection(`users/${order.buyerUid}/tickets`).doc();
        const ticket: TicketDoc = {
          eventId: order.eventId, tierId: item.tierId, tierName: item.tierName, orderId,
          curatorProfileId: order.curatorProfileId, qrSecret: mintQrSecret(), status: "valid", createdAt: now,
        };
        tx.set(ticketRef, ticket);
        const attendee: AttendeeDoc = {
          ownerUid: order.buyerUid, ownerName, tierId: item.tierId, tierName: item.tierName, status: "valid",
        };
        tx.set(db.doc(`events/${order.eventId}/attendees/${ticketRef.id}`), attendee);
        totalQty += 1;
      }
    }

    // Blind increment (create-if-missing via merge) rather than a prior read:
    // FieldValue.increment on a missing doc/field starts from zero, so the
    // buyer's very first ticket for this event needs no extra read here.
    tx.set(db.doc(`users/${order.buyerUid}/ticketIndex/${order.eventId}`),
      { count: FieldValue.increment(totalQty) }, { merge: true });
    tx.update(orderRef, { status: "paid", paidAt: now });

    return { order, eventTitle, totalQty };
  });

  if (!completed) return;
  const { order, eventTitle, totalQty } = completed;
  const totalCents = order.faceTotalCents + order.serviceFeeCents;

  // Post-commit, best-effort tails: the money (or the free grant) already
  // moved by the time these run, matching every other SP5/SP6 ledger and
  // notification write. stripeId is the orderId itself (not the
  // PaymentIntent id, which is null for a free order): every completed order
  // gets exactly one row regardless of whether it was paid or free.
  await writeLedger({
    kind: "ticket_sale", amountCents: totalCents, bookingId: null, gigId: null,
    profileId: order.curatorProfileId, stripeId: orderId,
    detail: `${totalQty} ticket(s) for "${eventTitle}"`,
    eventId: order.eventId, buyerUid: order.buyerUid,
  }).catch((e) => console.error(`completeOrderTx: ledger write failed for order ${orderId}`, e));

  await notifyUser(order.buyerUid, {
    kind: "ticket", refId: order.eventId, title: "Tickets confirmed",
    body: `Your ${totalQty} ticket(s) for "${eventTitle}" are ready.`,
  }).catch((e) => console.error(`completeOrderTx: notification failed for order ${orderId}`, e));
}

// Registered from paymentsWebhook.ts (that file's registry, not this one, so
// this module never needs to import it back). Reads metadata.orderId off the
// succeeded PaymentIntent; a missing/invalid one is logged and dropped rather
// than thrown, matching every other SP5 purpose handler's contract, so a
// malformed delivery still lets stripeWebhook mark the event processed
// instead of retrying forever.
export async function completeOrderTicketsHandler(
  object: Record<string, unknown>, eventId: string,
): Promise<void> {
  const orderId = (object.metadata as Record<string, string> | undefined)?.orderId;
  if (!orderId || !isValidDocId(orderId)) {
    console.warn(
      `completeOrderTicketsHandler: missing or invalid metadata.orderId on intent ${String(object.id)} (event ${eventId})`);
    return;
  }
  await completeOrderTx(orderId);
}

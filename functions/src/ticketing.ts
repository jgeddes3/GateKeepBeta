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
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  isValidDocId, ticketOrderTotals, ticketServiceFeeCents,
  EVENT_NOT_ON_SALE_MESSAGE, EVENT_SALE_CLOSED_MESSAGE, EVENT_SOLD_OUT_MESSAGE, EVENT_BUYER_CAP_MESSAGE,
  EVENT_CANCELLED_MESSAGE, TICKET_NOT_REFUNDABLE_MESSAGE, TICKET_REFUND_WINDOW_CLOSED_MESSAGE,
  TICKET_NOT_VALID_MESSAGE, TICKET_ALREADY_CHECKED_IN_MESSAGE, TRANSFER_OFFER_SENT_MESSAGE,
  CHECK_IN_OPENS_BEFORE_MS, CHECK_IN_TOO_EARLY_MESSAGE,
  PENDING_ORDERS_PER_USER_CAP, PENDING_ORDERS_CAP_MESSAGE,
  type EventDoc, type TicketTierDoc, type TicketOrderDoc, type TicketOrderStatus,
  type TicketIndexDoc, type TicketDoc, type TicketStatus, type AttendeeDoc, type TicketTransferDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireApprovedCuratorProfile } from "./guards.js";
import {
  ORDER_TTL_MS, TRANSFER_TTL_MS, mintQrSecret, currentTicketFeePolicy, tierOnSale, buildOrderItems,
} from "./eventsCore.js";
import { getStripe, stripeSecretKey } from "./stripeClient.js";
import { writeLedger, recordAdminAlert } from "./paymentsCore.js";
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
    // SP10 Task 10: the curator must still be approved. Closes the window
    // between a reject-from-approved and its cascade (and any event the
    // cascade missed): the public event page may still render, but nothing
    // sells. One get per invocation; same message the client already keys on.
    const curatorSnap = await db.doc(`profiles/${event.curatorProfileId}`).get();
    if (curatorSnap.data()?.status !== "approved") {
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
    // SP10 Task 21 (sp6 #15): a buyer may hold at most PENDING_ORDERS_PER_USER_CAP
    // unpaid reservations across ALL events. Equality-only query, served by
    // merged single-field indexes; limit() keeps the transactional read tiny.
    const allPendingQuery = db.collection("orders")
      .where("buyerUid", "==", uid).where("status", "==", "pending").limit(PENDING_ORDERS_PER_USER_CAP);

    let faceTotalCents = 0;
    let serviceFeeCents = 0;

    await db.runTransaction(async (tx) => {
      const [tierSnaps, ticketIndexSnap, pendingOrdersSnap, allPendingSnap] = await Promise.all([
        Promise.all(tierRefs.map((ref) => tx.get(ref))), tx.get(ticketIndexRef), tx.get(pendingOrdersQuery),
        tx.get(allPendingQuery),
      ]);
      if (allPendingSnap.size >= PENDING_ORDERS_PER_USER_CAP) {
        throw new HttpsError("resource-exhausted", PENDING_ORDERS_CAP_MESSAGE);
      }
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

    // SP10 Task 21 (sp6 #7): the account email is verified (requireVerifiedEmail
    // above), so it is safe to hand Stripe as the receipt address.
    const receiptEmail = typeof req.auth?.token?.email === "string" ? req.auth.token.email : undefined;
    const intent = await getStripe().createIntent({
      amountCents: faceTotalCents + serviceFeeCents,
      idempotencyKey: `tickets:${orderRef.id}`,
      meta: { purpose: "tickets", orderId: orderRef.id },
      receiptEmail,
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

/**
 * SP6 Task 6: cancellation and refunds.
 *
 * Two money paths land here:
 *  - refundOrdersForCancelledEvent: the batch that events.ts's `cancelEvent`
 *    callable runs right after flipping an event to "cancelled" (and that
 *    paymentsSweep.ts's retry step re-drives for any event that still has
 *    unresolved orders). Refunds every "paid" order in full and expires
 *    every still-"pending" one, releasing its inventory hold; money always
 *    wins over expiry, same as the Task 5 expiry sweep step this pending-
 *    order path deliberately mirrors.
 *  - refundTicket: the curator-triggered single-ticket "grace" refund, which
 *    never touches the order's status.
 *
 * Both follow the SP5 invariant every money file in this codebase repeats:
 * Stripe calls never run inside a Firestore transaction (a transaction can be
 * silently retried by the SDK on contention, which would replay the Stripe
 * call too), so each does its Stripe call OUTSIDE any transaction, then
 * applies every resulting Firestore write together in ONE transaction.
 */

// The adminAlerts id for "this order was not resolved for its cancelled
// event" (see AdminAlertKind's ticket_cancel_refund_failed). One id per
// order, scoped to this file the same way ticketing's own doc-id disciplines
// are: the caller does not need to know this string, only
// refundOrdersForCancelledEvent's own retry-safety.
function ticketCancelAlertId(orderId: string): string {
  return `ticket-cancel:${orderId}`;
}

// Task 8 fix round 1 (security review): the adminAlerts id for "a grace
// refund's Stripe money moved but the live descendant of a raced-transferred
// ticket could not be automatically torn down to match it" (see
// AdminAlertKind's ticket_refund_convergence_failed). One id per ORIGINAL
// ticket id (the one the caller actually asked to refund), scoped to this
// file the same way ticketCancelAlertId above is.
function ticketRefundConvergenceAlertId(ticketId: string): string {
  return `ticket-refund-converge:${ticketId}`;
}

// The buyer-facing cancellation notification body, shared by every order
// this batch touches (a paid order, and a $0 one alike). `reason`, when the
// curator gave one on cancelEvent's own input, is folded in here: this is
// the one place it actually reaches a person, since EventDoc carries no
// persisted cancel-reason field for anything else to read it back from.
function cancellationNotificationBody(eventTitle: string, reason: string | undefined, refunded: boolean): string {
  const reasonClause = reason ? `: ${reason}` : "";
  const refundClause = refunded ? " Your payment has been refunded." : "";
  return `"${eventTitle}" was cancelled${reasonClause}.${refundClause}`;
}

// Task 8: the body for a CURRENT owner of a TRANSFERRED ticket. They hold no
// stake in the order's money (that always returns to the order's own buyer,
// notified separately via cancellationNotificationBody above) but still need
// to know their live ticket for this event is dead, so this deliberately
// never mentions a refund.
function transferredTicketCancellationBody(eventTitle: string, reason: string | undefined): string {
  const reasonClause = reason ? `: ${reason}` : "";
  return `"${eventTitle}" was cancelled${reasonClause}. Your ticket has been cancelled.`;
}

// Refunds ONE "paid" order's full remaining balance (face + service fee,
// minus whatever a prior grace refund already returned) as part of an event
// cancellation. Idempotent: only acts on an order still "paid". A doc
// already "cancelled_refunded" (a prior pass, or this exact call replayed
// after a crash) is a silent no-op, matching completeOrderTx's own
// "transitions OUT of one state" discipline. Safe to re-run freely: the
// Stripe call carries a deterministic per-order idempotency key, so a retry
// that reaches Stripe again (because a prior pass's Firestore transaction
// never committed) replays the SAME refund rather than issuing a second one.
//
// No two-phase "refund_pending" marker (unlike SP5's deposit refunds): the
// event is ALREADY flipped to "cancelled" by the time this runs (cancelEvent
// flips status before calling this, and the sweep only ever calls this for
// an event already "cancelled"), and refundTicket refuses on a cancelled
// event, so nothing else can be racing this order's tickets/index/tier
// fields, and a single Firestore transaction after the Stripe call is
// sufficient.
async function refundOrderForCancelledEvent(
  db: Firestore, orderRef: FirebaseFirestore.DocumentReference, eventTitle: string, now: number,
  reason: string | undefined,
): Promise<"refunded" | "skipped"> {
  const orderSnap = await orderRef.get();
  const order = orderSnap.data() as TicketOrderDoc | undefined;
  if (!order || order.status !== "paid") return "skipped";

  const remainingCents = order.faceTotalCents + order.serviceFeeCents - order.refundedCents;
  const remainingFaceCents = order.faceTotalCents - order.refundedFaceCents;

  // A "paid" order with a positive remaining balance always carries a
  // PaymentIntent. The only way remainingCents can be 0 with nothing left
  // to refund is a free order, or one already grace-refunded down to zero.
  if (remainingCents > 0 && order.paymentIntentId) {
    await getStripe().refund({
      intentId: order.paymentIntentId, amountCents: remainingCents,
      idempotencyKey: `ticket_cancel_refund:${orderRef.id}`,
      meta: { orderId: orderRef.id, eventId: order.eventId, purpose: "ticket_cancel_refund" },
    });
  }

  // Non-transactional read of this order's tickets, safe because nothing
  // else can be writing to them right now (see this function's doc comment):
  // the event is already "cancelled", which blocks refundTicket AND (Task 8)
  // offerTransfer/respondToTransfer's own published-event checks, so no
  // other path mutates ticket status while this runs.
  //
  // COLLECTION-GROUP, not the order's buyer's own subcollection (Task 8,
  // carried cross-task requirement): a ticket transferred away from the
  // buyer now lives under its RECIPIENT's uid (respondToTransfer mints a
  // fresh ticket doc there), not the buyer's. Every doc this order ever
  // minted still carries THIS order's id regardless of which uid it lives
  // under today, so filtering on `orderId` alone finds the buyer's own
  // remaining tickets AND every ticket transferred out of this order, in one
  // query. See firestore.indexes.json's `tickets`/`orderId` fieldOverride:
  // a collection-group query needs its own index even for a lone equality
  // filter.
  const ticketsSnap = await db.collectionGroup("tickets").where("orderId", "==", orderRef.id).get();
  const refundable = ticketsSnap.docs
    .map((d) => {
      const ownerRef = d.ref.parent.parent; // users/{ownerUid}/tickets/{ticketId} -> users/{ownerUid}
      return ownerRef ? { ticketId: d.id, ownerUid: ownerRef.id, status: (d.data() as TicketDoc).status } : null;
    })
    .filter((t): t is { ticketId: string; ownerUid: string; status: TicketStatus } => t !== null)
    .filter((t) => t.status === "valid" || t.status === "checked_in");

  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(orderRef);
    const fresh = freshSnap.data() as TicketOrderDoc | undefined;
    if (!fresh || fresh.status !== "paid") return; // raced/idempotent no-op

    // Grouped by CURRENT owner: a transferred ticket's teardown (status flip,
    // attendee mirror, ticketIndex decrement) always keys off whoever holds
    // it today, never the order's buyer. Only the MONEY (the Stripe refund
    // above, and the buyerUid this function's ledger/notification below
    // name) stays pinned to the buyer.
    const byOwner = new Map<string, string[]>();
    for (const t of refundable) {
      const list = byOwner.get(t.ownerUid) ?? [];
      list.push(t.ticketId);
      byOwner.set(t.ownerUid, list);
    }
    const owners = [...byOwner.keys()];
    const idxSnaps = await Promise.all(
      owners.map((ownerUid) => tx.get(db.doc(`users/${ownerUid}/ticketIndex/${order.eventId}`))));

    owners.forEach((ownerUid, i) => {
      const ticketIds = byOwner.get(ownerUid)!;
      for (const ticketId of ticketIds) {
        tx.update(db.doc(`users/${ownerUid}/tickets/${ticketId}`), { status: "refunded" });
        tx.update(db.doc(`events/${order.eventId}/attendees/${ticketId}`), { status: "refunded" });
      }
      const idxRef = db.doc(`users/${ownerUid}/ticketIndex/${order.eventId}`);
      const idxCount = (idxSnaps[i].data() as TicketIndexDoc | undefined)?.count ?? 0;
      const remainingIdx = idxCount - ticketIds.length;
      if (remainingIdx <= 0) tx.delete(idxRef); else tx.update(idxRef, { count: remainingIdx });
    });

    const refundableTicketIds = refundable.map((t) => t.ticketId);
    tx.update(orderRef, {
      status: "cancelled_refunded",
      // FieldValue.arrayUnion() called with ZERO elements throws synchronously
      // (the Admin SDK requires >= 1 argument), reachable whenever every
      // ticket on this order was already grace-refunded before the event was
      // cancelled (refundableTicketIds is then empty). Without this guard the
      // spread call above would throw on every single attempt, the order
      // would never reach "cancelled_refunded", and this order would wedge
      // permanently: the sweep's retry step (step 9) would keep finding it
      // "paid" and keep re-throwing, alarming forever without converging.
      // The status flip and the cents increments below must still happen
      // unconditionally either way. remainingCents/remainingFaceCents can be
      // 0 here (nothing left to refund), which is exactly the converging
      // no-op case this order needs to reach.
      ...(refundableTicketIds.length > 0
        ? { refundedTicketIds: FieldValue.arrayUnion(...refundableTicketIds) } : {}),
      refundedCents: FieldValue.increment(remainingCents),
      refundedFaceCents: FieldValue.increment(remainingFaceCents),
    });
  });

  await writeLedger({
    kind: "ticket_cancel_refund", amountCents: remainingCents, bookingId: null, gigId: null,
    profileId: order.curatorProfileId, stripeId: orderRef.id,
    detail: `event cancelled, refunded remaining balance for "${eventTitle}"`,
    eventId: order.eventId, buyerUid: order.buyerUid, at: now,
  }).catch((e) => console.error(`refundOrderForCancelledEvent: ledger write failed for order ${orderRef.id}`, e));

  // The BUYER (money): always notified, whether or not they still hold any
  // of this order's tickets themselves.
  await notifyUser(order.buyerUid, {
    kind: "ticket", refId: order.eventId, title: "Event cancelled",
    body: cancellationNotificationBody(eventTitle, reason, remainingCents > 0),
  }).catch((e) => console.error(`refundOrderForCancelledEvent: notification failed for order ${orderRef.id}`, e));

  // Every OTHER current owner (Task 8: a transfer recipient) whose live
  // ticket this pass just tore down, distinct from the buyer above so a
  // buyer who still holds some of their own tickets is never notified twice.
  const otherOwners = new Set(refundable.map((t) => t.ownerUid).filter((ownerUid) => ownerUid !== order.buyerUid));
  for (const ownerUid of otherOwners) {
    await notifyUser(ownerUid, {
      kind: "ticket", refId: order.eventId, title: "Event cancelled",
      body: transferredTicketCancellationBody(eventTitle, reason),
    }).catch((e) => console.error(`refundOrderForCancelledEvent: transferred-owner notification failed for order ${orderRef.id}, owner ${ownerUid}`, e));
  }

  return "refunded";
}

// Cancels ONE "pending" order's PaymentIntent (if any) and releases its
// held tier inventory, landing the order in `finalStatus`. Reuses the SP6
// Task 5 expiry sweep's money-wins pattern (paymentsSweep.ts's
// expireOneTicketOrder) rather than importing it: that step is keyed off
// expiresAt and carries its own report counters. SP10 Task 21 lifted this
// out of cancelPendingOrderForCancelledEvent so the buyer's own
// cancelTicketOrder shares exactly one release transaction.
//
// "deferred" means the intent could not be confirmed cancelable (most
// commonly: it already succeeded, money moved); the order is left pending
// for finalizeTicketOrder / the webhook / refundOrderForCancelledEvent.
async function releasePendingOrder(
  db: Firestore, orderRef: FirebaseFirestore.DocumentReference, finalStatus: "expired" | "cancelled",
): Promise<"released" | "deferred" | "skipped"> {
  const freshSnap = await orderRef.get();
  const order = freshSnap.data() as TicketOrderDoc | undefined;
  if (!order || order.status !== "pending") return "skipped"; // resolved since the caller's read

  if (order.paymentIntentId) {
    try {
      await getStripe().cancelIntent(order.paymentIntentId);
    } catch (e) {
      // Ambiguous throw (cancelIntent's own doc comment): either the intent
      // already succeeded, or it was already canceled by a prior pass whose
      // Firestore transaction below never committed. Only the second case
      // is safe to proceed on.
      let status: string | undefined;
      try {
        status = (await getStripe().retrieveIntentStatus(order.paymentIntentId)).status;
      } catch (statusError) {
        console.error(
          `releasePendingOrder: could not confirm intent ${order.paymentIntentId}'s status after a failed cancel for order ${orderRef.id}`, statusError);
      }
      if (status !== "canceled") {
        console.info(
          `releasePendingOrder: order ${orderRef.id} left pending, intent ${order.paymentIntentId} could not be confirmed cancelable (status=${status ?? "unknown"})`, e);
        return "deferred";
      }
    }
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    const o = snap.data() as TicketOrderDoc | undefined;
    if (!o || o.status !== "pending") return; // raced since the fresh read above
    for (const item of o.items) {
      tx.update(db.doc(`events/${o.eventId}/tiers/${item.tierId}`), { soldCount: FieldValue.increment(-item.quantity) });
    }
    tx.update(orderRef, { status: finalStatus });
  });
  return "released";
}

async function cancelPendingOrderForCancelledEvent(
  db: Firestore, orderRef: FirebaseFirestore.DocumentReference,
): Promise<"expired" | "deferred" | "skipped"> {
  const outcome = await releasePendingOrder(db, orderRef, "expired");
  return outcome === "released" ? "expired" : outcome;
}

const ORDER_ALREADY_PAID_MESSAGE = "This order has already been paid. Check your tickets.";

export interface CancelTicketOrderInput { orderId: string; }
export interface CancelTicketOrderResult { orderStatus: TicketOrderStatus; }

// SP10 Task 21 (sp6 #2): the buyer's own release. A dismissed PaymentSheet or
// a web Cancel used to leave a 10 to 70 minute hold the fan could not undo,
// which read as "Sold out" to them for their own seats. Pending only; a
// resolved order just echoes its status (the client can call this freely
// from any cancel path). Nothing here refunds: a pending order has never
// been charged, and an intent that turns out to have succeeded is left for
// finalizeTicketOrder, with a message that says so.
export const cancelTicketOrder = onCall<CancelTicketOrderInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<CancelTicketOrderResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { orderId } = req.data ?? ({} as CancelTicketOrderInput);
    if (!isValidDocId(orderId)) throw new HttpsError("invalid-argument", "An order id is required.");

    const db = getFirestore();
    const orderRef = db.doc(`orders/${orderId}`);
    const order = (await orderRef.get()).data() as TicketOrderDoc | undefined;
    // Same not-found for "no such order" and "someone else's order": an order
    // id must never be an oracle for another buyer's activity.
    if (!order || order.buyerUid !== uid) throw new HttpsError("not-found", "Order not found.");
    if (order.status !== "pending") return { orderStatus: order.status };

    const outcome = await releasePendingOrder(db, orderRef, "cancelled");
    if (outcome === "deferred") throw new HttpsError("failed-precondition", ORDER_ALREADY_PAID_MESSAGE);
    const fresh = (await orderRef.get()).data() as TicketOrderDoc;
    return { orderStatus: fresh.status };
  });

export interface CancelledEventOrdersResult {
  ordersRefunded: number; pendingExpired: number; pendingDeferred: number; errors: number;
}

// The whole batch: every "paid" order refunded in full, every "pending" one
// expired. Called once by events.ts's `cancelEvent` right after it flips the
// event to "cancelled" (with the curator's own cancellation `reason`, if
// they gave one), and again by paymentsSweep.ts's retry step for any event
// that still has unresolved orders (with no `reason`: EventDoc does not
// persist one, so a retry pass has nothing to pass along). Same idempotent
// function either way, per the brief's "batched loop, not one transaction"
// ruling (each order resolves independently, so one failure never wedges
// the rest of the loop).
export async function refundOrdersForCancelledEvent(
  eventId: string, eventTitle: string, now: number, reason?: string,
): Promise<CancelledEventOrdersResult> {
  const db = getFirestore();
  const result: CancelledEventOrdersResult = { ordersRefunded: 0, pendingExpired: 0, pendingDeferred: 0, errors: 0 };

  const paidSnap = await db.collection("orders")
    .where("eventId", "==", eventId).where("status", "==", "paid").get();
  for (const doc of paidSnap.docs) {
    try {
      const outcome = await refundOrderForCancelledEvent(db, doc.ref, eventTitle, now, reason);
      if (outcome === "refunded") result.ordersRefunded++;
    } catch (e) {
      result.errors++;
      const alertId = ticketCancelAlertId(doc.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "ticket_cancel_refund_failed",
        detail: `event ${eventId} ("${eventTitle}") cancelled but order ${doc.id} could not be refunded: ${e instanceof Error ? e.message : String(e)}`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) {
        console.error(`refundOrdersForCancelledEvent: order ${doc.id} refund failed (see adminAlerts/${alertId})`, e);
      }
    }
  }

  const pendingSnap = await db.collection("orders")
    .where("eventId", "==", eventId).where("status", "==", "pending").get();
  for (const doc of pendingSnap.docs) {
    try {
      const outcome = await cancelPendingOrderForCancelledEvent(db, doc.ref);
      if (outcome === "expired") result.pendingExpired++;
      else if (outcome === "deferred") result.pendingDeferred++;
    } catch (e) {
      result.errors++;
      const alertId = ticketCancelAlertId(doc.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "ticket_cancel_refund_failed",
        detail: `event ${eventId} ("${eventTitle}") cancelled but pending order ${doc.id} could not be expired: ${e instanceof Error ? e.message : String(e)}`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) {
        console.error(`refundOrdersForCancelledEvent: pending order ${doc.id} expiry failed (see adminAlerts/${alertId})`, e);
      }
    }
  }

  return result;
}

export interface RefundTicketInput { curatorProfileId: string; eventId: string; ticketId: string; }

// Curator-triggered single-ticket "grace" refund: refunds ONE ticket's
// face+fee off its order's shared PaymentIntent without touching the order's
// own status (it stays "paid", see TicketOrderDoc.refundedTicketIds/
// refundedCents/refundedFaceCents, which every refund path, this one and
// cancellation, maintains the same way).
//
// The ticket OWNER, read off events/{eventId}/attendees/{ticketId}.ownerUid
// (NOT the order's buyerUid), keys the ticketIndex decrement, the attendee
// projection, and the notification: a transferred ticket's live doc lives
// under its CURRENT owner's users/{uid}/tickets subcollection, and that
// projection is exactly what tracks the current owner (see completeOrderTx,
// which writes both docs under the same id). The money, by contrast, always
// returns to the ORDER's buyer, the person who actually paid Stripe.
//
// REFUSED once `now >= event.endsAt` (Task 7 fix round 1, money review
// Critical 1). Product rationale: a grace refund is for a pre-show change of
// plans; a post-show dispute is a manual/support path, not this callable.
// Load-bearing for money, not just policy: paymentsSweep.ts's T+1 ticket
// settlement sums each paid order's `faceTotalCents - refundedFaceCents` and
// transfers it to the curator under a STATIC per-event idempotency key. If a
// grace refund could still land after endsAt, a transfer that crashed after
// Stripe accepted it but before the completion write landed would recompute
// a SMALLER amount on retry, and replaying that key with a different amount
// is refused by Stripe forever. Freezing refunds a full T+1 window (24h)
// before any transfer can even become due removes the drift at its source
// instead of trying to re-scope the key around it.
//
// Fix round 1 (security review, Important, silent money drift): a transfer
// accept can race BETWEEN this callable's Stripe refund call and its books-
// resolution transaction (both used to run back to back with nothing in
// between). Closed in two layers, belt and braces, matching this codebase's
// money-converges discipline (see paymentsSweep.ts's own "money always wins"
// rule):
//  1. PREVENTION, right here, right before the Stripe call: a transaction
//     re-verifies the ticket is still valid/checked_in and VOIDS any open
//     transfer offer for it, so no PRE-EXISTING offer can be accepted once
//     this refund is committed to happening.
//  2. CONVERGENCE, in `applyTicketRefund` below: if a BRAND-NEW offer+accept
//     still slips into the (much narrower) window spanning the Stripe call
//     itself, the books-resolution transaction finds the ticket "transferred"
//     instead of "valid"/"checked_in" and follows it to the CURRENT live
//     descendant to tear down instead, never a silent { ok: true } with
//     Stripe money moved and nothing in the books to show for it.
const TICKET_OFFER_WITHDRAWN_MESSAGE_BODY = (tierName: string) =>
  `The "${tierName}" ticket you were offered was refunded by the organizer and is no longer available.`;
const TICKET_REFUND_CONVERGENCE_FAILED_MESSAGE =
  "This refund could not be completed automatically and has been flagged for review.";

export const refundTicket = onCall<RefundTicketInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.curatorProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile id is required.");
    }
    if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (!isValidDocId(input?.ticketId)) throw new HttpsError("invalid-argument", "A ticket id is required.");

    await requireProfileMember(input.curatorProfileId, uid);
    await requireApprovedCuratorProfile(input.curatorProfileId);

    const db = getFirestore();
    const eventRef = db.doc(`events/${input.eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    if (event.curatorProfileId !== input.curatorProfileId) {
      throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
    }
    if (event.status === "cancelled") throw new HttpsError("failed-precondition", EVENT_CANCELLED_MESSAGE);
    if (Date.now() >= event.endsAt) {
      throw new HttpsError("failed-precondition", TICKET_REFUND_WINDOW_CLOSED_MESSAGE);
    }

    const attendeeRef = eventRef.collection("attendees").doc(input.ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const attendee = attendeeSnap.data() as AttendeeDoc;
    const ownerUid = attendee.ownerUid;

    const ticketRef = db.doc(`users/${ownerUid}/tickets/${input.ticketId}`);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const ticket = ticketSnap.data() as TicketDoc;
    if (ticket.eventId !== input.eventId || ticket.curatorProfileId !== input.curatorProfileId) {
      throw new HttpsError("not-found", "Ticket not found.");
    }
    if (ticket.status !== "valid" && ticket.status !== "checked_in") {
      throw new HttpsError("failed-precondition", TICKET_NOT_REFUNDABLE_MESSAGE);
    }

    const orderRef = db.doc(`orders/${ticket.orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new HttpsError("internal", "This ticket's order could not be found.");
    const order = orderSnap.data() as TicketOrderDoc;
    const item = order.items.find((it) => it.tierId === ticket.tierId);
    if (!item) throw new HttpsError("internal", "This ticket's order line item could not be found.");

    const unitPriceCents = item.unitPriceCents;
    // SP10 Task 6 fix round 2 (Important 2): a lost dispute can already have
    // reversed part or all of this order's face value (paymentsDisputes.ts's
    // reverseForLostDispute), leaving less curator revenue on the order than
    // this ticket's own face value to give back a second time. A FREE tier
    // (unitPriceCents 0) has nothing to give back either way and must stay
    // refundable regardless of the order's remaining face (fix round 1's
    // `<= 0` check wrongly refused every free ticket, since a fully-paid
    // order's remaining face is also 0).
    if (unitPriceCents > 0 && order.faceTotalCents - order.refundedFaceCents < unitPriceCents) {
      throw new HttpsError("failed-precondition", TICKET_NOT_REFUNDABLE_MESSAGE);
    }
    const feeCents = ticketServiceFeeCents(unitPriceCents, order.feePolicy);
    const amountCents = unitPriceCents + feeCents;

    // Layer 1, PREVENTION (see this callable's own header comment): fresh
    // transactional re-verification, immediately before the Stripe call, and
    // an atomic void of any open offer in the SAME transaction. A voided
    // offer notifies its would-be recipient only AFTER this commits (never
    // inside the transaction itself).
    const voidedOffers = await db.runTransaction(async (tx) => {
      const openOffersQuery = db.collection("transfers")
        .where("ticketId", "==", input.ticketId).where("status", "==", "offered");
      const [tSnap, offersSnap] = await Promise.all([tx.get(ticketRef), tx.get(openOffersQuery)]);
      const t = tSnap.data() as TicketDoc | undefined;
      if (!t || (t.status !== "valid" && t.status !== "checked_in")) {
        throw new HttpsError("failed-precondition", TICKET_NOT_REFUNDABLE_MESSAGE);
      }
      const now = Date.now();
      const voided: Array<{ transferId: string; toUid: string }> = [];
      for (const doc of offersSnap.docs) {
        const transfer = doc.data() as TicketTransferDoc;
        tx.update(doc.ref, { status: "voided", resolvedAt: now });
        voided.push({ transferId: doc.id, toUid: transfer.toUid });
      }
      return voided;
    });

    for (const v of voidedOffers) {
      await notifyUser(v.toUid, {
        kind: "ticket", refId: input.eventId, title: "Ticket offer withdrawn",
        body: TICKET_OFFER_WITHDRAWN_MESSAGE_BODY(item.tierName),
      }).catch((e) => console.error(`refundTicket: voided-offer notification failed for transfer ${v.transferId}`, e));
    }

    if (amountCents > 0) {
      await getStripe().refund({
        intentId: order.paymentIntentId!, amountCents,
        idempotencyKey: `ticket_grace_refund:${input.ticketId}`,
        meta: { orderId: ticket.orderId, ticketId: input.ticketId, eventId: input.eventId, purpose: "ticket_grace_refund" },
      });
    }

    // Layer 2, CONVERGENCE: see applyTicketRefund's own header comment.
    // Throws (never a silent { ok: true }) if Stripe money moved and the
    // books could not be made to match it.
    await applyTicketRefund({
      eventId: input.eventId, ticketId: input.ticketId, ownerUid, tierId: ticket.tierId, tierName: item.tierName,
      curatorProfileId: input.curatorProfileId, orderId: ticket.orderId, buyerUid: order.buyerUid,
      amountCents, unitPriceCents,
    });

    return { ok: true };
  });

export interface ApplyTicketRefundParams {
  eventId: string; ticketId: string; ownerUid: string; tierId: string; tierName: string;
  curatorProfileId: string; orderId: string; buyerUid: string;
  amountCents: number; unitPriceCents: number;
}

type ApplyTicketRefundOutcome =
  | { kind: "applied" }
  | { kind: "converged"; ownerUid: string; ticketId: string }
  | { kind: "noop" }
  | { kind: "convergeFailed"; reason: string };

// The post-Stripe books resolution refundTicket calls once its Stripe
// refund has succeeded. Split out into its own exported function, same
// discipline as completeOrderTx/cancelEventCore/refundOrdersForCancelledEvent
// above in this file, so fix round 1's residual race window (a BRAND-NEW
// transfer offer+accept slipping in between refundTicket's own pre-phase
// transaction and this one, completing while the Stripe call itself is in
// flight) can be exercised directly by tests without fighting real network
// timing (the emulator's Functions process is a separate sandbox a test
// cannot reach into to pause mid-call).
//
// `ticketRef` (`users/{ownerUid}/tickets/{ticketId}`) is fixed on the
// ORIGINAL ticket doc the caller named; that doc is NEVER deleted by a
// transfer (only its sibling attendee doc is), so a fresh read of it always
// reflects the truth regardless of how the race played out. Three shapes:
//  - "valid"/"checked_in": the ordinary path, unchanged from before this fix
//    round: flips straight to "refunded".
//  - "transferred": the raced case. `t.transferredTo` names the CURRENT
//    owner; their live ("valid") descendant ticket sharing this order id is
//    found and torn down INSTEAD of the original doc, which is left exactly
//    as it is (still "transferred"). Deliberately narrower than
//    refundTicket's own "valid or checked_in" refundability rule: a
//    descendant already "checked_in" is NOT auto-torn-down here, since the
//    attendee already walked in on it, and an automatic yank of an in-use
//    seat is a judgment call for a human, not this function (see the
//    "convergeFailed" branch).
//  - anything else: an idempotent no-op for an already-"refunded" doc
//    (a racer/retry already resolved this exact ticket, unchanged from
//    before this fix round) or an ESCALATED, THROWN failure when the
//    "transferred" branch's descendant is missing, already refunded,
//    already checked in, or ambiguous. Stripe money already moved and
//    nothing in the books moved to match it, which must never be swallowed
//    into a silent { ok: true }.
export async function applyTicketRefund(params: ApplyTicketRefundParams): Promise<void> {
  const db = getFirestore();
  const eventRef = db.doc(`events/${params.eventId}`);
  const ticketRef = db.doc(`users/${params.ownerUid}/tickets/${params.ticketId}`);
  const orderRef = db.doc(`orders/${params.orderId}`);
  const tierRef = eventRef.collection("tiers").doc(params.tierId);

  const outcome = await db.runTransaction<ApplyTicketRefundOutcome>(async (tx) => {
    const tSnap = await tx.get(ticketRef);
    const t = tSnap.data() as TicketDoc | undefined;
    if (!t) return { kind: "noop" };

    if (t.status === "valid" || t.status === "checked_in") {
      const idxRef = db.doc(`users/${params.ownerUid}/ticketIndex/${params.eventId}`);
      const attendeeRef = eventRef.collection("attendees").doc(params.ticketId);
      const [tierSnap, idxSnap] = await Promise.all([tx.get(tierRef), tx.get(idxRef)]);
      tx.update(ticketRef, { status: "refunded" });
      tx.update(attendeeRef, { status: "refunded" });
      if (tierSnap.exists) tx.update(tierRef, { soldCount: FieldValue.increment(-1) });
      const idxCount = (idxSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
      if (idxCount <= 1) tx.delete(idxRef); else tx.update(idxRef, { count: idxCount - 1 });
      tx.update(orderRef, {
        refundedTicketIds: FieldValue.arrayUnion(params.ticketId),
        refundedCents: FieldValue.increment(params.amountCents),
        refundedFaceCents: FieldValue.increment(params.unitPriceCents),
      });
      return { kind: "applied" };
    }

    if (t.status === "transferred") {
      const currentOwnerUid = t.transferredTo;
      if (!currentOwnerUid) {
        return { kind: "convergeFailed", reason: "transferred with no transferredTo recorded" };
      }
      const liveSnap = await tx.get(
        db.collection(`users/${currentOwnerUid}/tickets`).where("orderId", "==", params.orderId));
      const descendants = liveSnap.docs.map((d) => ({ doc: d, status: (d.data() as TicketDoc).status }));
      // A "refunded" descendant means this exact convergence already ran
      // (an earlier pass, or a crash-recovery retry) and already tore it
      // down: idempotent no-op, mirroring the direct path's own "already
      // refunded" branch below, checked BEFORE the ambiguity guard so a
      // retry after a successful converge never mistakes "nothing left
      // valid" for a failure.
      if (descendants.some((d) => d.status === "refunded")) return { kind: "noop" };
      const liveDocs = descendants.filter((d) => d.status === "valid").map((d) => d.doc);
      if (liveDocs.length !== 1) {
        return {
          kind: "convergeFailed",
          reason: `${liveDocs.length} live ("valid") descendant ticket(s) found under ${currentOwnerUid} for order ${params.orderId} (of ${descendants.length} total)`,
        };
      }
      const liveDoc = liveDocs[0];
      const liveTicketId = liveDoc.id;
      const liveIdxRef = db.doc(`users/${currentOwnerUid}/ticketIndex/${params.eventId}`);
      const liveAttendeeRef = eventRef.collection("attendees").doc(liveTicketId);
      const [tierSnap, liveIdxSnap] = await Promise.all([tx.get(tierRef), tx.get(liveIdxRef)]);

      tx.update(liveDoc.ref, { status: "refunded" });
      tx.update(liveAttendeeRef, { status: "refunded" });
      if (tierSnap.exists) tx.update(tierRef, { soldCount: FieldValue.increment(-1) });
      const idxCount = (liveIdxSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
      if (idxCount <= 1) tx.delete(liveIdxRef); else tx.update(liveIdxRef, { count: idxCount - 1 });
      tx.update(orderRef, {
        refundedTicketIds: FieldValue.arrayUnion(liveTicketId),
        refundedCents: FieldValue.increment(params.amountCents),
        refundedFaceCents: FieldValue.increment(params.unitPriceCents),
      });
      return { kind: "converged", ownerUid: currentOwnerUid, ticketId: liveTicketId };
    }

    // Any other terminal state ("refunded"): idempotent no-op, unchanged
    // from before this fix round.
    return { kind: "noop" };
  });

  if (outcome.kind === "noop") return;

  if (outcome.kind === "convergeFailed") {
    const alertId = ticketRefundConvergenceAlertId(params.ticketId);
    await recordAdminAlert({
      alertId, kind: "ticket_refund_convergence_failed",
      detail: `refundTicket ${params.ticketId} (order ${params.orderId}): Stripe refunded ${params.amountCents}c but the ticket had been transferred and its current live descendant could not be torn down to match (${outcome.reason}); needs manual reconciliation`,
      bookingId: null, gigId: null, now: Date.now(),
    });
    throw new HttpsError("internal", TICKET_REFUND_CONVERGENCE_FAILED_MESSAGE);
  }

  const notifyOwnerUid = outcome.kind === "converged" ? outcome.ownerUid : params.ownerUid;

  await writeLedger({
    kind: "ticket_grace_refund", amountCents: params.amountCents, bookingId: null, gigId: null,
    profileId: params.curatorProfileId, stripeId: params.ticketId,
    detail: `curator grace refund for one ticket ("${params.tierName}")`,
    eventId: params.eventId, buyerUid: params.buyerUid,
  }).catch((e) => console.error(`applyTicketRefund: ledger write failed for ticket ${params.ticketId}`, e));

  await notifyUser(notifyOwnerUid, {
    kind: "ticket", refId: params.eventId, title: "Ticket refunded",
    body: `The organizer refunded your "${params.tierName}" ticket.`,
  }).catch((e) => console.error(`applyTicketRefund: notification failed for ticket ${params.ticketId}`, e));
}

/**
 * SP6 Task 8: the door (QR check-in) and capped in-app ticket transfers.
 *
 * No money moves in this file's remaining three callables (checkInTicket,
 * offerTransfer, respondToTransfer): the only Stripe-money paths in
 * ticketing.ts remain checkout (above) and the two refund paths (above).
 * Transfers move a ticket, not a cent: the buyer already paid, and a
 * transfer just re-points who may present it at the door.
 */

// v1 target is EMAIL ONLY (spec deviation, recorded ruling): the spec's
// "@handle or email" reads naturally for a person, but a "@handle" in this
// codebase resolves to a PROFILE (a musician/curator, often a group with
// several members) via handles/{handle}, never an individual account.
// Handle targeting is therefore ambiguous by construction for a person-to-
// person ticket handoff, so this callable only ever resolves email, via
// Admin Auth's getUserByEmail (emails are not public; see the anti-
// enumeration discipline below, mirroring members.ts's inviteMember).
const TICKET_NOT_TRANSFERABLE_MESSAGE = "Only a valid ticket can be transferred.";
const TRANSFERS_CLOSED_MESSAGE = "Transfers are closed for this event.";
const DUPLICATE_TRANSFER_OFFER_MESSAGE = "This ticket already has a pending transfer offer.";
const SELF_TRANSFER_MESSAGE = "You can't transfer a ticket to yourself.";
const TRANSFER_NOT_OPEN_MESSAGE = "This transfer is no longer open.";
const TRANSFER_EXPIRED_MESSAGE = "This transfer offer has expired.";
const CHECK_IN_NOT_PUBLISHED_MESSAGE = "Check-in is only available for a published event.";

export interface CheckInTicketInput {
  curatorProfileId: string; eventId: string; ticketId: string; qrSecret?: string; override?: boolean;
}
export interface CheckInTicketResult { ownerName: string; tierName: string; checkedInAt: number; }

// Curator-side door scan. Resolution is attendee -> ownerUid -> ticket doc
// (never the other way): the attendees roster is what a curator's member can
// read (firestore.rules), and it names the ticket's CURRENT owner, which is
// where the live ticket doc, and its qrSecret (which attendees deliberately
// never carries), actually lives (a transferred ticket's attendee doc is
// keyed by the NEW ticketId respondToTransfer mints, so this path never sees
// a stale owner). qrSecret is checked BEFORE status, always: a wrong secret
// must read identically whether the ticket is untouched or already checked
// in, or a stolen/guessed secret could fish for "already used" as a signal.
// `override: true` (the curator's list-fallback, no scanner) skips it.
export const checkInTicket = onCall<CheckInTicketInput>(
  { region: "us-central1" }, async (req): Promise<CheckInTicketResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.curatorProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile id is required.");
    }
    if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (!isValidDocId(input?.ticketId)) throw new HttpsError("invalid-argument", "A ticket id is required.");
    if (input.override !== true && (typeof input.qrSecret !== "string" || input.qrSecret.length === 0)) {
      throw new HttpsError("invalid-argument", "A QR secret or override is required.");
    }

    await requireProfileMember(input.curatorProfileId, uid);
    await requireApprovedCuratorProfile(input.curatorProfileId);

    const db = getFirestore();
    const eventRef = db.doc(`events/${input.eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    if (event.curatorProfileId !== input.curatorProfileId) {
      throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
    }
    // Doors can run late relative to endsAt (no time-of-day gate here at
    // all), but only a "published" event has a live door: draft never sold,
    // cancelled/completed have nothing left to check in.
    if (event.status !== "published") {
      throw new HttpsError("failed-precondition", CHECK_IN_NOT_PUBLISHED_MESSAGE);
    }
    // SP10 Task 20 (sp6 #12): a curator browsing the attendee list days early
    // must not be able to mark someone in by a mistaken tap. 12h covers a
    // matinee-to-late-show door and an early soundcheck.
    if (event.startsAt - Date.now() > CHECK_IN_OPENS_BEFORE_MS) {
      throw new HttpsError("failed-precondition", CHECK_IN_TOO_EARLY_MESSAGE);
    }

    const attendeeRef = eventRef.collection("attendees").doc(input.ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const attendee = attendeeSnap.data() as AttendeeDoc;
    const ticketRef = db.doc(`users/${attendee.ownerUid}/tickets/${input.ticketId}`);

    return db.runTransaction(async (tx) => {
      const ticketSnap = await tx.get(ticketRef);
      const ticket = ticketSnap.data() as TicketDoc | undefined;
      if (!ticket || ticket.eventId !== input.eventId || ticket.curatorProfileId !== input.curatorProfileId) {
        throw new HttpsError("not-found", "Ticket not found.");
      }
      // Strict `!== true` (fix round 1, security review): a truthy-but-not-
      // literal-`true` override (a string, a number, any non-boolean JSON
      // value an untrusted onCall payload can carry) must never skip the
      // secret check, even if it slipped past the validation gate above by
      // also supplying a (possibly wrong) qrSecret.
      if (input.override !== true && ticket.qrSecret !== input.qrSecret) {
        throw new HttpsError("failed-precondition", TICKET_NOT_VALID_MESSAGE);
      }
      if (ticket.status === "checked_in") {
        // Original checkedInAt in `details`, not the message: the client
        // shows "already checked in at <time>" without a second round trip.
        throw new HttpsError(
          "failed-precondition", TICKET_ALREADY_CHECKED_IN_MESSAGE, { checkedInAt: ticket.checkedInAt });
      }
      if (ticket.status !== "valid") {
        throw new HttpsError("failed-precondition", TICKET_NOT_VALID_MESSAGE); // refunded or transferred
      }

      const now = Date.now();
      tx.update(ticketRef, { status: "checked_in", checkedInAt: now });
      tx.update(attendeeRef, { status: "checked_in", checkedInAt: now });
      return { ownerName: attendee.ownerName, tierName: ticket.tierName, checkedInAt: now };
    });
  });

const TICKET_NOT_CHECKED_IN_MESSAGE = "This ticket is not checked in.";

export interface UndoCheckInInput { eventId: string; ticketId: string; }

// SP10 Task 20 (sp6 #12): the door's undo. Same attendee -> ownerUid ->
// ticket resolution as checkInTicket, no qrSecret (the curator already has
// the ticket in front of them on the list); the only state it accepts is
// "checked_in", and it puts both docs back exactly as a fresh ticket looks
// (status "valid", no checkedInAt) so a re-scan behaves like a first scan.
export const undoCheckIn = onCall<UndoCheckInInput>(
  { region: "us-central1" }, async (req): Promise<{ ok: true }> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (!isValidDocId(input?.ticketId)) throw new HttpsError("invalid-argument", "A ticket id is required.");

    const db = getFirestore();
    const eventRef = db.doc(`events/${input.eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    await requireProfileMember(event.curatorProfileId, uid);
    await requireApprovedCuratorProfile(event.curatorProfileId);
    if (event.status !== "published") {
      throw new HttpsError("failed-precondition", CHECK_IN_NOT_PUBLISHED_MESSAGE);
    }

    const attendeeRef = eventRef.collection("attendees").doc(input.ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const attendee = attendeeSnap.data() as AttendeeDoc;
    const ticketRef = db.doc(`users/${attendee.ownerUid}/tickets/${input.ticketId}`);

    await db.runTransaction(async (tx) => {
      const ticketSnap = await tx.get(ticketRef);
      const ticket = ticketSnap.data() as TicketDoc | undefined;
      if (!ticket || ticket.eventId !== input.eventId || ticket.curatorProfileId !== event.curatorProfileId) {
        throw new HttpsError("not-found", "Ticket not found.");
      }
      if (ticket.status !== "checked_in") {
        throw new HttpsError("failed-precondition", TICKET_NOT_CHECKED_IN_MESSAGE);
      }
      tx.update(ticketRef, { status: "valid", checkedInAt: FieldValue.delete() });
      tx.update(attendeeRef, { status: "valid", checkedInAt: FieldValue.delete() });
    });
    return { ok: true };
  });

export interface OfferTransferInput { ticketId: string; target: string; }
export interface OfferTransferResult { message: string; }

// Owner-initiated: offers ONE valid ticket to another account by email.
//
// ANTI-ENUMERATION (mirrors members.ts's inviteMember): whether or not
// `target` names a real account, and whether or not that account is already
// at its ticket cap for this event, the SENDER always gets back the same
// generic { message: TRANSFER_OFFER_SENT_MESSAGE }. Nothing in the response
// shape or error code may let a sender fish for "does this email have a
// GateKeep account" or "is that account already holding a lot of tickets".
// A transfer doc + notification are created ONLY when the target resolves,
// is not the sender, and is under its cap.
//
// By contrast, every check ABOVE that line is about the SENDER's OWN ticket
// (its validity, the event's own sale window, whether IT already has an open
// offer), safe to fail loudly since it reveals nothing about anyone else.
export const offerTransfer = onCall<OfferTransferInput>(
  { region: "us-central1" }, async (req): Promise<OfferTransferResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.ticketId)) throw new HttpsError("invalid-argument", "A ticket id is required.");
    if (typeof input?.target !== "string" || input.target.trim().length === 0 || input.target.length > 320) {
      throw new HttpsError("invalid-argument", "A recipient email is required.");
    }

    const db = getFirestore();
    const ticketRef = db.doc(`users/${uid}/tickets/${input.ticketId}`);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const ticket = ticketSnap.data() as TicketDoc;
    if (ticket.status !== "valid") throw new HttpsError("failed-precondition", TICKET_NOT_TRANSFERABLE_MESSAGE);

    const eventSnap = await db.doc(`events/${ticket.eventId}`).get();
    const event = eventSnap.data() as EventDoc | undefined;
    if (!event || event.status !== "published" || event.startsAt <= Date.now()) {
      throw new HttpsError("failed-precondition", TRANSFERS_CLOSED_MESSAGE);
    }

    const now = Date.now();
    // A ticket already carrying an open (unexpired) offer cannot get a
    // second one, sender-safe to reveal (see this callable's doc comment).
    const openOfferSnap = await db.collection("transfers")
      .where("ticketId", "==", input.ticketId).where("status", "==", "offered").get();
    if (openOfferSnap.docs.some((d) => (d.data() as TicketTransferDoc).expiresAt > now)) {
      throw new HttpsError("failed-precondition", DUPLICATE_TRANSFER_OFFER_MESSAGE);
    }

    let toUid: string;
    try {
      const record = await getAuth().getUserByEmail(input.target.trim());
      toUid = record.uid;
    } catch {
      // Unknown email: fall through to the SAME generic response a known-
      // but-capped-out or known-but-self target also gets below.
      return { message: TRANSFER_OFFER_SENT_MESSAGE };
    }
    if (toUid === uid) throw new HttpsError("failed-precondition", SELF_TRANSFER_MESSAGE);

    // Recipient held-cap re-check: ticketIndex.count (tickets already minted
    // to them) PLUS every other still-open offer already addressed to them
    // for THIS event (not yet accepted, so not yet in ticketIndex, but would
    // push them over the cap the moment any subset of those + this one are
    // accepted) must leave room for one more. Mirrors createTicketOrder's own
    // "held + in-flight" cap shape (eventsCore.ts), with pending TRANSFER
    // OFFERS standing in for that callable's pending ORDERS.
    const [toIdxSnap, pendingIncomingSnap] = await Promise.all([
      db.doc(`users/${toUid}/ticketIndex/${ticket.eventId}`).get(),
      db.collection("transfers")
        .where("toUid", "==", toUid).where("eventId", "==", ticket.eventId).where("status", "==", "offered").get(),
    ]);
    const toIdxCount = (toIdxSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
    const pendingIncomingCount = pendingIncomingSnap.docs
      .filter((d) => (d.data() as TicketTransferDoc).expiresAt > now).length;
    if (toIdxCount + pendingIncomingCount + 1 > event.maxTicketsPerBuyer) {
      // Silent, same anti-enumeration reasoning as the unknown-email branch
      // above: a distinct error here would tell the sender the account
      // exists AND is near its cap, which is exactly the kind of fact about
      // someone else's account this callable must never leak.
      return { message: TRANSFER_OFFER_SENT_MESSAGE };
    }

    const transferRef = db.collection("transfers").doc();
    const transfer: TicketTransferDoc = {
      ticketId: input.ticketId, eventId: ticket.eventId, fromUid: uid, toUid,
      status: "offered", createdAt: now, expiresAt: now + TRANSFER_TTL_MS,
    };
    await transferRef.set(transfer);

    await notifyUser(toUid, {
      kind: "ticket", refId: ticket.eventId, title: "You've been offered a ticket",
      body: `You've been offered a "${ticket.tierName}" ticket to "${event.title}".`,
    }).catch((e) => console.error(`offerTransfer: notification failed for transfer ${transferRef.id}`, e));

    return { message: TRANSFER_OFFER_SENT_MESSAGE };
  });

export interface RespondToTransferInput { transferId: string; accept: boolean; }
export interface RespondToTransferResult { ok: true; newTicketId: string | null; }

// Recipient-only. Decline is a plain status flip. Accept is the whole
// handoff in ONE transaction: re-validates the ticket is still "valid" and
// the event still "published" (a cancelled/completed event kills a pending
// offer at accept time, rather than the sweep having to hunt down every
// offer against every such event), re-checks the SAME held-cap this ticket's
// offer was checked against (ticketIndex.count, fresh: accepting is
// immediate and transactional, so unlike the offer-time check there is no
// "other pending offers" term to add: a second concurrent accept for a
// DIFFERENT offer to this same recipient either commits first and this
// transaction's own count read then reflects it, or contends and retries),
// mints a FRESH ticket doc under the recipient with a FRESH qrSecret (the
// old QR must die), replaces the attendees projection (delete the old
// ticketId's entry, write a new one keyed by the NEW ticketId), moves both
// sides' ticketIndex, and flips the old ticket to "transferred".
export const respondToTransfer = onCall<RespondToTransferInput>(
  { region: "us-central1" }, async (req): Promise<RespondToTransferResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.transferId)) throw new HttpsError("invalid-argument", "A transfer id is required.");
    if (typeof input?.accept !== "boolean") throw new HttpsError("invalid-argument", "An accept flag is required.");

    const db = getFirestore();
    const transferRef = db.doc(`transfers/${input.transferId}`);
    const now = Date.now();

    type Outcome =
      | { accepted: false; fromUid: string; eventId: string }
      | { accepted: true; fromUid: string; eventId: string; eventTitle: string; newTicketId: string };

    const outcome = await db.runTransaction<Outcome>(async (tx) => {
      const transferSnap = await tx.get(transferRef);
      if (!transferSnap.exists) throw new HttpsError("not-found", "Transfer not found.");
      const transfer = transferSnap.data() as TicketTransferDoc;
      if (transfer.toUid !== uid) throw new HttpsError("permission-denied", "This transfer does not belong to you.");
      if (transfer.status !== "offered") throw new HttpsError("failed-precondition", TRANSFER_NOT_OPEN_MESSAGE);
      if (transfer.expiresAt <= now) throw new HttpsError("failed-precondition", TRANSFER_EXPIRED_MESSAGE);

      if (!input.accept) {
        tx.update(transferRef, { status: "declined", resolvedAt: now });
        return { accepted: false, fromUid: transfer.fromUid, eventId: transfer.eventId };
      }

      const oldTicketRef = db.doc(`users/${transfer.fromUid}/tickets/${transfer.ticketId}`);
      const eventRef = db.doc(`events/${transfer.eventId}`);
      const toIdxRef = db.doc(`users/${uid}/ticketIndex/${transfer.eventId}`);
      const fromIdxRef = db.doc(`users/${transfer.fromUid}/ticketIndex/${transfer.eventId}`);
      const toUserRef = db.doc(`users/${uid}`);

      // All reads before any write, per the Admin SDK's transaction contract.
      const [oldTicketSnap, eventSnap, toIdxSnap, fromIdxSnap, toUserSnap] = await Promise.all([
        tx.get(oldTicketRef), tx.get(eventRef), tx.get(toIdxRef), tx.get(fromIdxRef), tx.get(toUserRef),
      ]);

      const oldTicket = oldTicketSnap.data() as TicketDoc | undefined;
      if (!oldTicket || oldTicket.status !== "valid") {
        throw new HttpsError("failed-precondition", TICKET_NOT_VALID_MESSAGE);
      }
      const event = eventSnap.data() as EventDoc | undefined;
      if (!event || event.status !== "published") {
        throw new HttpsError("failed-precondition", TRANSFERS_CLOSED_MESSAGE);
      }
      const toIdxCount = (toIdxSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
      if (toIdxCount + 1 > event.maxTicketsPerBuyer) {
        throw new HttpsError("failed-precondition", EVENT_BUYER_CAP_MESSAGE);
      }

      const ownerName = (toUserSnap.data() as { displayName?: string } | undefined)?.displayName ?? "Guest";
      const newTicketRef = db.collection(`users/${uid}/tickets`).doc();
      const newTicket: TicketDoc = {
        eventId: transfer.eventId, tierId: oldTicket.tierId, tierName: oldTicket.tierName,
        orderId: oldTicket.orderId, curatorProfileId: oldTicket.curatorProfileId,
        qrSecret: mintQrSecret(), status: "valid", createdAt: now,
      };
      tx.set(newTicketRef, newTicket);
      const newAttendee: AttendeeDoc = {
        ownerUid: uid, ownerName, tierId: oldTicket.tierId, tierName: oldTicket.tierName, status: "valid",
      };
      tx.set(db.doc(`events/${transfer.eventId}/attendees/${newTicketRef.id}`), newAttendee);
      // The old ticketId's attendee entry dies with it: a scan of the OLD
      // QR (attendee -> ownerUid -> ticket, checkInTicket's own resolution
      // order) now finds no attendee doc at all, rather than resolving
      // through to a "transferred" ticket.
      tx.delete(db.doc(`events/${transfer.eventId}/attendees/${transfer.ticketId}`));
      tx.update(oldTicketRef, { status: "transferred", transferredTo: uid });

      const fromIdxCount = (fromIdxSnap.data() as TicketIndexDoc | undefined)?.count ?? 0;
      if (fromIdxCount <= 1) tx.delete(fromIdxRef); else tx.update(fromIdxRef, { count: fromIdxCount - 1 });
      tx.set(toIdxRef, { count: FieldValue.increment(1) }, { merge: true });

      tx.update(transferRef, { status: "accepted", resolvedAt: now });

      return {
        accepted: true, fromUid: transfer.fromUid, eventId: transfer.eventId,
        eventTitle: event.title, newTicketId: newTicketRef.id,
      };
    });

    // Post-commit, best-effort notifications, both ways (to the SENDER
    // either way, since the recipient is the caller and already knows the
    // outcome).
    if (outcome.accepted) {
      await notifyUser(outcome.fromUid, {
        kind: "ticket", refId: outcome.eventId, title: "Ticket transfer accepted",
        body: `Your ticket transfer for "${outcome.eventTitle}" was accepted.`,
      }).catch((e) => console.error(`respondToTransfer: accepted notification failed for transfer ${input.transferId}`, e));
      return { ok: true, newTicketId: outcome.newTicketId };
    }

    const eventSnap = await db.doc(`events/${outcome.eventId}`).get();
    const eventTitle = (eventSnap.data() as EventDoc | undefined)?.title ?? "the event";
    await notifyUser(outcome.fromUid, {
      kind: "ticket", refId: outcome.eventId, title: "Ticket transfer declined",
      body: `Your ticket transfer offer for "${eventTitle}" was declined.`,
    }).catch((e) => console.error(`respondToTransfer: declined notification failed for transfer ${input.transferId}`, e));
    return { ok: true, newTicketId: null };
  });

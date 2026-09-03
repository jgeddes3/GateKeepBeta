/**
 * SP10 Task 5 and 6 (sp5 #2): chargebacks and dashboard refunds.
 *
 * Three webhook handlers, registered from paymentsWebhook.ts (that file's
 * registry, not this one, so this module never imports it back and no cycle
 * forms), each resolving the charge to its PaymentIntent (through Stripe, whose
 * metadata is the same `purpose` vocabulary the succeeded-intent dispatcher
 * uses) and then to a payment doc or a ticket order:
 *  - charge.dispute.created: record (ledger, DisputeRecord), alert, gate the
 *    curator (deposit / settlement / paydue purposes), stamp the order (tickets).
 *  - charge.dispute.closed: lost reverses the matching transfer; won clears.
 *  - charge.refunded: a refund the ledger does not know is a dashboard refund.
 *
 * Owner decision 4 (spec section 2): record, alert and gate on open; reverse
 * on lost; clear on won. Evidence submission stays manual in Stripe.
 *
 * Every handler tolerates redelivery: ledger rows key on the dispute or refund
 * id, DisputeRecord writes are merge-sets, reversals carry their own
 * idempotency key, and an already-closed record is a no-op.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { isValidDocId } from "@gatekeep/shared";
import type {
  BookingRequestDoc, DisputeRecord, EventDoc, PaymentDoc, TicketOrderDoc,
} from "@gatekeep/shared";
import { getStripe } from "./stripeClient.js";
import { notifyProfileMembers } from "./notifications.js";
import type { WebhookHandler } from "./paymentsWebhook.js";
import {
  clearDelinquencyIfSettled, declareCuratorDelinquent, disputeAlertId, disputeReversalAlertId,
  externalRefundAlertId, recomputePaymentSummary, recordAdminAlert, writeLedger,
} from "./paymentsCore.js";

export type DisputePurpose = DisputeRecord["purpose"];

export interface ChargeTarget {
  purpose: DisputePurpose; intentId: string; chargeId: string | null; amountCents: number;
  bookingId?: string; gigId?: string; orderId?: string;
  curatorProfileId: string | null;
}

const CURATOR_PURPOSES: ReadonlySet<string> = new Set(["deposit", "settlement", "paydue", "paydue_deposit"]);

// The charge -> intent -> doc resolution every handler starts with. null when
// the intent is unknown to Stripe, carries no purpose we stamp, or names ids
// that do not validate (metadata is signature-verified, never shape-validated).
export async function resolveChargeTarget(intentId: string): Promise<ChargeTarget | null> {
  const intent = await getStripe().retrieveIntent(intentId);
  if (!intent) return null;
  const purpose = intent.metadata.purpose;
  const base = { intentId, chargeId: intent.chargeId, amountCents: intent.amountCents };
  if (purpose === "tickets") {
    const orderId = intent.metadata.orderId;
    if (!orderId || !isValidDocId(orderId)) return null;
    return { ...base, purpose: "tickets", orderId, curatorProfileId: null };
  }
  if (!purpose || !CURATOR_PURPOSES.has(purpose)) return null;
  const bookingId = intent.metadata.bookingId;
  if (!bookingId || !isValidDocId(bookingId)) return null;
  const gigId = intent.metadata.gigId;
  if (gigId != null && !isValidDocId(gigId)) return null;
  const booking = (await getFirestore().doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc | undefined;
  if (!booking) return null;
  return {
    ...base, purpose: purpose as DisputePurpose, bookingId, ...(gigId ? { gigId } : {}),
    curatorProfileId: booking.curatorProfileId,
  };
}

interface DisputePayload {
  disputeId: string; intentId: string | null; chargeId: string | null;
  amountCents: number; feeCents: number; reason: string; status: string;
}

// The fields the handlers read off a Stripe Dispute object. `payment_intent`
// and `charge` arrive as ids on a webhook delivery (never expanded).
function readDispute(object: Record<string, unknown>): DisputePayload | null {
  const disputeId = typeof object.id === "string" ? object.id : null;
  if (!disputeId || !isValidDocId(disputeId)) return null;
  const txns = Array.isArray(object.balance_transactions) ? object.balance_transactions as Array<{ fee?: unknown }> : [];
  const feeCents = txns.reduce((sum, t) => sum + (typeof t.fee === "number" ? t.fee : 0), 0);
  return {
    disputeId,
    intentId: typeof object.payment_intent === "string" ? object.payment_intent : null,
    chargeId: typeof object.charge === "string" ? object.charge : null,
    amountCents: typeof object.amount === "number" ? object.amount : 0,
    feeCents,
    reason: typeof object.reason === "string" ? object.reason : "unknown",
    status: typeof object.status === "string" ? object.status : "unknown",
  };
}

async function escalateUnresolvedDispute(d: DisputePayload, eventId: string, now: number): Promise<void> {
  const detail = `dispute ${d.disputeId} (${d.amountCents}c, reason ${d.reason}) on charge ${String(d.chargeId)} / intent`
    + ` ${String(d.intentId)} could not be resolved to a payment doc or ticket order; look it up in Stripe`;
  const alertId = disputeAlertId(d.disputeId);
  const shouldLog = await recordAdminAlert({ alertId, kind: "dispute_opened", detail, bookingId: null, gigId: null, now });
  if (shouldLog) console.error(`charge.dispute (event ${eventId}): ${detail} (see adminAlerts/${alertId})`);
}

export const disputeCreatedHandler: WebhookHandler = async (object, eventId) => {
  const d = readDispute(object);
  if (!d) {
    console.warn(`charge.dispute.created: payload carries no usable dispute id (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const target = d.intentId ? await resolveChargeTarget(d.intentId) : null;
  if (!target) {
    await escalateUnresolvedDispute(d, eventId, now);
    return;
  }
  const db = getFirestore();
  const scope = target.purpose === "tickets"
    ? `ticket order ${target.orderId}`
    : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`;

  // 1. The ledger row, keyed on the dispute id: what Stripe took, and why.
  await writeLedger({
    kind: "dispute_opened", amountCents: d.amountCents, bookingId: target.bookingId ?? null,
    gigId: target.gigId ?? null, profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: `dispute opened on ${scope}: ${d.amountCents}c withdrawn plus fee ${d.feeCents}c, reason ${d.reason}`,
    ...(target.purpose === "tickets" ? { eventId: null, buyerUid: null } : {}),
  }).catch((e) => console.error(`charge.dispute.created: ledger row failed for ${d.disputeId}`, e));

  // 2. The resolution state `closed` reads back. Merge-set, so a redelivery
  // after `closed` already ran cannot reopen a decided dispute.
  const existing = (await db.doc(`disputes/${d.disputeId}`).get()).data() as DisputeRecord | undefined;
  if (!existing) {
    const record: DisputeRecord & { curatorProfileId: string | null } = {
      chargeId: d.chargeId ?? target.chargeId ?? "", intentId: target.intentId, purpose: target.purpose,
      ...(target.bookingId ? { bookingId: target.bookingId } : {}),
      ...(target.gigId ? { gigId: target.gigId } : {}),
      ...(target.orderId ? { orderId: target.orderId } : {}),
      amountCents: d.amountCents, feeCents: d.feeCents, reason: d.reason, status: "open", openedAt: now,
      curatorProfileId: target.curatorProfileId,
    };
    await db.doc(`disputes/${d.disputeId}`).set(record, { merge: true });
  }

  // 3. The durable escalation. Evidence is submitted by hand in Stripe; the
  // ledger and the booking thread are the evidence, and this row is what tells
  // an operator to go and assemble it.
  const alertId = disputeAlertId(d.disputeId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "dispute_opened",
    detail: `dispute ${d.disputeId} opened on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c, reason ${d.reason};`
      + " submit evidence in the Stripe dashboard (the ledger and the booking thread are the record)",
    bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
  });
  if (shouldLog) console.error(`charge.dispute.created: ${scope} disputed (see adminAlerts/${alertId})`);

  // 4. The gate and the word to the curator, for a curator charge.
  if (target.curatorProfileId) {
    await declareCuratorDelinquent(target.curatorProfileId, now)
      .catch((e) => console.error(`charge.dispute.created: delinquency flag failed for ${target.curatorProfileId}`, e));
    if (target.bookingId) {
      await recomputePaymentSummary(target.bookingId)
        .catch((e) => console.error(`charge.dispute.created: summary recompute failed for ${target.bookingId}`, e));
    }
    await notifyProfileMembers(target.curatorProfileId, {
      kind: "booking", refId: target.bookingId, title: "A payment was disputed",
      body: "Your bank has disputed a GateKeep charge. Booking is paused until the dispute is resolved.",
    }).catch((e) => console.error(`charge.dispute.created: notification failed for ${target.curatorProfileId}`, e));
  }

  // 5. The order stamp, for a ticket charge.
  if (target.purpose === "tickets" && target.orderId) {
    await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "open" })
      .catch((e) => console.error(`charge.dispute.created: order stamp failed for ${target.orderId}`, e));
  }
};

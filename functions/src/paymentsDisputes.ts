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
  // Review round 1 (Important 3): the ONLY record of the money Stripe pulled,
  // so a write failure must throw (500, Stripe retries) rather than be
  // swallowed; the row id is deterministic (`dispute_opened:{disputeId}`), so
  // a retry safely re-lands on the same doc instead of double-writing.
  await writeLedger({
    kind: "dispute_opened", amountCents: d.amountCents, bookingId: target.bookingId ?? null,
    gigId: target.gigId ?? null, profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: `dispute opened on ${scope}: ${d.amountCents}c withdrawn plus fee ${d.feeCents}c, reason ${d.reason}`,
    ...(target.purpose === "tickets" ? { eventId: null, buyerUid: null } : {}),
  });

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
  // an operator to go and assemble it. Kept ABOVE the redelivery guard below:
  // a `created` that arrives after the dispute is already decided is still a
  // real (if late) delivery worth recording a recurrence of.
  const alertId = disputeAlertId(d.disputeId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "dispute_opened",
    detail: `dispute ${d.disputeId} opened on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c, reason ${d.reason};`
      + " submit evidence in the Stripe dashboard (the ledger and the booking thread are the record)",
    bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
  });
  if (shouldLog) console.error(`charge.dispute.created: ${scope} disputed (see adminAlerts/${alertId})`);

  // Review round 1 (Important 1): a redelivered `created` (fresh event id,
  // same dispute) must not re-run steps 4/5 once the dispute is DECIDED
  // (Task 6's `closed` handler set status to "won"/"lost"). Only a still-open
  // (or brand-new, `!existing`) dispute may re-flag the curator or reopen the
  // order; a late `created` behind a `closed` is a stale echo, not new news.
  const stillOpen = !existing || existing.status === "open";

  // 4. The gate and the word to the curator, for a curator charge.
  if (stillOpen && target.curatorProfileId) {
    // Review round 1 (Important 2): notify only when this call newly declared
    // delinquency (the pattern paymentsSettlement.ts/paymentsSweep.ts use),
    // so a redelivery of an ALREADY-flagged dispute does not re-notify.
    const newlyDeclared = await declareCuratorDelinquent(target.curatorProfileId, now)
      .catch((e) => {
        console.error(`charge.dispute.created: delinquency flag failed for ${target.curatorProfileId}`, e);
        return false;
      });
    if (target.bookingId) {
      await recomputePaymentSummary(target.bookingId)
        .catch((e) => console.error(`charge.dispute.created: summary recompute failed for ${target.bookingId}`, e));
    }
    if (newlyDeclared) {
      await notifyProfileMembers(target.curatorProfileId, {
        kind: "booking", refId: target.bookingId, title: "A payment was disputed",
        body: "Your bank has disputed a GateKeep charge. Booking is paused until the dispute is resolved.",
      }).catch((e) => console.error(`charge.dispute.created: notification failed for ${target.curatorProfileId}`, e));
    }
  }

  // 5. The order stamp, for a ticket charge.
  if (stillOpen && target.purpose === "tickets" && target.orderId) {
    await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "open" })
      .catch((e) => console.error(`charge.dispute.created: order stamp failed for ${target.orderId}`, e));
  }
};

// Reverses what a LOST dispute took back: the earnings transfer of a settled
// occurrence, the forfeit transfer(s) of a deposit, or the order's share of an
// event's ticket settlement. Returns the reversal id(s) joined by "," (one in
// every ordinary case), or null when there was nothing to reverse; throws when
// Stripe refuses. `reason` explains a null.
async function reverseForLostDispute(
  target: ChargeTarget, disputeId: string, now: number,
): Promise<{ reversalIds: string[]; reason: string | null }> {
  const db = getFirestore();
  const stripe = getStripe();
  if (target.purpose === "tickets") {
    const orderRef = db.doc(`orders/${target.orderId}`);
    const order = (await orderRef.get()).data() as TicketOrderDoc | undefined;
    if (!order) return { reversalIds: [], reason: "order missing" };
    const faceCents = order.faceTotalCents - order.refundedFaceCents;
    if (faceCents <= 0) return { reversalIds: [], reason: "order has no unrefunded face value" };
    const event = (await db.doc(`events/${order.eventId}`).get()).data() as EventDoc | undefined;
    if (event?.settlementStartedAt == null) {
      // Not settled yet: shrink the basis settleOneEvent will sum. No transfer
      // exists to reverse, and none is needed.
      await orderRef.update({ refundedFaceCents: FieldValue.increment(faceCents) });
      return { reversalIds: [], reason: null };
    }
    const settled = await db.collection("ledger")
      .where("kind", "==", "ticket_settlement").where("eventId", "==", order.eventId).limit(1).get();
    const transferId = settled.empty ? null : (settled.docs[0].data().stripeId as string | null);
    if (!transferId) return { reversalIds: [], reason: "no transfer: the event is marked settled but no ticket_settlement row names its transfer" };
    const r = await stripe.reverseTransfer({
      transferId, amountCents: faceCents, idempotencyKey: `dispute_reverse:${disputeId}`,
    });
    return { reversalIds: [r.id], reason: null };
  }

  const paymentsSnap = await db.collection(`bookings/${target.bookingId}/payments`).get();
  const docs = paymentsSnap.docs
    .map((d) => ({ ref: d.ref, gigId: d.id, p: d.data() as PaymentDoc }))
    .filter(({ gigId, p }) => target.gigId ? gigId === target.gigId : p.deposit.intentId === target.intentId);
  if (target.purpose === "settlement" || target.purpose === "paydue") {
    const hit = docs.find(({ p }) => p.settlement.intentId === target.intentId && p.transfer.status === "transferred" && p.transfer.id);
    if (!hit) return { reversalIds: [], reason: "no transfer: the settlement has no live earnings transfer to reverse" };
    const r = await stripe.reverseTransfer({ transferId: hit.p.transfer.id!, idempotencyKey: `dispute_reverse:${disputeId}` });
    await hit.ref.update({ "transfer.status": "reversed", updatedAt: now })
      .catch((e) => console.error(`charge.dispute.closed: transfer.status write failed for ${target.bookingId}/${hit.gigId}`, e));
    await recomputePaymentSummary(target.bookingId!)
      .catch((e) => console.error(`charge.dispute.closed: summary recompute failed for ${target.bookingId}`, e));
    return { reversalIds: [r.id], reason: null };
  }
  // deposit / paydue_deposit: every forfeit funded by this charge.
  const forfeits = docs.filter(({ p }) => p.deposit.status === "forfeited" && p.deposit.forfeitTransferId);
  if (forfeits.length === 0) return { reversalIds: [], reason: "no transfer: the deposit was never forfeited to the musician" };
  const ids: string[] = [];
  for (const f of forfeits) {
    const key = forfeits.length === 1 ? `dispute_reverse:${disputeId}` : `dispute_reverse:${disputeId}:${f.gigId}`;
    const r = await stripe.reverseTransfer({ transferId: f.p.deposit.forfeitTransferId!, idempotencyKey: key });
    ids.push(r.id);
  }
  await recomputePaymentSummary(target.bookingId!)
    .catch((e) => console.error(`charge.dispute.closed: summary recompute failed for ${target.bookingId}`, e));
  return { reversalIds: ids, reason: null };
}

export const disputeClosedHandler: WebhookHandler = async (object, eventId) => {
  const d = readDispute(object);
  if (!d) {
    console.warn(`charge.dispute.closed: payload carries no usable dispute id (event ${eventId})`);
    return;
  }
  if (d.status !== "won" && d.status !== "lost") {
    // Stripe also closes disputes as warning_closed etc. Nothing moved; recorded by the claim machine only.
    console.info(`charge.dispute.closed: ${d.disputeId} closed as ${d.status}, nothing to do (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const db = getFirestore();
  const recRef = db.doc(`disputes/${d.disputeId}`);
  const existing = (await recRef.get()).data() as (DisputeRecord & { curatorProfileId?: string | null }) | undefined;
  if (existing && existing.status !== "open") {
    console.info(`charge.dispute.closed: ${d.disputeId} already ${existing.status}, replay ignored (event ${eventId})`);
    return;
  }
  // `created` may never have run (an endpoint registered mid-dispute); resolve
  // the target ourselves in that case, from the same intent.
  const target = existing
    ? {
      purpose: existing.purpose, intentId: existing.intentId, chargeId: existing.chargeId, amountCents: existing.amountCents,
      bookingId: existing.bookingId, gigId: existing.gigId, orderId: existing.orderId,
      curatorProfileId: existing.curatorProfileId ?? null,
    } satisfies ChargeTarget
    : (d.intentId ? await resolveChargeTarget(d.intentId) : null);
  if (!target) {
    await escalateUnresolvedDispute(d, eventId, now);
    return;
  }
  const scope = target.purpose === "tickets"
    ? `ticket order ${target.orderId}`
    : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`;
  const baseRecord = {
    chargeId: d.chargeId ?? target.chargeId ?? "", intentId: target.intentId, purpose: target.purpose,
    ...(target.bookingId ? { bookingId: target.bookingId } : {}),
    ...(target.gigId ? { gigId: target.gigId } : {}),
    ...(target.orderId ? { orderId: target.orderId } : {}),
    amountCents: d.amountCents, feeCents: d.feeCents, reason: d.reason,
    openedAt: existing?.openedAt ?? now, curatorProfileId: target.curatorProfileId,
  };

  if (d.status === "won") {
    await writeLedger({
      kind: "dispute_won", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
      profileId: target.curatorProfileId, stripeId: d.disputeId, detail: `dispute won on ${scope}: ${d.amountCents}c returned`,
    }).catch((e) => console.error(`charge.dispute.closed: dispute_won ledger row failed for ${d.disputeId}`, e));
    await recRef.set({ ...baseRecord, status: "won", closedAt: now }, { merge: true });
    if (target.purpose === "tickets" && target.orderId) {
      await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "won" })
        .catch((e) => console.error(`charge.dispute.closed: order stamp failed for ${target.orderId}`, e));
    }
    if (target.curatorProfileId) {
      // The record now reads `won`, so the open-dispute question in
      // clearDelinquencyIfSettled no longer holds the gate; the other two
      // questions still can.
      await clearDelinquencyIfSettled(target.curatorProfileId, now)
        .catch((e) => console.error(`charge.dispute.closed: delinquency clear failed for ${target.curatorProfileId}`, e));
    }
    const alertId = disputeAlertId(d.disputeId);
    await db.doc(`adminAlerts/${alertId}`).set({ resolvedAt: now, detail: `dispute ${d.disputeId} on ${scope} was WON; nothing further to do` }, { merge: true })
      .catch((e) => console.error(`charge.dispute.closed: could not resolve alert ${alertId}`, e));
    return;
  }

  // LOST. Stripe already debited the platform; reverse the matching transfer
  // so the loss lands where the money went (owner decision 4).
  let reversalIds: string[] = [];
  let failure: string | null = null;
  try {
    const r = await reverseForLostDispute(target, d.disputeId, now);
    reversalIds = r.reversalIds;
    failure = r.reason;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  await writeLedger({
    kind: "dispute_lost", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
    profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: reversalIds.length > 0
      ? `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; transfer reversed (${reversalIds.join(", ")})`
      : `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; ${failure ?? "settlement basis reduced, no transfer to reverse"}`,
  }).catch((e) => console.error(`charge.dispute.closed: dispute_lost ledger row failed for ${d.disputeId}`, e));
  await recRef.set({
    ...baseRecord, status: "lost", closedAt: now,
    ...(reversalIds.length > 0 ? { reversalTransferId: reversalIds.join(",") } : {}),
  }, { merge: true });
  if (target.purpose === "tickets" && target.orderId) {
    await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "lost" })
      .catch((e) => console.error(`charge.dispute.closed: order stamp failed for ${target.orderId}`, e));
  }
  if (failure) {
    const alertId = disputeReversalAlertId(d.disputeId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "dispute_reversal_failed",
      detail: `dispute ${d.disputeId} on ${scope} was LOST (${d.amountCents}c plus fee ${d.feeCents}c) and the matching transfer`
        + ` could not be reversed: ${failure}; finish the unwind in Stripe`,
      bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
    });
    if (shouldLog) console.error(`charge.dispute.closed: reversal failed for ${d.disputeId} (see adminAlerts/${alertId})`);
  }
  const alertId = disputeAlertId(d.disputeId);
  await db.doc(`adminAlerts/${alertId}`).set({
    resolvedAt: now, detail: `dispute ${d.disputeId} on ${scope} was LOST; see the dispute_lost ledger row${failure ? ` and adminAlerts/${disputeReversalAlertId(d.disputeId)}` : ""}`,
  }, { merge: true }).catch((e) => console.error(`charge.dispute.closed: could not resolve alert ${alertId}`, e));
};

// A refund the ledger does not know about is a DASHBOARD refund. Every refund
// this codebase issues carries `metadata.purpose` (RealStripe.refund forwards
// `meta`), and most also have a ledger row keyed on the refund id; a refund
// with neither was issued by hand.
export const chargeRefundedHandler: WebhookHandler = async (object, eventId) => {
  const chargeId = typeof object.id === "string" ? object.id : null;
  const intentId = typeof object.payment_intent === "string" ? object.payment_intent : null;
  const list = (object.refunds as { data?: unknown } | undefined)?.data;
  const refunds = Array.isArray(list)
    ? list.filter((r): r is { id: string; amount?: unknown; metadata?: unknown } => typeof (r as { id?: unknown }).id === "string")
    : [];
  if (!chargeId || refunds.length === 0) {
    console.info(`charge.refunded: no refund list on charge ${String(chargeId)} (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const db = getFirestore();
  const target = intentId ? await resolveChargeTarget(intentId) : null;
  for (const refund of refunds) {
    if (!isValidDocId(refund.id)) continue;
    const purpose = (refund.metadata as Record<string, unknown> | undefined)?.purpose;
    if (typeof purpose === "string" && purpose.length > 0) continue; // ours
    const known = await db.collection("ledger").where("stripeId", "==", refund.id).limit(1).get();
    if (!known.empty) continue; // ours, keyed on the refund id
    const amountCents = typeof refund.amount === "number" ? refund.amount : 0;

    let stillPaid = false;
    let stateWord = "unknown";
    let buyerUid: string | null = null;
    if (target?.purpose === "tickets" && target.orderId) {
      const order = (await db.doc(`orders/${target.orderId}`).get()).data() as TicketOrderDoc | undefined;
      buyerUid = order?.buyerUid ?? null;
      stillPaid = order?.status === "paid";
      stateWord = order?.status ?? "missing";
    } else if (target?.bookingId) {
      const snap = await db.collection(`bookings/${target.bookingId}/payments`).get();
      const docs = snap.docs.map((d) => d.data() as PaymentDoc)
        .filter((p) => target.gigId ? p.gigId === target.gigId : (p.deposit.intentId === intentId || p.settlement.intentId === intentId));
      const isSettlementCharge = target.purpose === "settlement" || target.purpose === "paydue";
      stillPaid = docs.some((p) => isSettlementCharge
        ? p.settlement.status === "paid"
        : (p.deposit.status === "held" || p.deposit.status === "applied" || p.deposit.status === "forfeited"));
      stateWord = docs.map((p) => isSettlementCharge ? p.settlement.status : p.deposit.status).join(",") || "missing";
    }
    const scope = target
      ? (target.purpose === "tickets" ? `ticket order ${target.orderId}` : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`)
      : `charge ${chargeId}`;
    await writeLedger({
      kind: "external_refund", amountCents, bookingId: target?.bookingId ?? null, gigId: target?.gigId ?? null,
      profileId: target?.curatorProfileId ?? null, stripeId: refund.id,
      detail: `refund ${refund.id} of ${amountCents}c on ${scope} was issued outside GateKeep (dashboard); doc state ${stateWord}`,
      ...(target?.purpose === "tickets" ? { eventId: null, buyerUid } : {}),
    }).catch((e) => console.error(`charge.refunded: external_refund ledger row failed for ${refund.id}`, e));
    if (stillPaid) {
      const alertId = externalRefundAlertId(refund.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "external_refund",
        detail: `refund ${refund.id} of ${amountCents}c on ${scope} came from the Stripe dashboard, but the record still reads ${stateWord};`
          + " decide what the refund means for this record and finish the unwind by hand",
        bookingId: target?.bookingId ?? null, gigId: target?.gigId ?? null, now,
      });
      if (shouldLog) console.error(`charge.refunded: external refund ${refund.id} on ${scope} (see adminAlerts/${alertId})`);
    }
  }
};

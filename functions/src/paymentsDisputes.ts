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
import { isValidDocId, SETTLEMENT_CLAIM_STALE_MS } from "@gatekeep/shared";
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
  // an operator to go and assemble it.
  //
  // Branch audit (LOW): skipped once the dispute is DECIDED. recordAdminAlert
  // clears `resolvedAt` on every recurrence, on purpose: an operator must not
  // be able to silence a condition that is still live. A dispute Stripe has
  // already won or lost is not a live condition, and the closed handler's own
  // "was WON/LOST" detail is the row's final word, so a late redelivery here
  // would reopen a finished ticket and overwrite that word with "opened".
  // Logged instead, so the late delivery is still visible. This is the same
  // stale-echo reasoning as the `stillOpen` guard on steps 4/5 below; only a
  // brand-new (`!existing`) or still-open dispute reaches the alert.
  const alertId = disputeAlertId(d.disputeId);
  if (existing && existing.status !== "open") {
    console.info(`charge.dispute.created: ${d.disputeId} already ${existing.status}, late delivery not re-escalated (event ${eventId})`);
  } else {
    const shouldLog = await recordAdminAlert({
      alertId, kind: "dispute_opened",
      detail: `dispute ${d.disputeId} opened on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c, reason ${d.reason};`
        + " submit evidence in the Stripe dashboard (the ledger and the booking thread are the record)",
      bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
    });
    if (shouldLog) console.error(`charge.dispute.created: ${scope} disputed (see adminAlerts/${alertId})`);
  }

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
// `disputeAmountCents` is what the BANK took back, which can be less than the
// transfer that moved the money out (a partial chargeback). Every reversal
// below is therefore capped at it: reversing the whole transfer would claw
// back more from the musician than the platform actually lost (branch audit,
// LOW). The ticket branch already reasons in per-order face value and is
// unchanged.
async function reverseForLostDispute(
  target: ChargeTarget, disputeId: string, now: number, disputeAmountCents: number,
): Promise<{ reversalIds: string[]; reason: string | null }> {
  const db = getFirestore();
  const stripe = getStripe();
  if (target.purpose === "tickets") {
    const orderRef = db.doc(`orders/${target.orderId}`);
    type TicketTxResult =
      | { kind: "no-op"; reason: string }
      | { kind: "reduced" }
      | { kind: "settled"; faceCents: number; transferId: string | null };
    // SP10 Task 6 fix round 1 (Important 2): the order read, the event's
    // settlementStartedAt re-check, and (when not yet settled) the
    // refundedFaceCents/refundedCents increment all happen inside ONE
    // transaction, so a settlement that starts in the window since an
    // earlier look can never be silently missed (which would otherwise shrink
    // the pending basis for revenue that had already left as a transfer). The
    // Stripe call for the SETTLED branch happens after this transaction
    // returns, never inside it (money-path discipline: no Stripe call inside
    // a Firestore transaction).
    const result = await db.runTransaction<TicketTxResult>(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      const order = orderSnap.data() as TicketOrderDoc | undefined;
      if (!order) return { kind: "no-op", reason: "order missing" };
      const faceCents = order.faceTotalCents - order.refundedFaceCents;
      if (faceCents <= 0) return { kind: "no-op", reason: "order has no unrefunded face value" };
      const eventSnap = await tx.get(db.doc(`events/${order.eventId}`));
      const event = eventSnap.data() as EventDoc | undefined;
      if (event?.settlementStartedAt == null) {
        // SP10 Task 9 fix round 1 (Critical 1): a FRESH `settlementClaimedAt`
        // with no `settlementStartedAt` is the window between the sweep's claim
        // write and its post-transfer stamp. The transfer may be in flight, or
        // may already have landed with only the stamp outstanding, so this is
        // NOT a pre-settlement order. Reducing the basis here would change the
        // faceCents the next sweep pass replays under the STATIC
        // `ticket_settlement:{eventId}` key (real Stripe answers a changed
        // amount under a used key with `idempotency_error`), and would shrink
        // revenue that may already have reached the curator. Same predicate and
        // same 24h window `cancelEventCore` refuses a cancel on: touch nothing
        // and hand back a reason, so `dispute_reversal_failed` fires and an
        // operator finishes the unwind in Stripe. A STALE claim belongs to a
        // settlement that kept failing and falls through to the pre-settlement
        // reduction below.
        const claimedAt = event?.settlementClaimedAt;
        if (claimedAt != null && now - claimedAt < SETTLEMENT_CLAIM_STALE_MS) {
          return {
            kind: "no-op",
            reason: "settlement in progress: the event's ticket settlement is claimed but not yet recorded;"
              + " reverse manually once it lands",
          };
        }
        // Not settled yet: shrink the basis settleOneEvent will sum (and keep
        // refundedCents in step, so refundOrderForCancelledEvent's own
        // "remaining" math stays consistent with this reduction). No transfer
        // exists to reverse, and none is needed.
        tx.update(orderRef, {
          refundedFaceCents: FieldValue.increment(faceCents), refundedCents: FieldValue.increment(faceCents),
        });
        return { kind: "reduced" };
      }
      const settledSnap = await tx.get(db.collection("ledger")
        .where("kind", "==", "ticket_settlement").where("eventId", "==", order.eventId).limit(1));
      const transferId = settledSnap.empty ? null : (settledSnap.docs[0].data().stripeId as string | null);
      return { kind: "settled", faceCents, transferId };
    });
    if (result.kind === "no-op") return { reversalIds: [], reason: result.reason };
    if (result.kind === "reduced") return { reversalIds: [], reason: null };
    if (!result.transferId) return { reversalIds: [], reason: "no transfer: the event is marked settled but no ticket_settlement row names its transfer" };
    const r = await stripe.reverseTransfer({
      transferId: result.transferId, amountCents: result.faceCents, idempotencyKey: `dispute_reverse:${disputeId}`,
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
    const r = await stripe.reverseTransfer({
      transferId: hit.p.transfer.id!, idempotencyKey: `dispute_reverse:${disputeId}`,
      amountCents: Math.min(disputeAmountCents, hit.p.transfer.amountCents ?? disputeAmountCents),
    });
    // The doc still reads "reversed" on a PARTIAL reversal: this occurrence's
    // earnings transfer is no longer whole, and nothing downstream treats
    // "reversed" as "reversed in full". The exact cents live on the ledger row
    // the caller writes, and in Stripe.
    await hit.ref.update({ "transfer.status": "reversed", updatedAt: now })
      .catch((e) => console.error(`charge.dispute.closed: transfer.status write failed for ${target.bookingId}/${hit.gigId}`, e));
    await recomputePaymentSummary(target.bookingId!)
      .catch((e) => console.error(`charge.dispute.closed: summary recompute failed for ${target.bookingId}`, e));
    return { reversalIds: [r.id], reason: null };
  }
  // deposit / paydue_deposit: every forfeit funded by THIS charge (SP10 Task 6
  // fix round 1, minor: the intentId check guards against a booking doc that
  // was re-charged under a newer deposit intent since this one was disputed,
  // so a stale disputed intent can never reverse a forfeit it did not fund).
  const forfeits = docs.filter(({ p }) => p.deposit.status === "forfeited" && p.deposit.forfeitTransferId
    && p.deposit.intentId === target.intentId);
  if (forfeits.length === 0) return { reversalIds: [], reason: "no transfer: the deposit was never forfeited to the musician" };
  const ids: string[] = [];
  for (const f of forfeits) {
    const key = forfeits.length === 1 ? `dispute_reverse:${disputeId}` : `dispute_reverse:${disputeId}:${f.gigId}`;
    const r = await stripe.reverseTransfer({
      transferId: f.p.deposit.forfeitTransferId!, idempotencyKey: key,
      // The forfeit transfer moved exactly the deposit slice (paymentsCore's
      // forfeit_transfer ledger row is written for that amount).
      amountCents: Math.min(disputeAmountCents, f.p.deposit.sliceCents),
    });
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
    // SP10 Task 6 fix round 1 (Important 4): the ONLY record that Stripe gave
    // this money back, so a write failure must throw (500, Stripe retries)
    // rather than be swallowed, same rule `disputeCreatedHandler`'s
    // `dispute_opened` row already follows. The deterministic id
    // (`dispute_won:{disputeId}`) makes a retry safely re-land on the same
    // doc, and this write runs BEFORE the `disputes/{id}` status stamp below,
    // so a retry after a failed write here is never blocked by the
    // `existing.status !== "open"` redelivery guard at the top of this
    // handler (which only trips once the record has actually moved to "won").
    await writeLedger({
      kind: "dispute_won", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
      profileId: target.curatorProfileId, stripeId: d.disputeId, detail: `dispute won on ${scope}: ${d.amountCents}c returned`,
    });
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
    const r = await reverseForLostDispute(target, d.disputeId, now, d.amountCents);
    reversalIds = r.reversalIds;
    failure = r.reason;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // Same rule as the WON row above (Important 4): throws rather than
  // swallows, and runs before the status stamp below.
  await writeLedger({
    kind: "dispute_lost", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
    profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: reversalIds.length > 0
      ? `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; transfer reversed (${reversalIds.join(", ")})`
      : `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; ${failure ?? "settlement basis reduced, no transfer to reverse"}`,
  });
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
//
// SP10 Task 6 fix round 1 (Critical 1): a Charge webhook payload's `refunds`
// list is NOT expanded on delivery, and this client's pinned API version
// (2025-08-27.basil, well past the 2022-11-15 cutover) no longer attaches it
// by default even on a direct fetch. Trusting `object.refunds` here would
// silently do nothing for every real dashboard refund. `listRefunds` asks
// Stripe (or the fake) directly, keyed on the charge id alone.
export const chargeRefundedHandler: WebhookHandler = async (object, eventId) => {
  const chargeId = typeof object.id === "string" ? object.id : null;
  const intentId = typeof object.payment_intent === "string" ? object.payment_intent : null;
  const amountRefundedTotal = typeof object.amount_refunded === "number" ? object.amount_refunded : 0;
  if (!chargeId || !isValidDocId(chargeId)) {
    console.warn(`charge.refunded: payload carries no usable charge id (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const db = getFirestore();

  let refunds: Array<{ id: string; amountCents: number; metadata: Record<string, string> }>;
  try {
    refunds = await getStripe().listRefunds(chargeId);
  } catch (e) {
    // Cannot enumerate what Stripe actually refunded. A positive
    // amount_refunded still means real money left, so escalate on the charge
    // id itself (there is no refund id to key on) rather than return
    // silently on what could be a live money event.
    if (amountRefundedTotal > 0) {
      const alertId = externalRefundAlertId(chargeId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "external_refund",
        detail: `charge ${chargeId} reports ${amountRefundedTotal}c refunded but its refund list could not be`
          + ` retrieved from Stripe (${e instanceof Error ? e.message : String(e)}); reconcile by hand`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) console.error(`charge.refunded: listRefunds failed for charge ${chargeId} (see adminAlerts/${alertId})`);
    } else {
      console.warn(`charge.refunded: listRefunds failed for charge ${chargeId} (event ${eventId})`, e);
    }
    return;
  }
  if (refunds.length === 0) {
    if (amountRefundedTotal > 0) {
      const alertId = externalRefundAlertId(chargeId);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "external_refund",
        detail: `charge ${chargeId} reports ${amountRefundedTotal}c refunded but Stripe's refund list came back`
          + " empty; reconcile by hand",
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) console.error(`charge.refunded: empty refund list for charge ${chargeId} despite a positive amount_refunded (see adminAlerts/${alertId})`);
    } else {
      console.info(`charge.refunded: no refunds on charge ${chargeId} (event ${eventId})`);
    }
    return;
  }
  const target = intentId ? await resolveChargeTarget(intentId) : null;
  for (const refund of refunds) {
    if (!isValidDocId(refund.id)) continue;
    // SP10 Task 6 fix round 2 (Important 1): the FIRST check, not the ledger
    // row. Every refund() call in this codebase stamps a non-empty
    // metadata.purpose (deposit_refund, below_deposit_refund,
    // noshow_clawback[_deposit], accept_abort, ticket_cancel_refund,
    // ticket_grace_refund), so this alone is enough to know a refund is
    // app-issued. It must not be dropped in favor of the ledger-row check
    // alone: the two ticketing refund kinds key their ledger rows on the
    // ticket/order id, not the Stripe refund id (ticketing.ts), so
    // `stripeId == refund.id` never matches them and every curator grace
    // refund or cancelled-event refund would otherwise misread as external.
    const purpose = refund.metadata.purpose;
    if (typeof purpose === "string" && purpose.length > 0) continue; // ours
    const known = await db.collection("ledger").where("stripeId", "==", refund.id).limit(1).get();
    if (!known.empty) continue; // ours, keyed on the refund id (every other purpose)
    const amountCents = refund.amountCents;

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
    // SP10 Task 6 fix round 1 (Important 4): throws rather than swallows, same
    // rule as the dispute ledger rows; deterministic id, redelivery-safe.
    await writeLedger({
      kind: "external_refund", amountCents, bookingId: target?.bookingId ?? null, gigId: target?.gigId ?? null,
      profileId: target?.curatorProfileId ?? null, stripeId: refund.id,
      detail: `refund ${refund.id} of ${amountCents}c on ${scope} was issued outside GateKeep (dashboard); doc state ${stateWord}`,
      ...(target?.purpose === "tickets" ? { eventId: null, buyerUid } : {}),
    });
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

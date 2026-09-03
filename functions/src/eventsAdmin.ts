/**
 * SP10 Task 11: admin-side event moderation. Kept out of events.ts so the
 * event lifecycle module never imports review.ts (requireAdmin/writeAudit)
 * directly; see the section header note on the review -> events -> gigs ->
 * review cycle.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type EventDoc } from "@gatekeep/shared";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";
import { stripeSecretKey } from "./stripeClient.js";
import { cancelAndRefundEventForModeration, type ModerationCancelResult } from "./events.js";

export interface TakedownEventInput { eventId: string; reason: string; }
export interface TakedownEventResult {
  ok: true; outcome: ModerationCancelResult["outcome"]; ordersRefunded: number;
}

// requireAdmin, then the same 1..500 reason contract reviewProfile and
// takedownGig enforce. Cancels and refunds regardless of the curator's
// status (the curator's own cancelEvent is gated on approval, which is the
// whole reason this exists: sp1 #1, cross #1). A completed event is refused
// outright rather than silently skipped: its settlement already ran, and an
// admin asking to refund it needs to know that is a Stripe-dashboard job.
export const takedownEvent = onCall<TakedownEventInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<TakedownEventResult> => {
    const actorUid = requireAdmin(req);
    const { eventId, reason } = req.data ?? ({} as TakedownEventInput);
    if (!isValidDocId(eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new HttpsError("invalid-argument", "A takedown reason is required.");
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length > 500) {
      throw new HttpsError("invalid-argument", "Takedown reason must be 500 characters or fewer.");
    }

    const snap = await getFirestore().doc(`events/${eventId}`).get();
    if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = snap.data() as EventDoc;
    if (event.status === "completed") {
      throw new HttpsError("failed-precondition",
        "This event has completed and its ticket revenue has settled. Refunds for it are a Stripe dashboard action.");
    }

    const result = await cancelAndRefundEventForModeration(eventId, trimmedReason, { kind: "admin", uid: actorUid });

    await writeAudit({
      actorUid, action: "event_taken_down", targetId: eventId,
      detail: `[was ${event.status}] ${trimmedReason} (refunded ${result.orders.ordersRefunded} orders, expired ${result.orders.pendingExpired} pending)`,
    });
    await notifyProfileMembers(event.curatorProfileId, {
      kind: "gig_moderation", refId: eventId,
      title: `Your event "${event.title}" was taken down`,
      body: `Reviewer note: ${trimmedReason} Ticket holders have been refunded in full.`,
    });
    return { ok: true, outcome: result.outcome, ordersRefunded: result.orders.ordersRefunded };
  });

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getStripe, stripeSecretKey, stripeWebhookSecret } from "./stripeClient.js";

// The codebase's ONLY non-callable HTTPS entry point. Contract:
//  - raw-body signature verification (RealStripe.constructWebhookEvent throws
//    on a bad signature; FakeStripe accepts anything — emulator only);
//  - stripeEvents/{eventId} transactional create-if-absent = exactly-once
//    processing per event id (replays and concurrent deliveries no-op);
//  - handlers are dispatched by type and must individually tolerate
//    out-of-order delivery (each re-reads current state, never assumes).
// Handlers are REGISTERED here but implemented across tasks:
//  - account.updated        -> Task 4 (cached gate flags)
//  - payment_intent.succeeded -> Task 10 (payPastDue completion)
//  - payout.paid/payout.failed -> Task 13
//  - transfer.reversed      -> Task 12 (ledger only)
// Unknown/unhandled types: record the event doc, 200 OK (Stripe requires 2xx
// or it retries forever).
export type WebhookHandler = (object: Record<string, unknown>, eventId: string) => Promise<void>;
export const webhookHandlers: Record<string, WebhookHandler> = {};

export const stripeWebhook = onRequest(
  { region: "us-central1", secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).end(); return; }
    const stripe = getStripe();
    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = stripe.constructWebhookEvent(req.rawBody.toString("utf8"), req.headers["stripe-signature"] as string ?? "");
    } catch {
      res.status(400).send("bad signature");
      return;
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") {
      res.status(400).send("bad event");
      return;
    }

    const db = getFirestore();
    const eventRef = db.doc(`stripeEvents/${event.id}`);
    // Exactly-once claim: create-if-absent inside a transaction. A replay
    // (doc already exists) returns 200 without re-processing.
    const fresh = await db.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      if (snap.exists) return false;
      tx.set(eventRef, { type: event.type, receivedAt: Date.now(), processed: false });
      return true;
    });
    if (!fresh) { res.status(200).send("duplicate"); return; }

    const handler = webhookHandlers[event.type];
    if (handler) {
      try {
        await handler(event.data.object, event.id);
        await eventRef.update({ processed: true, processedAt: Date.now() });
      } catch (e) {
        console.error(`stripeWebhook: handler for ${event.type} failed (event ${event.id})`, e);
        // Delete the claim so Stripe's retry re-processes — a handler failure
        // must not be swallowed by the idempotency guard.
        await eventRef.delete().catch(() => {});
        res.status(500).send("handler failed");
        return;
      }
    } else {
      await eventRef.update({ processed: true, processedAt: Date.now() });
    }
    res.status(200).send("ok");
  });

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId } from "@gatekeep/shared";
import { getStripe, stripeSecretKey, stripeWebhookSecret } from "./stripeClient.js";

// The codebase's ONLY non-callable HTTPS entry point. Contract:
//  - raw-body signature verification (RealStripe.constructWebhookEvent throws
//    on a bad signature; FakeStripe accepts anything — emulator only);
//  - stripeEvents/{eventId} status-field claim machine (see STALE_CLAIM_MS
//    below) = exactly-once processing per event id, self-healing against a
//    claim that never finished instead of leaving that event id stuck
//    forever;
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

// Test-only handlers, registered ONLY inside the Functions emulator
// (FUNCTIONS_EMULATOR is set by the emulator's own runtime — never true in a
// deployed function). They exist purely so paymentsWebhook.test.ts can
// exercise the claim machine's success/failure/re-claim paths end-to-end
// without depending on a real handler landing in this task.
if (process.env.FUNCTIONS_EMULATOR === "true") {
  webhookHandlers["gatekeep.test.throw"] = async () => {
    throw new Error("gatekeep.test.throw: intentional test failure");
  };
  webhookHandlers["gatekeep.test.ok"] = async () => {};
}

// A claim (stripeEvents/{id} with processed:false) that never resolves — the
// instance crashed mid-handler, a deploy rolled mid-flight, etc. — must not
// block that event id forever. Stripe's own retry schedule tops out well
// under this, so a delivery for the same id arriving after STALE_CLAIM_MS
// re-claims (and reprocesses) instead of parroting "duplicate" for an event
// that never actually finished. Re-claiming stamps a FRESH receivedAt, so the
// new attempt gets its own stale-claim window.
export const STALE_CLAIM_MS = 10 * 60 * 1000;

// Retention window stamped onto every stripeEvents doc as `expireAt` — 30
// days. This only stamps the field; actually expiring documents past it
// requires enabling a Firestore TTL policy on stripeEvents.expireAt in the
// console, tracked as a Task 16 README launch item, not code here.
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const stripeWebhook = onRequest(
  { region: "us-central1", secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).end(); return; }
    if (req.rawBody == null) { res.status(400).send("missing body"); return; }
    const sigHeader = req.headers["stripe-signature"];
    if (typeof sigHeader !== "string") { res.status(400).send("missing signature"); return; }

    const stripe = getStripe();
    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = stripe.constructWebhookEvent(req.rawBody, sigHeader);
    } catch {
      res.status(400).send("bad signature");
      return;
    }
    // isValidDocId(event.id) is also doc-id-injection protection: FakeStripe's
    // constructWebhookEvent is a bare JSON.parse with no shape validation, so
    // without this an event.id containing "/" (or too long, or empty) could
    // target an arbitrary stripeEvents/{...} path instead of a single doc.
    if (!isValidDocId(event?.id) || typeof event?.type !== "string" || event?.data?.object == null) {
      res.status(400).send("bad event");
      return;
    }

    // Signature verification above is the only untrusted-input boundary in
    // this handler — event.id/type/data.object are validated by this point,
    // so anything that throws past here is our own bug, not attacker input.
    // Catching it and responding 500 (rather than letting it escape as an
    // uncaught rejection) preserves Stripe's retry contract: a non-2xx means
    // "try again later."
    try {
      const db = getFirestore();
      const eventRef = db.doc(`stripeEvents/${event.id}`);
      const now = Date.now();
      // Claim machine: create-if-absent, OR re-claim a STALE in-flight claim
      // (processed:false and older than STALE_CLAIM_MS). A fresh, still
      // in-flight claim, or an already-processed one, both fail to claim —
      // that's the "duplicate" response.
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(eventRef);
        const d = snap.data();
        const staleInFlight = d?.processed === false && (d?.receivedAt ?? 0) < now - STALE_CLAIM_MS;
        if (snap.exists && !staleInFlight) return false;
        tx.set(eventRef, {
          type: event.type, receivedAt: now, processed: false,
          expireAt: now + EVENT_RETENTION_MS,
        });
        return true;
      });
      if (!claimed) { res.status(200).send("duplicate"); return; }

      const handler = webhookHandlers[event.type];
      let handlerFailed = false;
      if (handler) {
        try {
          await handler(event.data.object, event.id);
        } catch (e) {
          handlerFailed = true;
          console.error(`stripeWebhook: handler for ${event.type} failed (event ${event.id})`, e);
        }
      }
      // Shared flag-write for both the "handler succeeded" and "no
      // handler/unknown type" paths — but skipped entirely on handlerFailed:
      // a failed handler must leave processed:false so the claim above stays
      // reclaimable once STALE_CLAIM_MS elapses. No delete here (that would
      // discard the audit row, per the review that replaced the old
      // delete-on-failure behavior) — just never flip the flag.
      if (!handlerFailed) {
        try {
          await eventRef.update({ processed: true, processedAt: Date.now() });
        } catch (e) {
          console.error(`stripeWebhook: failed to mark event ${event.id} processed`, e);
        }
      }
      if (handlerFailed) { res.status(500).send("handler failed"); return; }
      res.status(200).send("ok");
    } catch (e) {
      console.error(`stripeWebhook: unhandled error processing event ${event.id}`, e);
      res.status(500).send("internal error");
    }
  });

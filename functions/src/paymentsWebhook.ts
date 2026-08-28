import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId } from "@gatekeep/shared";
import { getStripe, stripeSecretKey, stripeWebhookSecret, StripeWebhookSecretMissingError } from "./stripeClient.js";

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
//  - payment_intent.succeeded -> dispatched by metadata.purpose (see
//    paymentIntentSucceededHandlers below): "deposit" -> Task 6 (accept saga
//    completion), "settlement" -> Task 10, "paydue" / "paydue_deposit" ->
//    Task 11
//  - payment_intent.payment_failed -> recorded no-op (see below)
//  - payout.paid/payout.failed -> Task 13, registered in paymentsPayouts.ts
//    beside requestPayout, which writes the REQUEST-time ledger row these two
//    record the outcome of (`payout.paid` is a logged no-op for exactly that
//    reason; `payout.failed` writes the money-came-back row and notifies)
//  - transfer.reversed      -> Task 12, registered in paymentsSettlement.ts
//    beside the clawback whose reversals it dedupes against (ledger only —
//    it writes no document state)
// Unknown/unhandled types: record the event doc, 200 OK (Stripe requires 2xx
// or it retries forever).
//
// `account` (M1, branch audit): the event's top-level connected-account marker
// (present on a Connect event, absent on a platform event), threaded through by
// the dispatcher. Handlers that must be platform-only (payment_intent.succeeded)
// or account-pinned (account.updated / payout.*) read it; the rest ignore it.
export type WebhookHandler = (object: Record<string, unknown>, eventId: string, account?: string) => Promise<void>;
export const webhookHandlers: Record<string, WebhookHandler> = {};

// payment_intent.succeeded is the ONE event type several unrelated SP5 sagas
// all listen for (Task 6's accept deposit, Task 10's settlement, Task 11's
// payPastDue) — they're told apart by the intent's own
// `metadata.purpose`, which every SP5 charge stamps. A single registry keyed
// by purpose keeps those additive: each task registers its own purpose
// instead of overwriting a shared `webhookHandlers["payment_intent.succeeded"]`
// (last import wins, silently).
//
// THE FULL PURPOSE VOCABULARY (every `meta.purpose` SP5 stamps, and where its
// handler — if any — is registered):
//   HANDLED, because the money is a saga that can finish out-of-band:
//     "deposit"        -> bookings.ts            (accept saga, transaction B)
//     "settlement"     -> paymentsSettlement.ts  (the T+3 charge's tail)
//     "paydue"         -> paymentsSettlement.ts  (payPastDue, settlement debt)
//     "paydue_deposit" -> paymentsSettlement.ts  (payPastDue, deposit debt)
//   METADATA-ONLY, with NO handler BY DESIGN — these are not charges a saga
//   waits on, they are outbound moves that either completed synchronously or
//   have no follow-up state to write. The metadata exists as a RECOVERY
//   HANDLE (Task 8's note: look an object up by {bookingId, gigId, purpose}
//   when a key has expired) and for dashboard filtering, not for dispatch:
//     "earnings", "forfeit"                  (transferToAccount)
//     "deposit_refund", "below_deposit_refund", "accept_abort"  (refund)
//     "payout"                               (Task 13 createPayout — its own
//                                             payout.paid/failed events are
//                                             handled, but not through here)
//     "payout_fee"                           (Task 13 debitConnectedAccount)
//   A payment_intent.succeeded carrying one of these would be a bug elsewhere
//   (none of them creates a PaymentIntent), and the dispatcher's no-handler
//   branch logs it rather than throwing.
//
// NAMING: purposes are snake_case, one word or two. `paydue_deposit` was
// briefly hyphenated and was renamed while nothing was deployed — the tag is
// persisted on Stripe objects, so a rename after go-live would strand every
// in-flight intent whose metadata still carried the old spelling, with no
// handler to finalize it. Add new purposes in snake_case.
export const paymentIntentSucceededHandlers: Record<string, WebhookHandler> = {};

webhookHandlers["payment_intent.succeeded"] = async (object, eventId, account) => {
  // M1 (branch audit): a payment_intent.succeeded carrying a top-level `account`
  // is a CONNECTED ACCOUNT's PaymentIntent — never one of ours to finalize.
  // Every SP5 charge (deposit / settlement / pay-now) is a PLATFORM charge,
  // created without `stripeAccount`, so its success event carries no `account`.
  // Finalizing a connected-account intent by its `metadata.purpose` would let a
  // connected account (Express today; a future Standard or otherwise
  // metadata-bearing account is the real threat) forge a settlement/earnings
  // move by minting a PI we would then act on. Not an error — log it, and return
  // so the outer handler records the event processed (leaving it unprocessed
  // would have Stripe redeliver it forever).
  if (account) {
    console.warn(
      `payment_intent.succeeded: ignoring connected-account intent ${String(object.id)} on account ${account} (event ${eventId})`);
    return;
  }
  const purpose = (object.metadata as Record<string, string> | undefined)?.purpose;
  // L7 (branch audit): hasOwnProperty, not a bare index — a metadata.purpose of
  // "constructor"/"toString" must resolve to "no handler", never to an inherited
  // Object.prototype function. Same idiom validation.ts documents for its own
  // lookups.
  const handler = purpose && Object.prototype.hasOwnProperty.call(paymentIntentSucceededHandlers, purpose)
    ? paymentIntentSucceededHandlers[purpose] : undefined;
  if (!handler) {
    // Not an error: Stripe sends this event for every intent we create, and
    // some (e.g. an on-session intent whose callable already finalized it)
    // have no out-of-band work to do. Logged, not thrown — throwing would
    // leave the event unprocessed and Stripe retrying it forever.
    console.info(`payment_intent.succeeded: no handler for purpose ${JSON.stringify(purpose ?? null)} (event ${eventId})`);
    return;
  }
  await handler(object, eventId);
};

// RECORDED NO-OP, on purpose. Every decline SP5 cares about is handled
// synchronously where it happens — chargeOffSession throws
// StripeCardDeclinedError and the caller's own saga decides (unstage the
// accept, dun the deposit, walk the settlement ladder) — so there is nothing
// for an out-of-band handler to do, and an on-session intent the curator fails
// to confirm simply stays unconfirmed.
//
// Registering it anyway buys two things: the spec's listed event set is
// complete rather than silently falling through to the "no handler" branch,
// and every delivery still lands a `stripeEvents/{id}` doc (written by the
// claim machine above, before dispatch) so a dashboard can audit decline
// volume. Deliberately writes NO ledger row — nothing moved.
webhookHandlers["payment_intent.payment_failed"] = async (object, eventId) => {
  const meta = object.metadata as Record<string, string> | undefined;
  console.info(
    `payment_intent.payment_failed: recorded, no action — intent=${String(object.id)}, purpose=${JSON.stringify(meta?.purpose ?? null)} (event ${eventId})`);
};

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
// instance crashed mid-handler, the container was recycled, etc. — must not
// block that event id forever. This function doesn't set `timeoutSeconds`,
// so it runs under Cloud Functions v2's 60s default: an instance still "in
// flight" past that can no longer possibly be the one that made the claim.
// STALE_CLAIM_MS (10 min) is a generous multiple of that guarantee — it is
// NOT sized around Stripe's retry cadence. It's the backstop for an UNKNOWN
// death (we never found out the handler failed). A KNOWN failure doesn't
// wait for this at all: see failedAt below, which lets the very next
// delivery re-claim immediately. Re-claiming (either path) stamps a FRESH
// receivedAt, so the new attempt gets its own stale-claim window.
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
    let event: { id: string; type: string; account?: string; data: { object: Record<string, unknown> } };
    try {
      event = stripe.constructWebhookEvent(req.rawBody, sigHeader);
    } catch (e) {
      // H3 (branch audit): a MISCONFIGURED endpoint (no signing secret) is not a
      // bad signature — it is our own operational fault, and it must be LOUD (a
      // 500 an operator sees) rather than indistinguishable from an attacker's
      // forged request. Stripe retries a 500, so a genuine delivery is not lost
      // once the secret is fixed; a forged one still gets the flat 400 below.
      if (e instanceof StripeWebhookSecretMissingError) {
        console.error("stripeWebhook: STRIPE_WEBHOOK_SECRET is not configured — cannot verify signatures; refusing", e);
        res.status(500).send("webhook misconfigured");
        return;
      }
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
      // Claim machine: create-if-absent, OR re-claim when either:
      //  - the existing claim is a KNOWN failure (failedAt set by the
      //    handler-failure catch below) — re-claim immediately, no waiting;
      //  - the existing claim is still processed:false with no failedAt and
      //    has gone STALE (receivedAt older than STALE_CLAIM_MS) — an
      //    unknown death (crash, recycle) rather than a reported failure.
      // A fresh, still in-flight claim (processed:false, no failedAt, not
      // stale) or an already-processed claim both fail to claim — that's the
      // "duplicate" response. Either re-claim path preserves firstReceivedAt
      // (first-ever claim time) and increments attempts — an audit trail for
      // repeatedly-failing events — while overwriting (and thus clearing)
      // any prior failedAt.
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(eventRef);
        const d = snap.data();
        const knownFailed = d?.processed === false && d?.failedAt != null;
        const staleInFlight = d?.processed === false && (d?.receivedAt ?? 0) < now - STALE_CLAIM_MS;
        const canClaim = !snap.exists || knownFailed || staleInFlight;
        if (!canClaim) return false;
        tx.set(eventRef, {
          type: event.type, receivedAt: now, processed: false,
          expireAt: now + EVENT_RETENTION_MS,
          firstReceivedAt: d?.firstReceivedAt ?? now,
          attempts: (d?.attempts ?? 0) + 1,
        });
        return true;
      });
      if (!claimed) { res.status(200).send("duplicate"); return; }

      // L7 (branch audit): hasOwnProperty, not a bare index — an event.type of
      // "constructor"/"toString"/"__proto__" must resolve to the "no handler"
      // (unknown type) path, never to an inherited Object.prototype function.
      const handler = Object.prototype.hasOwnProperty.call(webhookHandlers, event.type)
        ? webhookHandlers[event.type] : undefined;
      let handlerFailed = false;
      if (handler) {
        try {
          // M1 (branch audit): thread the connected-account marker so the
          // platform-only / account-pinned handlers can enforce it.
          await handler(event.data.object, event.id, event.account);
        } catch (e) {
          handlerFailed = true;
          console.error(`stripeWebhook: handler for ${event.type} failed (event ${event.id})`, e);
          // Mark the failure so the VERY NEXT delivery re-claims immediately
          // (see the claim transaction above) instead of waiting out
          // STALE_CLAIM_MS. If this write itself fails, STALE_CLAIM_MS is
          // still the backstop — never a silent swallow either way.
          try {
            await eventRef.update({ failedAt: Date.now() });
          } catch (markErr) {
            console.error(`stripeWebhook: failed to mark event ${event.id} failedAt`, markErr);
          }
        }
      }
      // Shared flag-write for both the "handler succeeded" and "no
      // handler/unknown type" paths — but skipped entirely on handlerFailed:
      // a failed handler must leave processed:false so the claim above stays
      // reclaimable (immediately, via failedAt). No delete here (that would
      // discard the audit row) — just never flip the flag.
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
      if (!res.headersSent) res.status(500).send("internal error");
    }
  });

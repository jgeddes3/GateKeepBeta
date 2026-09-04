import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// H1 (branch audit), the stripe-secret regression guard.
//
// getStripe() FAILS CLOSED outside the emulator (stripeClient.ts): a deployed
// onCall/onRequest/onSchedule whose transitive call graph reaches getStripe()
// but does NOT declare `secrets: [stripeSecretKey]` cannot resolve the key and
// throws. So every getStripe()-reaching handler MUST list the secret.
//
// A precise static call-graph walk across the whole module graph is too fragile
// to encode in a test (a regex-level cross-file reachability analysis breaks on
// the first re-export or indirection), so, per the audit's own guidance, this
// ENUMERATES the verified getStripe()-reaching handler set (each entry established
// by reading its call graph during the audit) and asserts:
//   1. every listed handler declares stripeSecretKey in its options, AND
//   2. the set of handlers that declare stripeSecretKey is EXACTLY this set.
// (2) is the drift tripwire: it fails if the secret is removed from any listed
// handler (it drops out of the discovered set) OR if some OTHER handler starts
// declaring it without being listed here (forcing a human to confirm the new
// handler's call graph and add it). The one case neither clause catches, a
// BRAND-NEW getStripe()-reaching handler that forgets the secret entirely, is
// caught at RUNTIME by getStripe()'s fail-closed throw, which stripeClient.test.ts
// pins directly. A full census of every handler (to catch that statically) was
// rejected as too brittle: it would break on every unrelated callable added
// anywhere in the codebase.
//
// NOTE on the two handlers the audit's prose listed but this set omits: offerGig
// and confirmOccurrenceActuals do NOT reach getStripe() (offerGig only creates a
// booking request; confirmOccurrenceActuals only writes a true-up in a
// transaction, verified by reading both call graphs), so neither declares the
// secret and neither belongs here.
const STRIPE_REACHING: ReadonlyArray<{ name: string; file: string; why: string }> = [
  { name: "acceptBooking", file: "bookings.ts", why: "the accept saga charges the deposit off-session (getStripe().chargeOffSession)" },
  { name: "createSetupIntent", file: "payments.ts", why: "creates a Stripe customer + SetupIntent" },
  { name: "refreshPaymentMethod", file: "payments.ts", why: "resolves and pins the default payment method" },
  { name: "createOnboardingLink", file: "payments.ts", why: "creates the Express account + onboarding link" },
  { name: "getStripeStatus", file: "payments.ts", why: "reads account state and balances" },
  { name: "payPastDue", file: "payments.ts", why: "mints the on-session pay-now intent" },
  { name: "requestPayout", file: "paymentsPayouts.ts", why: "createPayout / debitConnectedAccount" },
  { name: "cancelBooking", file: "bookingLifecycle.ts", why: "executeCancellation -> resolveDepositPending (refund/forfeit executor)" },
  { name: "cancelOccurrence", file: "bookingLifecycle.ts", why: "resolveDepositPending (refund/forfeit executor)" },
  { name: "reportNoShow", file: "bookingLifecycle.ts", why: "resolveDepositPending AND clawbackSettledOccurrence" },
  { name: "pauseSeries", file: "gigSeries.ts", why: "cancelActiveRunBookingTolerant -> executeCancellation -> resolveDepositPending" },
  { name: "endSeries", file: "gigSeries.ts", why: "cancelActiveRunBookingTolerant -> executeCancellation -> resolveDepositPending" },
  { name: "stripeWebhook", file: "paymentsWebhook.ts", why: "onRequest, dispatches every SP5 money finalizer" },
  { name: "paymentsSweep", file: "paymentsSweep.ts", why: "onSchedule: the T+3 charge / dunning / deposit sweep, also the SP6 ticket-order expiry step's getStripe().cancelIntent and Task 6's cancelled-event retry step (refundOrdersForCancelledEvent -> getStripe().refund / cancelIntent)" },
  { name: "createTicketOrder", file: "ticketing.ts", why: "SP6 Task 5: mints the ticket checkout PaymentIntent (getStripe().createIntent)" },
  { name: "finalizeTicketOrder", file: "ticketing.ts", why: "SP6 Task 5: verifies the PaymentIntent status (getStripe().retrieveIntentStatus)" },
  { name: "cancelEvent", file: "events.ts", why: "SP6 Task 6: refundOrdersForCancelledEvent -> getStripe().refund / cancelIntent" },
  { name: "refundTicket", file: "ticketing.ts", why: "SP6 Task 6: the curator grace refund -> getStripe().refund" },
  { name: "reviewProfile", file: "review.ts", why: "SP10 Task 10: reject-from-approved cascades to cancelAndRefundEventForModeration -> refundOrdersForCancelledEvent -> getStripe().refund / cancelIntent" },
  { name: "dailySweep", file: "scheduled.ts", why: "SP10 Task 10, step 9: drainEventCascadeRetries -> cancelAndRefundEventForModeration -> refundOrdersForCancelledEvent -> getStripe().refund / cancelIntent" },
  { name: "takedownEvent", file: "eventsAdmin.ts", why: "SP10 Task 11: admin takedown -> cancelAndRefundEventForModeration -> refundOrdersForCancelledEvent -> getStripe().refund / cancelIntent" },
  { name: "deleteProfile", file: "profiles.ts", why: "SP10 Task 12: the money gate's assertNoMoneyOutstanding calls getStripe().getBalances on a connected account" },
  { name: "cancelTicketOrder", file: "ticketing.ts", why: "SP10 Task 21: releasePendingOrder -> getStripe().cancelIntent / retrieveIntentStatus" },
  { name: "ticketOrderExpiry", file: "paymentsSweep.ts", why: "SP10 Task 21: onSchedule every 5 minutes, runTicketOrderExpiry -> getStripe().cancelIntent" },
  { name: "createMemberOnboardingLink", file: "memberPayouts.ts", why: "SP5c Task 4: creates the member's own Express account + onboarding link (getStripe().createExpressAccount / createOnboardingLink)" },
  { name: "getMemberPayoutStatus", file: "memberPayouts.ts", why: "SP5c Task 4: syncMemberAccountFlags -> getStripe().getAccountState, readPayoutBalances -> getStripe().getBalances, and the held-share release's transferToAccount" },
  { name: "requestMemberPayout", file: "memberPayouts.ts", why: "SP5c Task 4: getStripe().getBalances / createPayout / debitConnectedAccount for a member's own cash-out" },
];

// NOT enumerated here, deliberately: `onMemberStripeWritten` (payoutShares.ts)
// is an `onDocumentWritten` FIRESTORE TRIGGER, and HANDLER_RE below walks only
// onCall/onRequest/onSchedule exports. It reaches getStripe() through
// releaseHeldShares and DOES declare `secrets: [stripeSecretKey]` (SP5c final
// fix wave, C1); widening the regex to trigger exports would need every other
// trigger in the codebase audited for the same question, which is the census
// this file's header already rejects as too brittle.

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const HANDLER_RE = /export const (\w+)\s*=\s*(onCall|onRequest|onSchedule)\b/g;

// The options object of a `onCall(OPTIONS, async (req) => …)` declaration is
// everything between the handler's name and the FIRST `async (` (the handler
// function) after it, options never contain `async (`, and each declaration's
// own handler is the next one. Returns null if no handler function follows
// (shouldn't happen for a real declaration).
function optionsSlice(src: string, declStart: number): string | null {
  const asyncAt = src.slice(declStart).search(/async\s*\(/);
  if (asyncAt === -1) return null;
  return src.slice(declStart, declStart + asyncAt);
}

interface Handler { name: string; file: string; declaresStripeSecret: boolean; }

function allHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const file of readdirSync(SRC_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(path.join(SRC_DIR, file), "utf8");
    for (const m of src.matchAll(HANDLER_RE)) {
      const opts = optionsSlice(src, m.index!);
      out.push({
        name: m[1], file,
        // `secrets: [ … stripeSecretKey … ]`, we only need the token's presence
        // in the options object; every SP5 declaration writes it literally.
        declaresStripeSecret: opts != null && /\bstripeSecretKey\b/.test(opts),
      });
    }
  }
  return out;
}

describe("H1, stripe secret declarations (branch audit regression guard)", () => {
  const handlers = allHandlers();
  const byName = new Map(handlers.map((h) => [h.name, h]));

  it.each(STRIPE_REACHING)(
    "$name ($file) declares secrets: [stripeSecretKey], reaches getStripe() because: $why",
    ({ name, file }) => {
      const h = byName.get(name);
      expect(h, `expected an exported onCall/onRequest/onSchedule named ${name}`).toBeTruthy();
      expect(h!.file, `${name} moved files, update STRIPE_REACHING`).toBe(file);
      expect(
        h!.declaresStripeSecret,
        `${name} (${file}) reaches getStripe() but its options do not declare secrets: [stripeSecretKey], `
        + "getStripe() will fail closed in production",
      ).toBe(true);
    });

  it("the set of handlers declaring stripeSecretKey is EXACTLY the verified getStripe()-reaching set (drift tripwire)", () => {
    const declaring = handlers.filter((h) => h.declaresStripeSecret).map((h) => h.name).sort();
    const expected = STRIPE_REACHING.map((h) => h.name).sort();
    // A mismatch means either a listed handler LOST the secret, or a handler NOT
    // in STRIPE_REACHING gained it, in the latter case, verify its call graph
    // actually reaches getStripe() and add it here (with the `why`), or remove
    // the stray secret if it doesn't.
    expect(declaring).toEqual(expected);
  });
});

// SP10 Task 4 (sp5 #3): the webhook verifies against TWO signing secrets, one
// per Stripe endpoint scope ("Your account" and "Connected accounts"). Both
// must be declared on stripeWebhook or a deployed function cannot resolve them.
describe("SP10 Task 4: stripeWebhook declares both webhook signing secrets", () => {
  it("stripeWebhook lists stripeWebhookSecret AND stripeConnectWebhookSecret", () => {
    const src = readFileSync(path.join(SRC_DIR, "paymentsWebhook.ts"), "utf8");
    const decl = src.search(/export const stripeWebhook\s*=\s*onRequest\b/);
    expect(decl).toBeGreaterThanOrEqual(0);
    const opts = optionsSlice(src, decl);
    expect(opts).not.toBeNull();
    expect(/\bstripeWebhookSecret\b/.test(opts!)).toBe(true);
    expect(/\bstripeConnectWebhookSecret\b/.test(opts!)).toBe(true);
  });

  it("stripeClient.ts defines the Connect secret with the fixed name", () => {
    const src = readFileSync(path.join(SRC_DIR, "stripeClient.ts"), "utf8");
    expect(src).toContain('export const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET")');
  });
});

import { describe, it, expect } from "vitest";
import { LAUNCH_TIMEZONE } from "@gatekeep/shared";
import { dailySweep } from "../src/scheduled.js";
import { paymentsSweep, ticketOrderExpiry } from "../src/paymentsSweep.js";
import { stripeWebhook } from "../src/paymentsWebhook.js";

// SP10 Task 24 (cross-cutting #17): deploy options are data on the function
// object (firebase-functions' __endpoint manifest), so the rulings are
// pinned here instead of trusted to a code-review glance. Pure: no emulator.
describe("deployed function options (SP10 Task 24)", () => {
  it("dailySweep retries 3 times and runs its 09:00 slot in LAUNCH_TIMEZONE", () => {
    const trigger = dailySweep.__endpoint.scheduleTrigger;
    expect(trigger?.schedule).toBe("every day 09:00");
    expect(trigger?.timeZone).toBe(LAUNCH_TIMEZONE);
    expect(trigger?.retryConfig?.retryCount).toBe(3);
  });

  it("paymentsSweep and ticketOrderExpiry retry 3 times", () => {
    expect(paymentsSweep.__endpoint.scheduleTrigger?.retryConfig?.retryCount).toBe(3);
    expect(ticketOrderExpiry.__endpoint.scheduleTrigger?.schedule).toBe("every 5 minutes");
    expect(ticketOrderExpiry.__endpoint.scheduleTrigger?.retryConfig?.retryCount).toBe(3);
  });

  it("stripeWebhook has a 120 s timeout", () => {
    expect(stripeWebhook.__endpoint.timeoutSeconds).toBe(120);
  });

  // Task 24 review: stripeSecrets.test.ts reads the SOURCE text of
  // paymentsWebhook.ts for the same three names; this reads the deployed
  // MANIFEST instead, so a secret that is written in the options object but
  // never reaches the endpoint (a wrong param object, a stale build) still
  // fails here. Both halves are cheap and neither subsumes the other.
  it("stripeWebhook declares all three Stripe secrets on its endpoint", () => {
    const keys = (stripeWebhook.__endpoint.secretEnvironmentVariables ?? []).map((s) => s.key).sort();
    expect(keys).toEqual(["STRIPE_CONNECT_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  });
});

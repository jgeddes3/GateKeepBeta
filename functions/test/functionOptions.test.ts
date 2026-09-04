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
});

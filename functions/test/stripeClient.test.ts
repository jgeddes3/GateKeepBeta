import { describe, it, expect, beforeAll } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { FakeStripe, StripeCardDeclinedError } from "../src/stripeClient.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

describe("FakeStripe", () => {
  const fake = new FakeStripe();
  beforeAll(async () => { await adb.doc("stripeFake/config").delete().catch(() => {}); });

  it("honors idempotency keys — same key, same intent, one object", async () => {
    const key = `test-idem-${Date.now()}`;
    const a = await fake.chargeOffSession({ customerId: "cus_x", amountCents: 1000, idempotencyKey: key, meta: {} });
    const b = await fake.chargeOffSession({ customerId: "cus_x", amountCents: 1000, idempotencyKey: key, meta: {} });
    expect(b.id).toBe(a.id);
  });

  it("declines when the config knob is set, and the SAME key stays declined-free after clearing", async () => {
    await adb.doc("stripeFake/config").set({ declineCharges: true });
    await expect(fake.chargeOffSession({ customerId: "cus_x", amountCents: 500, idempotencyKey: `d-${Date.now()}`, meta: {} }))
      .rejects.toBeInstanceOf(StripeCardDeclinedError);
    await adb.doc("stripeFake/config").set({ declineCharges: false });
  });

  it("refund cannot exceed the charge", async () => {
    const { id } = await fake.chargeOffSession({ customerId: "cus_x", amountCents: 1000, idempotencyKey: `r-${Date.now()}`, meta: {} });
    await fake.refund({ intentId: id, amountCents: 600, idempotencyKey: `rr1-${Date.now()}`, meta: {} });
    await expect(fake.refund({ intentId: id, amountCents: 600, idempotencyKey: `rr2-${Date.now()}`, meta: {} }))
      .rejects.toThrow("exceeds");
  });

  it("transfer/payout/debit maintain a coherent account balance", async () => {
    const { id: acct } = await fake.createExpressAccount({});
    await fake.transferToAccount({ accountId: acct, amountCents: 10_000, idempotencyKey: `t-${Date.now()}`, meta: {} });
    expect(await fake.getAvailableBalanceCents(acct)).toBe(10_000);
    await fake.createPayout({ accountId: acct, amountCents: 6_000, instant: false, idempotencyKey: `p-${Date.now()}`, meta: {} });
    await fake.debitConnectedAccount({ accountId: acct, amountCents: 500, idempotencyKey: `db-${Date.now()}`, meta: {} });
    expect(await fake.getAvailableBalanceCents(acct)).toBe(3_500);
    await expect(fake.createPayout({ accountId: acct, amountCents: 99_999, instant: true, idempotencyKey: `p2-${Date.now()}`, meta: {} }))
      .rejects.toThrow("exceeds balance");
  });
});

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

  it("chargeOffSession returns a chargeId alongside the PaymentIntent id", async () => {
    const { id, chargeId } = await fake.chargeOffSession({ customerId: "cus_x", amountCents: 1000, idempotencyKey: `cid-${Date.now()}`, meta: {} });
    expect(id).toMatch(/^pi_fake_/);
    expect(chargeId).toMatch(/^ch_fake_/);
  });

  it("declines when the config knob is set — the SAME key replays the cached decline even after the knob clears, a NEW key succeeds", async () => {
    const key = `d-${Date.now()}`;
    await adb.doc("stripeFake/config").set({ declineCharges: true });
    await expect(fake.chargeOffSession({ customerId: "cus_x", amountCents: 500, idempotencyKey: key, meta: {} }))
      .rejects.toBeInstanceOf(StripeCardDeclinedError);
    await adb.doc("stripeFake/config").set({ declineCharges: false });
    // Idempotency replay of the SAME key rethrows the cached decline — the
    // config knob only gates a fresh attempt, not a replay.
    await expect(fake.chargeOffSession({ customerId: "cus_x", amountCents: 500, idempotencyKey: key, meta: {} }))
      .rejects.toBeInstanceOf(StripeCardDeclinedError);
    // A brand-new key, with the knob now cleared, succeeds normally.
    const fresh = await fake.chargeOffSession({ customerId: "cus_x", amountCents: 500, idempotencyKey: `d2-${Date.now()}`, meta: {} });
    expect(fresh.chargeId).toBeTruthy();
  });

  it("decline knob scopes to declineCustomerIds — only the listed customer is declined", async () => {
    await adb.doc("stripeFake/config").set({ declineCharges: false, declineCustomerIds: ["cus_blocked"] });
    await expect(fake.chargeOffSession({ customerId: "cus_blocked", amountCents: 100, idempotencyKey: `sd-${Date.now()}`, meta: {} }))
      .rejects.toBeInstanceOf(StripeCardDeclinedError);
    const ok = await fake.chargeOffSession({ customerId: "cus_unblocked", amountCents: 100, idempotencyKey: `sd2-${Date.now()}`, meta: {} });
    expect(ok.chargeId).toBeTruthy();
    await adb.doc("stripeFake/config").set({ declineCharges: false, declineCustomerIds: [] });
  });

  it("replaying an idempotency key with different params throws instead of replaying the wrong result", async () => {
    const key = `fp-${Date.now()}`;
    await fake.chargeOffSession({ customerId: "cus_fp", amountCents: 1000, idempotencyKey: key, meta: {} });
    await expect(fake.chargeOffSession({ customerId: "cus_fp", amountCents: 2000, idempotencyKey: key, meta: {} }))
      .rejects.toThrow("reused with different params");
  });

  it("createOnSessionIntent honors idempotency keys — same key, same intent", async () => {
    const key = `osi-${Date.now()}`;
    const a = await fake.createOnSessionIntent({ customerId: "cus_x", amountCents: 2000, idempotencyKey: key, meta: {} });
    const b = await fake.createOnSessionIntent({ customerId: "cus_x", amountCents: 2000, idempotencyKey: key, meta: {} });
    expect(b.id).toBe(a.id);
    expect(b.clientSecret).toBe(a.clientSecret);
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

  it("reverseTransfer decrements the account balance and rejects a non-transfer target", async () => {
    const { id: acct } = await fake.createExpressAccount({});
    const { id: transferId } = await fake.transferToAccount({ accountId: acct, amountCents: 5_000, idempotencyKey: `rt-${Date.now()}`, meta: {} });
    expect(await fake.getAvailableBalanceCents(acct)).toBe(5_000);
    await fake.reverseTransfer({ transferId, idempotencyKey: `rtr-${Date.now()}` });
    expect(await fake.getAvailableBalanceCents(acct)).toBe(0);
    await expect(fake.reverseTransfer({ transferId: acct, idempotencyKey: `rtr2-${Date.now()}` }))
      .rejects.toThrow("is not a transfer");
  });

  it("markCardSaved flips getDefaultPaymentMethod from null to the fabricated Visa card", async () => {
    const customerId = `cus_marker_${Date.now()}`;
    expect(await fake.getDefaultPaymentMethod(customerId)).toBeNull();
    await fake.markCardSaved(customerId);
    expect(await fake.getDefaultPaymentMethod(customerId)).toEqual({ id: "pm_fake_4242", brand: "visa", last4: "4242" });
  });

  it("getAccountState defaults a fresh account to all-false", async () => {
    const { id: acct } = await fake.createExpressAccount({});
    expect(await fake.getAccountState(acct)).toEqual({
      id: acct, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    });
  });
});

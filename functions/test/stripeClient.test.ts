import { describe, it, expect, beforeAll } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  FakeStripe, getStripe, isFakeStripe, StripeCardDeclinedError, StripePaymentPendingError,
  StripeAccountMissingError, StripeSetupIntentMismatchError,
} from "../src/stripeClient.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

describe("FakeStripe", () => {
  const fake = new FakeStripe();
  beforeAll(async () => { await adb.doc("stripeFake/config").delete().catch(() => {}); });

  // The two balance buckets come back together (getBalances); every assertion
  // below is about the standard one.
  const balanceOf = async (accountId: string) => (await fake.getBalances(accountId)).availableCents;

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

  it("pendingCustomerIds scopes StripePaymentPendingError, carries a real pollable intent id, and replays the SAME intent id on the SAME key", async () => {
    const customerId = `cus_pending_${Date.now()}`;
    await adb.doc("stripeFake/config").set(
      { declineCharges: false, declineCustomerIds: [], pendingCustomerIds: [customerId] }, { merge: true });
    const key = `pend-${Date.now()}`;
    let caught: unknown;
    try {
      await fake.chargeOffSession({ customerId, amountCents: 100, idempotencyKey: key, meta: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StripePaymentPendingError);
    const intentId = (caught as StripePaymentPendingError).intentId;
    expect(intentId).toMatch(/^pi_fake_/);
    // "Pollable" — the intent object the error points at actually exists,
    // in `processing`, exactly like the real PaymentIntent would.
    const snap = await adb.doc(`stripeFake/state/objects/${intentId}`).get();
    expect(snap.data()).toMatchObject({ status: "processing" });
    // Same key replays the SAME cached pending outcome — this is the actual
    // recovery contract StripePaymentPendingError's doc comment describes:
    // a retry can never observe a different intentId, so callers must key
    // off the ORIGINAL intentId (persisted, then finalized by the
    // payment_intent.succeeded webhook), not expect a retry to progress it.
    let replayed: unknown;
    try {
      await fake.chargeOffSession({ customerId, amountCents: 100, idempotencyKey: key, meta: {} });
    } catch (e) {
      replayed = e;
    }
    expect(replayed).toBeInstanceOf(StripePaymentPendingError);
    expect((replayed as StripePaymentPendingError).intentId).toBe(intentId);
    await adb.doc("stripeFake/config").set(
      { declineCharges: false, declineCustomerIds: [], pendingCustomerIds: [] }, { merge: true });
  });

  it("a same-key race between two concurrent chargeOffSession calls resolves to one intent id", async () => {
    const key = `race-${Date.now()}`;
    const [a, b] = await Promise.allSettled([
      fake.chargeOffSession({ customerId: "cus_race", amountCents: 100, idempotencyKey: key, meta: {} }),
      fake.chargeOffSession({ customerId: "cus_race", amountCents: 100, idempotencyKey: key, meta: {} }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const aId = a.status === "fulfilled" ? a.value.id : null;
    const bId = b.status === "fulfilled" ? b.value.id : null;
    expect(aId).toBe(bId);
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

  it("createIntent produces a customer-less intent with a clientSecret", async () => {
    const { id, clientSecret } = await fake.createIntent({ amountCents: 1500, idempotencyKey: `ci-${Date.now()}`, meta: {} });
    expect(id).toMatch(/^pi_fake_/);
    expect(clientSecret).toBe(`${id}_secret_fake`);
  });

  it("retrieveIntentStatus reads back a created intent's status, and throws for an unknown id", async () => {
    const { id } = await fake.createIntent({ amountCents: 500, idempotencyKey: `ris-${Date.now()}`, meta: {} });
    expect(await fake.retrieveIntentStatus(id)).toEqual({ status: "requires_confirmation" });
    await expect(fake.retrieveIntentStatus(`pi_never_existed_${Date.now()}`)).rejects.toThrow("unknown payment intent");
  });

  it("cancelIntent cancels a not-yet-succeeded intent, but refuses one that already succeeded (money always wins over expiry)", async () => {
    const { id: pendingId } = await fake.createIntent({ amountCents: 700, idempotencyKey: `cxi-${Date.now()}`, meta: {} });
    expect(await fake.cancelIntent(pendingId)).toEqual({ status: "canceled" });
    expect(await fake.retrieveIntentStatus(pendingId)).toEqual({ status: "canceled" });
    // A second cancel of an already-canceled intent is a no-op, not a throw.
    expect(await fake.cancelIntent(pendingId)).toEqual({ status: "canceled" });

    const { id: chargedId } = await fake.chargeOffSession(
      { customerId: "cus_cancel_test", amountCents: 800, idempotencyKey: `cxi2-${Date.now()}`, meta: {} });
    await expect(fake.cancelIntent(chargedId)).rejects.toThrow("already succeeded");
    expect(await fake.retrieveIntentStatus(chargedId)).toEqual({ status: "succeeded" }); // untouched
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
    expect(await balanceOf(acct)).toBe(10_000);
    await fake.createPayout({ accountId: acct, amountCents: 6_000, instant: false, idempotencyKey: `p-${Date.now()}`, meta: {} });
    await fake.debitConnectedAccount({ accountId: acct, amountCents: 500, idempotencyKey: `db-${Date.now()}`, meta: {} });
    expect(await balanceOf(acct)).toBe(3_500);
    await expect(fake.createPayout({ accountId: acct, amountCents: 99_999, instant: true, idempotencyKey: `p2-${Date.now()}`, meta: {} }))
      .rejects.toThrow("exceeds balance");
  });

  it("reverseTransfer decrements the account balance and rejects a non-transfer target", async () => {
    const { id: acct } = await fake.createExpressAccount({});
    const { id: transferId } = await fake.transferToAccount({ accountId: acct, amountCents: 5_000, idempotencyKey: `rt-${Date.now()}`, meta: {} });
    expect(await balanceOf(acct)).toBe(5_000);
    await fake.reverseTransfer({ transferId, idempotencyKey: `rtr-${Date.now()}` });
    expect(await balanceOf(acct)).toBe(0);
    await expect(fake.reverseTransfer({ transferId: acct, idempotencyKey: `rtr2-${Date.now()}` }))
      .rejects.toThrow("is not a transfer");
    // A second reversal of the SAME transfer (a new idempotencyKey, so this
    // isn't just idempotency replay) is refused outright.
    await expect(fake.reverseTransfer({ transferId, idempotencyKey: `rtr3-${Date.now()}` }))
      .rejects.toThrow("has already been reversed");
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

  it("getAccountState throws StripeAccountMissingError for an id with no object doc (review round 1, I2)", async () => {
    await expect(fake.getAccountState(`acct_never_existed_${Date.now()}`))
      .rejects.toBeInstanceOf(StripeAccountMissingError);
  });

  it("getSetupIntentPaymentMethod resolves the owning customer's card, is null before the card is saved, and throws on a customer mismatch", async () => {
    const customerId = `cus_seti_${Date.now()}`;
    const otherCustomerId = `cus_seti_other_${Date.now()}`;
    const { id: setupIntentId } = await fake.createSetupIntent(customerId);

    // No card saved yet for this customer.
    expect(await fake.getSetupIntentPaymentMethod(setupIntentId, customerId)).toBeNull();

    await fake.markCardSaved(customerId);
    expect(await fake.getSetupIntentPaymentMethod(setupIntentId, customerId))
      .toEqual({ id: "pm_fake_4242", brand: "visa", last4: "4242" });

    // A caller asserting this SetupIntent belongs to some OTHER customer is refused.
    await expect(fake.getSetupIntentPaymentMethod(setupIntentId, otherCustomerId))
      .rejects.toBeInstanceOf(StripeSetupIntentMismatchError);
  });

  it("getSetupIntentPaymentMethod returns null for an unknown setup intent id", async () => {
    expect(await fake.getSetupIntentPaymentMethod(`seti_never_existed_${Date.now()}`, "cus_x")).toBeNull();
  });
});

// L8 (branch audit): getStripe()'s selection must FAIL CLOSED — a deployed
// handler that forgot `secrets: [stripeSecretKey]` (so process.env has no key)
// and is NOT in the emulator must THROW rather than silently move FakeStripe's
// pretend money against real Firestore data. This is the runtime backstop behind
// the H1 secret-declaration guard (stripeSecrets.test.ts).
describe("getStripe() selection (fail-closed)", () => {
  // Save/restore the three env vars getStripe() reads, exactly (a var that was
  // unset must go back to unset, not to "undefined").
  function withEnv(mutate: () => void, body: () => void): void {
    const saved: Record<string, string | undefined> = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
    };
    try {
      mutate();
      body();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("throws OUTSIDE the emulator with no STRIPE_SECRET_KEY — never a silent FakeStripe fallback", () => {
    withEnv(() => {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.FUNCTIONS_EMULATOR;
      delete process.env.FIRESTORE_EMULATOR_HOST;
    }, () => {
      expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY is not configured/);
    });
  });

  it("selects FakeStripe inside the emulator (FIRESTORE_EMULATOR_HOST set, no key) rather than throwing", () => {
    withEnv(() => {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.FUNCTIONS_EMULATOR;
      process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    }, () => {
      expect(isFakeStripe(getStripe())).toBe(true);
    });
  });
});

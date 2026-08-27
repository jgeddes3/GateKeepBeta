/**
 * Stripe client layer — the ONLY Stripe surface SP5 code may touch.
 *
 * StripeLike is deliberately narrow (only what SP5 uses). FakeStripe backs
 * the emulator/tests and persists idempotency + created objects in
 * Firestore (`stripeFake/*` docs) so behavior is consistent across the
 * emulator's functions process AND the test process, and honors
 * idempotency keys exactly like Stripe (same key => same object back,
 * never a duplicate). RealStripe adapts the real Stripe SDK. getStripe()
 * selects between them the same way getGeocoder() does (see geocode.ts):
 * the fake unless a real secret key is configured.
 */

import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

// P5 pattern (see geocode.ts): Secret Manager-backed params. Every handler
// that can reach getStripe() MUST list `secrets: [stripeSecretKey]` (and the
// webhook additionally stripeWebhookSecret) in its options.
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

export interface ChargeResult { id: string; status: "succeeded" | "failed"; }
export interface StripeAccountState {
  id: string; transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
}

export class StripeCardDeclinedError extends Error {
  constructor(msg = "card_declined") { super(msg); this.name = "StripeCardDeclinedError"; }
}

// The ONLY Stripe surface SP5 code may touch. Everything takes integer cents.
export interface StripeLike {
  createCustomer(meta: Record<string, string>): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }>;
  getDefaultPaymentMethod(customerId: string): Promise<{ id: string; brand: string; last4: string } | null>;
  createExpressAccount(meta: Record<string, string>): Promise<{ id: string }>;
  createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }>;
  getAccountState(accountId: string): Promise<StripeAccountState>;
  // Off-session charge with a saved payment method. Throws
  // StripeCardDeclinedError on decline; same idempotencyKey ⇒ same result.
  chargeOffSession(params: {
    customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<ChargeResult>;
  // On-session intent the CLIENT confirms with Elements (payPastDue).
  createOnSessionIntent(params: {
    customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string; clientSecret: string }>;
  refund(params: { intentId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }): Promise<{ id: string }>;
  transferToAccount(params: {
    accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string }>;
  reverseTransfer(params: { transferId: string; idempotencyKey: string }): Promise<{ id: string }>;
  getAvailableBalanceCents(accountId: string): Promise<number>;
  createPayout(params: {
    accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string }>;
  // Account debit: pull the instant-cashout fee from the connected account
  // back to the platform.
  debitConnectedAccount(params: {
    accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string }>;
  // Webhook verification. Real: stripe.webhooks.constructEvent (throws on bad
  // signature). Fake: JSON.parse, signature ignored (emulator only).
  constructWebhookEvent(rawBody: string, signature: string): { id: string; type: string; data: { object: Record<string, unknown> } };
}

// ---------- FakeStripe (emulator/tests) ----------
// State lives in Firestore so the functions process and the test process see
// the same world. All paths below route through the private *Ref() helpers
// so the layout lives in exactly one place. `stripeFake/config` is a plain
// doc (collection `stripeFake`, doc `config` — 2 segments, valid). Every
// other kind of state hangs off a single holder doc `stripeFake/state` as a
// subcollection, since e.g. `stripeFake/objects/{id}` would only be a valid
// *document* path if `objects` were itself a document id, not a collection
// name — going one level deeper (`stripeFake/state/objects/{id}`) keeps an
// even segment count (collection/doc/collection/doc) while still reading as
// "objects", "idem", "cards" collections:
//   stripeFake/config               { declineCharges?: boolean }  (test knob, admin-SDK-written)
//   stripeFake/state/idem/{key}     { result }                    (idempotency replay)
//   stripeFake/state/objects/{id}   { kind, ... }                 (created objects, incl. account state)
//   stripeFake/state/cards/{custId} { saved: true }                (markCardSaved marker)
// Counters use doc ids derived from the idempotency key (deterministic), or a
// random doc id where no key applies.
export class FakeStripe implements StripeLike {
  private db = getFirestore();

  private idemRef(key: string) {
    return this.db.doc(`stripeFake/state/idem/${encodeURIComponent(key)}`);
  }
  private objRef(id: string) {
    return this.db.doc(`stripeFake/state/objects/${id}`);
  }
  private cardRef(customerId: string) {
    return this.db.doc(`stripeFake/state/cards/${customerId}`);
  }

  private async idem<T>(key: string, make: () => Promise<T>): Promise<T> {
    const ref = this.idemRef(key);
    const snap = await ref.get();
    if (snap.exists) return snap.data()!.result as T;
    const result = await make();
    await ref.set({ result });
    return result;
  }

  private async shouldDecline(): Promise<boolean> {
    const cfg = await this.db.doc("stripeFake/config").get();
    return cfg.data()?.declineCharges === true;
  }

  private newId(prefix: string): string {
    return `${prefix}_fake_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  }

  async createCustomer(meta: Record<string, string>) {
    const id = this.newId("cus");
    await this.objRef(id).set({ kind: "customer", meta });
    return { id };
  }
  async createSetupIntent(customerId: string) {
    const id = this.newId("seti");
    await this.objRef(id).set({ kind: "setup_intent", customerId });
    return { id, clientSecret: `${id}_secret_fake` };
  }
  async getDefaultPaymentMethod(customerId: string) {
    // Deterministic contract (see test + markCardSaved below): a marker doc
    // at stripeFake/state/cards/{customerId} decides whether this customer
    // has a saved Visa •••• 4242 card. Nothing else — no scanning of
    // created setup intents.
    const marker = await this.cardRef(customerId).get();
    return marker.exists ? { id: "pm_fake_4242", brand: "visa", last4: "4242" } : null;
  }
  // Test/webhook hook: the web SaveCardModal can't run against the fake, so
  // createSetupIntent's CALLER (payments.ts) immediately marks the card saved
  // when running on the fake — see payments.ts Task 4.
  async markCardSaved(customerId: string): Promise<void> {
    await this.cardRef(customerId).set({ saved: true });
  }
  async createExpressAccount(meta: Record<string, string>) {
    const id = this.newId("acct");
    await this.objRef(id).set({
      kind: "account", meta, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    });
    return { id };
  }
  async createOnboardingLink(accountId: string, returnUrl: string) {
    return { url: `https://fake.stripe/onboard/${accountId}?return=${encodeURIComponent(returnUrl)}` };
  }
  async getAccountState(accountId: string): Promise<StripeAccountState> {
    const snap = await this.objRef(accountId).get();
    const d = snap.data();
    return {
      id: accountId,
      transfersEnabled: d?.transfersEnabled === true,
      payoutsEnabled: d?.payoutsEnabled === true,
      instantEligible: d?.instantEligible === true,
    };
  }
  async chargeOffSession(p: { customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      if (await this.shouldDecline()) throw new StripeCardDeclinedError();
      const id = this.newId("pi");
      await this.objRef(id).set({
        kind: "payment_intent", amountCents: p.amountCents, customerId: p.customerId,
        meta: p.meta, refundedCents: 0, status: "succeeded",
      });
      return { id, status: "succeeded" as const };
    });
  }
  async createOnSessionIntent(p: { customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("pi");
      await this.objRef(id).set({
        kind: "payment_intent", amountCents: p.amountCents, customerId: p.customerId,
        meta: p.meta, refundedCents: 0, status: "requires_confirmation",
      });
      return { id, clientSecret: `${id}_secret_fake` };
    });
  }
  async refund(p: { intentId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const ref = this.objRef(p.intentId);
      const snap = await ref.get();
      if (!snap.exists) throw new Error(`FakeStripe: refund of unknown intent ${p.intentId}`);
      const d = snap.data()!;
      if ((d.refundedCents as number) + p.amountCents > (d.amountCents as number)) {
        throw new Error("FakeStripe: refund exceeds charge");
      }
      await ref.update({ refundedCents: (d.refundedCents as number) + p.amountCents });
      const id = this.newId("re");
      await this.objRef(id).set({ kind: "refund", intentId: p.intentId, amountCents: p.amountCents });
      return { id };
    });
  }
  async transferToAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("tr");
      await this.objRef(id).set({ kind: "transfer", ...p });
      // Track a running balance on the account object so
      // getAvailableBalanceCents/payouts behave coherently in tests.
      const acct = this.objRef(p.accountId);
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) + p.amountCents }, { merge: true });
      });
      return { id };
    });
  }
  async reverseTransfer(p: { transferId: string; idempotencyKey: string }) {
    return this.idem(p.idempotencyKey, async () => {
      const tSnap = await this.objRef(p.transferId).get();
      if (!tSnap.exists) throw new Error(`FakeStripe: reversal of unknown transfer ${p.transferId}`);
      const t = tSnap.data()!;
      const acct = this.objRef(t.accountId as string);
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - (t.amountCents as number) }, { merge: true });
      });
      const id = this.newId("trr");
      await this.objRef(id).set({ kind: "transfer_reversal", transferId: p.transferId });
      return { id };
    });
  }
  async getAvailableBalanceCents(accountId: string): Promise<number> {
    const snap = await this.objRef(accountId).get();
    return (snap.data()?.balanceCents as number | undefined) ?? 0;
  }
  async createPayout(p: { accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const balance = await this.getAvailableBalanceCents(p.accountId);
      if (p.amountCents > balance) throw new Error("FakeStripe: payout exceeds balance");
      const acct = this.objRef(p.accountId);
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - p.amountCents }, { merge: true });
      });
      const id = this.newId("po");
      await this.objRef(id).set({ kind: "payout", ...p });
      return { id };
    });
  }
  async debitConnectedAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const acct = this.objRef(p.accountId);
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - p.amountCents }, { merge: true });
      });
      const id = this.newId("adb");
      await this.objRef(id).set({ kind: "account_debit", ...p });
      return { id };
    });
  }
  constructWebhookEvent(rawBody: string): { id: string; type: string; data: { object: Record<string, unknown> } } {
    return JSON.parse(rawBody);
  }
}

// ---------- Real adapter ----------
export class RealStripe implements StripeLike {
  private s: Stripe;
  constructor(key: string) { this.s = new Stripe(key); }

  async createCustomer(meta: Record<string, string>) {
    const c = await this.s.customers.create({ metadata: meta });
    return { id: c.id };
  }
  async createSetupIntent(customerId: string) {
    const si = await this.s.setupIntents.create({ customer: customerId, usage: "off_session" });
    return { id: si.id, clientSecret: si.client_secret! };
  }
  async getDefaultPaymentMethod(customerId: string) {
    const pms = await this.s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    const pm = pms.data[0];
    if (!pm?.card) return null;
    return { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
  }
  async createExpressAccount(meta: Record<string, string>) {
    const a = await this.s.accounts.create({
      type: "express", metadata: meta,
      capabilities: { transfers: { requested: true } },
      settings: { payouts: { schedule: { interval: "manual" }, debit_negative_balances: true } },
    });
    return { id: a.id };
  }
  async createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
    const l = await this.s.accountLinks.create({
      account: accountId, type: "account_onboarding", return_url: returnUrl, refresh_url: refreshUrl,
    });
    return { url: l.url };
  }
  async getAccountState(accountId: string) {
    const a = await this.s.accounts.retrieve(accountId);
    return {
      id: accountId,
      transfersEnabled: a.capabilities?.transfers === "active",
      payoutsEnabled: a.payouts_enabled === true,
      // external_accounts with instant-eligible debit cards — approximated by
      // payouts_enabled + a card external account; refined post-launch.
      instantEligible: a.payouts_enabled === true
        && (a.external_accounts?.data ?? []).some((e) => e.object === "card"),
    };
  }
  async chargeOffSession(p: { customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    const pm = await this.getDefaultPaymentMethod(p.customerId);
    if (!pm) throw new StripeCardDeclinedError("no_payment_method");
    try {
      const pi = await this.s.paymentIntents.create({
        amount: p.amountCents, currency: "usd", customer: p.customerId,
        payment_method: pm.id, off_session: true, confirm: true, metadata: p.meta,
      }, { idempotencyKey: p.idempotencyKey });
      return { id: pi.id, status: pi.status === "succeeded" ? "succeeded" as const : "failed" as const };
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) throw new StripeCardDeclinedError();
      throw e;
    }
  }
  async createOnSessionIntent(p: { customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    const pi = await this.s.paymentIntents.create({
      amount: p.amountCents, currency: "usd", customer: p.customerId, metadata: p.meta,
      automatic_payment_methods: { enabled: true },
    }, { idempotencyKey: p.idempotencyKey });
    return { id: pi.id, clientSecret: pi.client_secret! };
  }
  async refund(p: { intentId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    const r = await this.s.refunds.create(
      { payment_intent: p.intentId, amount: p.amountCents, metadata: p.meta },
      { idempotencyKey: p.idempotencyKey });
    return { id: r.id };
  }
  async transferToAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    const t = await this.s.transfers.create(
      { amount: p.amountCents, currency: "usd", destination: p.accountId, metadata: p.meta },
      { idempotencyKey: p.idempotencyKey });
    return { id: t.id };
  }
  async reverseTransfer(p: { transferId: string; idempotencyKey: string }) {
    const r = await this.s.transfers.createReversal(p.transferId, {}, { idempotencyKey: p.idempotencyKey });
    return { id: r.id };
  }
  async getAvailableBalanceCents(accountId: string) {
    const b = await this.s.balance.retrieve({ stripeAccount: accountId });
    return b.available.filter((a) => a.currency === "usd").reduce((s, a) => s + a.amount, 0);
  }
  async createPayout(p: { accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string> }) {
    const po = await this.s.payouts.create(
      { amount: p.amountCents, currency: "usd", method: p.instant ? "instant" : "standard", metadata: p.meta },
      { stripeAccount: p.accountId, idempotencyKey: p.idempotencyKey });
    return { id: po.id };
  }
  async debitConnectedAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    // Connect "account debit": a charge against the connected account's
    // balance payable to the platform.
    const c = await this.s.charges.create(
      { amount: p.amountCents, currency: "usd", source: p.accountId, metadata: p.meta } as Stripe.ChargeCreateParams,
      { idempotencyKey: p.idempotencyKey });
    return { id: c.id };
  }
  constructWebhookEvent(rawBody: string, signature: string) {
    const evt = this.s.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret.value() || process.env.STRIPE_WEBHOOK_SECRET || "");
    return evt as unknown as { id: string; type: string; data: { object: Record<string, unknown> } };
  }
}

// Selection mirrors getGeocoder(): the fake unless a real key is configured.
// The emulator never provisions secrets, so .value() resolves "" there and
// the whole suite runs on FakeStripe with zero keys present.
export function getStripe(): StripeLike {
  const key = stripeSecretKey.value() || process.env.STRIPE_SECRET_KEY;
  if (key) return new RealStripe(key);
  return new FakeStripe();
}

export function isFakeStripe(s: StripeLike): s is FakeStripe {
  return s instanceof FakeStripe;
}

/**
 * Stripe client layer — the ONLY Stripe surface SP5 code may touch.
 *
 * StripeLike is deliberately narrow (only what SP5 uses). FakeStripe backs
 * the emulator/tests and persists idempotency + created objects in
 * Firestore (`stripeFake/*` docs) so behavior is consistent across the
 * emulator's functions process AND the test process, and honors
 * idempotency keys exactly like Stripe (same key => same object — or the
 * same error — back, never a duplicate attempt). RealStripe adapts the real
 * Stripe SDK. getStripe() selects between them the same way getGeocoder()
 * does (see geocode.ts), but FAILS CLOSED: outside the emulator, a missing
 * key is a configuration bug (a handler forgot `secrets: [stripeSecretKey]`)
 * and must throw, never silently fall back to fake money against real
 * Firestore data.
 */

import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

// P5 pattern (see geocode.ts): Secret Manager-backed params. Every handler
// that can reach getStripe() MUST list `secrets: [stripeSecretKey]` (and the
// webhook additionally stripeWebhookSecret) in its options.
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

export interface ChargeResult { id: string; chargeId: string | null; }
export interface StripeAccountState {
  id: string; transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
}

export class StripeCardDeclinedError extends Error {
  code?: string;
  constructor(msg = "card_declined", code?: string) {
    super(msg);
    this.name = "StripeCardDeclinedError";
    this.code = code;
  }
}

// A PaymentIntent that ended up `processing` instead of `succeeded` (e.g.
// some ACH-backed cards settle asynchronously). Recovery does NOT mean
// "retry chargeOffSession with the same idempotencyKey" — both RealStripe
// and FakeStripe replay this SAME cached `processing` outcome forever for
// that key (see FakeStripe.idem), so a same-key retry can never observe a
// different result. The actual recovery contract: the caller persists
// `intentId`, leaves its saga/booking marker in the "awaiting payment"
// state, and the `payment_intent.succeeded` webhook (see Tasks 3/6/11)
// finalizes the saga out-of-band once Stripe confirms the charge. This
// class only carries the shape callers need for that — it does not
// implement the recovery itself.
export class StripePaymentPendingError extends Error {
  intentId: string;
  constructor(intentId: string, msg = "payment_pending") {
    super(msg);
    this.name = "StripePaymentPendingError";
    this.intentId = intentId;
  }
}

// Review round 1 (I2): the Connect account behind a cached accountId was
// deleted (or never existed) on Stripe's side. Distinguishes "the account is
// gone" from any other transient/infra failure reading account state, so
// syncStripeAccountFlags can fail CLOSED (zero the gate flags) instead of
// either 500ing or silently defaulting to false with no signal.
export class StripeAccountMissingError extends Error {
  accountId: string;
  constructor(accountId: string) {
    super(`Stripe account ${accountId} not found (deleted or never existed)`);
    this.name = "StripeAccountMissingError";
    this.accountId = accountId;
  }
}

// Review round 1 (I1): a SetupIntent id supplied by the client to
// refreshPaymentMethod does not belong to the caller's own Stripe customer.
// Thrown instead of silently resolving a stranger's card — the callable
// translates this to failed-precondition.
export class StripeSetupIntentMismatchError extends Error {
  setupIntentId: string;
  constructor(setupIntentId: string, expectedCustomerId: string, actualCustomerId: string | null) {
    super(`SetupIntent ${setupIntentId} belongs to customer ${actualCustomerId ?? "(none)"}, not ${expectedCustomerId}`);
    this.name = "StripeSetupIntentMismatchError";
    this.setupIntentId = setupIntentId;
  }
}

// The ONLY Stripe surface SP5 code may touch. Everything takes integer cents.
export interface StripeLike {
  createCustomer(meta: Record<string, string>): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }>;
  getDefaultPaymentMethod(customerId: string): Promise<{ id: string; brand: string; last4: string } | null>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  // Resolves the payment method attached to a SPECIFIC SetupIntent — unlike
  // getDefaultPaymentMethod, this does not read the customer's current
  // default, so it's the right call right after Elements confirms a NEW
  // SetupIntent (the customer's default hasn't been repointed at it yet;
  // reading "default" here would re-resolve the OLD card — review round 1,
  // I1). Throws StripeSetupIntentMismatchError if the SetupIntent's customer
  // isn't `expectedCustomerId`. Returns null if the SetupIntent (or its
  // payment method) doesn't exist, or has no card attached.
  getSetupIntentPaymentMethod(
    setupIntentId: string, expectedCustomerId: string,
  ): Promise<{ id: string; brand: string; last4: string } | null>;
  createExpressAccount(meta: Record<string, string>): Promise<{ id: string }>;
  createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }>;
  // Throws StripeAccountMissingError when the account was deleted (or never
  // existed) on Stripe's side — callers must not treat that the same as an
  // account that simply hasn't finished onboarding.
  getAccountState(accountId: string): Promise<StripeAccountState>;
  // Off-session charge with a saved payment method. THROWS on every
  // non-succeeded outcome — callers can never ignore a failure:
  //   - StripeCardDeclinedError (carries an optional `code`, e.g.
  //     "insufficient_funds", "authentication_required") for a definite
  //     decline.
  //   - StripePaymentPendingError (carries `intentId`) when the intent is
  //     left `processing` — see that class's doc comment for the actual
  //     recovery contract; it is NOT "retry with the same key".
  // Same idempotencyKey ⇒ the same result, or the same modeled error,
  // replayed.
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
    // The originating charge, when there is one. Forwarded to Stripe as
    // source_transaction so the transfer draws against that charge's funds
    // directly instead of the platform's overall available balance —
    // avoids balance_insufficient against a charge that hasn't settled yet.
    sourceChargeId?: string;
  }): Promise<{ id: string }>;
  reverseTransfer(params: { transferId: string; idempotencyKey: string }): Promise<{ id: string }>;
  getAvailableBalanceCents(accountId: string): Promise<number>;
  // Instant-payout-eligible slice of the balance — a subset of
  // getAvailableBalanceCents (funds still settling aren't instant-eligible).
  getInstantAvailableBalanceCents(accountId: string): Promise<number>;
  createPayout(params: {
    accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string }>;
  // Account debit: pull the instant-cashout fee from the connected account
  // back to the platform.
  debitConnectedAccount(params: {
    accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>;
  }): Promise<{ id: string }>;
  // Webhook verification. Real: stripe.webhooks.constructEvent (throws on bad
  // signature). Fake: JSON.parse, signature ignored (emulator only). rawBody
  // is `string | Buffer` so callers can hand req.rawBody straight through —
  // Stripe's own SDK accepts either directly (constructEvent hashes the raw
  // bytes; converting to a string first is a needless extra step, and for a
  // real request rawBody is already a Buffer).
  constructWebhookEvent(rawBody: string | Buffer, signature: string): { id: string; type: string; data: { object: Record<string, unknown> } };
}

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  // The Admin SDK surfaces the underlying gRPC status as a numeric code (6 =
  // ALREADY_EXISTS); the string forms are a defensive fallback, not the
  // expected shape.
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// Only these count as "the endpoint executed and produced a modeled
// outcome" — the set of failures a real Stripe idempotency-key replay would
// also hand back verbatim. Anything else (a transient Firestore UNAVAILABLE
// mid-`make()`, a programmer error) means we don't actually know whether
// make()'s side effects committed, so FakeStripe.idem must NOT cache it —
// see the comment on idem() itself.
function isCacheableStripeError(e: unknown): boolean {
  if (e instanceof StripeCardDeclinedError || e instanceof StripePaymentPendingError) return true;
  return e instanceof Error && e.message.startsWith("FakeStripe:");
}

interface StoredError { name: string; message: string; code?: string; intentId?: string; }

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
//   stripeFake/config               { declineCharges?, declineCustomerIds?,  (test knob, admin-SDK-written)
//                                      pendingCustomerIds? }
//   stripeFake/state/idem/{key}     { result } | { error }, fingerprint      (idempotency replay)
//   stripeFake/state/objects/{id}   { kind, ... }                            (created objects, incl. account state)
//   stripeFake/state/cards/{custId} { saved: true }                          (markCardSaved marker)
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

  private serializeError(e: unknown): StoredError {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      const intentId = (e as { intentId?: unknown }).intentId;
      return {
        name: e.name, message: e.message,
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof intentId === "string" ? { intentId } : {}),
      };
    }
    return { name: "Error", message: String(e) };
  }

  private reconstructError(stored: StoredError): Error {
    if (stored.name === "StripeCardDeclinedError") return new StripeCardDeclinedError(stored.message, stored.code);
    if (stored.name === "StripePaymentPendingError") return new StripePaymentPendingError(stored.intentId ?? "", stored.message);
    const err = new Error(stored.message);
    err.name = stored.name;
    return err;
  }

  private replayIdem<T>(data: FirebaseFirestore.DocumentData, fingerprint?: string): T {
    const stored = data.fingerprint as string | null | undefined;
    if (fingerprint !== undefined && stored != null && stored !== fingerprint) {
      throw new Error("FakeStripe: idempotency key reused with different params");
    }
    if (data.error) throw this.reconstructError(data.error as StoredError);
    return data.result as T;
  }

  // Mirrors real Stripe idempotency semantics: same key replays the same
  // outcome — success OR a MODELED error — instead of re-running `make()`.
  // Deliberate divergences from the real thing:
  //   - keys never expire (real Stripe expires them after 24h); fine for
  //     tests, which mint fresh Date.now()-suffixed keys per case.
  //   - only modeled failures are cached (isCacheableStripeError, above) —
  //     an infra-level throw from make() rethrows UNCACHED so a retry with
  //     the same key re-executes, matching Stripe's "a response is only
  //     saved once the endpoint actually ran to completion" behavior.
  // `fingerprint` is an optional caller-supplied digest of the call's
  // interesting params. It's deliberately AMOUNT-scoped (e.g.
  // "customerId:amountCents"), not a hash of the full request body — that's
  // the cheapest signal that catches the realistic bug this guards against
  // (a key reused for a different amount) without over-fitting to exact
  // param shapes that will keep changing across SP5 tasks. Reusing a key
  // with a DIFFERENT fingerprint is a caller bug (key collision, not a
  // legitimate retry) and throws rather than silently replaying the wrong
  // result.
  private async idem<T>(key: string, make: () => Promise<T>, fingerprint?: string): Promise<T> {
    const ref = this.idemRef(key);
    const existing = await ref.get();
    if (existing.exists) return this.replayIdem<T>(existing.data()!, fingerprint);

    let outcome: { ok: true; result: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, result: await make() };
    } catch (error) {
      if (!isCacheableStripeError(error)) throw error;
      outcome = { ok: false, error };
    }

    const record = outcome.ok
      ? { result: outcome.result, fingerprint: fingerprint ?? null }
      : { error: this.serializeError(outcome.error), fingerprint: fingerprint ?? null };

    try {
      // .create() (not .set()) so a concurrent call racing on the SAME key
      // can't both "win" the STORED outcome — first writer wins and the
      // loser replays it. This gives id CONSISTENCY, not mutual exclusion:
      // both racers still fully execute make() before this point (e.g. two
      // payment_intent docs briefly exist) — harmless for chargeOffSession,
      // and the balance-mutating methods (transferToAccount, createPayout,
      // debitConnectedAccount) only get away with tolerating it because
      // nothing in this codebase actually races them on the same key
      // (documented here, not redesigned — a real race would double-apply
      // the balance change).
      await ref.create(record);
    } catch (createError) {
      if (!isAlreadyExists(createError)) throw createError;
      const winner = await ref.get();
      return this.replayIdem<T>(winner.data()!, fingerprint);
    }

    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  }

  // Single config read backing chargeOffSession's two test knobs — decline
  // (declineCharges global flag OR customerId in declineCustomerIds) and
  // pending (customerId in pendingCustomerIds), scoped exactly the same way.
  private async chargeKnobs(customerId: string): Promise<{ decline: boolean; pending: boolean }> {
    const cfg = await this.db.doc("stripeFake/config").get();
    const d = cfg.data();
    const decline = d?.declineCharges === true
      || ((d?.declineCustomerIds as string[] | undefined) ?? []).includes(customerId);
    const pending = ((d?.pendingCustomerIds as string[] | undefined) ?? []).includes(customerId);
    return { decline, pending };
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
  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    void paymentMethodId; // The fake only ever fabricates one card (pm_fake_4242) — nothing to switch between.
    await this.cardRef(customerId).set({ saved: true }, { merge: true });
  }
  async getSetupIntentPaymentMethod(setupIntentId: string, expectedCustomerId: string) {
    const snap = await this.objRef(setupIntentId).get();
    // Unknown (or wrong-kind) SetupIntent id — no card to resolve, and
    // nothing to check ownership against, so this is "no card" rather than
    // a mismatch.
    if (!snap.exists || snap.data()?.kind !== "setup_intent") return null;
    const customerId = snap.data()?.customerId as string;
    if (customerId !== expectedCustomerId) {
      throw new StripeSetupIntentMismatchError(setupIntentId, expectedCustomerId, customerId ?? null);
    }
    // Deterministic contract, same marker getDefaultPaymentMethod reads: the
    // fake only ever fabricates one card, keyed off the customer, not the
    // SetupIntent — so "does THIS SetupIntent's customer have a saved card"
    // is exactly the same lookup.
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
  async createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
    void refreshUrl; // The fake never round-trips a real browser through onboarding, so there's nothing for refreshUrl to influence — kept in the signature to match StripeLike exactly.
    return { url: `https://fake.stripe/onboard/${accountId}?return=${encodeURIComponent(returnUrl)}` };
  }
  async getAccountState(accountId: string): Promise<StripeAccountState> {
    const snap = await this.objRef(accountId).get();
    // createExpressAccount ALWAYS writes the object doc (with explicit false
    // flags) — so a fresh, never-onboarded account still has a doc. Absent
    // means the doc was deleted out from under a cached accountId, i.e. the
    // Connect account itself is gone (review round 1, I2's fake model of a
    // deleted account).
    if (!snap.exists) throw new StripeAccountMissingError(accountId);
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
      const { decline, pending } = await this.chargeKnobs(p.customerId);
      if (decline) throw new StripeCardDeclinedError("card_declined", "generic_decline");
      const id = this.newId("pi");
      if (pending) {
        // Create the intent object doc FIRST so intentId is real/pollable —
        // mirrors RealStripe, where the PaymentIntent exists (in
        // `processing`) in Stripe's system before the error is thrown.
        await this.objRef(id).set({
          kind: "payment_intent", amountCents: p.amountCents, customerId: p.customerId,
          meta: p.meta, refundedCents: 0, status: "processing",
        });
        throw new StripePaymentPendingError(id);
      }
      const chargeId = this.newId("ch");
      await this.objRef(id).set({
        kind: "payment_intent", amountCents: p.amountCents, customerId: p.customerId,
        meta: p.meta, refundedCents: 0, status: "succeeded", chargeId,
      });
      return { id, chargeId };
    }, `${p.customerId}:${p.amountCents}`);
  }
  async createOnSessionIntent(p: { customerId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("pi");
      await this.objRef(id).set({
        kind: "payment_intent", amountCents: p.amountCents, customerId: p.customerId,
        meta: p.meta, refundedCents: 0, status: "requires_confirmation",
      });
      return { id, clientSecret: `${id}_secret_fake` };
    }, `${p.customerId}:${p.amountCents}`);
  }
  async refund(p: { intentId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const ref = this.objRef(p.intentId);
      const id = this.newId("re");
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error(`FakeStripe: refund of unknown intent ${p.intentId}`);
        const d = snap.data()!;
        if (d.kind !== "payment_intent") {
          throw new Error(`FakeStripe: refund target ${p.intentId} is not a payment_intent (kind=${String(d.kind)})`);
        }
        const refundedCents = (d.refundedCents as number) + p.amountCents;
        if (refundedCents > (d.amountCents as number)) {
          throw new Error("FakeStripe: refund exceeds charge");
        }
        tx.update(ref, { refundedCents });
        tx.set(this.objRef(id), { kind: "refund", intentId: p.intentId, amountCents: p.amountCents });
      });
      return { id };
    }, `${p.intentId}:${p.amountCents}`);
  }
  async transferToAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>; sourceChargeId?: string }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("tr");
      const acct = this.objRef(p.accountId);
      // Both writes — the transfer object AND the running balance it
      // depends on — happen in one transaction: no world where the object
      // exists but the balance never moved (or vice versa), including if
      // idem() decides NOT to cache a later failure and this whole make()
      // reruns.
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) + p.amountCents }, { merge: true });
        tx.set(this.objRef(id), {
          kind: "transfer", accountId: p.accountId, amountCents: p.amountCents, meta: p.meta,
          sourceChargeId: p.sourceChargeId ?? null, reversed: false,
        });
      });
      return { id };
    }, `${p.accountId}:${p.amountCents}:${p.sourceChargeId ?? ""}`);
  }
  async reverseTransfer(p: { transferId: string; idempotencyKey: string }) {
    return this.idem(p.idempotencyKey, async () => {
      const tRef = this.objRef(p.transferId);
      const id = this.newId("trr");
      await this.db.runTransaction(async (tx) => {
        const tSnap = await tx.get(tRef);
        if (!tSnap.exists) throw new Error(`FakeStripe: reversal of unknown transfer ${p.transferId}`);
        const t = tSnap.data()!;
        if (t.kind !== "transfer") {
          throw new Error(`FakeStripe: reversal target ${p.transferId} is not a transfer (kind=${String(t.kind)})`);
        }
        if (t.reversed === true) {
          throw new Error(`FakeStripe: transfer ${p.transferId} has already been reversed`);
        }
        const acct = this.objRef(t.accountId as string);
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - (t.amountCents as number) }, { merge: true });
        tx.update(tRef, { reversed: true });
        tx.set(this.objRef(id), { kind: "transfer_reversal", transferId: p.transferId });
      });
      return { id };
    }, p.transferId);
  }
  async getAvailableBalanceCents(accountId: string): Promise<number> {
    const snap = await this.objRef(accountId).get();
    return (snap.data()?.balanceCents as number | undefined) ?? 0;
  }
  async getInstantAvailableBalanceCents(accountId: string): Promise<number> {
    // The fake tracks one running balance per account — no real
    // card-network settlement delay to model, so "instant available"
    // coincides with "available".
    return this.getAvailableBalanceCents(accountId);
  }
  async createPayout(p: { accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const acct = this.objRef(p.accountId);
      const id = this.newId("po");
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        const balance = (s.data()?.balanceCents as number | undefined) ?? 0;
        if (p.amountCents > balance) throw new Error("FakeStripe: payout exceeds balance");
        tx.set(acct, { balanceCents: balance - p.amountCents }, { merge: true });
        tx.set(this.objRef(id), { kind: "payout", accountId: p.accountId, amountCents: p.amountCents, instant: p.instant, meta: p.meta });
      });
      return { id };
    }, `${p.accountId}:${p.amountCents}:${p.instant}`);
  }
  async debitConnectedAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    return this.idem(p.idempotencyKey, async () => {
      const acct = this.objRef(p.accountId);
      const id = this.newId("adb");
      // Both writes — the debit object AND the balance it depends on —
      // happen in one transaction (same reasoning as transferToAccount):
      // otherwise an infra throw landing between the two would leave the
      // balance moved but no debit doc, and since that throw isn't a
      // modeled error, idem() rethrows it uncached — a same-key retry would
      // re-run this and double-decrement the balance.
      await this.db.runTransaction(async (tx) => {
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - p.amountCents }, { merge: true });
        tx.set(this.objRef(id), { kind: "account_debit", accountId: p.accountId, amountCents: p.amountCents, meta: p.meta });
      });
      return { id };
    }, `${p.accountId}:${p.amountCents}`);
  }
  constructWebhookEvent(rawBody: string | Buffer, signature: string): { id: string; type: string; data: { object: Record<string, unknown> } } {
    void signature; // Signature verification is a RealStripe-only concern — the emulator's fake webhook calls are same-process and already trusted.
    return JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  }
}

// One Stripe SDK client per resolved secret key, memoized at module scope.
// Cloud Functions instances are reused across invocations, so without this
// every getStripe() call would construct a fresh Stripe client and lose the
// SDK's internal HTTP agent/connection pooling.
const realStripeClients = new Map<string, Stripe>();
function getRealStripeClient(key: string): Stripe {
  let client = realStripeClients.get(key);
  if (!client) {
    client = new Stripe(key, {
      // Pin an explicit version so a Stripe-side default-version bump can
      // never silently reshape a response this file's code assumes.
      apiVersion: "2025-08-27.basil",
      // Safe ONLY because every mutating call below passes an
      // idempotencyKey: a network-level retry with the same key replays
      // Stripe's original result instead of double-charging /
      // double-transferring / double-paying-out.
      maxNetworkRetries: 2,
    });
    realStripeClients.set(key, client);
  }
  return client;
}

// ---------- Real adapter ----------
export class RealStripe implements StripeLike {
  private s: Stripe;
  constructor(key: string) { this.s = getRealStripeClient(key); }

  async createCustomer(meta: Record<string, string>) {
    const c = await this.s.customers.create({ metadata: meta });
    return { id: c.id };
  }
  async createSetupIntent(customerId: string) {
    const si = await this.s.setupIntents.create({ customer: customerId, usage: "off_session" });
    return { id: si.id, clientSecret: si.client_secret! };
  }
  async getDefaultPaymentMethod(customerId: string) {
    // expand collapses what would otherwise be two round trips (retrieve
    // the customer, then separately retrieve the default payment method by
    // id) into one: default_payment_method comes back as the full
    // PaymentMethod object instead of just its id.
    const customer = await this.s.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    // `"invoice_settings" in customer` cleanly discriminates
    // Customer | DeletedCustomer: only DeletedCustomer entirely lacks the
    // key (Customer always has it, deleted customers are just gone).
    if ("invoice_settings" in customer) {
      const dpm = customer.invoice_settings.default_payment_method;
      if (dpm) {
        // Expanded above, so this is normally already the full
        // PaymentMethod object. If Stripe ever hands back just the id
        // instead (Stripe's types can't express "expand guarantees the
        // object shape" statically), retrieve THAT specific payment method
        // by id — falling through to "most recently attached card" here
        // would silently return a DIFFERENT card than the customer's actual
        // default.
        const pm = typeof dpm === "string" ? await this.s.paymentMethods.retrieve(dpm) : dpm;
        if (pm.card) return { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
      }
    }
    // No explicit default set (or it wasn't a card) — fall back to the most
    // recently attached card.
    const pms = await this.s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    const pm = pms.data[0];
    if (!pm?.card) return null;
    return { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
  }
  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.s.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  }
  async getSetupIntentPaymentMethod(setupIntentId: string, expectedCustomerId: string) {
    let si: Stripe.SetupIntent;
    try {
      si = await this.s.setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
    } catch (e) {
      // resource_missing (or a bare 404) means this SetupIntent id doesn't
      // exist — matches the interface contract (null, not a throw) and the
      // fake's identical "unknown id -> null" behavior. Review round 2, #1.
      if (e instanceof Stripe.errors.StripeInvalidRequestError
        && (e.code === "resource_missing" || e.statusCode === 404)) {
        return null;
      }
      throw e;
    }
    const customerId = typeof si.customer === "string" ? si.customer : (si.customer?.id ?? null);
    if (customerId !== expectedCustomerId) {
      throw new StripeSetupIntentMismatchError(setupIntentId, expectedCustomerId, customerId);
    }
    if (!si.payment_method) return null;
    const pm = typeof si.payment_method === "string"
      ? await this.s.paymentMethods.retrieve(si.payment_method)
      : si.payment_method;
    if (!pm.card) return null;
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
    let a: Stripe.Account;
    try {
      a = await this.s.accounts.retrieve(accountId);
    } catch (e) {
      // resource_missing (or a bare 404) means the Connect account was
      // deleted (or the id never existed) — distinguish that from any other
      // failure so callers can fail closed instead of either 500ing or
      // silently treating "can't reach Stripe" the same as "never
      // onboarded" (review round 1, I2).
      if (e instanceof Stripe.errors.StripeInvalidRequestError
        && (e.code === "resource_missing" || e.statusCode === 404)) {
        throw new StripeAccountMissingError(accountId);
      }
      throw e;
    }
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
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.s.paymentIntents.create({
        amount: p.amountCents, currency: "usd", customer: p.customerId,
        payment_method: pm.id, off_session: true, confirm: true, metadata: p.meta,
      }, { idempotencyKey: p.idempotencyKey });
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) {
        throw new StripeCardDeclinedError(e.message, e.decline_code || e.code);
      }
      throw e;
    }
    if (pi.status === "processing") throw new StripePaymentPendingError(pi.id);
    if (pi.status !== "succeeded") {
      // requires_action / requires_payment_method / canceled etc — an
      // off-session confirm that doesn't succeed outright is effectively a
      // decline (no user is present to complete an authentication step).
      throw new StripeCardDeclinedError(`unexpected off-session status: ${pi.status}`);
    }
    const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
    return { id: pi.id, chargeId };
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
  async transferToAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>; sourceChargeId?: string }) {
    const t = await this.s.transfers.create(
      {
        amount: p.amountCents, currency: "usd", destination: p.accountId, metadata: p.meta,
        ...(p.sourceChargeId ? { source_transaction: p.sourceChargeId } : {}),
      },
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
  async getInstantAvailableBalanceCents(accountId: string) {
    const b = await this.s.balance.retrieve({ stripeAccount: accountId });
    return (b.instant_available ?? []).filter((a) => a.currency === "usd").reduce((s, a) => s + a.amount, 0);
  }
  async createPayout(p: { accountId: string; amountCents: number; instant: boolean; idempotencyKey: string; meta: Record<string, string> }) {
    const po = await this.s.payouts.create(
      { amount: p.amountCents, currency: "usd", method: p.instant ? "instant" : "standard", metadata: p.meta },
      { stripeAccount: p.accountId, idempotencyKey: p.idempotencyKey });
    return { id: po.id };
  }
  async debitConnectedAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string> }) {
    // Connect "account debit": pulling funds from a connected account's
    // balance back to the platform via charges.create({ source: accountId })
    // is Stripe's legacy (pre-Treasury) mechanism for this and is thin on
    // current Connect documentation — re-verify this call against Stripe's
    // current account-debit guidance before this path ever runs in live
    // mode (see Task 13's payouts work).
    const c = await this.s.charges.create(
      { amount: p.amountCents, currency: "usd", source: p.accountId, metadata: p.meta },
      { idempotencyKey: p.idempotencyKey });
    return { id: c.id };
  }
  constructWebhookEvent(rawBody: string | Buffer, signature: string) {
    const evt = this.s.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret.value() || process.env.STRIPE_WEBHOOK_SECRET || "");
    return evt as unknown as { id: string; type: string; data: { object: Record<string, unknown> } };
  }
}

// Selection mirrors getGeocoder() (see geocode.ts) but FAILS CLOSED: a real
// key wins if present; otherwise the fake is allowed ONLY when we can prove
// we're in the emulator (FUNCTIONS_EMULATOR is set by the Functions
// emulator's runtime; FIRESTORE_EMULATOR_HOST is set explicitly by test
// processes like stripeClient.test.ts). Anywhere else — a deployed function
// whose handler forgot `secrets: [stripeSecretKey]` — this throws instead of
// silently moving fake money against production Firestore data.
export function getStripe(): StripeLike {
  // Cloud Functions v2 injects a secret declared via
  // `secrets: [stripeSecretKey]` directly into process.env.STRIPE_SECRET_KEY
  // in production, so this env check IS the production fast path — a
  // correctly configured handler resolves here without ever touching
  // stripeSecretKey.value().
  const envKey = process.env.STRIPE_SECRET_KEY;
  if (envKey) return new RealStripe(envKey);

  if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) {
    // Never call stripeSecretKey.value() here: the Functions emulator logs
    // a warning on every read of an unbound SecretParam, and the emulator
    // never provisions Secret Manager secrets anyway — the answer would
    // always be "". Gating the call out entirely (rather than just
    // reordering the `||`) keeps the emulator's logs clean.
    return new FakeStripe();
  }

  // Fail CLOSED: a handler that can reach getStripe() but forgot to list
  // `secrets: [stripeSecretKey]` in its options must break loudly in
  // production, never silently move fake money against real Firestore data.
  // (No point trying stripeSecretKey.value() as a last resort here: Cloud
  // Functions v2 backs it with the exact same process.env.STRIPE_SECRET_KEY
  // already checked above, so a second read can't turn up anything the
  // first one missed — it would only add a spurious emulator-style warning
  // right before this throw.)
  throw new Error("STRIPE_SECRET_KEY is not configured — refusing to run with FakeStripe outside the emulator.");
}

export function isFakeStripe(s: StripeLike): s is FakeStripe {
  return s instanceof FakeStripe;
}

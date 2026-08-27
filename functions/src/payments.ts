import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type StripeProfileDoc } from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { getStripe, isFakeStripe, stripeSecretKey } from "./stripeClient.js";
import { getStripeProfileDoc } from "./paymentsCore.js";
import { webhookHandlers } from "./paymentsWebhook.js";

export function emptyStripeProfile(now: number): StripeProfileDoc {
  return {
    customerId: null, defaultPaymentMethodId: null, cardBrand: null, cardLast4: null,
    accountId: null, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    onboardingStartedAt: null, onboardedAt: null, delinquent: false, delinquentSince: null,
    updatedAt: now,
  };
}

// Curator half: ensures a Customer exists and returns a SetupIntent client
// secret for the web Elements save-card modal. On the FAKE, the card is
// marked saved immediately (there is no browser Elements flow against a fake
// — the emulator contract is "createSetupIntent called ⇒ card on file").
export const createSetupIntent = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);

    const db = getFirestore();
    const stripe = getStripe();
    const now = Date.now();
    const ref = db.doc(`profiles/${profileId}/private/stripe`);
    const existing = await getStripeProfileDoc(profileId);
    let customerId = existing?.customerId ?? null;
    if (!customerId) {
      customerId = (await stripe.createCustomer({ profileId })).id;
      await ref.set({ ...(existing ?? emptyStripeProfile(now)), customerId, updatedAt: now }, { merge: true });
    }
    const si = await stripe.createSetupIntent(customerId);
    if (isFakeStripe(stripe)) {
      await stripe.markCardSaved(customerId);
      const pm = await stripe.getDefaultPaymentMethod(customerId);
      await stripe.setDefaultPaymentMethod(customerId, pm!.id);
      await ref.set({ defaultPaymentMethodId: pm!.id, cardBrand: pm!.brand, cardLast4: pm!.last4, updatedAt: now }, { merge: true });
    }
    return { clientSecret: si.clientSecret, customerId };
  });

// Called by the web save-card modal AFTER Elements confirms the SetupIntent —
// refreshes the cached default-card fields from Stripe (real path; the fake
// already cached them above) and sets the retrieved payment method as the
// customer's default. Also the "update card" path.
export const refreshPaymentMethod = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    const sp = await getStripeProfileDoc(profileId);
    if (!sp?.customerId) throw new HttpsError("failed-precondition", "No payment account yet — save a card first.");
    const stripe = getStripe();
    const pm = await stripe.getDefaultPaymentMethod(sp.customerId);
    if (pm) await stripe.setDefaultPaymentMethod(sp.customerId, pm.id);
    await db.doc(`profiles/${profileId}/private/stripe`).set({
      defaultPaymentMethodId: pm?.id ?? null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null,
      updatedAt: Date.now(),
    }, { merge: true });
    return { hasCard: pm != null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null };
  });

// Musician half: ensures an Express account exists, returns a fresh Stripe-
// hosted onboarding URL. returnPath/refreshPath are RELATIVE app paths —
// the callable prefixes the app origin (env APP_ORIGIN, default localhost) so
// a client can never direct Stripe's redirect at a foreign origin.
export const createOnboardingLink = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);

    const db = getFirestore();
    const stripe = getStripe();
    const now = Date.now();
    const ref = db.doc(`profiles/${profileId}/private/stripe`);
    const existing = await getStripeProfileDoc(profileId);
    let accountId = existing?.accountId ?? null;
    if (!accountId) {
      accountId = (await stripe.createExpressAccount({ profileId })).id;
      await ref.set({
        ...(existing ?? emptyStripeProfile(now)), accountId, onboardingStartedAt: now, updatedAt: now,
      }, { merge: true });
    }
    const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
    const link = await stripe.createOnboardingLink(
      accountId, `${origin}/dashboard/earnings/onboarding/return`, `${origin}/dashboard/earnings/onboarding/refresh`);
    return { url: link.url };
  });

// Re-reads the account state from Stripe and refreshes the cached gate flags
// — the onboarding return page calls this so the gates open without waiting
// for the account.updated webhook. Shared by that webhook handler. No-ops
// (returns the cached doc as-is) when there's no accountId yet.
export async function syncStripeAccountFlags(profileId: string, now: number): Promise<StripeProfileDoc | null> {
  const db = getFirestore();
  const sp = await getStripeProfileDoc(profileId);
  if (!sp?.accountId) return sp;
  const state = await getStripe().getAccountState(sp.accountId);
  const update = {
    transfersEnabled: state.transfersEnabled, payoutsEnabled: state.payoutsEnabled,
    instantEligible: state.instantEligible,
    onboardedAt: sp.onboardedAt ?? (state.transfersEnabled ? now : null),
    updatedAt: now,
  };
  await db.doc(`profiles/${profileId}/private/stripe`).set(update, { merge: true });
  return { ...sp, ...update };
}

// One status surface for both halves + (Task 13 adds balance fields).
export const getStripeStatus = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);
    const sp = await syncStripeAccountFlags(profileId, Date.now()) ?? emptyStripeProfile(Date.now());
    return {
      hasCard: sp.defaultPaymentMethodId != null, cardBrand: sp.cardBrand, cardLast4: sp.cardLast4,
      hasAccount: sp.accountId != null, transfersEnabled: sp.transfersEnabled,
      payoutsEnabled: sp.payoutsEnabled, instantEligible: sp.instantEligible,
      delinquent: sp.delinquent,
    };
  });

// Registered here (not in paymentsWebhook.ts) to avoid a webhook->payments
// import cycle: payments.ts already imports webhookHandlers from
// paymentsWebhook.ts, and index.ts importing payments.ts (for its callable
// exports) is what guarantees this registration has run before the webhook
// can ever fire.
webhookHandlers["account.updated"] = async (object) => {
  const accountId = object.id as string | undefined;
  const profileId = (object.metadata as Record<string, string> | undefined)?.profileId;
  if (!accountId || !profileId) return;
  const sp = await getStripeProfileDoc(profileId);
  if (sp?.accountId !== accountId) return; // stale/foreign event
  await syncStripeAccountFlags(profileId, Date.now());
};

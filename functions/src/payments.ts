import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type StripeProfileDoc } from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import {
  getStripe, isFakeStripe, stripeSecretKey,
  StripeAccountMissingError, StripeSetupIntentMismatchError, type StripeAccountState,
} from "./stripeClient.js";
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

// Stripe object ids (customer/setupIntent/account/...) — never contain "/",
// but CAN exceed Firestore's 1500-byte doc-id ceiling in principle, and
// isValidDocId's charset is broader than Stripe's. Review round 1 (I1): a
// dedicated, tighter check for ids a client hands back to us verbatim.
const STRIPE_ID_RE = /^[A-Za-z0-9_]{1,255}$/;

// profiles/{profileId}/private/stripe — the doc every callable below reads
// via getStripeProfileDoc and writes at this same path.
function stripeProfileRef(profileId: string) {
  return getFirestore().doc(`profiles/${profileId}/private/stripe`);
}

// Review round 1 (M1/M2): create-then-claim. The Stripe object is created
// OUTSIDE any transaction (invariant #2: Stripe calls never run inside
// Firestore transactions), then a transaction re-reads current state and
// keeps whichever id got there first — two concurrent callers can each
// create a Stripe object, but only ONE id is ever persisted, and neither
// path spreads a possibly-stale pre-transaction snapshot over a write that
// may have landed in between. Returns the WINNING id (ours, or the racer's).
async function claimStripeId(
  profileId: string, field: "customerId" | "accountId", createdId: string, now: number,
  extra?: Record<string, unknown>,
): Promise<string> {
  const ref = stripeProfileRef(profileId);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data() as StripeProfileDoc | undefined;
    const existingId = cur?.[field];
    if (existingId) return existingId;
    tx.set(ref, { ...(cur ? {} : emptyStripeProfile(now)), [field]: createdId, updatedAt: now, ...extra }, { merge: true });
    return createdId;
  });
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
    const existing = await getStripeProfileDoc(profileId);
    let customerId = existing?.customerId ?? null;
    if (!customerId) {
      const created = (await stripe.createCustomer({ profileId })).id;
      customerId = await claimStripeId(profileId, "customerId", created, now);
    }
    const si = await stripe.createSetupIntent(customerId);
    if (isFakeStripe(stripe)) {
      await stripe.markCardSaved(customerId);
      const pm = await stripe.getDefaultPaymentMethod(customerId);
      if (!pm) throw new HttpsError("internal", "FakeStripe failed to produce a card after markCardSaved.");
      await stripe.setDefaultPaymentMethod(customerId, pm.id);
      await db.doc(`profiles/${profileId}/private/stripe`).set(
        { defaultPaymentMethodId: pm.id, cardBrand: pm.brand, cardLast4: pm.last4, updatedAt: now }, { merge: true });
    }
    return { clientSecret: si.clientSecret, customerId };
  });

// Called by the web save-card modal AFTER Elements confirms a SetupIntent.
// Review round 1 (I1): passing that SetupIntent's id is now how the caller
// tells us WHICH card just got confirmed — reading the customer's "default"
// payment method here (the old behavior) just re-resolves whatever was
// already default, since nothing has repointed the default at the NEW card
// yet. Without setupIntentId, this falls back to the old read-default
// behavior (still useful as a plain refresh/"what's on file" call).
export interface RefreshPaymentMethodInput { profileId: string; setupIntentId?: string; }

export const refreshPaymentMethod = onCall<RefreshPaymentMethodInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, setupIntentId } = req.data ?? ({} as RefreshPaymentMethodInput);
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    if (setupIntentId !== undefined && !STRIPE_ID_RE.test(setupIntentId)) {
      throw new HttpsError("invalid-argument", "Invalid setup intent id.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    const sp = await getStripeProfileDoc(profileId);
    if (!sp?.customerId) throw new HttpsError("failed-precondition", "No payment account yet — save a card first.");
    const stripe = getStripe();
    let pm: { id: string; brand: string; last4: string } | null;
    if (setupIntentId) {
      try {
        pm = await stripe.getSetupIntentPaymentMethod(setupIntentId, sp.customerId);
      } catch (e) {
        if (e instanceof StripeSetupIntentMismatchError) {
          throw new HttpsError("failed-precondition", "That setup intent doesn't belong to this profile.");
        }
        throw e;
      }
    } else {
      pm = await stripe.getDefaultPaymentMethod(sp.customerId);
    }
    if (pm) await stripe.setDefaultPaymentMethod(sp.customerId, pm.id);
    await db.doc(`profiles/${profileId}/private/stripe`).set({
      defaultPaymentMethodId: pm?.id ?? null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null,
      updatedAt: Date.now(),
    }, { merge: true });
    return { hasCard: pm != null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null };
  });

// Musician half: ensures an Express account exists, returns a fresh Stripe-
// hosted onboarding URL. returnPath/refreshPath are RELATIVE app paths —
// the callable prefixes the app origin (env APP_ORIGIN) so a client can
// never direct Stripe's redirect at a foreign origin. Review round 1 (M5):
// mirrors getStripe()'s fail-CLOSED posture — outside the emulator, a
// missing APP_ORIGIN is a deploy-config bug, not something to silently
// paper over with a localhost fallback that would send real Stripe
// onboarding redirects nowhere useful.
export const createOnboardingLink = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);

    const stripe = getStripe();
    const now = Date.now();
    const existing = await getStripeProfileDoc(profileId);
    let accountId = existing?.accountId ?? null;
    if (!accountId) {
      const created = (await stripe.createExpressAccount({ profileId })).id;
      accountId = await claimStripeId(profileId, "accountId", created, now, { onboardingStartedAt: now });
    }
    const inEmulator = process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST != null;
    const origin = process.env.APP_ORIGIN ?? (inEmulator ? "http://localhost:3000" : null);
    if (!origin) {
      throw new Error("APP_ORIGIN is not configured — refusing to build a Stripe onboarding redirect without a known origin.");
    }
    const link = await stripe.createOnboardingLink(
      accountId, `${origin}/dashboard/earnings/onboarding/return`, `${origin}/dashboard/earnings/onboarding/refresh`);
    return { url: link.url };
  });

// Writes the gate flags only when they actually differ from the cached doc
// (review round 1, M6) — avoids a Firestore write (and an updatedAt churn)
// on every poll of an already-converged account.
async function writeGateFlagsIfChanged(
  profileId: string, sp: StripeProfileDoc,
  next: { transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean; onboardedAt: number | null },
  now: number,
): Promise<StripeProfileDoc> {
  const changed = sp.transfersEnabled !== next.transfersEnabled
    || sp.payoutsEnabled !== next.payoutsEnabled
    || sp.instantEligible !== next.instantEligible
    || sp.onboardedAt !== next.onboardedAt;
  if (!changed) return sp;
  const update = { ...next, updatedAt: now };
  await stripeProfileRef(profileId).set(update, { merge: true });
  return { ...sp, ...update };
}

// Re-reads the account state from Stripe and refreshes the cached gate flags
// — the onboarding return page calls this so the gates open without waiting
// for the account.updated webhook. Shared by that webhook handler. No-ops
// (returns the cached doc as-is) when there's no accountId yet.
//
// Review round 1 (I2): getAccountState can fail two distinct ways —
//   - StripeAccountMissingError: the Connect account was deleted (or never
//     existed) on Stripe's side. This is TRUTHFUL fail-closed information —
//     zero the three flags (a deleted account can't transfer/payout/instant
//     -cashout) and persist it, so nothing downstream trusts stale "enabled"
//     flags for an account that's gone.
//   - anything else (network blip, Stripe outage, ...): we don't actually
//     know the account's state right now. Log and return the CACHED doc
//     unchanged — getStripeStatus still renders (possibly-stale) flags
//     instead of 500ing the whole status surface over a transient read
//     failure.
export async function syncStripeAccountFlags(profileId: string, now: number): Promise<StripeProfileDoc | null> {
  const sp = await getStripeProfileDoc(profileId);
  if (!sp?.accountId) return sp;
  let state: StripeAccountState;
  try {
    state = await getStripe().getAccountState(sp.accountId);
  } catch (e) {
    if (e instanceof StripeAccountMissingError) {
      console.error(
        `syncStripeAccountFlags: Stripe account ${sp.accountId} missing for profile ${profileId} — zeroing gate flags`, e);
      return writeGateFlagsIfChanged(profileId, sp,
        { transfersEnabled: false, payoutsEnabled: false, instantEligible: false, onboardedAt: sp.onboardedAt }, now);
    }
    console.error(
      `syncStripeAccountFlags: failed to read Stripe account state for profile ${profileId} (accountId=${sp.accountId})`, e);
    return sp;
  }
  const onboardedAt = sp.onboardedAt ?? (state.transfersEnabled ? now : null);
  return writeGateFlagsIfChanged(profileId, sp, {
    transfersEnabled: state.transfersEnabled, payoutsEnabled: state.payoutsEnabled,
    instantEligible: state.instantEligible, onboardedAt,
  }, now);
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
  // Review round 1 (M4): validate BEFORE building a doc path from
  // attacker/Stripe-controlled metadata — event payloads are only signature-
  // verified, not shape-validated, so metadata.profileId is untrusted input.
  if (!isValidDocId(profileId)) return;
  const sp = await getStripeProfileDoc(profileId);
  if (sp?.accountId !== accountId) {
    // Review round 1 (M3): a mismatch here means either a stale/replayed
    // event for an account this profile no longer owns, or (more
    // concerning) an event whose metadata.profileId doesn't match the
    // account it claims to describe — worth a log line either way.
    console.warn(
      `account.updated webhook: accountId mismatch for profile ${profileId} — event accountId=${accountId}, cached accountId=${sp?.accountId ?? "none"}`);
    return;
  }
  await syncStripeAccountFlags(profileId, Date.now());
};

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, MAX_TRUE_UP_EXTRA_MINUTES, MAX_TRUE_UP_EXTRA_SONGS,
  TRUE_UP_SHAPE_MESSAGE, trueUpOverCapMessage, TRUE_UP_WINDOW_CLOSED_MESSAGE,
  TRUE_UP_PAYMENT_STARTED_MESSAGE, TRUE_UP_CHARGE_IN_FLIGHT_MESSAGE, TRUE_UP_INCREASE_ONLY_MESSAGE,
  PAY_PAST_DUE_NOT_OVERDUE_MESSAGE, PAY_PAST_DUE_NOTHING_OWED_MESSAGE, PAY_PAST_DUE_NO_CUSTOMER_MESSAGE,
  PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE, PAY_PAST_DUE_RACED_MESSAGE, PAY_PAST_DUE_DATE_CANCELLED_MESSAGE,
  type AdminAlertDoc, type BookingRequestDoc, type GigDoc, type PaymentDoc, type StripeProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { requireAdmin, writeAudit } from "./review.js";
import {
  getStripe, isFakeStripe, stripeSecretKey,
  StripeAccountMissingError, StripeSetupIntentMismatchError,
  type StripeAccountState, type StripeLike,
} from "./stripeClient.js";
import {
  clearDelinquencyIfSettled, getStripeProfileDoc, isDepositScheduleExhausted, isFailedPrecondition,
  stuckSagaAlertId, IDEMPOTENCY_WINDOW_MS,
} from "./paymentsCore.js";
// payPastDue prices and finalizes through the settlement module's own
// functions, never a second copy of that math. This import is also one of the
// two edges that load paymentsSettlement's webhook registrations from index.ts
// (see that file's header).
import {
  finalizeDepositPayDue, finalizeSettlementSuccess, settlementMath, PAYDUE_CONFIRM_WINDOW_MS,
} from "./paymentsSettlement.js";
import { resolveBookingSideStrict } from "./bookingLifecycle.js";
import { webhookHandlers } from "./paymentsWebhook.js";
// Task 13's balance surface. One-way edge: paymentsPayouts.ts owns the payout
// callable and the payout webhooks and knows nothing about this file.
import { readPayoutBalances } from "./paymentsPayouts.js";

export function emptyStripeProfile(now: number): StripeProfileDoc {
  return {
    customerId: null, defaultPaymentMethodId: null, cardBrand: null, cardLast4: null,
    accountId: null, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    onboardingStartedAt: null, onboardedAt: null, delinquent: false, delinquentSince: null,
    updatedAt: now,
  };
}

// Stripe object ids (customer/setupIntent/account/...), never contain "/",
// but CAN exceed Firestore's 1500-byte doc-id ceiling in principle, and
// isValidDocId's charset is broader than Stripe's. Review round 1 (I1): a
// dedicated, tighter check for ids a client hands back to us verbatim.
const STRIPE_ID_RE = /^[A-Za-z0-9_]{1,255}$/;

// profiles/{profileId}/private/stripe, the doc every callable below reads
// via getStripeProfileDoc and writes at this same path.
function stripeProfileRef(profileId: string) {
  return getFirestore().doc(`profiles/${profileId}/private/stripe`);
}

// Review round 1 (M1/M2): create-then-claim. The Stripe object is created
// OUTSIDE any transaction (invariant #2: Stripe calls never run inside
// Firestore transactions), then a transaction re-reads current state and
// keeps whichever id got there first, two concurrent callers can each
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
//, the emulator contract is "createSetupIntent called ⇒ card on file").
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
// tells us WHICH card just got confirmed, reading the customer's "default"
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
    // Review round 2, #3: RegExp.test coerces a non-string to a string first
    // (e.g. `123` -> "123" would otherwise sail through), check the type
    // explicitly rather than leaning on the coercion.
    if (setupIntentId !== undefined && (typeof setupIntentId !== "string" || !STRIPE_ID_RE.test(setupIntentId))) {
      throw new HttpsError("invalid-argument", "Invalid setup intent id.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    const sp = await getStripeProfileDoc(profileId);
    if (!sp?.customerId) throw new HttpsError("failed-precondition", "No payment account yet. Save a card first.");
    const stripe = getStripe();

    if (setupIntentId) {
      let pm: { id: string; brand: string; last4: string } | null;
      try {
        pm = await stripe.getSetupIntentPaymentMethod(setupIntentId, sp.customerId);
      } catch (e) {
        if (e instanceof StripeSetupIntentMismatchError) {
          throw new HttpsError("failed-precondition", "That setup intent doesn't belong to this profile.");
        }
        throw e;
      }
      // Review round 2, #2: a null resolution here is NOT authoritative "no
      // card on file", it only means THIS SetupIntent didn't pan out
      // (unknown id, nothing attached). Wiping the cache would erase a
      // perfectly good card that was already on file. Refuse instead and
      // leave the cached fields untouched, only the unconditional write on
      // the no-setupIntentId branch below is authoritative.
      if (!pm) throw new HttpsError("failed-precondition", "We couldn't find that card. Try saving it again.");
      await stripe.setDefaultPaymentMethod(sp.customerId, pm.id);
      await db.doc(`profiles/${profileId}/private/stripe`).set(
        { defaultPaymentMethodId: pm.id, cardBrand: pm.brand, cardLast4: pm.last4, updatedAt: Date.now() }, { merge: true });
      return { hasCard: true, cardBrand: pm.brand, cardLast4: pm.last4 };
    }

    // Authoritative branch: reads the customer's actual current default,
    // null here IS truthful "no card on file", so it's fine (and correct)
    // for this write to clear the cache.
    const pm = await stripe.getDefaultPaymentMethod(sp.customerId);
    await db.doc(`profiles/${profileId}/private/stripe`).set({
      defaultPaymentMethodId: pm?.id ?? null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null,
      updatedAt: Date.now(),
    }, { merge: true });
    return { hasCard: pm != null, cardBrand: pm?.brand ?? null, cardLast4: pm?.last4 ?? null };
  });

// Musician half: ensures an Express account exists, returns a fresh Stripe-
// hosted onboarding URL. returnPath/refreshPath are RELATIVE app paths,
// the callable prefixes the app origin (env APP_ORIGIN) so a client can
// never direct Stripe's redirect at a foreign origin. Review round 1 (M5):
// mirrors getStripe()'s fail-CLOSED posture, outside the emulator, a
// missing APP_ORIGIN is a deploy-config bug, not something to silently
// paper over with a localhost fallback that would send real Stripe
// onboarding redirects nowhere useful.
export const createOnboardingLink = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    // Owner ruling (H2): ADMIN-only. Onboarding sets the profile's payout
    // DESTINATION (which connected account the money lands in), so it is a
    // payout-authority action gated like removeMember/transferAdmin, not the
    // any-member content permission. Reading payout status/balance stays a
    // member permission (getStripeStatus below keeps requireProfileMember).
    await requireProfileAdmin(profileId, uid);

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
      throw new Error("APP_ORIGIN is not configured, refusing to build a Stripe onboarding redirect without a known origin.");
    }
    const link = await stripe.createOnboardingLink(
      accountId, `${origin}/dashboard/earnings/onboarding/return`, `${origin}/dashboard/earnings/onboarding/refresh`);
    return { url: link.url };
  });

// Writes the gate flags only when they actually differ from the cached doc
// (review round 1, M6), avoids a Firestore write (and an updatedAt churn)
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
//, the onboarding return page calls this so the gates open without waiting
// for the account.updated webhook. Shared by that webhook handler. No-ops
// (returns the cached doc as-is) when there's no accountId yet.
//
// Review round 1 (I2): getAccountState can fail two distinct ways,
//   - StripeAccountMissingError: the Connect account was deleted (or never
//     existed) on Stripe's side. This is TRUTHFUL fail-closed information,
//     zero the three flags (a deleted account can't transfer/payout/instant
//     -cashout) and persist it, so nothing downstream trusts stale "enabled"
//     flags for an account that's gone.
//   - anything else (network blip, Stripe outage, ...): we don't actually
//     know the account's state right now. Log and return the CACHED doc
//     unchanged, getStripeStatus still renders (possibly-stale) flags
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
        `syncStripeAccountFlags: Stripe account ${sp.accountId} missing for profile ${profileId}, zeroing gate flags`, e);
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

// One status surface for both halves, card state, onboarding/gate flags,
// delinquency, and (Task 13) the two payout balances.
//
// THE BALANCES ARE DEGRADABLE, in exactly the sense syncStripeAccountFlags's
// non-missing-account branch already is: `readPayoutBalances` returns nulls and
// logs when Stripe can't be read, rather than throwing. This whole callable is
// what the Earnings page and the curator delinquency banner load from, and a
// Stripe blip must not blank either of them. 0 (not null) means "we asked and
// there's nothing", including the no-account/payouts-off case, where there is
// no balance to have.
export const getStripeStatus = onCall<{ profileId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId } = req.data ?? ({} as { profileId: string });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(profileId, uid);
    const sp = await syncStripeAccountFlags(profileId, Date.now()) ?? emptyStripeProfile(Date.now());
    // AFTER the flag sync, never before: a deleted Connect account zeroes
    // `payoutsEnabled` there, and reading the balance off the synced doc is
    // what makes such an account report 0/0 instead of attempting a Stripe
    // balance call that can only fail.
    const balances = await readPayoutBalances(sp);
    return {
      hasCard: sp.defaultPaymentMethodId != null, cardBrand: sp.cardBrand, cardLast4: sp.cardLast4,
      hasAccount: sp.accountId != null, transfersEnabled: sp.transfersEnabled,
      payoutsEnabled: sp.payoutsEnabled, instantEligible: sp.instantEligible,
      delinquent: sp.delinquent,
      availableBalanceCents: balances.availableBalanceCents,
      instantAvailableBalanceCents: balances.instantAvailableBalanceCents,
    };
  });

// Registered here (not in paymentsWebhook.ts) to avoid a webhook->payments
// import cycle: payments.ts already imports webhookHandlers from
// paymentsWebhook.ts, and index.ts importing payments.ts (for its callable
// exports) is what guarantees this registration has run before the webhook
// can ever fire.
webhookHandlers["account.updated"] = async (object, eventId, account) => {
  const accountId = object.id as string | undefined;
  const profileId = (object.metadata as Record<string, string> | undefined)?.profileId;
  if (!accountId || !profileId) return;
  // Review round 1 (M4): validate BEFORE building a doc path from
  // attacker/Stripe-controlled metadata, event payloads are only signature-
  // verified, not shape-validated, so metadata.profileId is untrusted input.
  if (!isValidDocId(profileId)) {
    // Review round 2 (log nit): this is corrupt metadata on an account
    // Stripe itself sent us, more log-worthy than the ordinary accountId
    // mismatch case below (that one's often just a stale/replayed event).
    console.warn(`account.updated webhook: metadata.profileId is not a valid doc id, accountId=${accountId}, profileId=${JSON.stringify(profileId)} (event ${eventId})`);
    return;
  }
  const sp = await getStripeProfileDoc(profileId);
  if (sp?.accountId !== accountId) {
    // Review round 1 (M3): a mismatch here means either a stale/replayed
    // event for an account this profile no longer owns, or (more
    // concerning) an event whose metadata.profileId doesn't match the
    // account it claims to describe, worth a log line either way.
    console.warn(
      `account.updated webhook: accountId mismatch for profile ${profileId}, event accountId=${accountId}, cached accountId=${sp?.accountId ?? "none"} (event ${eventId})`);
    return;
  }
  // M1 (branch audit): account.updated is delivered to the platform endpoint FOR
  // a connected account, so Stripe stamps the event's TOP-LEVEL `account` with
  // that account id, pin it to the cached account too. object.id already pins
  // the account here (and is checked above), but requiring event.account makes
  // the platform/connected boundary explicit and identical to the payout
  // handlers, and forecloses a future Standard/metadata-bearing connected
  // account driving a flag sync on a profile it does not own.
  if (account !== accountId) {
    console.warn(
      `account.updated webhook: event.account ${account ?? "none"} does not match the event's account ${accountId} for profile ${profileId}, ignored (event ${eventId})`);
    return;
  }
  await syncStripeAccountFlags(profileId, Date.now());
};

// ---------- SP5 Task 9: operator release valve ----------

// Clears a stuck accept saga's marker so the booking is usable again.
//
// FOR USE **AFTER** AN OPERATOR HAS RECONCILED THE STRIPE SIDE BY HAND. This
// callable moves no money and checks no money: it is the last step of a manual
// recovery, not the recovery itself. The situation it exists for is the one
// the hourly sweep deliberately refuses to touch (adminAlerts, kinds
// `stale_accept_saga` / `stuck_saga_marker` / `expired_booking_saga_marker`):
// a booking staged for more than Stripe's 24h idempotency window, whose charge
// key can no longer be replayed, so nothing automatic can tell whether the
// curator was charged. The operator answers that in the Stripe dashboard,
// refunding the intent, or letting the charge stand and settling it manually,
// and THEN calls this to unstick the booking.
//
// What it does: clears `depositChargePending`/`depositChargeIntentId`, deletes
// the staged docs that are still `unpaid`, writes an audit row, and resolves
// the alert. What it deliberately does NOT do: touch a `held`/`*_pending`/
// terminal payment doc (those are real money records, a delete would erase
// escrow), issue any refund, or clear a delinquency.
//
// `depositChargeAttempt` is left in place on purpose, exactly as every unstage
// path does: the counter must only ever go up, so the next accept attempt
// mints a key that has never been used.
//
// It also deliberately does NOT lift a delinquency, and that is safe for a
// structural reason rather than a judgement call (shared with unstageAccept,
// see its note): a STAGED doc never carries `deposit.depositAttempts`, which is
// written only by the sweep's birth-deposit charge and never against a staged
// set (rule 3). Firestore indexes only documents that HAVE a field, so such a
// doc is invisible to clearDelinquencyIfSettled's exhausted-deposit query, it
// was never counted as debt, and deleting it extinguishes nothing.
//
// The three refusals below are what keep this from becoming a foot-gun: an
// operator reaching for it on a saga that is still moving would undo work in
// flight. Exported so the test asserts WHICH refusal fired, not merely that
// one did, they are three different situations with three different fixes.
export const SAGA_NOT_STAGED_MESSAGE = "This booking has no staged deposit charge to release.";
export const SAGA_WEBHOOK_OWNED_MESSAGE =
  "This booking's payment is still settling. Cancel or refund the intent in Stripe first, then release it.";
export const SAGA_NOT_ABANDONED_MESSAGE =
  "The sweep is still reconciling this booking: release is only for a saga it has given up on.";

export const releaseStuckSaga = onCall<{ bookingId: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { bookingId } = req.data ?? ({} as { bookingId: string });
    if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

    const db = getFirestore();
    const bookingRef = db.doc(`bookings/${bookingId}`);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = snap.data() as BookingRequestDoc;
    // Fail closed on anything that isn't actually stuck: without the marker
    // there is no saga to release, and "clearing" one would be a no-op write
    // that an operator could mistake for a fix.
    if (booking.depositChargePending !== true) {
      throw new HttpsError("failed-precondition", SAGA_NOT_STAGED_MESSAGE);
    }
    // A recorded pending intent means the charge is still SETTLING and the
    // payment_intent.succeeded webhook owns this saga: it will complete the
    // accept out-of-band, against exactly the staged docs this callable would
    // delete. Releasing here races a charge that can still succeed, the
    // curator ends up paid for a booking that is no longer confirmed. The
    // operator's move for a genuinely stalled intent is to cancel or refund it
    // in Stripe first; that stops the webhook, and the saga then ages into the
    // window below.
    if (booking.depositChargeIntentId != null) {
      throw new HttpsError("failed-precondition", SAGA_WEBHOOK_OWNED_MESSAGE);
    }
    // ...and the sweep must have GIVEN UP on it. Inside the idempotency
    // window the sweep reconciles this booking automatically on its next
    // hourly run, replaying the persisted key, which returns the original
    // intent rather than charging again, so releasing here would delete the
    // staged set out from under a charge that is about to be replayed and
    // could still succeed. That is precisely the hazard rule 3 exists for.
    //
    // Two independent signals, either sufficient:
    //  - `updatedAt` older than the window: the sweep's own staleness test,
    //    evaluated the same way it evaluates it;
    //  - an UNRESOLVED `stuckSagaAlertId(bookingId)` row: the sweep's
    //    durable record that it already refused this booking. Looked up by
    //    deterministic id (no query, no index) because that id IS the sweep's
    //    naming contract for this exact problem. It covers the cases the clock
    //    alone misses, a `stuck_saga_marker` on a booking whose `updatedAt`
    //    was recently bumped by the write that stranded it (e.g. an expiry
    //    cascade), which the sweep has still definitively given up on.
    const alert = (await db.doc(`adminAlerts/${stuckSagaAlertId(bookingId)}`).get()).data() as AdminAlertDoc | undefined;
    const sweepGaveUp = booking.updatedAt < Date.now() - IDEMPOTENCY_WINDOW_MS
      || (alert != null && alert.resolvedAt == null);
    if (!sweepGaveUp) {
      throw new HttpsError("failed-precondition", SAGA_NOT_ABANDONED_MESSAGE);
    }

    // Only `unpaid` docs, the staging. A doc that reached `held` (or any
    // pending/terminal state) is money that exists and is not this callable's
    // to erase.
    const paymentsSnap = await db.collection(`bookings/${bookingId}/payments`).get();
    const removed: string[] = [];
    const kept: string[] = [];
    // ONE batch for the deletes AND the marker clear: a partial release is the
    // worst outcome available here, staged docs gone but the marker still set
    // leaves a booking the sweep will now "release" as empty, while a cleared
    // marker with docs still present leaves an acceptable-looking booking
    // carrying a previous attempt's staging. Bounded by occurrences-per-booking
    // (+1), so far under Firestore's 500-op limit; no chunking needed.
    const batch = db.batch();
    for (const doc of paymentsSnap.docs) {
      const p = doc.data() as PaymentDoc;
      if (p.deposit.status !== "unpaid") { kept.push(`${doc.id}:${p.deposit.status}`); continue; }
      batch.delete(doc.ref);
      removed.push(doc.id);
    }
    // Belt-and-braces precondition on the read this whole decision was made
    // from: if ANY writer touched the booking since (the sweep completing the
    // saga, a webhook, a second operator), this release is acting on a world
    // that no longer exists and must fail rather than clobber it.
    batch.update(bookingRef, {
      depositChargePending: false, depositChargeIntentId: null, updatedAt: Date.now(),
    }, { lastUpdateTime: snap.updateTime! });
    await batch.commit();

    await writeAudit({
      actorUid, action: "booking_saga_released", targetId: bookingId,
      detail: `released staged deposit charge (attempt ${String(booking.depositChargeAttempt ?? "none")}); `
        + `deleted ${removed.length} unpaid staged doc(s)${kept.length ? `; kept ${kept.join(", ")}` : ""}`,
    });

    // Best-effort: the alert doc is a queue entry, not a money record, a
    // failure to close it must not fail a release that already committed.
    await db.doc(`adminAlerts/${stuckSagaAlertId(bookingId)}`)
      .update({ resolvedAt: Date.now() })
      .catch(() => { /* no alert row (released before a sweep ever saw it), nothing to resolve */ });

    return { ok: true, deletedStagedDocs: removed.length };
  });

// ---------- SP5 Task 10: the curator's true-up ----------

export interface ConfirmOccurrenceActualsInput {
  bookingId: string; gigId: string; extraMinutes?: number; extraSongs?: number;
}

// Caller-facing refusals, DIFFERENT situations with DIFFERENT fixes, and a
// test that only asserts "failed-precondition" cannot tell them apart. Moved
// to @gatekeep/shared/messages.ts (review round 1, the fix round before Task
// 15) so TrueUpForm's client-side validation hint can mirror this exact
// copy; re-exported here so every existing in-repo import (this file's own
// callable below, functions/test/*) keeps resolving from "./payments.js"
// unchanged.
export {
  TRUE_UP_SHAPE_MESSAGE, trueUpOverCapMessage, TRUE_UP_WINDOW_CLOSED_MESSAGE,
  TRUE_UP_PAYMENT_STARTED_MESSAGE, TRUE_UP_CHARGE_IN_FLIGHT_MESSAGE, TRUE_UP_INCREASE_ONLY_MESSAGE,
};

// Curator-only, INCREASE-ONLY true-up of what actually happened on one booked
// date, reported during the T+3 settlement window.
//
// Three properties make this safe to expose to a client at all:
//  1. It writes EXTRAS ONLY, never an amount. The money is still computed
//     server-side from the booking's frozen `acceptedTerms` and the gig's own
//     duration (see chargeSettlement); this call can only move the quantity
//     the frozen rate is applied to.
//  2. It only ever moves that quantity UP (validated against the previous
//     report), so a curator can never talk their own bill down after the fact,
//     and a repeated call REPLACES rather than accumulates, the payload is
//     the cumulative total, so a retried/duplicated request is idempotent.
//  3. It is refused once the settlement leaves `pending`, once a charge has
//     been initiated at all (`settlement.intentId`, a still-`processing`
//     PaymentIntent leaves the status `pending`), AND for as long as a charge
//     is IN FLIGHT (`settlement.chargingSince`, written immediately before the
//     Stripe call). Without that last one there is a one-write-wide window in
//     which a true-up could land between the amount being computed and the
//     intent id being recorded, settling the doc for an amount that was never
//     charged.
//
// Structure-aware: perHour bookings true-up minutes, perSong bookings true-up
// songs, and perSet bookings are flat, there is nothing to report.
export const confirmOccurrenceActuals = onCall<ConfirmOccurrenceActualsInput>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { bookingId, gigId, extraMinutes: rawMinutes, extraSongs: rawSongs } =
      req.data ?? ({} as ConfirmOccurrenceActualsInput);
    if (!isValidDocId(bookingId) || !isValidDocId(gigId)) {
      throw new HttpsError("invalid-argument", "Booking and gig ids are required.");
    }
    // Untrusted onCall payload: the declared param types only bind trusted
    // callers, so both extras are re-checked as non-negative whole numbers
    // inside their caps (which also bound the settlement base, spec §4).
    const extraMinutes = rawMinutes ?? 0;
    const extraSongs = rawSongs ?? 0;
    // SHAPE first (a non-integer/negative/empty report is malformed), then the
    // CAPS, which are a different complaint with a different fix, see the
    // message constants above.
    if (!Number.isInteger(extraMinutes) || extraMinutes < 0
      || !Number.isInteger(extraSongs) || extraSongs < 0
      || (extraMinutes === 0 && extraSongs === 0)) {
      throw new HttpsError("invalid-argument", TRUE_UP_SHAPE_MESSAGE);
    }
    if (extraMinutes > MAX_TRUE_UP_EXTRA_MINUTES) {
      throw new HttpsError("invalid-argument", trueUpOverCapMessage("minutes", MAX_TRUE_UP_EXTRA_MINUTES));
    }
    if (extraSongs > MAX_TRUE_UP_EXTRA_SONGS) {
      throw new HttpsError("invalid-argument", trueUpOverCapMessage("songs", MAX_TRUE_UP_EXTRA_SONGS));
    }

    const db = getFirestore();
    const bookingSnap = await db.doc(`bookings/${bookingId}`).get();
    if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnap.data() as BookingRequestDoc;
    // Side-DEPENDENT money action ⇒ the strict resolver (a member of BOTH
    // profiles is refused rather than silently resolved to one side).
    // Deliberately NOT gated on booking.status: a cancelled or expired booking
    // can still own a past-start date that was genuinely performed and still
    // settles (the same rule the settlement sweeps are built around).
    const side = await resolveBookingSideStrict(booking, uid);
    if (side !== "curator") throw new HttpsError("permission-denied", "Only the curator side can report actuals.");
    if (booking.structure === "perSet") {
      throw new HttpsError("failed-precondition", "Per-set bookings settle flat: nothing to report.");
    }
    if (booking.structure === "perHour" && extraSongs > 0) {
      throw new HttpsError("invalid-argument", "This booking bills per hour. Report extra minutes.");
    }
    if (booking.structure === "perSong" && extraMinutes > 0) {
      throw new HttpsError("invalid-argument", "This booking bills per song. Report extra songs.");
    }

    const now = Date.now();
    // Transactional: the read that validates "still reportable / only
    // increasing" and the write that acts on it must not be separated by a
    // sweep run that charges the settlement in between.
    await db.runTransaction(async (tx) => {
      const ref = db.doc(`bookings/${bookingId}/payments/${gigId}`);
      const snap = await tx.get(ref);
      const p = snap.data() as PaymentDoc | undefined;
      if (!p) throw new HttpsError("not-found", "No payment record for that date.");
      // TIME-BOUNDED on purpose: `chargingSince` is cleared by every terminal
      // settlement write, but an instance that dies mid-charge leaves it set
      // with nothing to clear it. Bounding it by Stripe's idempotency window
      // means such a marker stops blocking exactly when the charge behind it
      // stops being replayable, the same clock every other SP5 recovery
      // guard measures against.
      const charging = p.settlement.chargingSince != null
        && now - p.settlement.chargingSince < IDEMPOTENCY_WINDOW_MS;
      // Three distinct refusals, checked in order of how permanent they are
      // (M5). All three were one message before; the fixes differ.
      if (p.settlement.status !== "pending") {
        throw new HttpsError("failed-precondition", TRUE_UP_WINDOW_CLOSED_MESSAGE);
      }
      if (p.settlement.intentId != null) {
        throw new HttpsError("failed-precondition", TRUE_UP_PAYMENT_STARTED_MESSAGE);
      }
      if (charging) {
        throw new HttpsError("failed-precondition", TRUE_UP_CHARGE_IN_FLIGHT_MESSAGE);
      }
      const prev = p.settlement.trueUp;
      if (prev && (extraMinutes < prev.extraMinutes || extraSongs < prev.extraSongs)) {
        throw new HttpsError("failed-precondition", TRUE_UP_INCREASE_ONLY_MESSAGE);
      }
      tx.update(ref, {
        "settlement.trueUp": { extraMinutes, extraSongs, reportedAt: now },
        updatedAt: now,
      });
    });
    return { ok: true };
  });

// ---------- SP5 Task 11: the curator's way out of delinquency ----------

export interface PayPastDueInput { bookingId: string; gigId: string; }

// Caller-facing refusals, five different situations with five different
// fixes. Moved to @gatekeep/shared/messages.ts (review round 1, the fix
// round before Task 15) so PayPastDueButton can key UI off the specific one
// that fired; re-exported here so every existing in-repo import (this
// file's own callable below, functions/test/*) keeps resolving from
// "./payments.js" unchanged.
export {
  PAY_PAST_DUE_NOT_OVERDUE_MESSAGE, PAY_PAST_DUE_NOTHING_OWED_MESSAGE, PAY_PAST_DUE_NO_CUSTOMER_MESSAGE,
  PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE, PAY_PAST_DUE_RACED_MESSAGE, PAY_PAST_DUE_DATE_CANCELLED_MESSAGE,
};

// ON-SESSION recovery from a `past_due` (usually delinquent) settlement: the
// server prices the debt, mints a PaymentIntent the curator confirms in the
// browser with Elements, a FRESH card is fine, which is rather the point,
// since the card on file is the one that kept declining, and the
// `payment_intent.succeeded` webhook finalizes it through exactly the same
// tail as an ordinary settlement (transfer, terminal write, ledger, aggregate,
// delinquency lift, notification).
//
// DELIBERATELY NOT GATED ON requireCuratorChargeable. That gate refuses a
// delinquent curator, and a delinquent curator is precisely who this callable
// is for, gating it would make delinquency inescapable.
//
// THE AMOUNT IS SERVER-COMPUTED, always: `settlementMath` over the booking's
// frozen terms, the gig's own duration, the curator's own true-up and the
// booking's fee-policy snapshot, the very function the off-session charge
// prices from, so the two can never disagree (spec §4: no client input reaches
// a settlement amount). It includes the late fee, whose musician share rides
// back out on the earnings transfer.
//
// HOW THIS COOPERATES WITH chargeSettlement'S OUTSTANDING-INTENT GUARD:
//  - it persists its intent in `settlement.intentId` AND PARKS `nextRetryAt`
//    one confirmation window out (PAYDUE_CONFIRM_WINDOW_MS) in ONE write. The
//    park stops the sweep from charging the card off-session while the curator
//    is confirming in the browser; parking rather than NULLING is what keeps an
//    abandoned attempt from silently ending dunning forever (review round 1,
//    defect 3b), the sweep re-selects the doc an hour later, finds the
//    outstanding intent, and escalates it;
//  - it refuses while a charge is IN FLIGHT (`settlement.chargingSince` inside
//    Stripe's key window, defect 3a), so a sweep run that has already computed
//    an amount and is mid-`chargeOffSession` cannot be joined by an on-session
//    intent for the same debt;
//  - it mirrors the id into `settlement.payDueIntentId`, which is how a LATER
//    call proves the outstanding intent is its own to replace. An abandoned
//    attempt is resumed by calling again: the key is deterministic per attempt,
//    so Stripe replays the SAME intent (never a rival second one) and the
//    curator gets its clientSecret back;
//  - an intent that is NOT ours (an off-session settlement charge) is refused
//    outright, see PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE.
//
// IT ALSO PAYS AN EXHAUSTED BIRTH DEPOSIT. A deposit that ran out its own
// retry schedule (sweep step 3) declares the same delinquency a failed
// settlement does, but leaves no `past_due` settlement behind, so without this
// second mode a curator whose only debt is a deposit had NO way to clear the
// gate at all. That mode charges `sliceCents + feeShareCents` (both frozen at
// staging) for a FUTURE occurrence and finalizes into held escrow.
// What the callable hands back, in the two shapes it actually has. Exported so
// the web (and a test) binds the same contract the server returns, rather than
// re-describing it (review round 3, M9).
export type PayPastDueResult =
  // FAKE STRIPE ONLY: the emulator has no Elements flow, so the callable
  // finalizes inline and the debt is settled by the time it returns.
  | { done: true; amountCents: number }
  // REAL: `clientSecret` is what the browser confirms with Elements, after
  // which the payment_intent.succeeded webhook finalizes. `clientSecret` is
  // absent only on the fake path's own non-success exits.
  | { done: false; amountCents: number; clientSecret?: string };

// Everything both branches resolved before the fork. Passed as one object so
// neither branch re-reads a doc the dispatcher already has, every field here
// is the read the decision was made from, and the CAS preconditions below are
// held to `pSnap.updateTime` for exactly that reason.
interface PayDueContext {
  bookingId: string; gigId: string;
  booking: BookingRequestDoc;
  gig: GigDoc | undefined;
  p: PaymentDoc;
  pSnap: FirebaseFirestore.DocumentSnapshot;
  ref: FirebaseFirestore.DocumentReference;
  stripe: StripeLike;
  now: number;
}

// ===================== THE DEPOSIT DEBT =========================
// An exhausted birth deposit on a date that has not settled yet.
async function payDueDeposit(ctx: PayDueContext): Promise<PayPastDueResult> {
  const { bookingId, gigId, booking, p, pSnap, ref, stripe, now } = ctx;
  // RULE 3 (paymentsSweep.ts's header): an `unpaid` doc under a booking
  // carrying the accept-saga marker belongs to step 1 alone, a charge is in
  // flight against exactly that staged set, and charging one of its docs here,
  // on a key that saga knows nothing about, is how one accept becomes two
  // charges.
  if (booking.depositChargePending === true) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE);
  }
  // Same only-mine-replaceable rule as the settlement side: an `unpaid`
  // deposit that already carries an intent is a birth charge left `processing`
  // (sweep step 3's own pending path), and that intent can still capture.
  if (p.deposit.intentId != null && p.deposit.intentId !== p.deposit.payDueIntentId) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE);
  }
  // Both figures were frozen when the doc was staged (buildPaymentDoc) and no
  // path rewrites them, so this amount is as stable as the settlement side's,
  // the same property that makes the deterministic key safe.
  const amountCents = p.deposit.sliceCents + p.deposit.feeShareCents;
  if (amountCents <= 0) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_NOTHING_OWED_MESSAGE);
  }
  const curatorStripe = await getStripeProfileDoc(p.curatorProfileId);
  if (!curatorStripe?.customerId) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_NO_CUSTOMER_MESSAGE);
  }
  const intent = await stripe.createOnSessionIntent({
    customerId: curatorStripe.customerId, amountCents,
    // Scoped to the ATTEMPT counter, exactly like the sweep's own
    // `deposit:{depositAttempts}` key, and distinct from it, so a pay-now
    // intent can never collide with (or replay) an off-session attempt.
    idempotencyKey: `${bookingId}:${gigId}:paydue_deposit:${p.deposit.depositAttempts ?? 0}`,
    meta: { bookingId, gigId, purpose: "paydue_deposit" },
  });
  try {
    // Records the intent WITHOUT moving the doc off `unpaid`: the money has not
    // been captured yet. Note that an `unpaid` doc carrying an intent is
    // already meaningful elsewhere, both waive branches route such a doc
    // through `refund_pending` rather than straight to `refunded`, which is
    // exactly the handling an in-flight on-session intent needs.
    await ref.update({
      "deposit.intentId": intent.id,
      "deposit.payDueIntentId": intent.id,
      updatedAt: now,
    }, { lastUpdateTime: pSnap.updateTime! });
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_RACED_MESSAGE);
  }
  if (isFakeStripe(stripe)) {
    // Emulator contract (see payDueSettlement's): "called" means "confirmed".
    // The real path's equivalent is the "paydue_deposit" webhook purpose, which
    // runs this same finalizer.
    const { outcome } = await finalizeDepositPayDue({
      bookingId, gigId, intentId: intent.id, chargedCents: amountCents, now,
    });
    if (outcome === "raced") {
      // The money moved but no escrow exists: a cancellation claimed this doc
      // mid-call and its executor will send the charge back. Reporting
      // `done: true` here would tell the curator their date is secured at the
      // exact moment it was cancelled out from under them.
      throw new HttpsError("failed-precondition", PAY_PAST_DUE_DATE_CANCELLED_MESSAGE);
    }
    return outcome === "held" ? { done: true, amountCents } : { done: false, amountCents };
  }
  return { done: false, clientSecret: intent.clientSecret, amountCents };
}

// ===================== THE SETTLEMENT DEBT ========================
// A performed date whose charge failed, the only debt that can carry a late
// fee, and the only one the dunning ladder produces.
async function payDueSettlement(ctx: PayDueContext): Promise<PayPastDueResult> {
  const { bookingId, gigId, booking, gig, p, pSnap, ref, stripe, now } = ctx;
  // Both are needed to PRICE the date; without them there is no honest
  // amount to charge, and inventing one is not an option for money.
  if (!gig || !booking.acceptedTerms) {
    throw new HttpsError("failed-precondition", "This date can no longer be priced. Contact support.");
  }
  // DEFECT 3a, A CHARGE IS IN FLIGHT RIGHT NOW. `chargingSince` is
  // chargeSettlement's pre-charge claim: a sweep run has computed an amount
  // and is inside its `chargeOffSession` call. Minting an on-session intent
  // beside it would let the curator confirm one charge while the card is
  // being charged for the same debt off-session.
  //
  // WINDOW-BOUNDED DELIBERATELY, and the bound is the whole point: past
  // IDEMPOTENCY_WINDOW_MS a stale claim is chargeSettlement's PERMANENT
  // refusal (its stale-claim terminator), so treating it as permanent here
  // too would leave the curator with no way to pay at all, gated by a debt
  // the system has also stopped trying to collect. Inside the window the
  // sweep is still the owner; past it, the operator route is the alert
  // chargeSettlement raises, and the curator may still pay.
  const charging = p.settlement.chargingSince;
  if (charging != null && now - charging < IDEMPOTENCY_WINDOW_MS) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE);
  }
  // The double-charge guard. See the header note: only an intent this
  // callable itself minted may be replaced.
  if (p.settlement.intentId != null && p.settlement.intentId !== p.settlement.payDueIntentId) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE);
  }

  const math = settlementMath(p, booking, gig);
  if (math.chargeTotal <= 0) {
    // A `past_due` doc with nothing owed is a contradiction (a decline needs
    // something to have been charged), so this is a fail-closed refusal
    // rather than a silent zero-amount intent Stripe would reject anyway.
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_NOTHING_OWED_MESSAGE);
  }
  const curatorStripe = await getStripeProfileDoc(p.curatorProfileId);
  if (!curatorStripe?.customerId) {
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_NO_CUSTOMER_MESSAGE);
  }

    // ATTEMPT-SCOPED, like every other SP5 key (as-built contract #2), and
    // here the replay is a FEATURE: a repeat call for the same attempt hands
    // back the same intent instead of minting a rival one.
    //
    // THE INVARIANT THAT MAKES THAT SAFE: on a `past_due` doc the amount cannot
    // drift, so a replayed intent can never be for the wrong money. All five
    // inputs settlementMath reads are frozen by this point,
    //  1. `booking.acceptedTerms.amountCents`, stamped at accept, never
    //     rewritten by any path;
    //  2. `booking.acceptedTerms.expectedQuantity`, likewise;
    //  3. `gig.durationMinutes`, updateGig REFUSES a `filled`/`closed` gig
    //     outright ("its schedule and terms are locked"), and a gig that left
    //     `filled` fails chargeSettlement's linkage check into a waive instead;
    //  4. `settlement.trueUp`, confirmOccurrenceActuals refuses unless the
    //     settlement is `pending`, and this one is `past_due`;
    //  5. `deposit.sliceCents` (with `deposit.status` deciding whether it is
    //     credited), frozen at staging, and a `past_due` settlement's deposit
    //     is `held`, which is one of the two crediting states.
    // Plus `booking.feePolicy`, a snapshot taken at accept, and
    // `settlement.lateFeeCents`, written once at delinquency behind
    // recordSettlementFailure's re-entry guard. `attempts` itself only moves on
    // a decline, and the ladder that produces declines is over, so if the
    // amount ever COULD change, the key would change with it.
  const intent = await stripe.createOnSessionIntent({
    customerId: curatorStripe.customerId, amountCents: math.chargeTotal,
    idempotencyKey: `${bookingId}:${gigId}:paydue:${p.settlement.attempts}`,
    meta: { bookingId, gigId, purpose: "paydue" },
  });

  // CAS on the read this whole decision came from: an intent must never be
  // stamped onto a doc a racer has just waived or settled. Creating the
  // intent BEFORE this write is safe, an on-session intent captures nothing
  // until the client confirms it, so a lost race leaves an unconfirmed,
  // unreferenced intent and no money anywhere.
  let baseline: FirebaseFirestore.Timestamp;
  try {
    const wr = await ref.update({
      "settlement.intentId": intent.id,
      "settlement.payDueIntentId": intent.id,
      // PARKED, never nulled (defect 3b). One confirmation window of quiet
      // is all the browser needs, and it is what stops the sweep from also
      // charging the card off-session in the meantime, but the doc STAYS in
      // step 6's query, so an attempt the curator abandons comes back to
      // chargeSettlement an hour from now and is escalated as an abandoned
      // pay-now intent instead of vanishing from the dunning system. Written
      // unconditionally: a curator paying EARLY (on rung 1, 2 or 3) gets the
      // same protection as a delinquent one, whose clock was already null.
      "settlement.nextRetryAt": now + PAYDUE_CONFIRM_WINDOW_MS,
      updatedAt: now,
    }, { lastUpdateTime: pSnap.updateTime! });
    baseline = wr.writeTime;
  } catch (e) {
    if (!isFailedPrecondition(e)) throw e;
    throw new HttpsError("failed-precondition", PAY_PAST_DUE_RACED_MESSAGE);
  }

  if (isFakeStripe(stripe)) {
    // EMULATOR CONTRACT, mirroring createSetupIntent's: there is no Elements
    // flow against a fake, so "payPastDue called" means "the curator paid".
    // The real path's equivalent step is the payment_intent.succeeded webhook
    // for this same intent, which, on the fake, also fires and finds the doc
    // already `paid` (a clean no-op, logged at info).
    //
    // `baseline` is the write above, per finalizeSettlementSuccess's own
    // contract: it spans everything from our claim on this doc to the
    // terminal write.
    const result = await finalizeSettlementSuccess({
      bookingId, gigId, intentId: intent.id, chargedCents: math.chargeTotal, now, baseline,
    });
    // Defensive re-run of the lift: finalizeSettlementSuccess already clears
    // the delinquency on its success path, but not on an exceptional exit
    // (a racer). Calling again is a no-op in every case, the query still
    // sees this doc as `past_due` when the settlement did not actually land.
    await clearDelinquencyIfSettled(p.curatorProfileId, now)
      .catch((e) => console.error(`payPastDue: delinquency clear failed for ${p.curatorProfileId}`, e));
    return result.outcome === "charged"
      ? { done: true, amountCents: math.chargeTotal }
      : { done: false, amountCents: math.chargeTotal };
  }
  return { done: false, clientSecret: intent.clientSecret, amountCents: math.chargeTotal };
}

// THE DISPATCHER. Auth, ids, side, the reads both branches share, and the one
// decision that picks a branch, deliberately nothing else (review round 3,
// M6): the two debts have almost disjoint guards, amounts, keys and finalizers,
// and interleaving them in one body made it hard to see which rule applied to
// which kind of money.
export const payPastDue = onCall<PayPastDueInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<PayPastDueResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { bookingId, gigId } = req.data ?? ({} as PayPastDueInput);
    if (!isValidDocId(bookingId) || !isValidDocId(gigId)) {
      throw new HttpsError("invalid-argument", "Booking and gig ids are required.");
    }

    const db = getFirestore();
    const bookingSnap = await db.doc(`bookings/${bookingId}`).get();
    if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnap.data() as BookingRequestDoc;
    // Side-DEPENDENT money action ⇒ the strict resolver (a member of BOTH
    // profiles is refused rather than silently resolved to one side).
    // Deliberately NOT gated on booking.status: a cancelled or expired booking
    // can still own a performed date whose settlement went past_due, and that
    // debt is exactly what this pays.
    const side = await resolveBookingSideStrict(booking, uid);
    if (side !== "curator") throw new HttpsError("permission-denied", "Only the curator side can pay a settlement.");

    const ref = db.doc(`bookings/${bookingId}/payments/${gigId}`);
    const [pSnap, gigSnap] = await Promise.all([ref.get(), db.doc(`gigs/${gigId}`).get()]);
    const p = pSnap.data() as PaymentDoc | undefined;
    if (!p) throw new HttpsError("not-found", "No payment record for that date.");

    // WHICH DEBT? Settlement first: it is a date that was actually performed,
    // and it is the only one that can carry a late fee. A deposit debt is
    // second, and only once its own retry schedule has run out, before that
    // the sweep is still trying, and a manual charge would race it.
    const settlementDue = p.settlement.status === "past_due";
    const depositDue = isDepositScheduleExhausted(p.deposit.depositAttempts)
      && p.deposit.status === "unpaid"
      // ...for a date that has NOT been settled yet, which is what the deposit
      // branch's own "future occurrence" framing already assumes, made explicit
      // (review round 2, D1). A settlement that charged with no slice credit
      // took the FULL base, deposit included, and finalizeSettlementSuccess
      // resolves such a deposit `refunded` for exactly that reason; charging it
      // here would bill the curator a second time for money already collected.
      // `waived` is excluded on the same logic (nothing is owed for the date at
      // all) and `past_due` is the settlement branch's business, not this one.
      && (p.settlement.status === "not_due" || p.settlement.status === "pending");
    if (!settlementDue && !depositDue) {
      throw new HttpsError("failed-precondition", PAY_PAST_DUE_NOT_OVERDUE_MESSAGE);
    }

    const ctx: PayDueContext = {
      bookingId, gigId, booking, gig: gigSnap.data() as GigDoc | undefined,
      p, pSnap, ref, stripe: getStripe(), now: Date.now(),
    };
    return settlementDue ? payDueSettlement(ctx) : payDueDeposit(ctx);
  });

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, MAX_TRUE_UP_EXTRA_MINUTES, MAX_TRUE_UP_EXTRA_SONGS,
  type AdminAlertDoc, type BookingRequestDoc, type PaymentDoc, type StripeProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { requireAdmin, writeAudit } from "./review.js";
import {
  getStripe, isFakeStripe, stripeSecretKey,
  StripeAccountMissingError, StripeSetupIntentMismatchError, type StripeAccountState,
} from "./stripeClient.js";
import { getStripeProfileDoc, IDEMPOTENCY_WINDOW_MS } from "./paymentsCore.js";
import { resolveBookingSideStrict } from "./bookingLifecycle.js";
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
    // Review round 2, #3: RegExp.test coerces a non-string to a string first
    // (e.g. `123` -> "123" would otherwise sail through) — check the type
    // explicitly rather than leaning on the coercion.
    if (setupIntentId !== undefined && (typeof setupIntentId !== "string" || !STRIPE_ID_RE.test(setupIntentId))) {
      throw new HttpsError("invalid-argument", "Invalid setup intent id.");
    }
    await requireProfileMember(profileId, uid);
    const db = getFirestore();
    const sp = await getStripeProfileDoc(profileId);
    if (!sp?.customerId) throw new HttpsError("failed-precondition", "No payment account yet — save a card first.");
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
      // card on file" — it only means THIS SetupIntent didn't pan out
      // (unknown id, nothing attached). Wiping the cache would erase a
      // perfectly good card that was already on file. Refuse instead and
      // leave the cached fields untouched — only the unconditional write on
      // the no-setupIntentId branch below is authoritative.
      if (!pm) throw new HttpsError("failed-precondition", "We couldn't find that card — try saving it again.");
      await stripe.setDefaultPaymentMethod(sp.customerId, pm.id);
      await db.doc(`profiles/${profileId}/private/stripe`).set(
        { defaultPaymentMethodId: pm.id, cardBrand: pm.brand, cardLast4: pm.last4, updatedAt: Date.now() }, { merge: true });
      return { hasCard: true, cardBrand: pm.brand, cardLast4: pm.last4 };
    }

    // Authoritative branch: reads the customer's actual current default —
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
  if (!isValidDocId(profileId)) {
    // Review round 2 (log nit): this is corrupt metadata on an account
    // Stripe itself sent us — more log-worthy than the ordinary accountId
    // mismatch case below (that one's often just a stale/replayed event).
    console.warn(`account.updated webhook: metadata.profileId is not a valid doc id — accountId=${accountId}, profileId=${JSON.stringify(profileId)}`);
    return;
  }
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
// curator was charged. The operator answers that in the Stripe dashboard —
// refunding the intent, or letting the charge stand and settling it manually —
// and THEN calls this to unstick the booking.
//
// What it does: clears `depositChargePending`/`depositChargeIntentId`, deletes
// the staged docs that are still `unpaid`, writes an audit row, and resolves
// the alert. What it deliberately does NOT do: touch a `held`/`*_pending`/
// terminal payment doc (those are real money records — a delete would erase
// escrow), issue any refund, or clear a delinquency.
//
// `depositChargeAttempt` is left in place on purpose, exactly as every unstage
// path does: the counter must only ever go up, so the next accept attempt
// mints a key that has never been used.
//
// The three refusals below are what keep this from becoming a foot-gun: an
// operator reaching for it on a saga that is still moving would undo work in
// flight. Exported so the test asserts WHICH refusal fired, not merely that
// one did — they are three different situations with three different fixes.
export const SAGA_NOT_STAGED_MESSAGE = "This booking has no staged deposit charge to release.";
export const SAGA_WEBHOOK_OWNED_MESSAGE =
  "This booking's payment is still settling — cancel or refund the intent in Stripe first, then release it.";
export const SAGA_NOT_ABANDONED_MESSAGE =
  "The sweep is still reconciling this booking — release is only for a saga it has given up on.";

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
    // delete. Releasing here races a charge that can still succeed — the
    // curator ends up paid for a booking that is no longer confirmed. The
    // operator's move for a genuinely stalled intent is to cancel or refund it
    // in Stripe first; that stops the webhook, and the saga then ages into the
    // window below.
    if (booking.depositChargeIntentId != null) {
      throw new HttpsError("failed-precondition", SAGA_WEBHOOK_OWNED_MESSAGE);
    }
    // ...and the sweep must have GIVEN UP on it. Inside the idempotency
    // window the sweep reconciles this booking automatically on its next
    // hourly run — replaying the persisted key, which returns the original
    // intent rather than charging again — so releasing here would delete the
    // staged set out from under a charge that is about to be replayed and
    // could still succeed. That is precisely the hazard rule 3 exists for.
    //
    // Two independent signals, either sufficient:
    //  - `updatedAt` older than the window: the sweep's own staleness test,
    //    evaluated the same way it evaluates it;
    //  - an UNRESOLVED `adminAlerts/stuck-saga:{bookingId}` row: the sweep's
    //    durable record that it already refused this booking. Looked up by
    //    deterministic id (no query, no index) because that id IS the sweep's
    //    naming contract for this exact problem. It covers the cases the clock
    //    alone misses — a `stuck_saga_marker` on a booking whose `updatedAt`
    //    was recently bumped by the write that stranded it (e.g. an expiry
    //    cascade), which the sweep has still definitively given up on.
    const alert = (await db.doc(`adminAlerts/stuck-saga:${bookingId}`).get()).data() as AdminAlertDoc | undefined;
    const sweepGaveUp = booking.updatedAt < Date.now() - IDEMPOTENCY_WINDOW_MS
      || (alert != null && alert.resolvedAt == null);
    if (!sweepGaveUp) {
      throw new HttpsError("failed-precondition", SAGA_NOT_ABANDONED_MESSAGE);
    }

    // Only `unpaid` docs — the staging. A doc that reached `held` (or any
    // pending/terminal state) is money that exists and is not this callable's
    // to erase.
    const paymentsSnap = await db.collection(`bookings/${bookingId}/payments`).get();
    const removed: string[] = [];
    const kept: string[] = [];
    // ONE batch for the deletes AND the marker clear: a partial release is the
    // worst outcome available here — staged docs gone but the marker still set
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

    // Best-effort: the alert doc is a queue entry, not a money record — a
    // failure to close it must not fail a release that already committed.
    await db.doc(`adminAlerts/stuck-saga:${bookingId}`)
      .update({ resolvedAt: Date.now() })
      .catch(() => { /* no alert row (released before a sweep ever saw it) — nothing to resolve */ });

    return { ok: true, deletedStagedDocs: removed.length };
  });

// ---------- SP5 Task 10: the curator's true-up ----------

export interface ConfirmOccurrenceActualsInput {
  bookingId: string; gigId: string; extraMinutes?: number; extraSongs?: number;
}

// Curator-only, INCREASE-ONLY true-up of what actually happened on one booked
// date, reported during the T+3 settlement window.
//
// Three properties make this safe to expose to a client at all:
//  1. It writes EXTRAS ONLY — never an amount. The money is still computed
//     server-side from the booking's frozen `acceptedTerms` and the gig's own
//     duration (see chargeSettlement); this call can only move the quantity
//     the frozen rate is applied to.
//  2. It only ever moves that quantity UP (validated against the previous
//     report), so a curator can never talk their own bill down after the fact,
//     and a repeated call REPLACES rather than accumulates — the payload is
//     the cumulative total, so a retried/duplicated request is idempotent.
//  3. It is refused once the settlement leaves `pending`, and once a charge
//     has been initiated at all (`settlement.intentId`) — a pending
//     PaymentIntent is still `pending`-status, and letting the true-up move
//     under it would settle the doc for an amount that was never charged.
//
// Structure-aware: perHour bookings true-up minutes, perSong bookings true-up
// songs, and perSet bookings are flat — there is nothing to report.
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
    // inside their caps (which also bound the settlement base — spec §4).
    const extraMinutes = rawMinutes ?? 0;
    const extraSongs = rawSongs ?? 0;
    if (!Number.isInteger(extraMinutes) || extraMinutes < 0 || extraMinutes > MAX_TRUE_UP_EXTRA_MINUTES
      || !Number.isInteger(extraSongs) || extraSongs < 0 || extraSongs > MAX_TRUE_UP_EXTRA_SONGS
      || (extraMinutes === 0 && extraSongs === 0)) {
      throw new HttpsError("invalid-argument", "Report extra minutes and/or extra songs as positive whole numbers.");
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
      throw new HttpsError("failed-precondition", "Per-set bookings settle flat — nothing to report.");
    }
    if (booking.structure === "perHour" && extraSongs > 0) {
      throw new HttpsError("invalid-argument", "This booking bills per hour — report extra minutes.");
    }
    if (booking.structure === "perSong" && extraMinutes > 0) {
      throw new HttpsError("invalid-argument", "This booking bills per song — report extra songs.");
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
      if (p.settlement.status !== "pending" || p.settlement.intentId != null) {
        throw new HttpsError("failed-precondition", "Actuals can only be reported during the settlement window.");
      }
      const prev = p.settlement.trueUp;
      if (prev && (extraMinutes < prev.extraMinutes || extraSongs < prev.extraSongs)) {
        throw new HttpsError("failed-precondition", "Reported actuals can only increase.");
      }
      tx.update(ref, {
        "settlement.trueUp": { extraMinutes, extraSongs, reportedAt: now },
        updatedAt: now,
      });
    });
    return { ok: true };
  });

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  CURATOR_FEE_PCT, DEPOSIT_PERCENT,
  type BookingRequestDoc, type PaymentDoc, type ProfileDraftInput, type StripeProfileDoc,
} from "@gatekeep/shared";
import type { RefreshPaymentMethodInput } from "../src/payments.js";
import {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  BOOKING_NOT_CONFIRMABLE_MESSAGE, CARD_DECLINED_MESSAGE, DEPOSIT_PROCESSING_MESSAGE,
} from "../src/paymentsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

// 30s — was 20s (bookings.test.ts's precedent for booking-adjacent suites
// that chain several callables before reaching an assertion). Task 6's accept
// saga tests chain the longest sequences in this file: two approved profiles,
// makeMoneyReady, up to three createGig/publishGig pairs, applyToGig, and an
// acceptBooking that now runs two transactions plus a Stripe round trip —
// matching bookings.test.ts's own 30s for the same reason.
vi.setConfig({ testTimeout: 30_000 });

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

// Admin-SDK shortcut for the musician submission gate (bio+genre+avatar+
// track) — mirrors bookings.test.ts's identical fixture; this suite's
// subject is payment identity, not portfolio gate mechanics.
async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}

async function postWebhook(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "fake" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function getStripeDoc(profileId: string): Promise<StripeProfileDoc | undefined> {
  const snap = await adb.doc(`profiles/${profileId}/private/stripe`).get();
  return snap.data() as StripeProfileDoc | undefined;
}

describe("createSetupIntent", () => {
  it("as a member returns a clientSecret and caches the fake card on private/stripe", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("csimember");
    const result = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>(
      "createSetupIntent", { profileId }, owner.user);
    expect(result.clientSecret).toBeTruthy();
    expect(result.customerId).toBeTruthy();

    const sp = await getStripeDoc(profileId);
    expect(sp?.customerId).toBe(result.customerId);
    expect(sp?.cardBrand).toBe("visa");
    expect(sp?.cardLast4).toBe("4242");
    expect(sp?.defaultPaymentMethodId).toBeTruthy();
  });

  it("as a non-member is rejected with permission-denied", async () => {
    const { profileId } = await makeApprovedCuratorProfile("csiowner");
    const stranger = await signUpTestUser(`csi-stranger-${Date.now()}@test.com`);
    await expect(callFn("createSetupIntent", { profileId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("createOnboardingLink", () => {
  it("returns a url and persists accountId + onboardingStartedAt; a second call reuses the same accountId", async () => {
    const { owner, profileId } = await makeApprovedMusicianProfile("colmember");
    const first = await callFn<{ profileId: string }, { url: string }>(
      "createOnboardingLink", { profileId }, owner.user);
    expect(first.url).toBeTruthy();

    const spAfterFirst = await getStripeDoc(profileId);
    expect(spAfterFirst?.accountId).toBeTruthy();
    expect(spAfterFirst?.onboardingStartedAt).toBeTypeOf("number");

    const second = await callFn<{ profileId: string }, { url: string }>(
      "createOnboardingLink", { profileId }, owner.user);
    expect(second.url).toBeTruthy();
    const spAfterSecond = await getStripeDoc(profileId);
    expect(spAfterSecond?.accountId).toBe(spAfterFirst?.accountId);
  });
});

describe("createSetupIntent idempotent customer creation", () => {
  it("calling twice returns the same customerId both times (review round 1, M1 coverage)", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("csitwice");
    const first = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>(
      "createSetupIntent", { profileId }, owner.user);
    const second = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>(
      "createSetupIntent", { profileId }, owner.user);
    expect(second.customerId).toBe(first.customerId);
    // A fresh SetupIntent per call, though — only the customer is reused.
    expect(second.clientSecret).not.toBe(first.clientSecret);
    const sp = await getStripeDoc(profileId);
    expect(sp?.customerId).toBe(first.customerId);
  });
});

describe("getStripeStatus", () => {
  it("reflects cached flags, re-syncing from the fake account and setting onboardedAt once flags flip", async () => {
    const { owner, profileId } = await makeApprovedMusicianProfile("gssmember");
    await callFn("createOnboardingLink", { profileId }, owner.user);
    const sp = await getStripeDoc(profileId);
    const accountId = sp!.accountId!;

    const before = await callFn<{ profileId: string }, { transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean }>(
      "getStripeStatus", { profileId }, owner.user);
    expect(before.transfersEnabled).toBe(false);
    expect(before.payoutsEnabled).toBe(false);
    expect(before.instantEligible).toBe(false);

    await adb.doc(`stripeFake/state/objects/${accountId}`).set(
      { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });

    const after = await callFn<{ profileId: string }, { transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean }>(
      "getStripeStatus", { profileId }, owner.user);
    expect(after.transfersEnabled).toBe(true);
    expect(after.payoutsEnabled).toBe(true);
    expect(after.instantEligible).toBe(true);

    const spAfter = await getStripeDoc(profileId);
    expect(spAfter?.onboardedAt).not.toBeNull();
  });

  it("a deleted fake Connect account (object doc removed) zeroes the flags instead of 500ing (review round 1, I2)", async () => {
    const { owner, profileId } = await makeApprovedMusicianProfile("gssdel");
    await callFn("createOnboardingLink", { profileId }, owner.user);
    const sp = await getStripeDoc(profileId);
    const accountId = sp!.accountId!;

    // Onboard fully first, so there's something meaningful to zero out.
    await adb.doc(`stripeFake/state/objects/${accountId}`).set(
      { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
    await callFn("getStripeStatus", { profileId }, owner.user);
    expect((await getStripeDoc(profileId))?.transfersEnabled).toBe(true);

    // Now delete the fake account object entirely — the fake models this as
    // getAccountState throwing StripeAccountMissingError.
    await adb.doc(`stripeFake/state/objects/${accountId}`).delete();

    const status = await callFn<{ profileId: string }, { transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean }>(
      "getStripeStatus", { profileId }, owner.user);
    expect(status.transfersEnabled).toBe(false);
    expect(status.payoutsEnabled).toBe(false);
    expect(status.instantEligible).toBe(false);

    const spAfter = await getStripeDoc(profileId);
    expect(spAfter?.transfersEnabled).toBe(false);
    expect(spAfter?.payoutsEnabled).toBe(false);
    expect(spAfter?.instantEligible).toBe(false);
  });
});

describe("account.updated webhook", () => {
  it("updates the cached flags for a matching accountId, and leaves a mismatched profile's cached flags untouched even though ITS OWN fake account is already true (review round 1, I3)", async () => {
    const { owner, profileId } = await makeApprovedMusicianProfile("whmatch");
    await callFn("createOnboardingLink", { profileId }, owner.user);
    const sp = await getStripeDoc(profileId);
    const accountId = sp!.accountId!;

    await adb.doc(`stripeFake/state/objects/${accountId}`).set(
      { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });

    const evt = fakeEvent("account.updated", { id: accountId, metadata: { profileId } });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);

    const spAfter = await getStripeDoc(profileId);
    expect(spAfter?.transfersEnabled).toBe(true);
    expect(spAfter?.payoutsEnabled).toBe(true);
    expect(spAfter?.instantEligible).toBe(true);
    expect(spAfter?.onboardedAt).not.toBeNull();

    // A second profile whose CACHED accountId does NOT match this event's
    // account id. Flip that OTHER profile's own fake account flags to true
    // FIRST — a handler that skipped (or got wrong) the mismatch check would
    // still sync against the other profile's OWN cached accountId (the
    // handler never trusts the event's accountId for the Stripe read) and
    // pick these up; only a CORRECT mismatch bail leaves them false.
    const other = await makeApprovedMusicianProfile("whmiss");
    await callFn("createOnboardingLink", { profileId: other.profileId }, other.owner.user);
    const otherSp = await getStripeDoc(other.profileId);
    await adb.doc(`stripeFake/state/objects/${otherSp!.accountId}`).set(
      { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });

    const mismatchEvt = fakeEvent("account.updated", { id: accountId, metadata: { profileId: other.profileId } });
    const mismatchRes = await postWebhook(mismatchEvt);
    expect(mismatchRes.status).toBe(200);

    const otherAfter = await getStripeDoc(other.profileId);
    expect(otherAfter?.transfersEnabled).toBe(false);
    expect(otherAfter?.payoutsEnabled).toBe(false);
    expect(otherAfter?.instantEligible).toBe(false);
  });

  it("an event with no metadata.profileId is a 200 no-op (nothing to write)", async () => {
    const evt = fakeEvent("account.updated", { id: `acct_stray_${Date.now()}` });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);
  });
});

describe("refreshPaymentMethod", () => {
  it("without a customer on file fails with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("rpmnocust");
    await expect(callFn("refreshPaymentMethod", { profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("with a setupIntentId resolves THAT setup intent's card, sets it default, and caches it (review round 1, I1)", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("rpmsi");
    const { clientSecret } = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>(
      "createSetupIntent", { profileId }, owner.user);
    const setupIntentId = clientSecret.replace(/_secret_fake$/, "");

    const result = await callFn<RefreshPaymentMethodInput, { hasCard: boolean; cardBrand: string | null; cardLast4: string | null }>(
      "refreshPaymentMethod", { profileId, setupIntentId }, owner.user);
    expect(result).toEqual({ hasCard: true, cardBrand: "visa", cardLast4: "4242" });

    const sp = await getStripeDoc(profileId);
    expect(sp?.defaultPaymentMethodId).toBe("pm_fake_4242");
    expect(sp?.cardBrand).toBe("visa");
    expect(sp?.cardLast4).toBe("4242");
    // setDefaultPaymentMethod's fake effect: the customer's card marker is set.
    const marker = await adb.doc(`stripeFake/state/cards/${sp!.customerId}`).get();
    expect(marker.data()?.saved).toBe(true);
  });

  it("a setupIntentId belonging to a DIFFERENT customer fails with failed-precondition (review round 1, I1)", async () => {
    const a = await makeApprovedCuratorProfile("rpmsia");
    const b = await makeApprovedCuratorProfile("rpmsib");
    const { clientSecret } = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>(
      "createSetupIntent", { profileId: a.profileId }, a.owner.user);
    const setupIntentId = clientSecret.replace(/_secret_fake$/, "");

    // b needs its own customer on file first (refreshPaymentMethod's
    // no-customer guard fires before the setupIntentId ownership check).
    await callFn("createSetupIntent", { profileId: b.profileId }, b.owner.user);

    await expect(callFn<RefreshPaymentMethodInput, unknown>(
      "refreshPaymentMethod", { profileId: b.profileId, setupIntentId }, b.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("an unknown setupIntentId (fake resolves to null) fails with failed-precondition and leaves the cached card untouched (review round 2, #2)", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("rpmsiunk");
    await callFn("createSetupIntent", { profileId }, owner.user);
    const before = await getStripeDoc(profileId);
    expect(before?.defaultPaymentMethodId).toBe("pm_fake_4242");

    await expect(callFn<RefreshPaymentMethodInput, unknown>(
      "refreshPaymentMethod", { profileId, setupIntentId: `seti_fake_bogus_${Date.now()}` }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = await getStripeDoc(profileId);
    expect(after?.defaultPaymentMethodId).toBe(before?.defaultPaymentMethodId);
    expect(after?.cardBrand).toBe(before?.cardBrand);
    expect(after?.cardLast4).toBe(before?.cardLast4);
  });

  it("a non-string setupIntentId is rejected with invalid-argument — RegExp.test would otherwise coerce it (review round 2, #3)", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("rpmsitype");
    await expect(callFn<{ profileId: string; setupIntentId: number }, unknown>(
      "refreshPaymentMethod", { profileId, setupIntentId: 123 }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

// ---------- Task 5: booking money gates ----------
// Mirrors bookings.test.ts's own gig/offer fixtures (this suite's subject is
// the money gates, not booking negotiation mechanics — a minimal single-gig
// perHour setup is enough to exercise applyToGig/offerGig/acceptBooking).
function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides,
  };
}

async function createOpenGig(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId, ...gigContent(overrides) }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

function offerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { amountCents: 15000, note: "Looking forward to it!", ...overrides };
}

describe("Task 5 money gates", () => {
  it("applyToGig without a payout-ready musician fails with failed-precondition and the exact message", async () => {
    const curator = await makeApprovedCuratorProfile("g5at1c");
    const musician = await makeApprovedMusicianProfile("g5at1m");
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);

    await expect(callFn(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: MUSICIAN_PAYOUTS_REQUIRED_MESSAGE });
  });

  it("offerGig without a curator card fails with failed-precondition and the exact message", async () => {
    const curator = await makeApprovedCuratorProfile("g5og1c");
    const musician = await makeApprovedMusicianProfile("g5og1m");
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);

    await expect(callFn(
      "offerGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: CURATOR_CARD_REQUIRED_MESSAGE });
  });

  it("acceptBooking with a card on file but a delinquent curator fails with failed-precondition and the exact message", async () => {
    const curator = await makeApprovedCuratorProfile("g5ab1c");
    const musician = await makeApprovedMusicianProfile("g5ab1m");
    await makeMoneyReady(curator, musician);
    await adb.doc(`profiles/${curator.profileId}/private/stripe`).set({ delinquent: true }, { merge: true });

    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await expect(callFn("acceptBooking", { bookingId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: CURATOR_DELINQUENT_MESSAGE });
  });

  it("a fully money-ready pair can accept — gates only, no deposit charge yet at this task", async () => {
    const curator = await makeApprovedCuratorProfile("g5ab2c");
    const musician = await makeApprovedMusicianProfile("g5ab2m");
    await makeMoneyReady(curator, musician);

    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await callFn("acceptBooking", { bookingId }, curator.owner.user);

    const booking = await adb.doc(`bookings/${bookingId}`).get();
    expect(booking.data()?.status).toBe("confirmed");
  });

  // Review round 1, item 3: the musician gate is RE-CHECKED at accept (not
  // just at applyToGig) — a musician who was payout-ready when they applied
  // but lost transfersEnabled before the curator accepted must still block
  // the accept. The curator is the caller here, so the specific message
  // (not the audience-remapped one below) is expected.
  it("acceptBooking re-checks musician payout-readiness — lost transfersEnabled after applying blocks a curator-side accept with the specific message", async () => {
    const curator = await makeApprovedCuratorProfile("g5ab5c");
    const musician = await makeApprovedMusicianProfile("g5ab5m");
    await makeMoneyReady(curator, musician);

    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    // applyToGig itself would have refused this — the only way to reach a
    // staged application against a now-not-payout-ready musician is for the
    // flag to flip AFTER applying (e.g. Stripe disabled the account).
    await adb.doc(`profiles/${musician.profileId}/private/stripe`).set({ transfersEnabled: false }, { merge: true });

    await expect(callFn("acceptBooking", { bookingId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: MUSICIAN_PAYOUTS_REQUIRED_MESSAGE });
  });

  // Review round 1, item 1: audience-aware curator-gate message. A
  // musician-side caller who trips the CURATOR gate (accepting a curator's
  // earlier offer, whose curator has since gone delinquent) must get the
  // neutral BOOKING_NOT_CONFIRMABLE_MESSAGE, never the curator-authored
  // CURATOR_DELINQUENT_MESSAGE — the musician can't act on curator-specific
  // copy. offerGig itself would have refused a delinquent curator, so the
  // curator must go delinquent AFTER making the offer.
  it("musician accepts a delinquent curator's earlier offer: gets the neutral BOOKING_NOT_CONFIRMABLE_MESSAGE, not the curator-authored text", async () => {
    const curator = await makeApprovedCuratorProfile("g5ab6c");
    const musician = await makeApprovedMusicianProfile("g5ab6m");
    await makeMoneyReady(curator, musician);

    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "offerGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, curator.owner.user);

    await adb.doc(`profiles/${curator.profileId}/private/stripe`).set({ delinquent: true }, { merge: true });

    await expect(callFn("acceptBooking", { bookingId }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: BOOKING_NOT_CONFIRMABLE_MESSAGE });
  });
});

// ---------- Task 6: accept saga (staged payment docs + batch deposit charge) ----------

// Mirrors bookings.test.ts's identical fixture — including its "never leave
// an active series behind in the shared emulator" contract (every caller
// below flips it to "ended" in a finally).
function seedSeries(curatorProfileId: string) {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode: "whole_run", status: "active",
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    template: {
      title: "Friday Night Jazz", description: "A cozy weekly set.",
      wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
      durationMinutes: 90,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: {
        venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
        geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: "123 Main St, Austin, TX",
      },
    },
    templatePrivateLocation: { address: "123 Main St, Austin, TX", geo: { lat: 30.27, lng: -97.74 } },
    materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
    activeBookingId: null, bookedMusicianProfileId: null,
  }).then(() => ref);
}

async function getBooking(bookingId: string): Promise<BookingRequestDoc> {
  return (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
}

async function getPaymentDocs(bookingId: string): Promise<PaymentDoc[]> {
  const snap = await adb.collection(`bookings/${bookingId}/payments`).get();
  return snap.docs.map((d) => d.data() as PaymentDoc);
}

// FakeStripe's created PaymentIntent object — the server-side amount actually
// charged, which no callable input can influence.
async function getFakeIntent(intentId: string): Promise<Record<string, unknown> | undefined> {
  return (await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data();
}

// Scoped charge knobs (as-built contract #6): ALWAYS list this test's OWN
// customerId rather than flipping the global declineCharges flag — the
// emulator's stripeFake/config doc is shared with every other suite running
// against it, and a global knob would decline their charges too.
async function setChargeKnob(
  knob: "declineCustomerIds" | "pendingCustomerIds", customerId: string, on: boolean,
): Promise<void> {
  await adb.doc("stripeFake/config").set(
    { [knob]: on ? FieldValue.arrayUnion(customerId) : FieldValue.arrayRemove(customerId) },
    { merge: true });
}

async function curatorCustomerId(profileId: string): Promise<string> {
  const sp = await getStripeDoc(profileId);
  if (!sp?.customerId) throw new Error(`no customerId cached for curator profile ${profileId}`);
  return sp.customerId;
}

describe("Task 6 accept saga", () => {
  it("single perHour gig ($150/hr x 90min): stages one payment doc, charges the batch once, marks it held", async () => {
    const curator = await makeApprovedCuratorProfile("t6hpc");
    const musician = await makeApprovedMusicianProfile("t6hpm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user, { durationMinutes: 90 });
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);

    await callFn("acceptBooking", { bookingId }, curator.owner.user);

    // 15000c/hr x 1.5h => base 22500; slice ceil(22500 * 35%) = 7875;
    // curator fee share ceil(7875 * 11%) = ceil(866.25) = 867.
    const snap = await adb.collection(`bookings/${bookingId}/payments`).get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].id).toBe(gigId);
    const p = snap.docs[0].data() as PaymentDoc;
    expect(p.bookingId).toBe(bookingId);
    expect(p.gigId).toBe(gigId);
    expect(p.curatorProfileId).toBe(curator.profileId);
    expect(p.musicianProfileId).toBe(musician.profileId);
    expect(p.selfDeal).toBe(false);
    expect(typeof p.occurrenceStartsAt).toBe("number");
    expect(p.baseCents).toBe(22500);
    expect(p.deposit.sliceCents).toBe(7875);
    expect(p.deposit.feeShareCents).toBe(867);
    expect(p.deposit.status).toBe("held");
    expect(p.deposit.intentId).toBeTruthy();
    expect(p.deposit.chargeId).toBeTruthy();   // later transfers pass it as sourceChargeId
    expect(typeof p.deposit.chargedAt).toBe("number");
    expect(p.deposit.resolvedAt).toBeNull();
    expect(p.deposit.forfeitTransferId).toBeNull();
    expect(p.settlement.status).toBe("not_due");
    expect(p.settlement.attempts).toBe(0);
    expect(p.settlement.delinquentAt).toBeNull();
    expect(p.transfer).toEqual({ status: "none", id: null, amountCents: null, transferredAt: null });

    const booking = await getBooking(bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.deposit?.status).toBe("held");
    expect(booking.deposit?.amountCents).toBe(7875);
    expect(booking.deposit?.policy.percent).toBe(DEPOSIT_PERCENT);
    expect(booking.feePolicy?.curatorFeePct).toBe(CURATOR_FEE_PCT);
    expect(booking.paymentSummary?.heldCents).toBe(7875);
    expect(booking.paymentSummary?.paidCents).toBe(8742);
    expect(booking.paymentSummary?.state).toBe("current");
    expect(booking.depositChargePending).toBe(false);
    expect(booking.depositChargeIntentId).toBeNull();
    expect(booking.depositChargeAttempt).toBe(1);

    // The server-computed amount: slice + fee share, never anything a client
    // could influence.
    const intent = await getFakeIntent(p.deposit.intentId!);
    expect(intent?.amountCents).toBe(8742);
    expect(intent?.meta).toEqual({ bookingId, purpose: "deposit" });

    const ledger = await adb.doc(`ledger/deposit_charged:${p.deposit.intentId}`).get();
    expect(ledger.exists).toBe(true);
    expect(ledger.data()?.amountCents).toBe(8742);
    expect(ledger.data()?.bookingId).toBe(bookingId);
    expect(ledger.data()?.profileId).toBe(curator.profileId);
  });

  it("whole-run: one payment doc per future occurrence, each priced from ITS OWN duration, and ONE intent for the sum", async () => {
    const curator = await makeApprovedCuratorProfile("t6wrc");
    const musician = await makeApprovedMusicianProfile("t6wrm");
    await makeMoneyReady(curator, musician);
    const series = await seedSeries(curator.profileId);
    try {
      // Deliberately three DIFFERENT durations — a whole-run deposit must be
      // priced per occurrence, never by multiplying the initiating gig's.
      const gig60 = await createOpenGig(curator.profileId, curator.owner.user, { durationMinutes: 60 });
      const gig90 = await createOpenGig(curator.profileId, curator.owner.user, { durationMinutes: 90 });
      const gig120 = await createOpenGig(curator.profileId, curator.owner.user, { durationMinutes: 120 });
      await Promise.all([gig60, gig90, gig120].map((id) => adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gig90, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
      expect((await getBooking(bookingId)).seriesId).toBe(series.id);

      await callFn("acceptBooking", { bookingId }, curator.owner.user);

      const snap = await adb.collection(`bookings/${bookingId}/payments`).get();
      expect(snap.size).toBe(3);
      const byGig = new Map(snap.docs.map((d) => [d.id, d.data() as PaymentDoc]));
      // 15000c/hr: 1h => 15000 (slice 5250, fee ceil(577.5) = 578);
      //            1.5h => 22500 (slice 7875, fee 867);
      //            2h => 30000 (slice 10500, fee 1155).
      expect(byGig.get(gig60)?.baseCents).toBe(15000);
      expect(byGig.get(gig60)?.deposit).toMatchObject({ sliceCents: 5250, feeShareCents: 578, status: "held" });
      expect(byGig.get(gig90)?.baseCents).toBe(22500);
      expect(byGig.get(gig90)?.deposit).toMatchObject({ sliceCents: 7875, feeShareCents: 867, status: "held" });
      expect(byGig.get(gig120)?.baseCents).toBe(30000);
      expect(byGig.get(gig120)?.deposit).toMatchObject({ sliceCents: 10500, feeShareCents: 1155, status: "held" });

      // ONE batch charge, shared by all three docs.
      const intentIds = new Set(snap.docs.map((d) => (d.data() as PaymentDoc).deposit.intentId));
      expect(intentIds.size).toBe(1);
      const intentId = [...intentIds][0]!;
      expect(await getFakeIntent(intentId).then((i) => i?.amountCents)).toBe(5828 + 8742 + 11655);

      const booking = await getBooking(bookingId);
      expect(booking.status).toBe("confirmed");
      expect(booking.paymentSummary?.heldCents).toBe(5250 + 7875 + 10500);
      // The run-level deposit still summarizes ONE occurrence (the initiating
      // gig's) — the per-occurrence docs above are the money truth.
      expect(booking.deposit?.amountCents).toBe(7875);
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });

  it("declined card: accept fails cleanly with nothing staged, and a retry afterwards succeeds on a fresh attempt key", async () => {
    const curator = await makeApprovedCuratorProfile("t6dcc");
    const musician = await makeApprovedMusicianProfile("t6dcm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
    const customerId = await curatorCustomerId(curator.profileId);

    await setChargeKnob("declineCustomerIds", customerId, true);
    try {
      await expect(callFn("acceptBooking", { bookingId }, curator.owner.user))
        .rejects.toMatchObject({ code: "functions/failed-precondition", message: CARD_DECLINED_MESSAGE });

      const declined = await getBooking(bookingId);
      expect(declined.status).toBe("open");
      expect(declined.acceptedTerms).toBeNull();
      expect(declined.depositChargePending).toBe(false);
      expect(declined.depositChargeAttempt).toBe(1);
      expect(await getPaymentDocs(bookingId)).toHaveLength(0);
      expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("open");
    } finally {
      await setChargeKnob("declineCustomerIds", customerId, false);
    }

    // The critical retry-after-decline: both real Stripe and the fake CACHE a
    // decline under its idempotency key, so this can only work because
    // transaction A bumped depositChargeAttempt (1 -> 2) and the charge key
    // moved with it.
    await callFn("acceptBooking", { bookingId }, curator.owner.user);

    const confirmed = await getBooking(bookingId);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.depositChargeAttempt).toBe(2);
    expect(confirmed.depositChargePending).toBe(false);
    const [p] = await getPaymentDocs(bookingId);
    expect(p.deposit.status).toBe("held");
    expect(p.deposit.intentId).toBeTruthy();
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("filled");
  });

  it("pending charge: accept reports processing and stays staged; payment_intent.succeeded finalizes it, and replays are no-ops", async () => {
    const curator = await makeApprovedCuratorProfile("t6pnc");
    const musician = await makeApprovedMusicianProfile("t6pnm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
    const customerId = await curatorCustomerId(curator.profileId);

    await setChargeKnob("pendingCustomerIds", customerId, true);
    try {
      await expect(callFn("acceptBooking", { bookingId }, curator.owner.user))
        .rejects.toMatchObject({ code: "functions/failed-precondition", message: DEPOSIT_PROCESSING_MESSAGE });
    } finally {
      await setChargeKnob("pendingCustomerIds", customerId, false);
    }

    // Unlike a decline, a pending intent leaves the saga STAGED — the money
    // may still land, so nothing is unwound and nothing may be re-charged.
    const pending = await getBooking(bookingId);
    expect(pending.status).toBe("open");
    expect(pending.depositChargePending).toBe(true);
    const intentId = pending.depositChargeIntentId!;
    expect(intentId).toBeTruthy();
    const [stagedDoc] = await getPaymentDocs(bookingId);
    expect(stagedDoc.deposit.status).toBe("unpaid");
    expect(stagedDoc.deposit.intentId).toBeNull();

    // A second accept while that intent is outstanding must NOT charge again
    // (the pending intent can still succeed — that would be a double charge).
    await expect(callFn("acceptBooking", { bookingId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: DEPOSIT_PROCESSING_MESSAGE });

    const evt = fakeEvent("payment_intent.succeeded", { id: intentId, metadata: { bookingId, purpose: "deposit" } });
    expect((await postWebhook(evt)).status).toBe(200);

    const confirmed = await getBooking(bookingId);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.depositChargePending).toBe(false);
    expect(confirmed.depositChargeIntentId).toBeNull();
    expect(confirmed.deposit?.status).toBe("held");
    expect(confirmed.paymentSummary?.heldCents).toBe(7875);
    const [heldDoc] = await getPaymentDocs(bookingId);
    expect(heldDoc.deposit.status).toBe("held");
    expect(heldDoc.deposit.intentId).toBe(intentId);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("filled");

    // Same event id: the webhook's claim machine dedupes it outright.
    expect((await postWebhook(evt)).text).toBe("duplicate");
    // A FRESH event id carrying the same intent still reaches the handler —
    // which must no-op, because the booking is no longer open-and-pending.
    const replay = fakeEvent("payment_intent.succeeded", { id: intentId, metadata: { bookingId, purpose: "deposit" } });
    expect((await postWebhook(replay)).status).toBe(200);
    const afterReplay = await getBooking(bookingId);
    expect(afterReplay.status).toBe("confirmed");
    expect(afterReplay.confirmedAt).toBe(confirmed.confirmedAt);
    expect((await getPaymentDocs(bookingId))[0].deposit.chargedAt).toBe(heldDoc.deposit.chargedAt);
  });

  it("perSong: baseCents is amount x songCount, regardless of the gig's duration", async () => {
    const curator = await makeApprovedCuratorProfile("t6psc");
    const musician = await makeApprovedMusicianProfile("t6psm");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user, {
      durationMinutes: 120, budget: { minCents: 5_000, maxCents: 20_000, structure: "perSong" },
    });
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig",
      { gigId, musicianProfileId: musician.profileId, offer: offerPayload({ amountCents: 800, expectedQuantity: 10 }) },
      musician.owner.user);

    await callFn("acceptBooking", { bookingId }, curator.owner.user);

    // 800c/song x 10 songs = 8000 (the 120-minute duration is irrelevant);
    // slice ceil(8000 * 35%) = 2800; fee ceil(2800 * 11%) = 308.
    const [p] = await getPaymentDocs(bookingId);
    expect(p.baseCents).toBe(8000);
    expect(p.deposit.sliceCents).toBe(2800);
    expect(p.deposit.feeShareCents).toBe(308);
    expect(p.deposit.status).toBe("held");
    expect(await getFakeIntent(p.deposit.intentId!).then((i) => i?.amountCents)).toBe(3108);
  });

  it("SP4's sibling supersede still fires after the saga: a rival open booking on the same gig is superseded", async () => {
    const curator = await makeApprovedCuratorProfile("t6ssc");
    const winner = await makeApprovedMusicianProfile("t6ssw");
    const rival = await makeApprovedMusicianProfile("t6ssr");
    await makeMoneyReady(curator, winner);
    await makeMoneyReady(curator, rival);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);

    const { bookingId: winnerBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: winner.profileId, offer: offerPayload() }, winner.owner.user);
    const { bookingId: rivalBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: rival.profileId, offer: offerPayload() }, rival.owner.user);

    await callFn("acceptBooking", { bookingId: winnerBookingId }, curator.owner.user);

    expect((await getBooking(winnerBookingId)).status).toBe("confirmed");
    expect((await getBooking(rivalBookingId)).status).toBe("superseded");
    // The loser is superseded, never charged — no payment docs of its own.
    expect(await getPaymentDocs(rivalBookingId)).toHaveLength(0);
  });
});

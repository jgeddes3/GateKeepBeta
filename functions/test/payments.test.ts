import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput, StripeProfileDoc } from "@gatekeep/shared";
import type { RefreshPaymentMethodInput } from "../src/payments.js";
import {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  BOOKING_NOT_CONFIRMABLE_MESSAGE,
} from "../src/paymentsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

// 20s, matching bookings.test.ts's precedent for booking-adjacent suites that
// chain several callables (createProfileDraft, submitProfileForReview,
// reviewProfile...) before reaching an assertion.
vi.setConfig({ testTimeout: 20_000 });

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

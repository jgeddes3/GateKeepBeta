import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput, StripeProfileDoc } from "@gatekeep/shared";
import type { RefreshPaymentMethodInput } from "../src/payments.js";

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
});

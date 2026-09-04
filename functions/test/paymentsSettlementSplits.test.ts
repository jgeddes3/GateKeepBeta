import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt,
} from "./helpers";
import { addMember, enableMemberAccount, memberStripe } from "./payoutFixtures";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  SETTLEMENT_DELAY_MS,
  type GigDoc, type LedgerEntry,
  type PaymentDoc, type ProfileDraftInput,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { chargeSettlement, clawbackSettledOccurrence } from "../src/paymentsSettlement.js";

// Task 6 (booking settlement through distributeEarnings). These fixtures are
// COPIES of paymentsSettlement.test.ts's own file-local helpers (controller
// ruling: that suite keeps every helper file-local, exporting from it would
// re-run its whole suite), trimmed to just what this file's one test needs:
// makeEndedBooking and what it calls (createOpenGig, offerPayload,
// setGigStartsAt), plus scheduleSettlement, getGig, getPayment, ledgerRows,
// fakeObject, and the derived money constants it relies on. addMember,
// enableMemberAccount and memberStripe come from payoutFixtures.ts instead,
// per the same ruling that governs the payout-splits test files.

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

vi.setConfig({ testTimeout: 60_000 });

const DAY_MS = 24 * 3_600_000;

// perHour, $150/hr over a 90-minute gig: the standard SP5 fixture (matches
// paymentsSettlement.test.ts's).
const RATE_CENTS = 15_000;
const DURATION_MINUTES = 90;

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

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
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: DURATION_MINUTES,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * DAY_MS,
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
  return { amountCents: RATE_CENTS, note: "Looking forward to it!", ...overrides };
}

async function getPayment(bookingId: string, gigId: string): Promise<PaymentDoc | undefined> {
  return (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc | undefined;
}

async function getGig(gigId: string): Promise<GigDoc> {
  return (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
}

async function fakeObject(id: string): Promise<Record<string, unknown> | undefined> {
  return (await adb.doc(`stripeFake/state/objects/${id}`).get()).data();
}

async function ledgerRows(bookingId: string): Promise<LedgerEntry[]> {
  const snap = await adb.collection("ledger").where("bookingId", "==", bookingId).get();
  return snap.docs.map((d) => d.data() as LedgerEntry);
}

// FakeStripe's running per-account balance (matches paymentsSettlement.test.ts's own helper).
async function accountBalanceCents(accountId: string): Promise<number> {
  return ((await fakeObject(accountId))?.balanceCents as number | undefined) ?? 0;
}

// FakeStripe's refusal knob (stripeFake/config.failTransferAccountIds), the
// same mechanism eventsSettlement.test.ts uses: transfers to this account are
// refused with a `balance_insufficient`-shaped error, and the error is
// deliberately not cached under its idempotency key, so the retry after the
// knob clears re-executes rather than replaying the refusal.
async function failTransfersTo(accountId: string, on: boolean): Promise<void> {
  await adb.doc("stripeFake/config").set(
    { failTransferAccountIds: on ? FieldValue.arrayUnion(accountId) : FieldValue.arrayRemove(accountId) },
    { merge: true });
}

async function musicianAccountId(profileId: string): Promise<string> {
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as { accountId?: string } | undefined;
  if (!sp?.accountId) throw new Error(`musicianAccountId: profile ${profileId} has no accountId after makeMoneyReady.`);
  return sp.accountId;
}

// A real, fully confirmed single-gig booking whose date has already ENDED.
async function makeEndedBooking(
  prefix: string,
  opts: { pastStartHours?: number; gig?: Record<string, unknown>; offer?: Record<string, unknown> } = {},
) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user, opts.gig ?? {});
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId, musicianProfileId: musician.profileId, offer: opts.offer ?? offerPayload() },
    musician.owner.user);
  await setGigStartsAt(gigId, -(opts.pastStartHours ?? 5));
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

// Schedules the settlement (sweep step 4) and asserts the T+3 window it opens.
async function scheduleSettlement(bookingId: string, gigId: string): Promise<void> {
  const gig = await getGig(gigId);
  const gigEnd = gig.startsAt + gig.durationMinutes * 60_000;
  if ((await getPayment(bookingId, gigId))?.settlement.status === "not_due") {
    await runPaymentsSweep(Date.now());
  }
  const scheduled = await getPayment(bookingId, gigId);
  expect(scheduled?.settlement.status).toBe("pending");
  expect(scheduled?.settlement.settleAfter).toBe(gigEnd + SETTLEMENT_DELAY_MS);
  expect(scheduled?.settlement.attempts).toBe(0);
  expect(scheduled?.deposit.status).toBe("held");
}

describe("booking settlement with shares", () => {
  it("splits a sourced settlement into per-member transfers, records legs, and holds an unonboarded member", async () => {
    const b = await makeEndedBooking("spl1");
    const bass = await addMember(b.musician.profileId, "spl1b");
    const drums = await addMember(b.musician.profileId, "spl1d");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    expect(await enableMemberAccount(bass.uid)).toBe(200);
    expect((await memberStripe(bass.uid))?.transfersEnabled).toBe(true);
    await callFn("setPayoutShares", { profileId: b.musician.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 45 },
      { payee: { kind: "member", uid: drums.uid }, percent: 45 },
      { payee: { kind: "profile" }, percent: 10 },
    ] }, b.musician.owner.user);
    await scheduleSettlement(b.bookingId, b.gigId);
    expect(await chargeSettlement({ bookingId: b.bookingId, gigId: b.gigId, now: Date.now() })).toEqual({ outcome: "charged", transferred: true });
    const paid = (await getPayment(b.bookingId, b.gigId))!;
    expect(paid.transfer.status).toBe("transferred");
    expect(paid.transfer.legs).toBe(3);
    expect(paid.transfer.heldCents).toBeGreaterThan(0);
    const rows = await ledgerRows(b.bookingId);
    const legs = rows.filter((r) => r.kind === "share_transfer");
    expect(legs).toHaveLength(2);
    expect(legs.every((r) => r.sourced === true)).toBe(true);
    expect(rows.find((r) => r.kind === "share_held")?.uid).toBe(drums.uid);
    expect(rows.find((r) => r.kind === "earnings_transfer")?.sourced).toBe(true);
    const bassRow = legs.find((r) => r.uid === bass.uid)!;
    // FIX WAVE M3(d): assert the intent id is really there before comparing
    // through it. The old `paid.settlement.intentId ? ... : undefined` ternary
    // made a MISSING intent compare `undefined` to `undefined` and pass, which
    // is exactly the regression (a settlement with no recorded intent) this
    // line is supposed to catch.
    expect(typeof paid.settlement.intentId).toBe("string");
    expect(await fakeObject(bassRow.stripeId!).then((t) => t?.sourceChargeId))
      .toBe((await fakeObject(paid.settlement.intentId!))?.chargeId);
    const total = legs.reduce((s, r) => s + r.amountCents, 0) + (rows.find((r) => r.kind === "share_held")?.amountCents ?? 0);
    expect(total).toBe(paid.transfer.amountCents);
  });

  // Fix round 1 (Critical): a no-show clawback on a split settlement must
  // reverse ONLY the profile's own share, never a member's transferred share
  // (spec section 8: a member's transferred share stays theirs, the existing
  // paths recover the curator's money from the profile's own account).
  it("clawing back a split settlement reverses only the profile's own share, leaving member shares untouched", async () => {
    const b = await makeEndedBooking("spl2");
    const bass = await addMember(b.musician.profileId, "spl2b");
    const drums = await addMember(b.musician.profileId, "spl2d");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    expect(await enableMemberAccount(bass.uid)).toBe(200);
    await callFn("setPayoutShares", { profileId: b.musician.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 45 },
      { payee: { kind: "member", uid: drums.uid }, percent: 45 },
      { payee: { kind: "profile" }, percent: 10 },
    ] }, b.musician.owner.user);
    await scheduleSettlement(b.bookingId, b.gigId);
    expect(await chargeSettlement({ bookingId: b.bookingId, gigId: b.gigId, now: Date.now() })).toEqual({ outcome: "charged", transferred: true });

    const rows = await ledgerRows(b.bookingId);
    const profileLeg = rows.find((r) => r.kind === "share_transfer" && r.uid == null)!;
    const bassLeg = rows.find((r) => r.kind === "share_transfer" && r.uid === bass.uid)!;
    const profileAccountId = await musicianAccountId(b.musician.profileId);
    const bassAccountId = (await memberStripe(bass.uid))!.accountId!;
    const profileBalanceBefore = await accountBalanceCents(profileAccountId);
    const bassBalanceBefore = await accountBalanceCents(bassAccountId);
    expect(bassBalanceBefore).toBe(bassLeg.amountCents);

    await clawbackSettledOccurrence(b.bookingId, b.gigId, Date.now());

    const clawed = (await getPayment(b.bookingId, b.gigId))!;
    expect(clawed.settlement.status).toBe("waived");
    expect(clawed.transfer.status).toBe("reversed");
    expect(clawed.deposit.status).toBe("refunded");
    // Only the profile's own account moved.
    expect(await accountBalanceCents(profileAccountId)).toBe(profileBalanceBefore - profileLeg.amountCents);
    expect(await accountBalanceCents(bassAccountId)).toBe(bassBalanceBefore);
    const reversalRow = (await ledgerRows(b.bookingId)).find((r) => r.kind === "transfer_reversal")!;
    expect(reversalRow.amountCents).toBe(profileLeg.amountCents);

    // FIX WAVE I4: the drummer's share was HELD against money the curator has
    // just been refunded. Left `held` it would transfer out of the platform's
    // own balance the moment they onboarded, for a date nobody paid for.
    const drumsHeld = await adb.collection("heldShares").where("uid", "==", drums.uid).get();
    expect(drumsHeld.size).toBe(1);
    expect(drumsHeld.docs[0].data().status).toBe("voided");
    expect(typeof drumsHeld.docs[0].data().voidedAt).toBe("number");
    const voidedRow = (await ledgerRows(b.bookingId)).find((r) => r.kind === "share_voided");
    expect(voidedRow?.uid).toBe(drums.uid);
    expect(voidedRow?.amountCents).toBe(drumsHeld.docs[0].data().amountCents);
  });

  // FIX WAVE M3(a): CRASH RESUME across a split settlement. The member leg
  // transfers, the profile leg is refused, and the attempt is re-run once the
  // refusal clears. The frozen plan (fix wave I2) plus the per-leg idempotency
  // keys are what make the re-run finish the settlement instead of paying the
  // member a second time.
  it("resumes a settlement whose profile leg was refused after a member leg had already transferred", async () => {
    const b = await makeEndedBooking("spl3");
    const bass = await addMember(b.musician.profileId, "spl3b");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    expect(await enableMemberAccount(bass.uid)).toBe(200);
    // The member leg is FIRST in the shares list, so it transfers before the
    // profile leg splitCents places last, which is what makes the refusal a
    // partial distribution rather than a clean first-leg failure.
    await callFn("setPayoutShares", { profileId: b.musician.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 60 },
      { payee: { kind: "profile" }, percent: 40 },
    ] }, b.musician.owner.user);
    await scheduleSettlement(b.bookingId, b.gigId);

    const profileAccountId = await musicianAccountId(b.musician.profileId);
    const bassAccountId = (await memberStripe(bass.uid))!.accountId!;
    await failTransfersTo(profileAccountId, true);
    await expect(chargeSettlement({ bookingId: b.bookingId, gigId: b.gigId, now: Date.now() })).rejects.toThrow();
    // The member has been paid; the profile has not, and the settlement is not
    // terminal, so nothing downstream can treat this date as done.
    const bassAfterFailure = await accountBalanceCents(bassAccountId);
    expect(bassAfterFailure).toBeGreaterThan(0);
    expect(await accountBalanceCents(profileAccountId)).toBe(0);
    expect((await getPayment(b.bookingId, b.gigId))?.settlement.status).not.toBe("paid");

    await failTransfersTo(profileAccountId, false);
    expect(await chargeSettlement({ bookingId: b.bookingId, gigId: b.gigId, now: Date.now() }))
      .toEqual({ outcome: "charged", transferred: true });

    const paid = (await getPayment(b.bookingId, b.gigId))!;
    expect(paid.settlement.status).toBe("paid");
    expect(paid.transfer.legs).toBe(2);
    const rows = await ledgerRows(b.bookingId);
    const bassLeg = rows.find((r) => r.kind === "share_transfer" && r.uid === bass.uid)!;
    const profileLeg = rows.find((r) => r.kind === "share_transfer" && r.uid == null)!;
    // ONCE each: the member's balance is unchanged by the resume, and the
    // profile received exactly its own leg.
    expect(await accountBalanceCents(bassAccountId)).toBe(bassAfterFailure);
    expect(bassAfterFailure).toBe(bassLeg.amountCents);
    expect(await accountBalanceCents(profileAccountId)).toBe(profileLeg.amountCents);
    expect(bassLeg.amountCents + profileLeg.amountCents).toBe(paid.transfer.amountCents);
    // One share_transfer row per leg, not one per attempt.
    expect(rows.filter((r) => r.kind === "share_transfer")).toHaveLength(2);
  });
});

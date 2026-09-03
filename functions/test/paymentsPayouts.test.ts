import { describe, it, expect, vi } from "vitest";
import type { User } from "firebase/auth";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
import {
  INSTANT_FEE_MIN_CENTS, INSTANT_FEE_PCT, INSTANT_PAYOUT_MIN_CENTS, SELF_DEAL_HOLD_MS,
  type LedgerEntry, type NotificationDoc, type PaymentDoc, type ProfileDraftInput, type StripeProfileDoc,
} from "@gatekeep/shared";
import {
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE,
  PAYOUT_INSTANT_MIN_MESSAGE, PAYOUT_INSTANT_HELD_MESSAGE,
  PAYOUT_OVER_BALANCE_MESSAGE, PAYOUT_REQUEST_ID_REUSED_MESSAGE, PAYOUT_SETUP_REQUIRED_MESSAGE,
  type RequestPayoutInput, type RequestPayoutResult,
} from "../src/paymentsPayouts.js";
import { payoutFeeAlertId, recordAdminAlert, resolveDepositPending } from "../src/paymentsCore.js";
// The fake's own balance API, used to SEED and to READ balances below, see
// seedBalance's note on why this suite touches it directly.
import { getStripe } from "../src/stripeClient.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

vi.setConfig({ testTimeout: 30_000 });

// A DRAFT musician profile is enough for every callable in this file:
// getStripeStatus gates on profile MEMBERSHIP and requestPayout on profile
// ADMIN (owner ruling H2), createProfileDraft grants the creator BOTH
// immediately (the owner's member doc is role:"admin"), never on review status.
// Skipping the approval chain keeps this suite's fixtures to three calls.
async function makeMusicianProfile(prefix: string) {
  const owner = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    {
      // Base-36 clock + a random tail: unique per run, and short enough that
      // even this file's longest prefix stays inside the 30-character handle
      // limit (a full `Date.now()` decimal blew it).
      type: "musician", subtype: "solo", name: "The Act",
      handle: `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    },
    owner.user);
  return { owner, profileId };
}

// Creates the Express account (via the real callable) and then force-enables
// the payout flags on BOTH the fake's account object and the cached
// private/stripe doc, the same shortcut makeMoneyReady takes, for the same
// reason: onboarding completion is normally driven by the account.updated
// webhook, which nothing in these fixtures triggers. `instantEligible` is a
// parameter because two tests need a payout-ready account that is NOT
// instant-eligible.
async function makePayoutReady(prefix: string, instantEligible = true) {
  const { owner, profileId } = await makeMusicianProfile(prefix);
  await callFn("createOnboardingLink", { profileId }, owner.user);
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc;
  if (!sp?.accountId) throw new Error(`makePayoutReady: ${profileId} has no accountId after createOnboardingLink.`);
  const flags = { transfersEnabled: true, payoutsEnabled: true, instantEligible };
  await adb.doc(`stripeFake/state/objects/${sp.accountId}`).set(flags, { merge: true });
  await adb.doc(`profiles/${profileId}/private/stripe`).set(flags, { merge: true });
  return { owner, profileId, accountId: sp.accountId };
}

// SHORTCUT, deliberately: money reaches a musician's Stripe balance through a
// settled booking's earnings transfer (Task 10) or a forfeited deposit (Task
// 8), and both of those chains are covered at length in
// paymentsSettlement.test.ts / payments.test.ts. This suite's subject is what
// happens AFTER a balance exists, so it calls the fake's transfer directly,
// the very call those paths end in, so the balance it produces is the same
// balance in the same place.
async function seedBalance(accountId: string, amountCents: number): Promise<void> {
  await getStripe().transferToAccount({
    accountId, amountCents,
    idempotencyKey: `test-seed:${accountId}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`,
    meta: { purpose: "test_seed" },
  });
}

const balanceOf = async (accountId: string) => (await getStripe().getBalances(accountId)).availableCents;

// Re-derived from the constants rather than hard-coded, so a rate change moves
// the expectation with the product instead of failing the suite.
//
// ONE HARD-CODED FIGURE SURVIVES ON PURPOSE, the `expect(feeCents).toBe(200)`
// in the 4%-of-$50 test below. That one is a RATE ANCHOR, not a duplicate of
// this helper: without it, a change to INSTANT_FEE_PCT would silently flow
// through both the code and every expectation here and the suite would still
// pass while the product's headline price had moved. It is meant to fail, and
// to be updated deliberately, when the rate changes.
const expectedInstantFee = (amountCents: number) =>
  Math.max(INSTANT_FEE_MIN_CENTS, Math.ceil(amountCents * INSTANT_FEE_PCT / 100));

const freshRequestId = () => `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function ledgerRowsFor(profileId: string): Promise<LedgerEntry[]> {
  const snap = await adb.collection("ledger").where("profileId", "==", profileId).get();
  return snap.docs.map((d) => d.data() as LedgerEntry);
}

async function notificationsFor(uid: string): Promise<NotificationDoc[]> {
  const snap = await adb.collection(`users/${uid}/notifications`).get();
  return snap.docs.map((d) => d.data() as NotificationDoc);
}

function payout(data: RequestPayoutInput, asUser: User) {
  return callFn<RequestPayoutInput, RequestPayoutResult>("requestPayout", data, asUser);
}

function fakeEvent(type: string, object: Record<string, unknown>) {
  return { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`, type, data: { object } };
}

async function postWebhook(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "fake" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe("requestPayout, standard", () => {
  it("pays out the full amount, decrements the balance, and writes a payout_standard ledger row", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("postd");
    await seedBalance(accountId, 10_000);

    const result = await payout(
      { profileId, amountCents: 4_000, method: "standard", requestId: freshRequestId() }, owner.user);
    expect(result.feeCents).toBe(0);
    expect(result.netCents).toBe(4_000);
    expect(result.replayed).toBe(false);
    expect(result.payoutId).toMatch(/^po_/);

    expect(await balanceOf(accountId)).toBe(6_000);
    const row = await adb.doc(`ledger/payout_standard:${result.payoutId}`).get();
    expect(row.exists).toBe(true);
    expect(row.data()?.amountCents).toBe(4_000);
    expect(row.data()?.profileId).toBe(profileId);
    // Payouts are not booking-scoped, both ids are null by design.
    expect(row.data()?.bookingId).toBeNull();
    expect(row.data()?.gigId).toBeNull();
  });

  it("replays a repeated requestId: same payoutId, replayed:true, and no second movement of money", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("porpl");
    await seedBalance(accountId, 10_000);
    const requestId = freshRequestId();

    const first = await payout({ profileId, amountCents: 4_000, method: "standard", requestId }, owner.user);
    expect(first.replayed).toBe(false);
    const balanceAfterFirst = await balanceOf(accountId);

    const second = await payout({ profileId, amountCents: 4_000, method: "standard", requestId }, owner.user);
    expect(second.payoutId).toBe(first.payoutId);
    expect(second.replayed).toBe(true);
    expect(second.netCents).toBe(first.netCents);
    // The whole point: the second call moved nothing.
    expect(await balanceOf(accountId)).toBe(balanceAfterFirst);
    const payoutRows = (await ledgerRowsFor(profileId)).filter((r) => r.kind === "payout_standard");
    expect(payoutRows).toHaveLength(1);
  });

  it("replays even when the first payout drained the balance, the memo answers before the balance check", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("porpld");
    await seedBalance(accountId, 5_000);
    const requestId = freshRequestId();

    const first = await payout({ profileId, amountCents: 5_000, method: "standard", requestId }, owner.user);
    expect(await balanceOf(accountId)).toBe(0);

    // Without the `lastPayout` memo this is the case that would refuse with
    // "more than your available balance" and never hand back the payout id,
    // and cashing out the FULL balance is the web's default.
    const second = await payout({ profileId, amountCents: 5_000, method: "standard", requestId }, owner.user);
    expect(second.payoutId).toBe(first.payoutId);
    expect(second.replayed).toBe(true);

    const memo = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc;
    expect(memo.lastPayout?.requestId).toBe(requestId);
    expect(memo.lastPayout?.payoutId).toBe(first.payoutId);
  });

  it("LAYER 2, with the memo gone, Stripe's own key still replays the payout instead of making a second one", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("porpl2");
    await seedBalance(accountId, 10_000);
    const requestId = freshRequestId();

    const first = await payout({ profileId, amountCents: 4_000, method: "standard", requestId }, owner.user);
    const balanceAfterFirst = await balanceOf(accountId);

    // Simulates the one window the memo cannot cover: a crash (or a logged
    // memo-write failure) between the payout and the memo write. Everything
    // downstream must then rest on the idempotency key alone.
    await adb.doc(`profiles/${profileId}/private/stripe`).update({ lastPayout: FieldValue.delete() });

    const second = await payout({ profileId, amountCents: 4_000, method: "standard", requestId }, owner.user);
    // Same Stripe object, no second movement, no second ledger row. This
    // assertion PINS THE KEY SCHEMA: `{profileId}:payout:{requestId}` must stay
    // derivable from the request alone, folding a nonce, a timestamp or an
    // attempt counter into it would make this call mint a second payout.
    expect(second.payoutId).toBe(first.payoutId);
    expect(await balanceOf(accountId)).toBe(balanceAfterFirst);
    expect((await ledgerRowsFor(profileId)).filter((r) => r.kind === "payout_standard")).toHaveLength(1);
    // Honest about what it knows: the callable cannot tell a replayed Stripe
    // object from a fresh one, so this path reports `replayed: false` even
    // though nothing moved (see RequestPayoutResult.replayed).
    expect(second.replayed).toBe(false);
  });
});

describe("requestPayout, instant", () => {
  it("nets the 4% fee (min $1) out of the amount, debits the fee, and takes the FULL amount off the balance", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("poinst");
    await seedBalance(accountId, 10_000);
    const amountCents = 5_000;
    const feeCents = expectedInstantFee(amountCents);
    // THE RATE ANCHOR (see expectedInstantFee's note): 4% of $50, above the $1
    // floor. Deliberately hard-coded so a change to INSTANT_FEE_PCT has to be
    // acknowledged here rather than sliding through every derived expectation.
    expect(feeCents).toBe(200);

    const result = await payout(
      { profileId, amountCents, method: "instant", requestId: freshRequestId() }, owner.user);
    expect(result.feeCents).toBe(feeCents);
    expect(result.netCents).toBe(amountCents - feeCents);

    // Gross, not net: the payout takes net and the account debit takes the fee.
    expect(await balanceOf(accountId)).toBe(10_000 - amountCents);

    const payoutRow = await adb.doc(`ledger/payout_instant:${result.payoutId}`).get();
    expect(payoutRow.exists).toBe(true);
    expect(payoutRow.data()?.amountCents).toBe(amountCents - feeCents);
    const debitRow = (await ledgerRowsFor(profileId)).find((r) => r.kind === "account_debit");
    expect(debitRow?.amountCents).toBe(feeCents);
    // The fee landed, so nothing was escalated.
    expect((await adb.collection("adminAlerts").where("kind", "==", "payout_fee_uncollected").get()).empty)
      .toBe(true);
  });

  it("applies the $1 floor below $25 (a small cash-out costs the minimum, not 4%)", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("poinstmin");
    await seedBalance(accountId, 10_000);
    const amountCents = 1_000;
    expect(expectedInstantFee(amountCents)).toBe(INSTANT_FEE_MIN_CENTS); // 4% of $10 = 40c, floored to $1

    const result = await payout(
      { profileId, amountCents, method: "instant", requestId: freshRequestId() }, owner.user);
    expect(result.feeCents).toBe(INSTANT_FEE_MIN_CENTS);
    expect(result.netCents).toBe(amountCents - INSTANT_FEE_MIN_CENTS);
    expect(await balanceOf(accountId)).toBe(9_000);
  });

  it("refuses a sub-$10 instant amount with the $10 minimum (M4), which now subsumes the old fee-would-swallow-it belt", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("pofeeeq");
    await seedBalance(accountId, 10_000);
    // $1.00: below the $10 instant minimum, which fires BEFORE, and now
    // subsumes, the fee-swallow-whole belt (that belt only ever bit at/below
    // ~$1, itself well under $10, so it is kept in the callable purely as
    // defense-in-depth against a future rate/minimum change). Balance untouched.
    await expect(payout({ profileId, amountCents: 100, method: "instant", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: PAYOUT_INSTANT_MIN_MESSAGE });
    expect(await balanceOf(accountId)).toBe(10_000);
  });

  it("refuses instant for an account without an eligible debit card, while standard still works", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("poinelig", false);
    await seedBalance(accountId, 10_000);

    await expect(payout({ profileId, amountCents: 2_000, method: "instant", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAYOUT_INSTANT_INELIGIBLE_MESSAGE,
      });
    expect(await balanceOf(accountId)).toBe(10_000);

    const ok = await payout(
      { profileId, amountCents: 2_000, method: "standard", requestId: freshRequestId() }, owner.user);
    expect(ok.feeCents).toBe(0);
    expect(await balanceOf(accountId)).toBe(8_000);
  });
});

describe("requestPayout, refusals", () => {
  it("over the available balance fails with failed-precondition and moves nothing", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("poover");
    await seedBalance(accountId, 1_000);
    await expect(payout({ profileId, amountCents: 2_000, method: "standard", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: PAYOUT_OVER_BALANCE_MESSAGE });
    expect(await balanceOf(accountId)).toBe(1_000);
  });

  it("a non-member is rejected with permission-denied", async () => {
    const { profileId, accountId } = await makePayoutReady("poowner");
    await seedBalance(accountId, 10_000);
    const stranger = await signUpTestUser(`po-stranger-${Date.now()}@test.com`);
    await expect(payout({ profileId, amountCents: 1_000, method: "standard", requestId: freshRequestId() }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    expect(await balanceOf(accountId)).toBe(10_000);
  });

  it("below the $1 minimum is invalid-argument", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("pomin");
    await seedBalance(accountId, 10_000);
    await expect(payout({ profileId, amountCents: 50, method: "standard", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    expect(await balanceOf(accountId)).toBe(10_000);
  });

  it("a malformed requestId is invalid-argument (too short, and a non-string RegExp.test would coerce)", async () => {
    const { owner, profileId } = await makePayoutReady("poreqid");
    await expect(payout({ profileId, amountCents: 1_000, method: "standard", requestId: "short" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn<{ profileId: string; amountCents: number; method: string; requestId: number }, unknown>(
      "requestPayout", { profileId, amountCents: 1_000, method: "standard", requestId: 12345678 }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("reusing a requestId for a DIFFERENT cash-out is refused, not replayed", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("poreuse");
    await seedBalance(accountId, 10_000);
    const requestId = freshRequestId();
    await payout({ profileId, amountCents: 2_000, method: "standard", requestId }, owner.user);

    // Same id, different amount, and the same id, different method. Either
    // would otherwise come back as "already sent" for a payout that isn't the
    // one being asked for.
    await expect(payout({ profileId, amountCents: 3_000, method: "standard", requestId }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: PAYOUT_REQUEST_ID_REUSED_MESSAGE });
    await expect(payout({ profileId, amountCents: 2_000, method: "instant", requestId }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: PAYOUT_REQUEST_ID_REUSED_MESSAGE });
    expect(await balanceOf(accountId)).toBe(8_000);
  });

  it("a profile that hasn't finished payout setup is refused", async () => {
    const { owner, profileId } = await makeMusicianProfile("posetup");
    await expect(payout({ profileId, amountCents: 1_000, method: "standard", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: PAYOUT_SETUP_REQUIRED_MESSAGE,
      });
  });

  it("an unknown method is invalid-argument", async () => {
    const { owner, profileId } = await makePayoutReady("pomethod");
    await expect(callFn<{ profileId: string; amountCents: number; method: string; requestId: string }, unknown>(
      "requestPayout", { profileId, amountCents: 1_000, method: "express", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("payout webhooks", () => {
  it("payout.failed writes a payout_failed ledger row and tells the profile's members", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("pofail");
    await seedBalance(accountId, 10_000);
    const result = await payout(
      { profileId, amountCents: 3_000, method: "standard", requestId: freshRequestId() }, owner.user);

    // M1 (branch audit): a payout is a connected-account event, so it carries a
    // top-level `account`, the handler pins it to the profile's cached account.
    const res = await postWebhook({ ...fakeEvent("payout.failed", {
      id: result.payoutId, amount: 3_000, currency: "usd", status: "failed",
      failure_code: "account_closed", failure_message: "The bank account has been closed.",
      metadata: { profileId, purpose: "payout" },
    }), account: accountId });
    expect(res.status).toBe(200);

    const row = await adb.doc(`ledger/payout_failed:${result.payoutId}`).get();
    expect(row.exists).toBe(true);
    expect(row.data()?.amountCents).toBe(3_000);
    expect(row.data()?.profileId).toBe(profileId);
    expect(row.data()?.detail).toContain("account_closed");
    // The request-time row is untouched, the two are different kinds keyed off
    // the same payout, which is exactly what writeLedger's id scheme allows.
    expect((await adb.doc(`ledger/payout_standard:${result.payoutId}`).get()).exists).toBe(true);

    expect((await notificationsFor(owner.uid)).some((n) => n.title === "Payout failed")).toBe(true);
  });

  it("payout.paid writes NO ledger row, the request-time row already recorded it", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("popaid");
    await seedBalance(accountId, 10_000);
    const result = await payout(
      { profileId, amountCents: 3_000, method: "standard", requestId: freshRequestId() }, owner.user);
    const before = (await ledgerRowsFor(profileId)).length;

    const res = await postWebhook({ ...fakeEvent("payout.paid", {
      id: result.payoutId, amount: 3_000, currency: "usd", status: "paid",
      metadata: { profileId, purpose: "payout" },
    }), account: accountId });
    expect(res.status).toBe(200);
    expect((await ledgerRowsFor(profileId)).length).toBe(before);
    expect((await notificationsFor(owner.uid)).some((n) => n.title === "Payout failed")).toBe(false);
  });

  it("payout.failed with unusable metadata still records the money, and notifies nobody", async () => {
    const payoutId = `po_orphan_${Date.now()}`;
    const res = await postWebhook(fakeEvent("payout.failed", {
      id: payoutId, amount: 500, currency: "usd", status: "failed",
      // A doc-id-shaped path segment is never accepted from event metadata.
      metadata: { profileId: "not/a/valid/id" },
    }));
    expect(res.status).toBe(200);
    const row = await adb.doc(`ledger/payout_failed:${payoutId}`).get();
    expect(row.exists).toBe(true);
    expect(row.data()?.profileId).toBeNull();
  });
});

describe("getStripeStatus, balances", () => {
  interface Status {
    payoutsEnabled: boolean; instantEligible: boolean;
    availableBalanceCents: number | null; instantAvailableBalanceCents: number | null;
  }
  const status = (profileId: string, asUser: User) =>
    callFn<{ profileId: string }, Status>("getStripeStatus", { profileId }, asUser);

  it("reports both buckets for a payout-ready account", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("postat");
    await seedBalance(accountId, 12_345);
    const s = await status(profileId, owner.user);
    expect(s.payoutsEnabled).toBe(true);
    expect(s.availableBalanceCents).toBe(12_345);
    // FakeStripe has no settlement delay to model, so the instant bucket
    // coincides with the available one (see FakeStripe.getBalances).
    expect(s.instantAvailableBalanceCents).toBe(12_345);
  });

  it("reports 0/0, not null, for a profile with no Stripe account at all", async () => {
    const { owner, profileId } = await makeMusicianProfile("postatnone");
    const s = await status(profileId, owner.user);
    expect(s.payoutsEnabled).toBe(false);
    expect(s.availableBalanceCents).toBe(0);
    expect(s.instantAvailableBalanceCents).toBe(0);
  });

  it("a DELETED Connect account zeroes the gate flags and reports 0/0 instead of 500ing", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("postatgone");
    await seedBalance(accountId, 5_000);
    await adb.doc(`stripeFake/state/objects/${accountId}`).delete();

    const s = await status(profileId, owner.user);
    expect(s.payoutsEnabled).toBe(false);
    expect(s.instantEligible).toBe(false);
    // Truthful: a deleted account has no balance, which is a different answer
    // from "we couldn't ask" (the null case below).
    expect(s.availableBalanceCents).toBe(0);
  });

  it("a balance read that THROWS degrades to nulls, leaving the rest of the status intact", async () => {
    const { owner, profileId } = await makePayoutReady("postatdegr");
    // The narrowest way to make FakeStripe's balance calls throw: an accountId
    // that isn't a legal Firestore doc-id segment, so every objRef() built from
    // it rejects. That stands in for the real-world case this branch exists for
    //, a Stripe outage or network blip mid-read, which the fake, whose reads
    // otherwise cannot fail, has no other way to produce.
    await adb.doc(`profiles/${profileId}/private/stripe`).set(
      { accountId: "acct_unreadable/segment", payoutsEnabled: true }, { merge: true });

    const s = await status(profileId, owner.user);
    // Not a 500, and the cached flags still render.
    expect(s.payoutsEnabled).toBe(true);
    expect(s.availableBalanceCents).toBeNull();
    expect(s.instantAvailableBalanceCents).toBeNull();
  });
});

describe("the uncollected-fee escalation", () => {
  it("payoutFeeAlertId is request-scoped, so two uncollected fees are two tickets", () => {
    expect(payoutFeeAlertId("prof1", "req-a")).toBe("payout-fee:prof1:req-a");
    expect(payoutFeeAlertId("prof1", "req-a")).not.toBe(payoutFeeAlertId("prof1", "req-b"));
  });

  // The raiser itself is unreachable in the emulator, FakeStripe's account
  // debit cannot fail, so the ROW SHAPE is covered directly. It is the one
  // alert in SP5 with no booking behind it, which is why AdminAlertDoc's
  // bookingId is nullable at all.
  it("records a profile-scoped row with null booking/gig ids", async () => {
    const alertId = payoutFeeAlertId("profshape", `req-${Date.now()}`);
    await recordAdminAlert({
      alertId, kind: "payout_fee_uncollected",
      detail: "instant payout fee could not be debited",
      bookingId: null, gigId: null, now: Date.now(),
    });
    const doc = await adb.doc(`adminAlerts/${alertId}`).get();
    expect(doc.data()?.kind).toBe("payout_fee_uncollected");
    expect(doc.data()?.bookingId).toBeNull();
    expect(doc.data()?.gigId).toBeNull();
    expect(doc.data()?.resolvedAt).toBeNull();
  });
});

// Seeds one `forfeit_pending` deposit payment doc and runs the REAL executor
// (resolveDepositPending, the exact call the cancel/no-show paths end in) so a
// self-deal forfeit's hold is set by production code, not by the test. `selfDeal`
// is the only thing that changes between the two M3 cases.
async function forfeitDepositTo(musicianProfileId: string, selfDeal: boolean): Promise<{ bookingId: string; gigId: string }> {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const bookingId = `bk_m3_${unique}`;
  const gigId = "g1";
  // Unique per call (as-built contract #6 style, review round 2): FakeStripe's
  // Task 3 cap tracks draws CUMULATIVELY per charge, so two calls sharing one
  // literal charge id would see the second forfeit's slice stacked on the
  // first's and refused as balance_insufficient.
  const intentId = `pi_sd_${unique}`;
  const chargeId = `ch_sd_${unique}`;
  const now = Date.now();
  const doc: PaymentDoc = {
    bookingId, gigId, occurrenceStartsAt: now,
    curatorProfileId: "cur_selfdeal", musicianProfileId, selfDeal,
    baseCents: 10_000,
    deposit: {
      sliceCents: 3_500, feeShareCents: 385, intentId, chargeId,
      status: "forfeit_pending", chargedAt: now, resolvedAt: null, forfeitTransferId: null,
    },
    settlement: {
      status: "waived", settleAfter: null, computedCents: null, feeShareCents: null,
      trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
      lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
    },
    transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
    createdAt: now, updatedAt: now,
  };
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).set(doc);
  // SP10 Task 3: FakeStripe now validates a sourced transfer against a REAL
  // charge (it resolves sourceChargeId through the charge's own payment_intent
  // object), so the deposit's stub chargeId needs a backing object, the exact
  // shape chargeOffSession itself would have written.
  await adb.doc(`stripeFake/state/objects/${intentId}`).set({
    kind: "payment_intent", amountCents: 3_885, customerId: "cus_sd",
    meta: {}, refundedCents: 0, status: "succeeded", chargeId,
  });
  await resolveDepositPending(bookingId, gigId);
  return { bookingId, gigId };
}

describe("requestPayout, authority (H2: admin only)", () => {
  it("a non-admin member cannot request a payout (permission-denied); the admin owner can", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("h2auth");
    await seedBalance(accountId, 10_000);
    // A plain (role:"member", not admin) member of the SAME profile.
    const member = await signUpTestUser(`h2member-${Date.now()}@test.com`);
    await adb.doc(`profiles/${profileId}/members/${member.uid}`).set(
      { uid: member.uid, role: "member", label: "helper", joinedAt: Date.now() });

    await expect(payout({ profileId, amountCents: 5_000, method: "standard", requestId: freshRequestId() }, member.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    // The admin owner is allowed, the money-draining action is admin-gated,
    // like removeMember/transferAdmin.
    const ok = await payout({ profileId, amountCents: 5_000, method: "standard", requestId: freshRequestId() }, owner.user);
    expect(ok.payoutId).toMatch(/^po_/);
  });
});

describe("requestPayout, instant $10 minimum (M4)", () => {
  it("refuses instant below $10 (invalid-argument), allows exactly $10, and standard is unaffected below $10", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("m4min");
    await seedBalance(accountId, 20_000);

    // $9.99 instant → invalid-argument (below the minimum)
    await expect(payout({ profileId, amountCents: INSTANT_PAYOUT_MIN_CENTS - 1, method: "instant", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: PAYOUT_INSTANT_MIN_MESSAGE });
    // $10.00 instant → allowed (exactly the minimum)
    const inst = await payout({ profileId, amountCents: INSTANT_PAYOUT_MIN_CENTS, method: "instant", requestId: freshRequestId() }, owner.user);
    expect(inst.payoutId).toMatch(/^po_/);
    // $9.99 standard → allowed (the minimum is instant-only; standard floors at $1)
    const std = await payout({ profileId, amountCents: INSTANT_PAYOUT_MIN_CENTS - 1, method: "standard", requestId: freshRequestId() }, owner.user);
    expect(std.feeCents).toBe(0);
    expect(std.netCents).toBe(INSTANT_PAYOUT_MIN_CENTS - 1);
  });
});

describe("requestPayout, self-deal instant hold (M3)", () => {
  it("a self-deal forfeit sets the instant hold; instant is then refused (held) while standard is still allowed", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("m3hold");

    await forfeitDepositTo(profileId, true);
    // The forfeit landed 100% of the slice in the balance...
    expect(await balanceOf(accountId)).toBe(3_500);
    // ...and stamped the instant hold ~now + SELF_DEAL_HOLD_MS.
    const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc;
    expect(typeof sp.instantHoldUntil).toBe("number");
    expect(sp.instantHoldUntil!).toBeGreaterThan(Date.now());
    expect(sp.instantHoldUntil!).toBeLessThanOrEqual(Date.now() + SELF_DEAL_HOLD_MS + 5_000);

    // Instant refused BY THE HOLD (a $10 request, so it clears the M4 minimum
    // and reaches the hold check), standard still works.
    await expect(payout({ profileId, amountCents: 1_000, method: "instant", requestId: freshRequestId() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: PAYOUT_INSTANT_HELD_MESSAGE });
    const std = await payout({ profileId, amountCents: 1_000, method: "standard", requestId: freshRequestId() }, owner.user);
    expect(std.netCents).toBe(1_000);
  });

  it("a NON-self-deal forfeit sets NO instant hold, instant stays available", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("m3nohold");

    await forfeitDepositTo(profileId, false);
    expect(await balanceOf(accountId)).toBe(3_500);
    const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc;
    expect(sp.instantHoldUntil == null).toBe(true);

    const inst = await payout({ profileId, amountCents: 1_000, method: "instant", requestId: freshRequestId() }, owner.user);
    expect(inst.payoutId).toMatch(/^po_/);
  });

  it("an EXPIRED hold does not block instant", async () => {
    const { owner, profileId, accountId } = await makePayoutReady("m3exp");
    await seedBalance(accountId, 10_000);
    await adb.doc(`profiles/${profileId}/private/stripe`).set({ instantHoldUntil: Date.now() - 1000 }, { merge: true });
    const inst = await payout({ profileId, amountCents: 1_000, method: "instant", requestId: freshRequestId() }, owner.user);
    expect(inst.payoutId).toMatch(/^po_/);
  });
});

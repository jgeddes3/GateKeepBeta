import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";
import { fakeEvent, postWebhook, memberStripe, enableMemberAccount } from "./payoutFixtures";
import {
  computeInstantFeeCents, INSTANT_FEE_MIN_CENTS, INSTANT_FEE_PCT, INSTANT_PAYOUT_MIN_CENTS,
  PAYOUT_INSTANT_MIN_MESSAGE, type LedgerEntry,
} from "@gatekeep/shared";

vi.setConfig({ testTimeout: 30_000 });

describe("member onboarding and status", () => {
  it("creates one account per user, syncs flags through account.updated, and ignores a forged account", async () => {
    const u = await signUpTestUser(`mp1-${Date.now()}@test.com`);
    const link = await callFn<object, { url: string }>("createMemberOnboardingLink", {}, u.user);
    expect(link.url).toContain("fake.stripe/onboard/");
    const first = await memberStripe(u.uid);
    expect(first?.accountId).toMatch(/^acct/);
    await callFn("createMemberOnboardingLink", {}, u.user);
    expect((await memberStripe(u.uid))?.accountId).toBe(first!.accountId);
    const forged = { ...fakeEvent("account.updated", { id: first!.accountId, metadata: { uid: u.uid } }), account: "acct_evil" };
    expect((await postWebhook(forged)).status).toBe(200);
    expect((await memberStripe(u.uid))?.transfersEnabled).toBe(false);
    expect(await enableMemberAccount(u.uid)).toBe(200);
    const after = await memberStripe(u.uid);
    expect(after).toMatchObject({ transfersEnabled: true, payoutsEnabled: true, instantEligible: true });
    expect(after?.onboardedAt).not.toBeNull();
    const status = await callFn<
      object, { hasAccount: boolean; payoutsEnabled: boolean; heldCents: number; availableBalanceCents: number | null }
    >("getMemberPayoutStatus", {}, u.user);
    expect(status).toMatchObject({ hasAccount: true, payoutsEnabled: true, heldCents: 0, availableBalanceCents: 0 });
  });
});

describe("requestMemberPayout", () => {
  it("pays out the owner's balance, replays by request id, refuses before setup, and routes payout.failed to the user", async () => {
    const u = await signUpTestUser(`mp2-${Date.now()}@test.com`);
    await expect(callFn("requestMemberPayout", { amountCents: 500, method: "standard", requestId: "req-aaaaaaa1" }, u.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await callFn("createMemberOnboardingLink", {}, u.user);
    expect(await enableMemberAccount(u.uid)).toBe(200);
    const ms = await memberStripe(u.uid);
    await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).set({ balanceCents: 2000 }, { merge: true });
    const res = await callFn<object, { payoutId: string; replayed: boolean; netCents: number }>(
      "requestMemberPayout", { amountCents: 1500, method: "standard", requestId: "req-aaaaaaa1" }, u.user);
    expect(res).toMatchObject({ replayed: false, netCents: 1500 });
    const again = await callFn<object, { payoutId: string; replayed: boolean }>(
      "requestMemberPayout", { amountCents: 1500, method: "standard", requestId: "req-aaaaaaa1" }, u.user);
    expect(again).toMatchObject({ payoutId: res.payoutId, replayed: true });
    expect(((await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).get()).data()?.balanceCents)).toBe(500);
    const rows = await adb.collection("ledger").where("uid", "==", u.uid).get();
    expect(rows.docs.map((d) => (d.data() as LedgerEntry).kind)).toContain("member_payout_standard");
    const failed = { ...fakeEvent("payout.failed", { id: res.payoutId, amount: 1500, metadata: { uid: u.uid }, failure_code: "account_closed" }), account: ms!.accountId };
    expect((await postWebhook(failed)).status).toBe(200);
    const notes = await adb.collection(`users/${u.uid}/notifications`).where("kind", "==", "member_payout_failed").get();
    expect(notes.size).toBe(1);
  });

  // FIX WAVE M3(b): the member rail must enforce the SAME instant rules as the
  // profile rail (paymentsPayouts.test.ts's "requestPayout, instant" block),
  // with the same caller-facing message constants. requestMemberPayout mirrors
  // requestPayout substitution-for-substitution, and these are the assertions
  // that keep it mirrored.
  it("refuses a sub-$10 instant amount with the same minimum message, and nets the 4% fee (min $1) off an allowed one", async () => {
    const u = await signUpTestUser(`mp3-${Date.now()}@test.com`);
    await callFn("createMemberOnboardingLink", {}, u.user);
    expect(await enableMemberAccount(u.uid)).toBe(200);
    const ms = await memberStripe(u.uid);
    const balanceOf = async () =>
      (await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).get()).data()?.balanceCents as number;
    await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).set({ balanceCents: 10_000 }, { merge: true });

    // Below the $10 instant minimum: refused BEFORE any Stripe call, balance
    // untouched, and standard is unaffected by the instant-only floor.
    await expect(callFn(
      "requestMemberPayout",
      { amountCents: INSTANT_PAYOUT_MIN_CENTS - 1, method: "instant", requestId: "req-mp3min1" }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: PAYOUT_INSTANT_MIN_MESSAGE });
    expect(await balanceOf()).toBe(10_000);

    // $50 instant: THE RATE ANCHOR, 4% of $50 is $2, above the $1 floor.
    // Hard-coded exactly as the profile suite does it, so a change to
    // INSTANT_FEE_PCT has to be acknowledged here rather than sliding through.
    const amountCents = 5_000;
    const feeCents = computeInstantFeeCents(amountCents, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS);
    expect(feeCents).toBe(200);
    const res = await callFn<object, { payoutId: string; feeCents: number; netCents: number }>(
      "requestMemberPayout", { amountCents, method: "instant", requestId: "req-mp3inst" }, u.user);
    expect(res.feeCents).toBe(feeCents);
    expect(res.netCents).toBe(amountCents - feeCents);
    // GROSS off the balance: the payout takes the net, the account debit takes the fee.
    expect(await balanceOf()).toBe(10_000 - amountCents);
    const payoutRow = await adb.doc(`ledger/member_payout_instant:${res.payoutId}`).get();
    expect(payoutRow.exists).toBe(true);
    expect(payoutRow.data()?.amountCents).toBe(amountCents - feeCents);
    const rows = (await adb.collection("ledger").where("uid", "==", u.uid).get())
      .docs.map((d) => d.data() as LedgerEntry);
    expect(rows.find((r) => r.kind === "account_debit")?.amountCents).toBe(feeCents);
    // The fee landed, so nothing was escalated for this request.
    expect((await adb.doc("adminAlerts/member_payout_fee:" + u.uid + ":req-mp3inst").get()).exists).toBe(false);

    // $1 floor: 4% of $10 is 40c, floored to $1.
    expect(computeInstantFeeCents(1_000, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS)).toBe(INSTANT_FEE_MIN_CENTS);
    const small = await callFn<object, { feeCents: number; netCents: number }>(
      "requestMemberPayout", { amountCents: 1_000, method: "instant", requestId: "req-mp3floor" }, u.user);
    expect(small.feeCents).toBe(INSTANT_FEE_MIN_CENTS);
    expect(small.netCents).toBe(1_000 - INSTANT_FEE_MIN_CENTS);
    expect(await balanceOf()).toBe(4_000);
  });
});

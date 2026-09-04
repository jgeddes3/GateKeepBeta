import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";
import { fakeEvent, postWebhook, memberStripe, enableMemberAccount } from "./payoutFixtures";
import type { LedgerEntry } from "@gatekeep/shared";

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
});

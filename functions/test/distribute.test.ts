import { describe, it, expect, vi } from "vitest";
import type { User } from "firebase/auth";
import { callFn } from "./helpers";
import { adb, makeApprovedMusicianProfile } from "./discoverFixtures";
import { addMember, enableMemberAccount, memberStripe } from "./payoutFixtures";
import { distributeEarnings } from "../src/payoutShares.js";
import type { HeldShareDoc, LedgerEntry, NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const fakeBalance = async (accountId: string) => ((await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data()?.balanceCents as number | undefined) ?? 0;

// `makeApprovedMusicianProfile` does not create a Stripe account. Mirrors
// `makeMoneyReady`'s musician branch (functions/test/helpers.ts): create the
// account via the ordinary onboarding-link callable, then flip its fake
// account's flags and the cached gate flags directly, exactly the same two
// writes that helper makes.
async function readyProfileAccount(profileId: string, ownerUser: User) {
  await callFn("createOnboardingLink", { profileId }, ownerUser);
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as { accountId?: string } | undefined;
  if (!sp?.accountId) {
    throw new Error(`readyProfileAccount: profile ${profileId} has no accountId after createOnboardingLink.`);
  }
  await adb.doc(`stripeFake/state/objects/${sp.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  await adb.doc(`profiles/${profileId}/private/stripe`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
}

describe("distributeEarnings", () => {
  it("pays enabled members, holds the rest, is idempotent per base, and releases on enable", async () => {
    const band = await makeApprovedMusicianProfile("di1");
    const bass = await addMember(band.profileId, "di1b");
    const drums = await addMember(band.profileId, "di1d");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    expect(await enableMemberAccount(bass.uid)).toBe(200);
    await callFn("setPayoutShares", { profileId: band.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 50 },
      { payee: { kind: "member", uid: drums.uid }, percent: 30 },
      { payee: { kind: "profile" }, percent: 20 },
    ] }, band.owner.user);
    await readyProfileAccount(band.profileId, band.owner.user);
    const sp = (await adb.doc(`profiles/${band.profileId}/private/stripe`).get()).data()!;
    const base = `test:di1:${Date.now()}`;
    const input = {
      profileId: band.profileId, amountCents: 1001, source: null, purpose: "earnings" as const,
      ref: { bookingId: "b1", gigId: "g1" }, idempotencyBase: base, meta: { purpose: "earnings" }, profileAccountId: sp.accountId as string, now: Date.now(),
    };
    const r1 = await distributeEarnings(input);
    expect(r1.legs.map((l) => [l.payee.kind, l.amountCents, l.outcome])).toEqual([
      ["member", 501, "transferred"], ["member", 300, "held"], ["profile", 200, "transferred"],
    ]);
    // Fix round 1 (Critical): `transferId` is the PROFILE leg's own transfer,
    // never a member's, even though a member leg comes first in `legs` above,
    // a clawback reverses this exact id and must never reach into a member's
    // account. `profileCents` is what the profile's own account actually got.
    expect(r1.transferId).toBe(r1.legs.find((l) => l.payee.kind === "profile")!.transferId);
    expect(r1.profileCents).toBe(200);
    const bassAcct = (await memberStripe(bass.uid))!.accountId!;
    expect(await fakeBalance(bassAcct)).toBe(501);
    expect(await fakeBalance(sp.accountId as string)).toBe(200);
    const held = (await adb.doc(`heldShares/${base}:${drums.uid}`).get()).data() as HeldShareDoc;
    expect(held).toMatchObject({ profileId: band.profileId, uid: drums.uid, amountCents: 300, status: "held" });
    const r2 = await distributeEarnings(input);
    expect(r2.legs).toEqual(r1.legs);
    expect(await fakeBalance(bassAcct)).toBe(501);
    const paidNote = await adb.collection(`users/${bass.uid}/notifications`).where("kind", "==", "share_paid").get();
    expect(paidNote.size).toBe(1);
    const heldNote = await adb.collection(`users/${drums.uid}/notifications`).where("kind", "==", "share_held").get();
    expect(heldNote.size).toBe(1);
    expect((heldNote.docs[0].data() as NotificationDoc).body).toContain("$3.00");

    await callFn("createMemberOnboardingLink", {}, drums.user);
    expect(await enableMemberAccount(drums.uid)).toBe(200);
    const drumsAcct = (await memberStripe(drums.uid))!.accountId!;
    const until = Date.now() + 15_000;
    let released: HeldShareDoc | undefined;
    for (;;) {
      released = (await adb.doc(`heldShares/${base}:${drums.uid}`).get()).data() as HeldShareDoc;
      if (released.status === "released" || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(released!.status).toBe("released");
    expect(await fakeBalance(drumsAcct)).toBe(300);
    const rows = await adb.collection("ledger").where("uid", "==", drums.uid).get();
    expect(rows.docs.map((d) => (d.data() as LedgerEntry).kind).sort()).toEqual(["share_held", "share_released"]);
    // Fix round 1 (Important 1): enableMemberAccount's webhook drives release
    // through TWO independent paths off the same underlying doc write, the
    // account.updated handler's own releaseHeldSharesHook call and the
    // onMemberStripeWritten trigger firing off that same write, so this is
    // exactly the race the deterministic (not time-based) dedupe key guards.
    const releasedNote = await adb.collection(`users/${drums.uid}/notifications`).where("kind", "==", "share_released").get();
    expect(releasedNote.size).toBe(1);
  });

  it("with no shares makes a single transfer under the base key", async () => {
    const solo = await makeApprovedMusicianProfile("di2");
    await readyProfileAccount(solo.profileId, solo.owner.user);
    const sp = (await adb.doc(`profiles/${solo.profileId}/private/stripe`).get()).data()!;
    const r = await distributeEarnings({ profileId: solo.profileId, amountCents: 700, source: null, purpose: "earnings", ref: { bookingId: "b", gigId: "g" }, idempotencyBase: `test:di2:${Date.now()}`, meta: {}, profileAccountId: sp.accountId as string, now: Date.now() });
    expect(r.legs).toHaveLength(1);
    expect(r.transferId).toMatch(/^tr/);
    expect(await fakeBalance(sp.accountId as string)).toBe(700);
  });
});

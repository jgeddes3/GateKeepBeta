import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile } from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import type { StripeProfileDoc, NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

const stripeDoc = async (profileId: string) => (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;

describe("setPayoutShares", () => {
  it("admin sets, member cannot, validation runs against live members, null clears", async () => {
    const band = await makeApprovedMusicianProfile("ps1");
    const bass = await addMember(band.profileId, "ps1b");
    const shares = [
      { payee: { kind: "member", uid: band.owner.uid }, percent: 60 },
      { payee: { kind: "member", uid: bass.uid }, percent: 30 },
      { payee: { kind: "profile" }, percent: 10 },
    ];
    await callFn("setPayoutShares", { profileId: band.profileId, shares }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toEqual(shares);
    await expect(callFn("setPayoutShares", { profileId: band.profileId, shares }, bass.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    const stranger = await signUpTestUser(`ps1s-${Date.now()}@test.com`);
    await expect(callFn("setPayoutShares", { profileId: band.profileId, shares: [{ payee: { kind: "member", uid: stranger.uid }, percent: 100 }] }, band.owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await callFn("setPayoutShares", { profileId: band.profileId, shares: null }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toBeNull();
  });
});

describe("removeMember with a share", () => {
  it("moves the removed member's share to the band fund and tells the admins, not every member", async () => {
    const band = await makeApprovedMusicianProfile("ps2");
    const bass = await addMember(band.profileId, "ps2b");
    const drummer = await addMember(band.profileId, "ps2d");
    await callFn("setPayoutShares", { profileId: band.profileId, shares: [
      { payee: { kind: "member", uid: band.owner.uid }, percent: 70 },
      { payee: { kind: "member", uid: bass.uid }, percent: 30 },
    ] }, band.owner.user);
    await callFn("removeMember", { profileId: band.profileId, uid: bass.uid }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toEqual([
      { payee: { kind: "member", uid: band.owner.uid }, percent: 70 },
      { payee: { kind: "profile" }, percent: 30 },
    ]);
    const notes = await adb.collection(`users/${band.owner.uid}/notifications`).where("kind", "==", "system").get();
    expect(notes.docs.some((d) => (d.data() as NotificationDoc).title === "Payout shares changed")).toBe(true);
    const drummerNotes = await adb.collection(`users/${drummer.uid}/notifications`).where("kind", "==", "system").get();
    expect(drummerNotes.docs.some((d) => (d.data() as NotificationDoc).title === "Payout shares changed")).toBe(false);
  });
});

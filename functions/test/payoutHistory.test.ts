import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile } from "./discoverFixtures";
import { addMember } from "./payoutFixtures";

vi.setConfig({ testTimeout: 30_000 });

describe("getPayoutHistory", () => {
  it("members page a profile's rows newest first, owners page their own, strangers are refused", async () => {
    const band = await makeApprovedMusicianProfile("ph1");
    const bass = await addMember(band.profileId, "ph1b");
    const at = Date.now();
    for (let i = 0; i < 25; i++) {
      // Controller ruling: writeLedger names ledger docs `${kind}:${stripeId}`
      // (colons, often over 64 characters), so a real cursor must be able to
      // round-trip an id like that. Seed via deterministic ids rather than
      // .add() so paging exercises exactly that.
      const kind = i % 2 ? "share_transfer" : "earnings_transfer";
      await adb.doc(`ledger/${kind}:tr_ph1_${i}`).set({
        kind, amountCents: 100 + i, bookingId: "b", gigId: "g", profileId: band.profileId,
        uid: i % 2 ? bass.uid : null, stripeId: `tr_ph1_${i}`, detail: "t", at: at - i * 1000,
      });
    }
    const page1 = await callFn<object, { rows: Array<{ amountCents: number; label: string | null }>; nextCursor: string | null }>(
      "getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId } }, bass.user);
    expect(page1.rows).toHaveLength(20);
    expect(page1.rows[0].amountCents).toBe(100);
    expect(page1.rows[1].label).toBe("bass");
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await callFn<object, { rows: unknown[]; nextCursor: string | null }>(
      "getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId }, cursor: page1.nextCursor }, bass.user);
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    const mine = await callFn<object, { rows: Array<{ uid: string | null }> }>(
      "getPayoutHistory", { scope: { kind: "user" } }, bass.user);
    expect(mine.rows.every((r) => r.uid === bass.uid)).toBe(true);
    const stranger = await signUpTestUser(`ph1s-${Date.now()}@test.com`);
    await expect(
      callFn("getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId } }, stranger.user),
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

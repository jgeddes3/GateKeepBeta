import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeApprovedMusicianProfile, stub } from "./discoverFixtures";
import type { ProfileDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

describe("updatePortfolio home city", () => {
  it("geocodes a city, skips the budget on an unchanged re-save, and clears with null", async () => {
    const m = await makeApprovedMusicianProfile("pc1");
    await callFn("updatePortfolio", { profileId: m.profileId, city: "Austin" }, m.owner.user);
    const expected = await stub.geocode("Austin");
    let p = (await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc;
    expect(p.portfolio?.location).toEqual({ city: expected!.city, geo: { lat: expected!.lat, lng: expected!.lng }, geocodedFrom: "Austin" });
    const budget1 = (await adb.doc(`geocodeBudgets/${m.owner.uid}`).get()).data()?.count;
    await callFn("updatePortfolio", { profileId: m.profileId, city: "Austin", bio: "Updated" }, m.owner.user);
    const budget2 = (await adb.doc(`geocodeBudgets/${m.owner.uid}`).get()).data()?.count;
    expect(budget2).toBe(budget1);
    await callFn("updatePortfolio", { profileId: m.profileId, city: null }, m.owner.user);
    p = (await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc;
    expect(p.portfolio?.location).toBeNull();
  });
  it("rejects an overlong city", async () => {
    const m = await makeApprovedMusicianProfile("pc2");
    await expect(callFn("updatePortfolio", { profileId: m.profileId, city: "x".repeat(121) }, m.owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";
import type { UpdateAccountResult, UserDoc, GetDiscoverDeckInput, GetDiscoverDeckResult } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

const userDoc = async (uid: string) => (await adb.doc(`users/${uid}`).get()).data() as UserDoc;

describe("updateAccount", () => {
  it("saves a name and a geocoded city, coarsens the point, and clears both", async () => {
    const u = await signUpTestUser(`ua1-${Date.now()}@test.com`);
    const res = await callFn<object, UpdateAccountResult>(
      "updateAccount", { displayName: "  Bobby Tables  ", homeCity: "Austin, TX" }, u.user);
    expect(res).toMatchObject({ ok: true, geocoded: true });
    const after = await userDoc(u.uid);
    expect(after.displayName).toBe("Bobby Tables");
    expect(after.homeCity).toBe("Austin, TX");
    expect(after.homeGeo).not.toBeNull();
    // coarsen() rounds to two decimals, so 100 * value is a whole number.
    expect(Number.isInteger(Math.round(after.homeGeo!.lat * 100))).toBe(true);
    expect(after.homeGeo!.lat).toBe(Math.round(after.homeGeo!.lat * 100) / 100);
    expect(after.homeGeo!.lng).toBe(Math.round(after.homeGeo!.lng * 100) / 100);

    // A name-only save leaves the city and the point alone.
    expect(await callFn<object, UpdateAccountResult>("updateAccount", { displayName: "Bob" }, u.user))
      .toMatchObject({ ok: true, geocoded: null });
    const nameOnly = await userDoc(u.uid);
    expect(nameOnly.displayName).toBe("Bob");
    expect(nameOnly.homeGeo).toEqual(after.homeGeo);

    // null clears both; "" does the same.
    expect(await callFn<object, UpdateAccountResult>("updateAccount", { homeCity: null }, u.user))
      .toMatchObject({ ok: true, geocoded: null });
    const cleared = await userDoc(u.uid);
    expect(cleared.homeCity).toBeNull();
    expect(cleared.homeGeo).toBeNull();
  });

  it("refuses a blank or overlong name and an overlong city, and refuses signed-out callers", async () => {
    const u = await signUpTestUser(`ua2-${Date.now()}@test.com`);
    await expect(callFn("updateAccount", { displayName: "   " }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Display name must be 1 to 80 characters." });
    await expect(callFn("updateAccount", { displayName: "x".repeat(81) }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { displayName: 5 }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { homeCity: "x".repeat(81) }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Home city must be 80 characters or fewer." });
    await expect(callFn("updateAccount", { homeCity: 5 }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateAccount", { displayName: "Nobody" })).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("charges the geocode budget only when it geocodes, and refuses past the daily ceiling", async () => {
    const u = await signUpTestUser(`ua3-${Date.now()}@test.com`);
    const dateKey = new Date().toISOString().slice(0, 10);
    await callFn("updateAccount", { homeCity: "Austin, TX" }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()).toMatchObject({ date: dateKey, count: 1 });
    await callFn("updateAccount", { displayName: "No geocode here" }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()?.count).toBe(1);
    await callFn("updateAccount", { homeCity: null }, u.user);
    expect((await adb.doc(`geocodeBudgets/${u.uid}`).get()).data()?.count).toBe(1);
    await adb.doc(`geocodeBudgets/${u.uid}`).set({ date: dateKey, count: 50 });
    await expect(callFn("updateAccount", { homeCity: "Dallas, TX" }, u.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });

  it("hands the stored homeGeo straight to getDiscoverDeck", async () => {
    const u = await signUpTestUser(`ua4-${Date.now()}@test.com`);
    await callFn("updateAccount", { homeCity: "Austin, TX" }, u.user);
    const homeGeo = (await userDoc(u.uid)).homeGeo!;
    const deck = await callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>(
      "getDiscoverDeck", { location: homeGeo }, u.user);
    expect(Array.isArray(deck.cards)).toBe(true);
    for (const card of deck.cards) {
      if (card.kind === "show" || card.kind === "venue") {
        expect(card.distanceMeters === null || typeof card.distanceMeters === "number").toBe(true);
      }
    }
    await expect(callFn("getDiscoverDeck", { location: { lat: 200, lng: 0 } }, u.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

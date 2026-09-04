import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeApprovedMusicianProfile, makeApprovedCuratorProfile, makePublishedBookingEvent, makeFan, waitForIndex } from "./discoverFixtures";
import { consumeSearchBudget } from "../src/searchBudget.js";
import { SEARCH_DAILY_BUDGET, type SearchInput, type SearchOutput, type EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const DAY = 24 * 60 * 60 * 1000;
const input = (over: Partial<SearchInput>): SearchInput =>
  ({ face: "fan", q: "", filters: {}, location: null, page: 0, includePins: false, ...over });

describe("search callable", () => {
  it("requires auth, validates input, and rejects a null-less bad location", async () => {
    const fan = await makeFan("se1");
    await expect(callFn("search", input({}))).rejects.toMatchObject({ code: "functions/unauthenticated" });
    // The Firebase client SDK's request encoder folds `undefined` into `null`
    // before it ever leaves the browser (see @firebase/functions' `encode`),
    // so a location of `undefined` is indistinguishable on the wire from a
    // location of `null` (which is valid, "no location given"). Send an
    // empty object instead: it survives encoding as `{}`, which is not null
    // and has no lat/lng, so it actually exercises the "bad location" path.
    await expect(callFn("search", { ...input({}), location: {} }, fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("search", input({ face: "fan", filters: { actSize: "band" } }), fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("search", input({ page: 51 }), fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("finds a published show by title words with AND semantics and returns only result fields", async () => {
    const { eventId } = await makePublishedBookingEvent("se2");
    await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    const fan = await makeFan("se2f");
    const firstWord = event.title.split(" ").find((w) => w.length >= 2) as string;
    const hit = await callFn<SearchInput, SearchOutput>("search", input({ q: firstWord }), fan.user);
    const row = hit.items.find((r) => r.id === eventId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("tokens");
    expect(row).not.toHaveProperty("busyDays");
    expect(row).not.toHaveProperty("relatedProfileIds");
    expect(row!.distanceMeters).toBeNull();
    const miss = await callFn<SearchInput, SearchOutput>("search", input({ q: `${firstWord} zzzqqq` }), fan.user);
    expect(miss.items.find((r) => r.id === eventId)).toBeUndefined();
  });

  it("applies fan filters: free only, genres, when, and near me with distance", async () => {
    const { eventId } = await makePublishedBookingEvent("se3");
    const idx = await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    const fan = await makeFan("se3f");
    const free = await callFn<SearchInput, SearchOutput>("search", input({ filters: { freeOnly: true } }), fan.user);
    expect(free.items.some((r) => r.id === eventId)).toBe(true);
    const jazz = await callFn<SearchInput, SearchOutput>("search", input({ filters: { genres: ["jazz"] } }), fan.user);
    expect(jazz.items.some((r) => r.id === eventId)).toBe(idx!.genres.includes("jazz"));
    const tonight = await callFn<SearchInput, SearchOutput>("search", input({ filters: { when: "tonight" } }), fan.user);
    expect(tonight.items.some((r) => r.id === eventId)).toBe(idx!.startsAt! < Date.now() + DAY);
    if (idx!.geo) {
      const near = await callFn<SearchInput, SearchOutput>("search", input({ filters: { nearMe: true }, location: { lat: idx!.geo.lat, lng: idx!.geo.lng } }), fan.user);
      const row = near.items.find((r) => r.id === eventId);
      expect(row?.distanceMeters).toBe(0);
      const far = await callFn<SearchInput, SearchOutput>("search", input({ filters: { nearMe: true }, location: { lat: idx!.geo.lat + 5, lng: idx!.geo.lng } }), fan.user);
      expect(far.items.some((r) => r.id === eventId)).toBe(false);
    }
  });

  it("serves the curator face with act size, city, audio, and availability filters", async () => {
    const m = await makeApprovedMusicianProfile("se4m");
    await adb.doc(`profiles/${m.profileId}/private/booking`).set({
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [], travelRadiusKm: null, actSize: "duo", typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null },
      updatedAt: Date.now(),
    });
    await adb.doc(`profiles/${m.profileId}`).update({ "portfolio.location": { city: "Austin", geo: null, geocodedFrom: "Austin" }, updatedAt: Date.now() });
    await waitForIndex(`artist_${m.profileId}`, (x) => x?.actSize === "duo" && x?.cityLower === "austin");
    const c = await makeApprovedCuratorProfile("se4c");
    const q = (filters: SearchInput["filters"]) => callFn<SearchInput, SearchOutput>("search", input({ face: "curator", q: "the act", filters }), c.owner.user);
    expect((await q({ actSize: "duo" })).items.some((r) => r.id === m.profileId)).toBe(true);
    expect((await q({ actSize: "band" })).items.some((r) => r.id === m.profileId)).toBe(false);
    expect((await q({ city: "austin" })).items.some((r) => r.id === m.profileId)).toBe(true);
    expect((await q({ city: "Dallas" })).items.some((r) => r.id === m.profileId)).toBe(false);
    expect((await q({ hasAudio: true })).items.some((r) => r.id === m.profileId)).toBe(true);
    expect((await q({ availableOn: "2030-01-01" })).items.some((r) => r.id === m.profileId)).toBe(true);
  });

  it("pages 20 at a time and returns pins on request", async () => {
    const fan = await makeFan("se5f");
    const page0 = await callFn<SearchInput, SearchOutput>("search", input({ includePins: true }), fan.user);
    expect(page0.items.length).toBeLessThanOrEqual(20);
    expect(page0.page).toBe(0);
    expect(Array.isArray(page0.pins)).toBe(true);
    for (const p of page0.pins!) expect(p.geo).toBeDefined();
    expect(page0.matched).toBeGreaterThanOrEqual(page0.items.length);
    const page1 = await callFn<SearchInput, SearchOutput>("search", input({ page: 1 }), fan.user);
    expect(page1.pins).toBeUndefined();
    expect(page1.hasMore).toBe(page0.matched > 40);
  });

  it("enforces the daily budget and resets on a new day", async () => {
    const fan = await makeFan("se6f");
    const today = new Date().toISOString().slice(0, 10);
    await adb.doc(`searchBudgets/${fan.uid}`).set({ date: today, count: SEARCH_DAILY_BUDGET });
    await expect(callFn("search", input({}), fan.user)).rejects.toMatchObject({ code: "functions/resource-exhausted" });
    await consumeSearchBudget(fan.uid, Date.now() + DAY);
    expect((await adb.doc(`searchBudgets/${fan.uid}`).get()).data()).toMatchObject({ count: 1 });
  });
});

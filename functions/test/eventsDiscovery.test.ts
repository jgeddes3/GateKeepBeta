import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeDraftEvent, makeFilledGig, eventContent, addTiers, makePublishedBookingEvent } from "./discoverFixtures";
import type { EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

describe("event discovery projections", () => {
  it("derives genres from a booking act's portfolio and starts with no price projection", async () => {
    const { eventId } = await makePublishedBookingEvent("pg1", [
      { name: "GA", priceCents: 1500, capacity: 10, saleStartsAt: null, saleEndsAt: null },
      { name: "Free", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null },
    ]);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["rock"]);
    expect(ev.curatorGenres).toEqual([]);
    expect(ev.priceFromCents).toBe(0);
    expect(ev.hasFreeTier).toBe(true);
  });
  it("curator genres override derivation and are validated", async () => {
    const { curator, musician, bookingId } = await makeFilledGig("pg2");
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" }, curatorGenres: ["jazz", "soul"],
      ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
    }, curator.owner.user);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["jazz", "soul"]);
    await expect(callFn("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" }, curatorGenres: ["polka"], ...eventContent(),
    }, curator.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("external-only lineups get empty genres; setEventTiers keeps the projection current", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pg3");
    let ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual([]); expect(ev.priceFromCents).toBeNull(); expect(ev.hasFreeTier).toBe(false);
    await addTiers(profileId, eventId, owner.user, [{ name: "GA", priceCents: 2500, capacity: 5, saleStartsAt: null, saleEndsAt: null }]);
    ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.priceFromCents).toBe(2500); expect(ev.hasFreeTier).toBe(false);
  });
  it("updateEvent recomputes genres when the curator sets them", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pg4");
    await callFn("updateEvent", { curatorProfileId: profileId, eventId, curatorGenres: ["blues"], ...eventContent() }, owner.user);
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(ev.genres).toEqual(["blues"]);
  });
});

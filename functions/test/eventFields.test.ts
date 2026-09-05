import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeApprovedCuratorProfile, eventContent, addTiersAndPublish } from "./discoverFixtures";
import type { EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const HOUR = 3_600_000;
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;

describe("doors and age on createEvent", () => {
  it("stores both, defaults age to all_ages and doors to null, and refuses bad values", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ef1", "venue");
    const base = eventContent();
    const startsAt = base.startsAt as number;

    const created = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" }, ...base,
      doorsAt: startsAt - HOUR, ageRestriction: "21_plus",
    }, owner.user);
    expect(await event(created.eventId)).toMatchObject({ doorsAt: startsAt - HOUR, ageRestriction: "21_plus" });

    const plain = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base }, owner.user);
    expect(await event(plain.eventId)).toMatchObject({ doorsAt: null, ageRestriction: "all_ages" });

    for (const doorsAt of [startsAt, startsAt + 1, startsAt - 13 * HOUR, "soon", 1.5]) {
      await expect(callFn("createEvent",
        { curatorProfileId: profileId, source: { kind: "standalone" }, ...base, doorsAt }, owner.user))
        .rejects.toMatchObject({
          code: "functions/invalid-argument",
          message: "Doors must be before the start time and within 12 hours of it.",
        });
    }
    // The 12-hour bound is inclusive at exactly 12 hours.
    const edge = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" }, ...base, doorsAt: startsAt - 12 * HOUR,
    }, owner.user);
    expect((await event(edge.eventId)).doorsAt).toBe(startsAt - 12 * HOUR);

    await expect(callFn("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base, ageRestriction: "18" }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: "Pick an age restriction." });
  });
});

describe("doors and age on updateEvent", () => {
  it("saves both, clears doors with null, and a doors-only change does not reschedule", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ef2", "venue");
    const base = eventContent();
    const startsAt = base.startsAt as number;
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base }, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);

    const payload = {
      curatorProfileId: profileId, eventId,
      title: base.title, description: base.description, startsAt, endsAt: base.endsAt,
      lineup: base.lineup,
    };
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - 2 * HOUR, ageRestriction: "18_plus" }, owner.user);
    expect(await event(eventId)).toMatchObject({ doorsAt: startsAt - 2 * HOUR, ageRestriction: "18_plus" });

    // A doors-only edit must not tell followers or ticket holders the show moved.
    const before = await adb.collection(`users/${owner.uid}/notifications`).get();
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - 3 * HOUR, ageRestriction: "18_plus" }, owner.user);
    const after = await adb.collection(`users/${owner.uid}/notifications`).get();
    expect(after.size).toBe(before.size);
    expect(after.docs.some((d) => d.id === `resched:${eventId}:${startsAt}`)).toBe(false);

    await callFn("updateEvent", { ...payload, doorsAt: null }, owner.user);
    expect(await event(eventId)).toMatchObject({ doorsAt: null, ageRestriction: "all_ages" });
  });
});

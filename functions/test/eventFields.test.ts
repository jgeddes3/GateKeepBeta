import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedCuratorProfile, eventContent, addTiersAndPublish } from "./discoverFixtures";
import { EVENT_DOORS_MESSAGE, type EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const HOUR = 3_600_000;
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const reschedNotes = async (uid: string) =>
  (await adb.collection(`users/${uid}/notifications`).where("kind", "==", "show_rescheduled").get()).docs;

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
    // The reschedule fan-out reaches FOLLOWERS and ticket holders, never the
    // curator who made the edit, so the "did it fire?" assertions need a fan
    // following the curator profile before publish (the pattern
    // eventArtistTags.test.ts's announce-dedupe case uses).
    const fan = await signUpTestUser(`ef2f-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: profileId, targetType: "curator" }, fan.user);
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
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - 3 * HOUR, ageRestriction: "18_plus" }, owner.user);
    expect(await reschedNotes(fan.uid)).toHaveLength(0);

    // Moving the start an hour later IS a reschedule, and the same fan hears
    // about it: the assertion above is a real negative, not a dead uid.
    const movedAt = startsAt + HOUR;
    await callFn("updateEvent",
      { ...payload, startsAt: movedAt, doorsAt: startsAt - 3 * HOUR, ageRestriction: "18_plus" }, owner.user);
    expect(await reschedNotes(fan.uid)).toHaveLength(1);
    expect((await adb.doc(`users/${fan.uid}/notifications/resched:${eventId}:${movedAt}`).get()).exists).toBe(true);

    await callFn("updateEvent", { ...payload, startsAt: movedAt, doorsAt: null }, owner.user);
    expect(await event(eventId)).toMatchObject({ doorsAt: null, ageRestriction: "all_ages" });
  });

  // Task 4 review, parked: the shared validator refuses a reschedule that
  // would strand a saved doors time AFTER the new start, which is exactly
  // what both editors send when a curator drags the start earlier and resends
  // the doors time already on the event.
  it("refuses moving startsAt earlier than a saved doorsAt", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ef3", "venue");
    const base = eventContent();
    const startsAt = base.startsAt as number;
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
      { curatorProfileId: profileId, source: { kind: "standalone" }, ...base }, owner.user);
    const payload = {
      curatorProfileId: profileId, eventId,
      title: base.title, description: base.description, startsAt, endsAt: base.endsAt,
      lineup: base.lineup,
    };
    await callFn("updateEvent", { ...payload, doorsAt: startsAt - HOUR }, owner.user);
    expect((await event(eventId)).doorsAt).toBe(startsAt - HOUR);

    await expect(callFn("updateEvent",
      { ...payload, startsAt: startsAt - 2 * HOUR, doorsAt: startsAt - HOUR }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument", message: EVENT_DOORS_MESSAGE });
    expect(await event(eventId)).toMatchObject({ startsAt, doorsAt: startsAt - HOUR });
  });
});

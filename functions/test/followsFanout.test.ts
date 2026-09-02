import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser, makeWav } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getStorage as adminStorage } from "firebase-admin/storage";
import {
  adb, makeFan, makeFilledGig, eventContent, addTiersAndPublish, makePublishedBookingEvent, tierIdByName, buyFreeTicket,
} from "./discoverFixtures";
import type { NotificationDoc, EventDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const notes = async (uid: string) =>
  (await adb.collection(`users/${uid}/notifications`).get()).docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) }));

describe("show announced fan-out", () => {
  it("notifies venue, artist, and genre followers once, and lineup members once, with dedupe keys", async () => {
    const { curator, musician, bookingId } = await makeFilledGig("fa1");
    const venueFan = await makeFan("fa1v"); const artistFan = await makeFan("fa1a"); const genreFan = await makeFan("fa1g"); const allFan = await makeFan("fa1all");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, venueFan.user);
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, artistFan.user);
    await callFn("followTarget", { targetId: "genre:rock", targetType: "genre" }, genreFan.user);
    for (const t of [[curator.profileId, "curator"], [musician.profileId, "musician"], ["genre:rock", "genre"]] as const) {
      await callFn("followTarget", { targetId: t[0], targetType: t[1] }, allFan.user);
    }
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" },
      ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
    }, curator.owner.user);
    await addTiersAndPublish(curator.profileId, eventId, curator.owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);

    for (const fan of [venueFan, artistFan, genreFan, allFan]) {
      const n = await notes(fan.uid);
      const announced = n.filter((x) => x.kind === "show_announced");
      expect(announced).toHaveLength(1);
      expect(announced[0].id).toBe(`announce:${eventId}`);
      expect(announced[0].refId).toBe(eventId);
      expect(announced[0].title).toBe("Show announced");
    }
    const bill = (await notes(musician.owner.uid)).filter((x) => x.id === `bill:${eventId}`);
    expect(bill).toHaveLength(1); expect(bill[0].title).toBe("You're on the bill");
  });

  it("adding a lineup artist to a published event notifies only the new artist's followers; existing docs are untouched", async () => {
    const { curator } = await makePublishedBookingEvent("fa2");
    const venueFan = await makeFan("fa2v");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, venueFan.user);
    // Second act with its own follower, added after publish.
    const second = await makeFilledGig("fa2b");
    const secondFan = await makeFan("fa2s");
    await callFn("followTarget", { targetId: second.musician.profileId, targetType: "musician" }, secondFan.user);
    const { eventId: ev2 } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: second.curator.profileId, source: { kind: "standalone" },
      ...eventContent({ lineup: [{ kind: "external", name: "Opener" }] }),
    }, second.curator.owner.user);
    await addTiersAndPublish(second.curator.profileId, ev2, second.curator.owner.user,
      [{ name: "GA", priceCents: 0, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    expect((await notes(secondFan.uid)).filter((x) => x.kind === "show_announced")).toHaveLength(0);
    const ev = (await adb.doc(`events/${ev2}`).get()).data() as EventDoc;
    await callFn("updateEvent", { curatorProfileId: second.curator.profileId, eventId: ev2,
      title: ev.title, description: ev.description, startsAt: ev.startsAt, endsAt: ev.endsAt,
      lineup: [{ kind: "external", name: "Opener" }, { kind: "booking", bookingId: second.bookingId, musicianProfileId: second.musician.profileId, name: "Headliner" }],
    }, second.curator.owner.user);
    const after = (await notes(secondFan.uid)).filter((x) => x.kind === "show_announced");
    expect(after).toHaveLength(1); expect(after[0].id).toBe(`announce:${ev2}`);
    // The first event's venue follower got nothing new from the second event.
    expect((await notes(venueFan.uid)).filter((x) => x.id === `announce:${ev2}`)).toHaveLength(0);
  });

  it("a reschedule reaches followers and ticket holders and re-arms the reminder", async () => {
    const { curator, eventId } = await makePublishedBookingEvent("fa3");
    const fan = await makeFan("fa3f"); const holder = await makeFan("fa3h");
    await callFn("followTarget", { targetId: curator.profileId, targetType: "curator" }, fan.user);
    await buyFreeTicket(eventId, await tierIdByName(eventId, "General"), holder.user);
    await adb.doc(`events/${eventId}`).update({ reminderSentAt: Date.now() });
    const ev = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    const newStart = ev.startsAt + 3 * 24 * 3600 * 1000;
    await callFn("updateEvent", { curatorProfileId: curator.profileId, eventId,
      title: ev.title, description: ev.description, startsAt: newStart, endsAt: newStart + 3 * 3600 * 1000, lineup: ev.lineup,
    }, curator.owner.user);
    for (const u of [fan, holder]) {
      const r = (await notes(u.uid)).filter((x) => x.kind === "show_rescheduled");
      expect(r).toHaveLength(1); expect(r[0].id).toBe(`resched:${eventId}:${newStart}`);
    }
    expect(((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).reminderSentAt).toBeUndefined();
  });
});

describe("new music fan-out", () => {
  it("notifies an artist's followers when a track is approved", async () => {
    const { musician } = await makeFilledGig("nm1");
    const fan = await makeFan("nm1f");
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    await adb.doc(`profiles/${musician.profileId}/tracks/pending1`).set({
      title: "Second Song", status: "pending_review", uploaderUid: musician.owner.uid, startSec: 0, durationSec: 20,
      storagePath: `review/tracks/${musician.profileId}/pending1.m4a`, rejectionReason: null, failureReason: null, order: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    // The review clip must exist in the storage emulator for approve's copy
    // to succeed. storage.rules denies a client write to review/, so this
    // writes the object directly via the Admin SDK bucket, matching how
    // tracks.test.ts gets a review clip in place.
    const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
    const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");
    await abucket.file(`review/tracks/${musician.profileId}/pending1.m4a`)
      .save(Buffer.from(makeWav(1)), { contentType: "audio/mp4" });
    const admin2 = await makeAdminUser("nm1a");
    await callFn("reviewTrack", { profileId: musician.profileId, trackId: "pending1", decision: "approved" }, admin2.user);
    const n = (await notes(fan.uid)).filter((x) => x.kind === "new_music");
    expect(n).toHaveLength(1); expect(n[0].id).toBe("track:pending1"); expect(n[0].refId).toBe(musician.profileId);
  });
});

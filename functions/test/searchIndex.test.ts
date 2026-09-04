import { describe, it, expect, vi } from "vitest";
import { adb, makeApprovedMusicianProfile, makeApprovedCuratorProfile, makePublishedBookingEvent, waitForIndex } from "./discoverFixtures";
import { dayKeyInLaunchZone, type EventDoc, type ProfileDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const DAY = 24 * 60 * 60 * 1000;

function openGig(curatorProfileId: string, startsAt: number) {
  return {
    curatorProfileId, seriesId: null, detachedFromTemplate: false, title: "Rooftop Set", description: "",
    wants: { genres: ["jazz"], actSizes: ["solo"] }, budget: { minCents: 10_000, maxCents: 30_000, structure: "perSet" },
    startsAt, durationMinutes: 60, provisions: [],
    location: { venueName: "Mohawk", neighborhood: "Red River", city: "Austin", geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "neighborhood", address: null },
    status: "open", createdAt: Date.now(), updatedAt: Date.now(), bookingId: null, bookedMusicianProfileId: null,
  };
}

describe("searchIndex maintainers", () => {
  it("indexes an approved musician with audio, then drops it on rejection", async () => {
    const m = await makeApprovedMusicianProfile("si1");
    const d = await waitForIndex(`artist_${m.profileId}`, (x) => x?.hasAudio === true);
    expect(d).toMatchObject({ kind: "artist", sourceId: m.profileId, title: "The Act", genres: ["rock"], hasAudio: true, actSize: null, followerCount: 0 });
    expect(d!.words).toEqual(expect.arrayContaining(["the", "act"]));
    expect(d!.tokens).toEqual(expect.arrayContaining(["th", "the", "ac", "act"]));
    expect(d!.relatedProfileIds).toEqual([m.profileId]);
    expect(d!.imagePath).toBe("public/photos/seed/avatar-seed.jpg");
    await adb.doc(`profiles/${m.profileId}/tracks/seed-track`).update({ status: "rejected" });
    expect((await waitForIndex(`artist_${m.profileId}`, (x) => x?.hasAudio === false))?.hasAudio).toBe(false);
    await adb.doc(`profiles/${m.profileId}`).update({ status: "rejected" });
    expect(await waitForIndex(`artist_${m.profileId}`, (x) => x === undefined)).toBeUndefined();
  });

  it("indexes an approved curator as a venue with the genres it books", async () => {
    const c = await makeApprovedCuratorProfile("si2");
    const profile = (await adb.doc(`profiles/${c.profileId}`).get()).data() as ProfileDoc;
    const d = await waitForIndex(`venue_${c.profileId}`, (x) => x !== undefined);
    expect(d).toMatchObject({ kind: "venue", sourceId: c.profileId, handle: profile.handle, title: profile.name });
    expect(d!.genres).toEqual(profile.curator?.lookingFor?.genres ?? []);
    expect(d!.city).toBe(profile.curator?.location?.city ?? null);
  });

  it("indexes a published show, marks the lineup artist busy, and clears both on cancel", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("si3");
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    const show = await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    expect(show).toMatchObject({ kind: "show", sourceId: eventId, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, hasFreeTier: true, priceFromCents: 0 });
    expect(show!.relatedProfileIds).toEqual(expect.arrayContaining([event.curatorProfileId, musician.profileId]));
    expect(show!.words).toEqual(expect.arrayContaining(["the", "act"]));
    const day = dayKeyInLaunchZone(event.startsAt);
    const artist = await waitForIndex(`artist_${musician.profileId}`, (x) => x?.busyDays.includes(day) === true);
    expect(artist!.busyDays).toContain(day);
    await adb.doc(`events/${eventId}`).update({ status: "cancelled", cancelledAt: Date.now() });
    expect(await waitForIndex(`show_${eventId}`, (x) => x === undefined)).toBeUndefined();
    // Cancelling the public show listing does not, by itself, release the
    // musician's underlying confirmed booking (verified against events.ts's
    // cancelEventCore, which never touches bookings): a confirmed booking is
    // a separate commitment from any event built around it, exactly as the
    // gig-booking test below establishes (a confirmed booking alone marks an
    // artist busy, with no event involved at all). Releasing that booking
    // here is what should clear the day, mirroring that same trigger path.
    const confirmed = await adb.collection("bookings")
      .where("musicianProfileId", "==", musician.profileId).where("status", "==", "confirmed").get();
    await Promise.all(confirmed.docs.map((d) => d.ref.update({ status: "cancelled_by_curator", updatedAt: Date.now() })));
    const artistAfter = await waitForIndex(`artist_${musician.profileId}`, (x) => x?.busyDays.includes(day) === false);
    expect(artistAfter!.busyDays).not.toContain(day);
  });

  it("indexes an open gig, drops it when filled, and marks a confirmed booking's artist busy", async () => {
    const c = await makeApprovedCuratorProfile("si4");
    const m = await makeApprovedMusicianProfile("si4m");
    const startsAt = Date.now() + 3 * DAY;
    const gigRef = await adb.collection("gigs").add(openGig(c.profileId, startsAt));
    const gig = await waitForIndex(`gig_${gigRef.id}`, (x) => x !== undefined);
    expect(gig).toMatchObject({ kind: "gig", title: "Rooftop Set", subtitle: "Mohawk, Red River", genres: ["jazz"], budgetMinCents: 10_000, budgetMaxCents: 30_000, startsAt, city: "Austin" });
    expect(gig!.words).toEqual(expect.arrayContaining(["rooftop", "set", "mohawk", "red", "river", "austin"]));
    const bookingRef = await adb.collection("bookings").add({
      gigId: gigRef.id, musicianProfileId: m.profileId, curatorProfileId: c.profileId, status: "confirmed",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const day = dayKeyInLaunchZone(startsAt);
    expect((await waitForIndex(`artist_${m.profileId}`, (x) => x?.busyDays.includes(day) === true))!.busyDays).toContain(day);
    await bookingRef.update({ status: "cancelled_by_curator", updatedAt: Date.now() });
    expect((await waitForIndex(`artist_${m.profileId}`, (x) => x?.busyDays.includes(day) === false))!.busyDays).not.toContain(day);
    await gigRef.update({ status: "filled", updatedAt: Date.now() });
    expect(await waitForIndex(`gig_${gigRef.id}`, (x) => x === undefined)).toBeUndefined();
  });

  it("reads act size and home city onto the artist doc", async () => {
    const m = await makeApprovedMusicianProfile("si5");
    await adb.doc(`profiles/${m.profileId}/private/booking`).set({
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: { gigTypes: [], travelRadiusKm: null, actSize: "band", typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null },
      updatedAt: Date.now(),
    });
    await adb.doc(`profiles/${m.profileId}`).update({ "portfolio.location": { city: "Austin", geo: { lat: 30.2, lng: -97.7 }, geocodedFrom: "Austin" }, updatedAt: Date.now() });
    const d = await waitForIndex(`artist_${m.profileId}`, (x) => x?.actSize === "band" && x?.cityLower === "austin");
    expect(d).toMatchObject({ actSize: "band", city: "Austin", cityLower: "austin", geo: { lat: 30.2, lng: -97.7 } });
  });
});

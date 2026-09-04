import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import {
  adb, makeFan, makeApprovedMusicianProfile, makeApprovedCuratorProfile,
  makeFilledGig, eventContent, addTiersAndPublish,
} from "./discoverFixtures";
import type { GetDiscoverDeckResult, ProfileDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const deck = (user: import("firebase/auth").User, data: Record<string, unknown> = {}) =>
  callFn<Record<string, unknown>, GetDiscoverDeckResult>("getDiscoverDeck", data, user);

describe("getDiscoverDeck", () => {
  it("requires auth and validates input", async () => {
    await expect(deck(undefined as never)).rejects.toMatchObject({ code: "functions/unauthenticated" });
    const fan = await makeFan("dk0");
    await expect(deck(fan.user, { location: { lat: 200, lng: 0 } })).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(deck(fan.user, { location: null })).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(deck(fan.user, { excludeIds: new Array(201).fill("x") })).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("returns show, artist, and venue cards with previews, excludes followed targets, and pages by excludeIds", async () => {
    // The emulator database accumulates events, artists, and venues from every other test
    // file in the full suite run (no per-file clear), and a page is only 20 cards, so this
    // fixture's ids are not guaranteed to rank into page one on genre/soonness/randomness
    // alone. Steer the ranking deterministically instead: give the fixture's act and venue a
    // genre ("worship") no other fixture in this suite uses, and have the fan follow that
    // genre before the first deck call. followedGenres overlap is worth 3 points on top of at
    // most 2 for soonness and under 1 for randomness, so every unmatched candidate tops out
    // around 2.6 while these three candidates start at 3.5, guaranteeing all three place.
    const { curator, musician, bookingId } = await makeFilledGig("dk1");
    await adb.doc(`profiles/${musician.profileId}`).update({ "portfolio.genres": ["worship"] });
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: curator.profileId, source: { kind: "standalone" },
      ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
    }, curator.owner.user);
    await addTiersAndPublish(curator.profileId, eventId, curator.owner.user, [
      { name: "GA", priceCents: 1200, capacity: 10, saleStartsAt: null, saleEndsAt: null },
    ]);
    // discover.ts's venue query (exactly per the brief) has no orderBy, so on the shared,
    // never-cleared corpus this test's venue also needs the id-lottery fix explained on the
    // venue-ordering test below: re-home the curator profile under a low document id (with the
    // member doc copied, so later curator-authenticated calls on it would still authorize) and
    // repoint the already-created event at it, admin-side, after createEvent's own booking/
    // membership checks have already run against the original id.
    const curatorId = `00000000000-dk1c-${Date.now()}`;
    const curatorData = (await adb.doc(`profiles/${curator.profileId}`).get()).data() as ProfileDoc;
    await adb.doc(`profiles/${curatorId}`).set({
      ...curatorData,
      curator: { ...curatorData.curator!, lookingFor: { ...curatorData.curator!.lookingFor, genres: ["worship"] } },
    });
    await adb.doc(`profiles/${curatorId}/members/${curator.owner.uid}`)
      .set({ uid: curator.owner.uid, role: "admin", label: "owner", joinedAt: Date.now() });
    await adb.doc(`events/${eventId}`).update({ curatorProfileId: curatorId });

    const fan = await makeFan("dk1f");
    await callFn("followTarget", { targetId: "genre:worship", targetType: "genre" }, fan.user);
    const first = await deck(fan.user, { seed: 5 });
    expect(first.seed).toBe(5);
    const show = first.cards.find((c) => c.kind === "show" && c.id === eventId);
    expect(show).toBeDefined();
    if (show?.kind === "show") {
      expect(show.preview?.trackPath).toBe("public/tracks/seed/demo.m4a");
      expect(show.priceFromCents).toBe(1200); expect(show.hasFreeTier).toBe(false);
      expect(show.curatorHandle).toBeTruthy(); expect(show.lineupNames).toEqual(["The Act"]);
      expect(show.distanceMeters).toBeNull();
    }
    const artist = first.cards.find((c) => c.kind === "artist" && c.id === musician.profileId);
    expect(artist).toBeDefined();
    if (artist?.kind === "artist") {
      expect(artist.preview?.trackPath).toBe("public/tracks/seed/demo.m4a");
      expect(artist.nextShow?.eventId).toBe(eventId);
    }
    const venue = first.cards.find((c) => c.kind === "venue" && c.id === curatorId);
    expect(venue).toBeDefined();
    if (venue?.kind === "venue") { expect(venue.preview?.artistName).toBe("The Act"); expect(venue.nextShow?.eventId).toBe(eventId); }

    // Following the artist and venue removes their cards but keeps the show.
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    await callFn("followTarget", { targetId: curatorId, targetType: "curator" }, fan.user);
    const second = await deck(fan.user, { seed: 5 });
    expect(second.cards.some((c) => c.kind === "artist" && c.id === musician.profileId)).toBe(false);
    expect(second.cards.some((c) => c.kind === "venue" && c.id === curatorId)).toBe(false);
    expect(second.cards.some((c) => c.kind === "show" && c.id === eventId)).toBe(true);

    const third = await deck(fan.user, { seed: 5, excludeIds: [eventId] });
    expect(third.cards.some((c) => c.id === eventId)).toBe(false);
  });

  it("orders nearer venues first when a location is given and reports distances", async () => {
    // discover.ts's venue query has no orderBy of its own signal (it now orders by
    // updatedAt desc, matching the artist query, so a fresh write always sorts first, but the
    // page-one RANKING still competes against the full suite's shared, never-cleared corpus).
    // Re-home each profile under a document id that starts with a long run of "0" (sorts
    // before any Firestore auto-id) so the query is guaranteed to include both, and tag both
    // with a genre ("worship") no other fixture in this suite uses, with the fan following it,
    // to steer the ranking too.
    //
    // Score ceilings differ between the two, though: near scores genre(3) + soon(0.5, no next
    // show) + dist(1.5, distance ~0) + rand[0,1) = [5, 6), which no ambient candidate near the
    // fan's location can reach (an unmatched show can score at most soon(2) + dist(1.5) +
    // rand[0,1), under 4.5), so near is deterministically on page one. far scores genre(3) +
    // soon(0.5) + dist(0, beyond the ranker's 20 km falloff) + rand[0,1) = [3.5, 4.5), which
    // DOES overlap an unmatched-but-soon-and-nearby show's range, so far is not guaranteed to
    // land on page one; if it does not, look for it on page two (excludeIds = page one's ids,
    // same seed) instead of requiring both on the same page.
    const near = await makeApprovedCuratorProfile("dk2n", "venue");
    const far = await makeApprovedCuratorProfile("dk2f", "venue");
    const nearId = `00000000000-dk2n-${Date.now()}`;
    const farId = `00000000001-dk2f-${Date.now()}`;
    const nearData = (await adb.doc(`profiles/${near.profileId}`).get()).data() as ProfileDoc;
    const farData = (await adb.doc(`profiles/${far.profileId}`).get()).data() as ProfileDoc;
    await adb.doc(`profiles/${nearId}`).set({
      ...nearData,
      curator: { ...nearData.curator!, lookingFor: { ...nearData.curator!.lookingFor, genres: ["worship"] } },
    });
    await adb.doc(`profiles/${farId}`).set({
      ...farData,
      curator: {
        ...farData.curator!, lookingFor: { ...farData.curator!.lookingFor, genres: ["worship"] },
        location: { ...farData.curator!.location, geo: { lat: 30.47, lng: -97.74 } },
      },
    });
    const fan = await makeFan("dk2fan");
    await callFn("followTarget", { targetId: "genre:worship", targetType: "genre" }, fan.user);
    const loc = { lat: 30.27, lng: -97.74 };
    const page1 = await deck(fan.user, { seed: 1, location: loc });
    const nearCard = page1.cards.find((c) => c.kind === "venue" && c.id === nearId);
    expect(nearCard).toBeDefined();
    let farCard = page1.cards.find((c) => c.kind === "venue" && c.id === farId);
    const farOnPageOne = farCard !== undefined;
    if (!farCard) {
      const page2 = await deck(fan.user, { seed: 1, location: loc, excludeIds: page1.cards.map((c) => c.id) });
      farCard = page2.cards.find((c) => c.kind === "venue" && c.id === farId);
    }
    expect(farCard).toBeDefined();
    if (nearCard?.kind === "venue") expect(nearCard.distanceMeters).toBeLessThan(100);
    if (farCard?.kind === "venue") expect(farCard.distanceMeters).toBeGreaterThan(20_000);
    if (farOnPageOne && nearCard && farCard) {
      expect(page1.cards.indexOf(nearCard)).toBeLessThan(page1.cards.indexOf(farCard));
    }
  });

  // Fix round 2 (item 4): the deck reads EVERY published event in its window,
  // so one malformed event used to throw INTERNAL for every caller, not just
  // for the page it landed on. Written straight through the Admin SDK, which
  // is exactly how a hand-seeded fixture (or an older client) can produce one.
  it("a published in-window event missing its lineup and genre arrays does not break the deck", async () => {
    const now = Date.now();
    const eventId = `dk4-halfshaped-${now}`;
    const startsAt = now + 3 * 86_400_000; // inside DECK_WINDOW_MS
    await adb.doc(`events/${eventId}`).set({
      curatorProfileId: "dk4-curator", title: "Half shaped", description: "",
      location: { venueName: "Nowhere", neighborhood: null, city: "Austin", addressVisibility: "neighborhood", address: null },
      startsAt, endsAt: startsAt + 3 * 3_600_000, status: "published",
      createdAt: now, updatedAt: now,
    });
    try {
      const fan = await makeFan("dk4f");
      const res = await deck(fan.user, { seed: 7 });
      expect(Array.isArray(res.cards)).toBe(true);
      // With a location too: the distance helper reads location.geo, which
      // this event does not have either.
      const located = await deck(fan.user, { seed: 7, location: { lat: 30.27, lng: -97.74 } });
      expect(Array.isArray(located.cards)).toBe(true);
    } finally {
      await adb.doc(`events/${eventId}`).delete();
    }
  });

  it("interleaves kinds and caps at the page size", async () => {
    for (let i = 0; i < 4; i++) await makeApprovedMusicianProfile(`dk3m${i}`);
    const fan = await makeFan("dk3f");
    const res = await deck(fan.user, { seed: 3 });
    expect(res.cards.length).toBeLessThanOrEqual(20);
    for (let i = 2; i < res.cards.length; i++) {
      expect(res.cards[i].kind === res.cards[i - 1].kind && res.cards[i].kind === res.cards[i - 2].kind).toBe(false);
    }
  });
});

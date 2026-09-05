import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import {
  adb, makeApprovedCuratorProfile, makeApprovedMusicianProfile, makeDraftEvent,
  addTiersAndPublish, eventContent, waitForIndex, makePublishedBookingEvent,
} from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import type { EventDoc, EventAct, NotificationDoc, GetDiscoverDeckResult } from "@gatekeep/shared";
import type { User } from "firebase/auth";
vi.setConfig({ testTimeout: 60_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const taggedAct = async (eventId: string, musicianProfileId: string) =>
  (await event(eventId)).lineup.find(
    (a): a is Extract<EventAct, { kind: "tagged" }> => a.kind === "tagged" && a.musicianProfileId === musicianProfileId);
const notes = async (uid: string, kind: string) =>
  (await adb.collection(`users/${uid}/notifications`).where("kind", "==", kind).get()).docs
    .map((d) => d.data() as NotificationDoc);

// The deck is a ranked page of at most 20 cards over the emulator's shared,
// never-cleared corpus, so a caller steers the ranking (follow a genre no
// other fixture uses) and this pages once with page one's ids excluded before
// giving up, the same fallback discover.test.ts's venue-distance case uses.
const deck = (user: User, data: Record<string, unknown>) =>
  callFn<Record<string, unknown>, GetDiscoverDeckResult>("getDiscoverDeck", data, user);
async function findShowCard(user: User, eventId: string) {
  const page1 = await deck(user, { seed: 11 });
  const hit = page1.cards.find((c) => c.kind === "show" && c.id === eventId);
  if (hit) return hit;
  const page2 = await deck(user, { seed: 11, excludeIds: page1.cards.map((c) => c.id) });
  return page2.cards.find((c) => c.kind === "show" && c.id === eventId);
}

describe("tagEventArtist", () => {
  it("tags on a draft silently, notifies once on publish, and the artist accepts", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at1");
    const artist = await makeApprovedMusicianProfile("at1m");
    // A genre no other fixture in this suite uses. It is both what the
    // accepted tag is expected to contribute to the event's own genre
    // projection (the curator set none) and how the deck read at the end of
    // this test is steered onto page one.
    await adb.doc(`profiles/${artist.profileId}`).update({ "portfolio.genres": ["classical"] });

    const { actIndex } = await callFn<Record<string, unknown>, { actIndex: number }>(
      "tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    expect(actIndex).toBe(1);
    const tagged = await taggedAct(eventId, artist.profileId);
    expect(tagged).toMatchObject({
      kind: "tagged", musicianProfileId: artist.profileId, name: "The Act", status: "pending", respondedAt: null,
    });
    const taggedAt = tagged!.taggedAt;
    // A draft tag is silent, and the pending act is not in the projection.
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(0);
    expect((await event(eventId)).lineupMusicianProfileIds).not.toContain(artist.profileId);

    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const sent = await notes(artist.owner.uid, "artist_tag");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "You were tagged on a lineup", refId: eventId });
    expect(sent[0].body).toContain("tagged you on");
    // The dedupe key is keyed on THIS tag's own taggedAt (fix round 1,
    // Important 3): a re-tag after an untag mints a new taggedAt and so a
    // fresh key, rather than replaying an already-spent one.
    expect((await adb.doc(`users/${artist.owner.uid}/notifications/artist_tag:${eventId}:${artist.profileId}:${taggedAt}`).get()).exists).toBe(true);

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const accepted = await event(eventId);
    expect(accepted.lineupMusicianProfileIds).toContain(artist.profileId);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({ status: "accepted" });
    expect((await taggedAct(eventId, artist.profileId))!.respondedAt).toBeTypeOf("number");
    // An accepted tag contributes its portfolio genres to the event's genre
    // projection, exactly as a booking act does; this curator set none.
    expect(accepted.genres).toContain("classical");
    // The accepted act reaches the search index through the event trigger.
    const indexed = await waitForIndex(`show_${eventId}`, (d) => !!d?.relatedProfileIds.includes(artist.profileId));
    expect(indexed?.relatedProfileIds).toContain(artist.profileId);

    // The deck resolves a lineupMusicianProfileIds entry back to the act it
    // came from for the preview's artist name. An accepted tagged act has to
    // resolve there like a booking act, or the card reads as nameless audio.
    const fan = await signUpTestUser(`at1f-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: "genre:classical", targetType: "genre" }, fan.user);
    const card = await findShowCard(fan.user, eventId);
    expect(card).toBeDefined();
    if (card?.kind === "show") expect(card.preview?.artistName).toBe("The Act");

    // A second publish attempt cannot double-send announce or the tag note.
    await expect(callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(1);
    await expect(callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "This tag has already been answered." });
  });

  it("tags a published event immediately, and accept announces to that artist's followers once", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at2");
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const artist = await makeApprovedMusicianProfile("at2m");
    const fan = await signUpTestUser(`at2f-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: artist.profileId, targetType: "musician" }, fan.user);

    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(1);
    expect(await notes(fan.uid, "show_announced")).toHaveLength(0);

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const announced = await notes(fan.uid, "show_announced");
    expect(announced).toHaveLength(1);
    expect(announced[0].refId).toBe(eventId);
    expect((await adb.doc(`users/${fan.uid}/notifications/announce:${eventId}`).get()).exists).toBe(true);
  });

  it("declines, untags, and refuses non-admins, unapproved artists, duplicates, and the cap", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at3");
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const artist = await makeApprovedMusicianProfile("at3m");
    const stranger = await signUpTestUser(`at3s-${Date.now()}@test.com`);

    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    const draftArtist = await makeApprovedCuratorProfile("at3c", "venue");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: draftArtist.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Only approved artists can be tagged." });

    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "That artist is already on the lineup." });

    await expect(callFn("respondToArtistTag",
      { eventId, musicianProfileId: artist.profileId, accept: true }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: false }, artist.owner.user);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({ status: "declined" });
    expect((await event(eventId)).lineupMusicianProfileIds).not.toContain(artist.profileId);

    // Untag turns the act into a plain external name and drops the id.
    const second = await makeApprovedMusicianProfile("at3n");
    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    await callFn("respondToArtistTag", { eventId, musicianProfileId: second.profileId, accept: true }, second.owner.user);
    expect((await event(eventId)).lineupMusicianProfileIds).toContain(second.profileId);
    expect((await event(eventId)).genres).toContain("rock");
    await callFn("untagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    const untagged = await event(eventId);
    expect(untagged.lineupMusicianProfileIds).not.toContain(second.profileId);
    expect(untagged.lineup.some((a) => a.kind === "external" && a.name === "The Act")).toBe(true);
    // The genre the accepted tag contributed goes with it.
    expect(untagged.genres).not.toContain("rock");

    // Re-tagging the SAME artist converts that external act back rather than
    // appending a duplicate row (fix round 1, Important 3), and notifies
    // again under a fresh (new taggedAt) dedupe key.
    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    const retagged = await event(eventId);
    expect(retagged.lineup).toHaveLength(3);
    expect(retagged.lineup.some((a) => a.kind === "external" && a.name === "The Act")).toBe(false);
    expect(await notes(second.owner.uid, "artist_tag")).toHaveLength(2);

    // The 20-act cap is the same one validateEventInput enforces.
    await adb.doc(`events/${eventId}`).update({
      lineup: Array.from({ length: 20 }, (_, i) => ({ kind: "external", name: `Filler ${i}` })),
    });
    const third = await makeApprovedMusicianProfile("at3t");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: third.profileId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("lets a tagged artist post only after accepting, and a co-admin answer counts", async () => {
    const { musician, eventId } = await makePublishedTaggedEvent("at4");
    await expect(callFn("createShowPost",
      { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const coAdmin = await addMember(musician.profileId, "at4a", "admin");
    await callFn("respondToArtistTag", { eventId, musicianProfileId: musician.profileId, accept: true }, coAdmin.user);
    const { postId } = await callFn<Record<string, unknown>, { postId: string }>(
      "createShowPost", { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user);
    expect(postId).toBeTypeOf("string");
  });

  it("keeps a stored tag's status when the curator resaves the lineup, and refuses an invented one", async () => {
    const { curator, musician, eventId } = await makePublishedTaggedEvent("at5");
    await callFn("respondToArtistTag", { eventId, musicianProfileId: musician.profileId, accept: true }, musician.owner.user);
    const stored = await event(eventId);
    const forged = stored.lineup.map((a) => a.kind === "tagged"
      ? { ...a, status: "accepted", name: "Renamed", taggedAt: 1, respondedAt: 1 } : a);
    await callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: forged,
    }, curator.owner.user);
    // Name, taggedAt, respondedAt and status all come from the server copy.
    expect(await taggedAct(eventId, musician.profileId)).toMatchObject({ name: "The Act", taggedAt: stored.lineup.find((a) => a.kind === "tagged")!.taggedAt });

    const other = await makeApprovedMusicianProfile("at5o");
    await expect(callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: [...stored.lineup, {
        kind: "tagged", musicianProfileId: other.profileId, name: "Sneaky",
        status: "accepted", taggedAt: Date.now(), respondedAt: Date.now(),
      }],
    }, curator.owner.user)).rejects.toMatchObject({
      code: "functions/invalid-argument", message: "Tag artists from the lineup editor.",
    });

    // Dropping the act from the payload removes it and its projection id.
    await callFn("updateEvent", {
      curatorProfileId: curator.profileId, eventId,
      title: stored.title, description: stored.description, startsAt: stored.startsAt, endsAt: stored.endsAt,
      lineup: stored.lineup.filter((a) => a.kind !== "tagged"),
    }, curator.owner.user);
    const after = await event(eventId);
    expect(after.lineupMusicianProfileIds).not.toContain(musician.profileId);
    expect(after.lineup.some((a) => a.kind === "tagged")).toBe(false);
  });

  it("refuses tagEventArtist and untagEventArtist for a curator profile that does not own the event", async () => {
    const { eventId } = await makeDraftEvent("at6");
    const other = await makeApprovedCuratorProfile("at6b", "venue");
    const artist = await makeApprovedMusicianProfile("at6m");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: other.profileId, eventId, musicianProfileId: artist.profileId }, other.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("untagEventArtist",
      { curatorProfileId: other.profileId, eventId, musicianProfileId: artist.profileId }, other.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("refuses untagEventArtist for a non-admin member of the curator profile", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at7");
    const artist = await makeApprovedMusicianProfile("at7m");
    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    const member = await addMember(profileId, "at7b", "member");
    await expect(callFn("untagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, member.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("refuses tagging an artist already on the bill as a booking act", async () => {
    const { curator, musician, eventId } = await makePublishedBookingEvent("at8");
    await expect(callFn("tagEventArtist",
      { curatorProfileId: curator.profileId, eventId, musicianProfileId: musician.profileId }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "That artist is already on the lineup." });
  });

  it("dedupes the accept-time announce: a venue follower already told at publish hears nothing new, an artist-only follower hears once", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at9");
    const venueFan = await signUpTestUser(`at9vf-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: profileId, targetType: "curator" }, venueFan.user);
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    expect(await notes(venueFan.uid, "show_announced")).toHaveLength(1);

    const artist = await makeApprovedMusicianProfile("at9m");
    const artistFan = await signUpTestUser(`at9af-${Date.now()}@test.com`);
    await callFn("followTarget", { targetId: artist.profileId, targetType: "musician" }, artistFan.user);

    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);

    expect(await notes(venueFan.uid, "show_announced")).toHaveLength(1);
    expect(await notes(artistFan.uid, "show_announced")).toHaveLength(1);
  });

  it("refuses respondToArtistTag once the event is cancelled", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at10");
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const artist = await makeApprovedMusicianProfile("at10m");
    await callFn("tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await callFn("cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    await expect(callFn("respondToArtistTag",
      { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: "This event is no longer accepting lineup changes.",
      });
  });
});

// Local to this file only because it composes exported fixtures; if a later
// task needs it, move it to discoverFixtures.ts rather than importing here.
async function makePublishedTaggedEvent(prefix: string) {
  const curator = await makeApprovedCuratorProfile(prefix, "venue");
  const created = await callFn<Record<string, unknown>, { eventId: string }>("createEvent",
    { curatorProfileId: curator.profileId, source: { kind: "standalone" }, ...eventContent() }, curator.owner.user);
  await addTiersAndPublish(curator.profileId, created.eventId, curator.owner.user, FREE_TIER);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await callFn("tagEventArtist",
    { curatorProfileId: curator.profileId, eventId: created.eventId, musicianProfileId: musician.profileId },
    curator.owner.user);
  return { curator, musician, eventId: created.eventId };
}

import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import {
  adb, makeApprovedCuratorProfile, makeApprovedMusicianProfile, makeDraftEvent,
  addTiersAndPublish, eventContent, waitForIndex,
} from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import type { EventDoc, EventAct, NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const taggedAct = async (eventId: string, musicianProfileId: string) =>
  (await event(eventId)).lineup.find(
    (a): a is Extract<EventAct, { kind: "tagged" }> => a.kind === "tagged" && a.musicianProfileId === musicianProfileId);
const notes = async (uid: string, kind: string) =>
  (await adb.collection(`users/${uid}/notifications`).where("kind", "==", kind).get()).docs
    .map((d) => d.data() as NotificationDoc);

describe("tagEventArtist", () => {
  it("tags on a draft silently, notifies once on publish, and the artist accepts", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("at1");
    const artist = await makeApprovedMusicianProfile("at1m");

    const { actIndex } = await callFn<Record<string, unknown>, { actIndex: number }>(
      "tagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    expect(actIndex).toBe(1);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({
      kind: "tagged", musicianProfileId: artist.profileId, name: "The Act", status: "pending", respondedAt: null,
    });
    // A draft tag is silent, and the pending act is not in the projection.
    expect(await notes(artist.owner.uid, "artist_tag")).toHaveLength(0);
    expect((await event(eventId)).lineupMusicianProfileIds).not.toContain(artist.profileId);

    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);
    const sent = await notes(artist.owner.uid, "artist_tag");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "You were tagged on a lineup", refId: eventId });
    expect(sent[0].body).toContain("tagged you on");
    expect((await adb.doc(`users/${artist.owner.uid}/notifications/artist_tag:${eventId}:${artist.profileId}`).get()).exists).toBe(true);

    await callFn("respondToArtistTag", { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const accepted = await event(eventId);
    expect(accepted.lineupMusicianProfileIds).toContain(artist.profileId);
    expect(await taggedAct(eventId, artist.profileId)).toMatchObject({ status: "accepted" });
    expect((await taggedAct(eventId, artist.profileId))!.respondedAt).toBeTypeOf("number");
    // The accepted act reaches the search index through the event trigger.
    const indexed = await waitForIndex(`show_${eventId}`, (d) => !!d?.relatedProfileIds.includes(artist.profileId));
    expect(indexed?.relatedProfileIds).toContain(artist.profileId);
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
    await callFn("untagEventArtist", { curatorProfileId: profileId, eventId, musicianProfileId: second.profileId }, owner.user);
    const untagged = await event(eventId);
    expect(untagged.lineupMusicianProfileIds).not.toContain(second.profileId);
    expect(untagged.lineup.some((a) => a.kind === "external" && a.name === "The Act")).toBe(true);

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
    const { curator, musician, eventId } = await makePublishedTaggedEvent("at4");
    await expect(callFn("createShowPost",
      { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const coAdmin = await addMember(musician.profileId, "at4a", "admin");
    await callFn("respondToArtistTag", { eventId, musicianProfileId: musician.profileId, accept: true }, coAdmin.user);
    const { postId } = await callFn<Record<string, unknown>, { postId: string }>(
      "createShowPost", { eventId, musicianProfileId: musician.profileId, text: "Doors soon" }, musician.owner.user);
    expect(postId).toBeTypeOf("string");
    expect(curator.profileId).toBeTypeOf("string");
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

import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { StubGeocoder } from "../src/geocode.js";
import { type ProfileDraftInput, type EventDoc, type GigDoc } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const stub = new StubGeocoder();
// Chain-heavy fixtures (profile x2 + review x2, some also a full booking
// chain), same rationale/budget as gigs.test.ts's identical setConfig.
vi.setConfig({ testTimeout: 20_000 });

const SEED_ADDRESS = "123 Main St, Austin, TX"; // matches helpers.ts's seedCuratorGateContent

async function makeApprovedCuratorProfile(
  emailPrefix: string, subtype: "venue" | "planner" | "individual_host" = "venue",
) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype, name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz", description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] }, durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides,
  };
}

// The "least ceremony" path to a filled gig, mirroring gigs.test.ts's
// "cancel the booking instead" fixture (createGig, publishGig, applyToGig,
// acceptBooking). This file's subject is events built ON TOP of a filled
// gig, not booking negotiation mechanics, so this stays single-offer-accept
// only, same as that precedent.
async function makeFilledGig(prefix: string) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`, "venue");
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(
    { owner: curator.owner, profileId: curator.profileId },
    { owner: musician.owner, profileId: musician.profileId });
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId: curator.profileId, ...gigContent() }, curator.owner.user);
  await callFn("publishGig", { gigId }, curator.owner.user);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId, musicianProfileId: musician.profileId, offer: { amountCents: 15000, note: "Looking forward to it!" } },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

function eventContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = Date.now() + 7 * 24 * 3600 * 1000;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * 3600 * 1000,
    lineup: [{ kind: "external", name: "The Quartet" }],
    ...overrides,
  };
}

async function makeDraftEvent(prefix: string) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix, "venue");
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user);
  return { owner, profileId, eventId };
}

async function addTiers(
  profileId: string, eventId: string, user: import("firebase/auth").User,
  tiers: Record<string, unknown>[],
): Promise<void> {
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId, tiers }, user);
}

describe("createEvent", () => {
  it("creates a standalone draft event: doc shape + private address doc", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ce1", "venue");
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("draft");
    expect(event.curatorProfileId).toBe(profileId);
    expect(event.gigId).toBeNull();
    expect(event.posterPath).toBeNull();
    expect(event.maxTicketsPerBuyer).toBe(8);
    expect(event.lineup).toEqual([{ kind: "external", name: "The Quartet" }]);
    expect(event.lineupMusicianProfileIds).toEqual([]);
    expect(event.cancelledAt).toBeUndefined();
    expect(event.completedAt).toBeUndefined();

    // Venue subtype defaults to the profile's own address, public visibility,
    // same convention as createGig (see gigs.test.ts's identical assertion).
    const expected = await stub.geocode(SEED_ADDRESS);
    expect(event.location.venueName).toBe("The Green Room");
    expect(event.location.addressVisibility).toBe("public");
    expect(event.location.address).toBe(SEED_ADDRESS);
    expect(event.location.geo).toEqual({ lat: expected.lat, lng: expected.lng });

    const priv = (await adb.doc(`events/${eventId}/private/address`).get()).data();
    expect(priv?.address).toBe(SEED_ADDRESS);
    expect(priv?.geo).toEqual({ lat: expected.lat, lng: expected.lng });
  });

  it("creates an event from a filled gig: location + gigId copied verbatim, no re-geocode", async () => {
    const { curator, gigId } = await makeFilledGig("ce2");
    const gigDoc = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const gigPriv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();

    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent",
      { curatorProfileId: curator.profileId, source: { kind: "gig", gigId }, ...eventContent() },
      curator.owner.user);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.gigId).toBe(gigId);
    expect(event.location).toEqual(gigDoc.location);

    const priv = (await adb.doc(`events/${eventId}/private/address`).get()).data();
    expect(priv?.address).toBe(gigPriv?.address);
    expect(priv?.geo).toEqual(gigPriv?.geo);
  });

  it("derives lineupMusicianProfileIds from booking-kind lineup acts, deduplicated", async () => {
    const { curator, musician, gigId, bookingId } = await makeFilledGig("ce3");
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent",
      {
        curatorProfileId: curator.profileId, source: { kind: "gig", gigId },
        ...eventContent({
          lineup: [
            { kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" },
            { kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act (encore)" },
            { kind: "external", name: "DJ Opener" },
          ],
        }),
      },
      curator.owner.user);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.lineupMusicianProfileIds).toEqual([musician.profileId]);
  });

  it("rejects a non-member with permission-denied", async () => {
    const { profileId } = await makeApprovedCuratorProfile("ce4", "venue");
    const { user: stranger } = await signUpTestUser(`ce4b-${Date.now()}@test.com`);
    await expect(callFn(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, stranger,
    )).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects an unapproved curator profile with failed-precondition", async () => {
    const owner = await signUpTestUser(`ce5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Unapproved Room", handle: `ce5_${Date.now()}` },
      owner.user);
    await expect(callFn(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user,
    )).rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects promoting a gig that isn't filled", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ce6", "venue");
    const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
      "createGig", { profileId, ...gigContent() }, owner.user);
    await callFn("publishGig", { gigId }, owner.user);

    await expect(callFn(
      "createEvent", { curatorProfileId: profileId, source: { kind: "gig", gigId }, ...eventContent() }, owner.user,
    )).rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a gig that belongs to a different curator profile", async () => {
    const { gigId } = await makeFilledGig("ce7a");
    const { owner: ownerB, profileId: profileB } = await makeApprovedCuratorProfile("ce7b", "venue");
    await expect(callFn(
      "createEvent", { curatorProfileId: profileB, source: { kind: "gig", gigId }, ...eventContent() }, ownerB.user,
    )).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects a posterPath that doesn't belong to this curator profile", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ce8", "venue");
    await expect(callFn("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" },
      posterPath: "public/photos/someone-else-profile/poster-xyz", ...eventContent(),
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("accepts a posterPath that belongs to this curator profile", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ce9", "venue");
    const posterPath = `public/photos/${profileId}/poster-abc123`;
    const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
      curatorProfileId: profileId, source: { kind: "standalone" }, posterPath, ...eventContent(),
    }, owner.user);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.posterPath).toBe(posterPath);
  });
});

describe("setEventTiers", () => {
  it("upserts named tiers", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("st1");
    await addTiers(profileId, eventId, owner.user, [
      { name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null },
      { name: "VIP", priceCents: 5000, capacity: 20, saleStartsAt: null, saleEndsAt: null },
    ]);
    const snap = await adb.collection(`events/${eventId}/tiers`).orderBy("sortOrder").get();
    expect(snap.docs.map((d) => d.data().name)).toEqual(["General", "VIP"]);
    expect(snap.docs.every((d) => d.data().soldCount === 0)).toBe(true);
    expect(snap.docs.map((d) => d.data().sortOrder)).toEqual([0, 1]);
  });

  it("deletes an omitted tier while draft", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("st2");
    await addTiers(profileId, eventId, owner.user, [
      { name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null },
      { name: "VIP", priceCents: 5000, capacity: 20, saleStartsAt: null, saleEndsAt: null },
    ]);
    const first = await adb.collection(`events/${eventId}/tiers`).get();
    const generalId = first.docs.find((d) => d.data().name === "General")!.id;

    await addTiers(profileId, eventId, owner.user,
      [{ tierId: generalId, name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null }]);

    const second = await adb.collection(`events/${eventId}/tiers`).get();
    expect(second.docs).toHaveLength(1);
    expect(second.docs[0].data().name).toBe("General");
  });

  it("rejects deleting a tier after publish; both tiers untouched", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("st3");
    await addTiers(profileId, eventId, owner.user, [
      { name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null },
      { name: "VIP", priceCents: 5000, capacity: 20, saleStartsAt: null, saleEndsAt: null },
    ]);
    await callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user);
    const before = await adb.collection(`events/${eventId}/tiers`).get();
    const vip = before.docs.find((d) => d.data().name === "VIP")!;

    await expect(callFn("setEventTiers", {
      curatorProfileId: profileId, eventId,
      tiers: [{ tierId: vip.id, name: "VIP", priceCents: 5000, capacity: 20, saleStartsAt: null, saleEndsAt: null }],
    }, owner.user)).rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = await adb.collection(`events/${eventId}/tiers`).get();
    expect(after.docs).toHaveLength(2);
  });

  it("rejects a capacity decrease below the already-sold count", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("st4");
    await addTiers(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null }]);
    const tiersSnap = await adb.collection(`events/${eventId}/tiers`).get();
    const generalId = tiersSnap.docs[0].id;
    await adb.doc(`events/${eventId}/tiers/${generalId}`).update({ soldCount: 40 });

    await expect(callFn("setEventTiers", {
      curatorProfileId: profileId, eventId,
      tiers: [{ tierId: generalId, name: "General", priceCents: 2500, capacity: 30, saleStartsAt: null, saleEndsAt: null }],
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });

    const after = (await adb.doc(`events/${eventId}/tiers/${generalId}`).get()).data();
    expect(after?.capacity).toBe(100); // untouched
  });

  it("allows capacity increases and new tiers after publish", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("st5");
    await addTiers(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null }]);
    await callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user);
    const tiersSnap = await adb.collection(`events/${eventId}/tiers`).get();
    const generalId = tiersSnap.docs[0].id;

    await addTiers(profileId, eventId, owner.user, [
      { tierId: generalId, name: "General", priceCents: 2500, capacity: 150, saleStartsAt: null, saleEndsAt: null },
      { name: "VIP", priceCents: 5000, capacity: 20, saleStartsAt: null, saleEndsAt: null },
    ]);

    const after = await adb.collection(`events/${eventId}/tiers`).get();
    expect(after.docs).toHaveLength(2);
    expect(after.docs.find((d) => d.id === generalId)!.data().capacity).toBe(150);
  });
});

describe("publishEvent", () => {
  it("rejects publishing with no tiers", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pe1");
    await expect(callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("flips status to published", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("pe2");
    await addTiers(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null }]);
    await callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("published");
  });
});

describe("updateEvent", () => {
  it("rejects updating a cancelled event", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ue1");
    // cancelEventCore isn't wired to a callable in this task (Task 6 ships
    // the real cancelEvent); flip status directly via the admin SDK.
    await adb.doc(`events/${eventId}`).update({ status: "cancelled", cancelledAt: Date.now(), updatedAt: Date.now() });

    await expect(callFn(
      "updateEvent",
      { curatorProfileId: profileId, eventId, ...eventContent({ title: "New title" }) },
      owner.user,
    )).rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("re-validates content and applies edits while draft", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ue2");
    await callFn(
      "updateEvent",
      { curatorProfileId: profileId, eventId, ...eventContent({ title: "Updated Title" }) },
      owner.user);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.title).toBe("Updated Title");

    // Bad content still gets re-validated on update (title too long).
    await expect(callFn(
      "updateEvent",
      { curatorProfileId: profileId, eventId, ...eventContent({ title: "x".repeat(200) }) },
      owner.user,
    )).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { StubGeocoder, coarsen } from "../src/geocode.js";
import {
  MAX_ACTIVE_SERIES_PER_PROFILE, type ProfileDraftInput, type GigSeriesDoc, type GigDoc,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const stub = new StubGeocoder();
vi.setConfig({ testTimeout: 15_000 });

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

// Full series content payload (everything createSeries/updateSeries need
// besides profileId/seriesId and an optional location override).
function seriesContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    fillMode: "per_occurrence",
    ...overrides,
  };
}

async function createSeries(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { seriesId } = await callFn<Record<string, unknown>, { seriesId: string }>(
    "createSeries", { profileId, ...seriesContent(overrides) }, user);
  return seriesId;
}

// Admin-SDK shortcut for seeding a materialized occurrence gig doc attached
// to a series — Task 7's materializer doesn't exist yet, so tests exercising
// updateSeries'/endSeries' occurrence-sweep behavior seed the occurrences
// directly, matching gigs.test.ts's takedownGig series-scope fixture style.
async function seedOccurrence(
  seriesId: string, curatorProfileId: string, overrides: Partial<GigDoc> = {},
): Promise<string> {
  const ref = adb.collection("gigs").doc();
  const now = Date.now();
  const doc: GigDoc = {
    curatorProfileId, seriesId, detachedFromTemplate: false,
    title: "Seeded occurrence", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
    budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
    startsAt: now + 7 * 24 * 3600 * 1000, durationMinutes: 60,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    location: {
      venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
      geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: SEED_ADDRESS,
    },
    status: "open", createdAt: now, updatedAt: now,
    bookingId: null, bookedMusicianProfileId: null,
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

describe("createSeries", () => {
  it("venue subtype defaults to the profile's address, public visibility; template stores both the public and exact private location", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs1", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    const expected = await stub.geocode(SEED_ADDRESS);
    expect(series.status).toBe("active");
    expect(series.materializedThrough).toBe(0);
    expect(series.curatorProfileId).toBe(profileId);
    expect(series.fillMode).toBe("per_occurrence");
    expect(series.template.location.addressVisibility).toBe("public");
    expect(series.template.location.address).toBe(SEED_ADDRESS);
    expect(series.template.location.venueName).toBe("The Green Room");
    expect(series.template.location.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
    expect(series.templatePrivateLocation.address).toBe(SEED_ADDRESS);
    expect(series.templatePrivateLocation.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("planner subtype requires an address input; defaults neighborhood visibility with coarsened public geo, exact private location", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs2", "planner");
    const address = "456 Oak Ave, Denver, CO";
    const seriesId = await createSeries(profileId, owner.user, { location: { address } });
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    const expected = await stub.geocode(address);
    expect(series.template.location.addressVisibility).toBe("neighborhood");
    expect(series.template.location.address).toBeNull();
    expect(series.template.location.geo).toEqual(coarsen(expected!));
    expect(series.templatePrivateLocation.address).toBe(address);
    expect(series.templatePrivateLocation.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("rejects a planner/individual_host series with no address input", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs3", "individual_host");
    await expect(callFn("createSeries", { profileId, ...seriesContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects a non-member with permission-denied", async () => {
    const { profileId } = await makeApprovedCuratorProfile("cs4", "venue");
    const { user: stranger } = await signUpTestUser(`cs4b-${Date.now()}@test.com`);
    await expect(callFn("createSeries", { profileId, ...seriesContent() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects a member of an unapproved (pending) curator profile with failed-precondition", async () => {
    const owner = await signUpTestUser(`cs5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Pending Venue", handle: `cs5_${Date.now()}` },
      owner.user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    await expect(callFn("createSeries", { profileId, ...seriesContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects an invalid budget (min > max) with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs6", "venue");
    await expect(callFn("createSeries", {
      profileId, ...seriesContent({ budget: { minCents: 5000, maxCents: 1000, structure: "perHour" } }),
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects an invalid recurrence (weekday out of range) with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs7", "venue");
    await expect(callFn("createSeries", {
      profileId, ...seriesContent({ recurrence: { weekday: 7, hour: 20, minute: 0, cadence: "weekly", endDate: null } }),
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects an invalid fillMode with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs8", "venue");
    await expect(callFn("createSeries", { profileId, ...seriesContent({ fillMode: "bogus" }) }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("enforces MAX_ACTIVE_SERIES_PER_PROFILE with resource-exhausted", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cs9", "venue");
    const seedLocation = {
      venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
      geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: SEED_ADDRESS,
    };
    const batch = adb.batch();
    for (let i = 0; i < MAX_ACTIVE_SERIES_PER_PROFILE; i++) {
      const ref = adb.collection("gigSeries").doc();
      const doc: GigSeriesDoc = {
        curatorProfileId: profileId,
        recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
        fillMode: "per_occurrence",
        template: {
          title: `Seed series ${i}`, description: "", wants: { genres: ["rock"], actSizes: ["band"] },
          budget: { minCents: 1000, maxCents: 2000, structure: "perHour" }, durationMinutes: 60,
          provisions: { hasPA: null, hasBackline: null, notes: null },
          location: seedLocation as GigDoc["location"],
        },
        templatePrivateLocation: { address: SEED_ADDRESS, geo: { lat: 30.27, lng: -97.74 } },
        status: "active", materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
        activeBookingId: null, bookedMusicianProfileId: null,
      };
      batch.set(ref, doc);
    }
    await batch.commit();
    await expect(callFn("createSeries", { profileId, ...seriesContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("updateSeries", () => {
  it("member updates the template's content fields", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us1", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Saturday Blues Night" }) }, owner.user);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.template.title).toBe("Saturday Blues Night");
  });

  it("propagates a template edit to a future, non-detached occurrence", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us2", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const occId = await seedOccurrence(seriesId, profileId);
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Propagated Title" }) }, owner.user);
    const occ = (await adb.doc(`gigs/${occId}`).get()).data();
    expect(occ?.title).toBe("Propagated Title");
  });

  it("propagates an address change to a future, non-detached occurrence's PUBLIC location AND its PRIVATE location subdoc", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us2b", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const occId = await seedOccurrence(seriesId, profileId);
    // Simulate Task 7's materializer having already written this
    // occurrence's private location subdoc (mirrors createGig's own write) —
    // the propagation sweep must overwrite it, not merely leave it stale.
    await adb.doc(`gigs/${occId}/private/location`).set({
      address: SEED_ADDRESS, geo: { lat: 30.27, lng: -97.74 },
    });
    const newAddress = "789 Elm St, Marfa, TX";
    await callFn("updateSeries", { seriesId, ...seriesContent({ location: { address: newAddress } }) }, owner.user);
    const expected = await stub.geocode(newAddress);
    const occPub = (await adb.doc(`gigs/${occId}`).get()).data();
    expect(occPub?.location.address).toBe(newAddress);
    expect(occPub?.location.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
    const occPriv = (await adb.doc(`gigs/${occId}/private/location`).get()).data();
    expect(occPriv?.address).toBe(newAddress);
    expect(occPriv?.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("does NOT propagate to a DETACHED future occurrence", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us3", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const occId = await seedOccurrence(seriesId, profileId, { detachedFromTemplate: true, title: "Detached original" });
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Propagated Title" }) }, owner.user);
    const occ = (await adb.doc(`gigs/${occId}`).get()).data();
    expect(occ?.title).toBe("Detached original");
  });

  it("does NOT propagate to a PAST occurrence (startsAt already elapsed)", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us4", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const occId = await seedOccurrence(seriesId, profileId, {
      startsAt: Date.now() - 3600_000, title: "Past original",
    });
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Propagated Title" }) }, owner.user);
    const occ = (await adb.doc(`gigs/${occId}`).get()).data();
    expect(occ?.title).toBe("Past original");
  });

  it("does NOT propagate to an occurrence belonging to a DIFFERENT series", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us5", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const otherSeriesId = await createSeries(profileId, owner.user, { title: "Other series" });
    const occId = await seedOccurrence(otherSeriesId, profileId, { title: "Unrelated original" });
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Propagated Title" }) }, owner.user);
    const occ = (await adb.doc(`gigs/${occId}`).get()).data();
    expect(occ?.title).toBe("Unrelated original");
  });

  it("a recurrence edit updates the series doc but does not touch already-materialized occurrences' startsAt", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us6", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const occId = await seedOccurrence(seriesId, profileId);
    const originalStartsAt = (await adb.doc(`gigs/${occId}`).get()).data()?.startsAt;
    await callFn("updateSeries", {
      seriesId, ...seriesContent({ recurrence: { weekday: 2, hour: 10, minute: 30, cadence: "monthly", endDate: null } }),
    }, owner.user);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.recurrence).toEqual({ weekday: 2, hour: 10, minute: 30, cadence: "monthly", endDate: null });
    const occ = (await adb.doc(`gigs/${occId}`).get()).data();
    // recurrence math never re-touches an already-materialized occurrence —
    // only its content fields propagate (covered by the tests above).
    expect(occ?.startsAt).toBe(originalStartsAt);
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us7", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`us7b-${Date.now()}@test.com`);
    await expect(callFn("updateSeries", { seriesId, ...seriesContent() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects editing an ended series with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us8", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("endSeries", { seriesId }, owner.user);
    await expect(callFn("updateSeries", { seriesId, ...seriesContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a bogus series id with not-found", async () => {
    const { owner } = await makeApprovedCuratorProfile("us9", "venue");
    await expect(callFn("updateSeries", { seriesId: "does-not-exist", ...seriesContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });

  it("P3: rejects editing a series once the profile has been rejected/unpublished, even for a still-member owner", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("us10", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const admin = await makeAdminUser("us10a");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, admin.user);
    await expect(callFn("updateSeries", { seriesId, ...seriesContent({ title: "Should not land" }) }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data();
    expect(series?.template.title).not.toBe("Should not land");
  });
});

describe("pauseSeries", () => {
  it("active -> paused", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ps1", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("pauseSeries", { seriesId }, owner.user);
    expect((await adb.doc(`gigSeries/${seriesId}`).get()).data()?.status).toBe("paused");
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ps2", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`ps2b-${Date.now()}@test.com`);
    await expect(callFn("pauseSeries", { seriesId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects pausing an already-paused series with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ps3", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("pauseSeries", { seriesId }, owner.user);
    await expect(callFn("pauseSeries", { seriesId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

describe("endSeries", () => {
  it("cancels future open|draft occurrences; leaves past and terminal-status occurrences untouched", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("es1", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const futureOpenId = await seedOccurrence(seriesId, profileId, { status: "open" });
    const futureDraftId = await seedOccurrence(seriesId, profileId, { status: "draft" });
    const futureCancelledId = await seedOccurrence(seriesId, profileId, { status: "cancelled" });
    const pastOpenId = await seedOccurrence(seriesId, profileId, { status: "open", startsAt: Date.now() - 3600_000 });

    await callFn("endSeries", { seriesId }, owner.user);

    expect((await adb.doc(`gigSeries/${seriesId}`).get()).data()?.status).toBe("ended");
    expect((await adb.doc(`gigs/${futureOpenId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`gigs/${futureDraftId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`gigs/${futureCancelledId}`).get()).data()?.status).toBe("cancelled"); // already was
    expect((await adb.doc(`gigs/${pastOpenId}`).get()).data()?.status).toBe("open"); // untouched — already elapsed
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("es2", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`es2b-${Date.now()}@test.com`);
    await expect(callFn("endSeries", { seriesId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects ending an already-ended series with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("es3", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("endSeries", { seriesId }, owner.user);
    await expect(callFn("endSeries", { seriesId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("end from a paused series also works", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("es4", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    await callFn("pauseSeries", { seriesId }, owner.user);
    await callFn("endSeries", { seriesId }, owner.user);
    expect((await adb.doc(`gigSeries/${seriesId}`).get()).data()?.status).toBe("ended");
  });
});

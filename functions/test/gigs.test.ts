import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { StubGeocoder, coarsen } from "../src/geocode.js";
import { MAX_OPEN_GIGS_PER_PROFILE, type ProfileDraftInput, type GigDoc } from "@gatekeep/shared";

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

// Full gig content payload (everything createGig/updateGig need besides
// profileId/gigId and an optional location override). A fresh startsAt each
// call avoids any accidental cross-test coupling on the value.
function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides,
  };
}

async function createDraftGig(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId, ...gigContent(overrides) }, user);
  return gigId;
}

describe("createGig", () => {
  it("venue subtype defaults to the profile's address, public visibility, exact geo; private doc matches", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg1", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const pub = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const expected = await stub.geocode(SEED_ADDRESS);
    expect(pub.status).toBe("draft");
    expect(pub.curatorProfileId).toBe(profileId);
    expect(pub.seriesId).toBeNull();
    expect(pub.detachedFromTemplate).toBe(false);
    expect(pub.location.addressVisibility).toBe("public");
    expect(pub.location.address).toBe(SEED_ADDRESS);
    expect(pub.location.venueName).toBe("The Green Room");
    expect(pub.location.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    expect(priv?.address).toBe(SEED_ADDRESS);
    expect(priv?.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("a venue can override its default address and visibility per gig", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg2", "venue");
    const offSite = "999 Off Site Rd, Marfa, TX";
    const gigId = await createDraftGig(profileId, owner.user,
      { location: { address: offSite, addressVisibility: "neighborhood" } });
    const pub = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    expect(pub.location.addressVisibility).toBe("neighborhood");
    expect(pub.location.address).toBeNull();
    const expected = await stub.geocode(offSite);
    expect(pub.location.geo).toEqual(coarsen(expected!));
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    expect(priv?.address).toBe(offSite);
  });

  it("planner subtype requires an address input; defaults neighborhood visibility with coarsened public geo, exact private doc", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg3", "planner");
    const address = "456 Oak Ave, Denver, CO";
    const gigId = await createDraftGig(profileId, owner.user, { location: { address } });
    const pub = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const expected = await stub.geocode(address);
    expect(pub.location.addressVisibility).toBe("neighborhood");
    expect(pub.location.address).toBeNull();
    expect(pub.location.venueName).toBeNull();
    expect(pub.location.geo).toEqual(coarsen(expected!));
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    expect(priv?.address).toBe(address);
    expect(priv?.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("rejects a planner/individual_host gig with no address input", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg4", "individual_host");
    await expect(callFn("createGig", { profileId, ...gigContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects a non-member with permission-denied", async () => {
    const { profileId } = await makeApprovedCuratorProfile("cg5", "venue");
    const { user: stranger } = await signUpTestUser(`cg5b-${Date.now()}@test.com`);
    await expect(callFn("createGig", { profileId, ...gigContent() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects a member of an unapproved (pending) curator profile with failed-precondition", async () => {
    const owner = await signUpTestUser(`cg6-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Pending Venue", handle: `cg6_${Date.now()}` },
      owner.user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    await expect(callFn("createGig", { profileId, ...gigContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects an invalid budget (min > max) with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg7", "venue");
    await expect(callFn("createGig", {
      profileId, ...gigContent({ budget: { minCents: 5000, maxCents: 1000, structure: "perHour" } }),
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects invalid gig content (empty title) with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg8", "venue");
    await expect(callFn("createGig", { profileId, ...gigContent({ title: "" }) }, owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("publishGig", () => {
  it("draft -> open", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg1", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("publishGig", { gigId }, owner.user);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("open");
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg2", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`pg2b-${Date.now()}@test.com`);
    await expect(callFn("publishGig", { gigId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects publishing a gig that is already open", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg3", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("publishGig", { gigId }, owner.user);
    await expect(callFn("publishGig", { gigId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects publishing once the profile has been rejected/unpublished, even for a still-member owner", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg5", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const admin = await makeAdminUser("pg5a");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, admin.user);
    await expect(callFn("publishGig", { gigId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("P1: rejects publishing a gig whose date has already passed", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg6", "venue");
    const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
      "createGig", { profileId, ...gigContent({ startsAt: Date.now() - 3600_000 }) }, owner.user);
    await expect(callFn("publishGig", { gigId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("draft"); // unchanged
  });

  it("enforces MAX_OPEN_GIGS_PER_PROFILE with resource-exhausted", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("pg4", "venue");
    const seedLocation = {
      venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
      geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: SEED_ADDRESS,
    };
    const batch = adb.batch();
    for (let i = 0; i < MAX_OPEN_GIGS_PER_PROFILE; i++) {
      const ref = adb.collection("gigs").doc();
      const doc: GigDoc = {
        curatorProfileId: profileId, seriesId: null, detachedFromTemplate: false,
        title: `Seed gig ${i}`, description: "", wants: { genres: ["rock"], actSizes: ["band"] },
        budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
        startsAt: Date.now(), durationMinutes: 60,
        provisions: { hasPA: null, hasBackline: null, notes: null },
        location: seedLocation as GigDoc["location"],
        status: "open", createdAt: Date.now(), updatedAt: Date.now(),
        bookingId: null, bookedMusicianProfileId: null,
      };
      batch.set(ref, doc);
    }
    await batch.commit();
    const gigId = await createDraftGig(profileId, owner.user);
    await expect(callFn("publishGig", { gigId }, owner.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("updateGig", () => {
  it("member updates content fields", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug1", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("updateGig", { gigId, ...gigContent({ title: "Saturday Blues Night" }) }, owner.user);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.title).toBe("Saturday Blues Night");
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug2", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`ug2b-${Date.now()}@test.com`);
    await expect(callFn("updateGig", { gigId, ...gigContent() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("visibility flip public -> neighborhood re-coarsens the geo and strips the public address; private doc stays exact", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug3", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const before = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    expect(before.location.addressVisibility).toBe("public");

    await callFn("updateGig", { gigId, ...gigContent(), location: { addressVisibility: "neighborhood" } }, owner.user);

    const after = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const expected = await stub.geocode(SEED_ADDRESS);
    expect(after.location.addressVisibility).toBe("neighborhood");
    expect(after.location.address).toBeNull();
    expect(after.location.geo).toEqual(coarsen(expected!));
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    expect(priv?.address).toBe(SEED_ADDRESS);
    expect(priv?.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
  });

  it("visibility flip neighborhood -> public reveals the existing private address without a fresh geocode", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug4", "planner");
    const address = "789 Elm St, Boise, ID";
    const gigId = await createDraftGig(profileId, owner.user, { location: { address } });
    const before = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    expect(before.location.addressVisibility).toBe("neighborhood");

    await callFn("updateGig", { gigId, ...gigContent(), location: { addressVisibility: "public" } }, owner.user);

    const after = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    expect(after.location.addressVisibility).toBe("public");
    expect(after.location.address).toBe(address);
    expect(after.location.geo).toEqual(priv?.geo);
  });

  it("re-geocodes on an address change", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug5", "planner");
    const original = "1 First St, Reno, NV";
    const gigId = await createDraftGig(profileId, owner.user,
      { location: { address: original, addressVisibility: "public" } });
    const changed = "2 Second St, Reno, NV";

    await callFn("updateGig", { gigId, ...gigContent(), location: { address: changed } }, owner.user);

    const after = (await adb.doc(`gigs/${gigId}`).get()).data() as GigDoc;
    const priv = (await adb.doc(`gigs/${gigId}/private/location`).get()).data();
    const expected = await stub.geocode(changed);
    expect(priv?.address).toBe(changed);
    expect(priv?.geo).toEqual({ lat: expected!.lat, lng: expected!.lng });
    expect(after.location.address).toBe(changed);
  });

  it("sets detachedFromTemplate true when the gig has a seriesId", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug6", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await adb.doc(`gigs/${gigId}`).update({ seriesId: "fake-series-id" });
    await callFn("updateGig", { gigId, ...gigContent() }, owner.user);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.detachedFromTemplate).toBe(true);
  });

  it("rejects editing a cancelled gig with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug7", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("cancelGig", { gigId }, owner.user);
    await expect(callFn("updateGig", { gigId, ...gigContent() }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects an invalid budget with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug8", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await expect(callFn("updateGig", {
      gigId, ...gigContent({ budget: { minCents: 5, maxCents: 1, structure: "perHour" } }),
    }, owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects editing a still-open gig once the profile has been rejected/unpublished", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug9", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("publishGig", { gigId }, owner.user); // now "open" — world-readable
    const admin = await makeAdminUser("ug9a");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, admin.user);
    await expect(callFn("updateGig", { gigId, ...gigContent({ title: "Should not land" }) }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.title).not.toBe("Should not land");
  });

  it("S2: re-submitting the SAME address does not consume the caller's daily geocode budget again", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ug10", "planner");
    const address = `1 Repeat St, Reno-${Date.now()}, NV`;
    const gigId = await createDraftGig(profileId, owner.user, { location: { address } });
    const afterCreate = (await adb.doc(`geocodeBudgets/${owner.uid}`).get()).data();
    expect(afterCreate?.count).toBe(1); // createGig always geocodes (no prior private location)

    await callFn("updateGig", { gigId, ...gigContent(), location: { address } }, owner.user);
    const afterUpdate = (await adb.doc(`geocodeBudgets/${owner.uid}`).get()).data();
    expect(afterUpdate?.count).toBe(1); // unchanged — the re-submitted address was skipped
  });
});

describe("createGig geocoder throttle (S2)", () => {
  it("rejects with resource-exhausted once the caller's daily geocode budget is already at the ceiling", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cg9", "planner");
    const dateKey = new Date().toISOString().slice(0, 10);
    await adb.doc(`geocodeBudgets/${owner.uid}`).set({ date: dateKey, count: 50 });
    await expect(callFn("createGig",
      { profileId, ...gigContent({ location: { address: `999 Over Budget Rd, Marfa-${Date.now()}, TX` } }) }, owner.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("cancelGig", () => {
  it("draft -> cancelled", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cn1", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("cancelGig", { gigId }, owner.user);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("cancelled");
  });

  it("open -> cancelled", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cn2", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("publishGig", { gigId }, owner.user);
    await callFn("cancelGig", { gigId }, owner.user);
    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("cancelled");
  });

  it("rejects a non-member with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cn3", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const { user: stranger } = await signUpTestUser(`cn3b-${Date.now()}@test.com`);
    await expect(callFn("cancelGig", { gigId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects cancelling an already-cancelled gig with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("cn4", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("cancelGig", { gigId }, owner.user);
    await expect(callFn("cancelGig", { gigId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

describe("takedownGig", () => {
  it("rejects non-admin callers with permission-denied", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td1", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await expect(callFn("takedownGig", { gigId, scope: "occurrence", reason: "Complaint." }, owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("occurrence scope: taken_down + audit gig_taken_down (reason+scope in detail) + curator notified with the reason", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td2", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    await callFn("publishGig", { gigId }, owner.user);
    const admin = await makeAdminUser("td2a");

    await callFn("takedownGig", { gigId, scope: "occurrence", reason: "Reported as a scam listing." }, admin.user);

    expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("taken_down");
    const audit = await adb.collection("auditLogs")
      .where("targetId", "==", gigId).where("action", "==", "gig_taken_down").get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data().actorUid).toBe(admin.uid);
    expect(audit.docs[0].data().detail).toContain("occurrence");
    expect(audit.docs[0].data().detail).toContain("Reported as a scam listing.");
    const notifs = await adb.collection(`users/${owner.uid}/notifications`).where("kind", "==", "gig_moderation").get();
    expect(notifs.docs.some((d) =>
      /taken down/i.test(d.data().title as string) && /Reported as a scam listing\./.test(d.data().body as string),
    )).toBe(true);
  });

  it("series scope: takes down the occurrence, pauses the series, sweeps other OPEN siblings only", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td3", "venue");
    const seriesRef = adb.collection("gigSeries").doc();
    await seriesRef.set({
      curatorProfileId: profileId,
      recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
      fillMode: "per_occurrence", template: {},
      status: "active", materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const rootId = await createDraftGig(profileId, owner.user);
    await adb.doc(`gigs/${rootId}`).update({ seriesId: seriesRef.id });
    await callFn("publishGig", { gigId: rootId }, owner.user);

    const openSiblingId = await createDraftGig(profileId, owner.user);
    await adb.doc(`gigs/${openSiblingId}`).update({ seriesId: seriesRef.id });
    await callFn("publishGig", { gigId: openSiblingId }, owner.user);

    const draftSiblingId = await createDraftGig(profileId, owner.user);
    await adb.doc(`gigs/${draftSiblingId}`).update({ seriesId: seriesRef.id }); // left in draft

    const otherOpenGigId = await createDraftGig(profileId, owner.user); // seriesId stays null
    await callFn("publishGig", { gigId: otherOpenGigId }, owner.user);

    const admin = await makeAdminUser("td3a");
    await callFn("takedownGig", { gigId: rootId, scope: "series", reason: "Repeated noise complaints." }, admin.user);

    expect((await adb.doc(`gigs/${rootId}`).get()).data()?.status).toBe("taken_down");
    expect((await adb.doc(`gigs/${openSiblingId}`).get()).data()?.status).toBe("taken_down");
    expect((await adb.doc(`gigs/${draftSiblingId}`).get()).data()?.status).toBe("draft");
    expect((await adb.doc(`gigs/${otherOpenGigId}`).get()).data()?.status).toBe("open");
    expect((await seriesRef.get()).data()?.status).toBe("paused");
    const audit = await adb.collection("auditLogs")
      .where("targetId", "==", rootId).where("action", "==", "gig_taken_down").get();
    expect(audit.docs[0].data().detail).toContain("series");
  });

  it("rejects scope 'series' on a gig with no seriesId with failed-precondition", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td4", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const admin = await makeAdminUser("td4a");
    await expect(callFn("takedownGig", { gigId, scope: "series", reason: "x" }, admin.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects taking down a gig that is already taken_down", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td5", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const admin = await makeAdminUser("td5a");
    await callFn("takedownGig", { gigId, scope: "occurrence", reason: "x" }, admin.user);
    await expect(callFn("takedownGig", { gigId, scope: "occurrence", reason: "x" }, admin.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a missing/blank reason with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td6", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const admin = await makeAdminUser("td6a");
    await expect(callFn("takedownGig", { gigId, scope: "occurrence", reason: "   " }, admin.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects an invalid scope value with invalid-argument", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("td7", "venue");
    const gigId = await createDraftGig(profileId, owner.user);
    const admin = await makeAdminUser("td7a");
    await expect(callFn("takedownGig", { gigId, scope: "bogus", reason: "x" }, admin.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

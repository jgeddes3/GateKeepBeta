import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 15_000 });

async function makeCuratorProfile(
  user: import("firebase/auth").User,
  subtype: "venue" | "planner" | "individual_host" = "venue",
) {
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype, name: "Test Curator", handle: `cur_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    user);
  return profileId;
}

describe("createProfileDraft curator seed", () => {
  it("curator drafts start with an empty curator map", async () => {
    const { user } = await signUpTestUser(`cseed-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator).toEqual({
      about: "",
      lookingFor: { genres: [], actSizes: [], notes: null },
      amenities: { capacity: null, hasPA: null, hasBackline: null, indoorOutdoor: null, notes: null },
      advertisingInterest: false,
      location: { address: null, city: "", neighborhood: null, geo: null },
      photoPaths: [],
    });
  });

  it("musician drafts are unaffected — no curator field", async () => {
    const { user } = await signUpTestUser(`cseedm-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `cseedm_${Date.now()}` }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator).toBeUndefined();
  });
});

describe("updateCuratorProfile", () => {
  it("member updates about/lookingFor/amenities/advertisingInterest; non-member is rejected", async () => {
    const { user } = await signUpTestUser(`u1-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    await callFn("updateCuratorProfile", {
      profileId,
      about: "Great room for live music.",
      lookingFor: { genres: ["rock", "indie"], actSizes: ["band"], notes: "Weekend slots only" },
      amenities: {
        capacity: 200, hasPA: true, hasBackline: false, indoorOutdoor: "indoor", notes: "Load-in via back door",
      },
      advertisingInterest: true,
    }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator.about).toBe("Great room for live music.");
    expect(p.data()?.curator.lookingFor).toEqual({
      genres: ["rock", "indie"], actSizes: ["band"], notes: "Weekend slots only",
    });
    expect(p.data()?.curator.amenities).toEqual({
      capacity: 200, hasPA: true, hasBackline: false, indoorOutdoor: "indoor", notes: "Load-in via back door",
    });
    expect(p.data()?.curator.advertisingInterest).toBe(true);

    const { user: stranger } = await signUpTestUser(`u2-${Date.now()}@test.com`);
    await expect(callFn("updateCuratorProfile", { profileId, about: "hax" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects updates on a non-curator (musician) profile with failed-precondition", async () => {
    const { user } = await signUpTestUser(`u3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", { type: "musician", subtype: "solo", name: "Musician", handle: `mus_${Date.now()}` }, user);
    await expect(callFn("updateCuratorProfile", { profileId, about: "hax" }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects invalid lookingFor (empty genres) with invalid-argument", async () => {
    const { user } = await signUpTestUser(`u4-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    await expect(callFn("updateCuratorProfile",
      { profileId, lookingFor: { genres: [], actSizes: ["band"], notes: null } }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects a street address on a non-venue (planner) profile with invalid-argument", async () => {
    const { user } = await signUpTestUser(`u5-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "planner");
    await expect(callFn("updateCuratorProfile",
      { profileId, location: { address: "123 Main St", city: "Austin" } }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects a street address on an individual_host profile with invalid-argument", async () => {
    const { user } = await signUpTestUser(`u5b-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "individual_host");
    await expect(callFn("updateCuratorProfile",
      { profileId, location: { address: "456 Oak Ave", city: "Denver" } }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("geocodes a venue's full street address and stores address+city+neighborhood+geo", async () => {
    const { user } = await signUpTestUser(`u6-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "venue");
    await callFn("updateCuratorProfile",
      { profileId, location: { address: "123 Main St, Austin, TX", city: "Austin" } }, user);
    const loc = (await adb.doc(`profiles/${profileId}`).get()).data()?.curator.location;
    expect(loc.address).toBe("123 Main St, Austin, TX");
    expect(typeof loc.geo.lat).toBe("number");
    expect(typeof loc.geo.lng).toBe("number");
    expect(loc.city).toBeTruthy();
  });

  it("a venue with no address yet falls back to a city-level pin (address stays null)", async () => {
    const { user } = await signUpTestUser(`u6b-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "venue");
    await callFn("updateCuratorProfile", { profileId, location: { address: null, city: "Austin" } }, user);
    const loc = (await adb.doc(`profiles/${profileId}`).get()).data()?.curator.location;
    expect(loc.address).toBeNull();
    expect(loc.neighborhood).toBeNull();
    expect(typeof loc.geo.lat).toBe("number");
  });

  it("geocodes a planner/host's city alone: stores city-level geo with address and neighborhood null", async () => {
    const { user } = await signUpTestUser(`u7-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "planner");
    await callFn("updateCuratorProfile", { profileId, location: { address: null, city: "Austin" } }, user);
    const loc = (await adb.doc(`profiles/${profileId}`).get()).data()?.curator.location;
    expect(loc.address).toBeNull();
    expect(loc.neighborhood).toBeNull();
    expect(typeof loc.geo.lat).toBe("number");
    expect(typeof loc.geo.lng).toBe("number");
  });

  it("bumps updatedAt on a partial update and leaves untouched curator fields alone", async () => {
    const { user } = await signUpTestUser(`u8-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    await callFn("updateCuratorProfile", { profileId, about: "First." }, user);
    const before = (await adb.doc(`profiles/${profileId}`).get()).data();
    await callFn("updateCuratorProfile", { profileId, advertisingInterest: true }, user);
    const after = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(after?.curator.about).toBe("First."); // untouched by the second, unrelated update
    expect(after?.curator.advertisingInterest).toBe(true);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt);
  });

  it("rejects an empty update payload with invalid-argument", async () => {
    const { user } = await signUpTestUser(`u9-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    await expect(callFn("updateCuratorProfile", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("rejects unauthenticated calls", async () => {
    await expect(callFn("updateCuratorProfile", { profileId: "x", about: "hi" })).rejects.toThrow();
  });
});

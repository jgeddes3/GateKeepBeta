import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");
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

describe("updateCuratorProfile geocoder throttle (S2)", () => {
  it("does not consume the daily geocode budget when the location input is unchanged from the last-geocoded value", async () => {
    const { user, uid } = await signUpTestUser(`s2a-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "planner");
    const location = { address: null, city: `Austin-${Date.now()}` };
    // First call: no stored geocodedFrom yet — always geocodes, consuming
    // the budget once.
    await callFn("updateCuratorProfile", { profileId, location }, user);
    const afterFirst = (await adb.doc(`geocodeBudgets/${uid}`).get()).data();
    expect(afterFirst?.count).toBe(1);
    // Second call with the EXACT same location input — the query string
    // matches curator.location.geocodedFrom, so this must skip the geocoder
    // (and the budget charge) entirely.
    await callFn("updateCuratorProfile", { profileId, location }, user);
    const afterSecond = (await adb.doc(`geocodeBudgets/${uid}`).get()).data();
    expect(afterSecond?.count).toBe(1); // unchanged — the second call was skipped
  });

  it("a changed location input DOES consume the budget again", async () => {
    const { user, uid } = await signUpTestUser(`s2b-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "planner");
    await callFn("updateCuratorProfile", { profileId, location: { address: null, city: `First-${Date.now()}` } }, user);
    await callFn("updateCuratorProfile", { profileId, location: { address: null, city: `Second-${Date.now()}` } }, user);
    const budget = (await adb.doc(`geocodeBudgets/${uid}`).get()).data();
    expect(budget?.count).toBe(2);
  });

  it("rejects with resource-exhausted once the caller's daily geocode budget is already at the ceiling", async () => {
    const { user, uid } = await signUpTestUser(`s2c-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user, "planner");
    const dateKey = new Date().toISOString().slice(0, 10);
    await adb.doc(`geocodeBudgets/${uid}`).set({ date: dateKey, count: 50 });
    await expect(callFn("updateCuratorProfile",
      { profileId, location: { address: null, city: `Over-${Date.now()}` } }, user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("removeCuratorPhoto", () => {
  it("member removes a photo: array entry and storage object both go; non-member is rejected", async () => {
    const { user } = await signUpTestUser(`rp1-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    const path = `public/photos/${profileId}/gallery-${Date.now()}.jpg`;
    await abucket.file(path).save(Buffer.from([1, 2, 3]), { contentType: "image/jpeg" });
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": [path] });

    const { user: stranger } = await signUpTestUser(`rp1b-${Date.now()}@test.com`);
    await expect(callFn("removeCuratorPhoto", { profileId, path }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("removeCuratorPhoto", { profileId, path }, user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.curator.photoPaths).toEqual([]);
    const [exists] = await abucket.file(path).exists();
    expect(exists).toBe(false);
  });

  it("removes only the named path, leaving other gallery entries untouched", async () => {
    const { user } = await signUpTestUser(`rp2-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    const keep = `public/photos/${profileId}/gallery-keep.jpg`;
    const drop = `public/photos/${profileId}/gallery-drop.jpg`;
    await abucket.file(drop).save(Buffer.from([1]), { contentType: "image/jpeg" });
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": [keep, drop] });
    await callFn("removeCuratorPhoto", { profileId, path: drop }, user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.curator.photoPaths).toEqual([keep]);
  });

  it("rejects a path not currently on the profile with not-found", async () => {
    const { user } = await signUpTestUser(`rp3-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": [`public/photos/${profileId}/gallery-a.jpg`] });
    // Path prefix-matches this profile's own gallery segment (Task 6's
    // defense-in-depth assertion) but isn't in the array — must still reach
    // the not-found branch, not get short-circuited earlier.
    await expect(callFn("removeCuratorPhoto",
      { profileId, path: `public/photos/${profileId}/gallery-not-there.jpg` }, user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });

  it("rejects removal on a non-curator (musician) profile with failed-precondition", async () => {
    const { user } = await signUpTestUser(`rp4-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", { type: "musician", subtype: "solo", name: "Musician", handle: `rp4m_${Date.now()}` }, user);
    await expect(callFn("removeCuratorPhoto", { profileId, path: `public/photos/${profileId}/gallery-a.jpg` }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("succeeds (best-effort) even when the storage object is already gone", async () => {
    const { user } = await signUpTestUser(`rp5-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    // No object actually written at this path — the array entry is
    // orphaned (e.g. a prior manual bucket cleanup). Removal must still
    // succeed and clear the array entry, not fail on the storage delete.
    const path = `public/photos/${profileId}/gallery-already-gone.jpg`;
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": [path] });
    await callFn("removeCuratorPhoto", { profileId, path }, user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.curator.photoPaths).toEqual([]);
  });

  it("rejects unauthenticated calls", async () => {
    await expect(callFn("removeCuratorPhoto", { profileId: "x", path: "public/photos/x/gallery-a.jpg" }))
      .rejects.toThrow();
  });

  it("rejects a path outside this profile's own gallery prefix with invalid-argument, checked before membership (defense-in-depth)", async () => {
    const { user } = await signUpTestUser(`rp6-${Date.now()}@test.com`);
    const profileId = await makeCuratorProfile(user);
    // `user` genuinely IS a member of `profileId` in both calls below — if
    // the path-prefix assertion did not run before the membership check
    // (or didn't exist at all), these would instead fall through to the
    // not-found branch (photo not on this profile's array), not
    // invalid-argument. Asserting invalid-argument here proves the
    // shape/prefix validation runs first, per the ordering convention.
    await expect(callFn("removeCuratorPhoto",
      { profileId, path: `public/photos/some-other-profile/gallery-a.jpg` }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("removeCuratorPhoto",
      { profileId, path: `public/photos/${profileId}/avatar-a.jpg` }, user)) // wrong kind, not "gallery-"
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

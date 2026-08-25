import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 15_000 });

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

async function makeMusicianProfile(user: import("firebase/auth").User) {
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft", draft(`pf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`), user);
  return profileId;
}

describe("createProfileDraft portfolio seed", () => {
  it("musician drafts start with an empty portfolio map", async () => {
    const { user } = await signUpTestUser(`seed-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio).toEqual({
      bio: "", genres: [], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null,
    });
  });
});

describe("updatePortfolio", () => {
  it("member updates bio/genres/links; non-member is rejected", async () => {
    const { user } = await signUpTestUser(`up1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updatePortfolio", {
      profileId, bio: "Austin indie soul.", genres: ["soul", "indie"],
      externalLinks: [{ kind: "spotify", url: "https://open.spotify.com/artist/a1" }],
    }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio.bio).toBe("Austin indie soul.");
    expect(p.data()?.portfolio.genres).toEqual(["soul", "indie"]);
    expect(p.data()?.portfolio.externalLinks).toEqual([
      { kind: "spotify", url: "https://open.spotify.com/artist/a1" },
    ]);
    const { user: stranger } = await signUpTestUser(`up2-${Date.now()}@test.com`);
    await expect(callFn("updatePortfolio", { profileId, bio: "hax" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects invalid payloads with invalid-argument", async () => {
    const { user } = await signUpTestUser(`up3-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await expect(callFn("updatePortfolio", { profileId, bio: "x".repeat(2001) }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updatePortfolio", { profileId, genres: [] }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("updateBookingInfo", () => {
  const booking = (profileId: string) => ({
    profileId,
    rates: { perHour: { amountCents: 20000, note: null }, perSong: { amountCents: 2500, note: "requests" }, perSet: null },
    preferences: { gigTypes: ["wedding", "bar_club"], travelRadiusKm: 80, actSize: "band",
      typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends" },
  });
  it("member writes the private booking subdoc; stranger cannot", async () => {
    const { user } = await signUpTestUser(`bk1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updateBookingInfo", booking(profileId), user);
    const b = await adb.doc(`profiles/${profileId}/private/booking`).get();
    expect(b.data()?.rates.perHour.amountCents).toBe(20000);
    expect(b.data()?.rates.perSet).toBeNull();
    expect(b.data()?.preferences.gigTypes).toContain("wedding");
    const { user: stranger } = await signUpTestUser(`bk2-${Date.now()}@test.com`);
    await expect(callFn("updateBookingInfo", booking(profileId), stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("normalizes absent rates/preference fields to null on read-back", async () => {
    const { user } = await signUpTestUser(`bk4-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updateBookingInfo", {
      profileId,
      rates: {},
      preferences: { gigTypes: [] },
    }, user);
    const b = await adb.doc(`profiles/${profileId}/private/booking`).get();
    const data = b.data();
    expect(data).toMatchObject({
      rates: { perHour: null, perSong: null, perSet: null },
      preferences: {
        gigTypes: [], travelRadiusKm: null, actSize: null,
        typicalSetMinutes: null, bringsOwnPA: null, availabilityPattern: null,
      },
    });
    // Keys must be *present* with value null, not simply absent.
    expect(Object.prototype.hasOwnProperty.call(data?.rates, "perHour")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(data?.preferences, "actSize")).toBe(true);
  });
  it("rejects invalid rates", async () => {
    const { user } = await signUpTestUser(`bk3-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    const bad = booking(profileId);
    bad.rates.perHour = { amountCents: -5, note: null } as never;
    await expect(callFn("updateBookingInfo", bad, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

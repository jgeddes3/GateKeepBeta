import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, signUpUnverifiedTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore, FieldValue } from "firebase-admin/firestore";
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

const CURATORS_ONLY_VISIBILITY = {
  perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
} as const;

describe("updateBookingInfo", () => {
  const booking = (profileId: string) => ({
    profileId,
    rates: { perHour: { amountCents: 20000, note: null }, perSong: { amountCents: 2500, note: "requests" }, perSet: null },
    preferences: { gigTypes: ["wedding", "bar_club"], travelRadiusKm: 80, actSize: "band",
      typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends" },
    visibility: CURATORS_ONLY_VISIBILITY,
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
      visibility: CURATORS_ONLY_VISIBILITY,
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
  it("rejects invalid visibility (missing key, extra key, or an out-of-set value)", async () => {
    const { user } = await signUpTestUser(`bk6-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    const b = booking(profileId);
    const { preferences: _drop, ...missingKey } = CURATORS_ONLY_VISIBILITY as Record<string, unknown>;
    await expect(callFn("updateBookingInfo", { ...b, visibility: missingKey }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("updateBookingInfo", { ...b, visibility: { ...CURATORS_ONLY_VISIBILITY, extra: "x" } }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    // "public" is not a legal RateVisibility (rates are never public — spec decision 4).
    await expect(callFn("updateBookingInfo", { ...b, visibility: { ...CURATORS_ONLY_VISIBILITY, perHour: "public" } }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("updatePortfolio preserves fields not being updated", () => {
  it("preserves avatarPhotoPath, genres, and externalLinks when only bio is updated (the reason dotted keys exist)", async () => {
    const { user } = await signUpTestUser(`pp1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await adb.doc(`profiles/${profileId}`).update({
      "portfolio.avatarPhotoPath": "public/photos/p1/avatar-abc.jpg",
      "portfolio.genres": ["soul"],
      "portfolio.externalLinks": [{ kind: "website", url: "https://example.com" }],
    });
    await callFn("updatePortfolio", { profileId, bio: "Just a bio update." }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio.bio).toBe("Just a bio update.");
    expect(p.data()?.portfolio.avatarPhotoPath).toBe("public/photos/p1/avatar-abc.jpg");
    expect(p.data()?.portfolio.genres).toEqual(["soul"]);
    expect(p.data()?.portfolio.externalLinks).toEqual([{ kind: "website", url: "https://example.com" }]);
  });
});

describe("updatePortfolio backfills a legacy/partial portfolio map field-wise", () => {
  it("completes a map that only has avatarPhotoPath (media pipeline landed first) without clobbering it", async () => {
    const { user } = await signUpTestUser(`legacy1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    // Simulate a legacy profile: portfolio map removed entirely, then only
    // the media pipeline's avatarPhotoPath write landed — a partial map,
    // not simply a missing one.
    await adb.doc(`profiles/${profileId}`).update({ portfolio: FieldValue.delete() });
    await adb.doc(`profiles/${profileId}`).update({
      "portfolio.avatarPhotoPath": "public/photos/p1/avatar-legacy.jpg",
    });
    await callFn("updatePortfolio", { profileId, bio: "Legacy backfill test." }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio).toEqual({
      bio: "Legacy backfill test.",
      genres: [],
      externalLinks: [],
      avatarPhotoPath: "public/photos/p1/avatar-legacy.jpg", // preserved, not clobbered
      coverPhotoPath: null,
    });
  });
});

describe("updatePortfolio on a non-musician profile", () => {
  it("rejects a curator profile with failed-precondition", async () => {
    const { user } = await signUpTestUser(`cur1-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "The Venue", handle: `cur_${Date.now()}` },
      user);
    await expect(callFn("updatePortfolio", { profileId, bio: "hi" }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

describe("strips untrusted extra keys (defense against reference-stored injection)", () => {
  it("updatePortfolio keeps only {kind, url} on a link, trimmed, dropping any junk key", async () => {
    const { user } = await signUpTestUser(`junk1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updatePortfolio", {
      profileId,
      externalLinks: [{ kind: "spotify", url: "  https://open.spotify.com/artist/a1  ", junk: "X" } as never],
    }, user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.portfolio.externalLinks).toEqual([
      { kind: "spotify", url: "https://open.spotify.com/artist/a1" },
    ]);
  });
  it("updateBookingInfo keeps only {amountCents, note} on a rate, dropping any junk key", async () => {
    const { user } = await signUpTestUser(`junk2-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(user);
    await callFn("updateBookingInfo", {
      profileId,
      rates: { perHour: { amountCents: 5000, note: null, junk: "X" } as never, perSong: null, perSet: null },
      preferences: { gigTypes: [] },
      visibility: CURATORS_ONLY_VISIBILITY,
    }, user);
    const b = await adb.doc(`profiles/${profileId}/private/booking`).get();
    expect(b.data()?.rates.perHour).toEqual({ amountCents: 5000, note: null });
  });
});

describe("unverified-email member is rejected", () => {
  it("updatePortfolio and updateBookingInfo both reject with failed-precondition", async () => {
    const { user: owner } = await signUpTestUser(`unv1-${Date.now()}@test.com`);
    const profileId = await makeMusicianProfile(owner);
    // signUpUnverifiedTestUser leaves the account unverified — can't create a
    // profile itself (createProfileDraft gates on it), so a verified owner
    // creates the profile and the admin SDK seeds the membership directly.
    const { uid: memberUid, user: memberUser } = await signUpUnverifiedTestUser(`unv2-${Date.now()}@test.com`);
    await adb.doc(`profiles/${profileId}/members/${memberUid}`).set({
      uid: memberUid, role: "member", label: "x", joinedAt: Date.now(),
    });
    await expect(callFn("updatePortfolio", { profileId, bio: "hi" }, memberUser))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(callFn("updateBookingInfo", {
      profileId, rates: {}, preferences: { gigTypes: [] }, visibility: CURATORS_ONLY_VISIBILITY,
    }, memberUser)).rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

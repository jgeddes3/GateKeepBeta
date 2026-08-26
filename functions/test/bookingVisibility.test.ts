import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { rebuildBookingProjections } from "../src/bookingVisibility.js";
import type { ProfileDraftInput, BookingVisibility, RateVisibility } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 20_000 });

async function makeMusicianProfile(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "Test Musician", handle: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    user);
  return { user, uid, profileId };
}

const fullRates = () => ({
  perHour: { amountCents: 20000, note: null },
  perSong: { amountCents: 2500, note: "requests" },
  perSet: { amountCents: 50000, note: null },
});
const fullPreferences = () => ({
  gigTypes: ["wedding"], travelRadiusKm: 80, actSize: "band",
  typicalSetMinutes: 45, bringsOwnPA: true, availabilityPattern: "weekends",
});
const allCurators: BookingVisibility = {
  perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
};

describe("updateBookingInfo -> rebuildBookingProjections", () => {
  it("nulls private-marked rate structures in curatorBooking while the source keeps them; public preferences populate publicBooking, curators-only clears it", async () => {
    const { user, profileId } = await makeMusicianProfile("rbp1");
    await callFn("updateBookingInfo", {
      profileId, rates: fullRates(), preferences: fullPreferences(),
      visibility: { perHour: "private", perSong: "curators", perSet: "curators", preferences: "public" },
    }, user);

    const source = (await adb.doc(`profiles/${profileId}/private/booking`).get()).data();
    expect(source?.rates.perHour.amountCents).toBe(20000); // untouched in the source doc
    expect(source?.visibility).toEqual({ perHour: "private", perSong: "curators", perSet: "curators", preferences: "public" });

    const projection = (await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).data();
    expect(projection?.rates.perHour).toBeNull(); // nulled — visibility "private"
    expect(projection?.rates.perSong).toEqual(fullRates().perSong);
    expect(projection?.rates.perSet).toEqual(fullRates().perSet);
    expect(projection?.preferences).toEqual(fullPreferences());
    expect(projection?.reliability).toEqual({ noShowCount: 0, completedCount: 0 });
    expect(typeof projection?.updatedAt).toBe("number");

    const profile = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(profile?.publicBooking).toEqual(fullPreferences());

    // Flip preferences visibility to curators-only — publicBooking clears.
    await callFn("updateBookingInfo", {
      profileId, rates: fullRates(), preferences: fullPreferences(),
      visibility: { perHour: "private", perSong: "curators", perSet: "curators", preferences: "curators" },
    }, user);
    const profile2 = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(profile2?.publicBooking).toBeNull();
  });

  it("every combination of perHour/perSong/perSet visibility nulls exactly the private-marked structures (8 combos)", async () => {
    const { user, profileId } = await makeMusicianProfile("rbp2");
    const opts: RateVisibility[] = ["curators", "private"];
    let combos = 0;
    for (const perHour of opts) {
      for (const perSong of opts) {
        for (const perSet of opts) {
          combos++;
          await callFn("updateBookingInfo", {
            profileId, rates: fullRates(), preferences: fullPreferences(),
            visibility: { perHour, perSong, perSet, preferences: "curators" },
          }, user);
          const projection = (await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).data();
          expect(projection?.rates.perHour).toEqual(perHour === "private" ? null : fullRates().perHour);
          expect(projection?.rates.perSong).toEqual(perSong === "private" ? null : fullRates().perSong);
          expect(projection?.rates.perSet).toEqual(perSet === "private" ? null : fullRates().perSet);
        }
      }
    }
    expect(combos).toBe(8);
  });

  it("reliability summary counts non-removed marks as noShowCount and carries completedCount", async () => {
    const { user, profileId } = await makeMusicianProfile("rbp3");
    await adb.doc(`profiles/${profileId}/private/reliability`).set({
      marks: [
        { bookingId: "b1", gigId: "g1", kind: "reported_no_show", at: 1, reportedByProfileId: "cp1", removedByAdmin: false },
        { bookingId: "b2", gigId: "g2", kind: "late_cancel", at: 2, reportedByProfileId: null, removedByAdmin: false },
        { bookingId: "b3", gigId: "g3", kind: "reported_no_show", at: 3, reportedByProfileId: "cp1", removedByAdmin: true },
      ],
      completedCount: 4,
      updatedAt: Date.now(),
    });
    await callFn("updateBookingInfo", {
      profileId, rates: fullRates(), preferences: fullPreferences(), visibility: allCurators,
    }, user);
    const projection = (await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).data();
    expect(projection?.reliability).toEqual({ noShowCount: 2, completedCount: 4 });
  });
});

describe("rebuildBookingProjections (direct)", () => {
  it("clears the curatorBooking projection and nulls publicBooking when the source booking doc is missing", async () => {
    const { user, profileId } = await makeMusicianProfile("rbp4");
    await callFn("updateBookingInfo", {
      profileId, rates: fullRates(), preferences: fullPreferences(),
      visibility: { perHour: "curators", perSong: "curators", perSet: "curators", preferences: "public" },
    }, user);
    expect((await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).exists).toBe(true);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.publicBooking).not.toBeNull();

    await adb.doc(`profiles/${profileId}/private/booking`).delete();
    await rebuildBookingProjections(profileId);

    expect((await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.publicBooking).toBeNull();
  });
});

describe("backfillBookingVisibility", () => {
  it("converges legacy musician profiles missing visibility to the all-curators default, rebuilds projections, skips already-set/no-doc/non-musician profiles, is idempotent, admin-gated", async () => {
    // Short and hyphen-free: this becomes part of createProfileDraft handles
    // below (via makeMusicianProfile, which already appends its own
    // Date.now()+random suffix for uniqueness) — handles are capped at 30
    // chars and may only contain lowercase letters, digits, underscores.
    const tag = "bfv1";
    const adminUser = await makeAdminUser(`${tag}admin`);
    // Baseline sweep: converge away any legacy docs that might already exist
    // from earlier in the suite (order-independence — mirrors
    // backfillDisplayNameLower's race-tolerant test design, but here it's a
    // one-time deterministic sweep rather than an ongoing race, since
    // nothing else in this suite writes a booking doc without `visibility`).
    // After this, the whole `profiles` collection has zero legacy docs.
    await callFn("backfillBookingVisibility", {}, adminUser.user);

    const legacyA = await makeMusicianProfile(`${tag}a`);
    const legacyB = await makeMusicianProfile(`${tag}b`);
    const alreadySet = await makeMusicianProfile(`${tag}c`);
    const noBookingDoc = await makeMusicianProfile(`${tag}d`);

    // Legacy shape: no `visibility` key at all — bypasses updateBookingInfo,
    // which always writes a complete one now.
    await adb.doc(`profiles/${legacyA.profileId}/private/booking`).set({
      rates: fullRates(), preferences: fullPreferences(), updatedAt: Date.now(),
    });
    await adb.doc(`profiles/${legacyB.profileId}/private/booking`).set({
      rates: fullRates(), preferences: fullPreferences(), updatedAt: Date.now(),
    });
    // Already has visibility set (non-default, to prove it's untouched, not overwritten).
    await adb.doc(`profiles/${alreadySet.profileId}/private/booking`).set({
      rates: fullRates(), preferences: fullPreferences(), updatedAt: Date.now(),
      visibility: { perHour: "private", perSong: "private", perSet: "private", preferences: "public" },
    });
    // noBookingDoc: no private/booking doc at all — must be skipped without error.

    // A curator profile carrying a booking-shaped doc missing visibility —
    // must NOT be touched (only musician profiles are paged).
    const { user: curOwner } = await signUpTestUser(`${tag}cur-${Date.now()}@test.com`);
    const { profileId: curatorProfileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", { type: "curator", subtype: "venue", name: "Not A Musician", handle: `${tag}cur` }, curOwner);
    await adb.doc(`profiles/${curatorProfileId}/private/booking`).set({
      rates: fullRates(), preferences: fullPreferences(), updatedAt: Date.now(),
    });

    const { converged } = await callFn<Record<string, never>, { converged: number }>(
      "backfillBookingVisibility", {}, adminUser.user);
    expect(converged).toBe(2); // only legacyA and legacyB — the baseline sweep zeroed everything else out first

    const sourceA = (await adb.doc(`profiles/${legacyA.profileId}/private/booking`).get()).data();
    expect(sourceA?.visibility).toEqual(allCurators);
    const sourceB = (await adb.doc(`profiles/${legacyB.profileId}/private/booking`).get()).data();
    expect(sourceB?.visibility).toEqual(allCurators);

    // Projections rebuilt with the default — nothing nulled (all "curators").
    const projectionA = (await adb.doc(`profiles/${legacyA.profileId}/private/curatorBooking`).get()).data();
    expect(projectionA?.rates).toEqual(fullRates());
    const profileA = (await adb.doc(`profiles/${legacyA.profileId}`).get()).data();
    expect(profileA?.publicBooking).toBeNull(); // default preferences visibility is "curators", never public

    // Untouched cases.
    const sourceAlreadySet = (await adb.doc(`profiles/${alreadySet.profileId}/private/booking`).get()).data();
    expect(sourceAlreadySet?.visibility).toEqual({ perHour: "private", perSong: "private", perSet: "private", preferences: "public" });
    expect((await adb.doc(`profiles/${noBookingDoc.profileId}/private/booking`).get()).exists).toBe(false);
    const curatorSource = (await adb.doc(`profiles/${curatorProfileId}/private/booking`).get()).data();
    expect(curatorSource?.visibility).toBeUndefined();

    const logs = await adb.collection("auditLogs")
      .where("action", "==", "booking_visibility_backfilled")
      .where("actorUid", "==", adminUser.uid).get();
    expect(logs.docs.some((d) => d.data().detail === "2")).toBe(true);

    // Idempotent — nothing left to converge.
    const { converged: converged2 } = await callFn<Record<string, never>, { converged: number }>(
      "backfillBookingVisibility", {}, adminUser.user);
    expect(converged2).toBe(0);
  });

  it("non-admin callers are denied", async () => {
    const stranger = await signUpTestUser(`bfv-na-${Date.now()}@test.com`);
    await expect(callFn("backfillBookingVisibility", {}, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

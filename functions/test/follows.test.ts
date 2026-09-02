import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile, makeApprovedCuratorProfile, makeFan } from "./discoverFixtures";
import { FOLLOW_LIMIT_MESSAGE, type FollowDoc, type ProfileDoc, type UserDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

describe("followTarget / unfollowTarget", () => {
  it("follows an approved musician, bumps the counter, and is idempotent", async () => {
    const m = await makeApprovedMusicianProfile("fo1m");
    const fan = await makeFan("fo1f");
    await callFn("followTarget", { targetId: m.profileId, targetType: "musician" }, fan.user);
    await callFn("followTarget", { targetId: m.profileId, targetType: "musician" }, fan.user);
    const f = (await adb.doc(`follows/${fan.uid}_${m.profileId}`).get()).data() as FollowDoc;
    expect(f).toMatchObject({ uid: fan.uid, targetId: m.profileId, targetType: "musician" });
    expect(((await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc).followerCount).toBe(1);
    await callFn("unfollowTarget", { targetId: m.profileId }, fan.user);
    await callFn("unfollowTarget", { targetId: m.profileId }, fan.user);
    expect((await adb.doc(`follows/${fan.uid}_${m.profileId}`).get()).exists).toBe(false);
    expect(((await adb.doc(`profiles/${m.profileId}`).get()).data() as ProfileDoc).followerCount).toBe(0);
  });
  it("follows a venue and a genre", async () => {
    const v = await makeApprovedCuratorProfile("fo2v", "venue");
    const fan = await makeFan("fo2f");
    await callFn("followTarget", { targetId: v.profileId, targetType: "curator" }, fan.user);
    await callFn("followTarget", { targetId: "genre:jazz", targetType: "genre" }, fan.user);
    expect((await adb.doc(`follows/${fan.uid}_genre:jazz`).get()).exists).toBe(true);
  });
  it("refuses unknown genres, type mismatches, unapproved profiles, and anonymous calls", async () => {
    const fan = await makeFan("fo3f");
    await expect(callFn("followTarget", { targetId: "genre:polka", targetType: "genre" }, fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    const m = await makeApprovedMusicianProfile("fo3m");
    await expect(callFn("followTarget", { targetId: m.profileId, targetType: "curator" }, fan.user)).rejects.toMatchObject({ code: "functions/not-found" });
    const draft = await signUpTestUser(`fo3d-${Date.now()}@test.com`);
    const { profileId } = await callFn<Record<string, unknown>, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Draft", handle: `fo3d_${Date.now()}` }, draft.user);
    await expect(callFn("followTarget", { targetId: profileId, targetType: "musician" }, fan.user)).rejects.toMatchObject({ code: "functions/not-found" });
    await expect(callFn("followTarget", { targetId: m.profileId, targetType: "musician" })).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });
  it("enforces the follow cap with the shared message", async () => {
    const fan = await makeFan("fo4f");
    // Seed 500 follow docs directly (the cap counts docs, not their validity).
    const batch = adb.batch();
    for (let i = 0; i < 500; i++) batch.set(adb.doc(`follows/${fan.uid}_seed${i}`), { uid: fan.uid, targetId: `seed${i}`, targetType: "musician", createdAt: 1 });
    await batch.commit();
    await expect(callFn("followTarget", { targetId: "genre:jazz", targetType: "genre" }, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: FOLLOW_LIMIT_MESSAGE });
  });
  it("markGenrePickerSeen stamps the user doc", async () => {
    const fan = await makeFan("fo5f");
    await callFn("markGenrePickerSeen", {}, fan.user);
    expect(((await adb.doc(`users/${fan.uid}`).get()).data() as UserDoc).genrePickerSeenAt).toBeTypeOf("number");
  });
});

describe("notifyUser dedupeKey", () => {
  it("writes once per key and leaves the first doc untouched", async () => {
    const { notifyUser } = await import("../src/notifications.js");
    const fan = await makeFan("nd1f");
    const first = await notifyUser(fan.uid, { kind: "system", title: "A", body: "one" }, "key:1");
    const second = await notifyUser(fan.uid, { kind: "system", title: "B", body: "two" }, "key:1");
    expect(first).toBe(true); expect(second).toBe(false);
    const doc = (await adb.doc(`users/${fan.uid}/notifications/key:1`).get()).data();
    expect(doc?.title).toBe("A");
  });
});

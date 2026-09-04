import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait, seedCuratorGateContent } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput, MemberDoc } from "@gatekeep/shared";
import { loadPushTokenIds, deadTokenIdsFromExpoResponse, notifyUser } from "../src/notifications.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Function execution (reviewProfile -> notifyProfileMembers -> notifyUser) is async
// relative to the callable's resolved promise finishing its Firestore writes being
// visible to a separate admin-SDK read, and a cold-started Functions emulator can add
// latency on top of that. Poll instead of a single fixed sleep, same pattern as the
// cold-start note in authTriggers.test.ts.
vi.setConfig({ testTimeout: 15_000 });

// Poll a single user's notifications collection until it has at least one doc, or
// the deadline passes (returns whatever the last read found, possibly still empty,
// which the caller's assertions will then fail on with a clear message).
async function pollNotifications(uid: string) {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

async function makeAdminUser() {
  const t = await signUpTestUser(`na-${Date.now()}@test.com`);
  await adminAuth(admin).setCustomUserClaims(t.uid, { admin: true });
  await t.user.getIdToken(true); // refresh claims
  return t;
}

describe("review notifications", () => {
  it("approving a profile writes an inbox notification for each member", async () => {
    const owner = await signUpTestUser(`n1-${Date.now()}@test.com`);
    // Curator, not musician: this test's subject is notification fan-out on a
    // review decision, not the minimum-content gate, seed the gate's
    // requirements directly (Task 4) rather than re-deriving them here.
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Nova", handle: `nova_${Date.now()}` }, owner.user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    const notes = await pollNotifications(owner.uid);

    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/approved/i);
  });

  it("rejecting a profile writes a notification whose title and body reflect the decision and reason", async () => {
    const owner = await signUpTestUser(`n2-${Date.now()}@test.com`);
    // Curator, not musician, see the fixture note above.
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Comet", handle: `comet_${Date.now()}` }, owner.user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    const reason = "Please add at least 3 photos and a bio";
    await callFn("reviewProfile", { profileId, decision: "rejected", reason }, adminUser.user);

    const notes = await pollNotifications(owner.uid);

    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/needs changes/i);
    expect(notes.docs[0].data().body).toContain(reason);
  });

  it("approving a profile with multiple members notifies every member's inbox", async () => {
    const owner = await signUpTestUser(`n3-${Date.now()}@test.com`);
    // Curator, not musician, see the fixture note above; this test's subject
    // is member fan-out, unrelated to profile type.
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Lunar Sound", handle: `lunar_${Date.now()}` }, owner.user);

    // Add a second member directly via the admin SDK, bypassing the invite-accept
    // callable flow, equivalent end state (a members subcollection doc), simpler
    // for the purposes of this fan-out test.
    const bandmate = await signUpTestUser(`n3b-${Date.now()}@test.com`);
    const member: MemberDoc = { uid: bandmate.uid, role: "member", label: "drummer", joinedAt: Date.now() };
    await adb.doc(`profiles/${profileId}/members/${bandmate.uid}`).set(member);

    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    const [ownerNotes, bandmateNotes] = await Promise.all([
      pollNotifications(owner.uid),
      pollNotifications(bandmate.uid),
    ]);

    for (const notes of [ownerNotes, bandmateNotes]) {
      expect(notes.size).toBe(1);
      expect(notes.docs[0].data().kind).toBe("profile_review");
      expect(notes.docs[0].data().title).toMatch(/approved/i);
    }
  });
});

describe("push token selection and pruning (SP10 Task 15)", () => {
  it("loadPushTokenIds returns the 20 newest tokens by createdAt, newest first", async () => {
    const { uid } = await signUpTestUser(`pt1-${Date.now()}@test.com`);
    const batch = adb.batch();
    for (let i = 1; i <= 22; i++) {
      batch.set(adb.doc(`users/${uid}/pushTokens/ExponentPushToken[tok${i}]`), { createdAt: i });
    }
    await batch.commit();
    const ids = await loadPushTokenIds(uid);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe("ExponentPushToken[tok22]");
    expect(ids[19]).toBe("ExponentPushToken[tok3]");
    expect(ids).not.toContain("ExponentPushToken[tok1]");
    expect(ids).not.toContain("ExponentPushToken[tok2]");
  });

  it("deadTokenIdsFromExpoResponse picks only DeviceNotRegistered tickets, aligned by index", () => {
    const tokens = ["ExponentPushToken[a]", "ExponentPushToken[b]", "ExponentPushToken[c]"];
    const body = { data: [
      { status: "ok", id: "x" },
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      { status: "error", message: "big", details: { error: "MessageTooBig" } },
    ] };
    expect(deadTokenIdsFromExpoResponse(tokens, body)).toEqual(["ExponentPushToken[b]"]);
    expect(deadTokenIdsFromExpoResponse(tokens, null)).toEqual([]);
    expect(deadTokenIdsFromExpoResponse(tokens, { data: "nope" })).toEqual([]);
    expect(deadTokenIdsFromExpoResponse(tokens, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] })).toEqual([]);
  });
});

describe("notifyUser push data payload (SP10 Task 29)", () => {
  // Same in-process stubbing pattern as GoogleGeocoder's tests in
  // geocode.test.ts: notifyUser is imported straight from src (not called
  // through a deployed callable), so stubbing global fetch here observes
  // exactly the request body it builds.
  it("attaches data: { kind, refId } to every Expo push message", async () => {
    const { uid } = await signUpTestUser(`nd1-${Date.now()}@test.com`);
    await adb.doc(`users/${uid}/pushTokens/ExponentPushToken[nd1]`).set({ createdAt: Date.now() });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: "ok", id: "x" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyUser(uid, { title: "Booking update", body: "Your booking moved forward", kind: "booking", refId: "book123" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual([{
        to: "ExponentPushToken[nd1]", title: "Booking update", body: "Your booking moved forward",
        data: { kind: "booking", refId: "book123" },
      }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends refId: null when the notification carries no refId", async () => {
    const { uid } = await signUpTestUser(`nd2-${Date.now()}@test.com`);
    await adb.doc(`users/${uid}/pushTokens/ExponentPushToken[nd2]`).set({ createdAt: Date.now() });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: "ok", id: "x" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyUser(uid, { title: "System", body: "Something happened", kind: "system" });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body[0].data).toEqual({ kind: "system", refId: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

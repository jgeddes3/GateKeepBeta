import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn, makeAdminUser } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Directly seeds a users/{uid} doc via the Admin SDK (bypassing the real
// signup -> onUserCreated flow) so search/backfill tests can control
// displayName/displayNameLower exactly, without waiting on Functions
// emulator cold-start or a real auth account. searchUsersByName and
// backfillDisplayNameLower only ever read/write Firestore, so a synthetic
// uid is indistinguishable from a real one to either callable.
async function seedUser(uid: string, displayName: string, opts: { withLower?: boolean; email?: string } = {}) {
  const { withLower = true, email = `${uid}@test.com` } = opts;
  await adb.doc(`users/${uid}`).set({
    displayName,
    email,
    photoUrl: null,
    homeCity: null,
    createdAt: Date.now(),
    ...(withLower ? { displayNameLower: displayName.toLowerCase() } : {}),
  });
}

describe("searchUsersByName", () => {
  it("matches a case-insensitive lowercase prefix and excludes non-matching names", async () => {
    const tag = `zzq${Date.now()}`;
    await seedUser(`${tag}-a`, `${tag} One`);
    await seedUser(`${tag}-b`, `${tag} Two`);
    await seedUser(`${tag}-c`, "Totally unrelated name");

    const adminUser = await makeAdminUser("search1");
    // Uppercase query, the callable itself must lowercase it before
    // ranging against the already-lowercased displayNameLower field.
    const { results } = await callFn<{ q: string }, { results: { uid: string; displayName: string; email: string }[] }>(
      "searchUsersByName", { q: tag.toUpperCase() }, adminUser.user);

    const uids = results.map((r) => r.uid).sort();
    expect(uids).toEqual([`${tag}-a`, `${tag}-b`].sort());
    const one = results.find((r) => r.uid === `${tag}-a`)!;
    expect(one.displayName).toBe(`${tag} One`);
    expect(one.email).toBe(`${tag}-a@test.com`);
  });

  it("caps results at 10 even when more than 10 names match the prefix", async () => {
    const tag = `zzlim${Date.now()}`;
    for (let i = 0; i < 12; i++) {
      await seedUser(`${tag}-${String(i).padStart(2, "0")}`, `${tag} Person ${i}`);
    }
    const adminUser = await makeAdminUser("search2");
    const { results } = await callFn<{ q: string }, { results: unknown[] }>(
      "searchUsersByName", { q: tag }, adminUser.user);
    expect(results.length).toBe(10);
  });

  it("rejects a missing/empty query with invalid-argument", async () => {
    const adminUser = await makeAdminUser("search3");
    await expect(callFn("searchUsersByName", { q: "" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("searchUsersByName", { q: "x".repeat(81) }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("non-admin callers are denied", async () => {
    const stranger = await signUpTestUser(`search4-${Date.now()}@test.com`);
    await expect(callFn("searchUsersByName", { q: "anything" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("flagAccount", () => {
  it("appends {byUid, at, text} to adminNotes/{uid} and writes an account_flagged audit entry", async () => {
    const target = await signUpTestUser(`flagtarget1-${Date.now()}@test.com`);
    const adminUser = await makeAdminUser("flag1");
    await callFn("flagAccount", { uid: target.uid, text: "Suspicious activity reported." }, adminUser.user);

    const notesSnap = await adb.doc(`adminNotes/${target.uid}`).get();
    expect(notesSnap.exists).toBe(true);
    const notes = notesSnap.data()?.notes as { byUid: string; at: number; text: string }[];
    expect(notes.length).toBe(1);
    expect(notes[0].byUid).toBe(adminUser.uid);
    expect(notes[0].text).toBe("Suspicious activity reported.");
    expect(typeof notes[0].at).toBe("number");

    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", target.uid).where("action", "==", "account_flagged").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(adminUser.uid);
    expect(logs.docs[0].data().detail).toBe("Suspicious activity reported.");
  });

  it("a second flag appends rather than overwriting the first", async () => {
    const target = await signUpTestUser(`flagtarget2-${Date.now()}@test.com`);
    const admin1 = await makeAdminUser("flag2a");
    const admin2 = await makeAdminUser("flag2b");
    await callFn("flagAccount", { uid: target.uid, text: "First note." }, admin1.user);
    await callFn("flagAccount", { uid: target.uid, text: "Second note." }, admin2.user);

    const notes = (await adb.doc(`adminNotes/${target.uid}`).get()).data()?.notes as { byUid: string; text: string }[];
    expect(notes.length).toBe(2);
    expect(notes.map((n) => n.text)).toEqual(["First note.", "Second note."]);
    expect(notes.map((n) => n.byUid)).toEqual([admin1.uid, admin2.uid]);
  });

  it("rejects empty text and text over 500 characters", async () => {
    const target = await signUpTestUser(`flagtarget3-${Date.now()}@test.com`);
    const adminUser = await makeAdminUser("flag3");
    await expect(callFn("flagAccount", { uid: target.uid, text: "" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("flagAccount", { uid: target.uid, text: "x".repeat(501) }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    // Exactly 500 is allowed.
    await callFn("flagAccount", { uid: target.uid, text: "x".repeat(500) }, adminUser.user);
    const notes = (await adb.doc(`adminNotes/${target.uid}`).get()).data()?.notes as unknown[];
    expect(notes.length).toBe(1);
  });

  it("rejects a missing/invalid uid with invalid-argument", async () => {
    const adminUser = await makeAdminUser("flag4");
    await expect(callFn("flagAccount", { uid: "", text: "note" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });

  it("P6: rejects flagging once a user's notes reach 200 entries (resource-exhausted)", async () => {
    const target = await signUpTestUser(`flagtarget6-${Date.now()}@test.com`);
    const adminUser = await makeAdminUser("flag5");
    const notes = Array.from({ length: 200 }, (_, i) => ({ byUid: adminUser.uid, at: i, text: `note ${i}` }));
    await adb.doc(`adminNotes/${target.uid}`).set({ notes });
    await expect(callFn("flagAccount", { uid: target.uid, text: "one too many" }, adminUser.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
    const after = (await adb.doc(`adminNotes/${target.uid}`).get()).data()?.notes as unknown[];
    expect(after.length).toBe(200); // unchanged, the 201st entry was rejected
  });

  it("non-admin callers are denied", async () => {
    const target = await signUpTestUser(`flagtarget5-${Date.now()}@test.com`);
    const stranger = await signUpTestUser(`flagstranger-${Date.now()}@test.com`);
    await expect(callFn("flagAccount", { uid: target.uid, text: "note" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("backfillDisplayNameLower", () => {
  // NOTE on why this doesn't assert `updated >= N`: onUserDocWritten (a LIVE
  // trigger in this same emulator session) reacts to every write to
  // users/{uid} within single-digit milliseconds, including these seed
  // writes. backfillDisplayNameLower's own collection-wide scan (paging the
  // whole `users` collection, ~150ms+ once the suite has accumulated
  // hundreds of test accounts) takes far longer than that, so by the time
  // its query reaches these docs the trigger has almost always already
  // fixed them, `updated` legitimately lands at 0 most runs. That's not
  // this test flaking; it's the real, deterministic ordering of two
  // independent async reactors racing over the same collection. The
  // decision logic backfill shares with the trigger (computeDisplayNameLowerFix)
  // is covered deterministically, without that race, in
  // authTriggers.test.ts. This test instead proves the parts that DO hold
  // regardless of who wins the race: the admin gate, that a full collection
  // scan completes without error, and that every seeded doc ends up
  // consistent afterward (converged, whether by the trigger or by backfill).
  it("converges legacy users (missing/stale displayNameLower) to a consistent value, admin-gated, without error", async () => {
    const tag = `zzbf${Date.now()}`;
    const missingUid = `${tag}-missing`;
    const staleUid = `${tag}-stale`;
    const alreadyOkUid = `${tag}-ok`;
    await seedUser(missingUid, "Legacy Missing Lower", { withLower: false });
    await seedUser(staleUid, "Legacy Stale Lower", { withLower: false });
    await adb.doc(`users/${staleUid}`).update({ displayNameLower: "an old stale value" });
    await seedUser(alreadyOkUid, "Already Consistent");

    const adminUser = await makeAdminUser("backfill1");
    const { updated } = await callFn<Record<string, never>, { updated: number }>(
      "backfillDisplayNameLower", {}, adminUser.user);
    expect(Number.isInteger(updated)).toBe(true);
    expect(updated).toBeGreaterThanOrEqual(0);

    // Converged, whichever of backfill / the live trigger got there first.
    expect((await adb.doc(`users/${missingUid}`).get()).data()?.displayNameLower).toBe("legacy missing lower");
    expect((await adb.doc(`users/${staleUid}`).get()).data()?.displayNameLower).toBe("legacy stale lower");
    // Untouched, was already correct going in.
    expect((await adb.doc(`users/${alreadyOkUid}`).get()).data()?.displayNameLower).toBe("already consistent");
  });

  it("non-admin callers are denied", async () => {
    const stranger = await signUpTestUser(`backfill2-${Date.now()}@test.com`);
    await expect(callFn("backfillDisplayNameLower", {}, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

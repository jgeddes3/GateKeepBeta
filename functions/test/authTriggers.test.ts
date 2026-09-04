// Admin SDK against emulator to read users docs regardless of rules.
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";

import { describe, it, expect } from "vitest";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { signUpTestUser, db, wait, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { computeDisplayNameLowerFix } from "../src/authTriggers.js";
import type { ProfileDraftInput } from "@gatekeep/shared";

const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });

// Shared by every test below: poll users/{uid} until it exists (onUserCreated
// is async, and a cold-started Functions emulator can take several seconds
// for its first invocation).
async function waitForUserDoc(uid: string, deadline = Date.now() + 10_000) {
  let snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  while (!snap.exists && Date.now() < deadline) {
    await wait(250);
    snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  }
  return snap;
}

describe("onUserCreated", () => {
  it(
    "creates users/{uid} with email and defaults",
    async () => {
      const { uid } = await signUpTestUser(`alice-${Date.now()}@test.com`);
      const snap = await waitForUserDoc(uid);

      expect(snap.exists).toBe(true);
      expect(snap.data()?.email).toContain("@test.com");
      expect(snap.data()?.photoUrl).toBeNull();
      expect(typeof snap.data()?.createdAt).toBe("number");
    },
    15_000,
  );

  it(
    "an EMPTY auth displayName falls back to the email local part, never a blank name",
    async () => {
      // Rules audit: the users update rule now requires a present, non-blank
      // displayName on EVERY patch (even a homeCity-only one). A doc seeded
      // with "" would therefore be permanently unpatchable by its own owner,
      // so the seed must never produce one. `??` does not catch "" (it is not
      // nullish), which is exactly the hole this closes.
      const email = `blank-${Date.now()}@test.com`;
      const created = await adminAuth(admin).createUser({ email, password: "GateKeep-Test1", displayName: "" });
      const snap = await waitForUserDoc(created.uid);
      expect(snap.exists).toBe(true);
      expect(snap.data()?.displayName).toBe(email.split("@")[0]);
      expect((snap.data()?.displayName as string).trim().length).toBeGreaterThan(0);
      expect(snap.data()?.displayNameLower).toBe(email.split("@")[0].toLowerCase());
    },
    15_000,
  );

  it(
    "also stamps displayNameLower as the lowercased displayName",
    async () => {
      const { uid } = await signUpTestUser(`bob-${Date.now()}@test.com`);
      const snap = await waitForUserDoc(uid);

      expect(snap.exists).toBe(true);
      const data = snap.data();
      expect(data?.displayNameLower).toBe((data?.displayName as string).toLowerCase());
    },
    15_000,
  );
});

// Task 8: computeDisplayNameLowerFix is the pure consistency rule behind
// both onUserDocWritten (below) and backfillDisplayNameLower
// (adminTools.ts). Unit-tested directly (no emulator round trip) because
// onUserDocWritten reacts to EVERY write to users/{uid} within single-digit
// milliseconds, a live-emulator integration test that seeds an
// "inconsistent" doc almost always finds it already corrected by the time
// it can look again, especially against backfillDisplayNameLower's own
// collection-wide scan, which takes far longer than the trigger's reaction.
// This is the reliable seam for exercising the actual decision logic.
describe("computeDisplayNameLowerFix", () => {
  it("returns the lowercased value when displayNameLower is missing", () => {
    expect(computeDisplayNameLowerFix({ displayName: "Legacy Missing Lower" }))
      .toBe("legacy missing lower");
  });
  it("returns the corrected lowercased value when displayNameLower is stale", () => {
    expect(computeDisplayNameLowerFix({ displayName: "Legacy Stale Lower", displayNameLower: "an old stale value" }))
      .toBe("legacy stale lower");
  });
  it("returns null when already consistent, the no-op / no-self-retrigger case", () => {
    expect(computeDisplayNameLowerFix({ displayName: "Already Consistent", displayNameLower: "already consistent" }))
      .toBeNull();
  });
  it("treats a missing/non-string displayName as empty string, not a crash", () => {
    expect(computeDisplayNameLowerFix({})).toBe("");
    expect(computeDisplayNameLowerFix({ displayName: 42 })).toBe("");
    expect(computeDisplayNameLowerFix({ displayName: "", displayNameLower: "" })).toBeNull();
  });
});

// Task 8: onUserDocWritten (v2 onDocumentWritten("users/{uid}")) keeps
// displayNameLower in sync with displayName after creation, e.g. a client
// update via the users update rule (owner may write displayName directly).
describe("onUserDocWritten", () => {
  it(
    "syncs displayNameLower when displayName changes",
    async () => {
      const { uid } = await signUpTestUser(`carol-${Date.now()}@test.com`);
      await waitForUserDoc(uid);

      await updateDoc(doc(db, "users", uid), { displayName: "CaRoL Mixed CASE" });

      const deadline = Date.now() + 10_000;
      let adata = (await adminFirestore(admin).doc(`users/${uid}`).get()).data();
      while (adata?.displayNameLower !== "carol mixed case" && Date.now() < deadline) {
        await wait(250);
        adata = (await adminFirestore(admin).doc(`users/${uid}`).get()).data();
      }

      expect(adata?.displayName).toBe("CaRoL Mixed CASE");
      expect(adata?.displayNameLower).toBe("carol mixed case");
    },
    15_000,
  );

  it(
    "is a no-op once displayNameLower is already consistent, no self-retrigger churn",
    async () => {
      const { uid } = await signUpTestUser(`dave-${Date.now()}@test.com`);
      await waitForUserDoc(uid);

      await updateDoc(doc(db, "users", uid), { displayName: "Dave Settled" });

      const deadline = Date.now() + 10_000;
      let snap = await adminFirestore(admin).doc(`users/${uid}`).get();
      while (snap.data()?.displayNameLower !== "dave settled" && Date.now() < deadline) {
        await wait(250);
        snap = await adminFirestore(admin).doc(`users/${uid}`).get();
      }
      expect(snap.data()?.displayNameLower).toBe("dave settled");
      const updateTimeAfterSync = snap.updateTime;

      // If the trigger's own sync write re-triggered itself (a missing or
      // broken consistency guard), the document's updateTime would keep
      // advancing indefinitely. Wait past one more plausible trigger round
      // trip and confirm Firestore's own updateTime, not an app-level
      // field, genuinely stopped changing.
      await wait(3_000);
      const settledSnap = await adminFirestore(admin).doc(`users/${uid}`).get();
      expect(settledSnap.updateTime?.isEqual(updateTimeAfterSync!)).toBe(true);
    },
    20_000,
  );

  it(
    "handles a deleted user doc gracefully (no error, nothing recreated)",
    async () => {
      const adb = adminFirestore(admin);
      const uid = `ghost-${Date.now()}`;
      await adb.doc(`users/${uid}`).set({
        displayName: "Ghost", displayNameLower: "ghost", email: "g@test.com",
        photoUrl: null, homeCity: null, createdAt: Date.now(),
      });
      await adb.doc(`users/${uid}`).delete();

      // Give the trigger a moment to run against the delete event; the
      // assertion is purely that nothing resurrects the doc or throws.
      await wait(3_000);
      const snap = await adb.doc(`users/${uid}`).get();
      expect(snap.exists).toBe(false);
    },
    15_000,
  );
});

async function waitForUserDocGone(uid: string, deadline = Date.now() + 15_000) {
  let snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  while (snap.exists && Date.now() < deadline) {
    await wait(250);
    snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  }
  return snap;
}

describe("onUserDeleted", () => {
  it("a console/Admin SDK deletion cascades: users tree, memberships, curatorAccess, pending invites revoked, offered transfers voided", async () => {
    const { uid } = await signUpTestUser(`od1-${Date.now()}@test.com`);
    await waitForUserDoc(uid);
    const adb = adminFirestore(admin);
    const now = Date.now();
    await adb.doc(`curatorAccess/${uid}`).set({});
    await adb.doc(`profiles/od1-profile-${now}/members/${uid}`).set({ uid, role: "member", label: "sax", joinedAt: now });
    const inviteRef = adb.collection("invites").doc();
    await inviteRef.set({
      profileId: "p1", profileName: "Band", invitedUid: uid, role: "member", label: "sax",
      invitedByUid: "owner", status: "pending", createdAt: now,
    });
    const transferRef = adb.collection("transfers").doc();
    await transferRef.set({ ticketId: "t", eventId: "e", fromUid: "other", toUid: uid, status: "offered", createdAt: now, expiresAt: now + 86_400_000 });

    await adminAuth(admin).deleteUser(uid);

    const gone = await waitForUserDocGone(uid);
    expect(gone.exists).toBe(false);
    expect((await adb.doc(`curatorAccess/${uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/od1-profile-${now}/members/${uid}`).get()).exists).toBe(false);
    expect((await inviteRef.get()).data()?.status).toBe("revoked");
    const transfer = (await transferRef.get()).data();
    expect(transfer?.status).toBe("voided");
    expect(typeof transfer?.resolvedAt).toBe("number");
  }, 30_000);

  it("a client-side deletion with a live future ticket alerts account_deleted_unclean and still cascades", async () => {
    const { uid } = await signUpTestUser(`od3-${Date.now()}@test.com`);
    await waitForUserDoc(uid);
    const adb = adminFirestore(admin);
    const now = Date.now();
    const eventId = `od3-event-${now}`;
    // Dated past DECK_WINDOW_MS (30 days) and given the full EventDoc shape:
    // this fixture is written straight through the Admin SDK, and getDiscoverDeck
    // reads every published event inside its window without null-guarding
    // lineupMusicianProfileIds, so a half-shaped one poisons an unrelated suite.
    const startsAt = now + 60 * 86_400_000;
    await adb.doc(`events/${eventId}`).set({
      curatorProfileId: "od3-curator", title: "Future night", description: "",
      location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
      startsAt, endsAt: startsAt + 3 * 3_600_000, status: "published",
      lineup: [], lineupMusicianProfileIds: [], genres: [],
      createdAt: now, updatedAt: now,
    });
    await adb.doc(`users/${uid}/tickets/od3-ticket`).set({
      eventId, tierId: "t1", orderId: "o1", ownerUid: uid, status: "valid", createdAt: now,
    });

    // currentUser.delete() on a client, or a console deletion: neither can be
    // refused server-side, so deleteAccount's refusals are bypassed entirely.
    await adminAuth(admin).deleteUser(uid);

    const gone = await waitForUserDocGone(uid);
    expect(gone.exists).toBe(false); // the cascade still ran

    const deadline = Date.now() + 15_000;
    let alert = (await adb.doc(`adminAlerts/account-deleted-unclean:${uid}`).get()).data();
    while (!alert && Date.now() < deadline) {
      await wait(250);
      alert = (await adb.doc(`adminAlerts/account-deleted-unclean:${uid}`).get()).data();
    }
    expect(alert).toBeDefined();
    expect(alert?.kind).toBe("account_deleted_unclean");
    expect(alert?.detail).toContain(uid);
    expect(alert?.detail).toMatch(/ticket/i);
    expect(alert?.resolvedAt).toBeNull();
  }, 40_000);

  it("a sole admin deleted from the console is logged, not refused: the membership goes, the profile stays", async () => {
    const owner = await signUpTestUser(`od2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", { type: "musician", subtype: "solo", name: "Solo", handle: `od2_${Date.now()}` }, owner.user);
    await adminAuth(admin).deleteUser(owner.uid);
    const gone = await waitForUserDocGone(owner.uid);
    expect(gone.exists).toBe(false);
    const adb = adminFirestore(admin);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(true);
  }, 30_000);
});

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, callFn, wait, fetchPendingInviteId } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import {
  DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE,
  type ProfileDraftInput,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);

// Cold-start note (see review.test.ts / authTriggers.test.ts): the first
// invocation of a callable in this file can take several seconds in the
// Functions emulator, so raise the default 5s test timeout.
vi.setConfig({ testTimeout: 15_000 });

describe("deleteAccount", () => {
  it("rejects unauthenticated calls", async () => {
    await expect(callFn("deleteAccount", {})).rejects.toThrow();
  });

  it("deletes a plain fan account: auth user, users doc, subcollections", async () => {
    const fan = await signUpTestUser(`d1-${Date.now()}@test.com`);

    // onUserCreated (Task 5) runs async relative to sign-up resolving; poll
    // instead of a fixed sleep, matching the pattern in authTriggers.test.ts.
    const deadline = Date.now() + 10_000;
    let userSnap = await adb.doc(`users/${fan.uid}`).get();
    while (!userSnap.exists && Date.now() < deadline) {
      await wait(250);
      userSnap = await adb.doc(`users/${fan.uid}`).get();
    }
    expect(userSnap.exists).toBe(true);

    await adb.doc(`users/${fan.uid}/notifications/n1`).set({ title: "x", read: false });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`users/${fan.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`users/${fan.uid}/notifications/n1`).get()).exists).toBe(false);
    await expect(adminAuth(admin).getUser(fan.uid)).rejects.toThrow();
  });

  it("refuses while sole admin of a profile, naming it", async () => {
    const owner = await signUpTestUser(`d2-${Date.now()}@test.com`);
    await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `del_${Date.now()}` }, owner.user);
    await expect(callFn("deleteAccount", {}, owner.user)).rejects.toThrow(/Solo Act/);
  });

  it("succeeds after admin transfer; membership removed", async () => {
    const owner = await signUpTestUser(`d3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Loft", handle: `loft_${Date.now()}` }, owner.user);
    const email = `d4-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, co.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    await callFn("deleteAccount", {}, owner.user);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${co.uid}`).get()).exists).toBe(true);
  });

  it("S5: clears the curatorAccess marker (and any pending retry doc) as the first phase of deletion", async () => {
    const fan = await signUpTestUser(`d5-${Date.now()}@test.com`);
    // Seeded directly, this test's subject is deleteAccount's own cleanup,
    // not how the marker/retry doc ordinarily gets there.
    await adb.doc(`curatorAccess/${fan.uid}`).set({});
    await adb.doc(`curatorAccessRetries/${fan.uid}`).set({ createdAt: Date.now() });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`curatorAccess/${fan.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`curatorAccessRetries/${fan.uid}`).get()).exists).toBe(false);
  });
});

// SP10 Task 13: every refusal is seeded directly via the admin SDK. The
// subject is the gate, not the checkout/transfer flows that ordinarily
// produce these docs (ticketing.test.ts covers those).
async function seedFutureEvent(): Promise<string> {
  const ref = adb.collection("events").doc();
  const now = Date.now();
  await ref.set({
    curatorProfileId: "seed-curator", title: "Seeded show", description: "", status: "published",
    location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
    startsAt: now + 86_400_000, endsAt: now + 90_000_000, posterPath: null, maxTicketsPerBuyer: 8,
    lineup: [], lineupMusicianProfileIds: [], gigId: null, createdAt: now, updatedAt: now,
  });
  return ref.id;
}

describe("deleteAccount refusals (SP10)", () => {
  it("refuses while the user holds a valid ticket to an event that has not ended; allows once it has", async () => {
    const fan = await signUpTestUser(`da1-${Date.now()}@test.com`);
    const eventId = await seedFutureEvent();
    await adb.doc(`users/${fan.uid}/tickets/t1`).set({
      eventId, tierId: "t", tierName: "General", orderId: "o1", curatorProfileId: "seed-curator",
      qrSecret: "x", status: "checked_in", createdAt: Date.now(),
    });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: DELETE_ACCOUNT_TICKETS_MESSAGE });
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - 1000 });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`users/${fan.uid}`).get()).exists).toBe(false);
  });

  it("refuses while a transfer is offered on either side", async () => {
    const fan = await signUpTestUser(`da2-${Date.now()}@test.com`);
    const now = Date.now();
    const ref = adb.collection("transfers").doc();
    await ref.set({ ticketId: "t", eventId: "e", fromUid: fan.uid, toUid: "other", status: "offered", createdAt: now, expiresAt: now + 86_400_000 });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_TRANSFERS_MESSAGE });
    await ref.set({ ticketId: "t", eventId: "e", fromUid: "other", toUid: fan.uid, status: "offered", createdAt: now, expiresAt: now + 86_400_000 });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_TRANSFERS_MESSAGE });
    await ref.update({ status: "declined", resolvedAt: now });
    await callFn("deleteAccount", {}, fan.user);
  });

  it("refuses while a ticket order is pending", async () => {
    const fan = await signUpTestUser(`da3-${Date.now()}@test.com`);
    const now = Date.now();
    const ref = adb.collection("orders").doc();
    await ref.set({
      buyerUid: fan.uid, eventId: "e", curatorProfileId: "c", items: [], faceTotalCents: 0, serviceFeeCents: 0,
      feePolicy: { ticketFeePct: 7, ticketFeeFixedCents: 99, ticketFeeCapCents: 399 }, paymentIntentId: null,
      status: "pending", refundedTicketIds: [], refundedCents: 0, refundedFaceCents: 0, createdAt: now, expiresAt: now + 600_000,
    });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_ORDERS_MESSAGE });
    await ref.update({ status: "expired" });
    await callFn("deleteAccount", {}, fan.user);
  });

  it("writes an account_deleted audit entry on success", async () => {
    const fan = await signUpTestUser(`da4-${Date.now()}@test.com`);
    await callFn("deleteAccount", {}, fan.user);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", fan.uid).where("action", "==", "account_deleted").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(fan.uid);
  });
});

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE, MAX_BOOKING_THREAD_ENTRIES,
  type ProfileDraftInput, type BookingRequestDoc, type OfferEntry,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 15_000 });

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

// Admin-SDK shortcut for the musician submission gate (bio+genre+avatar+
// track) — the upload/transcode pipeline has its own tests (tracks.test.ts);
// this suite's subject is booking negotiation, not portfolio gate mechanics.
// Mirrors seedCuratorGateContent's identical rationale in helpers.ts.
async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz",
    description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] },
    durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides,
  };
}

async function createOpenGig(
  profileId: string, user: import("firebase/auth").User, overrides: Record<string, unknown> = {},
): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId, ...gigContent(overrides) }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

function offerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { amountCents: 15000, note: "Looking forward to it!", ...overrides };
}

// Mirrors notifications.test.ts's pollNotifications — see its comment on why
// polling (not a single read) is needed even though the callable already
// awaited the write.
async function pollNotifications(uid: string) {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

function seedSeries(curatorProfileId: string, fillMode: "whole_run" | "per_occurrence") {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode, status: "active",
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    template: {}, templatePrivateLocation: {},
    materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
    activeBookingId: null, bookedMusicianProfileId: null,
  }).then(() => ref);
}

describe("applyToGig", () => {
  it("happy path: creates an open booking with the correct doc shape (perHour quantity server-derived), notifies the curator", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user, { durationMinutes: 90 });

    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.gigId).toBe(gigId);
    expect(booking.seriesId).toBeNull();
    expect(booking.curatorProfileId).toBe(curatorProfileId);
    expect(booking.musicianProfileId).toBe(musicianProfileId);
    expect(booking.initiatedBy).toBe("musician");
    expect(booking.structure).toBe("perHour");
    expect(booking.awaitingSide).toBe("curator");
    expect(booking.status).toBe("open");
    expect(booking.acceptedTerms).toBeNull();
    expect(booking.deposit).toBeNull();
    expect(booking.cancellation).toBeNull();
    expect(booking.confirmedAt).toBeNull();
    expect(booking.resolvedAt).toBeNull();
    expect(typeof booking.createdAt).toBe("number");
    expect(typeof booking.updatedAt).toBe("number");
    expect(booking.thread).toHaveLength(1);
    expect(booking.thread[0].by).toBe("musician");
    expect(booking.thread[0].amountCents).toBe(15000);
    expect(booking.thread[0].expectedQuantity).toBe(1.5); // 90 minutes / 60
    expect(booking.thread[0].note).toBe("Looking forward to it!");

    const notes = await pollNotifications(curator.uid);
    expect(notes.docs.some((d) => d.data().kind === "booking" && /New booking request/.test(d.data().title))).toBe(true);
  });

  it("sets seriesId for a whole_run series occurrence, leaves it null for a per_occurrence one", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at2m");

    const wholeRunSeries = await seedSeries(curatorProfileId, "whole_run");
    const wholeRunGigId = await createOpenGig(curatorProfileId, curator.user);
    await adb.doc(`gigs/${wholeRunGigId}`).update({ seriesId: wholeRunSeries.id });

    const perOccurrenceSeries = await seedSeries(curatorProfileId, "per_occurrence");
    const perOccurrenceGigId = await createOpenGig(curatorProfileId, curator.user);
    await adb.doc(`gigs/${perOccurrenceGigId}`).update({ seriesId: perOccurrenceSeries.id });

    const { bookingId: wholeRunBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId: wholeRunGigId, musicianProfileId, offer: offerPayload() }, musician.user);
    const { bookingId: perOccurrenceBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId: perOccurrenceGigId, musicianProfileId, offer: offerPayload() }, musician.user);

    expect((await adb.doc(`bookings/${wholeRunBookingId}`).get()).data()?.seriesId).toBe(wholeRunSeries.id);
    expect((await adb.doc(`bookings/${perOccurrenceBookingId}`).get()).data()?.seriesId).toBeNull();
  });

  it("rejects an unapproved (pending) musician profile with failed-precondition", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at3c");
    const musicianOwner = await signUpTestUser(`at3m-${Date.now()}@test.com`);
    const { profileId: musicianProfileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Unfinished Act", handle: `at3m_${Date.now()}` },
      musicianOwner.user);
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musicianOwner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects once the curator profile has been rejected/unpublished after posting, even though the gig is still open", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at4c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at4m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    // Direct status flip (not reviewProfile) — isolates this guard from
    // reviewProfile's reject-from-approved cascade, which would also close
    // the gig; this test's subject is the curator re-approval re-check alone.
    await adb.doc(`profiles/${curatorProfileId}`).update({ status: "rejected" });
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a non-open gig with failed-precondition", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at5c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at5m");
    const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
      "createGig", { profileId: curatorProfileId, ...gigContent() }, curator.user); // draft, never published
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a duplicate open (gig, musician) pair with already-exists", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at6c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at6m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user))
      .rejects.toMatchObject({ code: "functions/already-exists" });
  });

  it("enforces MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE with resource-exhausted", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at7c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at7m");
    const batch = adb.batch();
    for (let i = 0; i < MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE; i++) {
      const ref = adb.collection("bookings").doc();
      const doc: BookingRequestDoc = {
        gigId: `seed-gig-${i}`, seriesId: null,
        curatorProfileId, musicianProfileId,
        initiatedBy: "musician", structure: "perHour",
        thread: [{ by: "musician", amountCents: 1000, expectedQuantity: 1, note: null, at: Date.now() }],
        awaitingSide: "curator", status: "open",
        acceptedTerms: null, deposit: null, cancellation: null,
        createdAt: Date.now(), updatedAt: Date.now(), confirmedAt: null, resolvedAt: null,
      };
      batch.set(ref, doc);
    }
    await batch.commit();
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });

  describe("bad offer input", () => {
    it("rejects a non-integer (float) amountCents", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at8c");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at8m");
      const gigId = await createOpenGig(curatorProfileId, curator.user);
      await expect(callFn("applyToGig",
        { gigId, musicianProfileId, offer: offerPayload({ amountCents: 150.5 }) }, musician.user))
        .rejects.toMatchObject({ code: "functions/invalid-argument" });
    });

    it("rejects a note over MAX_OFFER_NOTE_LENGTH (281 chars)", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at9c");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at9m");
      const gigId = await createOpenGig(curatorProfileId, curator.user);
      await expect(callFn("applyToGig",
        { gigId, musicianProfileId, offer: offerPayload({ note: "x".repeat(281) }) }, musician.user))
        .rejects.toMatchObject({ code: "functions/invalid-argument" });
    });

    it("rejects a perSet gig offer that supplies an expectedQuantity", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("at10c");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("at10m");
      const gigId = await createOpenGig(curatorProfileId, curator.user,
        { budget: { minCents: 10_000, maxCents: 50_000, structure: "perSet" } });
      await expect(callFn("applyToGig",
        { gigId, musicianProfileId, offer: offerPayload({ expectedQuantity: 3 }) }, musician.user))
        .rejects.toMatchObject({ code: "functions/invalid-argument" });
    });
  });
});

describe("offerGig", () => {
  it("happy path (mirror): curator initiates, awaitingSide is musician, musician notified", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("og1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("og1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);

    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "offerGig", { gigId, musicianProfileId, offer: offerPayload() }, curator.user);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.initiatedBy).toBe("curator");
    expect(booking.awaitingSide).toBe("musician");
    expect(booking.thread).toHaveLength(1);
    expect(booking.thread[0].by).toBe("curator");

    const notes = await pollNotifications(musician.uid);
    expect(notes.docs.some((d) => d.data().kind === "booking" && /New booking offer/.test(d.data().title))).toBe(true);
  });

  it("rejects a caller who is not a member of the gig's curator profile with permission-denied", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("og2c");
    const { profileId: musicianProfileId } = await makeApprovedMusicianProfile("og2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { user: stranger } = await signUpTestUser(`og2s-${Date.now()}@test.com`);
    await expect(callFn("offerGig", { gigId, musicianProfileId, offer: offerPayload() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("counterBooking", () => {
  it("turn-enforced: the non-awaiting side cannot counter (failed-precondition)", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cb1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("cb1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    // awaitingSide is "curator" after the apply — the musician (initiator,
    // non-awaiting) tries to counter out of turn.
    await expect(callFn("counterBooking", { bookingId, offer: offerPayload({ amountCents: 20000 }) }, musician.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("flips awaitingSide, appends the correct 'by', bumps updatedAt, notifies the other side", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cb2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("cb2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    const before = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;

    await callFn("counterBooking", { bookingId, offer: offerPayload({ amountCents: 22000 }) }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.awaitingSide).toBe("musician");
    expect(after.thread).toHaveLength(2);
    expect(after.thread[1].by).toBe("curator");
    expect(after.thread[1].amountCents).toBe(22000);
    expect(after.thread[1].expectedQuantity).toBe(1.5); // re-derived perHour from the current gig
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    const notes = await pollNotifications(musician.uid);
    expect(notes.docs.some((d) => d.data().kind === "booking" && /Countered offer/.test(d.data().title))).toBe(true);
  });

  it("enforces MAX_BOOKING_THREAD_ENTRIES with resource-exhausted", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cb3c");
    const { profileId: musicianProfileId } = await makeApprovedMusicianProfile("cb3m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const thread: OfferEntry[] = [];
    for (let i = 0; i < MAX_BOOKING_THREAD_ENTRIES; i++) {
      thread.push({
        by: i % 2 === 0 ? "musician" : "curator", amountCents: 1000 + i,
        expectedQuantity: 1.5, note: null, at: Date.now(),
      });
    }
    const bookingRef = adb.collection("bookings").doc();
    const doc: BookingRequestDoc = {
      gigId, seriesId: null, curatorProfileId, musicianProfileId,
      initiatedBy: "musician", structure: "perHour",
      thread, awaitingSide: "curator", status: "open",
      acceptedTerms: null, deposit: null, cancellation: null,
      createdAt: Date.now(), updatedAt: Date.now(), confirmedAt: null, resolvedAt: null,
    };
    await bookingRef.set(doc);
    await expect(callFn("counterBooking", { bookingId: bookingRef.id, offer: offerPayload() }, curator.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("declineBooking", () => {
  it("awaiting side declines: open -> declined, resolvedAt set, other side notified", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("db1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("db1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    await callFn("declineBooking", { bookingId }, curator.user); // awaitingSide is "curator"

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("declined");
    expect(after.resolvedAt).not.toBeNull();

    const notes = await pollNotifications(musician.uid);
    expect(notes.docs.some((d) => d.data().kind === "booking" && d.data().title === "Booking request declined")).toBe(true);
  });

  it("rejects the wrong (non-awaiting) side with failed-precondition", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("db2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("db2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    await expect(callFn("declineBooking", { bookingId }, musician.user)) // musician is NOT awaiting
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

describe("withdrawBooking", () => {
  it("non-awaiting side withdraws: open -> withdrawn, resolvedAt set, other side notified", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("wb1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("wb1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    await callFn("withdrawBooking", { bookingId }, musician.user); // musician is non-awaiting (the initiator)

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("withdrawn");
    expect(after.resolvedAt).not.toBeNull();

    const notes = await pollNotifications(curator.uid);
    expect(notes.docs.some((d) => d.data().kind === "booking" && d.data().title === "Booking request withdrawn")).toBe(true);
  });

  it("rejects the awaiting side with failed-precondition", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("wb2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("wb2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    await expect(callFn("withdrawBooking", { bookingId }, curator.user)) // curator IS awaiting
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
});

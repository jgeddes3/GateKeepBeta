import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE, MAX_BOOKING_THREAD_ENTRIES,
  DEPOSIT_PERCENT, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  type ProfileDraftInput, type BookingRequestDoc, type OfferEntry,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// 20s (not the file-wide-standard 15s), matching bookingVisibility.test.ts's
// own precedent for this suite's other unusually chain-heavy booking file:
// several tests here run 3-5 chained callables (createProfileDraft x2,
// submitProfileForReview x2, reviewProfile x2, createGig, publishGig,
// applyToGig, counterBooking, acceptBooking...) before ever reaching an
// assertion. Task 5's acceptBooking pushed the "applyToGig happy path" test
// (already ~14s of the prior 15s budget in isolation) over the edge under
// full-suite load — one more deployed function measurably adds dispatch
// overhead across all ~300+ other tests' calls too, not just this file's own.
vi.setConfig({ testTimeout: 20_000 });

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

// NOTE: the suite runs every test file against ONE persistent Firestore
// emulator instance with no reset between files (see scheduled.test.ts's own
// comment on this) — a "status: active" gigSeries doc left behind here is
// visible to scheduled.test.ts's runDailySweep, which scans every active
// series. An earlier version of this fixture used `template: {}`, which
// crashed that scan (`series.template.title` undefined) and silently
// swallowed OTHER series' legitimately-materialized occurrences for that
// run (scheduled.ts's per-step try/catch aborts the whole step, including
// already-planned-but-not-yet-committed writes, on the first throw). Give it
// a real, materializer-safe template so a stray cross-file sweep is a no-op
// rather than a crash; the "sets seriesId..." test also flips both series to
// "ended" once it's done with them, minimizing how long they're live.
function seedSeries(curatorProfileId: string, fillMode: "whole_run" | "per_occurrence") {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode, status: "active",
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    template: {
      title: "Friday Night Jazz", description: "A cozy weekly set.",
      wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
      durationMinutes: 90,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: {
        venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
        geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: "123 Main St, Austin, TX",
      },
    },
    templatePrivateLocation: { address: "123 Main St, Austin, TX", geo: { lat: 30.27, lng: -97.74 } },
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

    // Cleanup: flip both out of "active" now that this test is done with
    // them — minimizes the window where a cross-file dailySweep run (see
    // seedSeries's comment) could scan and materialize against them.
    await Promise.all([
      adb.doc(`gigSeries/${wholeRunSeries.id}`).update({ status: "ended" }),
      adb.doc(`gigSeries/${perOccurrenceSeries.id}`).update({ status: "ended" }),
    ]);
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

    // State-unchanged: exactly the first booking exists, no second landed.
    const pairSnap = await adb.collection("bookings")
      .where("gigId", "==", gigId).where("musicianProfileId", "==", musicianProfileId)
      .where("status", "==", "open").get();
    expect(pairSnap.size).toBe(1);
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

    // State-unchanged: the rejected 26th attempt must not have landed.
    const finalCount = await adb.collection("bookings")
      .where("musicianProfileId", "==", musicianProfileId)
      .where("initiatedBy", "==", "musician")
      .where("status", "==", "open")
      .count().get();
    expect(finalCount.data().count).toBe(MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE);
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

    // State-unchanged: the rejected counter must not have appended anything.
    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.thread).toHaveLength(1);
    expect(after.awaitingSide).toBe("curator");
  });

  it("rejects a stranger to both sides with permission-denied", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cb4c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("cb4m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    const { user: stranger } = await signUpTestUser(`cb4s-${Date.now()}@test.com`);
    await expect(callFn("counterBooking", { bookingId, offer: offerPayload() }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("flips awaitingSide, appends the correct 'by', bumps updatedAt, notifies the other side", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cb2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("cb2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    // Force an old updatedAt directly (rather than trusting clock resolution
    // between two calls a few ms apart) so the strict toBeGreaterThan
    // assertion below can never flake on a same-millisecond fast local run.
    const staleUpdatedAt = Date.now() - 60_000;
    await adb.doc(`bookings/${bookingId}`).update({ updatedAt: staleUpdatedAt });

    await callFn("counterBooking", { bookingId, offer: offerPayload({ amountCents: 22000 }) }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.awaitingSide).toBe("musician");
    expect(after.thread).toHaveLength(2);
    expect(after.thread[1].by).toBe("curator");
    expect(after.thread[1].amountCents).toBe(22000);
    expect(after.thread[1].expectedQuantity).toBe(1.5); // re-derived perHour from the current gig
    expect(after.updatedAt).toBeGreaterThan(staleUpdatedAt);

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

describe("acceptBooking", () => {
  it("happy path: freezes acceptedTerms from the LAST thread entry (not the first offer), computes deposit with ceil, fills the gig, sets confirmedAt, notifies both winners", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab1c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab1m");
    const gigId = await createOpenGig(curatorProfileId, curator.user, { durationMinutes: 90 });

    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload({ amountCents: 9000 }) }, musician.user);
    // Curator counters — this becomes the LAST thread entry, and must be
    // what gets frozen, not the musician's original 9000 offer. Chosen so
    // BOTH ceils actually round up: 10001c/hr * 1.5hr = 15001.5 ->
    // expectedTotalCents 15002; 15002 * 35% = 5250.7 -> deposit 5251.
    await callFn("counterBooking", { bookingId, offer: offerPayload({ amountCents: 10001 }) }, curator.user);
    // awaitingSide flipped to musician after the counter — musician accepts.

    await callFn("acceptBooking", { bookingId }, musician.user);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("confirmed");
    expect(typeof booking.confirmedAt).toBe("number");
    expect(booking.acceptedTerms).toEqual({ amountCents: 10001, expectedQuantity: 1.5, expectedTotalCents: 15002 });
    expect(booking.deposit).toEqual({
      amountCents: 5251, status: "unpaid", forfeitedTo: null,
      policy: { percent: DEPOSIT_PERCENT, curatorForfeitHours: CURATOR_FORFEIT_WINDOW_HOURS, musicianMarkHours: MUSICIAN_MARK_WINDOW_HOURS },
    });

    const gig = (await adb.doc(`gigs/${gigId}`).get()).data();
    expect(gig?.status).toBe("filled");
    expect(gig?.bookingId).toBe(bookingId);
    expect(gig?.bookedMusicianProfileId).toBe(musicianProfileId);

    const curatorNotes = await pollNotifications(curator.uid);
    expect(curatorNotes.docs.some((d) => d.data().kind === "booking" && /confirmed/i.test(d.data().title))).toBe(true);
    const musicianNotes = await pollNotifications(musician.uid);
    expect(musicianNotes.docs.some((d) => d.data().kind === "booking" && /confirmed/i.test(d.data().title))).toBe(true);
  });

  it("enforces awaitingSide — the non-awaiting side cannot accept (failed-precondition), booking left open", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab2c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab2m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    // awaitingSide is "curator" after the apply — the musician (initiator,
    // non-awaiting) tries to accept out of turn.
    await expect(callFn("acceptBooking", { bookingId }, musician.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("open");
  });

  it("rejects a stranger to both sides with permission-denied", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab3c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab3m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    const { user: stranger } = await signUpTestUser(`ab3s-${Date.now()}@test.com`);
    await expect(callFn("acceptBooking", { bookingId }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("race: gig flipped closed via admin SDK before accept -> failed-precondition, booking left open", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab4c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab4m");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    // Simulates a concurrent takedown/closure racing the accept.
    await adb.doc(`gigs/${gigId}`).update({ status: "closed" });

    await expect(callFn("acceptBooking", { bookingId }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("open");
    expect(after.acceptedTerms).toBeNull();
    expect(after.deposit).toBeNull();
  });

  it("supersede: two rival open bookings on the same gig -> loser superseded + notified, winner confirmed", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab5c");
    const { owner: winner, profileId: winnerProfileId } = await makeApprovedMusicianProfile("ab5w");
    const { owner: loser, profileId: loserProfileId } = await makeApprovedMusicianProfile("ab5l");
    const gigId = await createOpenGig(curatorProfileId, curator.user);

    const { bookingId: winnerBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: winnerProfileId, offer: offerPayload() }, winner.user);
    const { bookingId: loserBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: loserProfileId, offer: offerPayload() }, loser.user);

    await callFn("acceptBooking", { bookingId: winnerBookingId }, curator.user);

    const winnerAfter = (await adb.doc(`bookings/${winnerBookingId}`).get()).data() as BookingRequestDoc;
    expect(winnerAfter.status).toBe("confirmed");

    const loserAfter = (await adb.doc(`bookings/${loserBookingId}`).get()).data() as BookingRequestDoc;
    expect(loserAfter.status).toBe("superseded");
    expect(loserAfter.resolvedAt).not.toBeNull();

    const loserNotes = await pollNotifications(loser.uid);
    expect(loserNotes.docs.some((d) => d.data().kind === "booking" && /no longer available/i.test(d.data().title))).toBe(true);
  });

  it("whole-run: fills every currently-open occurrence, stamps the series, supersedes a rival booking on a DIFFERENT occurrence", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab6c");
    const { owner: winner, profileId: winnerProfileId } = await makeApprovedMusicianProfile("ab6w");
    const { owner: rival, profileId: rivalProfileId } = await makeApprovedMusicianProfile("ab6r");

    const series = await seedSeries(curatorProfileId, "whole_run");
    const gigId1 = await createOpenGig(curatorProfileId, curator.user);
    const gigId2 = await createOpenGig(curatorProfileId, curator.user);
    const gigId3 = await createOpenGig(curatorProfileId, curator.user);
    await Promise.all([gigId1, gigId2, gigId3].map((id) => adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

    const { bookingId: winnerBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId: gigId1, musicianProfileId: winnerProfileId, offer: offerPayload() }, winner.user);
    const { bookingId: rivalBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId: gigId2, musicianProfileId: rivalProfileId, offer: offerPayload() }, rival.user);
    expect((await adb.doc(`bookings/${winnerBookingId}`).get()).data()?.seriesId).toBe(series.id);

    await callFn("acceptBooking", { bookingId: winnerBookingId }, curator.user);

    for (const gigId of [gigId1, gigId2, gigId3]) {
      const gig = (await adb.doc(`gigs/${gigId}`).get()).data();
      expect(gig?.status).toBe("filled");
      expect(gig?.bookingId).toBe(winnerBookingId);
      expect(gig?.bookedMusicianProfileId).toBe(winnerProfileId);
    }

    const seriesAfter = (await adb.doc(`gigSeries/${series.id}`).get()).data();
    expect(seriesAfter?.activeBookingId).toBe(winnerBookingId);
    expect(seriesAfter?.bookedMusicianProfileId).toBe(winnerProfileId);

    const rivalAfter = (await adb.doc(`bookings/${rivalBookingId}`).get()).data() as BookingRequestDoc;
    expect(rivalAfter.status).toBe("superseded");

    // Cleanup — never leave an "active" gigSeries fixture behind (the shared
    // emulator's scheduled.test.ts sweep scans every active series).
    await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
  });

  it("whole-run: fails with failed-precondition when the series is paused mid-thread, booking left open", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab7c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab7m");

    const series = await seedSeries(curatorProfileId, "whole_run");
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });

    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.seriesId).toBe(series.id);

    // Series paused mid-thread — after the booking was created (and so
    // targets the whole run), before the accept.
    await adb.doc(`gigSeries/${series.id}`).update({ status: "paused" });

    await expect(callFn("acceptBooking", { bookingId }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("open");
    // Already non-active ("paused") — the shared sweep only scans
    // status:"active" series, so no further cleanup is needed.
  });

  it("tripwire: rejects a zero expectedTotalCents (a durationMinutes:0 perHour gig) with failed-precondition, never a silent $0 deposit", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ab8c");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ab8m");
    const gigId = await createOpenGig(curatorProfileId, curator.user, { durationMinutes: 90 });
    // A forgotten/corrupted duration, seeded directly (bypasses updateGig's
    // own validation, which would otherwise reject durationMinutes:0).
    await adb.doc(`gigs/${gigId}`).update({ durationMinutes: 0 });

    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);

    await expect(callFn("acceptBooking", { bookingId }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("open");
    expect(after.deposit).toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS, NO_SHOW_REPORT_WINDOW_DAYS,
  MAX_OCCURRENCE_CANCELLATIONS,
  type ProfileDraftInput, type BookingRequestDoc, type ReliabilityDoc, type CuratorBookingDoc,
  type OccurrenceCancellation,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
// 20s — matches bookingVisibility.test.ts/bookings.test.ts's precedent for
// this same family of chain-heavy booking suites (createProfileDraft x2,
// submitProfileForReview x2, reviewProfile x2, createGig, publishGig,
// applyToGig, acceptBooking, then this file's own callable under test — a
// happy path can be 8+ chained callables before the first assertion).
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

function seedSeries(curatorProfileId: string) {
  const ref = adb.collection("gigSeries").doc();
  return ref.set({
    curatorProfileId, fillMode: "whole_run", status: "active",
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

async function pollNotifications(uid: string) {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

// Sets a gig's startsAt relative to "now" AT THE MOMENT THIS RUNS — called
// immediately before the boundary-sensitive callable under test, never
// before the (multi-call, multi-second) profile/gig/booking setup chain.
// That ordering matters: the setup chain's own wall-clock time would
// otherwise erode any fixed buffer computed before it ran.
async function setGigStartsAt(gigId: string, hoursFromNow: number): Promise<void> {
  await adb.doc(`gigs/${gigId}`).update({ startsAt: Date.now() + hoursFromNow * 3_600_000 });
}

// Builds a real, fully confirmed single-gig booking (through the actual
// applyToGig -> acceptBooking chain, so membership docs/deposit/acceptedTerms
// are all genuine) — the shared starting point for the single-gig
// cancelBooking/reportNoShow tests below. Callers then use setGigStartsAt to
// control timing precisely right before the callable under test.
async function makeConfirmedBooking(prefix: string, gigOverrides: Record<string, unknown> = {}) {
  const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile(`${prefix}c`);
  const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile(`${prefix}m`);
  const gigId = await createOpenGig(curatorProfileId, curator.user, gigOverrides);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
  await callFn("acceptBooking", { bookingId }, curator.user);
  return { curator, musician, curatorProfileId, musicianProfileId, gigId, bookingId };
}

describe("recomputeReliability / cancelBooking", () => {
  it("curator cancels at 80h before start: refund, forfeitedTo stays null", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("cb80");
    await setGigStartsAt(gigId, 80);

    await callFn("cancelBooking", { bookingId, reason: "Double-booked the venue." }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("cancelled_by_curator");
    expect(after.cancellation?.outcome).toBe("deposit_refunded");
    expect(after.cancellation?.markApplied).toBe(false);
    expect(after.deposit?.forfeitedTo).toBeNull();
    expect(typeof after.resolvedAt).toBe("number");

    const gig = (await adb.doc(`gigs/${gigId}`).get()).data();
    expect(gig?.status).toBe("open");
    expect(gig?.bookingId).toBeNull();
    expect(gig?.bookedMusicianProfileId).toBeNull();
  });

  it("curator cancels at 71.9h before start: forfeited to the musician, gig reopens", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("cb719");
    await setGigStartsAt(gigId, 71.9);

    await callFn("cancelBooking", { bookingId, reason: "Venue flooded." }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.cancellation?.outcome).toBe("deposit_forfeited");
    expect(after.deposit?.forfeitedTo).toBe("musician");

    const gig = (await adb.doc(`gigs/${gigId}`).get()).data();
    expect(gig?.status).toBe("open");
    expect(gig?.bookingId).toBeNull();
  });

  it("boundary: EXACTLY CURATOR_FORFEIT_WINDOW_HOURS refunds (strict less-than only forfeits)", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("cb720");
    // 60s buffer over the exact boundary, applied immediately before the
    // single remaining call (cancelBooking) — comfortably survives normal
    // emulator round-trip time while staying on the refund side of the
    // strict "< CURATOR_FORFEIT_WINDOW_HOURS" comparison. See
    // setGigStartsAt's comment on why this must happen this late, not
    // before the setup chain above.
    const BOUNDARY_BUFFER_MS = 60_000;
    await adb.doc(`gigs/${gigId}`).update({
      startsAt: Date.now() + CURATOR_FORFEIT_WINDOW_HOURS * 3_600_000 + BOUNDARY_BUFFER_MS,
    });

    await callFn("cancelBooking", { bookingId, reason: "Change of plans." }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.cancellation?.outcome).toBe("deposit_refunded");
    expect(after.deposit?.forfeitedTo).toBeNull();
  });

  // F6 (security audit wave): the window thresholds must be read from THIS
  // booking's OWN frozen deposit.policy snapshot, never re-read live from
  // the shared constants — a later change to the shared constants (or, as
  // here, a directly-modified snapshot) must not retroactively change the
  // deal the two sides actually accepted. 80h is on the REFUND side of the
  // live CURATOR_FORFEIT_WINDOW_HOURS constant (72h) but on the FORFEIT
  // side of this booking's own (modified) 100h snapshot — proving the
  // snapshot, not the live constant, governs.
  it("F6: cancellation windows are read from the booking's OWN deposit.policy snapshot, not the live shared constant", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("f6pol");
    await adb.doc(`bookings/${bookingId}`).update({ "deposit.policy.curatorForfeitHours": 100 });
    await setGigStartsAt(gigId, 80);

    await callFn("cancelBooking", { bookingId, reason: "Testing the policy snapshot." }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.cancellation?.outcome).toBe("deposit_forfeited");
    expect(after.deposit?.forfeitedTo).toBe("musician");
  });

  it("musician cancels at 30h before start: refund, no mark", async () => {
    const { musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("mb30");
    await setGigStartsAt(gigId, 30);

    await callFn("cancelBooking", { bookingId, reason: "Illness." }, musician.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("cancelled_by_musician");
    expect(after.cancellation?.outcome).toBe("deposit_refunded");
    expect(after.cancellation?.markApplied).toBe(false);

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
    expect(reliability).toBeUndefined();
  });

  it("musician cancels at 20h before start: mark applied, reliability doc + curatorBooking projection count 1", async () => {
    const { musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("mb20");
    await setGigStartsAt(gigId, 20);

    await callFn("cancelBooking", { bookingId, reason: "Van broke down." }, musician.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.cancellation?.markApplied).toBe(true);

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data() as ReliabilityDoc;
    expect(reliability.marks).toHaveLength(1);
    expect(reliability.marks[0]).toMatchObject({ bookingId, kind: "late_cancel", removedByAdmin: false });

    const curatorBooking = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get())
      .data() as CuratorBookingDoc;
    expect(curatorBooking.reliability.noShowCount).toBe(1);
  });

  it("boundary: EXACTLY MUSICIAN_MARK_WINDOW_HOURS before start applies no mark (strict less-than only marks)", async () => {
    const { musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("mb24");
    // Mirrors the 72h boundary test's rationale above — buffer applied
    // immediately before the single remaining call (cancelBooking).
    const BOUNDARY_BUFFER_MS = 60_000;
    await adb.doc(`gigs/${gigId}`).update({
      startsAt: Date.now() + MUSICIAN_MARK_WINDOW_HOURS * 3_600_000 + BOUNDARY_BUFFER_MS,
    });

    await callFn("cancelBooking", { bookingId, reason: "Change of plans." }, musician.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.cancellation?.outcome).toBe("deposit_refunded");
    expect(after.cancellation?.markApplied).toBe(false);

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
    expect(reliability).toBeUndefined();
  });

  it("cancel after the gig has already started: failed-precondition (report instead)", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("cbpast");
    await setGigStartsAt(gigId, -1); // 1 hour in the past

    await expect(callFn("cancelBooking", { bookingId, reason: "Too late now." }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("a caller who is a member of BOTH sides is refused with failed-precondition (ambiguous)", async () => {
    const { curator, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("cbamb");
    await setGigStartsAt(gigId, 50);
    // Make the curator's own owner ALSO a member of the musician profile —
    // deliberately admin-SDK direct (no invite flow needed for this test).
    await adb.doc(`profiles/${musicianProfileId}/members/${curator.uid}`).set({
      uid: curator.uid, role: "member", label: "also here", joinedAt: Date.now(),
    });

    await expect(callFn("cancelBooking", { bookingId, reason: "Ambiguous caller." }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // State unchanged — the ambiguous attempt must not have cancelled anything.
    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("confirmed");
  });

  it("notifies both sides with outcome-specific copy", async () => {
    const { curator, musician, bookingId, gigId } = await makeConfirmedBooking("cbnote");
    await setGigStartsAt(gigId, 10); // forfeit window

    await callFn("cancelBooking", { bookingId, reason: "Emergency." }, curator.user);

    const curatorNotes = await pollNotifications(curator.uid);
    expect(curatorNotes.docs.some((d) => d.data().kind === "booking" && d.data().title === "Booking cancelled"
      && /forfeited to the musician/i.test(d.data().body))).toBe(true);
    const musicianNotes = await pollNotifications(musician.uid);
    expect(musicianNotes.docs.some((d) => d.data().kind === "booking" && d.data().title === "Booking cancelled"
      && /forfeited to you/i.test(d.data().body))).toBe(true);
  });

  describe("whole-run", () => {
    it("cancelling mid-run reopens future occurrences, leaves a past/started one untouched, clears series linkage, records exactly one mark for a <24h musician cancel", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("wrcbc");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("wrcbm");
      const series = await seedSeries(curatorProfileId);
      try {
        // publishGig rejects a past startsAt outright — create it with a
        // future placeholder, then push it into the past via the admin SDK
        // (mirrors setGigStartsAt's rationale).
        const gigPast = await createOpenGig(curatorProfileId, curator.user);
        await setGigStartsAt(gigPast, -1);
        const gigNext = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 20 * 3_600_000 });
        const gigLater = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 100 * 3_600_000 });
        await Promise.all([gigPast, gigNext, gigLater].map((id) =>
          adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

        const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
          "applyToGig", { gigId: gigNext, musicianProfileId, offer: offerPayload() }, musician.user);
        await callFn("acceptBooking", { bookingId }, curator.user);

        // Sanity: acceptBooking filled all three, including the past one.
        expect((await adb.doc(`gigs/${gigPast}`).get()).data()?.status).toBe("filled");

        await callFn("cancelBooking", { bookingId, reason: "Musician pulled out." }, musician.user);

        const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
        expect(after.status).toBe("cancelled_by_musician");
        // hoursBeforeStart computed against gigNext (~20h) — the earliest
        // FUTURE filled occurrence, not gigLater (~100h).
        expect(after.cancellation?.hoursBeforeStart).toBeLessThan(MUSICIAN_MARK_WINDOW_HOURS);
        expect(after.cancellation?.markApplied).toBe(true);

        const [pastAfter, nextAfter, laterAfter] = await Promise.all(
          [gigPast, gigNext, gigLater].map((id) => adb.doc(`gigs/${id}`).get()));
        expect(pastAfter.data()?.status).toBe("filled"); // untouched — already started
        expect(pastAfter.data()?.bookingId).toBe(bookingId);
        expect(nextAfter.data()?.status).toBe("open");
        expect(nextAfter.data()?.bookingId).toBeNull();
        expect(laterAfter.data()?.status).toBe("open");
        expect(laterAfter.data()?.bookedMusicianProfileId).toBeNull();

        const seriesAfter = (await adb.doc(`gigSeries/${series.id}`).get()).data();
        expect(seriesAfter?.activeBookingId).toBeNull();
        expect(seriesAfter?.bookedMusicianProfileId).toBeNull();

        const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
          .data() as ReliabilityDoc;
        expect(reliability.marks).toHaveLength(1);
      } finally {
        // Never leave an active series behind for the shared emulator's
        // dailySweep scan (mirrors bookings.test.ts's identical rationale).
        await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
      }
    });

    it("whole-run cancel with no future filled occurrence left, but the booking's last occurrence is in the PAST: keeps 'already started' advice", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("wrpastc");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("wrpastm");
      const series = await seedSeries(curatorProfileId);
      try {
        const gigId = await createOpenGig(curatorProfileId, curator.user);
        await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });
        const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
          "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
        await callFn("acceptBooking", { bookingId }, curator.user);
        await adb.doc(`gigs/${gigId}`).update({ startsAt: Date.now() - 3_600_000 }); // now in the past

        // The gig still names this booking (bookingId untouched, only its
        // startsAt moved) — the run genuinely already started, so
        // "already started — report instead" is truthful advice here.
        await expect(callFn("cancelBooking", { bookingId, reason: "Too late." }, curator.user)).rejects.toMatchObject({
          code: "functions/failed-precondition",
          message: expect.stringMatching(/already started/i),
        });
      } finally {
        await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
      }
    });

    // SP4 (Task 7) carry-forward (b) — the zombie-run message.
    it("whole-run cancel with no future filled occurrence left AND no date currently linked to this booking (cancelled per-occurrence): truthful 'nothing to cancel' message, NOT 'already started'", async () => {
      const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("wrzombiec");
      const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("wrzombiem");
      const series = await seedSeries(curatorProfileId);
      try {
        const gigId = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 50 * 3_600_000 });
        await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });
        const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
          "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
        await callFn("acceptBooking", { bookingId }, curator.user);

        // Cancel the run's only date PER-OCCURRENCE — the run survives
        // (booking stays "confirmed"), but cancelOccurrence clears the gig's
        // own bookingId on reopen, so no gig anywhere still names this
        // booking's id, and none of its own occurrences remain future+filled.
        await callFn("cancelOccurrence", { bookingId, gigId, reason: "Scheduling conflict." }, curator.user);
        expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.status).toBe("confirmed");
        expect((await adb.doc(`gigs/${gigId}`).get()).data()?.bookingId).toBeNull();

        await expect(callFn("cancelBooking", { bookingId, reason: "Trying to cancel anyway." }, curator.user))
          .rejects.toMatchObject({
            code: "functions/failed-precondition",
            message: expect.stringMatching(/no upcoming booked dates remain/i),
          });

        // Untouched — the refusal must not have changed the booking's status.
        expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.status).toBe("confirmed");
      } finally {
        await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
      }
    });
  });
});

describe("cancelOccurrence", () => {
  it("the run survives (booking stays confirmed), the named date reopens, an occurrenceCancellations entry is recorded", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("cocc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ocm");
    const series = await seedSeries(curatorProfileId);
    try {
      const gigId1 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 20 * 3_600_000 });
      const gigId2 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 200 * 3_600_000 });
      await Promise.all([gigId1, gigId2].map((id) => adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gigId1, musicianProfileId, offer: offerPayload() }, musician.user);
      await callFn("acceptBooking", { bookingId }, curator.user);

      await callFn("cancelOccurrence",
        { bookingId, gigId: gigId1, reason: "Curator has a scheduling conflict that day." }, curator.user);

      const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(after.status).toBe("confirmed"); // run survives
      expect(after.occurrenceCancellations).toHaveLength(1);
      // gigId1 starts ~20h out — under CURATOR_FORFEIT_WINDOW_HOURS (72h),
      // so this per-date outcome forfeits (curator side never marks).
      expect(after.occurrenceCancellations?.[0]).toMatchObject({
        gigId: gigId1, by: "curator", outcome: "deposit_forfeited", markApplied: false,
      });
      // hoursBeforeStart is positive — this date hasn't happened yet (unlike
      // reportNoShow's always-negative value for an already-passed start).
      expect(after.occurrenceCancellations?.[0].hoursBeforeStart).toBeGreaterThan(0);
      // Run-level deposit untouched by a per-occurrence cancellation.
      expect(after.deposit?.forfeitedTo).toBeNull();

      const [gig1After, gig2After] = await Promise.all(
        [gigId1, gigId2].map((id) => adb.doc(`gigs/${id}`).get()));
      expect(gig1After.data()?.status).toBe("open");
      expect(gig1After.data()?.bookingId).toBeNull();
      expect(gig2After.data()?.status).toBe("filled"); // the rest of the run continues
      expect(gig2After.data()?.bookingId).toBe(bookingId);

      const seriesAfter = (await adb.doc(`gigSeries/${series.id}`).get()).data();
      expect(seriesAfter?.activeBookingId).toBe(bookingId); // series-level linkage untouched
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });

  it("rejects a single-gig (non-whole-run) booking with failed-precondition", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("occ1s");
    await expect(callFn("cancelOccurrence", { bookingId, gigId, reason: "n/a" }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("musician <24h cancel of one date applies exactly one mark", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("occmc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("occmm");
    const series = await seedSeries(curatorProfileId);
    try {
      const gigId1 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 10 * 3_600_000 });
      const gigId2 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 300 * 3_600_000 });
      await Promise.all([gigId1, gigId2].map((id) => adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gigId1, musicianProfileId, offer: offerPayload() }, musician.user);
      await callFn("acceptBooking", { bookingId }, curator.user);

      await callFn("cancelOccurrence", { bookingId, gigId: gigId1, reason: "Can't make it that night." }, musician.user);

      const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      // Musician side never forfeits the curator's deposit (refunded always),
      // but a <24h cancel does apply a mark; hoursBeforeStart stays positive
      // (this date hasn't happened yet).
      expect(after.occurrenceCancellations?.[0]).toMatchObject({
        gigId: gigId1, by: "musician", outcome: "deposit_refunded", markApplied: true,
      });
      expect(after.occurrenceCancellations?.[0].hoursBeforeStart).toBeGreaterThan(0);

      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
        .data() as ReliabilityDoc;
      expect(reliability.marks).toHaveLength(1);
      expect(reliability.marks[0]).toMatchObject({ bookingId, gigId: gigId1, kind: "late_cancel" });
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });

  // F7 (security audit wave, ruling: reject-when-full): once
  // occurrenceCancellations is already at MAX_OCCURRENCE_CANCELLATIONS, a
  // further cancelOccurrence call must be REFUSED outright — never silently
  // drop the oldest settlement record to make room for a new one.
  it("F7: refuses with resource-exhausted once occurrenceCancellations is at the cap; the array is left unchanged", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("occcap");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("occcapm");
    const series = await seedSeries(curatorProfileId);
    try {
      const gigId = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 50 * 3_600_000 });
      await adb.doc(`gigs/${gigId}`).update({ seriesId: series.id });
      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
      await callFn("acceptBooking", { bookingId }, curator.user);

      const fullArray: OccurrenceCancellation[] = Array.from(
        { length: MAX_OCCURRENCE_CANCELLATIONS }, (_, i) => ({
          gigId: `filler-gig-${i}`, by: "curator" as const, at: Date.now(), hoursBeforeStart: 100,
          outcome: "deposit_refunded" as const, markApplied: false,
        }));
      await adb.doc(`bookings/${bookingId}`).update({ occurrenceCancellations: fullArray });

      await expect(callFn("cancelOccurrence", { bookingId, gigId, reason: "One too many." }, curator.user))
        .rejects.toMatchObject({ code: "functions/resource-exhausted" });

      const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(after.occurrenceCancellations).toHaveLength(MAX_OCCURRENCE_CANCELLATIONS);
      expect(after.occurrenceCancellations).toEqual(fullArray); // unchanged, nothing dropped or appended
      // A refused call must not have touched the gig either.
      expect((await adb.doc(`gigs/${gigId}`).get()).data()?.status).toBe("filled");
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });
});

describe("reportNoShow", () => {
  it("a completed booking whose start has passed: flips to cancelled_by_musician, appends a mark, updates the projection, notifies the musician", async () => {
    const { curator, musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("nsc1");
    await setGigStartsAt(gigId, -5); // 5 hours ago
    await adb.doc(`bookings/${bookingId}`).update({ status: "completed" });

    await callFn("reportNoShow", { bookingId, reason: "Never showed up, no contact." }, curator.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("cancelled_by_musician");
    expect(after.cancellation).toMatchObject({ by: "musician", outcome: "deposit_refunded", markApplied: true });
    expect(after.cancellation?.hoursBeforeStart).toBeLessThan(0);

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(reliability.marks).toHaveLength(1);
    expect(reliability.marks[0]).toMatchObject({ bookingId, kind: "reported_no_show" });

    const curatorBooking = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get())
      .data() as CuratorBookingDoc;
    expect(curatorBooking.reliability.noShowCount).toBe(1);

    const musicianNotes = await pollNotifications(musician.uid);
    expect(musicianNotes.docs.some((d) => d.data().kind === "booking" && /no-show/i.test(d.data().title))).toBe(true);
  });

  it("reporting the same booking twice: the second call fails with already-exists", async () => {
    const { curator, bookingId, gigId } = await makeConfirmedBooking("nsdbl");
    await setGigStartsAt(gigId, -3);

    await callFn("reportNoShow", { bookingId, reason: "No-show." }, curator.user);
    await expect(callFn("reportNoShow", { bookingId, reason: "Reporting again." }, curator.user))
      .rejects.toMatchObject({ code: "functions/already-exists" });
  });

  it("more than NO_SHOW_REPORT_WINDOW_DAYS after the start: failed-precondition, no mark appended", async () => {
    const { curator, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("nswin");
    await setGigStartsAt(gigId, -(NO_SHOW_REPORT_WINDOW_DAYS + 1) * 24);

    await expect(callFn("reportNoShow", { bookingId, reason: "Too late to report." }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // Rejected before any write — the reliability doc must never have been
    // touched (no doc created, so no marks either).
    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
    expect(reliability).toBeUndefined();
  });

  it("a curator from an unrelated profile: permission-denied", async () => {
    const { bookingId, gigId } = await makeConfirmedBooking("nsstr");
    await setGigStartsAt(gigId, -3);
    const { owner: strangerCurator } = await makeApprovedCuratorProfile("nsstx");

    await expect(callFn("reportNoShow", { bookingId, reason: "Not my booking." }, strangerCurator.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("the musician side cannot report a no-show on themselves: permission-denied", async () => {
    const { musician, bookingId, gigId } = await makeConfirmedBooking("nsmus");
    await setGigStartsAt(gigId, -3);

    await expect(callFn("reportNoShow", { bookingId, reason: "n/a" }, musician.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  // Plan amendment (docs/superpowers/plans/2026-08-26-booking-flow.md, Task
  // 6 reportNoShow bullet): a whole-run no-show ends the run for this
  // booking exactly like cancelBooking does — the run's remaining future
  // dates must reopen and the series linkage must clear, not sit "filled"
  // against a booking that has already flipped to cancelled_by_musician.
  it("whole-run: reopens the run's future filled occurrences, clears series linkage, leaves the reported (past) occurrence untouched", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("nswrc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("nswrm");
    const series = await seedSeries(curatorProfileId);
    try {
      // publishGig rejects a past startsAt outright — create with a future
      // placeholder, then push it into the past (mirrors setGigStartsAt's
      // rationale elsewhere in this file).
      const gigPast = await createOpenGig(curatorProfileId, curator.user);
      await setGigStartsAt(gigPast, -3);
      const gigNext = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 20 * 3_600_000 });
      const gigLater = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 100 * 3_600_000 });
      await Promise.all([gigPast, gigNext, gigLater].map((id) =>
        adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

      const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gigNext, musicianProfileId, offer: offerPayload() }, musician.user);
      await callFn("acceptBooking", { bookingId }, curator.user);

      // Sanity: acceptBooking filled all three, including the past one.
      expect((await adb.doc(`gigs/${gigPast}`).get()).data()?.status).toBe("filled");

      await callFn("reportNoShow", { bookingId, reason: "Never showed up for the run." }, curator.user);

      const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(after.status).toBe("cancelled_by_musician");
      expect(after.cancellation?.hoursBeforeStart).toBeLessThan(0);

      const [pastAfter, nextAfter, laterAfter] = await Promise.all(
        [gigPast, gigNext, gigLater].map((id) => adb.doc(`gigs/${id}`).get()));
      expect(pastAfter.data()?.status).toBe("filled"); // untouched — this is the reported occurrence itself
      expect(pastAfter.data()?.bookingId).toBe(bookingId);
      expect(nextAfter.data()?.status).toBe("open");
      expect(nextAfter.data()?.bookingId).toBeNull();
      expect(nextAfter.data()?.bookedMusicianProfileId).toBeNull();
      expect(laterAfter.data()?.status).toBe("open");
      expect(laterAfter.data()?.bookedMusicianProfileId).toBeNull();

      const seriesAfter = (await adb.doc(`gigSeries/${series.id}`).get()).data();
      expect(seriesAfter?.activeBookingId).toBeNull();
      expect(seriesAfter?.bookedMusicianProfileId).toBeNull();

      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
        .data() as ReliabilityDoc;
      expect(reliability.marks).toHaveLength(1);
      expect(reliability.marks[0]).toMatchObject({ bookingId, gigId: gigPast, kind: "reported_no_show" });
    } finally {
      // Never leave an active series behind for the shared emulator's
      // dailySweep scan (mirrors this file's other whole-run fixtures).
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });
});

describe("removeReliabilityMark", () => {
  it("admin removal sets removedByAdmin (never splices), drops the projection count, writes an audit entry", async () => {
    const { profileId: musicianProfileId } = await makeApprovedMusicianProfile("rrmok");
    const seedMark = {
      bookingId: "seed-booking-1", gigId: "seed-gig-1", kind: "late_cancel" as const,
      at: Date.now(), reportedByProfileId: null, removedByAdmin: false,
    };
    await adb.doc(`profiles/${musicianProfileId}/private/reliability`).set({
      marks: [seedMark], completedCount: 0, updatedAt: Date.now(),
    });
    const admin = await makeAdminUser("rrmadmin");

    await callFn("removeReliabilityMark",
      { musicianProfileId, bookingId: "seed-booking-1", kind: "late_cancel" }, admin.user);

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(reliability.marks).toHaveLength(1); // not spliced
    expect(reliability.marks[0].removedByAdmin).toBe(true);

    const curatorBooking = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get())
      .data() as CuratorBookingDoc;
    expect(curatorBooking.reliability.noShowCount).toBe(0);

    const auditSnap = await adb.collection("auditLogs")
      .where("action", "==", "reliability_mark_removed").where("targetId", "==", musicianProfileId).get();
    expect(auditSnap.empty).toBe(false);
  });

  // F4 (security audit wave): reversing a FALSE reported_no_show also
  // restores the settlement record the false report stole — the booking
  // goes back to "completed" (what scheduled.ts step 7 would have resolved
  // it to had the report never happened), completedCount is netted back,
  // and both sides are notified.
  it("F4: reversing a false reported_no_show restores the booking to completed and nets completedCount, notifying both sides", async () => {
    const { curator, musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("f4fr");
    await setGigStartsAt(gigId, -5); // 5 hours ago
    await callFn("reportNoShow", { bookingId, reason: "Never showed up." }, curator.user);

    const beforeAdmin = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(beforeAdmin.status).toBe("cancelled_by_musician");
    const depositBefore = beforeAdmin.deposit;
    const acceptedTermsBefore = beforeAdmin.acceptedTerms;

    const admin = await makeAdminUser("f4fra");
    await callFn("removeReliabilityMark",
      { musicianProfileId, bookingId, kind: "reported_no_show" }, admin.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("completed");
    expect(after.cancellation).toBeNull();
    expect(after.deposit).toEqual(depositBefore); // untouched
    expect(after.acceptedTerms).toEqual(acceptedTermsBefore); // untouched

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(reliability.completedCount).toBe(1);
    const curatorBooking = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get())
      .data() as CuratorBookingDoc;
    expect(curatorBooking.reliability.completedCount).toBe(1);
    expect(curatorBooking.reliability.noShowCount).toBe(0); // the mark itself was also removed

    const musicianNotes = await pollNotifications(musician.uid);
    expect(musicianNotes.docs.some((d) =>
      d.data().kind === "booking" && /restored as completed/i.test(d.data().body as string))).toBe(true);
    const curatorNotes = await pollNotifications(curator.uid);
    expect(curatorNotes.docs.some((d) =>
      d.data().kind === "booking" && /restored as completed/i.test(d.data().body as string))).toBe(true);
  });

  it("F4: removing a late_cancel mark does NOT touch the booking — the cancellation was real, only the mark judgment changes", async () => {
    const { musician, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("f4lc");
    await setGigStartsAt(gigId, 20); // <24h -> mark applied
    await callFn("cancelBooking", { bookingId, reason: "Van broke down." }, musician.user);

    const beforeAdmin = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(beforeAdmin.status).toBe("cancelled_by_musician");
    expect(beforeAdmin.cancellation?.markApplied).toBe(true);

    const admin = await makeAdminUser("f4lca");
    await callFn("removeReliabilityMark",
      { musicianProfileId, bookingId, kind: "late_cancel" }, admin.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("cancelled_by_musician"); // untouched
    expect(after.cancellation).toEqual(beforeAdmin.cancellation); // untouched, still present

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(reliability.completedCount).toBe(0); // no restoration credit
  });

  // R1 (post-audit residual): a booking the sweep already resolved to
  // "completed" (crediting completedCount once) that is THEN falsely
  // reported as a no-show must have that credit clawed back by reportNoShow
  // itself — otherwise sweep(+1) -> report(no change) -> admin restore(+1)
  // nets 2 for one single performance. The restore's own +1 is then the
  // correct, single credit for the one show that actually happened.
  it("R1/R2: sweep-completed booking -> reportNoShow nets completedCount back to 0 -> admin restore lands exactly 1", async () => {
    const { curator, musicianProfileId, bookingId, gigId } = await makeConfirmedBooking("r1a");
    await setGigStartsAt(gigId, -5); // 5 hours ago
    // Simulate scheduled.ts's sweep step 7 having already completed + credited
    // this booking (this file's subject is the callables, not the sweep
    // itself — scheduled.test.ts owns that; seeding directly isolates this
    // test to reportNoShow/removeReliabilityMark's own netting logic).
    await adb.doc(`bookings/${bookingId}`).update({ status: "completed", resolvedAt: Date.now() });
    await adb.doc(`profiles/${musicianProfileId}/private/reliability`).set({
      marks: [], completedCount: 1, updatedAt: Date.now(),
    });

    await callFn("reportNoShow", { bookingId, reason: "Actually never showed." }, curator.user);

    const afterReport = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(afterReport.completedCount).toBe(0); // netted back — the sweep's credit reversed

    const admin = await makeAdminUser("r1aa");
    await callFn("removeReliabilityMark",
      { musicianProfileId, bookingId, kind: "reported_no_show" }, admin.user);

    const afterRestore = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(afterRestore.completedCount).toBe(1); // exactly one credit for the one performance

    const bookingAfter = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(bookingAfter.status).toBe("completed");
  });

  // R2 (post-audit residual): restoreFalselyReportedBooking must match the
  // sweep's own selfDeal exclusion (F5) — the booking still genuinely
  // resolves back to "completed" (the STATUS restore always happens), but a
  // self-dealing profile must never be able to farm the trust metric via a
  // reversed false-report either.
  it("R2: a selfDeal booking's false-report restore leaves completedCount at 0 while status returns to completed", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("r2sdc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("r2sdm");
    // Overlap: the MUSICIAN's own owner uid is ALSO a member of the
    // CURATOR profile (mirrors bookings.test.ts's F5 fixture — this
    // direction keeps the curator's own acceptBooking/reportNoShow calls
    // below unambiguous, since requireBookingSide/resolveBookingSideStrict
    // resolve a dual-member caller musician-first).
    await adb.doc(`profiles/${curatorProfileId}/members/${musician.uid}`).set({
      uid: musician.uid, role: "member", label: "also here", joinedAt: Date.now(),
    });
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user);
    await callFn("acceptBooking", { bookingId }, curator.user);
    expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.selfDeal).toBe(true);

    await setGigStartsAt(gigId, -5);
    await callFn("reportNoShow", { bookingId, reason: "Never showed." }, curator.user);

    const admin = await makeAdminUser("r2sda");
    await callFn("removeReliabilityMark",
      { musicianProfileId, bookingId, kind: "reported_no_show" }, admin.user);

    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("completed"); // restored — the status flip is unconditional

    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get())
      .data() as ReliabilityDoc;
    expect(reliability.completedCount ?? 0).toBe(0); // selfDeal — no trust-metric credit
  });

  it("non-admin callers are denied", async () => {
    const { profileId: musicianProfileId } = await makeApprovedMusicianProfile("rrmna");
    await adb.doc(`profiles/${musicianProfileId}/private/reliability`).set({
      marks: [{
        bookingId: "seed-booking-2", gigId: "seed-gig-2", kind: "late_cancel",
        at: Date.now(), reportedByProfileId: null, removedByAdmin: false,
      }], completedCount: 0, updatedAt: Date.now(),
    });
    const { user: stranger } = await signUpTestUser(`rrmna-s-${Date.now()}@test.com`);

    await expect(callFn("removeReliabilityMark",
      { musicianProfileId, bookingId: "seed-booking-2", kind: "late_cancel" }, stranger))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("no matching mark: not-found", async () => {
    const { profileId: musicianProfileId } = await makeApprovedMusicianProfile("rrmnf");
    const admin = await makeAdminUser("rrmnfadmin");

    await expect(callFn("removeReliabilityMark",
      { musicianProfileId, bookingId: "no-such-booking", kind: "late_cancel" }, admin.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
});

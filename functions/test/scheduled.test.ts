import { describe, it, expect, vi } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  MAX_OPEN_GIGS_PER_PROFILE,
  type GigSeriesDoc, type GigDoc, type InviteDoc, type TrackDoc, type SeriesCadence, type BookingRequestDoc,
} from "@gatekeep/shared";
import { runDailySweep } from "../src/scheduled.js";
import { wait } from "./helpers";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 15_000 });

const DAY_MS = 86_400_000;
const SEED_ADDRESS = "123 Main St, Austin, TX";
const SEED_LOCATION: GigDoc["location"] = {
  venueName: "The Green Room", neighborhood: "Downtown", city: "Austin",
  geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: SEED_ADDRESS,
};
const SEED_PRIVATE_LOCATION = { address: SEED_ADDRESS, geo: { lat: 30.27, lng: -97.74 } };

// Independent oracle for the anchor computation (NOT a copy of scheduled.ts's
// implementation) — walks forward day by day from createdAt (UTC calendar
// day) until it lands on the target weekday, then sets hour/minute; if that
// lands before createdAt (same weekday, earlier time of day) rolls forward a
// full week. Used to compute the expected first-occurrence timestamp so the
// tests assert an actual calendar fact, not just "whatever the code returns."
function expectedAnchor(createdAt: number, weekday: number, hour: number, minute: number): number {
  let d = new Date(createdAt);
  let day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  while (new Date(day).getUTCDay() !== weekday) day += DAY_MS;
  if (day < createdAt) day += 7 * DAY_MS;
  return day;
}

let profileCounter = 0;
function fakeProfileId(): string { return `sched-profile-${Date.now()}-${profileCounter++}`; }

// `overrides.recurrence`, when given, must be a COMPLETE recurrence object
// (all 5 fields) — it wholesale-replaces the default below via the trailing
// spread, matching gigSeries.test.ts's seed-fixture convention.
async function seedSeries(
  overrides: Partial<GigSeriesDoc> = {},
): Promise<{ seriesId: string; profileId: string; createdAt: number }> {
  const profileId = fakeProfileId();
  const createdAt = overrides.createdAt ?? Date.now();
  const ref = adb.collection("gigSeries").doc();
  const doc: GigSeriesDoc = {
    curatorProfileId: profileId,
    recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
    fillMode: "per_occurrence",
    template: {
      title: "Friday Night Jazz", description: "A cozy weekly set.",
      wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
      durationMinutes: 90,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: SEED_LOCATION,
    },
    templatePrivateLocation: SEED_PRIVATE_LOCATION,
    status: "active", materializedThrough: 0,
    createdAt, updatedAt: createdAt,
    activeBookingId: null, bookedMusicianProfileId: null,
    ...overrides,
  };
  await ref.set(doc);
  return { seriesId: ref.id, profileId, createdAt };
}

async function occurrencesFor(seriesId: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await adb.collection("gigs").where("seriesId", "==", seriesId).get();
  return snap.docs.sort((a, b) => (a.data().startsAt as number) - (b.data().startsAt as number));
}

async function seedOccurrence(seriesId: string, profileId: string, overrides: Partial<GigDoc> = {}): Promise<string> {
  const ref = adb.collection("gigs").doc();
  const now = Date.now();
  const doc: GigDoc = {
    curatorProfileId: profileId, seriesId, detachedFromTemplate: false,
    title: "Seeded occurrence", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
    budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
    startsAt: now, durationMinutes: 60,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    location: SEED_LOCATION,
    status: "open", createdAt: now, updatedAt: now,
    bookingId: null, bookedMusicianProfileId: null,
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

async function seedTrack(profileId: string, overrides: Partial<TrackDoc> = {}): Promise<string> {
  const ref = adb.collection(`profiles/${profileId}/tracks`).doc();
  const now = Date.now();
  const doc: TrackDoc = {
    title: "Track", status: "processing", uploaderUid: "uploader-uid",
    startSec: 0, durationSec: null, storagePath: null,
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

async function seedInvite(overrides: Partial<InviteDoc> = {}): Promise<string> {
  const ref = adb.collection("invites").doc();
  const doc: InviteDoc = {
    profileId: fakeProfileId(), profileName: "A Profile", invitedUid: "invited-uid",
    role: "member", label: "x", invitedByUid: "inviter-uid", status: "pending", createdAt: Date.now(),
    ...overrides,
  };
  await ref.set(doc);
  return ref.id;
}

// ---------- SP4 Task 8: booking sweep + run-aware materializer fixtures ----------

let uidCounter = 0;
function fakeUid(): string { return `sched-uid-${Date.now()}-${uidCounter++}`; }

// notifyProfileMembers fans out to every doc in profiles/{id}/members — the
// doc's own content is never read, only its id (the uid), so an empty stub
// is enough to make a profile "have a member" for notification-delivery
// assertions.
async function seedMember(profileId: string, uid: string): Promise<void> {
  await adb.doc(`profiles/${profileId}/members/${uid}`).set({ role: "owner" });
}

// Mirrors bookings.test.ts's own pollNotifications (see its comment on why
// polling — not a single read — is needed even though the callable/sweep
// step already awaited the notify call).
async function pollNotifications(uid: string): Promise<FirebaseFirestore.QuerySnapshot> {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

// `gigId`/`seriesId` in overrides are deliberately allowed to be caller-chosen
// placeholders (a test seeding a booking before its linked gig/series exists
// yet can pass a throwaway string and patch the real id in afterward via a
// plain admin `.update()` — same "create booking first, patch gigId after"
// ordering bookings.test.ts's own fixtures don't need, but scheduled.test.ts's
// booking-then-gig-referencing-that-booking's-own-id ordering does).
async function seedBooking(overrides: Partial<BookingRequestDoc> & { gigId: string }): Promise<{
  bookingId: string; musicianProfileId: string; curatorProfileId: string;
}> {
  const musicianProfileId = overrides.musicianProfileId ?? fakeProfileId();
  const curatorProfileId = overrides.curatorProfileId ?? fakeProfileId();
  const now = Date.now();
  const ref = adb.collection("bookings").doc();
  const doc: BookingRequestDoc = {
    gigId: overrides.gigId, seriesId: null,
    curatorProfileId, musicianProfileId,
    initiatedBy: "musician", structure: "perHour",
    thread: [{ by: "musician", amountCents: 10_000, expectedQuantity: 1, note: null, at: now }],
    awaitingSide: "curator", status: "open",
    acceptedTerms: null, deposit: null, cancellation: null,
    createdAt: now, updatedAt: now, confirmedAt: null, resolvedAt: null,
    ...overrides,
  };
  await ref.set(doc);
  return { bookingId: ref.id, musicianProfileId: doc.musicianProfileId, curatorProfileId: doc.curatorProfileId };
}

describe("runDailySweep — series materialization", () => {
  it("weekly series materializes exactly ceil(8w/1w)=8 occurrences with the correct startsAt sequence", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    const report = await runDailySweep(anchor);

    // The suite runs every test file against ONE persistent Firestore
    // emulator instance (no reset between files) — other files' fixtures
    // leave their own "active" series/gigs/tracks/invites lying around, so a
    // SweepReport's global counts can only be a LOWER bound of what THIS
    // test's own fixture caused, never an exact figure. Every scoped
    // assertion below (queried by this series' id, or by exact doc id) is
    // fully deterministic regardless of that shared state; the report-field
    // checks here just confirm the aggregation itself isn't a no-op.
    expect(report.occurrencesCreated).toBeGreaterThanOrEqual(8);
    expect(report.seriesAdvanced).toBeGreaterThanOrEqual(1);
    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(8);
    const expectedStarts = Array.from({ length: 8 }, (_, i) => anchor + i * 7 * DAY_MS);
    expect(occs.map((d) => d.data().startsAt)).toEqual(expectedStarts);
    for (const d of occs) {
      const data = d.data();
      expect(data.status).toBe("open");
      expect(data.seriesId).toBe(seriesId);
      expect(data.detachedFromTemplate).toBe(false);
      expect(data.title).toBe("Friday Night Jazz");
      expect(data.location).toEqual(SEED_LOCATION);
      const priv = (await adb.doc(`gigs/${d.id}/private/location`).get()).data();
      expect(priv).toEqual(SEED_PRIVATE_LOCATION);
    }
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(anchor + 56 * DAY_MS);
  });

  it("biweekly cadence materializes exactly ceil(8w/2w)=4 occurrences, 14 days apart", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, recurrence: { weekday: 2, hour: 10, minute: 30, cadence: "biweekly", endDate: null },
    });
    const anchor = expectedAnchor(createdAt, 2, 10, 30);

    // (See the weekly test above for why this is a scoped, per-series check
    // rather than an assertion on the shared-emulator-contaminated report.)
    await runDailySweep(anchor);
    const occs = await occurrencesFor(seriesId);
    const expectedStarts = Array.from({ length: 4 }, (_, i) => anchor + i * 14 * DAY_MS);
    expect(occs.map((d) => d.data().startsAt)).toEqual(expectedStarts);
  });

  it("monthly cadence (RULING: every 4 weeks / +28d) materializes exactly ceil(8w/4w)=2 occurrences, 28 days apart", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, recurrence: { weekday: 0, hour: 18, minute: 15, cadence: "monthly", endDate: null },
    });
    const anchor = expectedAnchor(createdAt, 0, 18, 15);

    await runDailySweep(anchor);
    const occs = await occurrencesFor(seriesId);
    const expectedStarts = [anchor, anchor + 28 * DAY_MS];
    expect(occs.map((d) => d.data().startsAt)).toEqual(expectedStarts);
  });

  it("respects recurrence.endDate — caps occurrences and advances materializedThrough to endDate, not the full window", async () => {
    const createdAt = Date.now();
    const anchor = expectedAnchor(createdAt, 5, 20, 0);
    const endDate = anchor + 20 * DAY_MS; // partway through the weekly cadence
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate },
    });

    await runDailySweep(anchor); // anchor, +7, +14 (< +20) materialize; +21 excluded
    const occs = await occurrencesFor(seriesId);
    expect(occs.map((d) => d.data().startsAt)).toEqual([anchor, anchor + 7 * DAY_MS, anchor + 14 * DAY_MS]);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(endDate);
  });

  it("INVARIANT: a paused series materializes nothing, even though it matches every other condition", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt, status: "paused" });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    // Not asserting on the global report here (other active series elsewhere
    // in the shared emulator could legitimately contribute nonzero counts of
    // their own) — the invariant under test is scoped to THIS series: it
    // must gain zero occurrences and its watermark must never move.
    await runDailySweep(anchor);
    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(0);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(0); // untouched
  });

  it("an ended series also materializes nothing", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt, status: "ended" });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);
    await runDailySweep(anchor);
    expect((await occurrencesFor(seriesId)).length).toBe(0);
  });

  it("double-run at the same `now` is idempotent — the second run creates nothing new", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    await runDailySweep(anchor);
    const afterFirst = await occurrencesFor(seriesId);
    expect(afterFirst.length).toBe(8);

    await runDailySweep(anchor); // identical `now` — nothing new to materialize
    const afterSecond = await occurrencesFor(seriesId);
    expect(afterSecond.length).toBe(8); // still exactly 8 — no duplicates
    expect(afterSecond.map((d) => d.id).sort()).toEqual(afterFirst.map((d) => d.id).sort());
  });

  it("a later run only materializes the newly-in-window slice beyond the prior watermark", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    await runDailySweep(anchor);
    // A week later: the window slides forward by 7 days, so exactly one more
    // weekly occurrence should newly fall inside it. (Not asserting on the
    // global report's occurrencesCreated — see the weekly test's comment on
    // shared-emulator contamination; this test's own series is the scoped,
    // deterministic check.)
    await runDailySweep(anchor + 7 * DAY_MS);
    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(9);
    expect(occs[8].data().startsAt).toBe(anchor + 56 * DAY_MS);
  });

  it("clamps to `now`: a series whose anchor already elapsed before this run never materializes a past-dated occurrence", async () => {
    // The four sweep steps share one deferred WriteBatch, so the past-gig
    // sweep's read query can never see this run's own not-yet-committed
    // creates — a past-dated occurrence created here would stay "open" and
    // world-readable until the NEXT day's run finally closes it. Simulates
    // the ordinary "materializedThrough: 0 on first run" case where the
    // sweep happens to run a few days after the series' own anchor slot
    // already elapsed (createdAt long before the first 09:00 sweep).
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);
    const now = anchor + 3 * DAY_MS; // this run happens after the anchor's own slot already elapsed

    await runDailySweep(now);

    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(8);
    for (const d of occs) expect(d.data().startsAt as number).toBeGreaterThanOrEqual(now);
    expect(occs.some((d) => d.data().startsAt === anchor)).toBe(false); // the elapsed anchor itself is never created
    expect(occs[0].data().startsAt).toBe(anchor + 7 * DAY_MS); // first FUTURE grid slot, not the elapsed one
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(now + 56 * DAY_MS);
  });
});

describe("runDailySweep — past-gig sweep", () => {
  it("closes an open gig whose startsAt has elapsed; leaves a future open gig untouched", async () => {
    const now = Date.now();
    const profileId = fakeProfileId();
    const seriesId = "not-a-real-series";
    const pastId = await seedOccurrence(seriesId, profileId, { status: "open", startsAt: now - 3600_000 });
    const futureId = await seedOccurrence(seriesId, profileId, { status: "open", startsAt: now + 3600_000 });
    const pastDraftId = await seedOccurrence(seriesId, profileId, { status: "draft", startsAt: now - 3600_000 });

    const report = await runDailySweep(now);

    // >= not ===: other test files may leave their own past-dated "open"
    // gigs sitting in the shared emulator (e.g. gigSeries.test.ts's endSeries
    // fixtures) — see the weekly materialization test's comment. The doc-id
    // checks below are the deterministic, scoped assertions.
    expect(report.pastGigsClosed).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`gigs/${pastId}`).get()).data()?.status).toBe("closed");
    expect((await adb.doc(`gigs/${futureId}`).get()).data()?.status).toBe("open");
    expect((await adb.doc(`gigs/${pastDraftId}`).get()).data()?.status).toBe("draft"); // only "open" is swept
  });
});

describe("runDailySweep — track reaper", () => {
  it("fails a processing track older than 24h; leaves a fresh processing track and an older non-processing track untouched", async () => {
    const now = Date.now();
    const profileId = fakeProfileId();
    const staleId = await seedTrack(profileId, { status: "processing", createdAt: now - 25 * 3600_000 });
    const freshId = await seedTrack(profileId, { status: "processing", createdAt: now - 1 * 3600_000 });
    const oldApprovedId = await seedTrack(profileId, { status: "approved", createdAt: now - 30 * 3600_000 });

    const report = await runDailySweep(now);

    expect(report.tracksFailed).toBeGreaterThanOrEqual(1); // see contamination note above
    const stale = (await adb.doc(`profiles/${profileId}/tracks/${staleId}`).get()).data();
    expect(stale?.status).toBe("failed");
    expect(stale?.failureReason).toBe("Upload abandoned");
    expect((await adb.doc(`profiles/${profileId}/tracks/${freshId}`).get()).data()?.status).toBe("processing");
    expect((await adb.doc(`profiles/${profileId}/tracks/${oldApprovedId}`).get()).data()?.status).toBe("approved");
  });
});

describe("runDailySweep — invite sweep", () => {
  it("revokes a pending invite past the 14-day expiry; leaves a fresh pending invite and an old non-pending invite untouched", async () => {
    const now = Date.now();
    const staleId = await seedInvite({ status: "pending", createdAt: now - 15 * DAY_MS });
    const freshId = await seedInvite({ status: "pending", createdAt: now - 1 * DAY_MS });
    const oldAcceptedId = await seedInvite({ status: "accepted", createdAt: now - 20 * DAY_MS });

    const report = await runDailySweep(now);

    expect(report.invitesRevoked).toBeGreaterThanOrEqual(1); // see contamination note above
    expect((await adb.doc(`invites/${staleId}`).get()).data()?.status).toBe("revoked");
    expect((await adb.doc(`invites/${freshId}`).get()).data()?.status).toBe("pending");
    expect((await adb.doc(`invites/${oldAcceptedId}`).get()).data()?.status).toBe("accepted");
  });
});

describe("runDailySweep — S3 sweep resilience", () => {
  it("a poisoned series (malformed recurrence, forced via admin SDK) does not prevent steps 2-4 — their effects still land", async () => {
    const now = Date.now();
    // Force a genuinely-throwing series doc: destructuring `null` inside
    // anchorFor's `const { weekday, hour, minute } = series.recurrence;`
    // throws a TypeError. This bypasses createSeries/validateRecurrence
    // entirely (an admin-SDK-only shape — the real callables can never
    // produce it), simulating the kind of malformed data step 1's per-series
    // try/catch (SP4 Task 13 item 8) must survive without blocking the rest
    // of the sweep — or any OTHER series in the same step 1 pass.
    const { seriesId: poisonedId } = await seedSeries({
      createdAt: now, updatedAt: now, recurrence: null as unknown as GigSeriesDoc["recurrence"],
    });

    // Independent fixtures for steps 2-4, unrelated to the poisoned series —
    // step 1's per-series (not step-level) catch must not stop steps 2/3/4
    // from running at all.
    const profileId = fakeProfileId();
    const pastId = await seedOccurrence("not-a-real-series", profileId, { status: "open", startsAt: now - 3600_000 });
    const staleTrackId = await seedTrack(profileId, { status: "processing", createdAt: now - 25 * 3600_000 });
    const staleInviteId = await seedInvite({ status: "pending", createdAt: now - 15 * DAY_MS });

    const report = await runDailySweep(now);

    // SP4 (Task 13 item 8): a single poisoned series is now caught PER-DOC
    // (report.seriesMaterializeSkipped), not by the step-level catch
    // (report.errors.series) — the latter no longer fires for this scenario
    // at all, since the per-series catch prevents the throw from ever
    // reaching step 1's outer try/catch.
    expect(report.seriesMaterializeSkipped).toBeGreaterThanOrEqual(1);
    expect(report.errors.series).toBe(0);
    expect((await adb.doc(`gigs/${pastId}`).get()).data()?.status).toBe("closed");
    expect((await adb.doc(`profiles/${profileId}/tracks/${staleTrackId}`).get()).data()?.status).toBe("failed");
    expect((await adb.doc(`invites/${staleInviteId}`).get()).data()?.status).toBe("revoked");
    // The poisoned series itself never advanced (its own iteration aborted).
    const poisoned = (await adb.doc(`gigSeries/${poisonedId}`).get()).data() as GigSeriesDoc;
    expect(poisoned.materializedThrough).toBe(0);

    // Cleanup: this file runs every test against ONE persistent, never-reset
    // Firestore emulator instance, and step 1's query is unscoped
    // (`where("status","==","active")` over the WHOLE collection) — leaving
    // this doc "active" forever would poison every LATER test in this file
    // that also calls runDailySweep. Flip it out of the query's match set
    // once this test is done with it.
    await adb.doc(`gigSeries/${poisonedId}`).update({ status: "ended" });
  });

  it("SP4 Task 13 item 8: a poisoned series (malformed template, forced via admin SDK) does not stop a healthy active series from materializing in the SAME step 1 pass", async () => {
    const now = Date.now();
    const createdAt = now - 60 * DAY_MS; // far enough back that both series have a due occurrence by `now`
    // Malformed `template` (not `recurrence` — the OTHER poisoned-series
    // test above already covers that vector): computeOccurrences succeeds
    // (recurrence is intact), so this throws later in the SAME per-series
    // iteration, at `series.template.title` while building the gig doc —
    // proving the try/catch wraps the WHOLE per-series body, not just the
    // early planning call.
    const { seriesId: poisonedId } = await seedSeries({
      createdAt, updatedAt: createdAt, template: null as unknown as GigSeriesDoc["template"],
    });
    const { seriesId: healthyId } = await seedSeries({ createdAt, updatedAt: createdAt });

    const report = await runDailySweep(now);

    expect(report.seriesMaterializeSkipped).toBeGreaterThanOrEqual(1);
    const poisoned = (await adb.doc(`gigSeries/${poisonedId}`).get()).data() as GigSeriesDoc;
    expect(poisoned.materializedThrough).toBe(0); // its own iteration aborted, never advanced

    // The healthy series — same run, same page — still materialized.
    const healthy = (await adb.doc(`gigSeries/${healthyId}`).get()).data() as GigSeriesDoc;
    expect(healthy.materializedThrough).toBeGreaterThan(0);
    const healthyOccurrences = await occurrencesFor(healthyId);
    expect(healthyOccurrences.length).toBeGreaterThan(0);

    // Fixture hygiene (both series, same rationale as above).
    await adb.doc(`gigSeries/${poisonedId}`).update({ status: "ended" });
    await adb.doc(`gigSeries/${healthyId}`).update({ status: "ended" });
  });
});

describe("runDailySweep — S4 curatorAccess retry sweep", () => {
  it("retries a seeded curatorAccessRetries doc via syncCuratorAccess and deletes it on success", async () => {
    const uid = `retry-uid-${Date.now()}`;
    await adb.doc(`curatorAccessRetries/${uid}`).set({ createdAt: Date.now() });
    const report = await runDailySweep(Date.now());
    expect(report.curatorAccessRetried).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`curatorAccessRetries/${uid}`).get()).exists).toBe(false);
  });

  it("SP4 Task 13 item 1: a poisoned uid (invalid, forced via admin SDK) does not starve the retry queue — the next uid still drains", async () => {
    const now = Date.now();
    // ">64 chars" fails @gatekeep/shared's isValidDocId (syncCuratorAccess's
    // own guard — SP4 Task 13 item 1) while still being a perfectly legal
    // Firestore document id (well under its own 1500-byte limit), so this
    // seeds fine via the admin SDK but syncCuratorAccess rejects it. Prefixed
    // "0-" so it sorts BEFORE the healthy uid under step 5's
    // orderBy(FieldPath.documentId()) — first in the queue.
    const poisonedUid = `0-invalid-${"x".repeat(70)}`;
    const healthyUid = `zzz-healthy-uid-${now}`;
    await adb.doc(`curatorAccessRetries/${poisonedUid}`).set({ createdAt: now });
    await adb.doc(`curatorAccessRetries/${healthyUid}`).set({ createdAt: now });

    const report = await runDailySweep(now);

    expect(report.curatorAccessRetried).toBeGreaterThanOrEqual(1);
    expect(report.errors.curatorAccessRetries).toBeGreaterThanOrEqual(1);
    // The poisoned doc stays queued (for a future retry)...
    expect((await adb.doc(`curatorAccessRetries/${poisonedUid}`).get()).exists).toBe(true);
    // ...but the healthy uid right behind it in doc-id order still drains.
    expect((await adb.doc(`curatorAccessRetries/${healthyUid}`).get()).exists).toBe(false);

    // Fixture hygiene: step 5's query is unscoped over the whole collection
    // (same as step 1's series query) — leaving this doc in place would
    // poison every LATER test in this file that also calls runDailySweep.
    await adb.doc(`curatorAccessRetries/${poisonedUid}`).delete();
  });
});

describe("runDailySweep — P4 materializer cap guard + TOCTOU re-read", () => {
  it("a profile already at MAX_OPEN_GIGS_PER_PROFILE open gigs materializes nothing for its series", async () => {
    const createdAt = Date.now();
    const { seriesId, profileId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const batch = adb.batch();
    for (let i = 0; i < MAX_OPEN_GIGS_PER_PROFILE; i++) {
      const ref = adb.collection("gigs").doc();
      const doc: GigDoc = {
        curatorProfileId: profileId, seriesId: null, detachedFromTemplate: false,
        title: `Cap filler ${i}`, description: "", wants: { genres: ["rock"], actSizes: ["band"] },
        budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
        startsAt: createdAt, durationMinutes: 60,
        provisions: { hasPA: null, hasBackline: null, notes: null },
        location: SEED_LOCATION, status: "open", createdAt, updatedAt: createdAt,
        bookingId: null, bookedMusicianProfileId: null,
      };
      batch.set(ref, doc);
    }
    await batch.commit();
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    const report = await runDailySweep(anchor);

    expect(report.seriesSkippedCapped).toBeGreaterThanOrEqual(1);
    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(0);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(0); // untouched — capped before advancing the watermark
  });

  it("M-10 TOCTOU: a series paused between the scan and its write materializes nothing", async () => {
    const createdAt = Date.now();
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    // Races a concurrent pause against the sweep's own per-series re-read:
    // the initial scan (status=='active') already matches this series by
    // the time both promises start, but the write path performs its OWN
    // fresh `seriesDoc.ref.get()` immediately before writing (P4/M-10 fix)
    // — that fresh read must see "paused" and skip, even though the
    // ORIGINAL scan saw "active". Started via Promise.all (not a fixed
    // delay/sleep) so the pause genuinely races the sweep's own real
    // Firestore round-trips (the scan query, then the per-series cap-check
    // .count().get()) rather than an arbitrary timer.
    await Promise.all([
      runDailySweep(anchor),
      adb.doc(`gigSeries/${seriesId}`).update({ status: "paused" }),
    ]);

    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBe(0);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.status).toBe("paused");
    expect(series.materializedThrough).toBe(0); // untouched — skipped before advancing the watermark
  });
});

describe("runDailySweep — SP4 Task 8: booking expiry sweep (step 6)", () => {
  it("expires an open booking whose gig's startsAt has elapsed; notifies the musician side", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const musicianUid = fakeUid();
    await seedMember(musicianProfileId, musicianUid);
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "open", startsAt: now - 3600_000 });
    const { bookingId } = await seedBooking({ gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open" });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("expired");
    expect(booking.resolvedAt).toBe(now);
    const notes = await pollNotifications(musicianUid);
    expect(notes.empty).toBe(false);
    // SP4 Task 10a: the sweep's expiry notification also carries refId,
    // the web notification list's deep-link source for /dashboard/bookings/[refId].
    expect(notes.docs.some((d) => d.data().refId === bookingId)).toBe(true);
  });

  it("expires an open booking whose gig is no longer 'open' (e.g. cancelled), even though it hasn't started yet; notifies the musician side", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const musicianUid = fakeUid();
    await seedMember(musicianProfileId, musicianUid);
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "cancelled", startsAt: now + 3600_000 });
    const { bookingId } = await seedBooking({ gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open" });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("expired");
    const notes = await pollNotifications(musicianUid);
    expect(notes.empty).toBe(false);
  });

  it("leaves an open booking on a still-open, future gig untouched", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "open", startsAt: now + 3600_000 });
    const { bookingId } = await seedBooking({ gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open" });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("open");
  });

  it("Task 8 review: expires an open booking whose gig doc has been deleted outright (e.g. deleteProfile's cascade); notifies the musician side", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const musicianUid = fakeUid();
    await seedMember(musicianProfileId, musicianUid);
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "open", startsAt: now + 3600_000 });
    const { bookingId } = await seedBooking({ gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open" });
    await adb.doc(`gigs/${gigId}`).delete(); // gig gone outright — the strongest "can never be accepted" case

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("expired");
    expect(booking.resolvedAt).toBe(now);
    const notes = await pollNotifications(musicianUid);
    expect(notes.empty).toBe(false);
  });
});

describe("runDailySweep — SP4 Task 8: booking completion sweep (step 7)", () => {
  it("completes a single-gig confirmed booking once its gig has ended; increments completedCount and recomputes the projection", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: null, curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, {
      status: "filled", startsAt: now - 2 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("completed");
    expect(booking.resolvedAt).toBe(now);
    const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
    expect(reliability?.completedCount).toBe(1);
    const projection = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get()).data();
    expect(projection?.reliability?.completedCount).toBe(1);
  });

  it("does not complete a single-gig confirmed booking whose gig hasn't ended yet", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: null, curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, {
      status: "filled", startsAt: now + 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("confirmed");
  });

  it("does not complete a confirmed booking whose gig has STARTED but not yet ENDED (pins the startsAt+durationMinutes math, not just startsAt<=now)", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: null, curatorProfileId, musicianProfileId, status: "confirmed",
    });
    // Started 30 minutes ago, runs 90 minutes — 60 minutes still remain. A
    // formula that forgets to convert durationMinutes to milliseconds before
    // adding it to the epoch-ms `startsAt` (durationMinutes is minutes, not
    // ms) would wrongly treat this as already ended, since the un-converted
    // "+60" is negligible next to startsAt's own scale.
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, {
      status: "filled", startsAt: now - 30 * 60_000, durationMinutes: 90,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("confirmed");
  });

  it("completes a whole-run confirmed booking only once its LAST linked occurrence has ended — a mid-run sweep does not complete it", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const { seriesId } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      // Far-future watermark — this fixture's own materializer pass (step 1,
      // which always runs before step 7 in the same sweep call) must never
      // birth a fresh occurrence here; the test's whole point is to control
      // the linked-occurrence set by hand.
      materializedThrough: now + 1000 * DAY_MS,
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId });
    const pastGigId = await seedOccurrence(seriesId, curatorProfileId, {
      status: "filled", startsAt: now - 3 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    // Its own future date, still linked and "filled" — the mid-run sweep
    // must not complete the booking while this exists.
    await seedOccurrence(seriesId, curatorProfileId, {
      status: "filled", startsAt: now + 2 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId: pastGigId });

    try {
      await runDailySweep(now); // mid-run: the future date hasn't ended yet
      let booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("confirmed");

      await runDailySweep(now + 4 * 3600_000); // after the future date (ends at now+3h) has ended
      booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("completed");
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("zombie resolver: a confirmed whole-run booking with zero future linked occurrences but one PAST linked occurrence resolves to completed and clears the series' active-booking linkage", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const { seriesId } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      materializedThrough: now + 1000 * DAY_MS,
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId });
    const pastGigId = await seedOccurrence(seriesId, curatorProfileId, {
      status: "filled", startsAt: now - 3 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId: pastGigId });

    try {
      await runDailySweep(now);

      const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("completed");
      expect(booking.resolvedAt).toBe(now);
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
      expect(reliability?.completedCount).toBe(1);
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("zombie resolver variant: a confirmed whole-run booking with ZERO linked occurrences at all (nothing ever performed) resolves to expired and clears the series linkage", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "never-materialized", seriesId: "pending", curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const { seriesId } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      materializedThrough: now + 1000 * DAY_MS,
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId });

    try {
      await runDailySweep(now);

      const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("expired");
      expect(booking.resolvedAt).toBe(now);
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
      expect(reliability?.completedCount ?? 0).toBe(0);
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("Task 8 ruling: a future TAKEN_DOWN linked date does not delay completion — resolves 'completed' immediately once a PAST FILLED linked date exists, without waiting for the taken-down date's fictional end", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const { seriesId } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      materializedThrough: now + 1000 * DAY_MS,
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId });
    const pastFilledGigId = await seedOccurrence(seriesId, curatorProfileId, {
      status: "filled", startsAt: now - 3 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId: pastFilledGigId });
    // takedownGig's occurrence scope leaves bookingId/bookedMusicianProfileId
    // set on a "taken_down" gig belonging to a still-confirmed whole-run
    // booking (see gigs.ts) — this future date will NEVER happen, but stays
    // linked. Without the status:"filled" query filter, this would be picked
    // as the "last linked occurrence" and delay resolution until its
    // fictional end time, then wrongly award "completed".
    await seedOccurrence(seriesId, curatorProfileId, {
      status: "taken_down", startsAt: now + 5 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });

    try {
      await runDailySweep(now); // the taken-down date's fictional end (now+6h) hasn't happened yet

      const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("completed");
      expect(booking.resolvedAt).toBe(now);
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
      expect(reliability?.completedCount).toBe(1);
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("Task 8 ruling variant: a future TAKEN_DOWN linked date with NO past FILLED linked date resolves 'expired', not 'completed' — completedCount stays 0", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "never-performed", seriesId: "pending", curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const { seriesId } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      materializedThrough: now + 1000 * DAY_MS,
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId });
    await seedOccurrence(seriesId, curatorProfileId, {
      status: "taken_down", startsAt: now + 5 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });

    try {
      await runDailySweep(now);

      const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
      expect(booking.status).toBe("expired");
      expect(booking.resolvedAt).toBe(now);
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
      const reliability = (await adb.doc(`profiles/${musicianProfileId}/private/reliability`).get()).data();
      expect(reliability?.completedCount ?? 0).toBe(0);
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });
});

describe("runDailySweep — SP4 Task 8: run-aware materializer (step 1 change)", () => {
  it("materializes a whole-run series' occurrences already status:'filled' + linked, when the series' active booking is still confirmed", async () => {
    const createdAt = Date.now();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", status: "confirmed", musicianProfileId,
    });
    const { seriesId, profileId: curatorProfileId } = await seedSeries({
      createdAt, updatedAt: createdAt, fillMode: "whole_run",
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId, curatorProfileId });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    try {
      const report = await runDailySweep(anchor);
      expect(report.occurrencesBornFilled).toBeGreaterThanOrEqual(8);
      const occs = await occurrencesFor(seriesId);
      expect(occs.length).toBe(8);
      for (const d of occs) {
        const data = d.data();
        expect(data.status).toBe("filled");
        expect(data.bookingId).toBe(bookingId);
        expect(data.bookedMusicianProfileId).toBe(musicianProfileId);
      }
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("self-heals a stale series/booking linkage: births OPEN occurrences and clears the series' linkage when the linked booking is no longer confirmed", async () => {
    const createdAt = Date.now();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", status: "cancelled_by_curator", musicianProfileId,
    });
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, fillMode: "whole_run",
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    try {
      const report = await runDailySweep(anchor);
      expect(report.seriesSelfHealed).toBeGreaterThanOrEqual(1);
      const occs = await occurrencesFor(seriesId);
      expect(occs.length).toBe(8);
      for (const d of occs) {
        const data = d.data();
        expect(data.status).toBe("open");
        expect(data.bookingId).toBeNull();
        expect(data.bookedMusicianProfileId).toBeNull();
      }
      const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
      expect(series.activeBookingId).toBeNull();
      expect(series.bookedMusicianProfileId).toBeNull();
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });

  it("filled births skip the MAX_OPEN_GIGS_PER_PROFILE cap guard — a profile already at the cap still materializes a booked run's filled occurrences", async () => {
    const createdAt = Date.now();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: "pending", status: "confirmed", musicianProfileId,
    });
    const { seriesId, profileId: curatorProfileId } = await seedSeries({
      createdAt, updatedAt: createdAt, fillMode: "whole_run",
      activeBookingId: bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ seriesId, curatorProfileId });

    const batch = adb.batch();
    for (let i = 0; i < MAX_OPEN_GIGS_PER_PROFILE; i++) {
      const ref = adb.collection("gigs").doc();
      const doc: GigDoc = {
        curatorProfileId, seriesId: null, detachedFromTemplate: false,
        title: `Cap filler ${i}`, description: "", wants: { genres: ["rock"], actSizes: ["band"] },
        budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
        startsAt: createdAt, durationMinutes: 60,
        provisions: { hasPA: null, hasBackline: null, notes: null },
        location: SEED_LOCATION, status: "open", createdAt, updatedAt: createdAt,
        bookingId: null, bookedMusicianProfileId: null,
      };
      batch.set(ref, doc);
    }
    await batch.commit();
    const anchor = expectedAnchor(createdAt, 5, 20, 0);

    try {
      const report = await runDailySweep(anchor);
      expect(report.occurrencesBornFilled).toBeGreaterThanOrEqual(8);
      const occs = await occurrencesFor(seriesId);
      expect(occs.length).toBe(8);
      expect(occs.every((d) => d.data().status === "filled")).toBe(true);
    } finally {
      await adb.doc(`gigSeries/${seriesId}`).update({ status: "ended" });
    }
  });
});

describe("runDailySweep — SP4 Task 8: double-run idempotency across the new steps", () => {
  it("a second run at the same `now` makes zero further changes across booking expiry, completion (single + zombie), and filled materialization", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();

    // (a) a stale open booking due to expire.
    const musicianA = fakeProfileId();
    const gigA = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "open", startsAt: now - 3600_000 });
    const { bookingId: bookingA } = await seedBooking({
      gigId: gigA, seriesId: null, curatorProfileId, musicianProfileId: musicianA, status: "open",
    });

    // (b) a single-gig confirmed booking due to complete.
    const musicianB = fakeProfileId();
    const { bookingId: bookingB } = await seedBooking({
      gigId: "pending", seriesId: null, curatorProfileId, musicianProfileId: musicianB, status: "confirmed",
    });
    const gigB = await seedOccurrence("not-a-real-series", curatorProfileId, {
      status: "filled", startsAt: now - 2 * 3600_000, durationMinutes: 60, bookingId: bookingB, bookedMusicianProfileId: musicianB,
    });
    await adb.doc(`bookings/${bookingB}`).update({ gigId: gigB });

    // (c) a zombie whole-run booking (one past linked, zero future) due to complete.
    const musicianC = fakeProfileId();
    const { bookingId: bookingC } = await seedBooking({
      gigId: "pending", seriesId: "pending", curatorProfileId, musicianProfileId: musicianC, status: "confirmed",
    });
    const { seriesId: seriesC } = await seedSeries({
      createdAt: now, updatedAt: now, curatorProfileId, status: "active",
      materializedThrough: now + 1000 * DAY_MS, activeBookingId: bookingC, bookedMusicianProfileId: musicianC,
    });
    await adb.doc(`bookings/${bookingC}`).update({ seriesId: seriesC });
    const gigC = await seedOccurrence(seriesC, curatorProfileId, {
      status: "filled", startsAt: now - 3 * 3600_000, durationMinutes: 60, bookingId: bookingC, bookedMusicianProfileId: musicianC,
    });
    await adb.doc(`bookings/${bookingC}`).update({ gigId: gigC });

    // (d) a series + confirmed run booking due to materialize filled births.
    const musicianD = fakeProfileId();
    const { bookingId: bookingD } = await seedBooking({
      gigId: "pending", seriesId: "pending", status: "confirmed", musicianProfileId: musicianD,
    });
    const { seriesId: seriesD, profileId: curatorD } = await seedSeries({
      createdAt: now, updatedAt: now, fillMode: "whole_run",
      activeBookingId: bookingD, bookedMusicianProfileId: musicianD,
    });
    await adb.doc(`bookings/${bookingD}`).update({ seriesId: seriesD, curatorProfileId: curatorD });
    // anchorD >= now always (anchorFor never lands before its series' own
    // createdAt) — running the WHOLE sweep at anchorD is valid for (a)/(b)/(c)
    // too: their past-dated triggers stay just as past relative to anchorD.
    const anchorD = expectedAnchor(now, 5, 20, 0);

    try {
      await runDailySweep(anchorD);

      const firstOccsD = await occurrencesFor(seriesD);
      expect(firstOccsD.length).toBe(8);
      const bookingASnap1 = (await adb.doc(`bookings/${bookingA}`).get()).data();
      const bookingBSnap1 = (await adb.doc(`bookings/${bookingB}`).get()).data();
      const bookingCSnap1 = (await adb.doc(`bookings/${bookingC}`).get()).data();
      expect(bookingASnap1?.status).toBe("expired");
      expect(bookingBSnap1?.status).toBe("completed");
      expect(bookingCSnap1?.status).toBe("completed");
      const reliabilityB1 = (await adb.doc(`profiles/${musicianB}/private/reliability`).get()).data();
      expect(reliabilityB1?.completedCount).toBe(1);

      await runDailySweep(anchorD); // second run, identical `now`

      const secondOccsD = await occurrencesFor(seriesD);
      expect(secondOccsD.map((d) => d.id).sort()).toEqual(firstOccsD.map((d) => d.id).sort());
      expect(secondOccsD.length).toBe(8);
      const bookingASnap2 = (await adb.doc(`bookings/${bookingA}`).get()).data();
      const bookingBSnap2 = (await adb.doc(`bookings/${bookingB}`).get()).data();
      const bookingCSnap2 = (await adb.doc(`bookings/${bookingC}`).get()).data();
      expect(bookingASnap2).toEqual(bookingASnap1);
      expect(bookingBSnap2).toEqual(bookingBSnap1);
      expect(bookingCSnap2).toEqual(bookingCSnap1);
      const reliabilityB2 = (await adb.doc(`profiles/${musicianB}/private/reliability`).get()).data();
      expect(reliabilityB2?.completedCount).toBe(1); // not double-incremented
    } finally {
      await adb.doc(`gigSeries/${seriesC}`).update({ status: "ended" });
      await adb.doc(`gigSeries/${seriesD}`).update({ status: "ended" });
    }
  });
});

// Type-only sanity check that SeriesCadence covers what CADENCE tests exercise.
const _cadences: SeriesCadence[] = ["weekly", "biweekly", "monthly"];
void _cadences;

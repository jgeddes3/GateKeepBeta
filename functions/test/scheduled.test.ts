import { describe, it, expect, vi } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { MAX_OPEN_GIGS_PER_PROFILE, type GigSeriesDoc, type GigDoc, type InviteDoc, type TrackDoc, type SeriesCadence } from "@gatekeep/shared";
import { runDailySweep } from "../src/scheduled.js";

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
    // produce it), simulating the kind of malformed data step 1's
    // try/catch must survive without blocking the rest of the sweep.
    const { seriesId: poisonedId } = await seedSeries({
      createdAt: now, updatedAt: now, recurrence: null as unknown as GigSeriesDoc["recurrence"],
    });

    // Independent fixtures for steps 2-4, unrelated to the poisoned series —
    // if the step-level try/catch (not a per-doc catch) is working, step 1's
    // exception must not stop steps 2/3/4 from running at all.
    const profileId = fakeProfileId();
    const pastId = await seedOccurrence("not-a-real-series", profileId, { status: "open", startsAt: now - 3600_000 });
    const staleTrackId = await seedTrack(profileId, { status: "processing", createdAt: now - 25 * 3600_000 });
    const staleInviteId = await seedInvite({ status: "pending", createdAt: now - 15 * DAY_MS });

    const report = await runDailySweep(now);

    expect(report.errors.series).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`gigs/${pastId}`).get()).data()?.status).toBe("closed");
    expect((await adb.doc(`profiles/${profileId}/tracks/${staleTrackId}`).get()).data()?.status).toBe("failed");
    expect((await adb.doc(`invites/${staleInviteId}`).get()).data()?.status).toBe("revoked");
    // The poisoned series itself never advanced (its own step aborted).
    const poisoned = (await adb.doc(`gigSeries/${poisonedId}`).get()).data() as GigSeriesDoc;
    expect(poisoned.materializedThrough).toBe(0);

    // Cleanup: this file runs every test against ONE persistent, never-reset
    // Firestore emulator instance, and step 1's query is unscoped
    // (`where("status","==","active")` over the WHOLE collection) — leaving
    // this doc "active" forever would poison every LATER test in this file
    // that also calls runDailySweep (a single throw anywhere in step 1's
    // loop aborts that whole step for THAT run, not just this doc). Flip it
    // out of the query's match set once this test is done with it.
    await adb.doc(`gigSeries/${poisonedId}`).update({ status: "ended" });
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

// Type-only sanity check that SeriesCadence covers what CADENCE tests exercise.
const _cadences: SeriesCadence[] = ["weekly", "biweekly", "monthly"];
void _cadences;

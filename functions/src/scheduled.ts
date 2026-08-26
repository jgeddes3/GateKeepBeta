import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import {
  SERIES_MATERIALIZE_WEEKS, MAX_OPEN_GIGS_PER_PROFILE,
  type GigSeriesDoc, type GigDoc, type SeriesCadence,
} from "@gatekeep/shared";
import { INVITE_MAX_AGE_MS } from "./members.js";
import { syncCuratorAccess } from "./curator.js";

const DAY_MS = 86_400_000;
// SP2 debt (tracks.ts's ACTIVE_TRACK_STATUSES comment): a track stuck in
// "processing" this long means the transcode trigger never ran (the upload
// was abandoned mid-flight) — the reaper below frees its slot.
const PROCESSING_STALE_MS = 24 * 60 * 60 * 1000;

// v1 stores every timestamp as epoch ms with no per-profile timezone, so the
// recurrence's weekday/hour/minute is interpreted in a FIXED timezone (UTC)
// rather than the launch metro's local time. That's a real gap — a curator
// who picks "Friday 8pm" will get a UTC 8pm, which drifts from their local
// 8pm across DST and by their UTC offset — documented here and in the Task 7
// report as a launch-checklist item (Task 14 owns the README note).
//
// RULING (Task 7 brief): true calendar-monthly recurrence ("the 3rd Tuesday
// of every month") is materially more complex than a fixed-length step, and
// is deferred. monthly = every 4 weeks (+28 days) for v1.
const CADENCE_STEP_MS: Record<SeriesCadence, number> = {
  weekly: 7 * DAY_MS,
  biweekly: 14 * DAY_MS,
  monthly: 28 * DAY_MS,
};

// The recurrence's phase anchor: the first timestamp (UTC) matching the
// series' weekday/hour/minute pattern that falls on or after the series was
// created. This — not "now" — is what the cadence steps forward from. Fixing
// it to a value that depends only on immutable series data (createdAt +
// recurrence) is what keeps biweekly/monthly cadences from drifting phase
// across daily sweep runs: every run recomputes the exact same anchor for a
// given series, so "which of the two weekly slots is the biweekly one"
// never changes.
function anchorFor(series: GigSeriesDoc): number {
  const { weekday, hour, minute } = series.recurrence;
  const ref = new Date(series.createdAt);
  let candidate = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hour, minute, 0, 0);
  const candidateWeekday = new Date(candidate).getUTCDay();
  let deltaDays = weekday - candidateWeekday;
  if (deltaDays < 0) deltaDays += 7;
  candidate += deltaDays * DAY_MS;
  // Same calendar day, but the recurrence's hour:minute already elapsed
  // before createdAt's exact instant — the true first occurrence is a full
  // week later.
  if (candidate < series.createdAt) candidate += 7 * DAY_MS;
  return candidate;
}

interface MaterializePlan { startsAtList: number[]; newMaterializedThrough: number; }

// Smallest `base + k*step` (k >= 0, so always grid-aligned to `base`) that is
// >= `threshold`. A no-op (returns `base` unchanged) when `base` already
// clears the threshold.
function skipAheadTo(base: number, threshold: number, step: number): number {
  if (base >= threshold) return base;
  const stepsToSkip = Math.ceil((threshold - base) / step);
  return base + stepsToSkip * step;
}

// Pure planning function (no I/O) — computes which occurrence startsAt
// values fall newly inside the [materializedThrough, windowEnd) slice, plus
// the watermark to advance to. Window end is exclusive: an occurrence
// exactly AT now+SERIES_MATERIALIZE_WEEKS (or exactly at endDate) is left for
// the following day's run, keeping the boundary convention identical for
// both the window cap and the endDate cap.
function computeOccurrences(series: GigSeriesDoc, now: number): MaterializePlan {
  const step = CADENCE_STEP_MS[series.recurrence.cadence];
  const rawWindowEnd = now + SERIES_MATERIALIZE_WEEKS * 7 * DAY_MS;
  const windowEnd = series.recurrence.endDate != null
    ? Math.min(rawWindowEnd, series.recurrence.endDate)
    : rawWindowEnd;

  // Idempotency guard: if the window hasn't advanced past the watermark
  // (a same-`now` double-run, or an endDate already fully materialized),
  // there is nothing new to plan.
  if (windowEnd <= series.materializedThrough) {
    return { startsAtList: [], newMaterializedThrough: series.materializedThrough };
  }

  const anchor = anchorFor(series);
  // Half-open interval convention: a run covers [materializedThrough,
  // windowEnd) — candidates strictly less than windowEnd are materialized,
  // and the watermark then advances to windowEnd itself (the exclusive
  // upper edge already scanned, not a candidate that was skipped). Skipping
  // ahead to `series.materializedThrough` (inclusive — via `>=`, not `>`) is
  // deliberate: materializedThrough is where the PREVIOUS run's `< windowEnd`
  // cut off, so that exact value was never itself materialized and must
  // remain eligible here. Using a strict `>` here (or, equivalently, the old
  // `<=`/floor+1 skip formula) would treat that instant as already covered
  // and permanently skip it — losing an occurrence whenever the window
  // boundary lands exactly on a grid point.
  let candidate = skipAheadTo(anchor, series.materializedThrough, step);
  // Second, independent clamp: never plan a candidate before `now`. All four
  // daily-sweep steps share ONE deferred WriteBatch (see createChunkedWriter)
  // — step 2's past-gig-close QUERY reads Firestore's already-committed
  // state, so it cannot see this step's not-yet-committed creates within the
  // SAME run. Without this clamp, a series whose anchor falls between its
  // own createdAt and the next scheduled sweep (the common
  // materializedThrough:0-on-first-run case, not a rare edge case) would
  // materialize a past-dated "open" occurrence that stays world-readable and
  // unclosed until the FOLLOWING day's run finally sees and closes it — up
  // to 24h of a bookable-looking gig for a date that already passed.
  // Grid-aligned via the same skipAheadTo helper (not "clamp to exactly
  // now"), so the sequence stays on-pattern: the next candidate is the next
  // valid cadence slot at/after `now`, not an off-grid timestamp.
  candidate = skipAheadTo(candidate, now, step);
  const startsAtList: number[] = [];
  while (candidate < windowEnd) {
    startsAtList.push(candidate);
    candidate += step;
  }
  return { startsAtList, newMaterializedThrough: windowEnd };
}

// Chunked batch writer: commits and starts a fresh batch every 400 ops.
// Materializing one series occurrence is 2 ops (the gig doc + its private
// location subdoc), and the sweeps below touch gigs/tracks/invites across
// every profile — cheap defensive chunking against Firestore's 500-op
// per-batch limit, even though any single series' per-run occurrence count
// is small (capped by SERIES_MATERIALIZE_WEEKS).
//
// S3: EACH of the five steps below constructs its OWN writer and commits it
// at the end of that step's own try/catch, rather than one writer shared
// across the whole sweep — so a step that throws only ever loses ITS OWN
// not-yet-rotated-out batch, never a healthy step's already-queued writes.
function createChunkedWriter(db: FirebaseFirestore.Firestore) {
  const LIMIT = 400;
  let batch = db.batch();
  let ops = 0;
  async function rotateIfFull(): Promise<void> {
    if (ops >= LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  return {
    async set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): Promise<void> {
      await rotateIfFull();
      batch.set(ref, data);
      ops++;
    },
    async update(
      ref: FirebaseFirestore.DocumentReference,
      data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
    ): Promise<void> {
      await rotateIfFull();
      batch.update(ref, data);
      ops++;
    },
    async delete(ref: FirebaseFirestore.DocumentReference): Promise<void> {
      await rotateIfFull();
      batch.delete(ref);
      ops++;
    },
    async commit(): Promise<void> {
      if (ops > 0) await batch.commit();
    },
  };
}

// S3: pages a query PAGE_SIZE docs at a time instead of one unbounded
// `.get()` — the gigSeries/gigs/tracks/invites collections all grow
// unboundedly over the app's lifetime, and an unbounded scan risks memory
// pressure and a single giant, slow read on every sweep run regardless of
// how much of that data the sweep actually needs to touch that day. The
// caller's query MUST already carry an explicit `.orderBy(...)` (matching
// its own filters) so `.startAfter(cursor)` cursors correctly between pages.
async function* paginate(
  baseQuery: FirebaseFirestore.Query, pageSize: number,
): AsyncGenerator<FirebaseFirestore.QueryDocumentSnapshot[]> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = baseQuery.limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.docs.length < pageSize) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

const SERIES_PAGE_SIZE = 100;
const SWEEP_PAGE_SIZE = 500;

export interface SweepReport {
  occurrencesCreated: number;
  seriesAdvanced: number;
  pastGigsClosed: number;
  tracksFailed: number;
  invitesRevoked: number;
  // P4: series skipped by the materializer cap guard (profile already at/
  // over MAX_OPEN_GIGS_PER_PROFILE open gigs) or the TOCTOU re-read (series
  // was paused/ended between the initial scan and this series' write).
  seriesSkippedCapped: number;
  seriesSkippedRace: number;
  // S4: curatorAccessRetries entries successfully retried (and cleared) this run.
  curatorAccessRetried: number;
  // S3: per-step failure counts — a step that throws is caught, logged, and
  // counted here rather than aborting the remaining steps.
  errors: {
    series: number; pastGigs: number; tracks: number; invites: number; curatorAccessRetries: number;
  };
}

// The daily sweep's entire behavior lives in this plain, exported function so
// tests can invoke it directly with an injected clock (`now`) against
// emulator-seeded data — no scheduler emulator config, no wall-clock races.
//
// S3: each of the five steps below is independently wrapped in its own
// try/catch — a poisoned doc (e.g. a malformed series) that makes ONE step
// throw is logged and counted in `report.errors`, but never prevents the
// REMAINING steps from running. Each step also owns its own chunked writer,
// committed at the end of that step's try block, so one step's failure can
// only ever lose that step's own not-yet-durable writes, never another
// step's.
export async function runDailySweep(now: number): Promise<SweepReport> {
  const db = getFirestore();
  const report: SweepReport = {
    occurrencesCreated: 0, seriesAdvanced: 0, pastGigsClosed: 0, tracksFailed: 0, invitesRevoked: 0,
    seriesSkippedCapped: 0, seriesSkippedRace: 0, curatorAccessRetried: 0,
    errors: { series: 0, pastGigs: 0, tracks: 0, invites: 0, curatorAccessRetries: 0 },
  };

  // 1) Materialize active series.
  //
  // INVARIANT (load-bearing): only `status == "active"` series may gain
  // occurrences — paused/ended series must never be materialized. This is
  // enforced by the QUERY FILTER below, not a post-filter: a paused/ended
  // series is never even fetched, so there is no code path downstream that
  // could accidentally materialize one. (P4/M-10 adds a SECOND, per-series
  // re-check right before writing — see below — for the narrower race where
  // a series is paused/ended AFTER this initial scan but before its write.)
  try {
    const writer = createChunkedWriter(db);
    const seriesQuery = db.collection("gigSeries").where("status", "==", "active").orderBy(FieldPath.documentId());
    for await (const page of paginate(seriesQuery, SERIES_PAGE_SIZE)) {
      for (const seriesDoc of page) {
        const series = seriesDoc.data() as GigSeriesDoc;
        const { startsAtList, newMaterializedThrough } = computeOccurrences(series, now);
        if (newMaterializedThrough <= series.materializedThrough) continue; // nothing new for this series

        // P4: materializer cap guard — MAX_OPEN_GIGS_PER_PROFILE bounds a
        // profile's total open gigs; createGig/publishGig enforce it at
        // request time, but the daily materializer is the OTHER writer of
        // "open" gigs and, unguarded, could blow well past it in one run
        // (worst case: MAX_OPEN_GIGS_PER_PROFILE manually-published gigs +
        // MAX_ACTIVE_SERIES_PER_PROFILE series each materializing a full
        // SERIES_MATERIALIZE_WEEKS-wide weekly window on their first run —
        // roughly 50 + 10*8 = 130 open gigs for one profile). Skip (log +
        // count) rather than partially materializing; matches this
        // codebase's established non-transactional-cap-read tier (see
        // createGig/createSeries) rather than a hard global enforcement.
        const openCount = await db.collection("gigs")
          .where("curatorProfileId", "==", series.curatorProfileId).where("status", "==", "open").count().get();
        if (openCount.data().count >= MAX_OPEN_GIGS_PER_PROFILE) {
          report.seriesSkippedCapped++;
          continue;
        }

        // P4/M-10 (TOCTOU): re-read the series' status immediately before
        // writing its occurrences. The scan above filtered status=='active'
        // at the START of this run, but a curator (pauseSeries/endSeries) or
        // an admin takedown (takedownGig scope:"series") can flip that
        // status in the window between that scan and this write — cheap
        // with per-step writers (one extra get per series that's actually
        // about to be written, not per occurrence).
        const freshSnap = await seriesDoc.ref.get();
        if (freshSnap.data()?.status !== "active") {
          report.seriesSkippedRace++;
          continue;
        }

        for (const startsAt of startsAtList) {
          const gigRef = db.collection("gigs").doc();
          // status:"open" — the profile was approved at series creation, and
          // the cascade that unpublishes a rejected profile's content also
          // pauses its series (Task 6), so an occurrence of an active
          // series is legitimately publishable straight away, unlike
          // createGig's "draft" default for a member-authored one-off.
          const gig: GigDoc = {
            curatorProfileId: series.curatorProfileId, seriesId: seriesDoc.id, detachedFromTemplate: false,
            title: series.template.title, description: series.template.description, wants: series.template.wants,
            budget: series.template.budget, startsAt, durationMinutes: series.template.durationMinutes,
            provisions: series.template.provisions, location: series.template.location,
            status: "open", createdAt: now, updatedAt: now,
          };
          await writer.set(gigRef, gig);
          // Mirrors createGig's own write and updateSeries' propagation sweep —
          // both halves of the template (public content + the exact private
          // address/geo) land on every occurrence.
          await writer.set(db.doc(`gigs/${gigRef.id}/private/location`), series.templatePrivateLocation);
        }
        await writer.update(seriesDoc.ref, { materializedThrough: newMaterializedThrough, updatedAt: now });
        report.occurrencesCreated += startsAtList.length;
        report.seriesAdvanced += 1;
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: series materialization step failed", e);
    report.errors.series++;
  }

  // 2) Past sweep: an "open" gig whose start time has elapsed closes
  // automatically. Reuses the existing (status,startsAt) composite index.
  try {
    const writer = createChunkedWriter(db);
    const pastQuery = db.collection("gigs")
      .where("status", "==", "open").where("startsAt", "<", now).orderBy("startsAt");
    for await (const page of paginate(pastQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        await writer.update(doc.ref, { status: "closed", updatedAt: now });
        report.pastGigsClosed++;
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: past-gig sweep step failed", e);
    report.errors.pastGigs++;
  }

  // 3) Track reaper (SP2 debt): a track stuck in "processing" for more than
  // 24h means the transcode trigger never completed — fail it so it stops
  // occupying one of the uploader's MAX_TRACKS active slots (tracks.ts's
  // ACTIVE_TRACK_STATUSES). The query filters on status alone (a
  // collection-group equality query, already index-enabled for
  // "tracks"/"status" via firestore.indexes.json's fieldOverride); the 24h
  // age check runs in application code rather than adding a new composite
  // collection-group index for what's normally a tiny, transient result set.
  try {
    const writer = createChunkedWriter(db);
    const processingCutoff = now - PROCESSING_STALE_MS;
    const trackQuery = db.collectionGroup("tracks").where("status", "==", "processing").orderBy(FieldPath.documentId());
    for await (const page of paginate(trackQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        const createdAt = doc.data().createdAt as number;
        if (createdAt < processingCutoff) {
          await writer.update(doc.ref, { status: "failed", failureReason: "Upload abandoned", updatedAt: now });
          report.tracksFailed++;
        }
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: track reaper step failed", e);
    report.errors.tracks++;
  }

  // 4) Invite sweep (SP2 debt): a pending invite past its expiry is revoked
  // so it stops counting against MAX_PENDING_INVITES_PER_PROFILE.
  // INVITE_MAX_AGE_MS is imported from members.ts (the same constant
  // respondToInvite already enforces at accept-time) rather than redefined
  // here. Same app-code-filters-the-age pattern as the track reaper, over
  // the existing "status" equality (part of the (profileId,status) index).
  try {
    const writer = createChunkedWriter(db);
    const inviteCutoff = now - INVITE_MAX_AGE_MS;
    const inviteQuery = db.collection("invites").where("status", "==", "pending").orderBy(FieldPath.documentId());
    for await (const page of paginate(inviteQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        const createdAt = doc.data().createdAt as number;
        if (createdAt < inviteCutoff) {
          await writer.update(doc.ref, { status: "revoked" });
          report.invitesRevoked++;
        }
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: invite sweep step failed", e);
    report.errors.invites++;
  }

  // 5) curatorAccess retry sweep (S4): retries syncCuratorAccess for any uid
  // whose recompute failed at its original touchpoint (reviewProfile's
  // reject-from-approved cascade — see review.ts's curatorAccessRetries
  // write) and was recorded to curatorAccessRetries/{uid}. Deletes the
  // retry doc on success; a renewed failure here leaves it in place (and
  // aborts the rest of THIS step, per the same step-level try/catch as
  // steps 1-4) to retry again on the next day's run.
  try {
    const writer = createChunkedWriter(db);
    const retryQuery = db.collection("curatorAccessRetries").orderBy(FieldPath.documentId());
    for await (const page of paginate(retryQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        await syncCuratorAccess(doc.id);
        await writer.delete(doc.ref);
        report.curatorAccessRetried++;
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: curatorAccess retry step failed", e);
    report.errors.curatorAccessRetries++;
  }

  return report;
}

// Thin wrapper — all logic lives in runDailySweep above so it's directly
// testable with an injected clock. 09:00 UTC (firebase-functions v2's
// "every day HH:MM" schedule syntax defaults to UTC absent an explicit
// timeZone option) is an arbitrary daily slot; picking the launch metro's
// actual low-traffic window is a launch-checklist refinement alongside the
// anchor-timezone note above.
//
// S3: timeoutSeconds: 540 (9 minutes — the v2 scheduler max is 540s for a
// non-Cloud-Run-based function) and memory: "512MiB" give the sweep real
// headroom now that its five steps page through potentially large
// collections; the default 60s/256MiB was sized for the original four-step,
// unbounded-`.get()` implementation and was already a latent risk at scale.
export const dailySweep = onSchedule(
  { schedule: "every day 09:00", region: "us-central1", timeoutSeconds: 540, memory: "512MiB" },
  async () => { await runDailySweep(Date.now()); },
);

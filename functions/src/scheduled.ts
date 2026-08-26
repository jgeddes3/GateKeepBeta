import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import {
  SERIES_MATERIALIZE_WEEKS,
  type GigSeriesDoc, type GigDoc, type SeriesCadence,
} from "@gatekeep/shared";
import { INVITE_MAX_AGE_MS } from "./members.js";

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
  let candidate = anchor;
  // Half-open interval convention: a run covers [materializedThrough,
  // windowEnd) — candidates strictly less than windowEnd are materialized,
  // and the watermark then advances to windowEnd itself (the exclusive
  // upper edge already scanned, not a candidate that was skipped). The skip-
  // ahead below must match with `<`/ceil, not `<=`/floor+1: a candidate
  // exactly EQUAL to materializedThrough is the first NOT-yet-covered
  // instant (materializedThrough is where the previous run's `< windowEnd`
  // cut off, so that exact value was never itself materialized) and must
  // remain eligible here. Using `<=`/floor+1 here would treat that instant
  // as already covered and permanently skip it — losing an occurrence
  // whenever the window boundary lands exactly on a grid point.
  if (candidate < series.materializedThrough) {
    const stepsToSkip = Math.ceil((series.materializedThrough - candidate) / step);
    candidate += stepsToSkip * step;
  }
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
    async commit(): Promise<void> {
      if (ops > 0) await batch.commit();
    },
  };
}

export interface SweepReport {
  occurrencesCreated: number;
  seriesAdvanced: number;
  pastGigsClosed: number;
  tracksFailed: number;
  invitesRevoked: number;
}

// The daily sweep's entire behavior lives in this plain, exported function so
// tests can invoke it directly with an injected clock (`now`) against
// emulator-seeded data — no scheduler emulator config, no wall-clock races.
export async function runDailySweep(now: number): Promise<SweepReport> {
  const db = getFirestore();
  const writer = createChunkedWriter(db);
  const report: SweepReport = {
    occurrencesCreated: 0, seriesAdvanced: 0, pastGigsClosed: 0, tracksFailed: 0, invitesRevoked: 0,
  };

  // 1) Materialize active series.
  //
  // INVARIANT (load-bearing): only `status == "active"` series may gain
  // occurrences — paused/ended series must never be materialized. This is
  // enforced by the QUERY FILTER below, not a post-filter: a paused/ended
  // series is never even fetched, so there is no code path downstream that
  // could accidentally materialize one.
  const activeSeriesSnap = await db.collection("gigSeries").where("status", "==", "active").get();
  for (const seriesDoc of activeSeriesSnap.docs) {
    const series = seriesDoc.data() as GigSeriesDoc;
    const { startsAtList, newMaterializedThrough } = computeOccurrences(series, now);
    if (newMaterializedThrough <= series.materializedThrough) continue; // nothing new for this series

    for (const startsAt of startsAtList) {
      const gigRef = db.collection("gigs").doc();
      // status:"open" — the profile was approved at series creation, and the
      // cascade that unpublishes a rejected profile's content also pauses
      // its series (Task 6), so an occurrence of an active series is
      // legitimately publishable straight away, unlike createGig's "draft"
      // default for a member-authored one-off.
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

  // 2) Past sweep: an "open" gig whose start time has elapsed closes
  // automatically. Reuses the existing (status,startsAt) composite index.
  const pastSnap = await db.collection("gigs")
    .where("status", "==", "open").where("startsAt", "<", now).get();
  for (const doc of pastSnap.docs) {
    await writer.update(doc.ref, { status: "closed", updatedAt: now });
    report.pastGigsClosed++;
  }

  // 3) Track reaper (SP2 debt): a track stuck in "processing" for more than
  // 24h means the transcode trigger never completed — fail it so it stops
  // occupying one of the uploader's MAX_TRACKS active slots (tracks.ts's
  // ACTIVE_TRACK_STATUSES). The query filters on status alone (a
  // collection-group equality query, already index-enabled for
  // "tracks"/"status" via firestore.indexes.json's fieldOverride); the 24h
  // age check runs in application code rather than adding a new composite
  // collection-group index for what's normally a tiny, transient result set.
  const processingCutoff = now - PROCESSING_STALE_MS;
  const processingSnap = await db.collectionGroup("tracks").where("status", "==", "processing").get();
  for (const doc of processingSnap.docs) {
    const createdAt = doc.data().createdAt as number;
    if (createdAt < processingCutoff) {
      await writer.update(doc.ref, { status: "failed", failureReason: "Upload abandoned", updatedAt: now });
      report.tracksFailed++;
    }
  }

  // 4) Invite sweep (SP2 debt): a pending invite past its expiry is revoked
  // so it stops counting against MAX_PENDING_INVITES_PER_PROFILE.
  // INVITE_MAX_AGE_MS is imported from members.ts (the same constant
  // respondToInvite already enforces at accept-time) rather than redefined
  // here. Same app-code-filters-the-age pattern as the track reaper, over
  // the existing "status" equality (part of the (profileId,status) index).
  const inviteCutoff = now - INVITE_MAX_AGE_MS;
  const pendingInvitesSnap = await db.collection("invites").where("status", "==", "pending").get();
  for (const doc of pendingInvitesSnap.docs) {
    const createdAt = doc.data().createdAt as number;
    if (createdAt < inviteCutoff) {
      await writer.update(doc.ref, { status: "revoked" });
      report.invitesRevoked++;
    }
  }

  await writer.commit();
  return report;
}

// Thin wrapper — all logic lives in runDailySweep above so it's directly
// testable with an injected clock. 09:00 UTC (firebase-functions v2's
// "every day HH:MM" schedule syntax defaults to UTC absent an explicit
// timeZone option) is an arbitrary daily slot; picking the launch metro's
// actual low-traffic window is a launch-checklist refinement alongside the
// anchor-timezone note above.
export const dailySweep = onSchedule(
  { schedule: "every day 09:00", region: "us-central1" },
  async () => { await runDailySweep(Date.now()); },
);

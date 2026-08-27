import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import {
  SERIES_MATERIALIZE_WEEKS, MAX_OPEN_GIGS_PER_PROFILE,
  type GigSeriesDoc, type GigDoc, type SeriesCadence, type BookingRequestDoc, type ReliabilityDoc,
} from "@gatekeep/shared";
import { INVITE_MAX_AGE_MS } from "./members.js";
import { syncCuratorAccess } from "./curator.js";
import { recomputeReliability } from "./bookingLifecycle.js";
import { notifyProfileMembers } from "./notifications.js";

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
  // SP4 Task 8 — step 1 (materializer): occurrences born already status:
  // "filled" (a whole-run series whose active booking is still confirmed at
  // materialization time — see step 1's own comment below); a subset of
  // occurrencesCreated, not additional to it.
  occurrencesBornFilled: number;
  // SP4 Task 8 — step 1: a series' activeBookingId named a booking that
  // turned out NOT confirmed at the fresh re-read (the booking has since
  // expired/cancelled/completed through some path that didn't already clear
  // this series' own linkage) — self-healed by birthing this run's
  // occurrences "open" instead and clearing the stale linkage.
  seriesSelfHealed: number;
  // SP4 Task 8 — step 6: "open" bookings expired because their target gig
  // became unavailable (elapsed startsAt, or any non-"open" status) without
  // ever being resolved by acceptBooking's sibling-supersede fan-out or
  // unwindBookingsForModeration (both best-effort, failure-isolated).
  bookingsExpired: number;
  // SP4 Task 8 — step 7: "confirmed" bookings resolved to "completed" (their
  // last linked occurrence has ended). Does NOT include zombie resolutions
  // that resolved to "expired" instead — see bookingsExpired above, which
  // those are counted under.
  bookingsCompleted: number;
  // SP4 Task 8 — step 7: whole-run confirmed bookings resolved (to either
  // "completed" or "expired" — see bookingsCompleted/bookingsExpired above,
  // which those are ALSO counted under) via the zero-future-linked-occurrence
  // rule — the committed resolver for the pause/end tolerance path
  // (pauseSeries/endSeries's cancelActiveRunBookingTolerant) and for a run
  // whose schedule simply ran its course. A diagnostic sub-metric, not an
  // additional outcome.
  bookingsResolvedZombie: number;
  // S3: per-step failure counts — a step that throws is caught, logged, and
  // counted here rather than aborting the remaining steps.
  errors: {
    series: number; pastGigs: number; tracks: number; invites: number; curatorAccessRetries: number;
    bookingExpiry: number; bookingCompletion: number;
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
    occurrencesBornFilled: 0, seriesSelfHealed: 0,
    bookingsExpired: 0, bookingsCompleted: 0, bookingsResolvedZombie: 0,
    errors: {
      series: 0, pastGigs: 0, tracks: 0, invites: 0, curatorAccessRetries: 0,
      bookingExpiry: 0, bookingCompletion: 0,
    },
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
        //
        // SP4 (Task 8): this guard is later IGNORED for a filled birth (see
        // below) — a whole-run booking's occurrences are committed work the
        // curator already owes the musician, never a fresh open slot. It
        // still runs HERE, unconditionally, rather than only when a filled
        // birth turns out NOT to be happening, so this step's per-series
        // round-trip shape/timing stays identical to before this change —
        // the M-10 TOCTOU race test below depends on the number of real
        // Firestore round-trips that occur before the freshSnap re-read.
        const openCount = await db.collection("gigs")
          .where("curatorProfileId", "==", series.curatorProfileId).where("status", "==", "open").count().get();
        const isCapped = openCount.data().count >= MAX_OPEN_GIGS_PER_PROFILE;

        // P4/M-10 (TOCTOU): re-read the series' status immediately before
        // writing its occurrences. The scan above filtered status=='active'
        // at the START of this run, but a curator (pauseSeries/endSeries) or
        // an admin takedown (takedownGig scope:"series") can flip that
        // status in the window between that scan and this write — cheap
        // with per-step writers (one extra get per series that's actually
        // about to be written, not per occurrence).
        const freshSnap = await seriesDoc.ref.get();
        const freshSeries = freshSnap.data() as GigSeriesDoc | undefined;
        if (freshSeries?.status !== "active") {
          report.seriesSkippedRace++;
          continue;
        }

        // SP4 (Task 8): birth mode — FRESH activeBookingId + a fresh re-read
        // of THAT booking's own status (not the initial scan's `series`
        // object, which can be stale by the time we get here — same race
        // window the M-10 re-read above already guards for `status`)
        // decides whether this series' new occurrences are committed
        // (filled) work or fresh open slots.
        let birthAs: { status: "filled"; bookingId: string; bookedMusicianProfileId: string } | { status: "open" } =
          { status: "open" };
        let selfHeal = false;
        if (freshSeries.activeBookingId) {
          const bookingSnap = await db.doc(`bookings/${freshSeries.activeBookingId}`).get();
          const booking = bookingSnap.data() as BookingRequestDoc | undefined;
          if (booking?.status === "confirmed") {
            birthAs = {
              status: "filled", bookingId: freshSeries.activeBookingId,
              bookedMusicianProfileId: freshSeries.bookedMusicianProfileId ?? booking.musicianProfileId,
            };
          } else {
            // Stale linkage — the booking this series still names is no
            // longer confirmed (expired/cancelled/completed through some
            // path that didn't already clear this field — step 7 below and
            // bookingLifecycle.ts's own ownership-gated clears handle the
            // normal paths; this is the defensive backstop for whatever
            // those miss). Self-heal: birth open instead, and clear the
            // stale linkage in the SAME write as materializedThrough below.
            selfHeal = true;
          }
        }

        // The cap guard only ever blocks a fresh OPEN slot — see this
        // guard's own comment above for why a filled birth ignores `isCapped`
        // outright rather than never having computed it.
        if (birthAs.status === "open" && isCapped) {
          report.seriesSkippedCapped++;
          continue;
        }

        for (const startsAt of startsAtList) {
          const gigRef = db.collection("gigs").doc();
          // status:"open" (or, SP4 Task 8, "filled" for a booked run's
          // committed occurrences) — the profile was approved at series
          // creation, and the cascade that unpublishes a rejected profile's
          // content also pauses its series (Task 6), so an occurrence of an
          // active series is legitimately publishable straight away, unlike
          // createGig's "draft" default for a member-authored one-off.
          const gig: GigDoc = {
            curatorProfileId: series.curatorProfileId, seriesId: seriesDoc.id, detachedFromTemplate: false,
            title: series.template.title, description: series.template.description, wants: series.template.wants,
            budget: series.template.budget, startsAt, durationMinutes: series.template.durationMinutes,
            provisions: series.template.provisions, location: series.template.location,
            status: birthAs.status, createdAt: now, updatedAt: now,
            bookingId: birthAs.status === "filled" ? birthAs.bookingId : null,
            bookedMusicianProfileId: birthAs.status === "filled" ? birthAs.bookedMusicianProfileId : null,
          };
          await writer.set(gigRef, gig);
          // Mirrors createGig's own write and updateSeries' propagation sweep —
          // both halves of the template (public content + the exact private
          // address/geo) land on every occurrence.
          await writer.set(db.doc(`gigs/${gigRef.id}/private/location`), series.templatePrivateLocation);
          if (birthAs.status === "filled") report.occurrencesBornFilled++;
        }
        const seriesUpdate: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
          materializedThrough: newMaterializedThrough, updatedAt: now,
        };
        if (selfHeal) {
          seriesUpdate.activeBookingId = null;
          seriesUpdate.bookedMusicianProfileId = null;
          report.seriesSelfHealed++;
        }
        await writer.update(seriesDoc.ref, seriesUpdate);
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

  // 6) Booking expiry sweep (SP4 Task 8): an "open" booking whose target gig
  // has since become unavailable (its startsAt elapsed, or its status is
  // anything other than "open" — filled by a rival, closed, cancelled, taken
  // down) never got resolved by acceptBooking's sibling-supersede fan-out or
  // unwindBookingsForModeration's cascades (both best-effort and
  // failure-isolated — see their own comments in bookings.ts/
  // bookingLifecycle.ts). This step is the backstop that guarantees no
  // "open" booking lingers forever against a gig that can never again be
  // accepted into. Booking-scoped: reads booking.gigId directly (one extra
  // get per "open" booking) rather than a join query — the "open" bookings
  // query itself is what's paginated.
  try {
    const writer = createChunkedWriter(db);
    const openBookingsQuery = db.collection("bookings").where("status", "==", "open").orderBy(FieldPath.documentId());
    for await (const page of paginate(openBookingsQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        const booking = doc.data() as BookingRequestDoc;
        const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
        const gig = gigSnap.data() as GigDoc | undefined;
        if (!gig) continue; // defensive — a booking always names an existing gig
        if (gig.startsAt < now || gig.status !== "open") {
          await writer.update(doc.ref, { status: "expired", resolvedAt: now, updatedAt: now });
          report.bookingsExpired++;
          // Per-item try/catch (S3 sweep philosophy) — one failed notify
          // must never abort the rest of this step.
          try {
            await notifyProfileMembers(booking.musicianProfileId, {
              kind: "booking", title: "Booking no longer available", body: "This gig is no longer available.",
            });
          } catch (e) {
            console.error(`dailySweep: failed to notify expired booking ${doc.id}`, e);
          }
        }
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: booking expiry sweep step failed", e);
    report.errors.bookingExpiry++;
  }

  // 7) Booking completion sweep (SP4 Task 8): resolves every "confirmed"
  // booking whose committed work is actually done. Booking-scoped occurrence
  // linkage — "linked" means gigs where bookingId == this booking's own id
  // (the (bookingId,status,startsAt) index — mirrors bookingLifecycle.ts's
  // getFutureFilledOccurrences/reportNoShow rationale for the same booking-
  // scoping). The query below ALSO filters status=="filled" — linkage does
  // NOT imply status:"filled": takedownGig's occurrence scope deliberately
  // leaves bookingId/bookedMusicianProfileId set on a gig it flips to
  // "taken_down" when that gig belongs to a still-CONFIRMED whole-run
  // booking (see gigs.ts's takedownGig — the run survives, only that one
  // date is pulled), so a linked gig can be "taken_down". Without the status
  // filter, a future taken-down-but-still-linked date would be picked as the
  // "last linked occurrence", delaying this booking's resolution until that
  // NEVER-TO-HAPPEN date's fictional end time, then wrongly awarding
  // "completed" (+completedCount, a curator-facing reliability metric) for a
  // performance that never occurred. Filtering to "filled" makes the query
  // see only dates that remained genuinely booked, so the most-recently-
  // dated MATCH is exactly the run's (or single gig's) own last performed
  // (or still-pending) date.
  //
  // Single-gig and whole-run bookings share ONE rule: find the FILLED linked
  // gig with the latest startsAt.
  //  - none found: either every occurrence this booking ever filled has
  //    since been individually reopened (cancelOccurrence) or taken down
  //    before it happened — nothing was ever performed. Whole-run only (a
  //    single-gig booking has no cancelOccurrence path, and takedownGig's
  //    occurrence-scope skip doesn't apply to it either — see the unwind
  //    note above — so this can't happen to one) — resolves to "expired"
  //    (the AMENDMENT's zombie resolver, no-past-linked-occurrence branch).
  //  - found, but it hasn't ENDED yet (startsAt + durationMinutes > now):
  //    still ongoing — for a whole-run booking this also covers "series
  //    still active, more dates queued": step 1 above always births the next
  //    due occurrence (already filled — see step 1's own comment) before
  //    this step runs each sweep, so a genuinely ongoing active series'
  //    booking always has a fresh future linked occurrence by this point —
  //    skip.
  //  - found and ENDED: resolves to "completed". This is simultaneously the
  //    plan's "Normal" completion path (single-gig; or a whole-run booking
  //    whose schedule genuinely ran its course) and the AMENDMENT's zombie
  //    resolver "completed" branch (whole-run whose remaining dates were all
  //    individually cancelled/taken down, or whose series paused/ended and
  //    cancelActiveRunBookingTolerant — gigSeries.ts — found nothing left to
  //    cancel) — both collapse to the identical "last FILLED linked
  //    occurrence already ended" check, so one code path serves both without
  //    the two framings ever disagreeing on the outcome.
  //
  // Do NOT complete a confirmed booking whose future FILLED linked
  // occurrences still exist and whose last one hasn't ended — see the
  // "found, not yet ended" bullet above.
  //
  // Whole-run resolutions (either branch) ALSO clear the series'
  // activeBookingId/bookedMusicianProfileId — ownership-gated (only when the
  // series still names THIS booking) and best-effort ({lastUpdateTime}
  // idiom, mirroring unwindBookingsForModeration's own series-linkage clear
  // in bookingLifecycle.ts) — without this, a completed/expired run would
  // permanently block the series from ever accepting a fresh whole-run
  // booking (acceptBooking's rebooking-door guard refuses whenever
  // activeBookingId names ANY booking other than the one being accepted,
  // regardless of that named booking's own status).
  //
  // Status-guarded idempotency: once resolved, a booking's status is no
  // longer "confirmed", so a later sweep run's query naturally excludes it —
  // the zombie resolver (or the normal completion path) can never re-fire.
  try {
    const writer = createChunkedWriter(db);
    const confirmedQuery = db.collection("bookings").where("status", "==", "confirmed").orderBy(FieldPath.documentId());
    for await (const page of paginate(confirmedQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        const bookingId = doc.id;
        const booking = doc.data() as BookingRequestDoc;
        const isWholeRun = booking.seriesId != null;

        const lastLinkedSnap = await db.collection("gigs")
          .where("bookingId", "==", bookingId).where("status", "==", "filled")
          .orderBy("startsAt", "desc").limit(1).get();
        const lastLinked = lastLinkedSnap.docs[0]?.data() as GigDoc | undefined;

        let outcome: "completed" | "expired" | null = null;
        if (!lastLinked) {
          // Single-gig booking with no linked gig at all is defensive/
          // unreachable (its one gig always stays linked while the booking
          // stays confirmed) — only the whole-run zombie case is real.
          if (isWholeRun) outcome = "expired";
          // `startsAt` is epoch ms; `durationMinutes` is minutes — the *
          // 60_000 conversion is load-bearing (without it this collapses to
          // "has this occurrence STARTED", not "has it ENDED").
        } else if (lastLinked.startsAt + lastLinked.durationMinutes * 60_000 <= now) {
          outcome = "completed";
        }
        if (outcome === null) continue; // still ongoing — nothing to resolve yet

        await writer.update(doc.ref, { status: outcome, resolvedAt: now, updatedAt: now });
        if (outcome === "completed") report.bookingsCompleted++;
        else report.bookingsExpired++;
        if (isWholeRun) report.bookingsResolvedZombie++;

        if (outcome === "completed") {
          // Read-modify-write on the reliability doc (create-if-missing),
          // then recomputeReliability — mirrors bookingLifecycle.ts's own
          // completedCount bump idiom. Direct (non-batched) calls, awaited
          // in-loop rather than queued on `writer`: recomputeReliability
          // does its OWN read of this same doc immediately after, which
          // must see the incremented count, not a still-uncommitted batched
          // write.
          const reliabilityRef = db.doc(`profiles/${booking.musicianProfileId}/private/reliability`);
          const reliabilitySnap = await reliabilityRef.get();
          const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
          await reliabilityRef.set({
            marks: reliability?.marks ?? [],
            completedCount: (reliability?.completedCount ?? 0) + 1,
            updatedAt: now,
          }, { merge: true });
          await recomputeReliability(booking.musicianProfileId);
        }

        if (isWholeRun) {
          try {
            const seriesRef = db.doc(`gigSeries/${booking.seriesId}`);
            const seriesSnap = await seriesRef.get();
            const series = seriesSnap.data() as GigSeriesDoc | undefined;
            if (series?.activeBookingId === bookingId) {
              await seriesRef.update(
                { activeBookingId: null, bookedMusicianProfileId: null, updatedAt: now },
                { lastUpdateTime: seriesSnap.updateTime });
            }
          } catch (e) {
            console.error(`dailySweep: failed to clear series linkage for booking ${bookingId}`, e);
          }
        }

        try {
          const notifyTitle = outcome === "completed" ? "Booking completed" : "Booking run ended";
          const notifyBody = outcome === "completed"
            ? "This booking is now complete."
            : "This booking's run ended before any date took place.";
          await notifyProfileMembers(booking.musicianProfileId, { kind: "booking", title: notifyTitle, body: notifyBody });
          await notifyProfileMembers(booking.curatorProfileId, { kind: "booking", title: notifyTitle, body: notifyBody });
        } catch (e) {
          console.error(`dailySweep: failed to notify booking resolution ${bookingId}`, e);
        }
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: booking completion sweep step failed", e);
    report.errors.bookingCompletion++;
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

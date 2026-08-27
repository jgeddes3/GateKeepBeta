import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, MAX_CANCEL_REASON_LENGTH, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  MAX_RELIABILITY_MARKS, NO_SHOW_REPORT_WINDOW_DAYS, MAX_OCCURRENCE_CANCELLATIONS, CANCEL_GRACE_MS,
  type BookingRequestDoc, type BookingSide, type GigDoc, type GigSeriesDoc,
  type ReliabilityDoc, type ReliabilityMark, type OccurrenceCancellation,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";

// Same "already started" message for both the whole-booking and
// single-occurrence cancel paths — a caller who missed the cancellation
// window is pointed at the same remedy (reportNoShow) either way. Exported
// (Task 7 fix) so a caller that needs to distinguish executeCancellation's
// "no cancellable dates left" family of failures from any other can match
// on the exact constant — see gigSeries.ts's pauseSeries/endSeries, which
// must tolerate exactly this family without ad-hoc substring matching.
export const ALREADY_STARTED_MESSAGE = "This booking has already started — report a no-show instead.";

// Task 7 carry-forward (b): a whole-run booking whose future-filled
// occurrence set is empty is NOT always "already started" — its dates may
// instead have been cancelled one-by-one via cancelOccurrence, or re-filled
// by a LATER booking of the same series (see executeCancellation's own
// comment on how these two cases are told apart from a genuine past-start).
// This is the truthful alternative for that case. Exported for the same
// reason as ALREADY_STARTED_MESSAGE above.
export const NO_UPCOMING_DATES_MESSAGE =
  "No upcoming booked dates remain on this booking — nothing to cancel.";

type CancelOutcome = "deposit_forfeited" | "deposit_refunded";

function validateCancelReason(reason: unknown): string {
  if (typeof reason !== "string") throw new HttpsError("invalid-argument", "A reason is required.");
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_CANCEL_REASON_LENGTH) {
    throw new HttpsError("invalid-argument", `Reason must be 1-${MAX_CANCEL_REASON_LENGTH} characters.`);
  }
  return trimmed;
}

// Dedicated side-resolver for this file's callables — deliberately NOT
// bookings.ts's requireBookingSide, which resolves musician-first and never
// complains about a caller who is a member of BOTH the musician and curator
// profile on the same booking (an edge case that idiom doesn't need to care
// about, since none of Task 4/5's turn-based callables can be exploited by
// it — the transactional awaitingSide check still picks exactly one turn).
// Cancellation/no-show, by contrast, computes a side-DEPENDENT outcome
// (curator forfeits, musician gets marked) purely from which side the
// caller resolves to — silently picking one side for a dual-member would
// let that member choose their own favorable outcome. Refuse instead.
async function resolveBookingSideStrict(booking: BookingRequestDoc, uid: string): Promise<BookingSide> {
  const db = getFirestore();
  const [musicianMember, curatorMember] = await Promise.all([
    db.doc(`profiles/${booking.musicianProfileId}/members/${uid}`).get(),
    db.doc(`profiles/${booking.curatorProfileId}/members/${uid}`).get(),
  ]);
  if (musicianMember.exists && curatorMember.exists) {
    throw new HttpsError("failed-precondition",
      "You are a member of both sides of this booking — ambiguous which side you're acting as.");
  }
  if (musicianMember.exists) return "musician";
  if (curatorMember.exists) return "curator";
  throw new HttpsError("permission-denied", "Only a member of this booking's profiles can do that.");
}

// Drop-oldest cap — a legitimate late-cancel/no-show mark is never REJECTED
// for hitting a ceiling (contrast flagAccount's reject-when-full moderation
// notes, which is a different kind of unbounded-growth problem); the most
// recent MAX_RELIABILITY_MARKS marks are what matters for a reliability
// history, so the oldest is silently dropped instead. Pure — every callable
// below reads profiles/{id}/private/reliability in its OWN transaction's
// read phase, calls this to build the next array, then tx.set()s it in the
// same transaction's write phase (atomic with the booking/gig write it
// accompanies — a crash between the two must never lose a mark that a
// committed cancellation/no-show already implies, since nothing else would
// ever re-add it).
function appendMarkCapped(marks: ReliabilityMark[], mark: ReliabilityMark): ReliabilityMark[] {
  const next = [...marks, mark];
  return next.length > MAX_RELIABILITY_MARKS ? next.slice(next.length - MAX_RELIABILITY_MARKS) : next;
}

// Recounts profiles/{id}/private/reliability into the noShowCount/
// completedCount summary that lives inside profiles/{id}/private/
// curatorBooking — see bookingVisibility.ts's rebuildBookingProjections
// comment, which already names this function as curatorBooking's SECOND
// writer (the first being rebuildBookingProjections itself, which rewrites
// the whole doc from rates/preferences/reliability together). This function
// merge-writes ONLY the `reliability` + `updatedAt` keys, so it never
// clobbers rates/preferences written by the other path. `removedByAdmin`
// marks are excluded from noShowCount (audit-preserving: the mark itself is
// never deleted, only excluded from the count a curator shops by) —
// mirrors rebuildBookingProjections' own `marks.filter((m) =>
// !m.removedByAdmin)` idiom exactly.
export async function recomputeReliability(musicianProfileId: string): Promise<void> {
  const db = getFirestore();
  const reliabilitySnap = await db.doc(`profiles/${musicianProfileId}/private/reliability`).get();
  const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
  const marks = reliability?.marks ?? [];
  const noShowCount = marks.filter((m) => !m.removedByAdmin).length;
  const completedCount = reliability?.completedCount ?? 0;
  // merge:true — the projection may not exist yet (no booking info has ever
  // been saved for this profile); this creates a summary-only doc in that
  // case rather than requiring rebuildBookingProjections to have run first.
  await db.doc(`profiles/${musicianProfileId}/private/curatorBooking`).set(
    { reliability: { noShowCount, completedCount }, updatedAt: Date.now() },
    { merge: true },
  );
}

// Every FUTURE, currently-filled occurrence of a whole-run series that is
// STILL this specific booking's own (via the (seriesId,status,startsAt)
// composite index — see firestore.indexes.json — then filtered to
// bookingId==bookingId in application code, rather than adding a fourth
// composite-index field). A past/started occurrence (startsAt <= now) is
// excluded — it keeps its "filled" status untouched (Task 8's sweep is what
// eventually resolves it to completed/no-show, not these callables).
//
// The bookingId filter matters once a series has had more than one
// whole-run booking over its life — e.g. an earlier booking's date was
// reopened via cancelOccurrence and a LATER booking re-filled it while the
// earlier booking is still "confirmed" for its own remaining dates. Without
// this filter, a cancelBooking/reportNoShow call against the OLDER booking
// could reopen occurrences that actually belong to the NEWER, still-active
// booking.
//
// Shared by cancelBooking's "next affected occurrence" lookup and
// reportNoShow's post-no-show unwind of a whole-run booking's remaining
// dates. Read-only — must be called during the transaction's read phase,
// before any tx.update/tx.set.
async function getFutureFilledOccurrences(
  tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore,
  seriesId: string, bookingId: string, now: number,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await tx.get(
    db.collection("gigs")
      .where("seriesId", "==", seriesId)
      .where("status", "==", "filled")
      .where("startsAt", ">", now)
      .orderBy("startsAt", "asc"));
  return snap.docs.filter((doc) => doc.data().bookingId === bookingId);
}

// Write-side counterpart to getFutureFilledOccurrences: reopens every given
// occurrence (filled -> open, clear bookingId/bookedMusicianProfileId) and
// clears the series' own activeBookingId/bookedMusicianProfileId ONLY when
// the series still names THIS booking as its active one
// (`seriesActiveBookingId === bookingId`, read by the caller during the
// transaction's read phase) — never unconditionally: a later, still-active
// booking of the same series (see getFutureFilledOccurrences' comment above)
// must not have its own series-level linkage clobbered by an older
// booking's cancel/no-show. `occurrenceDocs` being empty (e.g. reportNoShow
// called on the run's very last date, with no future dates left to reopen)
// does not change this — the series-linkage clear still runs, still gated
// on the same ownership check. Shared by cancelBooking and reportNoShow's
// whole-run unwind.
function reopenSeriesOccurrences(
  tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore,
  seriesId: string, bookingId: string, seriesActiveBookingId: string | null,
  occurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[], now: number,
): void {
  for (const doc of occurrenceDocs) {
    tx.update(doc.ref, { status: "open", bookingId: null, bookedMusicianProfileId: null, updatedAt: now });
  }
  if (seriesActiveBookingId === bookingId) {
    tx.update(db.doc(`gigSeries/${seriesId}`), {
      activeBookingId: null, bookedMusicianProfileId: null, updatedAt: now,
    });
  }
}

// Shared outcome-dependent notification copy for cancelBooking/
// cancelOccurrence — NOT reportNoShow (that one is always the same shape:
// musician-side-only, no forfeiture branch) or removeReliabilityMark (also
// single-shape). `by` is who initiated the cancellation. `scope` disambiguates
// the forfeiture message's deposit reference: cancelBooking's "booking"
// forfeits the run-level deposit (booking.deposit.forfeitedTo), while
// cancelOccurrence's "occurrence" is a per-date OUTCOME RECORD only
// (occurrenceCancellations entry) — no separate deposit actually moves per
// date, so its copy must not read as if it does.
function cancellationCopy(
  by: BookingSide, outcome: CancelOutcome, markApplied: boolean,
  scope: "booking" | "occurrence", gigTitle?: string,
): { curatorBody: string; musicianBody: string } {
  const forGig = gigTitle ? ` for "${gigTitle}"` : "";
  const depositRef = scope === "occurrence" ? "the deposit for that date" : "the deposit";
  if (by === "curator") {
    if (outcome === "deposit_forfeited") {
      return {
        curatorBody: `You cancelled${forGig} less than ${CURATOR_FORFEIT_WINDOW_HOURS} hours before the start — ${depositRef} was forfeited to the musician.`,
        musicianBody: `The curator cancelled${forGig} less than ${CURATOR_FORFEIT_WINDOW_HOURS} hours before the start — ${depositRef} forfeited to you.`,
      };
    }
    return {
      curatorBody: `You cancelled${forGig}. Your deposit will be refunded.`,
      musicianBody: `The curator cancelled${forGig}. Your deposit will be refunded.`,
    };
  }
  if (markApplied) {
    return {
      curatorBody: `The musician cancelled${forGig} on short notice. Your deposit will be refunded.`,
      musicianBody: `You cancelled${forGig} less than ${MUSICIAN_MARK_WINDOW_HOURS} hours before the start — a late-cancellation mark was recorded on your reliability history.`,
    };
  }
  return {
    curatorBody: `The musician cancelled${forGig}. Your deposit will be refunded.`,
    musicianBody: `You cancelled${forGig}. Your deposit will be refunded.`,
  };
}

interface CancelBookingInput { bookingId: string; reason: string; }

// Extracted core of cancelBooking (Task 7) — shared with pauseSeries/
// endSeries's own curator-side run-cancellation call (gigSeries.ts), which
// supplies a synthetic reason ("Series paused/ended by curator") and
// side:"curator" directly rather than resolving it from a caller's
// membership (there's no ambiguity to resolve there — the series action IS
// the curator side acting). `booking` is the OUTER (pre-transaction) read of
// the doc, used only for its IMMUTABLE fields (gigId/seriesId/
// musicianProfileId/curatorProfileId are all fixed at booking-creation time);
// the transaction below re-reads bookingRef fresh for everything mutable.
// Every check/side-effect here is exactly what cancelBooking's callable used
// to run inline — behavior must not drift (Task 6's cancelBooking tests are
// the regression harness for this refactor).
export async function executeCancellation(
  bookingId: string, booking: BookingRequestDoc, side: BookingSide, reason: string, now: number,
): Promise<{ outcome: CancelOutcome; markApplied: boolean }> {
  const trimmedReason = validateCancelReason(reason);
  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const reliabilityRef = db.doc(`profiles/${booking.musicianProfileId}/private/reliability`);

  // Status check, the "next affected occurrence" read (a query for
  // whole-run, a direct doc read for single), the reliability doc (needed
  // up front in case a mark ends up applying — see the write phase below),
  // and every write this callable makes (booking, gig(s), series,
  // conditionally reliability) share ONE transaction — same rationale as
  // acceptBooking's transaction in bookings.ts: nothing here may act on a
  // status/occurrence-set that could have shifted underneath a multi-step
  // read-then-write. The reliability mark append in particular MUST be
  // in-txn (not a separate post-commit call): a crash between two
  // transactions would leave `cancellation.markApplied: true` on the
  // committed booking with no mark ever recorded, and nothing else would
  // ever re-add it — an unrecoverable, silently-wrong reliability history.
  const result = await db.runTransaction(async (tx) => {
    // ---- READS ----
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;
    if (freshBooking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", `Cannot cancel a booking in status "${freshBooking.status}".`);
    }

    const reliabilitySnap = await tx.get(reliabilityRef);
    const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
    const existingMarks = reliability?.marks ?? [];

    let occurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    let nextGigId: string;
    let nextStartsAt: number;
    let singleGigRef: FirebaseFirestore.DocumentReference | null = null;
    let seriesActiveBookingId: string | null = null;

    if (freshBooking.seriesId) {
      const seriesSnap = await tx.get(db.doc(`gigSeries/${freshBooking.seriesId}`));
      seriesActiveBookingId = (seriesSnap.data() as GigSeriesDoc | undefined)?.activeBookingId ?? null;
      // The earliest (by startsAt) of every future, currently-filled
      // occurrence STILL OWNED BY THIS BOOKING is the "next affected
      // occurrence" the window math is computed against; ALL of them get
      // reopened below (see getFutureFilledOccurrences/
      // reopenSeriesOccurrences).
      occurrenceDocs = await getFutureFilledOccurrences(tx, db, freshBooking.seriesId, bookingId, now);
      if (occurrenceDocs.length === 0) {
        // Task 7 carry-forward (b): distinguish "the run genuinely already
        // started" from "there's nothing left of THIS booking's run to
        // cancel" (its dates were cancelled per-occurrence via
        // cancelOccurrence, or re-filled by a later booking of the same
        // series — either way, the gig's own bookingId field no longer
        // names this booking, so getFutureFilledOccurrences' bookingId
        // filter above can never find it). The booking's own LAST
        // still-linked occurrence (any status, via the (bookingId,startsAt)
        // index) is the only truthful signal left: if it's in the past, the
        // run genuinely already started — "report instead" is correct
        // advice; if there's no such occurrence at all, "already started"
        // would be a lie — there's simply nothing left of this booking's
        // run to act on.
        const lastLinkedSnap = await tx.get(
          db.collection("gigs").where("bookingId", "==", bookingId).orderBy("startsAt", "desc").limit(1));
        const lastLinked = lastLinkedSnap.docs[0]?.data() as GigDoc | undefined;
        throw new HttpsError("failed-precondition",
          lastLinked && lastLinked.startsAt <= now ? ALREADY_STARTED_MESSAGE : NO_UPCOMING_DATES_MESSAGE);
      }
      nextGigId = occurrenceDocs[0].id;
      nextStartsAt = occurrenceDocs[0].data().startsAt as number;
    } else {
      const gigRef = db.doc(`gigs/${freshBooking.gigId}`);
      const gigSnap = await tx.get(gigRef);
      const gig = gigSnap.data() as GigDoc | undefined;
      // Defensive — mirrors acceptBooking's identical rationale in
      // bookings.ts: a booking always names an existing gig, and nothing
      // deletes gigs.
      if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");
      if (gig.startsAt <= now) throw new HttpsError("failed-precondition", ALREADY_STARTED_MESSAGE);
      singleGigRef = gigRef;
      nextGigId = freshBooking.gigId;
      nextStartsAt = gig.startsAt;
    }

    const hoursBeforeStart = (nextStartsAt - now) / 3_600_000;
    // F6 (security audit wave): window thresholds are read from THIS
    // booking's OWN frozen deposit.policy snapshot (acceptBooking stamps it
    // once, at accept time — see BookingDeposit's own "snapshot, never
    // re-read from constants" comment in types.ts) — falling back to the
    // live shared constants only when the snapshot is missing (a
    // pre-deposit-snapshot booking, or a defensive fallback for corrupted
    // data). Without this, a later change to the shared constants would
    // retroactively change the deal the two sides already accepted, and the
    // deposit's own policy snapshot would be a lie.
    const curatorForfeitHours = freshBooking.deposit?.policy?.curatorForfeitHours ?? CURATOR_FORFEIT_WINDOW_HOURS;
    const musicianMarkHours = freshBooking.deposit?.policy?.musicianMarkHours ?? MUSICIAN_MARK_WINDOW_HOURS;
    // SP5: 1h post-accept grace (both sides) — a flash booking accepted
    // already inside the penalty windows can be undone penalty-free for
    // CANCEL_GRACE_MS after the accept. Capped at gig start implicitly: the
    // already-started guards above make now < nextStartsAt. Requires
    // confirmedAt != null: with no timestamp there is nothing to bound the
    // exception against, so treating an unknown confirmedAt as "in grace"
    // would grant unbounded, permanent grace instead of a genuine 1h
    // window — silently disabling forfeiture/marks for that booking forever.
    const graceApplied = freshBooking.confirmedAt != null && (now - freshBooking.confirmedAt) < CANCEL_GRACE_MS;
    let outcome: CancelOutcome;
    let markApplied = false;
    // { [key]: unknown } rather than a typed literal — the conditional
    // "deposit.forfeitedTo" dot-path key below only applies on the curator/
    // forfeit branch, so this can't be a single object literal.
    const bookingUpdate: { [key: string]: unknown } = {
      status: side === "curator" ? "cancelled_by_curator" : "cancelled_by_musician",
      resolvedAt: now, updatedAt: now,
    };

    if (side === "curator") {
      // STRICTLY less-than — exactly curatorForfeitHours refunds.
      outcome = !graceApplied && hoursBeforeStart < curatorForfeitHours ? "deposit_forfeited" : "deposit_refunded";
      if (outcome === "deposit_forfeited") bookingUpdate["deposit.forfeitedTo"] = "musician";
    } else {
      // Musician side never forfeits the curator's deposit — always refunded.
      outcome = "deposit_refunded";
      markApplied = !graceApplied && hoursBeforeStart < musicianMarkHours;
    }

    bookingUpdate.cancellation = {
      by: side, reason: trimmedReason, at: now, hoursBeforeStart, outcome, markApplied, graceApplied,
    };

    // ---- WRITES ----
    tx.update(bookingRef, bookingUpdate);
    if (freshBooking.seriesId) {
      reopenSeriesOccurrences(tx, db, freshBooking.seriesId, bookingId, seriesActiveBookingId, occurrenceDocs, now);
    } else {
      tx.update(singleGigRef!, { status: "open", bookingId: null, bookedMusicianProfileId: null, updatedAt: now });
    }
    if (markApplied) {
      const mark: ReliabilityMark = {
        bookingId, gigId: nextGigId, kind: "late_cancel", at: now, reportedByProfileId: null, removedByAdmin: false,
      };
      const marks = appendMarkCapped(existingMarks, mark);
      tx.set(reliabilityRef, { marks, completedCount: reliability?.completedCount ?? 0, updatedAt: now });
    }

    return { outcome, markApplied };
  });

  // recomputeReliability stays post-transaction — it's a pure re-derivation
  // from the reliability doc's current marks (self-healing: a failure here
  // just leaves a stale curatorBooking.reliability summary until the next
  // mark-affecting event recomputes it), unlike the mark append itself,
  // which is only safe INSIDE the transaction above (see its comment).
  if (result.markApplied) {
    await recomputeReliability(booking.musicianProfileId);
  }

  // Best-effort, post-commit notification — a failure here must never
  // surface as an error on an already-committed cancellation (mirrors
  // acceptBooking's winner-notify tail in bookings.ts).
  try {
    const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
    const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
    const { curatorBody, musicianBody } =
      cancellationCopy(side, result.outcome, result.markApplied, "booking", gigTitle);
    await notifyProfileMembers(booking.curatorProfileId, { kind: "booking", refId: bookingId, title: "Booking cancelled", body: curatorBody });
    await notifyProfileMembers(booking.musicianProfileId, { kind: "booking", refId: bookingId, title: "Booking cancelled", body: musicianBody });
  } catch (e) {
    console.error(`executeCancellation: failed to notify for booking ${bookingId}`, e);
  }

  return result;
}

export const cancelBooking = onCall<CancelBookingInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId, reason } = req.data ?? ({} as CancelBookingInput);
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");
  // Validated here too, ahead of the membership/authz read below — preserves
  // the codebase's input-validation-before-authz ordering convention.
  // executeCancellation independently re-validates+trims the same value for
  // its OWN (non-cancelBooking) callers, so this call is deliberately
  // redundant rather than load-bearing here.
  validateCancelReason(reason);

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership doesn't depend on mutable booking state — safe to resolve
  // once, outside the transaction (mirrors requireBookingSide's rationale
  // in bookings.ts).
  const callerSide = await resolveBookingSideStrict(booking, uid);

  // Captured once — see executeCancellation's own identical rationale (a
  // `now` no longer current by commit time can never disagree with what
  // actually gets written). A boundary case may therefore favor the
  // canceller by a few seconds — accepted.
  const now = Date.now();
  await executeCancellation(bookingId, booking, callerSide, reason, now);
  return { ok: true };
});

interface CancelOccurrenceInput { bookingId: string; gigId: string; reason: string; }

export const cancelOccurrence = onCall<CancelOccurrenceInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId, gigId, reason } = req.data ?? ({} as CancelOccurrenceInput);
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");
  if (!isValidDocId(gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");
  const trimmedReason = validateCancelReason(reason);

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // seriesId is immutable once the booking is created (set <=> whole-run —
  // see BookingRequestDoc's own comment) — safe to check outside the
  // transaction, same rationale as requireBookingSide's outer-read pattern.
  if (!booking.seriesId) {
    throw new HttpsError("failed-precondition",
      "This is a single-gig booking — use cancelBooking to cancel it.");
  }

  const callerSide = await resolveBookingSideStrict(booking, uid);

  // Captured once, before the transaction — see cancelBooking's identical
  // comment on why this matters (the window math and the persisted record
  // must always agree, even across a retry or a slow commit).
  const now = Date.now();
  const gigRef = db.doc(`gigs/${gigId}`);
  const reliabilityRef = db.doc(`profiles/${booking.musicianProfileId}/private/reliability`);
  // The reliability doc is read here (up front, alongside the booking/gig)
  // and, when a mark applies, written in the SAME transaction's write phase
  // — not a separate post-commit call. See cancelBooking's identical
  // rationale: a crash between two transactions would leave a committed
  // occurrenceCancellations entry with markApplied:true and no mark ever
  // recorded, which nothing would ever re-add.
  const result = await db.runTransaction(async (tx) => {
    // ---- READS ----
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;
    if (freshBooking.status !== "confirmed") {
      throw new HttpsError("failed-precondition",
        `Cannot cancel a date of a booking in status "${freshBooking.status}".`);
    }

    const reliabilitySnap = await tx.get(reliabilityRef);
    const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
    const existingMarks = reliability?.marks ?? [];

    const gigSnap = await tx.get(gigRef);
    const gig = gigSnap.data() as GigDoc | undefined;
    // Belongs to THIS booking's run (not just any gig sharing the series id
    // — e.g. a filled occurrence of a DIFFERENT booking would be a
    // logic error elsewhere, but this check makes it impossible to reach
    // here regardless).
    if (!gig || gig.seriesId !== freshBooking.seriesId || gig.bookingId !== bookingId) {
      throw new HttpsError("failed-precondition", "That date does not belong to this booking's run.");
    }
    if (gig.status !== "filled") {
      throw new HttpsError("failed-precondition", `Cannot cancel a date in status "${gig.status}".`);
    }
    if (gig.startsAt <= now) throw new HttpsError("failed-precondition", ALREADY_STARTED_MESSAGE);

    // F7 (security audit wave, ruling: reject-when-full): once the array is
    // already at MAX_OCCURRENCE_CANCELLATIONS, refuse outright rather than
    // silently dropping the oldest settlement record — sub-5 reads every
    // entry here as a real per-date settlement input, and none of them may
    // ever be discarded without a human choosing to. Checked before any
    // other write in this transaction so a refusal never has a side effect.
    const existing = freshBooking.occurrenceCancellations ?? [];
    if (existing.length >= MAX_OCCURRENCE_CANCELLATIONS) {
      throw new HttpsError("resource-exhausted",
        "Too many individual date cancellations on this booking — cancel the whole run instead.");
    }

    const hoursBeforeStart = (gig.startsAt - now) / 3_600_000;
    // F6 (security audit wave): read from the booking's OWN deposit.policy
    // snapshot — see executeCancellation's identical fix/comment above.
    const curatorForfeitHours = freshBooking.deposit?.policy?.curatorForfeitHours ?? CURATOR_FORFEIT_WINDOW_HOURS;
    const musicianMarkHours = freshBooking.deposit?.policy?.musicianMarkHours ?? MUSICIAN_MARK_WINDOW_HOURS;
    // SP5: 1h post-accept grace (both sides) — see executeCancellation's
    // identical rationale above (including why a null confirmedAt must NOT
    // count as in-grace). Capped at gig start implicitly here via this
    // function's own `gig.startsAt <= now` guard above (not
    // executeCancellation's nextStartsAt, which doesn't exist in this scope).
    const graceApplied = freshBooking.confirmedAt != null && (now - freshBooking.confirmedAt) < CANCEL_GRACE_MS;
    let outcome: CancelOutcome;
    let markApplied = false;
    if (callerSide === "curator") {
      outcome = !graceApplied && hoursBeforeStart < curatorForfeitHours ? "deposit_forfeited" : "deposit_refunded";
      // Deliberately does NOT touch booking.deposit/deposit.forfeitedTo —
      // that field is the RUN-level outcome (cancelBooking's alone to set).
      // This occurrence's own outcome lives only in the
      // occurrenceCancellations entry below; sub-5 reads it from there.
    } else {
      outcome = "deposit_refunded";
      markApplied = !graceApplied && hoursBeforeStart < musicianMarkHours;
    }

    const entry: OccurrenceCancellation = {
      gigId, by: callerSide, at: now, hoursBeforeStart, outcome, markApplied, graceApplied,
    };
    // No cap/drop-oldest here — the check above already refused before this
    // point whenever appending would exceed the cap, so `existing` is always
    // strictly under it and this append can never itself reach the ceiling.
    const nextEntries = [...existing, entry];

    // ---- WRITES ----
    // Booking itself stays "confirmed" — only this one date is affected;
    // the run continues with its remaining occurrences.
    tx.update(bookingRef, { occurrenceCancellations: nextEntries, updatedAt: now });
    tx.update(gigRef, { status: "open", bookingId: null, bookedMusicianProfileId: null, updatedAt: now });
    if (markApplied) {
      const mark: ReliabilityMark = {
        bookingId, gigId, kind: "late_cancel", at: now, reportedByProfileId: null, removedByAdmin: false,
      };
      const marks = appendMarkCapped(existingMarks, mark);
      tx.set(reliabilityRef, { marks, completedCount: reliability?.completedCount ?? 0, updatedAt: now });
    }

    return { outcome, markApplied };
  });

  // recomputeReliability stays post-transaction — see cancelBooking's
  // identical rationale (a pure, self-healing re-derivation; only the mark
  // append itself needed to be inside the transaction).
  if (result.markApplied) {
    await recomputeReliability(booking.musicianProfileId);
  }

  try {
    const gigSnap = await db.doc(`gigs/${gigId}`).get();
    const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
    const { curatorBody, musicianBody } =
      cancellationCopy(callerSide, result.outcome, result.markApplied, "occurrence", gigTitle);
    await notifyProfileMembers(booking.curatorProfileId,
      { kind: "booking", refId: bookingId, title: "One date of your booking was cancelled", body: curatorBody });
    await notifyProfileMembers(booking.musicianProfileId,
      { kind: "booking", refId: bookingId, title: "One date of your booking was cancelled", body: musicianBody });
  } catch (e) {
    console.error(`cancelOccurrence: failed to notify for booking ${bookingId}`, e);
  }

  return { ok: true };
});

interface ReportNoShowInput { bookingId: string; reason: string; }

export const reportNoShow = onCall<ReportNoShowInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId, reason } = req.data ?? ({} as ReportNoShowInput);
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");
  const trimmedReason = validateCancelReason(reason);

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  const callerSide = await resolveBookingSideStrict(booking, uid);
  if (callerSide !== "curator") {
    throw new HttpsError("permission-denied", "Only the curator side can report a no-show.");
  }

  // Captured once, before the transaction — see cancelBooking's identical
  // comment on why this matters (the window/day-count math and the
  // persisted record must always agree, even across a retry or a slow commit).
  const now = Date.now();
  const reliabilityRef = db.doc(`profiles/${booking.musicianProfileId}/private/reliability`);
  // Unlike cancelBooking/cancelOccurrence's mark append (also in-txn as of
  // this same fix), reportNoShow's mark append has always needed to be
  // INSIDE this transaction for its own, additional reason: the "once per
  // booking" invariant is enforced by checking for an existing
  // reported_no_show mark for this bookingId, and that check must be atomic
  // with the write, or a second concurrent call could read "no mark yet"
  // and double-report before the first call's write lands.
  const result = await db.runTransaction(async (tx) => {
    // ---- READS ----
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;

    const reliabilitySnap = await tx.get(reliabilityRef);
    const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
    const existingMarks = reliability?.marks ?? [];
    // Checked BEFORE the status guard below (and regardless of
    // removedByAdmin — an admin removal fixes the reliability COUNT, it
    // does not un-report the underlying event) so a second report against
    // an already-flipped booking surfaces the true already-exists reason,
    // not a generic failed-precondition from the status check.
    if (existingMarks.some((m) => m.bookingId === bookingId && m.kind === "reported_no_show")) {
      throw new HttpsError("already-exists", "A no-show has already been reported for this booking.");
    }

    if (freshBooking.status !== "confirmed" && freshBooking.status !== "completed") {
      throw new HttpsError("failed-precondition",
        `Cannot report a no-show for a booking in status "${freshBooking.status}".`);
    }

    // The reported occurrence — scoped to THIS booking's own gigId
    // (bookingId==bookingId), never merely "any occurrence of the series
    // that has passed": a seriesId-scoped query could otherwise select a
    // never-booked open date, or a validly-cancelled date belonging to a
    // DIFFERENT (earlier or later) booking of the same run — mis-attributing
    // the mark's gigId, computing the window against the wrong date, and
    // making the NO_SHOW_REPORT_WINDOW_DAYS check effectively unbounded on
    // an ongoing run (the series keeps materializing new "most recent past
    // occurrence" candidates regardless of which booking is being reported
    // on). Needs the new (bookingId,startsAt) composite index — see
    // firestore.indexes.json. Correct for BOTH single-gig bookings (exactly
    // one gig ever carries this bookingId) and whole-run bookings (the most
    // recent occurrence THIS booking actually filled and that has since
    // started) — no seriesId branch needed here.
    const pastSnap = await tx.get(
      db.collection("gigs")
        .where("bookingId", "==", bookingId)
        .where("startsAt", "<=", now)
        .orderBy("startsAt", "desc")
        .limit(1));
    if (pastSnap.empty) {
      throw new HttpsError("failed-precondition", "No occurrence of this booking has started yet.");
    }
    const occurrenceGigId = pastSnap.docs[0].id;
    const occurrenceStartsAt = pastSnap.docs[0].data().startsAt as number;

    // Whole-run only: every future filled occurrence STILL OWNED BY THIS
    // BOOKING gets reopened below, and the series' own linkage clears IFF
    // it still names this booking — the no-show ends this run for this
    // booking exactly the way cancelBooking does (plan amendment closing a
    // gap where the run's remaining dates were otherwise left "filled"
    // against a booking that had already flipped to cancelled_by_musician).
    // Read here (transaction read phase); applied in the write phase below
    // via reopenSeriesOccurrences.
    let futureOccurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    let seriesActiveBookingId: string | null = null;
    if (freshBooking.seriesId) {
      const seriesSnap = await tx.get(db.doc(`gigSeries/${freshBooking.seriesId}`));
      seriesActiveBookingId = (seriesSnap.data() as GigSeriesDoc | undefined)?.activeBookingId ?? null;
      futureOccurrenceDocs = await getFutureFilledOccurrences(tx, db, freshBooking.seriesId, bookingId, now);
    }

    const daysSinceStart = (now - occurrenceStartsAt) / (24 * 3_600_000);
    if (daysSinceStart > NO_SHOW_REPORT_WINDOW_DAYS) {
      throw new HttpsError("failed-precondition",
        `No-shows must be reported within ${NO_SHOW_REPORT_WINDOW_DAYS} days of the start.`);
    }

    // Negative — the start has already passed (the query above only
    // returns occurrences with startsAt <= now).
    const hoursBeforeStart = (occurrenceStartsAt - now) / 3_600_000;

    // ---- WRITES ----
    // by: "musician" — the musician's failure to appear is what caused this
    // cancellation, even though the CURATOR is the one calling; `reason` is
    // the curator's own account of what happened.
    tx.update(bookingRef, {
      status: "cancelled_by_musician", resolvedAt: now, updatedAt: now,
      cancellation: {
        by: "musician", reason: trimmedReason, at: now, hoursBeforeStart,
        outcome: "deposit_refunded", markApplied: true,
      },
    });
    const mark: ReliabilityMark = {
      bookingId, gigId: occurrenceGigId, kind: "reported_no_show",
      at: now, reportedByProfileId: booking.curatorProfileId, removedByAdmin: false,
    };
    const marks = appendMarkCapped(existingMarks, mark);
    // R1 (post-audit residual): if this booking was ALREADY "completed" —
    // scheduled.ts's sweep step 7 already credited it once — flipping it to
    // cancelled_by_musician here must claw that credit back, in the SAME
    // write as the mark append (same in-txn rationale as the mark itself:
    // a crash between two transactions must never leave a committed
    // no-show report with a stale, uncorrected completedCount that nothing
    // else would ever re-touch). Floored at 0 — never negative, matching
    // the "restore" side's own idempotency posture. A booking reported from
    // "confirmed" (never yet swept) leaves completedCount untouched, same
    // as before this fix. removeReliabilityMark's own restoreFalselyReported
    // Booking is what later re-credits this — see its own comment.
    const currentCompletedCount = reliability?.completedCount ?? 0;
    const nextCompletedCount = freshBooking.status === "completed"
      ? Math.max(0, currentCompletedCount - 1) : currentCompletedCount;
    tx.set(reliabilityRef, { marks, completedCount: nextCompletedCount, updatedAt: now });

    // Whole-run unwind — see the read-phase comment above.
    if (freshBooking.seriesId) {
      reopenSeriesOccurrences(tx, db, freshBooking.seriesId, bookingId, seriesActiveBookingId, futureOccurrenceDocs, now);
    }

    return { occurrenceGigId };
  });

  await recomputeReliability(booking.musicianProfileId);

  try {
    const gigSnap = await db.doc(`gigs/${result.occurrenceGigId}`).get();
    const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
    await notifyProfileMembers(booking.musicianProfileId, {
      kind: "booking", refId: bookingId, title: "No-show reported",
      body: `A no-show was reported${gigTitle ? ` for "${gigTitle}"` : ""}. This affects your reliability history.`,
    });
  } catch (e) {
    console.error(`reportNoShow: failed to notify for booking ${bookingId}`, e);
  }

  return { ok: true };
});

interface RemoveReliabilityMarkInput {
  musicianProfileId: string; bookingId: string; kind: ReliabilityMark["kind"];
}

// F4 (security audit wave): reversing a FALSE `reported_no_show` mark must
// also restore the settlement record the false report stole — reportNoShow
// flipped the booking to `cancelled_by_musician` (deposit_refunded,
// markApplied:true), pre-empting the "completed" resolution
// scheduled.ts step 7 would otherwise have reached. Scoped tightly by TWO
// independent signals so this can never misfire on a genuine cancellation
// that merely happens to carry the same mark kind:
//   1. the booking's status is still exactly `cancelled_by_musician` (an
//      idempotency guard too — a booking already restored, or resolved some
//      OTHER way since, is left alone: `!== "cancelled_by_musician"` is a
//      no-op here, matching the "only if not already completed" mandate).
//   2. its cancellation record's hoursBeforeStart is <= 0 — reportNoShow's
//      OWN transaction only ever fires after the relevant occurrence's
//      start (see its `pastSnap` query), so this is exactly the signature
//      of a report-caused flip; a musician's own late_cancel is always
//      hoursBeforeStart > 0 (still before the start) and is correctly left
//      alone by this check even if it somehow arrived paired with this mark
//      kind. late_cancel mark removals never reach this function at all
//      (the caller below gates the call on kind === "reported_no_show").
// completedCount increments here mirror scheduled.ts step 7's own idiom
// exactly (read-modify-write, merge:true) — it's the exact credit the false
// report stole. Deposit/acceptedTerms are left completely untouched (the
// terms of the deal never changed, only whether the show is credited as
// having happened).
async function restoreFalselyReportedBooking(
  db: FirebaseFirestore.Firestore, bookingId: string, now: number,
): Promise<{ restored: boolean; curatorProfileId: string | null; musicianProfileId: string | null }> {
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  if (!booking) return { restored: false, curatorProfileId: null, musicianProfileId: null };
  if (booking.status !== "cancelled_by_musician") {
    return { restored: false, curatorProfileId: booking.curatorProfileId, musicianProfileId: booking.musicianProfileId };
  }
  if (!booking.cancellation || booking.cancellation.hoursBeforeStart > 0) {
    return { restored: false, curatorProfileId: booking.curatorProfileId, musicianProfileId: booking.musicianProfileId };
  }

  await bookingRef.update({ status: "completed", cancellation: null, resolvedAt: now, updatedAt: now });

  // R2 (post-audit residual): a `selfDeal` booking (F5 — the same uid sits
  // on both sides) never earns completedCount credit anywhere else in this
  // codebase (scheduled.ts step 7's own increment is gated on
  // `!booking.selfDeal`) — this restoration path must match that exclusion
  // exactly, or reversing a false no-show report would become a backdoor
  // that lets a self-dealing profile farm the curator-facing trust metric
  // after all. The STATUS restore (above) still happens regardless — the
  // booking is genuinely "completed" work either way, selfDeal only ever
  // gates the reliability CREDIT, never the resolution itself. No
  // reliability-doc write or recompute needed here in that case — nothing
  // about the reliability doc changed, and removeReliabilityMark's own
  // caller already ran recomputeReliability once for the mark removal
  // itself just before this function was called.
  if (!booking.selfDeal) {
    // Mirrors scheduled.ts step 7's completedCount increment idiom exactly —
    // direct (non-batched) read-modify-write, then recomputeReliability so
    // the curatorBooking projection reflects the new count immediately.
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

  return { restored: true, curatorProfileId: booking.curatorProfileId, musicianProfileId: booking.musicianProfileId };
}

export const removeReliabilityMark = onCall<RemoveReliabilityMarkInput>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { musicianProfileId, bookingId, kind } = req.data ?? ({} as RemoveReliabilityMarkInput);
  if (!isValidDocId(musicianProfileId)) throw new HttpsError("invalid-argument", "A musician profile id is required.");
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");
  if (kind !== "late_cancel" && kind !== "reported_no_show") {
    throw new HttpsError("invalid-argument", 'kind must be "late_cancel" or "reported_no_show".');
  }

  const db = getFirestore();
  const reliabilityRef = db.doc(`profiles/${musicianProfileId}/private/reliability`);
  const now = Date.now();
  // Read-modify-write transaction (mirrors flagAccount's rationale) —
  // audit-preserving: flips removedByAdmin on the matching entry, never
  // splices it out of the array.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reliabilityRef);
    const marks = (snap.data() as ReliabilityDoc | undefined)?.marks ?? [];
    // First non-removed match — if an admin already removed one prior mark
    // of this (bookingId,kind) pair (shouldn't normally happen, since
    // there's normally at most one per pair, but stays correct if it ever
    // does) a second removeReliabilityMark call finds the next one rather
    // than re-matching the already-removed entry.
    const idx = marks.findIndex((m) => m.bookingId === bookingId && m.kind === kind && !m.removedByAdmin);
    if (idx === -1) throw new HttpsError("not-found", "No matching reliability mark found.");
    const nextMarks = marks.map((m, i) => (i === idx ? { ...m, removedByAdmin: true } : m));
    tx.update(reliabilityRef, { marks: nextMarks, updatedAt: now });
  });

  await recomputeReliability(musicianProfileId);

  // F4: only a reversed `reported_no_show` can ever trigger a restoration —
  // a late_cancel removal only ever changes the MARK judgment, never the
  // (genuinely real) cancellation itself.
  const { restored, curatorProfileId } = kind === "reported_no_show"
    ? await restoreFalselyReportedBooking(db, bookingId, now)
    : { restored: false, curatorProfileId: null };

  await writeAudit({
    actorUid, action: "reliability_mark_removed", targetId: musicianProfileId,
    detail: `${kind} mark for booking ${bookingId} removed`
      + (restored ? " (booking restored to completed — reversed a false no-show report)" : ""),
  });

  try {
    await notifyProfileMembers(musicianProfileId, {
      kind: "booking", refId: bookingId, title: "A reliability mark was removed",
      body: "An admin reviewed your account and removed a mark from your reliability history.",
    });
  } catch (e) {
    console.error(`removeReliabilityMark: failed to notify profile ${musicianProfileId}`, e);
  }

  if (restored && curatorProfileId) {
    const restoreBody = "An admin reversed a no-show report — the booking is restored as completed.";
    try {
      await notifyProfileMembers(musicianProfileId, {
        kind: "booking", refId: bookingId, title: "Booking restored", body: restoreBody,
      });
    } catch (e) {
      console.error(`removeReliabilityMark: failed to notify musician side of restoration for booking ${bookingId}`, e);
    }
    try {
      await notifyProfileMembers(curatorProfileId, {
        kind: "booking", refId: bookingId, title: "Booking restored", body: restoreBody,
      });
    } catch (e) {
      console.error(`removeReliabilityMark: failed to notify curator side of restoration for booking ${bookingId}`, e);
    }
  }

  return { ok: true };
});

// ---------- Task 7: series/lifecycle collisions + cascades ----------

export interface UnwindModerationOpts {
  gigIds?: string[];
  seriesId?: string;
  profileId?: string;
  // Notification body sent to the musician side of each affected booking —
  // defaults to the generic moderation copy below, which deliberately never
  // echoes the moderation reason (see this function's own comment). cancelGig
  // — a curator's own DIRECT action on their own still-open gig, not
  // moderation — overrides this with honest "the gig was cancelled" wording.
  notifyBody?: string;
}

const DEFAULT_UNWIND_NOTIFY_BODY = "This gig is no longer available.";

// Shared unwind for every "the gig/series/profile underneath this booking is
// going away, and it's nobody's fault" collision — takedownGig (occurrence +
// series scope), cancelGig (a still-open gig only — a filled one goes
// through cancelBooking instead), and reviewProfile's reject-from-approved +
// deleteProfile's cascade (either profile side). pauseSeries/endSeries do
// NOT call this — a booked run being cancelled by the series pausing/ending
// is a real CURATOR-side cancellation (forfeiture/mark consequences apply),
// so it goes through executeCancellation above instead.
//
// Distinct from cancelBooking/cancelOccurrence/reportNoShow: those are a
// PARTY acting on their own booking, with a side-dependent outcome (curator
// forfeits, musician gets marked). This is an ADMIN/SYSTEM action taking the
// gig/series/profile out from under the booking — no party did anything
// wrong, so: no cancellation record, no forfeiture, no reliability mark.
// `open` bookings simply expire (nobody was ever confirmed); `confirmed`
// bookings ALSO simply expire — sub-5 reads status:"expired" + a non-null
// `deposit` as "refund the deposit", no separate write needed here.
//
// Reopens nothing for a gigId/seriesId-scoped call (takedownGig, cancelGig),
// nor for a profileId-scoped call whose moderated profile is the CURATOR
// side (reviewProfile's reject-from-approved + deleteProfile's cascade
// already close/clear that profile's OWN gigs directly, in their own
// caller-side code, before or alongside calling here) — every one of those
// callers is ALSO taking the affected gig(s) down in its own write, so
// there is nothing live left for a reopened gig to serve.
//
// F1 (security audit wave) fix: that assumption is FALSE for a
// profileId-scoped call whose moderated profile is the booking's MUSICIAN
// side — the CURATOR'S OWN gig is entirely innocent and stays live; nothing
// else in this cascade ever touches it. Left alone, a confirmed booking's
// linked gig(s) would sit "filled" — still publicly readable, still linked
// to a booking that just silently expired — forever. See
// reopenGigsForMusicianModeration below for the reopen logic this case
// alone triggers.
//
// Per-booking failure isolation (try/catch, log, continue) — mirrors
// acceptBooking's supersedeSiblingBooking idiom in bookings.ts: one poisoned
// booking must never abort the unwind of every other affected one.
//
// Bounded, index-backed queries only — reuses the (gigId,status),
// (seriesId,status), (musicianProfileId,status,updatedAt) and
// (curatorProfileId,status,updatedAt) composite indexes already in
// firestore.indexes.json; no new index needed.

// F1 fix: reopens every FUTURE-dated linked FILLED gig of `booking` (single-
// gig: the one gig, iff its startsAt is still ahead of `now`; whole-run:
// every future filled occurrence still owned by this booking, via the same
// query shape as getFutureFilledOccurrences/reopenSeriesOccurrences above —
// duplicated rather than shared because those two are transaction-only
// helpers, and this path deliberately stays the SAME best-effort,
// non-transactional, per-booking-isolated style as the rest of this
// function, with a real optimistic precondition — `lastUpdateTime`, the
// supersedeSiblingBooking idiom in bookings.ts — on each write so a lost
// race just skips that one occurrence rather than clobbering a concurrent
// write). PAST-dated linked gigs are left completely untouched — the show's
// date has already elapsed either way, and there is nothing to reopen.
// Returns whether anything actually reopened, so the caller only sends its
// "the date has reopened" notification to the curator side when that's
// literally true (a past-only case must never claim a reopen that never
// happened). Series-linkage clearing is NOT this function's job — the
// existing ownership-gated clear a few lines below in the main loop already
// runs unconditionally for every seriesId-carrying booking here, musician-
// caused or not.
async function reopenGigsForMusicianModeration(
  db: FirebaseFirestore.Firestore, booking: BookingRequestDoc, bookingId: string, now: number,
): Promise<boolean> {
  let reopenedAny = false;
  if (booking.seriesId) {
    const snap = await db.collection("gigs")
      .where("seriesId", "==", booking.seriesId)
      .where("status", "==", "filled")
      .where("startsAt", ">", now)
      .orderBy("startsAt", "asc")
      .get();
    const occurrenceDocs = snap.docs.filter((occ) => occ.data().bookingId === bookingId);
    for (const occ of occurrenceDocs) {
      try {
        await occ.ref.update(
          { status: "open", bookingId: null, bookedMusicianProfileId: null, updatedAt: now },
          { lastUpdateTime: occ.updateTime });
        reopenedAny = true;
      } catch (e) {
        console.error(`unwindBookingsForModeration: failed to reopen occurrence ${occ.id} for booking ${bookingId}`, e);
      }
    }
  } else {
    const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
    const gig = gigSnap.data() as GigDoc | undefined;
    if (gig && gig.status === "filled" && gig.startsAt > now) {
      try {
        await gigSnap.ref.update(
          { status: "open", bookingId: null, bookedMusicianProfileId: null, updatedAt: now },
          { lastUpdateTime: gigSnap.updateTime });
        reopenedAny = true;
      } catch (e) {
        console.error(`unwindBookingsForModeration: failed to reopen gig ${booking.gigId} for booking ${bookingId}`, e);
      }
    }
    // Past-dated (or already-non-filled): left untouched — see this
    // function's own comment.
  }
  return reopenedAny;
}

export async function unwindBookingsForModeration(opts: UnwindModerationOpts): Promise<void> {
  const db = getFirestore();
  const now = Date.now();
  const notifyBody = opts.notifyBody ?? DEFAULT_UNWIND_NOTIFY_BODY;

  // A booking can be reachable via more than one requested scope at once
  // (e.g. a series-scoped takedown whose whole-run booking is ALSO caught by
  // one of the taken-down occurrence gigIds) — de-dupe by booking id before
  // processing so it's never touched twice.
  const candidates = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  const UNWIND_STATUSES = ["open", "confirmed"] as const;

  async function collect(field: "gigId" | "seriesId" | "musicianProfileId" | "curatorProfileId", value: string) {
    for (const status of UNWIND_STATUSES) {
      const snap = await db.collection("bookings").where(field, "==", value).where("status", "==", status).get();
      for (const doc of snap.docs) {
        // Task 7 fix: a gigId-scoped candidate (cancelGig; takedownGig's
        // occurrence scope) never expires a still-CONFIRMED whole-run
        // booking just because its initiating gig was the one cancelled/
        // taken down — the run's OTHER occurrences would be left dangling,
        // still filled, still linked to a booking this call just killed.
        // Series scope (or a profileId cascade) is the correct tool for
        // removing a booked run outright, and reaches this SAME booking via
        // its own seriesId/profileId collect() call below, which carries no
        // such exemption. An OPEN run APPLICATION, by contrast, still
        // expires here — nobody is confirmed yet, so there's nothing to
        // protect (the application is genuinely dead).
        if (field === "gigId") {
          const data = doc.data() as BookingRequestDoc;
          if (data.seriesId != null && data.status === "confirmed") continue;
        }
        candidates.set(doc.id, doc);
      }
    }
  }

  for (const gigId of opts.gigIds ?? []) await collect("gigId", gigId);
  if (opts.seriesId) await collect("seriesId", opts.seriesId);
  if (opts.profileId) {
    await collect("musicianProfileId", opts.profileId);
    await collect("curatorProfileId", opts.profileId);
  }

  for (const doc of candidates.values()) {
    try {
      const booking = doc.data() as BookingRequestDoc;
      // F1 fix: was this unwind reached BECAUSE the moderated profile is
      // this booking's MUSICIAN side? (opts.profileId is set only by
      // reviewProfile's reject-from-approved cascade and deleteProfile's
      // cascade — never by the gigId/seriesId-scoped callers, for which this
      // is always false.) `wasConfirmed` must be read from the ORIGINAL
      // (pre-expire) status below — only a booking that actually filled a
      // gig has anything to reopen.
      const isMusicianCausedUnwind = opts.profileId != null && opts.profileId === booking.musicianProfileId;
      const wasConfirmed = booking.status === "confirmed";

      // Booking expiry — unconditional, the core effect of this call.
      await doc.ref.update({ status: "expired", resolvedAt: now, updatedAt: now });

      // F1 fix: reopen the innocent curator's gig(s) — see
      // reopenGigsForMusicianModeration's own comment for why this is the
      // one case that must reopen rather than leave the gig(s) alone.
      let reopened = false;
      if (isMusicianCausedUnwind && wasConfirmed) {
        reopened = await reopenGigsForMusicianModeration(db, booking, doc.id, now);
      }

      // Series-linkage clear — best-effort and DELIBERATELY separate from
      // the booking-expiry write above: it clears ONLY when the series
      // still names THIS booking as its active one (mirrors
      // reopenSeriesOccurrences' ownership-gated clear in cancelBooking/
      // reportNoShow — a later, still-active booking of the same series
      // must not have its own linkage clobbered by an older booking's
      // unwind), and carries its own real optimistic precondition
      // (`lastUpdateTime`, the supersedeSiblingBooking idiom in bookings.ts)
      // so a lost race on the series doc (a CONCURRENT unwind/accept
      // touching the same series between this read and this write) can
      // never undo the booking expiry that already committed above. A
      // missed clear here is safe interim state, not a correctness bug —
      // same "stale activeBookingId, sweep resolves it" reasoning as
      // gigSeries.ts's pauseSeries/endSeries zombie-run tolerance. No
      // occurrence reopen here regardless — see this function's own top
      // comment.
      if (booking.seriesId) {
        const seriesSnap = await db.doc(`gigSeries/${booking.seriesId}`).get();
        const series = seriesSnap.data() as GigSeriesDoc | undefined;
        if (series?.activeBookingId === doc.id) {
          try {
            await seriesSnap.ref.update(
              { activeBookingId: null, bookedMusicianProfileId: null, updatedAt: now },
              { lastUpdateTime: seriesSnap.updateTime });
          } catch (e) {
            console.error(`unwindBookingsForModeration: failed to clear series linkage for booking ${doc.id}`, e);
          }
        }
      }

      await notifyProfileMembers(booking.musicianProfileId, {
        kind: "booking", refId: doc.id, title: "Booking no longer available", body: notifyBody,
      });

      // F1 fix: the curator side deserves its own honest notice too — the
      // musician-facing `notifyBody` above is written for the MODERATED
      // side and is never appropriate for the innocent curator (e.g.
      // cancelGig's override reads "The gig ... was cancelled", which is
      // false from the curator's own point of view when they're the one
      // who cancelled it — that path never reaches here anyway since
      // isMusicianCausedUnwind is always false for it, but the point holds
      // generally). Sent only when a gig actually reopened — see
      // reopenGigsForMusicianModeration's own comment on why a past-only
      // case must never claim "the date has reopened". No reason leak —
      // mirrors this function's own notifyBody contract.
      if (reopened) {
        try {
          await notifyProfileMembers(booking.curatorProfileId, {
            kind: "booking", refId: doc.id, title: "Booking no longer available",
            body: "Your booked act is no longer available — the date has reopened.",
          });
        } catch (e) {
          console.error(`unwindBookingsForModeration: failed to notify curator side for booking ${doc.id}`, e);
        }
      }
    } catch (e) {
      console.error(`unwindBookingsForModeration: failed to unwind booking ${doc.id}`, e);
    }
  }
}

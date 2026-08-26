import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  isValidDocId, MAX_CANCEL_REASON_LENGTH, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  MAX_RELIABILITY_MARKS, NO_SHOW_REPORT_WINDOW_DAYS, MAX_OCCURRENCE_CANCELLATIONS,
  type BookingRequestDoc, type BookingSide, type GigDoc, type GigSeriesDoc,
  type ReliabilityDoc, type ReliabilityMark, type OccurrenceCancellation,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";

// Same "already started" message for both the whole-booking and
// single-occurrence cancel paths — a caller who missed the cancellation
// window is pointed at the same remedy (reportNoShow) either way.
const ALREADY_STARTED_MESSAGE = "This booking has already started — report a no-show instead.";

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

export const cancelBooking = onCall<CancelBookingInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId, reason } = req.data ?? ({} as CancelBookingInput);
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");
  const trimmedReason = validateCancelReason(reason);

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership doesn't depend on mutable booking state — safe to resolve
  // once, outside the transaction (mirrors requireBookingSide's rationale
  // in bookings.ts).
  const callerSide = await resolveBookingSideStrict(booking, uid);

  // Captured once, before the transaction — every check below (the window
  // math, the record we persist) reads this SAME instant, so a `now` no
  // longer current by commit time (a transaction retry, or a slow commit)
  // can never disagree with what actually gets written. A boundary case may
  // therefore favor the canceller by a few seconds — accepted.
  const now = Date.now();
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
      if (occurrenceDocs.length === 0) throw new HttpsError("failed-precondition", ALREADY_STARTED_MESSAGE);
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
    let outcome: CancelOutcome;
    let markApplied = false;
    // { [key]: unknown } rather than a typed literal — the conditional
    // "deposit.forfeitedTo" dot-path key below only applies on the curator/
    // forfeit branch, so this can't be a single object literal.
    const bookingUpdate: { [key: string]: unknown } = {
      status: callerSide === "curator" ? "cancelled_by_curator" : "cancelled_by_musician",
      resolvedAt: now, updatedAt: now,
    };

    if (callerSide === "curator") {
      // STRICTLY less-than — exactly CURATOR_FORFEIT_WINDOW_HOURS refunds.
      outcome = hoursBeforeStart < CURATOR_FORFEIT_WINDOW_HOURS ? "deposit_forfeited" : "deposit_refunded";
      if (outcome === "deposit_forfeited") bookingUpdate["deposit.forfeitedTo"] = "musician";
    } else {
      // Musician side never forfeits the curator's deposit — always refunded.
      outcome = "deposit_refunded";
      markApplied = hoursBeforeStart < MUSICIAN_MARK_WINDOW_HOURS;
    }

    bookingUpdate.cancellation = {
      by: callerSide, reason: trimmedReason, at: now, hoursBeforeStart, outcome, markApplied,
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
      cancellationCopy(callerSide, result.outcome, result.markApplied, "booking", gigTitle);
    await notifyProfileMembers(booking.curatorProfileId, { kind: "booking", title: "Booking cancelled", body: curatorBody });
    await notifyProfileMembers(booking.musicianProfileId, { kind: "booking", title: "Booking cancelled", body: musicianBody });
  } catch (e) {
    console.error(`cancelBooking: failed to notify for booking ${bookingId}`, e);
  }

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

    const hoursBeforeStart = (gig.startsAt - now) / 3_600_000;
    let outcome: CancelOutcome;
    let markApplied = false;
    if (callerSide === "curator") {
      outcome = hoursBeforeStart < CURATOR_FORFEIT_WINDOW_HOURS ? "deposit_forfeited" : "deposit_refunded";
      // Deliberately does NOT touch booking.deposit/deposit.forfeitedTo —
      // that field is the RUN-level outcome (cancelBooking's alone to set).
      // This occurrence's own outcome lives only in the
      // occurrenceCancellations entry below; sub-5 reads it from there.
    } else {
      outcome = "deposit_refunded";
      markApplied = hoursBeforeStart < MUSICIAN_MARK_WINDOW_HOURS;
    }

    const entry: OccurrenceCancellation = { gigId, by: callerSide, at: now, hoursBeforeStart, outcome, markApplied };
    const existing = freshBooking.occurrenceCancellations ?? [];
    const nextEntries = [...existing, entry];
    const cappedEntries = nextEntries.length > MAX_OCCURRENCE_CANCELLATIONS
      ? nextEntries.slice(nextEntries.length - MAX_OCCURRENCE_CANCELLATIONS) : nextEntries;

    // ---- WRITES ----
    // Booking itself stays "confirmed" — only this one date is affected;
    // the run continues with its remaining occurrences.
    tx.update(bookingRef, { occurrenceCancellations: cappedEntries, updatedAt: now });
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
      { kind: "booking", title: "One date of your booking was cancelled", body: curatorBody });
    await notifyProfileMembers(booking.musicianProfileId,
      { kind: "booking", title: "One date of your booking was cancelled", body: musicianBody });
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
    tx.set(reliabilityRef, { marks, completedCount: reliability?.completedCount ?? 0, updatedAt: now });

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
      kind: "booking", title: "No-show reported",
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
  await writeAudit({
    actorUid, action: "reliability_mark_removed", targetId: musicianProfileId,
    detail: `${kind} mark for booking ${bookingId} removed`,
  });

  try {
    await notifyProfileMembers(musicianProfileId, {
      kind: "booking", title: "A reliability mark was removed",
      body: "An admin reviewed your account and removed a mark from your reliability history.",
    });
  } catch (e) {
    console.error(`removeReliabilityMark: failed to notify profile ${musicianProfileId}`, e);
  }

  return { ok: true };
});

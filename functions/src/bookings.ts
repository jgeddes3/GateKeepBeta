import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateOfferInput, isValidDocId, computeExpectedTotalCents, computeDepositCents,
  MAX_BOOKING_THREAD_ENTRIES, MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE,
  DEPOSIT_PERCENT, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  type BookingRequestDoc, type OfferEntry, type BookingSide, type GigDoc, type GigSeriesDoc,
  type AcceptedTerms, type BookingDeposit,
} from "@gatekeep/shared";
import {
  requireAuthUid, requireVerifiedEmail, requireProfileMember,
  requireApprovedMusicianProfile, requireApprovedCuratorProfile,
} from "./guards.js";
import { notifyProfileMembers } from "./notifications.js";

// Untrusted onCall payload shape — same defensive-runtime rationale used
// throughout this codebase (a compile-time type only binds trusted callers).
export interface OfferInput { amountCents: number; expectedQuantity?: number | null; note?: string | null; }
export interface ApplyToGigInput { gigId: string; musicianProfileId: string; offer: OfferInput; }
export interface OfferGigInput { gigId: string; musicianProfileId: string; offer: OfferInput; }
export interface CounterBookingInput { bookingId: string; offer: OfferInput; }

async function profileName(db: FirebaseFirestore.Firestore, profileId: string): Promise<string> {
  const snap = await db.doc(`profiles/${profileId}`).get();
  return (snap.data()?.name as string | undefined) ?? "A profile";
}

// Resolves which side (if any) `uid` belongs to on this booking.
// musicianProfileId/curatorProfileId are immutable once a booking is
// created, so this is safe to resolve from a non-transactional read even
// though the turn-based checks in counterBooking/declineBooking/
// withdrawBooking (which depend on the MUTABLE awaitingSide/status/thread)
// are not — those re-check against a transactional re-read instead (see
// each callable below). A stranger to both sides throws permission-denied
// immediately; this function only tells you WHICH side you're on, never
// whether it's currently that side's turn.
async function requireBookingSide(booking: BookingRequestDoc, uid: string): Promise<BookingSide> {
  const db = getFirestore();
  const [musicianMember, curatorMember] = await Promise.all([
    db.doc(`profiles/${booking.musicianProfileId}/members/${uid}`).get(),
    db.doc(`profiles/${booking.curatorProfileId}/members/${uid}`).get(),
  ]);
  if (musicianMember.exists) return "musician";
  if (curatorMember.exists) return "curator";
  throw new HttpsError("permission-denied", "Only a member of this booking's profiles can do that.");
}

// Shared tail end of applyToGig/offerGig, once each has resolved its own
// caller-side + other-side authorization: validates the offer, derives the
// server-owned perHour quantity, dedupes, enforces the initiator's open-cap,
// detects a whole-run series occurrence, writes the booking, and notifies
// the awaiting side. `initiatedBy` alone decides every asymmetry (which
// profile the cap counts against, who's now awaitingSide, who gets
// notified) — see gigs.ts's resolveGigLocation for the identical
// shared-tail-of-two-callables pattern.
//
// Precondition: callers MUST have already verified `gig.status === "open"`
// before calling this — it does not re-check gig status itself (a gig
// doesn't change concurrently with a fresh booking's creation the way an
// existing booking's awaitingSide/status does, so no transaction is needed
// here; applyToGig/offerGig's own status check just before the call is the
// single source of truth).
async function finalizeBookingRequest(params: {
  db: FirebaseFirestore.Firestore;
  gig: GigDoc; gigId: string;
  curatorProfileId: string; musicianProfileId: string;
  initiatedBy: BookingSide;
  offer: OfferInput;
  actingProfileName: string;
}): Promise<{ bookingId: string }> {
  const { db, gig, gigId, curatorProfileId, musicianProfileId, initiatedBy, offer, actingProfileName } = params;
  const structure = gig.budget.structure;
  const err = validateOfferInput(structure, {
    amountCents: offer?.amountCents, expectedQuantity: offer?.expectedQuantity, note: offer?.note,
  });
  if (err) throw new HttpsError("invalid-argument", err);

  // perHour: server-derived from the gig's own duration, never trusted from
  // the caller (validateOfferInput requires the input value be null/absent
  // for perHour/perSet). perSong: caller-supplied, already validated as a
  // 1..MAX_OFFER_SONG_COUNT integer above. perSet: always null.
  const expectedQuantity = structure === "perHour" ? gig.durationMinutes / 60
    : structure === "perSong" ? (offer.expectedQuantity as number)
    : null;

  // Dedupe: at most one OPEN booking per (gig, musician) pair, regardless of
  // which side initiated it — an accepted/declined/withdrawn prior round
  // doesn't block a fresh one. Needs its own 3-field composite index (see
  // firestore.indexes.json) — the existing (gigId,status) index doesn't
  // cover the added musicianProfileId equality filter.
  const dupSnap = await db.collection("bookings")
    .where("gigId", "==", gigId).where("musicianProfileId", "==", musicianProfileId)
    .where("status", "==", "open").limit(1).get();
  if (!dupSnap.empty) {
    throw new HttpsError("already-exists", "There is already an open booking request between this act and this gig.");
  }

  // Cap: counts the INITIATING profile's own open, self-initiated bookings
  // (not every open booking naming that profile — an offer a curator
  // received doesn't count against that curator's own initiated cap).
  // Soft/non-transactional tier, matching publishGig's identical count-query
  // idiom in gigs.ts. Needs its own composite index per side (see
  // firestore.indexes.json) — the existing (profileId,status,updatedAt)
  // indexes don't cover the added initiatedBy equality filter.
  const capField = initiatedBy === "musician" ? "musicianProfileId" : "curatorProfileId";
  const capProfileId = initiatedBy === "musician" ? musicianProfileId : curatorProfileId;
  const openCount = await db.collection("bookings")
    .where(capField, "==", capProfileId)
    .where("initiatedBy", "==", initiatedBy)
    .where("status", "==", "open")
    .count().get();
  if (openCount.data().count >= MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE) {
    throw new HttpsError("resource-exhausted",
      `A profile may have at most ${MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE} open initiated booking requests.`);
  }

  // Whole-run detection: this booking targets the entire series' run (not
  // just this one occurrence) only when the gig belongs to an ACTIVE series
  // whose fillMode is "whole_run" — a paused/ended series, or a
  // per_occurrence one, books only this occurrence (seriesId stays null).
  let seriesId: string | null = null;
  if (gig.seriesId) {
    const seriesSnap = await db.doc(`gigSeries/${gig.seriesId}`).get();
    const series = seriesSnap.data() as GigSeriesDoc | undefined;
    if (series?.fillMode === "whole_run" && series.status === "active") seriesId = gig.seriesId;
  }

  const now = Date.now();
  const entry: OfferEntry = {
    by: initiatedBy, amountCents: offer.amountCents, expectedQuantity, note: offer.note ?? null, at: now,
  };
  const awaitingSide: BookingSide = initiatedBy === "musician" ? "curator" : "musician";
  const bookingRef = db.collection("bookings").doc();
  const booking: BookingRequestDoc = {
    gigId, seriesId, curatorProfileId, musicianProfileId, initiatedBy, structure,
    thread: [entry], awaitingSide, status: "open",
    acceptedTerms: null, deposit: null, cancellation: null,
    createdAt: now, updatedAt: now, confirmedAt: null, resolvedAt: null,
  };
  await bookingRef.set(booking);

  const notifyProfileId = awaitingSide === "musician" ? musicianProfileId : curatorProfileId;
  const verb = initiatedBy === "musician" ? "wants to play this gig" : "wants to book you for this gig";
  await notifyProfileMembers(notifyProfileId, {
    kind: "booking",
    title: initiatedBy === "musician" ? `New booking request for "${gig.title}"` : `New booking offer for "${gig.title}"`,
    body: `${actingProfileName} ${verb}.`,
  });

  return { bookingId: bookingRef.id };
}

export const applyToGig = onCall<ApplyToGigInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");
  if (!isValidDocId(input?.musicianProfileId)) {
    throw new HttpsError("invalid-argument", "A musician profile id is required.");
  }

  // sequential is deliberate — mirrors createGig's identical rationale:
  // parallelizing makes rejection order nondeterministic and would leak
  // profile existence/type/approval status to non-members.
  await requireProfileMember(input.musicianProfileId, uid);
  const musicianSnap = await requireApprovedMusicianProfile(input.musicianProfileId);

  const db = getFirestore();
  const gigSnap = await db.doc(`gigs/${input.gigId}`).get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;
  if (gig.status !== "open") {
    // Generic message (not the actual status) — unlike offerGig/updateGig's
    // equivalent checks, the caller here need not be any kind of member of
    // the gig's curator profile, so echoing the real status back would be an
    // enumeration oracle for a non-member probing gig ids.
    throw new HttpsError("failed-precondition", "This gig is not open for applications.");
  }
  // Re-read: the curator profile may have been unpublished/rejected after
  // posting this gig — mirrors publishGig/updateGig's identical staleness
  // rationale in gigs.ts (a since-rejected profile's gig can still be
  // "open" until the review-reject cascade or a later sweep catches it).
  await requireApprovedCuratorProfile(gig.curatorProfileId);

  const musicianName = (musicianSnap.data()?.name as string | undefined) ?? "A profile";
  return finalizeBookingRequest({
    db, gig, gigId: input.gigId,
    curatorProfileId: gig.curatorProfileId, musicianProfileId: input.musicianProfileId,
    initiatedBy: "musician", offer: input.offer, actingProfileName: musicianName,
  });
});

export const offerGig = onCall<OfferGigInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");
  if (!isValidDocId(input?.musicianProfileId)) {
    throw new HttpsError("invalid-argument", "A musician profile id is required.");
  }

  const db = getFirestore();
  const gigSnap = await db.doc(`gigs/${input.gigId}`).get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;

  // sequential — same rationale as applyToGig above.
  await requireProfileMember(gig.curatorProfileId, uid);
  const curatorSnap = await requireApprovedCuratorProfile(gig.curatorProfileId);

  if (gig.status !== "open") {
    // Unlike applyToGig's variant, echoing the real status here is fine —
    // the caller must already be a member of the gig's own curator profile
    // to reach this line, so there's nothing to enumerate.
    throw new HttpsError("failed-precondition", `Cannot offer on a gig in status "${gig.status}".`);
  }
  await requireApprovedMusicianProfile(input.musicianProfileId);

  const curatorName = (curatorSnap.data()?.name as string | undefined) ?? "A profile";
  return finalizeBookingRequest({
    db, gig, gigId: input.gigId,
    curatorProfileId: gig.curatorProfileId, musicianProfileId: input.musicianProfileId,
    initiatedBy: "curator", offer: input.offer, actingProfileName: curatorName,
  });
});

export const counterBooking = onCall<CounterBookingInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${input.bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership (which side, if any, `uid` is on) doesn't depend on mutable
  // booking state — safe to resolve once, outside the transaction below.
  const callerSide = await requireBookingSide(booking, uid);

  // Re-derived from the CURRENT gig, not copied from an earlier thread entry
  // or trusted from the caller — the task explicitly allows this read
  // before/outside the transaction (only the thread append itself needs the
  // transactional booking read).
  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gig = gigSnap.data() as GigDoc | undefined;
  // Defensive: a booking always names an existing gig at creation time and
  // nothing in this task deletes gigs — surfaces as a clear internal error
  // rather than an uncaught TypeError on `gig.durationMinutes`/`gig.title`
  // below if that invariant is ever violated.
  if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");

  // booking.structure is immutable once set — safe to validate against the
  // outer (non-transactional) read.
  const err = validateOfferInput(booking.structure, {
    amountCents: input.offer?.amountCents, expectedQuantity: input.offer?.expectedQuantity, note: input.offer?.note,
  });
  if (err) throw new HttpsError("invalid-argument", err);

  const now = Date.now();
  // Turn/status/thread-cap checks AND the thread append all run against a
  // single transactional read-then-write: without this, two same-side
  // concurrent counters each read a stale thread and the second `update`
  // would silently clobber the first's entry (last-write-wins on the full
  // array replace) — a dropped negotiation entry with no self-heal.
  // Firestore retries this function on write contention, so the second
  // caller's retry sees the first counter's fresh thread/awaitingSide.
  const { notifyProfileId } = await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;

    if (callerSide !== freshBooking.awaitingSide) {
      throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
    }
    if (freshBooking.status !== "open") {
      throw new HttpsError("failed-precondition", `Cannot counter a booking in status "${freshBooking.status}".`);
    }
    if (freshBooking.thread.length >= MAX_BOOKING_THREAD_ENTRIES) {
      throw new HttpsError("resource-exhausted",
        `A booking's negotiation thread may have at most ${MAX_BOOKING_THREAD_ENTRIES} entries.`);
    }

    const expectedQuantity = freshBooking.structure === "perHour" ? gig.durationMinutes / 60
      : freshBooking.structure === "perSong" ? (input.offer.expectedQuantity as number)
      : null;
    const entry: OfferEntry = {
      by: freshBooking.awaitingSide, amountCents: input.offer.amountCents, expectedQuantity,
      note: input.offer.note ?? null, at: now,
    };
    const newAwaitingSide: BookingSide = freshBooking.awaitingSide === "musician" ? "curator" : "musician";
    tx.update(bookingRef, { thread: [...freshBooking.thread, entry], awaitingSide: newAwaitingSide, updatedAt: now });

    const notifyProfileId = newAwaitingSide === "musician" ? freshBooking.musicianProfileId : freshBooking.curatorProfileId;
    return { newAwaitingSide, notifyProfileId };
  });

  const actingProfileId = callerSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  await notifyProfileMembers(notifyProfileId, {
    kind: "booking",
    title: `Countered offer for "${gig.title}"`,
    body: `${actingName} sent a new offer.`,
  });

  return { ok: true };
});

export const declineBooking = onCall<{ bookingId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId } = req.data ?? ({} as { bookingId: string });
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership resolved once, outside the transaction — see requireBookingSide.
  const callerSide = await requireBookingSide(booking, uid);

  const now = Date.now();
  // Turn/status check + write share a transactional read so a decline can't
  // race a concurrent counter/withdraw against a stale status/awaitingSide
  // (same rationale as counterBooking above).
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;

    if (callerSide !== freshBooking.awaitingSide) {
      throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
    }
    if (freshBooking.status !== "open") {
      throw new HttpsError("failed-precondition", `Cannot decline a booking in status "${freshBooking.status}".`);
    }
    tx.update(bookingRef, { status: "declined", resolvedAt: now, updatedAt: now });
  });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = callerSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = callerSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  await notifyProfileMembers(otherProfileId, {
    kind: "booking",
    title: "Booking request declined",
    body: `${actingName} declined your booking request${gigTitle ? ` for "${gigTitle}"` : ""}.`,
  });

  return { ok: true };
});

export const withdrawBooking = onCall<{ bookingId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId } = req.data ?? ({} as { bookingId: string });
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership resolved once, outside the transaction — see requireBookingSide.
  const callerSide = await requireBookingSide(booking, uid);

  const now = Date.now();
  // You can withdraw only while the OTHER side is deciding (i.e. you are NOT
  // the current awaitingSide) — determined against the transaction's fresh
  // read, same rationale as counterBooking/declineBooking above.
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;
    const nonAwaitingSide: BookingSide = freshBooking.awaitingSide === "musician" ? "curator" : "musician";

    if (callerSide !== nonAwaitingSide) {
      throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
    }
    if (freshBooking.status !== "open") {
      throw new HttpsError("failed-precondition", `Cannot withdraw a booking in status "${freshBooking.status}".`);
    }
    tx.update(bookingRef, { status: "withdrawn", resolvedAt: now, updatedAt: now });
  });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = callerSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = callerSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  await notifyProfileMembers(otherProfileId, {
    kind: "booking",
    title: "Booking request withdrawn",
    body: `${actingName} withdrew their booking request${gigTitle ? ` for "${gigTitle}"` : ""}.`,
  });

  return { ok: true };
});

// Generic message for every reason a gig/run can be unavailable at accept
// time (gig closed underneath the negotiation, or — whole-run — the series
// paused/ended mid-thread). Deliberately identical across both branches: the
// caller reached this callable as a legitimate member of the booking, so
// there's no enumeration concern in being specific, but the two cases are
// operationally the same thing from the accepting side's point of view
// ("what you were about to confirm isn't there anymore").
const GIG_UNAVAILABLE_MESSAGE = "This gig is no longer available.";

async function supersedeSiblingBooking(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot, now: number,
): Promise<void> {
  // Fan-out is best-effort and MUST be failure-isolated: one poisoned
  // sibling (a missing gig doc, a transient write failure) must never abort
  // the rest of the fan-out — the already-committed accept transaction is
  // not undone by a notification/supersede failure here. Task 8's sweep
  // expiry step is the backstop for anything a failed iteration misses.
  try {
    const rival = doc.data() as BookingRequestDoc;
    // Optimistic precondition (a real one, not just a stale in-memory
    // check): `doc` came from a plain, non-transactional query snapshot
    // taken moments before this loop — a concurrent decline/withdraw/
    // counter on this same booking (or, benignly, this callable's own two
    // overlapping sibling queries returning the same doc — `seen` already
    // dedupes that case) could have moved it off "open" by the time we get
    // here. `lastUpdateTime` makes the write itself conditional on nothing
    // having touched the doc since we read it; a lost race surfaces as a
    // FAILED_PRECONDITION, which the catch below absorbs exactly like any
    // other per-booking fan-out failure.
    await doc.ref.update(
      { status: "superseded", resolvedAt: now, updatedAt: now },
      { lastUpdateTime: doc.updateTime },
    );

    const rivalGigSnap = await db.doc(`gigs/${rival.gigId}`).get();
    const rivalGigTitle = (rivalGigSnap.data() as GigDoc | undefined)?.title;
    await notifyProfileMembers(rival.musicianProfileId, {
      kind: "booking",
      title: "Booking request no longer available",
      body: `Another act was booked for${rivalGigTitle ? ` "${rivalGigTitle}"` : " this gig"}.`,
    });
  } catch (e) {
    console.error(`acceptBooking: failed to supersede/notify sibling booking ${doc.id}`, e);
  }
}

export const acceptBooking = onCall<{ bookingId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { bookingId } = req.data ?? ({} as { bookingId: string });
  if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data() as BookingRequestDoc;

  // Membership resolved once, outside the transaction — see requireBookingSide.
  const callerSide = await requireBookingSide(booking, uid);

  const now = Date.now();
  // Everything that decides whether the fill can happen — the booking's own
  // turn/status/thread, the gig's live status, and (whole-run) the series'
  // live status plus EVERY currently-open occurrence of the run — is read
  // and written inside ONE transaction. Without this, a gig/series status
  // flip (a takedown, another callable, an admin-SDK race, or two racing
  // accepts) could slip in between a pre-transaction check and the write
  // below. Same turn-check idiom as counterBooking/declineBooking/
  // withdrawBooking (see their comments); this callable just has more state
  // to re-read before it can safely write.
  const { filledGigIds } = await db.runTransaction(async (tx) => {
    // ---- READS (all of them, before any write — Admin SDK transaction rule) ----
    const freshSnap = await tx.get(bookingRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const freshBooking = freshSnap.data() as BookingRequestDoc;

    if (callerSide !== freshBooking.awaitingSide) {
      throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
    }
    if (freshBooking.status !== "open") {
      throw new HttpsError("failed-precondition", `Cannot accept a booking in status "${freshBooking.status}".`);
    }

    const gigRef = db.doc(`gigs/${freshBooking.gigId}`);
    const gigSnap = await tx.get(gigRef);
    const gig = gigSnap.data() as GigDoc | undefined;
    // Defensive — mirrors counterBooking's identical rationale: a booking
    // always names an existing gig at creation time and nothing deletes gigs.
    if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");
    if (gig.status !== "open") throw new HttpsError("failed-precondition", GIG_UNAVAILABLE_MESSAGE);

    // Whole-run: re-read the series (must still be active) and every
    // currently-open occurrence of the run — bounded (series occurrences
    // never exceed the SERIES_MATERIALIZE_WEEKS-week materialize window),
    // so a transactional query here is safe. This query's results include
    // the initiating gig itself (it's checked open above, and it IS an
    // occurrence of its own series), so the write loop below is the single
    // place every occurrence — including the one this booking's thread was
    // actually about — gets filled; no separate write to `gigRef` is needed
    // in the whole-run branch.
    let occurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    if (freshBooking.seriesId) {
      const seriesRef = db.doc(`gigSeries/${freshBooking.seriesId}`);
      const seriesSnap = await tx.get(seriesRef);
      const series = seriesSnap.data() as GigSeriesDoc | undefined;
      if (!series || series.status !== "active") {
        throw new HttpsError("failed-precondition", GIG_UNAVAILABLE_MESSAGE);
      }
      // Task 7 carry-forward (a) — the rebooking door: a cancelOccurrence-
      // reopened date on a still-active whole_run series can otherwise
      // accept a FRESH whole-run applyToGig/offerGig even while the series
      // is already linked to another confirmed run booking (applyToGig's
      // whole-run detection only checks fillMode+status, never
      // activeBookingId). Refuse here — a series names at most one confirmed
      // run booking at a time.
      if (series.activeBookingId != null && series.activeBookingId !== bookingId) {
        throw new HttpsError("failed-precondition", "This series is already booked.");
      }
      const occurrenceSnap = await tx.get(
        db.collection("gigs").where("seriesId", "==", freshBooking.seriesId).where("status", "==", "open"));
      occurrenceDocs = occurrenceSnap.docs;
    }

    // ---- Freeze terms from the LAST thread entry — whatever the two sides
    // most recently landed on, never the first offer. Whole-run: this doc's
    // acceptedTerms/deposit are computed from the INITIATING gig's
    // durationMinutes alone and represent ONE occurrence — an occurrence
    // that has since detached from the series template (updateGig) and
    // carries its own edited duration is NOT reflected here; sub-5
    // recomputes each occurrence's own total from `acceptedTerms.amountCents`
    // at settlement time, using THAT occurrence's actual duration. ----
    const lastEntry = freshBooking.thread[freshBooking.thread.length - 1];
    const expectedTotalCents = computeExpectedTotalCents(freshBooking.structure, lastEntry.amountCents, {
      durationMinutes: gig.durationMinutes, songCount: lastEntry.expectedQuantity ?? undefined,
    });
    // Tripwire (quality-review mandate): a forgotten/corrupted
    // durationMinutes or songCount must never silently produce a $0 deposit
    // obligation — fail loudly instead.
    if (expectedTotalCents <= 0) {
      throw new HttpsError("failed-precondition",
        "This booking's terms compute to a $0 total — check the gig's duration/song count before accepting.");
    }
    const acceptedTerms: AcceptedTerms = {
      amountCents: lastEntry.amountCents, expectedQuantity: lastEntry.expectedQuantity, expectedTotalCents,
    };
    const deposit: BookingDeposit = {
      amountCents: computeDepositCents(expectedTotalCents), status: "unpaid", forfeitedTo: null,
      policy: {
        percent: DEPOSIT_PERCENT, curatorForfeitHours: CURATOR_FORFEIT_WINDOW_HOURS,
        musicianMarkHours: MUSICIAN_MARK_WINDOW_HOURS,
      },
    };

    // ---- WRITES ----
    tx.update(bookingRef, { status: "confirmed", confirmedAt: now, updatedAt: now, acceptedTerms, deposit });

    const filledGigIds: string[] = [];
    if (freshBooking.seriesId) {
      for (const doc of occurrenceDocs) {
        tx.update(doc.ref, {
          status: "filled", bookingId, bookedMusicianProfileId: freshBooking.musicianProfileId, updatedAt: now,
        });
        filledGigIds.push(doc.id);
      }
      tx.update(db.doc(`gigSeries/${freshBooking.seriesId}`), {
        activeBookingId: bookingId, bookedMusicianProfileId: freshBooking.musicianProfileId, updatedAt: now,
      });
    } else {
      tx.update(gigRef, {
        status: "filled", bookingId, bookedMusicianProfileId: freshBooking.musicianProfileId, updatedAt: now,
      });
      filledGigIds.push(freshBooking.gigId);
    }

    return { filledGigIds };
  });

  // ---- POST-TRANSACTION FAN-OUT (deliberately outside the txn) ----
  // Sibling supersede: every other OPEN booking naming any gig this accept
  // just filled, UNION (whole-run only) every open booking naming the run's
  // series directly — the latter is a second, overlapping net in case a
  // rival whole-run applicant's own gigId isn't among `filledGigIds` for
  // some edge-case reason. `seen` dedupes across both queries (and excludes
  // the winner itself, whose status is no longer "open" anyway) so a
  // booking matching both is only processed once. Idempotent +
  // failure-isolated (see supersedeSiblingBooking) — Task 8's sweep expiry
  // step is the backstop for anything missed here.
  const seen = new Set<string>([bookingId]);
  const siblingQueries = filledGigIds.map((gid) =>
    db.collection("bookings").where("gigId", "==", gid).where("status", "==", "open"));
  if (booking.seriesId) {
    siblingQueries.push(
      db.collection("bookings").where("seriesId", "==", booking.seriesId).where("status", "==", "open"));
  }
  for (const q of siblingQueries) {
    const snap = await q.get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      await supersedeSiblingBooking(db, doc, now);
    }
  }

  // Winners — both sides. booking.gigId/musicianProfileId/curatorProfileId
  // are immutable (see requireBookingSide), so the outer, pre-transaction
  // `booking` is safe to use here. Unlike decline/withdrawBooking's
  // equivalent (unwrapped) tail, this one is wrapped: the accept has
  // already committed by this point (the transaction above returned), so a
  // failure in this best-effort notification tail — a transient read/write
  // error, nothing more — must never surface as an error to the caller. An
  // apparent failure here would look like the accept itself failed and
  // invite a confusing retry (which would then hit its own
  // failed-precondition, since the booking is no longer "open") even though
  // the gig is already correctly filled.
  try {
    const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
    const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
    const musicianName = await profileName(db, booking.musicianProfileId);
    const curatorName = await profileName(db, booking.curatorProfileId);
    await notifyProfileMembers(booking.curatorProfileId, {
      kind: "booking",
      title: `Booking confirmed${gigTitle ? ` for "${gigTitle}"` : ""}`,
      body: `${musicianName} is booked and confirmed.`,
    });
    await notifyProfileMembers(booking.musicianProfileId, {
      kind: "booking",
      title: `Booking confirmed${gigTitle ? ` for "${gigTitle}"` : ""}`,
      body: `You're booked and confirmed with ${curatorName}.`,
    });
  } catch (e) {
    console.error(`acceptBooking: failed to notify winners for booking ${bookingId}`, e);
  }

  return { ok: true };
});

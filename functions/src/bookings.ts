import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateOfferInput, isValidDocId,
  MAX_BOOKING_THREAD_ENTRIES, MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE,
  type BookingRequestDoc, type OfferEntry, type BookingSide, type GigDoc, type GigSeriesDoc,
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
  return (snap.data()?.name as string | undefined) ?? "";
}

// Turn-gated actions (counterBooking/declineBooking/withdrawBooking) share
// this distinction: a member of the booking's OTHER side is a legitimate
// participant (they can read this booking; they just can't act on it right
// now) — that's a state violation (failed-precondition, "not your turn"),
// distinct from a total stranger to both sides of the booking, which is a
// genuine authorization failure (permission-denied).
async function requireBookingTurnSide(
  booking: BookingRequestDoc, uid: string, allowedSide: BookingSide,
): Promise<void> {
  const allowedProfileId = allowedSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const otherProfileId = allowedSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  const db = getFirestore();
  const [allowedMember, otherMember] = await Promise.all([
    db.doc(`profiles/${allowedProfileId}/members/${uid}`).get(),
    db.doc(`profiles/${otherProfileId}/members/${uid}`).get(),
  ]);
  if (allowedMember.exists) return;
  if (otherMember.exists) {
    throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
  }
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
    throw new HttpsError("failed-precondition", `Cannot apply to a gig in status "${gig.status}".`);
  }
  // Re-read: the curator profile may have been unpublished/rejected after
  // posting this gig — mirrors publishGig/updateGig's identical staleness
  // rationale in gigs.ts (a since-rejected profile's gig can still be
  // "open" until the review-reject cascade or a later sweep catches it).
  await requireApprovedCuratorProfile(gig.curatorProfileId);

  const musicianName = (musicianSnap.data()?.name as string | undefined) ?? "";
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
    throw new HttpsError("failed-precondition", `Cannot offer on a gig in status "${gig.status}".`);
  }
  await requireApprovedMusicianProfile(input.musicianProfileId);

  const curatorName = (curatorSnap.data()?.name as string | undefined) ?? "";
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

  // Turn enforcement — only the side currently awaiting a response may
  // counter it.
  await requireBookingTurnSide(booking, uid, booking.awaitingSide);
  if (booking.status !== "open") {
    throw new HttpsError("failed-precondition", `Cannot counter a booking in status "${booking.status}".`);
  }
  if (booking.thread.length >= MAX_BOOKING_THREAD_ENTRIES) {
    throw new HttpsError("resource-exhausted",
      `A booking's negotiation thread may have at most ${MAX_BOOKING_THREAD_ENTRIES} entries.`);
  }

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gig = gigSnap.data() as GigDoc | undefined;
  // Defensive: a booking always names an existing gig at creation time and
  // nothing in this task deletes gigs — surfaces as a clear internal error
  // rather than an uncaught TypeError on `gig.durationMinutes`/`gig.title`
  // below if that invariant is ever violated.
  if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");

  const err = validateOfferInput(booking.structure, {
    amountCents: input.offer?.amountCents, expectedQuantity: input.offer?.expectedQuantity, note: input.offer?.note,
  });
  if (err) throw new HttpsError("invalid-argument", err);

  // perHour quantity is re-derived from the CURRENT gig, not copied from an
  // earlier thread entry or trusted from the caller — mirrors
  // finalizeBookingRequest's identical derivation, re-run here in case the
  // gig's duration changed since the booking opened.
  const expectedQuantity = booking.structure === "perHour" ? gig.durationMinutes / 60
    : booking.structure === "perSong" ? (input.offer.expectedQuantity as number)
    : null;

  const now = Date.now();
  const entry: OfferEntry = {
    by: booking.awaitingSide, amountCents: input.offer.amountCents, expectedQuantity,
    note: input.offer.note ?? null, at: now,
  };
  const newAwaitingSide: BookingSide = booking.awaitingSide === "musician" ? "curator" : "musician";
  await bookingRef.update({ thread: [...booking.thread, entry], awaitingSide: newAwaitingSide, updatedAt: now });

  const actingProfileId = booking.awaitingSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const notifyProfileId = newAwaitingSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
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

  // Only the side currently awaiting a response may decline THIS offer —
  // same turn-enforcement rationale as counterBooking.
  await requireBookingTurnSide(booking, uid, booking.awaitingSide);
  if (booking.status !== "open") {
    throw new HttpsError("failed-precondition", `Cannot decline a booking in status "${booking.status}".`);
  }

  const now = Date.now();
  await bookingRef.update({ status: "declined", resolvedAt: now, updatedAt: now });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = booking.awaitingSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = booking.awaitingSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
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

  // You can withdraw only while the OTHER side is deciding (i.e. you are
  // NOT the current awaitingSide) — same turn-enforcement rationale as
  // counterBooking/declineBooking, inverted: once it's your own turn, the
  // right action is to counter or decline, not withdraw.
  const nonAwaitingSide: BookingSide = booking.awaitingSide === "musician" ? "curator" : "musician";
  await requireBookingTurnSide(booking, uid, nonAwaitingSide);
  if (booking.status !== "open") {
    throw new HttpsError("failed-precondition", `Cannot withdraw a booking in status "${booking.status}".`);
  }

  const now = Date.now();
  await bookingRef.update({ status: "withdrawn", resolvedAt: now, updatedAt: now });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = nonAwaitingSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = nonAwaitingSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  await notifyProfileMembers(otherProfileId, {
    kind: "booking",
    title: "Booking request withdrawn",
    body: `${actingName} withdrew their booking request${gigTitle ? ` for "${gigTitle}"` : ""}.`,
  });

  return { ok: true };
});

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateOfferInput, isValidDocId, computeExpectedTotalCents, computeDepositCents,
  MAX_BOOKING_THREAD_ENTRIES, MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE,
  DEPOSIT_PERCENT, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  type BookingRequestDoc, type OfferEntry, type BookingSide, type GigDoc, type GigSeriesDoc,
  type AcceptedTerms, type BookingDeposit, type PaymentDoc, type StripeProfileDoc,
} from "@gatekeep/shared";
import {
  requireAuthUid, requireVerifiedEmail, requireProfileMember,
  requireApprovedMusicianProfile, requireApprovedCuratorProfile,
} from "./guards.js";
import { notifyProfileMembers } from "./notifications.js";
import {
  requireCuratorChargeable, requireMusicianPayoutReady, currentFeePolicy, buildPaymentDoc,
  writeLedger, recomputePaymentSummary,
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, BOOKING_NOT_CONFIRMABLE_MESSAGE,
  MUSICIAN_PAYOUTS_REQUIRED_MESSAGE, CARD_DECLINED_MESSAGE, DEPOSIT_PROCESSING_MESSAGE,
  DEPOSIT_RECONCILING_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE, BOOKING_LOCKED_BY_DEPOSIT_MESSAGE,
  type StagedOccurrence,
} from "./paymentsCore.js";
import {
  getStripe, stripeSecretKey, StripeCardDeclinedError, StripePaymentPendingError,
} from "./stripeClient.js";
import { paymentIntentSucceededHandlers } from "./paymentsWebhook.js";

// Untrusted onCall payload shape, same defensive-runtime rationale used
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
// are not, those re-check against a transactional re-read instead (see
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
// notified), see gigs.ts's resolveGigLocation for the identical
// shared-tail-of-two-callables pattern.
//
// Precondition: callers MUST have already verified `gig.status === "open"`
// before calling this, it does not re-check gig status itself (a gig
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
  // which side initiated it, an accepted/declined/withdrawn prior round
  // doesn't block a fresh one. Needs its own 3-field composite index (see
  // firestore.indexes.json), the existing (gigId,status) index doesn't
  // cover the added musicianProfileId equality filter.
  const dupSnap = await db.collection("bookings")
    .where("gigId", "==", gigId).where("musicianProfileId", "==", musicianProfileId)
    .where("status", "==", "open").limit(1).get();
  if (!dupSnap.empty) {
    throw new HttpsError("already-exists", "There is already an open booking request between this act and this gig.");
  }

  // Cap: counts the INITIATING profile's own open, self-initiated bookings
  // (not every open booking naming that profile, an offer a curator
  // received doesn't count against that curator's own initiated cap).
  // Soft/non-transactional tier, matching publishGig's identical count-query
  // idiom in gigs.ts. Needs its own composite index per side (see
  // firestore.indexes.json), the existing (profileId,status,updatedAt)
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
  // whose fillMode is "whole_run", a paused/ended series, or a
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
    kind: "booking", refId: bookingRef.id,
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

  // sequential is deliberate, mirrors createGig's identical rationale:
  // parallelizing makes rejection order nondeterministic and would leak
  // profile existence/type/approval status to non-members.
  await requireProfileMember(input.musicianProfileId, uid);
  const musicianSnap = await requireApprovedMusicianProfile(input.musicianProfileId);

  const db = getFirestore();
  const gigSnap = await db.doc(`gigs/${input.gigId}`).get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;
  if (gig.status !== "open") {
    // Generic message (not the actual status), unlike offerGig/updateGig's
    // equivalent checks, the caller here need not be any kind of member of
    // the gig's curator profile, so echoing the real status back would be an
    // enumeration oracle for a non-member probing gig ids.
    throw new HttpsError("failed-precondition", "This gig is not open for applications.");
  }
  // Re-read: the curator profile may have been unpublished/rejected after
  // posting this gig, mirrors publishGig/updateGig's identical staleness
  // rationale in gigs.ts (a since-rejected profile's gig can still be
  // "open" until the review-reject cascade or a later sweep catches it).
  await requireApprovedCuratorProfile(gig.curatorProfileId);
  await requireMusicianPayoutReady(input.musicianProfileId);

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

  // sequential, same rationale as applyToGig above.
  await requireProfileMember(gig.curatorProfileId, uid);
  const curatorSnap = await requireApprovedCuratorProfile(gig.curatorProfileId);

  if (gig.status !== "open") {
    // Unlike applyToGig's variant, echoing the real status here is fine,
    // the caller must already be a member of the gig's own curator profile
    // to reach this line, so there's nothing to enumerate.
    throw new HttpsError("failed-precondition", `Cannot offer on a gig in status "${gig.status}".`);
  }
  await requireApprovedMusicianProfile(input.musicianProfileId);
  await requireCuratorChargeable(gig.curatorProfileId);

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
  // booking state, safe to resolve once, outside the transaction below.
  const callerSide = await requireBookingSide(booking, uid);

  // Re-derived from the CURRENT gig, not copied from an earlier thread entry
  // or trusted from the caller, the task explicitly allows this read
  // before/outside the transaction (only the thread append itself needs the
  // transactional booking read).
  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gig = gigSnap.data() as GigDoc | undefined;
  // Defensive: a booking always names an existing gig at creation time and
  // nothing in this task deletes gigs, surfaces as a clear internal error
  // rather than an uncaught TypeError on `gig.durationMinutes`/`gig.title`
  // below if that invariant is ever violated.
  if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");

  // booking.structure is immutable once set, safe to validate against the
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
  // array replace), a dropped negotiation entry with no self-heal.
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
    // An accept saga is mid-flight on this booking, see
    // BOOKING_LOCKED_BY_DEPOSIT_MESSAGE for why this is a money guard rather
    // than a courtesy. Checked against the TRANSACTIONAL read, like every
    // other precondition here.
    if (freshBooking.depositChargePending === true) {
      throw new HttpsError("failed-precondition", BOOKING_LOCKED_BY_DEPOSIT_MESSAGE);
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
    kind: "booking", refId: input.bookingId,
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

  // Membership resolved once, outside the transaction, see requireBookingSide.
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
    // See counterBooking's identical guard (and
    // BOOKING_LOCKED_BY_DEPOSIT_MESSAGE): resolving a booking out from under a
    // staged charge strands both the money and the sweep's staleness clock.
    if (freshBooking.depositChargePending === true) {
      throw new HttpsError("failed-precondition", BOOKING_LOCKED_BY_DEPOSIT_MESSAGE);
    }
    tx.update(bookingRef, { status: "declined", resolvedAt: now, updatedAt: now });
  });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = callerSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = callerSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  await notifyProfileMembers(otherProfileId, {
    kind: "booking", refId: bookingId,
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

  // Membership resolved once, outside the transaction, see requireBookingSide.
  const callerSide = await requireBookingSide(booking, uid);

  const now = Date.now();
  // You can withdraw only while the OTHER side is deciding (i.e. you are NOT
  // the current awaitingSide), determined against the transaction's fresh
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
    // See counterBooking's identical guard (and
    // BOOKING_LOCKED_BY_DEPOSIT_MESSAGE): resolving a booking out from under a
    // staged charge strands both the money and the sweep's staleness clock.
    if (freshBooking.depositChargePending === true) {
      throw new HttpsError("failed-precondition", BOOKING_LOCKED_BY_DEPOSIT_MESSAGE);
    }
    tx.update(bookingRef, { status: "withdrawn", resolvedAt: now, updatedAt: now });
  });

  const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
  const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
  const actingProfileId = callerSide === "musician" ? booking.musicianProfileId : booking.curatorProfileId;
  const actingName = await profileName(db, actingProfileId);
  const otherProfileId = callerSide === "musician" ? booking.curatorProfileId : booking.musicianProfileId;
  await notifyProfileMembers(otherProfileId, {
    kind: "booking", refId: bookingId,
    title: "Booking request withdrawn",
    body: `${actingName} withdrew their booking request${gigTitle ? ` for "${gigTitle}"` : ""}.`,
  });

  return { ok: true };
});

// F5 (security audit wave, ruling: allow but exclude from trust metric):
// detects membership overlap between the two profiles on a booking, any
// uid that is a member of BOTH the curator profile AND the musician profile
// (e.g. a venue owner who is also a member of the musician profile
// performing there). Reads both profiles' `members` subcollections in full
// and intersects the uid sets, bounded by each profile's own member cap
// (mirrors syncCuratorAccess/reviewProfile's own "read a profile's members"
// idiom elsewhere in this codebase), cheaper and simpler than resolving
// which SPECIFIC uid to check membership for on the other side. Called
// OUTSIDE acceptBooking's own transaction, memberships are stable at
// accept time (nothing in this codebase changes membership as a side effect
// of a booking action), so a non-transactional read here carries no TOCTOU
// risk the way the booking/gig/series state itself does.
//
// EXPORTED (Task 9) for the same reason commitAcceptAfterCharge is: the sweep's
// accept-saga reconciliation completes the identical saga out of band and must
// stamp the identical `selfDeal` verdict, a second hand-rolled overlap check
// is how the callable's answer and the sweep's drift apart.
export async function detectSelfDeal(
  db: FirebaseFirestore.Firestore, curatorProfileId: string, musicianProfileId: string,
): Promise<boolean> {
  const [curatorMembersSnap, musicianMembersSnap] = await Promise.all([
    db.collection(`profiles/${curatorProfileId}/members`).get(),
    db.collection(`profiles/${musicianProfileId}/members`).get(),
  ]);
  const curatorUids = new Set(curatorMembersSnap.docs.map((d) => d.id));
  return musicianMembersSnap.docs.some((d) => curatorUids.has(d.id));
}

// Generic message for every reason a gig/run can be unavailable at accept
// time (gig closed underneath the negotiation, or, whole-run, the series
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
  // the rest of the fan-out, the already-committed accept transaction is
  // not undone by a notification/supersede failure here. Task 8's sweep
  // expiry step is the backstop for anything a failed iteration misses.
  try {
    const rival = doc.data() as BookingRequestDoc;
    // Optimistic precondition (a real one, not just a stale in-memory
    // check): `doc` came from a plain, non-transactional query snapshot
    // taken moments before this loop, a concurrent decline/withdraw/
    // counter on this same booking (or, benignly, this callable's own two
    // overlapping sibling queries returning the same doc, `seen` already
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
      kind: "booking", refId: doc.id,
      title: "Booking request no longer available",
      body: `Another act was booked for${rivalGigTitle ? ` "${rivalGigTitle}"` : " this gig"}.`,
    });
  } catch (e) {
    console.error(`acceptBooking: failed to supersede/notify sibling booking ${doc.id}`, e);
  }
}

function paymentRef(
  db: FirebaseFirestore.Firestore, bookingId: string, gigId: string,
): FirebaseFirestore.DocumentReference {
  return db.doc(`bookings/${bookingId}/payments/${gigId}`);
}

// Everything SP4's single accept transaction read and validated, factored out
// so the SP5 saga's TWO transactions (A: validate + stage the money; B:
// commit the accept once the charge landed) run the IDENTICAL set. That
// identity is the whole point: A's checks are what decide to take money, and
// B re-running them verbatim is what preserves SP4's race posture across the
// non-transactional Stripe call in between. Reads only, the caller does its
// own writes afterwards (Admin SDK transactions require all reads first).
//
// Deliberately does NOT check the caller's turn: only acceptBooking has a
// callerSide, and B also runs from the payment_intent.succeeded webhook and
// (Task 9) the sweep, neither of which has one. See commitAcceptAfterCharge
// for how B guards the terms instead.
interface AcceptValidation {
  freshBooking: BookingRequestDoc;
  gig: GigDoc;
  gigRef: FirebaseFirestore.DocumentReference;
  occurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[];  // whole-run only; [] for a single booking
  lastEntry: OfferEntry;
  acceptedTerms: AcceptedTerms;
  deposit: BookingDeposit;   // status "unpaid", the committing caller overrides it
}

async function readAndValidateAccept(
  tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore,
  bookingId: string, bookingRef: FirebaseFirestore.DocumentReference,
): Promise<AcceptValidation> {
  const freshSnap = await tx.get(bookingRef);
  if (!freshSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const freshBooking = freshSnap.data() as BookingRequestDoc;

  if (freshBooking.status !== "open") {
    throw new HttpsError("failed-precondition", `Cannot accept a booking in status "${freshBooking.status}".`);
  }

  const gigRef = db.doc(`gigs/${freshBooking.gigId}`);
  const gigSnap = await tx.get(gigRef);
  const gig = gigSnap.data() as GigDoc | undefined;
  // Defensive, mirrors counterBooking's identical rationale: a booking
  // always names an existing gig at creation time and nothing deletes gigs.
  if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");
  if (gig.status !== "open") throw new HttpsError("failed-precondition", GIG_UNAVAILABLE_MESSAGE);

  // F2 (security audit wave): refuse to accept once the gig has been
  // edited (updateGig) AFTER the thread's last offer, the terms about to
  // be frozen below may no longer match what the two sides actually
  // negotiated over. Most dangerous for perHour: amountCents (the rate)
  // never has to change for the accepted TOTAL to silently change, if
  // durationMinutes moved underneath the thread. Compared against the
  // LAST entry (not the first), a counter made AFTER the edit is a fresh
  // negotiation over the current gig and must not be blocked by an edit
  // that came before it.
  //
  // Edge case considered (and ruled out): publishGig bumps gig.updatedAt
  // at publish time, which is ALWAYS strictly before the first thread
  // entry's `at`, applyToGig/offerGig can only create a booking against
  // an already-"open" gig, so the publish write must have already
  // committed by the time either fires, and both timestamps are
  // server-side `Date.now()` calls in the same request-sequential flow.
  // No legitimate "accept the first offer right after publish" sequence
  // trips this. A theoretical multi-instance clock-skew trip is accepted
  // risk, the same tier as every other Date.now()-based window check in
  // this codebase; updateGig itself now separately refuses to edit a
  // FILLED/CLOSED gig (gigs.ts), so this guard's own exposure window is
  // bounded to the open negotiation period alone.
  const lastEntry = freshBooking.thread[freshBooking.thread.length - 1];
  if (gig.updatedAt > lastEntry.at) {
    throw new HttpsError("failed-precondition",
      "The gig was updated after the last offer. Review the gig and send a new offer.");
  }

  // Whole-run: re-read the series (must still be active) and every
  // currently-open occurrence of the run, bounded (series occurrences
  // never exceed the SERIES_MATERIALIZE_WEEKS-week materialize window),
  // so a transactional query here is safe. This query's results include
  // the initiating gig itself (it's checked open above, and it IS an
  // occurrence of its own series), so the write loop below is the single
  // place every occurrence, including the one this booking's thread was
  // actually about, gets filled; no separate write to `gigRef` is needed
  // in the whole-run branch.
  let occurrenceDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (freshBooking.seriesId) {
    const seriesRef = db.doc(`gigSeries/${freshBooking.seriesId}`);
    const seriesSnap = await tx.get(seriesRef);
    const series = seriesSnap.data() as GigSeriesDoc | undefined;
    if (!series || series.status !== "active") {
      throw new HttpsError("failed-precondition", GIG_UNAVAILABLE_MESSAGE);
    }
    // Task 7 carry-forward (a), the rebooking door: a cancelOccurrence-
    // reopened date on a still-active whole_run series can otherwise
    // accept a FRESH whole-run applyToGig/offerGig even while the series
    // is already linked to another confirmed run booking (applyToGig's
    // whole-run detection only checks fillMode+status, never
    // activeBookingId). Refuse here, a series names at most one confirmed
    // run booking at a time.
    if (series.activeBookingId != null && series.activeBookingId !== bookingId) {
      throw new HttpsError("failed-precondition", "This series is already booked.");
    }
    const occurrenceSnap = await tx.get(
      db.collection("gigs").where("seriesId", "==", freshBooking.seriesId).where("status", "==", "open"));
    occurrenceDocs = occurrenceSnap.docs;
  }

  // ---- Freeze terms from the LAST thread entry, whatever the two sides
  // most recently landed on, never the first offer. Whole-run: this doc's
  // acceptedTerms/deposit are computed from the INITIATING gig's
  // durationMinutes alone and represent ONE occurrence, an occurrence
  // that has since detached from the series template (updateGig) and
  // carries its own edited duration is NOT reflected here; SP5 stages a
  // per-occurrence payment doc priced from THAT occurrence's own duration
  // (see the staging loop in acceptBooking), and those docs, not this
  // run-level summary field, are the money truth. `lastEntry` is the same
  // value the F2 gig-edit guard above already computed. ----
  const expectedTotalCents = computeExpectedTotalCents(freshBooking.structure, lastEntry.amountCents, {
    durationMinutes: gig.durationMinutes, songCount: lastEntry.expectedQuantity ?? undefined,
  });
  // Tripwire (quality-review mandate): a forgotten/corrupted
  // durationMinutes or songCount must never silently produce a $0 deposit
  // obligation, fail loudly instead.
  if (expectedTotalCents <= 0) {
    throw new HttpsError("failed-precondition",
      "This booking's terms compute to a $0 total. Check the gig's duration/song count before accepting.");
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

  return { freshBooking, gig, gigRef, occurrenceDocs, lastEntry, acceptedTerms, deposit };
}

// Every occurrence this accept covers: the whole run's currently-open dates,
// or (single booking) just the one gig. Each carries its OWN durationMinutes
//, an occurrence detached from its series template with an edited duration
// is priced on its own duration, not the initiating gig's (sp4-rulings).
function collectOccurrences(v: AcceptValidation): StagedOccurrence[] {
  if (v.freshBooking.seriesId) {
    return v.occurrenceDocs.map((d) => {
      const g = d.data() as GigDoc;
      return { gigId: d.id, startsAt: g.startsAt, durationMinutes: g.durationMinutes };
    });
  }
  return [{ gigId: v.freshBooking.gigId, startsAt: v.gig.startsAt, durationMinutes: v.gig.durationMinutes }];
}

// What transaction B hands its caller. `filledGigIds`, `gigId`, `seriesId`
// and the two profile ids are what the post-commit fan-out (supersede +
// notifications + summary) needs so it never has to re-read the booking. The
// last two are DIAGNOSTICS, not fan-out inputs, the deposit_charged ledger
// row is written at charge time, not from these, but they are what a caller
// (or a test) reads to confirm the commit accounted for exactly the money it
// was told about.
export interface AcceptCommitResult {
  filledGigIds: string[];
  gigId: string; seriesId: string | null;
  curatorProfileId: string; musicianProfileId: string;
  depositTotalCents: number;      // Σ(slice + feeShare) marked held, always equals expectedChargeCents
  occurrenceCount: number;        // how many payment docs were marked held
}

// ---- Transaction B of the accept saga: commit the accept + mark deposits
// held. EXPORTED because three callers complete the same saga: acceptBooking
// (the normal path, right after its charge), the payment_intent.succeeded
// webhook (pending-charge recovery), and Task 9's sweep reconciliation.
//
// CONTRACT, read all four points before calling:
//
// 1. IT CAN THROW. `readAndValidateAccept`'s HttpsErrors (the gig closed, the
//    series paused, the F2 gig-edit guard, the $0 tripwire) surface as-is,
//    and so do transient Firestore/transaction errors. Every caller MUST
//    wrap the call, and must distinguish the two families, because the
//    first is permanent and the second is worth retrying (see the webhook
//    handler's catch for the canonical discrimination).
//
// 2. `null` means "THIS CALL DID NOT COMMIT", it does NOT mean "nothing
//    committed" and it does NOT mean "no money moved". A concurrent caller
//    (Task 9's sweep racing the callable, a redelivered webhook) may have
//    committed the very accept this call was trying to complete, which is
//    exactly why it found nothing left to do. A caller that responds to null
//    by refunding MUST first re-read the booking and confirm it is not
//    confirmed, refunding a committed accept's deposit is the worst
//    failure mode in this file.
//
// 3. It does NOT: fan out (supersede/notify), write the `deposit_charged`
//    ledger row, recompute paymentSummary, or refund anything. Those are the
//    caller's, deliberately, B is the transactional core and nothing
//    best-effort belongs inside a transaction.
//
// 4. Params:
//    - `intentId`/`chargeId` are stamped verbatim onto every deposit it
//      marks held. `chargeId` may be null (a webhook payload need not carry
//      latest_charge); `intentId` may be null ONLY when nothing was charged.
//    - `now` is used for every timestamp it writes (confirmedAt, chargedAt,
//      updatedAt), pass the saga's own `now` so A and B agree, or
//      Date.now() from an out-of-band caller.
//    - `isSelfDeal` is passed in rather than computed here: detectSelfDeal
//      reads two members subcollections and must not run inside a
//      transaction (memberships are stable at accept time, see its comment).
//    - `expectedChargeCents` is what the caller actually charged. B marks
//      held only the docs it can account for and returns null unless their
//      slices+fees sum EXACTLY to this, the charge and the escrow it
//      creates must never disagree, in either direction.
export async function commitAcceptAfterCharge(params: {
  bookingId: string; intentId: string | null; chargeId: string | null;
  now: number; isSelfDeal: boolean; expectedChargeCents: number;
}): Promise<AcceptCommitResult | null> {
  const { bookingId, intentId, chargeId, now, isSelfDeal, expectedChargeCents } = params;
  const db = getFirestore();
  const bookingRef = db.doc(`bookings/${bookingId}`);

  return db.runTransaction(async (tx) => {
    // ---- READS ----
    // Pre-check BEFORE readAndValidateAccept so "this booking already
    // committed / was never staged" returns null (a no-op) instead of
    // surfacing as readAndValidateAccept's "Cannot accept a booking in
    // status ..." throw. Same transaction, so this snapshot and the
    // validation below see one consistent world.
    const preSnap = await tx.get(bookingRef);
    const pre = preSnap.data() as BookingRequestDoc | undefined;
    if (!pre || pre.status !== "open" || pre.depositChargePending !== true) return null;

    const v = await readAndValidateAccept(tx, db, bookingId, bookingRef);
    const paymentsSnap = await tx.get(db.collection(`bookings/${bookingId}/payments`));

    // The set of payment docs this commit may mark held, scoped TWICE over:
    //  - status must still be "unpaid": an already-held/resolved doc belongs
    //    to some earlier money event and must never be re-stamped with this
    //    intent;
    //  - gigId must be in the occurrence set THIS transaction just collected.
    //    An unpaid doc outside it is a leftover from a failed unstage (or a
    //    date that left the run), and this intent did not pay for it,
    //    marking it held would invent money. Logged and left alone.
    //
    // The same loop re-derives each doc's baseCents from the CURRENT thread +
    // that occurrence's own duration and aborts on any divergence. That check
    // is both a money-integrity guard and the reason B can safely skip
    // acceptBooking's turn check: the charge was sized from the baseCents
    // staged in A, so if the terms moved underneath it in the charge window
    // (the accepting side countered itself from a second client, or an
    // occurrence's duration was edited), committing anyway would confirm
    // terms nobody paid for. Abort instead; the caller refunds.
    const occurrenceByGigId = new Map(collectOccurrences(v).map((o) => [o.gigId, o]));
    const stagedDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    // Occurrences this commit is allowed to FILL, the other direction of the
    // same intersection (see the fill loop below).
    const fundedGigIds = new Set<string>();
    let depositTotalCents = 0;
    for (const doc of paymentsSnap.docs) {
      const p = doc.data() as PaymentDoc;
      // Already held: paid for by an earlier intent (a partially-completed
      // saga). Not re-stamped, but its occurrence IS funded and may be filled.
      if (p.deposit.status === "held") { fundedGigIds.add(p.gigId); continue; }
      if (p.deposit.status !== "unpaid") continue;
      const occ = occurrenceByGigId.get(p.gigId);
      if (!occ) {
        console.error(
          `acceptCommit: unpaid payment doc ${bookingId}/${p.gigId} is outside this accept's occurrence set, leaving it untouched`);
        continue;
      }
      const expected = computeExpectedTotalCents(v.freshBooking.structure, v.lastEntry.amountCents, {
        durationMinutes: occ.durationMinutes, songCount: v.lastEntry.expectedQuantity ?? undefined,
      });
      if (expected !== p.baseCents) {
        console.error(
          `acceptCommit: staged base ${p.baseCents} no longer matches ${expected} for ${bookingId}/${p.gigId}, aborting`);
        return null;
      }
      stagedDocs.push(doc);
      fundedGigIds.add(p.gigId);
      depositTotalCents += p.deposit.sliceCents + p.deposit.feeShareCents;
    }

    // Charge accounting. The escrow this commit is about to create must equal
    // the money the caller actually took, exactly, in both directions. Short
    // means the curator paid for escrow that isn't being recorded; over means
    // deposits are being marked held that this charge never covered. Either
    // way the only safe move is not to commit: the caller refunds in full and
    // the booking stays open.
    if (depositTotalCents !== expectedChargeCents) {
      console.error(
        `acceptCommit: staged deposits total ${depositTotalCents} but ${expectedChargeCents} was charged for ${bookingId}, aborting`);
      return null;
    }

    // Fill ONLY funded occurrences, the second direction of the
    // intersection. An occurrence in this transaction's re-collected set with
    // NO payment doc was born open by the materializer during the A-to-B
    // window; nothing was charged for it, so filling it would create a
    // confirmed date with no money behind it and no deposit to settle.
    //
    // Leaving it open ABANDONS it, and that is the honest description: the
    // materializer will not revisit an occurrence it has already
    // materialized (its watermark is past that date), and no one else can
    // book it either, a fresh whole-run accept is refused by the
    // series-already-booked guard once activeBookingId is stamped below. It
    // simply sits open until the daily sweep closes it after its start time.
    // Recovering it needs Task 9 (reconciliation, or a per-birth deposit
    // adoption path for occurrences that appear on an already-booked run).
    // Hence the seriesId in the log line: that is the handle reconciliation
    // has to find it by.
    //
    // Computed HERE, before any write: a Firestore transaction commits
    // everything queued on it once the callback returns, so a bail-out AFTER
    // tx.update would still persist those writes.
    const occurrenceDocsToFill = v.freshBooking.seriesId
      ? v.occurrenceDocs.filter((doc) => {
        if (fundedGigIds.has(doc.id)) return true;
        console.error(
          `acceptCommit: occurrence ${doc.id} of series ${v.freshBooking.seriesId} (booking ${bookingId}) has no staged deposit, abandoned open, needs reconciliation`);
        return false;
      })
      : [];
    // Nothing fillable means nothing to confirm: confirming a booking whose
    // gigs all stay open would be a booking that exists for no date. Applies
    // to both shapes, a single booking whose one gig is unfunded, and a run
    // where every re-collected occurrence turned out to be unfunded.
    const fillableCount = v.freshBooking.seriesId
      ? occurrenceDocsToFill.length
      : (fundedGigIds.has(v.freshBooking.gigId) ? 1 : 0);
    if (fillableCount === 0) {
      console.error(`acceptCommit: ${bookingId} has no funded occurrence to fill, aborting`);
      return null;
    }

    // ---- WRITES ----
    // F5: `selfDeal` is only ever included (true) when overlap was detected
    //, never written as an explicit `false`, so a normal booking's doc
    // shape is unchanged (the field simply stays absent, exactly like every
    // pre-F5 booking).
    for (const doc of stagedDocs) {
      tx.update(doc.ref, {
        "deposit.status": "held", "deposit.intentId": intentId, "deposit.chargeId": chargeId,
        // SP10 Task 3: the amount of the CHARGE (the whole accept batch, shared
        // by every doc it paid for), not this doc's slice. finalizeSettlementSuccess
        // decides whether a transfer fits inside it.
        ...(intentId ? { "deposit.chargeAmountCents": expectedChargeCents } : {}),
        "deposit.chargedAt": now, updatedAt: now,
      });
    }
    tx.update(bookingRef, {
      status: "confirmed", confirmedAt: now, updatedAt: now,
      acceptedTerms: v.acceptedTerms,
      // The run-level deposit stays SP4's one-occurrence summary; only its
      // status moves to "held", and only when money actually moved.
      // Defensive: an accept with nothing staged charges nothing, so "unpaid"
      // (SP4's own value) stays the truth rather than claiming a held
      // deposit that doesn't exist. Not reachable in normal flow, every
      // accept fills at least the initiating gig, and every filled
      // occurrence is staged.
      deposit: { ...v.deposit, status: stagedDocs.length > 0 ? "held" : "unpaid" },
      ...(isSelfDeal ? { selfDeal: true } : {}),
      depositChargePending: false, depositChargeIntentId: null,
    });

    // The funded set decided above, every abandoned occurrence was already
    // filtered out and logged there.
    const filledGigIds: string[] = [];
    if (v.freshBooking.seriesId) {
      for (const doc of occurrenceDocsToFill) {
        tx.update(doc.ref, {
          status: "filled", bookingId, bookedMusicianProfileId: v.freshBooking.musicianProfileId, updatedAt: now,
        });
        filledGigIds.push(doc.id);
      }
      tx.update(db.doc(`gigSeries/${v.freshBooking.seriesId}`), {
        activeBookingId: bookingId, bookedMusicianProfileId: v.freshBooking.musicianProfileId, updatedAt: now,
      });
    } else {
      // Funding already asserted above, before the first write.
      tx.update(v.gigRef, {
        status: "filled", bookingId, bookedMusicianProfileId: v.freshBooking.musicianProfileId, updatedAt: now,
      });
      filledGigIds.push(v.freshBooking.gigId);
    }

    return {
      filledGigIds, gigId: v.freshBooking.gigId, seriesId: v.freshBooking.seriesId,
      curatorProfileId: v.freshBooking.curatorProfileId, musicianProfileId: v.freshBooking.musicianProfileId,
      depositTotalCents, occurrenceCount: stagedDocs.length,
    };
  });
}

// Clears the saga marker, and ONLY when clearing it is still the right thing
// to do. Two hazards this guards against:
//  - A racer (Task 9's sweep, a webhook delivery) may have committed the
//    accept between the unstage decision and this write. Clearing the marker
//    off a booking that is mid- or post-commit would strip the one field
//    reconciliation keys off. So: re-read, bail unless the booking is still
//    open-and-pending, and write under a `lastUpdateTime` precondition taken
//    from that very read, so a commit landing in the microseconds between
//    makes this write FAIL rather than clobber.
//  - The write is the last step of every failure path, so losing it to one
//    transient error strands the booking. Bounded retry (3 attempts, short
//    backoff): a precondition failure re-reads and usually then bails
//    cleanly, a transient error gets another go, and a final failure is
//    logged loudly for reconciliation rather than swallowed.
const MARKER_CLEAR_ATTEMPTS = 3;

async function clearStagedMarker(db: FirebaseFirestore.Firestore, bookingId: string): Promise<void> {
  const ref = db.doc(`bookings/${bookingId}`);
  for (let attempt = 1; attempt <= MARKER_CLEAR_ATTEMPTS; attempt++) {
    try {
      const snap = await ref.get();
      const b = snap.data() as BookingRequestDoc | undefined;
      if (!b) return;
      if (b.status !== "open" || b.depositChargePending !== true) return;  // already resolved by someone else
      await ref.update(
        { depositChargePending: false, depositChargeIntentId: null, updatedAt: Date.now() },
        { lastUpdateTime: snap.updateTime });
      return;
    } catch (e) {
      if (attempt === MARKER_CLEAR_ATTEMPTS) {
        console.error(
          `acceptUnstage: could not clear the staged marker on ${bookingId} after ${attempt} attempts, left for reconciliation`, e);
        return;
      }
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

// Best-effort undo of transaction A's staging, for every path that decided
// NOT to (or could not) complete the accept: a declined card, an aborted
// transaction B, an unexpected Stripe failure. Leaves the booking `open` with
// no pending marker, so a retry is a clean fresh attempt (with a bumped
// attempt counter ⇒ a fresh idempotency key ⇒ a real second charge attempt,
// not a replayed decline).
//
// `feePolicy` and `depositChargeAttempt` are deliberately LEFT on the booking:
// the fee snapshot is the same one a retry would write, and the attempt
// counter must only ever go up, resetting it would let a retry reuse a
// consumed (and possibly decline-cached) idempotency key.
//
// Each delete is guarded on the doc still being `unpaid`: the caller reaches
// here only when nothing was committed, but a delete is destructive and a
// HELD payment doc is real money, never remove one on a cleanup path.
// NOT called on the pending-charge path (see DEPOSIT_PROCESSING_MESSAGE):
// there the staged docs must survive for the webhook to finalize.
//
// `chargeOutstanding` says whether money may still be sitting on the
// curator's card unaccounted for, and it decides what happens when the doc
// cleanup comes up short:
//   false, nothing was charged (a declined card). A leftover `unpaid` doc is
//     harmless: transaction A's tx.set overwrites it on the next attempt. A
//     stuck marker is NOT harmless, it blocks every future accept on this
//     booking until a sweep intervenes. So always release the marker.
//   true, a charge may be outstanding (an abort after a successful charge,
//     or any charge error we can't classify). Here an incomplete cleanup is
//     a real signal: a doc that is no longer `unpaid` means a racer is
//     mid-commit, possibly against money we just refunded. Hold the marker so
//     the booking stays visible to reconciliation.
//
// EXPORTED (Task 9): the sweep's reconciliation hits the same DECLINE branch
// acceptBooking does, a declined replay moved no money, so the staged docs
// must go and the marker must be released, and that is exactly this
// function, not a hand-rolled three-step copy of it.
//
// `occurrences` is typed `{ gigId }[]`, not StagedOccurrence[]: only the gig
// id is ever read (each doc is re-read from its own path before deletion), and
// the sweep reconstructs its list from PAYMENT DOCS, which carry no
// durationMinutes. Narrowing the parameter is what stops a caller from having
// to fabricate a fake duration just to satisfy the type.
//
// STRUCTURAL INVARIANT THIS RELIES ON, shared with releaseStuckSaga: a STAGED
// doc never carries `deposit.depositAttempts`. Only the sweep's birth-deposit
// charge writes that field (persist-before-charge), and it never touches a
// staged set (rule 3). Two things depend on it, a staged doc is invisible to
// clearDelinquencyIfSettled's exhausted-deposit query (Firestore indexes only
// documents that HAVE the field), so an in-flight accept can never look like a
// debt and gate the curator; and deleting one here therefore extinguishes no
// obligation, which is why this function has no delinquency-lift call.
export async function unstageAccept(
  db: FirebaseFirestore.Firestore, bookingId: string, occurrences: { gigId: string }[],
  chargeOutstanding: boolean,
): Promise<void> {
  let fullyUnstaged = true;
  for (const occ of occurrences) {
    try {
      const ref = paymentRef(db, bookingId, occ.gigId);
      const snap = await ref.get();
      const p = snap.data() as PaymentDoc | undefined;
      if (!p) continue;
      if (p.deposit.status !== "unpaid") {
        console.error(`acceptUnstage: refusing to delete ${bookingId}/${occ.gigId} in deposit status ${p.deposit.status}`);
        fullyUnstaged = false;
        continue;
      }
      await ref.delete();
    } catch (e) {
      console.error(`acceptUnstage: failed to remove staged payment doc ${bookingId}/${occ.gigId}`, e);
      fullyUnstaged = false;
    }
  }
  // Marker LAST. Holding it back on an incomplete cleanup is only correct
  // when a charge might be outstanding, see the param's doc above.
  if (!fullyUnstaged && chargeOutstanding) {
    console.error(`acceptUnstage: ${bookingId} was not fully unstaged, leaving the saga marker set for reconciliation`);
    return;
  }
  if (!fullyUnstaged) {
    console.error(`acceptUnstage: ${bookingId} was not fully unstaged, but nothing was charged, releasing the marker anyway`);
  }
  await clearStagedMarker(db, bookingId);
}

// ---- The abort routine: a charge landed but transaction B did not commit.
// EXPORTED for the same reason commitAcceptAfterCharge is, Task 9's
// reconciliation has to perform exactly this sequence when it finds a staged
// booking whose commit can never succeed, and a second hand-rolled copy of
// "refund, record it, unstage" is how the two drift apart.
//
// Refund FIRST, unstage only if it worked: a failed refund means the curator
// is still charged, so the saga marker, the staged docs and the persisted
// attempt must all survive for reconciliation, which converges without any
// new money moving, since the same attempt-scoped charge key replays the
// already-succeeded intent and the refund retries under its own key. Clearing
// the marker there would strand the charge with nothing pointing at it.
//
// CALLER BEWARE: this refunds unconditionally when given an intentId. Only
// call it once you know THIS attempt's accept did not commit, see
// commitAcceptAfterCharge contract point 2, because refunding a committed
// accept's deposit is the worst failure mode in this file.
export async function abortAcceptAfterFailedCommit(params: {
  bookingId: string; intentId: string | null; attempt: number; amountCents: number;
  // `{ gigId }[]`, not StagedOccurrence[], see unstageAccept, which is the
  // only consumer of this list and reads nothing else off it.
  occurrences: { gigId: string }[]; curatorProfileId: string;
}): Promise<{ refunded: boolean }> {
  const { bookingId, intentId, attempt, amountCents, occurrences, curatorProfileId } = params;
  const db = getFirestore();

  let refunded = true;
  if (intentId) {
    refunded = false;
    try {
      const r = await getStripe().refund({
        intentId, amountCents,
        idempotencyKey: `${bookingId}:accept:refund:${attempt}`,
        meta: { bookingId, purpose: "accept_abort" },
      });
      refunded = true;
      await writeLedger({
        kind: "refund", amountCents, bookingId, gigId: null, profileId: curatorProfileId, stripeId: r.id,
        detail: "accept abort, booking no longer confirmable",
      }).catch((le) => console.error(`acceptAbort: refund ledger row failed for ${bookingId}`, le));
    } catch (re) {
      console.error(
        `acceptAbort: refund failed for ${bookingId} (intent ${intentId}, attempt ${attempt}), leaving the saga staged for reconciliation`, re);
    }
  }
  if (refunded) await unstageAccept(db, bookingId, occurrences, true);
  return { refunded };
}

// ---- POST-COMMIT TAIL (deliberately outside any transaction) ----
// Shared by acceptBooking, the payment_intent.succeeded recovery path and
// (Task 9) the sweep's saga reconciliation, so an out-of-band-completed accept
// fans out exactly like a callable-completed one, EXPORTED for that third
// caller.
// Every step is best-effort and failure-isolated: the accept and its charge
// have already committed by the time this runs, so nothing here may surface
// as a failure to whoever is waiting.
// The `deposit_charged` ledger row is deliberately NOT written here: it
// records the CHARGE, so it is written the moment the charge succeeds (before
// transaction B), not after a commit that might never happen. See
// acceptBooking's charge block and the webhook handler.
export async function runAcceptPostCommit(
  db: FirebaseFirestore.Firestore, bookingId: string, commit: AcceptCommitResult, now: number,
): Promise<void> {
  try {
    await recomputePaymentSummary(bookingId);
  } catch (e) {
    console.error(`acceptPostCommit: paymentSummary recompute failed for ${bookingId}`, e);
  }

  // Sibling supersede: every other OPEN booking naming any gig this accept
  // just filled, UNION (whole-run only) every open booking naming the run's
  // series directly, the latter is a second, overlapping net in case a
  // rival whole-run applicant's own gigId isn't among `filledGigIds` for
  // some edge-case reason. `seen` dedupes across both queries (and excludes
  // the winner itself, whose status is no longer "open" anyway) so a
  // booking matching both is only processed once. Idempotent +
  // failure-isolated (see supersedeSiblingBooking), Task 8's sweep expiry
  // step is the backstop for anything missed here.
  const seen = new Set<string>([bookingId]);
  const siblingQueries = commit.filledGigIds.map((gid) =>
    db.collection("bookings").where("gigId", "==", gid).where("status", "==", "open"));
  if (commit.seriesId) {
    siblingQueries.push(
      db.collection("bookings").where("seriesId", "==", commit.seriesId).where("status", "==", "open"));
  }
  for (const q of siblingQueries) {
    // Per-QUERY isolation, on top of supersedeSiblingBooking's own per-doc
    // isolation: without this, a failing sibling query (a missing index, a
    // transient read error) would escape a function whose contract is that
    // nothing here can surface to the caller, and would skip the winner
    // notifications below too.
    try {
      const snap = await q.get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        await supersedeSiblingBooking(db, doc, now);
      }
    } catch (e) {
      console.error(`acceptPostCommit: sibling supersede query failed for ${bookingId}`, e);
    }
  }

  // Winners, both sides. Unlike decline/withdrawBooking's equivalent
  // (unwrapped) tail, this one is wrapped: the accept has already committed
  // by this point, so a failure in this best-effort notification tail, a
  // transient read/write error, nothing more, must never surface as an
  // error to the caller. An apparent failure here would look like the accept
  // itself failed and invite a confusing retry (which would then hit its own
  // failed-precondition, since the booking is no longer "open") even though
  // the gig is already correctly filled, and, now, already charged.
  try {
    const gigSnap = await db.doc(`gigs/${commit.gigId}`).get();
    const gigTitle = (gigSnap.data() as GigDoc | undefined)?.title;
    const musicianName = await profileName(db, commit.musicianProfileId);
    const curatorName = await profileName(db, commit.curatorProfileId);
    await notifyProfileMembers(commit.curatorProfileId, {
      kind: "booking", refId: bookingId,
      title: `Booking confirmed${gigTitle ? ` for "${gigTitle}"` : ""}`,
      body: `${musicianName} is booked and confirmed.`,
    });
    await notifyProfileMembers(commit.musicianProfileId, {
      kind: "booking", refId: bookingId,
      title: `Booking confirmed${gigTitle ? ` for "${gigTitle}"` : ""}`,
      body: `You're booked and confirmed with ${curatorName}.`,
    });
  } catch (e) {
    console.error(`acceptPostCommit: failed to notify winners for booking ${bookingId}`, e);
  }
}

// Remaps the two curator-gate messages for a MUSICIAN-side caller: they're
// curator-authored, second-person copy ("Save a payment card...") that the
// musician side cannot act on. A curator-side caller keeps the specific
// message, it names exactly what they need to fix.
function curatorGateError(callerSide: BookingSide, message: string): HttpsError {
  return new HttpsError("failed-precondition",
    callerSide === "musician" ? BOOKING_NOT_CONFIRMABLE_MESSAGE : message);
}

export const acceptBooking = onCall<{ bookingId: string }>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { bookingId } = req.data ?? ({} as { bookingId: string });
    if (!isValidDocId(bookingId)) throw new HttpsError("invalid-argument", "A booking id is required.");

    const db = getFirestore();
    const bookingRef = db.doc(`bookings/${bookingId}`);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnap.data() as BookingRequestDoc;

    // Membership resolved once, outside the transaction, see requireBookingSide.
    const callerSide = await requireBookingSide(booking, uid);

    // F5: computed once, outside the transaction, see detectSelfDeal's own
    // comment on why memberships are stable enough for this to be safe here.
    // Also why it's computed HERE and passed into transaction B rather than
    // recomputed inside it: two members-subcollection reads must not run
    // inside a Firestore transaction.
    const isSelfDeal = await detectSelfDeal(db, booking.curatorProfileId, booking.musicianProfileId);

    // Task 5 money gates, FAST-FAIL half: either side accepting lands the
    // deposit charge on the CURATOR's card, so the curator profile is always
    // checked regardless of which side is calling, same for the musician's
    // own payout-readiness (applyToGig already checked it once; re-checked
    // here in case it lapsed between apply and accept).
    //
    // This pair exists for its FRIENDLY MESSAGES, not for safety:
    // profiles/*/private/stripe is mutable in the window between here and
    // the charge (Task 11's sweep flips `delinquent` asynchronously), so
    // transaction A below re-asserts both gates transactionally and takes
    // the charge's customerId from THAT snapshot. See the audience note on
    // curatorGateError for the musician-side message remap.
    try {
      await requireCuratorChargeable(booking.curatorProfileId);
    } catch (e) {
      if (e instanceof HttpsError
          && (e.message === CURATOR_CARD_REQUIRED_MESSAGE || e.message === CURATOR_DELINQUENT_MESSAGE)) {
        throw curatorGateError(callerSide, e.message);
      }
      throw e;
    }
    await requireMusicianPayoutReady(booking.musicianProfileId);

    const now = Date.now();
    const feePolicy = currentFeePolicy();

    // ================= Transaction A: validate + stage the money =========
    // Everything that decides whether the fill can happen, the booking's
    // own turn/status/thread, the gig's live status, and (whole-run) the
    // series' live status plus EVERY currently-open occurrence of the run,
    // is read inside ONE transaction, together with the money gates. The
    // ONLY writes are the staged payment docs and the saga marker: nothing
    // is confirmed and no gig is filled until the charge lands.
    const staged = await db.runTransaction(async (tx) => {
      // ---- READS (all of them, before any write, Admin SDK transaction rule) ----
      const v = await readAndValidateAccept(tx, db, bookingId, bookingRef);
      if (callerSide !== v.freshBooking.awaitingSide) {
        throw new HttpsError("failed-precondition", "It isn't your side's turn on this booking.");
      }
      // An accept already in flight for this booking. NEVER re-stage +
      // re-charge on a fresh attempt key here: the outstanding attempt's
      // intent can still succeed (that's exactly what the pending path is
      // waiting for), so a second charge would be a real double charge.
      if (v.freshBooking.depositChargePending === true) {
        throw new HttpsError("failed-precondition",
          v.freshBooking.depositChargeIntentId ? DEPOSIT_PROCESSING_MESSAGE : DEPOSIT_RECONCILING_MESSAGE);
      }

      // SP5 (Task 5 review #2): re-assert BOTH money gates transactionally.
      // The outer requireCuratorChargeable/requireMusicianPayoutReady calls
      // above are only the friendly-message fast-fail; private/stripe is
      // MUTABLE in the gate-to-commit window. Card VALIDITY is self-enforcing
      // at charge time (Stripe resolves the live default payment method), but
      // `delinquent`/`transfersEnabled` are GateKeep-only flags no charge can
      // enforce, so they must be read in the same transaction that stages
      // the money, and the charge below must use the customerId FROM THIS
      // SNAPSHOT rather than the outer read's.
      const [curatorStripeSnap, musicianStripeSnap] = await tx.getAll(
        db.doc(`profiles/${v.freshBooking.curatorProfileId}/private/stripe`),
        db.doc(`profiles/${v.freshBooking.musicianProfileId}/private/stripe`));
      const curatorStripe = curatorStripeSnap.data() as StripeProfileDoc | undefined;
      const musicianStripe = musicianStripeSnap.data() as StripeProfileDoc | undefined;
      // Fail CLOSED on partial docs, and check the card fields FIRST, see
      // requireCuratorChargeable's copy hazard note: the `delinquent === true`
      // test alone sails through a doc missing the field entirely.
      if (!curatorStripe?.customerId || !curatorStripe.defaultPaymentMethodId) {
        throw curatorGateError(callerSide, CURATOR_CARD_REQUIRED_MESSAGE);
      }
      if (curatorStripe.delinquent === true) throw curatorGateError(callerSide, CURATOR_DELINQUENT_MESSAGE);
      if (!musicianStripe?.accountId || musicianStripe.transfersEnabled !== true) {
        throw new HttpsError("failed-precondition", MUSICIAN_PAYOUTS_REQUIRED_MESSAGE);
      }

      // ---- WRITES (the only ones in A) ----
      // EVERY occurrence this accept fills gets a payment doc, past-dated
      // ones included. An already-started date can legitimately reach accept
      // (the daily sweep that closes past gigs runs at most once a day, so
      // there's a lag of up to ~24h) and its show still happens, leaving it
      // without a payment doc would mean it never settles and the musician
      // is never paid for it. A past occurrence's deposit simply applies
      // toward its settlement like any other.
      const occurrences = collectOccurrences(v);
      let totalChargeCents = 0;
      for (const occ of occurrences) {
        const doc = buildPaymentDoc({
          booking: v.freshBooking, bookingId, occ,
          amountCents: v.lastEntry.amountCents, expectedQuantity: v.lastEntry.expectedQuantity,
          structure: v.freshBooking.structure, feePolicy, selfDeal: isSelfDeal, now,
        });
        // Unconditional set (not create), and it may legitimately overwrite:
        // a previous attempt's docs survive a failed unstage. Safe because of
        // a saga invariant, a booking only reaches this line while `open`,
        // and unstageAccept never clears the marker unless every staged doc
        // was `unpaid` and actually deleted, so a booking that is back to
        // open-and-not-pending can only have unpaid leftovers here. A HELD
        // doc can therefore never be overwritten by this line; transaction B
        // additionally refuses to re-stamp anything that isn't `unpaid`.
        tx.set(paymentRef(db, bookingId, occ.gigId), doc);
        totalChargeCents += doc.deposit.sliceCents + doc.deposit.feeShareCents;
      }
      // Attempt-scoped charge key (as-built contract #2): both real Stripe
      // and FakeStripe CACHE a decline under its idempotency key, so a retry
      // after a decline must carry a different key or it replays the decline
      // forever. Persisted (not derived) so Task 9's crash reconciliation can
      // reuse the SAME attempt, same key, same intent, never a second charge.
      const attempt = (v.freshBooking.depositChargeAttempt ?? 0) + 1;
      tx.update(bookingRef, {
        depositChargePending: true, depositChargeAttempt: attempt, depositChargeIntentId: null,
        feePolicy, updatedAt: now,
      });

      return {
        occurrences, totalChargeCents, attempt,
        curatorCustomerId: curatorStripe.customerId,
      };
    });

    // ================= The charge (NEVER inside a transaction) ============
    // ONE off-session PaymentIntent for the whole batch: Σ(slice + feeShare)
    // over every staged occurrence.
    let intentId: string | null = null;
    let chargeId: string | null = null;
    if (staged.totalChargeCents > 0) {
      try {
        const r = await getStripe().chargeOffSession({
          customerId: staged.curatorCustomerId, amountCents: staged.totalChargeCents,
          idempotencyKey: `${bookingId}:accept:deposit:${staged.attempt}`,
          meta: { bookingId, purpose: "deposit" },
        });
        intentId = r.id;
        chargeId = r.chargeId;
        // Ledger row for the CHARGE, written the moment it succeeds, before
        // transaction B, not after. The row records that money left the
        // curator's card, which is true regardless of whether the accept goes
        // on to commit; deferring it to the post-commit tail would lose the
        // audit trail for exactly the charges that then had to be refunded.
        // Best-effort (a lost row is an audit gap, never a money bug) and
        // idempotent via writeLedger's deterministic {kind}:{stripeId} id.
        await writeLedger({
          kind: "deposit_charged", amountCents: staged.totalChargeCents,
          bookingId, gigId: null, profileId: booking.curatorProfileId, stripeId: intentId,
          detail: `deposit batch (${staged.occurrences.length} occurrence(s))`,
        }).catch((le) => console.error(`acceptBooking: deposit_charged ledger row failed for ${bookingId}`, le));
      } catch (e) {
        if (e instanceof StripePaymentPendingError) {
          // NOT a failure and NOT unstaged: the intent exists and is still
          // settling. Record its id, leave depositChargePending + the staged
          // docs in place, and let payment_intent.succeeded finish the accept.
          // A same-key retry is impossible here (the cached `processing`
          // outcome replays forever), which is why transaction A refuses a
          // fresh attempt while depositChargeIntentId is set.
          await bookingRef.update({ depositChargeIntentId: e.intentId, updatedAt: Date.now() })
            .catch((we) => console.error(`acceptBooking: failed to record pending intent ${e.intentId} on ${bookingId}`, we));
          throw new HttpsError("failed-precondition", DEPOSIT_PROCESSING_MESSAGE);
        }
        // A DECLINE moved no money, so the marker must come off even if a
        // staged doc delete failed, see unstageAccept's `chargeOutstanding`.
        // Any other error is unclassifiable (the charge may well have gone
        // through before the failure), so it holds the marker like an abort.
        await unstageAccept(db, bookingId, staged.occurrences, !(e instanceof StripeCardDeclinedError));
        if (e instanceof StripeCardDeclinedError) {
          throw new HttpsError("failed-precondition", CARD_DECLINED_MESSAGE);
        }
        throw e;
      }
    }

    // ================= Transaction B: commit the accept ==================
    let commit: AcceptCommitResult | null = null;
    let commitError: unknown = null;
    try {
      commit = await commitAcceptAfterCharge({
        bookingId, intentId, chargeId, now, isSelfDeal, expectedChargeCents: staged.totalChargeCents,
      });
    } catch (e) {
      commitError = e;
    }
    if (!commit) {
      // B did not commit AFTER a successful charge, either it threw, or the
      // world moved under the charge (returned null). Give the money back
      // before surfacing anything: the accept did not happen, so the curator
      // must not be left paying for it.
      //
      // Safe to refund unconditionally on THIS path (unlike an out-of-band
      // caller, which must re-read first, see abortAcceptAfterFailedCommit's
      // caller-beware note): this request owns the attempt whose charge it is
      // refunding, and a racer that committed would have had to consume the
      // very staged docs B just found missing.
      const { refunded } = await abortAcceptAfterFailedCommit({
        bookingId, intentId, attempt: staged.attempt, amountCents: staged.totalChargeCents,
        occurrences: staged.occurrences, curatorProfileId: booking.curatorProfileId,
      });
      // Tell the caller the money came back, but ONLY when it actually did.
      // Otherwise surface the underlying reason unchanged: a "we refunded
      // you" message on a failed refund would be a lie about money.
      if (intentId && refunded) {
        if (commitError) {
          console.error(`acceptBooking: transaction B failed for ${bookingId} after a refunded charge`, commitError);
        }
        throw new HttpsError("aborted", ACCEPT_ABORTED_REFUNDED_MESSAGE);
      }
      if (commitError) throw commitError;
      throw new HttpsError("aborted", GIG_UNAVAILABLE_MESSAGE);
    }

    await runAcceptPostCommit(db, bookingId, commit, now);
    return { ok: true };
  });

// ---- payment_intent.succeeded, purpose "deposit" (as-built contract #7) ----
// The out-of-band half of the pending-charge path: acceptBooking left the
// booking staged (`depositChargePending` + `depositChargeIntentId`) when its
// intent came back `processing`; when Stripe finally confirms the charge,
// this completes the very same transaction B and post-commit tail the
// callable would have run.
//
// Idempotent by construction: the commit's own guard no-ops once the booking
// is no longer open-and-pending, so a redelivered event (or one racing Task
// 9's sweep) changes nothing. Registered in bookings.ts, not payments.ts,
// because that's where the saga lives; the purpose-keyed registry keeps Task
// 10's "settlement" and Task 11's "paydue" branches purely additive.
paymentIntentSucceededHandlers["deposit"] = async (object) => {
  const intentId = object.id as string | undefined;
  const bookingId = (object.metadata as Record<string, string> | undefined)?.bookingId;
  // Event payloads are signature-verified but never shape-validated, so
  // metadata is untrusted input, validate before building a doc path from it
  // (mirrors account.updated's identical guard in payments.ts).
  if (!intentId || !bookingId || !isValidDocId(bookingId)) {
    console.warn(`payment_intent.succeeded (deposit): unusable metadata, intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}`);
    return;
  }

  const db = getFirestore();
  const snap = await db.doc(`bookings/${bookingId}`).get();
  const booking = snap.data() as BookingRequestDoc | undefined;
  if (!booking) return;
  // No accept in flight: this event is a redelivery for an accept that
  // already committed (or one that was unstaged). Nothing for THIS handler to
  // do, and nothing is left dangling if the original run's best-effort tail
  // didn't finish, because every part of it has its own backstop:
  // paymentSummary self-heals on the next payment tick (it recomputes from
  // the payment docs, never from a delta), Task 8's sweep expiry step
  // supersedes any sibling the fan-out missed, and the winner notifications
  // are best-effort by design. Re-running the tail here would risk
  // duplicating notifications for no gain.
  if (booking.depositChargePending !== true) return;
  // An accept IS in flight, but on a DIFFERENT intent, and THIS intent just
  // succeeded. That means two live charges exist for one booking: the one the
  // booking is waiting on, and this one, which nothing will ever consume.
  // Not silently ignorable; it's precisely the stuck-money signal Task 9's
  // reconciliation (and an operator) needs.
  if (booking.depositChargeIntentId !== intentId) {
    console.error(
      `payment_intent.succeeded (deposit): ${bookingId} is awaiting intent ${String(booking.depositChargeIntentId)} but ${intentId} succeeded, unconsumed charge, needs reconciliation`);
    return;
  }

  const isSelfDeal = await detectSelfDeal(db, booking.curatorProfileId, booking.musicianProfileId);
  const now = Date.now();
  // latest_charge is present on a real payment_intent.succeeded payload; a
  // deposit finalized without one simply carries a null chargeId (DepositState
  // documents that, and the transfers that want it treat it as optional).
  const chargeId = typeof object.latest_charge === "string" ? object.latest_charge : null;

  // What this intent actually charged. Prefer the EVENT's own amount, that
  // is Stripe's word on the money, and the whole point of the accounting
  // check is to catch a staged set that has drifted from it. Only when the
  // payload carries no amount (a hand-rolled emulator event) fall back to
  // summing the staged docs, which still catches a set that changes between
  // this read and the transaction.
  let expectedChargeCents: number | null =
    typeof object.amount_received === "number" ? object.amount_received
      : typeof object.amount === "number" ? object.amount
        : null;
  if (expectedChargeCents == null) {
    const staged = await db.collection(`bookings/${bookingId}/payments`).get();
    expectedChargeCents = staged.docs.reduce((sum, d) => {
      const p = d.data() as PaymentDoc;
      return p.deposit.status === "unpaid" ? sum + p.deposit.sliceCents + p.deposit.feeShareCents : sum;
    }, 0);
  }

  // Ledger row for the charge, written before the commit for the same reason
  // acceptBooking writes its own there: the money moved, whether or not the
  // accept goes on to commit. Idempotent via the deterministic id, so the
  // callable and this handler can never double-count the same intent.
  await writeLedger({
    kind: "deposit_charged", amountCents: expectedChargeCents,
    bookingId, gigId: null, profileId: booking.curatorProfileId, stripeId: intentId,
    detail: "deposit batch (pending charge confirmed by webhook)",
  }).catch((le) => console.error(`payment_intent.succeeded (deposit): ledger row failed for ${bookingId}`, le));

  let commit: AcceptCommitResult | null;
  try {
    commit = await commitAcceptAfterCharge({
      bookingId, intentId, chargeId, now, isSelfDeal, expectedChargeCents,
    });
  } catch (e) {
    // Discriminate, because the two failure families want opposite handling:
    //  - HttpsError is the PERMANENT validation family (the gig closed, the
    //    series moved, the F2 gig-edit guard, the $0 tripwire). No later
    //    delivery of this event can resolve it, so swallow it: returning
    //    normally lets the webhook mark the event processed, whereas letting
    //    it escape would 500 and Stripe would retry it forever.
    //  - Anything else is transient (a Firestore contention/abort, an infra
    //    error). RETHROW it so the claim machine records failedAt and the
    //    very next delivery re-claims and retries.
    // The booking keeps its pending marker on both paths, which is exactly
    // the signal Task 9's reconciliation looks for.
    if (!(e instanceof HttpsError)) {
      console.error(
        `payment_intent.succeeded (deposit): transient commit failure for ${bookingId} (intent ${intentId}), retrying on redelivery`, e);
      throw e;
    }
    console.error(
      `payment_intent.succeeded (deposit): commit permanently rejected for ${bookingId} (intent ${intentId}), left staged for reconciliation`, e);
    return;
  }
  if (!commit) {
    // Charged, but the accept can no longer be committed (the gig/series
    // moved while the intent settled, or the staged set no longer accounts
    // for the charge). Deliberately NOT auto-refunded from a webhook, a
    // racer may have committed this very accept (see commitAcceptAfterCharge
    // contract point 2), and Task 9's reconciliation owns stuck money. This
    // log is the signal for it, and for an operator.
    console.error(`payment_intent.succeeded (deposit): could not commit accept for ${bookingId} (intent ${intentId})`);
    return;
  }
  await runAcceptPostCommit(db, bookingId, commit, now);
};

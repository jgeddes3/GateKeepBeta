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
  DEPOSIT_RECONCILING_MESSAGE, type StagedOccurrence,
} from "./paymentsCore.js";
import {
  getStripe, stripeSecretKey, StripeCardDeclinedError, StripePaymentPendingError,
} from "./stripeClient.js";
import { paymentIntentSucceededHandlers } from "./paymentsWebhook.js";

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
    kind: "booking", refId: bookingId,
    title: "Booking request withdrawn",
    body: `${actingName} withdrew their booking request${gigTitle ? ` for "${gigTitle}"` : ""}.`,
  });

  return { ok: true };
});

// F5 (security audit wave, ruling: allow but exclude from trust metric):
// detects membership overlap between the two profiles on a booking — any
// uid that is a member of BOTH the curator profile AND the musician profile
// (e.g. a venue owner who is also a member of the musician profile
// performing there). Reads both profiles' `members` subcollections in full
// and intersects the uid sets — bounded by each profile's own member cap
// (mirrors syncCuratorAccess/reviewProfile's own "read a profile's members"
// idiom elsewhere in this codebase), cheaper and simpler than resolving
// which SPECIFIC uid to check membership for on the other side. Called
// OUTSIDE acceptBooking's own transaction — memberships are stable at
// accept time (nothing in this codebase changes membership as a side effect
// of a booking action), so a non-transactional read here carries no TOCTOU
// risk the way the booking/gig/series state itself does.
async function detectSelfDeal(
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
// non-transactional Stripe call in between. Reads only — the caller does its
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
  deposit: BookingDeposit;   // status "unpaid" — the committing caller overrides it
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
  // Defensive — mirrors counterBooking's identical rationale: a booking
  // always names an existing gig at creation time and nothing deletes gigs.
  if (!gig) throw new HttpsError("internal", "This booking's gig could not be found.");
  if (gig.status !== "open") throw new HttpsError("failed-precondition", GIG_UNAVAILABLE_MESSAGE);

  // F2 (security audit wave): refuse to accept once the gig has been
  // edited (updateGig) AFTER the thread's last offer — the terms about to
  // be frozen below may no longer match what the two sides actually
  // negotiated over. Most dangerous for perHour: amountCents (the rate)
  // never has to change for the accepted TOTAL to silently change, if
  // durationMinutes moved underneath the thread. Compared against the
  // LAST entry (not the first) — a counter made AFTER the edit is a fresh
  // negotiation over the current gig and must not be blocked by an edit
  // that came before it.
  //
  // Edge case considered (and ruled out): publishGig bumps gig.updatedAt
  // at publish time, which is ALWAYS strictly before the first thread
  // entry's `at` — applyToGig/offerGig can only create a booking against
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
      "The gig was updated after the last offer — review the gig and send a new offer.");
  }

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
  // carries its own edited duration is NOT reflected here; SP5 stages a
  // per-occurrence payment doc priced from THAT occurrence's own duration
  // (see the staging loop in acceptBooking), and those docs — not this
  // run-level summary field — are the money truth. `lastEntry` is the same
  // value the F2 gig-edit guard above already computed. ----
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

  return { freshBooking, gig, gigRef, occurrenceDocs, lastEntry, acceptedTerms, deposit };
}

// Every occurrence this accept covers: the whole run's currently-open dates,
// or (single booking) just the one gig. Each carries its OWN durationMinutes
// — an occurrence detached from its series template with an edited duration
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

// What transaction B hands its caller: enough to run the post-commit fan-out
// (supersede + notifications + ledger) without re-reading the booking.
export interface AcceptCommitResult {
  filledGigIds: string[];
  gigId: string; seriesId: string | null;
  curatorProfileId: string; musicianProfileId: string;
  depositTotalCents: number;      // Σ(slice + feeShare) actually marked held — the amount charged
  occurrenceCount: number;        // how many payment docs were marked held
}

// ---- Transaction B of the accept saga: commit the accept + mark deposits
// held. EXPORTED because three callers complete the same saga: acceptBooking
// (the normal path, right after its charge), the payment_intent.succeeded
// webhook (pending-charge recovery), and Task 9's sweep reconciliation.
//
// Returns null — never throws — when the booking is no longer in the
// staged/open state. That's the IDEMPOTENCY contract the webhook and the
// sweep depend on: a redelivered event, or a sweep racing the callable, must
// be a silent no-op, not a second accept. acceptBooking itself treats null as
// "the world moved under the charge" and refunds.
//
// `isSelfDeal` is passed in rather than computed here: detectSelfDeal reads
// two members subcollections and must not run inside a transaction (and
// memberships are stable at accept time — see detectSelfDeal's own comment).
export async function commitAcceptAfterCharge(
  bookingId: string, intentId: string | null, chargeId: string | null, now: number, isSelfDeal: boolean,
): Promise<AcceptCommitResult | null> {
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
    // Only the docs THIS accept staged: an already-held/resolved doc belongs
    // to some earlier money event and must not be re-stamped with this
    // intent.
    const stagedDocs = paymentsSnap.docs.filter((d) => (d.data() as PaymentDoc).deposit.status === "unpaid");

    // Money-integrity re-check, and the reason B can safely skip
    // acceptBooking's turn check: the charge was sized from the baseCents
    // staged in A. If the terms moved underneath it in the charge window
    // (the accepting side countered itself from a second client, or an
    // occurrence's duration was edited), re-deriving each staged doc's base
    // from the CURRENT thread + gig no longer agrees — committing anyway
    // would confirm terms nobody paid for. Abort instead; the caller refunds.
    const gigById = new Map<string, GigDoc>();
    if (v.freshBooking.seriesId) {
      for (const d of v.occurrenceDocs) gigById.set(d.id, d.data() as GigDoc);
    } else {
      gigById.set(v.freshBooking.gigId, v.gig);
    }
    for (const doc of stagedDocs) {
      const p = doc.data() as PaymentDoc;
      const g = gigById.get(p.gigId);
      // No live gig for this staged doc (the occurrence was cancelled or
      // filled elsewhere in the window): nothing to re-derive against, and
      // its money was already charged — leave the cross-check to the docs we
      // CAN verify rather than aborting a whole accept over one stale date.
      if (!g) continue;
      const expected = computeExpectedTotalCents(v.freshBooking.structure, v.lastEntry.amountCents, {
        durationMinutes: g.durationMinutes, songCount: v.lastEntry.expectedQuantity ?? undefined,
      });
      if (expected !== p.baseCents) {
        console.error(
          `commitAcceptAfterCharge: staged base ${p.baseCents} no longer matches ${expected} for ${bookingId}/${p.gigId} — aborting`);
        return null;
      }
    }

    // ---- WRITES ----
    // F5: `selfDeal` is only ever included (true) when overlap was detected
    // — never written as an explicit `false`, so a normal booking's doc
    // shape is unchanged (the field simply stays absent, exactly like every
    // pre-F5 booking).
    let depositTotalCents = 0;
    for (const doc of stagedDocs) {
      const p = doc.data() as PaymentDoc;
      depositTotalCents += p.deposit.sliceCents + p.deposit.feeShareCents;
      tx.update(doc.ref, {
        "deposit.status": "held", "deposit.intentId": intentId, "deposit.chargeId": chargeId,
        "deposit.chargedAt": now, updatedAt: now,
      });
    }
    tx.update(bookingRef, {
      status: "confirmed", confirmedAt: now, updatedAt: now,
      acceptedTerms: v.acceptedTerms,
      // The run-level deposit stays SP4's one-occurrence summary; only its
      // status moves to "held" — and only when money actually moved. A run
      // whose every open occurrence has already started stages nothing and
      // charges nothing, so "unpaid" (SP4's own value) remains the truth.
      deposit: { ...v.deposit, status: stagedDocs.length > 0 ? "held" : "unpaid" },
      ...(isSelfDeal ? { selfDeal: true } : {}),
      depositChargePending: false, depositChargeIntentId: null,
    });

    const filledGigIds: string[] = [];
    if (v.freshBooking.seriesId) {
      for (const doc of v.occurrenceDocs) {
        tx.update(doc.ref, {
          status: "filled", bookingId, bookedMusicianProfileId: v.freshBooking.musicianProfileId, updatedAt: now,
        });
        filledGigIds.push(doc.id);
      }
      tx.update(db.doc(`gigSeries/${v.freshBooking.seriesId}`), {
        activeBookingId: bookingId, bookedMusicianProfileId: v.freshBooking.musicianProfileId, updatedAt: now,
      });
    } else {
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

// Best-effort undo of transaction A's staging, for every path that decided
// NOT to (or could not) complete the accept: a declined card, an aborted
// transaction B, an unexpected Stripe failure. Leaves the booking `open` with
// no pending marker, so a retry is a clean fresh attempt (with a bumped
// attempt counter ⇒ a fresh idempotency key ⇒ a real second charge attempt,
// not a replayed decline).
//
// Each delete is guarded on the doc still being `unpaid`: the caller reaches
// here only when nothing was committed, but a delete is destructive and a
// HELD payment doc is real money — never remove one on a cleanup path.
// NOT called on the pending-charge path (see DEPOSIT_PROCESSING_MESSAGE):
// there the staged docs must survive for the webhook to finalize.
async function unstageAccept(
  db: FirebaseFirestore.Firestore, bookingId: string, occurrences: StagedOccurrence[],
): Promise<void> {
  for (const occ of occurrences) {
    try {
      const ref = paymentRef(db, bookingId, occ.gigId);
      const snap = await ref.get();
      const p = snap.data() as PaymentDoc | undefined;
      if (!p) continue;
      if (p.deposit.status !== "unpaid") {
        console.error(`unstageAccept: refusing to delete ${bookingId}/${occ.gigId} in deposit status ${p.deposit.status}`);
        continue;
      }
      await ref.delete();
    } catch (e) {
      console.error(`unstageAccept: failed to remove staged payment doc ${bookingId}/${occ.gigId}`, e);
    }
  }
  await db.doc(`bookings/${bookingId}`).update({
    depositChargePending: false, depositChargeIntentId: null, updatedAt: Date.now(),
  }).catch((e) => console.error(`unstageAccept: failed to clear the staged marker on ${bookingId}`, e));
}

// ---- POST-COMMIT TAIL (deliberately outside any transaction) ----
// Shared by acceptBooking and the payment_intent.succeeded recovery path, so
// a webhook-completed accept fans out exactly like a callable-completed one.
// Every step is best-effort and failure-isolated: the accept and its charge
// have already committed by the time this runs, so nothing here may surface
// as a failure to whoever is waiting.
async function runAcceptPostCommit(
  db: FirebaseFirestore.Firestore, bookingId: string, commit: AcceptCommitResult,
  intentId: string | null, now: number,
): Promise<void> {
  try {
    if (intentId && commit.depositTotalCents > 0) {
      await writeLedger({
        kind: "deposit_charged", amountCents: commit.depositTotalCents,
        bookingId, gigId: null, profileId: commit.curatorProfileId, stripeId: intentId,
        detail: `deposit batch (${commit.occurrenceCount} occurrence(s))`,
      });
    }
    await recomputePaymentSummary(bookingId);
  } catch (e) {
    console.error(`acceptBooking: ledger/summary failed for ${bookingId}`, e);
  }

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
  const siblingQueries = commit.filledGigIds.map((gid) =>
    db.collection("bookings").where("gigId", "==", gid).where("status", "==", "open"));
  if (commit.seriesId) {
    siblingQueries.push(
      db.collection("bookings").where("seriesId", "==", commit.seriesId).where("status", "==", "open"));
  }
  for (const q of siblingQueries) {
    const snap = await q.get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      await supersedeSiblingBooking(db, doc, now);
    }
  }

  // Winners — both sides. Unlike decline/withdrawBooking's equivalent
  // (unwrapped) tail, this one is wrapped: the accept has already committed
  // by this point, so a failure in this best-effort notification tail — a
  // transient read/write error, nothing more — must never surface as an
  // error to the caller. An apparent failure here would look like the accept
  // itself failed and invite a confusing retry (which would then hit its own
  // failed-precondition, since the booking is no longer "open") even though
  // the gig is already correctly filled — and, now, already charged.
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
    console.error(`acceptBooking: failed to notify winners for booking ${bookingId}`, e);
  }
}

// Remaps the two curator-gate messages for a MUSICIAN-side caller: they're
// curator-authored, second-person copy ("Save a payment card...") that the
// musician side cannot act on. A curator-side caller keeps the specific
// message — it names exactly what they need to fix.
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

    // Membership resolved once, outside the transaction — see requireBookingSide.
    const callerSide = await requireBookingSide(booking, uid);

    // F5: computed once, outside the transaction — see detectSelfDeal's own
    // comment on why memberships are stable enough for this to be safe here.
    // Also why it's computed HERE and passed into transaction B rather than
    // recomputed inside it: two members-subcollection reads must not run
    // inside a Firestore transaction.
    const isSelfDeal = await detectSelfDeal(db, booking.curatorProfileId, booking.musicianProfileId);

    // Task 5 money gates, FAST-FAIL half: either side accepting lands the
    // deposit charge on the CURATOR's card, so the curator profile is always
    // checked regardless of which side is calling — same for the musician's
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
    // Everything that decides whether the fill can happen — the booking's
    // own turn/status/thread, the gig's live status, and (whole-run) the
    // series' live status plus EVERY currently-open occurrence of the run —
    // is read inside ONE transaction, together with the money gates. The
    // ONLY writes are the staged payment docs and the saga marker: nothing
    // is confirmed and no gig is filled until the charge lands.
    const staged = await db.runTransaction(async (tx) => {
      // ---- READS (all of them, before any write — Admin SDK transaction rule) ----
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
      // enforce — so they must be read in the same transaction that stages
      // the money, and the charge below must use the customerId FROM THIS
      // SNAPSHOT rather than the outer read's.
      const [curatorStripeSnap, musicianStripeSnap] = await tx.getAll(
        db.doc(`profiles/${v.freshBooking.curatorProfileId}/private/stripe`),
        db.doc(`profiles/${v.freshBooking.musicianProfileId}/private/stripe`));
      const curatorStripe = curatorStripeSnap.data() as StripeProfileDoc | undefined;
      const musicianStripe = musicianStripeSnap.data() as StripeProfileDoc | undefined;
      // Fail CLOSED on partial docs, and check the card fields FIRST — see
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
      // Only FUTURE occurrences get a deposit: a run date that has already
      // started never gets charged for one (and a same-day accept of it
      // settles directly at Task 10's settlement instead).
      const occurrences = collectOccurrences(v).filter((o) => o.startsAt > now);
      let totalChargeCents = 0;
      for (const occ of occurrences) {
        const doc = buildPaymentDoc({
          booking: v.freshBooking, bookingId, occ,
          amountCents: v.lastEntry.amountCents, expectedQuantity: v.lastEntry.expectedQuantity,
          structure: v.freshBooking.structure, feePolicy, selfDeal: isSelfDeal, now,
        });
        tx.set(paymentRef(db, bookingId, occ.gigId), doc);
        totalChargeCents += doc.deposit.sliceCents + doc.deposit.feeShareCents;
      }
      // Attempt-scoped charge key (as-built contract #2): both real Stripe
      // and FakeStripe CACHE a decline under its idempotency key, so a retry
      // after a decline must carry a different key or it replays the decline
      // forever. Persisted (not derived) so Task 9's crash reconciliation can
      // reuse the SAME attempt — same key, same intent, never a second charge.
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
        await unstageAccept(db, bookingId, staged.occurrences);
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
      commit = await commitAcceptAfterCharge(bookingId, intentId, chargeId, now, isSelfDeal);
    } catch (e) {
      commitError = e;
    }
    if (!commit) {
      // B did not commit AFTER a successful charge — either it threw, or the
      // world moved under the charge (returned null). Give the money back
      // before surfacing anything: the accept did not happen, so the curator
      // must not be left paying for it. Then unstage, so the booking is a
      // clean `open` again and a retry is a fresh attempt.
      if (intentId) {
        await getStripe().refund({
          intentId, amountCents: staged.totalChargeCents,
          idempotencyKey: `${bookingId}:accept:refund:${staged.attempt}`,
          meta: { bookingId, purpose: "accept_abort" },
        }).catch((re) => console.error(`acceptBooking: abort-refund failed for ${bookingId}`, re));
      }
      await unstageAccept(db, bookingId, staged.occurrences);
      if (commitError) throw commitError;
      throw new HttpsError("aborted", GIG_UNAVAILABLE_MESSAGE);
    }

    await runAcceptPostCommit(db, bookingId, commit, intentId, now);
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
// 9's sweep) changes nothing. Registered in bookings.ts — not payments.ts —
// because that's where the saga lives; the purpose-keyed registry keeps Task
// 10's "settlement" and Task 11's "paydue" branches purely additive.
paymentIntentSucceededHandlers["deposit"] = async (object) => {
  const intentId = object.id as string | undefined;
  const bookingId = (object.metadata as Record<string, string> | undefined)?.bookingId;
  // Event payloads are signature-verified but never shape-validated, so
  // metadata is untrusted input — validate before building a doc path from it
  // (mirrors account.updated's identical guard in payments.ts).
  if (!intentId || !bookingId || !isValidDocId(bookingId)) {
    console.warn(`payment_intent.succeeded (deposit): unusable metadata — intent=${String(intentId)}, bookingId=${JSON.stringify(bookingId ?? null)}`);
    return;
  }

  const db = getFirestore();
  const snap = await db.doc(`bookings/${bookingId}`).get();
  const booking = snap.data() as BookingRequestDoc | undefined;
  if (!booking) return;
  // Not the accept this booking is waiting on (already committed, never
  // staged, or a different attempt's intent) — a no-op, not an error.
  if (booking.depositChargePending !== true || booking.depositChargeIntentId !== intentId) return;

  const isSelfDeal = await detectSelfDeal(db, booking.curatorProfileId, booking.musicianProfileId);
  const now = Date.now();
  // latest_charge is present on a real payment_intent.succeeded payload; a
  // deposit finalized without one simply carries a null chargeId (DepositState
  // documents that, and the transfers that want it treat it as optional).
  const chargeId = typeof object.latest_charge === "string" ? object.latest_charge : null;

  const commit = await commitAcceptAfterCharge(bookingId, intentId, chargeId, now, isSelfDeal);
  if (!commit) {
    // Charged, but the accept can no longer be committed (the gig/series
    // moved while the intent settled). Deliberately NOT auto-refunded from a
    // webhook — Task 9's reconciliation owns stuck money; this is the signal
    // for it (and for an operator) that this booking needs attention.
    console.error(`payment_intent.succeeded (deposit): could not commit accept for ${bookingId} (intent ${intentId})`);
    return;
  }
  await runAcceptPostCommit(db, bookingId, commit, intentId, now);
};

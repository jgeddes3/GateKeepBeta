import { onCall } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  type BookingDoc, type BookingVisibility, type CuratorBookingDoc, type ReliabilityDoc,
  type BookingRates,
} from "@gatekeep/shared";
import { requireAdmin, writeAudit } from "./review.js";

// Pre-SP4 behavior: curators (via the old isApprovedCuratorMember() rules
// disjunct on private/booking, now removed) could read every rate and
// preference. Defaulting a legacy doc to all-"curators" preserves that
// exposure exactly, nothing new becomes visible, and nothing that was
// visible becomes hidden, while "preferences":"public" is never assumed
// (public was never a pre-SP4 possibility).
export const DEFAULT_BOOKING_VISIBILITY: BookingVisibility = {
  perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
};

// SP10 Task 18: the rates block of a projection that exists only because a
// reliability event (sweep completion, late-cancel mark) needed somewhere to
// live. Every client renders these as "No public rates." (sp4 #1).
export const EMPTY_BOOKING_RATES: BookingRates = { perHour: null, perSong: null, perSet: null };

// Rebuilds both booking-visibility projections for a profile from its
// current source docs: profiles/{id}/private/curatorBooking (the
// curator-shopping surface, rates with any "private"-marked structure
// nulled out, full preferences, and a reliability summary) and
// profiles/{id}.publicBooking (the preferences object, but only when
// visibility.preferences is "public"; null otherwise). Called by
// updateBookingInfo after every write and by backfillBookingVisibility for
// each doc it converges, the primary writer of both projections today, per
// the comments left in profiles.ts / firestore.rules by earlier tasks. Not
// the ONLY writer of the reliability summary going forward, though: Task 6
// adds recomputeReliability, which merge-writes the `reliability` field of
// curatorBooking after cancellation/no-show/admin-removal events, leaving
// rates/preferences and publicBooking untouched. That merge is why this
// function no longer deletes curatorBooking for a musician with no booking
// info (SP10 Task 18): a reliability summary written by that path has to
// survive a rebuild that finds no source doc.
//
// `source`, when passed, is the BookingDoc the caller is about to persist,
// updateBookingInfo passes its just-built docData so the source write folds
// into THIS function's own batch instead of updateBookingInfo writing it
// separately first. That makes the source write and both projections commit
// atomically: no crash window where the source lands but the projections
// stay stale, and no interleave where a concurrent read pairs fresh
// rates/preferences with an older projection. Omit `source` to have this
// function read the current source doc itself (backfillBookingVisibility's
// path, and any direct/administrative rebuild), a doc that doesn't exist in
// that case triggers the seed-and-keep branch below (a merge-set projection
// carrying whatever reliability already exists), not an error and not a
// delete.
export async function rebuildBookingProjections(profileId: string, source?: BookingDoc): Promise<void> {
  const db = getFirestore();
  const bookingRef = db.doc(`profiles/${profileId}/private/booking`);
  const reliabilityRef = db.doc(`profiles/${profileId}/private/reliability`);
  const curatorBookingRef = db.doc(`profiles/${profileId}/private/curatorBooking`);
  const profileRef = db.doc(`profiles/${profileId}`);
  const batch = db.batch();

  let booking: BookingDoc;
  let reliabilitySnap: FirebaseFirestore.DocumentSnapshot;
  if (source) {
    booking = source;
    batch.set(bookingRef, source);
    reliabilitySnap = await reliabilityRef.get();
  } else {
    const [bookingSnap, relSnap] = await Promise.all([bookingRef.get(), reliabilityRef.get()]);
    if (!bookingSnap.exists) {
      // No source doc (never set, or deleted out from under a stale caller).
      // SP10 Task 18 (sp4 #20): merge-set a seeded projection rather than
      // deleting the doc, so a reliability summary recomputeReliability has
      // already written for a musician with no booking info survives.
      const rel = relSnap.data() as ReliabilityDoc | undefined;
      const relMarks = rel?.marks ?? [];
      const seeded: CuratorBookingDoc = {
        rates: EMPTY_BOOKING_RATES, preferences: null,
        reliability: {
          noShowCount: relMarks.filter((m) => !m.removedByAdmin).length,
          completedCount: rel?.completedCount ?? 0,
        },
        updatedAt: Date.now(),
      };
      batch.set(curatorBookingRef, seeded, { merge: true });
      batch.set(profileRef, { publicBooking: null }, { merge: true });
      await batch.commit();
      return;
    }
    booking = bookingSnap.data() as BookingDoc;
    reliabilitySnap = relSnap;
  }

  // Legacy docs (pre-Task-3, before backfillBookingVisibility converges
  // them) carry no `visibility`, treat exactly as the backfill default so a
  // pre-backfill read is never MORE exposed than a post-backfill one.
  const visibility = booking.visibility ?? DEFAULT_BOOKING_VISIBILITY;
  const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
  const marks = reliability?.marks ?? [];

  const rates: BookingRates = {
    perHour: visibility.perHour === "private" ? null : booking.rates.perHour,
    perSong: visibility.perSong === "private" ? null : booking.rates.perSong,
    perSet: visibility.perSet === "private" ? null : booking.rates.perSet,
  };

  const curatorBooking: CuratorBookingDoc = {
    rates,
    preferences: booking.preferences,
    reliability: {
      noShowCount: marks.filter((m) => !m.removedByAdmin).length,
      completedCount: reliability?.completedCount ?? 0,
    },
    updatedAt: Date.now(),
  };
  batch.set(curatorBookingRef, curatorBooking);

  const publicBooking = visibility.preferences === "public" ? booking.preferences : null;
  batch.set(profileRef, { publicBooking }, { merge: true });

  await batch.commit();
}

const BACKFILL_PAGE_SIZE = 300;

// Admin one-shot: pages every profiles/{id} doc (documentId()-ordered, same
// idiom as backfillDisplayNameLower in adminTools.ts, filtering to musician
// profiles in application code rather than adding a `type` equality clause
// to the paged query, so no new composite index is needed), and for each
// musician profile whose private/booking doc exists but lacks `visibility`,
// writes the all-"curators" default (preserves pre-SP4 exposure, see
// DEFAULT_BOOKING_VISIBILITY) and rebuilds its projections. Needed once at
// deploy for pre-Task-3 booking docs; idempotent, a doc that already has
// `visibility` (or has no booking doc at all) is left untouched.
export const backfillBookingVisibility = onCall<Record<string, never>>(
  { region: "us-central1", timeoutSeconds: 540 },
  async (req) => {
    const actorUid = requireAdmin(req);
    const db = getFirestore();
    let converged = 0;
    let failed = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = db.collection("profiles").orderBy("__name__").limit(BACKFILL_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        if (doc.data()?.type !== "musician") continue;
        const bookingRef = doc.ref.collection("private").doc("booking");
        try {
          const bookingSnap = await bookingRef.get();
          if (!bookingSnap.exists) continue;
          if (bookingSnap.data()?.visibility !== undefined) continue;
          // Rebuild BEFORE writing the marker, so the marker write is the
          // commit point for this profile. rebuildBookingProjections already
          // falls back to DEFAULT_BOOKING_VISIBILITY for a doc with no
          // `visibility`, so this produces the exact projections a
          // marker-then-rebuild order would, but if the rebuild throws, the
          // doc is left exactly as found (still missing `visibility`), so
          // the next backfill run retries it. The old marker-first order
          // could strand a doc forever: a crash after the marker landed but
          // before the projection was built left the marker set (the
          // `visibility !== undefined` check above skips it on every future
          // run) with no projection ever created, and since Task 2 removed
          // curators' direct read of private/booking, that doc's
          // rates/preferences would then be invisible to every curator
          // indefinitely.
          await rebuildBookingProjections(doc.id);
          // merge:true resilience (mirrors backfillDisplayNameLower), never
          // clobbers rates/preferences/updatedAt, only adds the missing key.
          await bookingRef.set({ visibility: DEFAULT_BOOKING_VISIBILITY }, { merge: true });
          converged++;
        } catch (err) {
          // Isolate-log-continue (mirrors the sweep philosophy in
          // scheduled.ts), one profile's failure must not abort the whole
          // page/run or strand every profile after it in this collection.
          failed++;
          console.error(`backfillBookingVisibility: failed to converge profile ${doc.id}`, err);
        }
      }

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < BACKFILL_PAGE_SIZE) break; // last page
    }

    // targetId "*", this is a collection-wide sweep, not a single-profile
    // action; the comment on AuditLogDoc.targetId ("profileId or uid") has
    // no literal fit for a bulk backfill, so a wildcard sentinel is used
    // instead of picking one arbitrary profile out of the converged set.
    await writeAudit({
      actorUid, action: "booking_visibility_backfilled", targetId: "*",
      detail: `${converged} converged, ${failed} failed`,
    });
    return { converged, failed };
  },
);

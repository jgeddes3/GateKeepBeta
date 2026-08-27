import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateGigContent, validateBudget, validateRecurrence, isValidDocId,
  MAX_ACTIVE_SERIES_PER_PROFILE, FILL_MODES,
  type GigContentInput, type GigBudget, type GigRecurrence, type FillMode,
  type GigSeriesDoc, type GigPublicLocation, type GigStatus,
  type CuratorSubtype, type CuratorDetails, type BookingRequestDoc,
} from "@gatekeep/shared";
import {
  requireAuthUid, requireVerifiedEmail, requireProfileMember, requireApprovedCuratorProfile,
} from "./guards.js";
import {
  resolveGigLocation, validateLocationInput, GEOCODE_FAILURE_MESSAGE, type GigLocationInput,
} from "./gigs.js";
import { getGeocoder, coarsen, geocoderApiKey, consumeGeocodeBudget } from "./geocode.js";
import { executeCancellation, ALREADY_STARTED_MESSAGE, NO_UPCOMING_DATES_MESSAGE } from "./bookingLifecycle.js";

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

// Shared content shape for both createSeries and updateSeries — the same
// GigContentInput/budget/location fields a one-off gig takes, plus the
// series-only recurrence + fillMode.
interface SeriesContentInput extends GigContentInput {
  budget: GigBudget;
  recurrence: GigRecurrence;
  fillMode: FillMode;
  location?: GigLocationInput;
}

export interface CreateSeriesInput extends SeriesContentInput { profileId: string; }
export interface UpdateSeriesInput extends SeriesContentInput { seriesId: string; }

// Field-shape validation for the content shared by create/update — Task 1's
// validators (content/budget/recurrence) plus the local fillMode/location
// checks gigs.ts already exports. Runs before any authz guard, matching the
// ordering convention.
function validateSeriesInput(input: SeriesContentInput, now: number): Result {
  const content = validateGigContent(input);
  if (!content.ok) return content;
  const budget = validateBudget(input.budget);
  if (!budget.ok) return budget;
  const recurrence = validateRecurrence(input.recurrence, now);
  if (!recurrence.ok) return recurrence;
  if (typeof input.fillMode !== "string" || !(FILL_MODES as readonly string[]).includes(input.fillMode)) {
    return fail("Invalid fill mode.");
  }
  return validateLocationInput(input.location);
}

function buildTemplateContent(input: SeriesContentInput, location: GigPublicLocation): GigSeriesDoc["template"] {
  return {
    title: input.title.trim(), description: input.description.trim(),
    wants: { genres: input.wants.genres, actSizes: input.wants.actSizes },
    budget: { minCents: input.budget.minCents, maxCents: input.budget.maxCents, structure: input.budget.structure },
    durationMinutes: input.durationMinutes,
    provisions: {
      hasPA: input.provisions.hasPA ?? null, hasBackline: input.provisions.hasBackline ?? null,
      notes: input.provisions.notes ?? null,
    },
    location,
  };
}

function buildRecurrence(input: GigRecurrence): GigSeriesDoc["recurrence"] {
  return {
    weekday: input.weekday, hour: input.hour, minute: input.minute,
    cadence: input.cadence, endDate: input.endDate ?? null,
  };
}

export const createSeries = onCall<CreateSeriesInput>({ region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
  const now = Date.now();
  const v = validateSeriesInput(input, now);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  // sequential is deliberate — mirrors createGig's identical rationale:
  // parallelizing makes rejection order nondeterministic and would leak
  // profile existence/type/approval status to non-members.
  await requireProfileMember(input.profileId, uid);
  const profileSnap = await requireApprovedCuratorProfile(input.profileId);
  const profile = profileSnap.data()!;
  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const curatorLocation = profile.curator?.location as CuratorDetails["location"] | undefined;

  const db = getFirestore();
  const activeCount = await db.collection("gigSeries")
    .where("curatorProfileId", "==", input.profileId)
    .where("status", "==", "active")
    .count().get();
  if (activeCount.data().count >= MAX_ACTIVE_SERIES_PER_PROFILE) {
    throw new HttpsError("resource-exhausted",
      `A profile may have at most ${MAX_ACTIVE_SERIES_PER_PROFILE} active series.`);
  }

  // Same resolution createGig runs — the template stores the resolved
  // public/private split so Task 7's materializer never has to re-geocode.
  const { location, privateLocation } = await resolveGigLocation(
    uid, isVenue, profile.name as string, curatorLocation, input.location);

  const seriesRef = db.collection("gigSeries").doc();
  const series: GigSeriesDoc = {
    curatorProfileId: input.profileId,
    recurrence: buildRecurrence(input.recurrence),
    fillMode: input.fillMode,
    template: buildTemplateContent(input, location),
    templatePrivateLocation: privateLocation,
    // Task 7's daily sweep materializes the first batch of occurrences on
    // its next run — createSeries deliberately writes no occurrence docs.
    status: "active", materializedThrough: 0, createdAt: now, updatedAt: now,
    // SP4 whole-run booking (Task 5) is the sole writer of these — no run is
    // booked yet at series creation.
    activeBookingId: null, bookedMusicianProfileId: null,
  };
  await seriesRef.set(series);
  return { seriesId: seriesRef.id };
});

export const updateSeries = onCall<UpdateSeriesInput>(
  { region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.seriesId)) throw new HttpsError("invalid-argument", "A series id is required.");
  const now = Date.now();
  const v = validateSeriesInput(input, now);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  const db = getFirestore();
  const seriesRef = db.doc(`gigSeries/${input.seriesId}`);
  const seriesSnap = await seriesRef.get();
  if (!seriesSnap.exists) throw new HttpsError("not-found", "Series not found.");
  const series = seriesSnap.data() as GigSeriesDoc;
  await requireProfileMember(series.curatorProfileId, uid);
  // P3: matches createSeries/publishGig/updateGig's approval gate — without
  // it, a member of a since-rejected/unpublished curator profile could keep
  // editing (and, via the propagation sweep below, keep rewriting) a
  // possibly still world-readable series' future occurrences.
  await requireApprovedCuratorProfile(series.curatorProfileId);
  if (series.status === "ended") {
    throw new HttpsError("failed-precondition", "Cannot edit an ended series.");
  }

  // Location: entirely omitted leaves the template's existing location
  // untouched (mirrors updateGig); provided triggers a resolve — an address
  // override re-geocodes, a visibility-only change reuses the template's
  // already-exact private address/geo rather than re-geocoding. Can't reuse
  // resolveGigLocation here (it only knows the create-time "no override ->
  // fall back to the profile's address" shape, which would wrongly discard
  // a prior per-series address override on a visibility-only edit).
  let location = series.template.location;
  let privateLocation = series.templatePrivateLocation;
  if (input.location !== undefined) {
    const profileSnap = await db.doc(`profiles/${series.curatorProfileId}`).get();
    const profile = profileSnap.data()!;
    const isVenue = (profile.subtype as CuratorSubtype) === "venue";
    const overrideAddress = typeof input.location.address === "string" ? input.location.address.trim() : "";
    const newVisibility = input.location.addressVisibility ?? location.addressVisibility;

    if (overrideAddress.length > 0) {
      if (privateLocation.geocodedFrom === overrideAddress) {
        // S2: unchanged address input — reuse the already-resolved geocode
        // rather than re-querying (and re-charging the daily budget for)
        // the exact same address a member just re-submitted.
        if (!privateLocation.geo) {
          throw new HttpsError("internal", "This series' stored location is missing coordinates.");
        }
        const { lat, lng } = privateLocation.geo;
        const publicGeo = newVisibility === "public" ? { lat, lng }
          : coarsen({ lat, lng, neighborhood: location.neighborhood, city: location.city });
        location = {
          venueName: isVenue ? (profile.name as string) : null, neighborhood: location.neighborhood, city: location.city,
          geo: publicGeo, addressVisibility: newVisibility,
          address: newVisibility === "public" ? overrideAddress : null,
        };
        privateLocation = { address: overrideAddress, geo: { lat, lng }, geocodedFrom: overrideAddress };
      } else {
        await consumeGeocodeBudget(uid);
        const result = await getGeocoder().geocode(overrideAddress);
        if (!result) throw new HttpsError("invalid-argument", GEOCODE_FAILURE_MESSAGE);
        const publicGeo = newVisibility === "public" ? { lat: result.lat, lng: result.lng } : coarsen(result);
        location = {
          venueName: isVenue ? (profile.name as string) : null, neighborhood: result.neighborhood, city: result.city,
          geo: publicGeo, addressVisibility: newVisibility,
          address: newVisibility === "public" ? overrideAddress : null,
        };
        privateLocation = { address: overrideAddress, geo: { lat: result.lat, lng: result.lng }, geocodedFrom: overrideAddress };
      }
    } else {
      // Visibility-only change (or a no-op location object) — reuse the
      // already-exact private geo/address rather than re-geocoding.
      // P7: explicit guard instead of a `.geo!` non-null assertion.
      if (!privateLocation.geo) {
        throw new HttpsError("internal", "This series' stored location is missing coordinates.");
      }
      const lat = privateLocation.geo.lat; const lng = privateLocation.geo.lng;
      const publicGeo = newVisibility === "public"
        ? { lat, lng }
        : coarsen({ lat, lng, neighborhood: location.neighborhood, city: location.city });
      location = {
        venueName: location.venueName, neighborhood: location.neighborhood, city: location.city,
        geo: publicGeo, addressVisibility: newVisibility,
        address: newVisibility === "public" ? privateLocation.address : null,
      };
    }
  }

  const template = buildTemplateContent(input, location);

  const batch = db.batch();
  batch.update(seriesRef, {
    recurrence: buildRecurrence(input.recurrence),
    fillMode: input.fillMode,
    template,
    templatePrivateLocation: privateLocation,
    updatedAt: now,
  });

  // Template edits propagate to FUTURE, still-attached occurrences only —
  // an occurrence a member directly edited (updateGig) has detached and
  // must not be silently overwritten by a later template edit. Recurrence
  // edits (weekday/hour/cadence/endDate) intentionally do NOT retroactively
  // reshape already-materialized occurrences: those are concrete dated gigs
  // already; only Task 7's materializer reads the new recurrence, and only
  // for occurrences it hasn't created yet.
  //
  // Queries seriesId==this && startsAt>now (served by the existing
  // (seriesId,startsAt) composite index) then filters detachedFromTemplate
  // in application code — a second equality filter combined with the range
  // filter would need its own composite index, and per-series occurrence
  // counts are small (materialization caps at SERIES_MATERIALIZE_WEEKS).
  // Did THIS call change the location (an address override or a
  // visibility-only flip)? If so, every swept occurrence's private location
  // needs to move too — its public `location` field is always kept in sync
  // with the template above, but the exact address+geo lives in a separate
  // `gigs/{id}/private/location` subdoc that the loop below wouldn't
  // otherwise touch.
  const locationChanged = input.location !== undefined;

  const futureSnap = await db.collection("gigs")
    .where("seriesId", "==", input.seriesId).where("startsAt", ">", now).get();
  for (const doc of futureSnap.docs) {
    if (doc.data().detachedFromTemplate === true) continue;
    batch.update(doc.ref, {
      title: template.title, description: template.description, wants: template.wants,
      budget: template.budget, durationMinutes: template.durationMinutes, provisions: template.provisions,
      location: template.location, updatedAt: now,
    });
    if (locationChanged) {
      // A plain set, not update: pre-Task-7 there's no materializer yet, so
      // an admin-SDK-seeded test occurrence may not have this subdoc at
      // all — set() is the correct "make it match the template" semantics
      // either way (create or overwrite), mirroring createGig's own
      // private/location write.
      batch.set(db.doc(`gigs/${doc.id}/private/location`), privateLocation);
    }
  }

  await batch.commit();
  return { ok: true };
});

// Task 7 fix: shared by pauseSeries/endSeries below — attempts a
// curator-side cancellation of the series' active run booking (if any, and
// still "confirmed") via executeCancellation, but TOLERATES exactly the
// "no cancellable dates left" family of failures it can throw
// (ALREADY_STARTED_MESSAGE / NO_UPCOMING_DATES_MESSAGE — a zombie run: every
// future date was already cancelled per-occurrence, or the run's last date
// already started). Matched via the exact exported message constants, never
// an ad-hoc substring check, so this can never accidentally swallow some
// OTHER failed-precondition it doesn't actually understand.
//
// The pause/end action itself must never be blocked by this zombie state —
// the curator's intent (pause/end the series) has nothing to do with
// whether this particular booking still has a cancellable date. Leaving the
// booking "confirmed" with a now-stale series.activeBookingId is safe
// interim state, not a bug: the materializer only births FILLED occurrences
// for a still-ACTIVE series (a paused/ended one births nothing), the
// rebooking-door guard in acceptBooking still correctly refuses a fresh
// accept against this series' activeBookingId, and Task 8's daily sweep
// resolves the booking (to "completed") within a day regardless. Any OTHER
// error (not-found, a genuine transient failure, ...) still propagates —
// this must never silently swallow a failure it doesn't recognize.
async function cancelActiveRunBookingTolerant(
  db: FirebaseFirestore.Firestore, activeBookingId: string, reason: string, now: number,
): Promise<void> {
  const bookingSnap = await db.doc(`bookings/${activeBookingId}`).get();
  const booking = bookingSnap.data() as BookingRequestDoc | undefined;
  if (booking?.status !== "confirmed") return;
  try {
    await executeCancellation(activeBookingId, booking, "curator", reason, now);
  } catch (e) {
    const isNoCancellableDates = e instanceof HttpsError && e.code === "failed-precondition"
      && (e.message === ALREADY_STARTED_MESSAGE || e.message === NO_UPCOMING_DATES_MESSAGE);
    if (!isNoCancellableDates) throw e;
  }
}

export const pauseSeries = onCall<{ seriesId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { seriesId } = req.data;
  if (!isValidDocId(seriesId)) throw new HttpsError("invalid-argument", "A series id is required.");

  const db = getFirestore();
  const seriesRef = db.doc(`gigSeries/${seriesId}`);
  const seriesSnap = await seriesRef.get();
  if (!seriesSnap.exists) throw new HttpsError("not-found", "Series not found.");
  const series = seriesSnap.data() as GigSeriesDoc;
  await requireProfileMember(series.curatorProfileId, uid);
  if (series.status !== "active") {
    throw new HttpsError("failed-precondition", `Cannot pause a series in status "${series.status}".`);
  }

  // SP4 (Task 7, spec §4): a booked run is CURATOR-side cancelled before the
  // pause itself — same window/outcome/mark math as any other curator
  // cancelBooking call, via the extracted executeCancellation core
  // (bookingLifecycle.ts), with a synthetic reason since there's no human
  // "why" beyond the pause action itself. executeCancellation's own
  // transaction reopens the run's future filled occurrences to "open" (via
  // reopenSeriesOccurrences) and clears the series' activeBookingId —
  // pausing leaves them exactly there; nothing further to do to them here
  // (pause has never cancelled occurrences outright — only endSeries, below,
  // does that). Tolerates a zombie (no-cancellable-dates) booking — see
  // cancelActiveRunBookingTolerant's own comment.
  if (series.activeBookingId) {
    await cancelActiveRunBookingTolerant(db, series.activeBookingId, "Series paused by curator", Date.now());
  }

  await seriesRef.update({ status: "paused", updatedAt: Date.now() });
  return { ok: true };
});

export const endSeries = onCall<{ seriesId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { seriesId } = req.data;
  if (!isValidDocId(seriesId)) throw new HttpsError("invalid-argument", "A series id is required.");

  const db = getFirestore();
  const seriesRef = db.doc(`gigSeries/${seriesId}`);
  const seriesSnap = await seriesRef.get();
  if (!seriesSnap.exists) throw new HttpsError("not-found", "Series not found.");
  const series = seriesSnap.data() as GigSeriesDoc;
  await requireProfileMember(series.curatorProfileId, uid);
  if (series.status === "ended") {
    throw new HttpsError("failed-precondition", "Series has already ended.");
  }

  // SP4 (Task 7): same curator-side run cancellation as pauseSeries above —
  // run FIRST, so the occurrences it reopens (filled -> open) fall straight
  // into this function's existing future open|draft sweep below, exactly
  // like any other open date does when a series ends. No separate branch
  // needed for a booked run's remaining dates. Tolerates a zombie
  // (no-cancellable-dates) booking — see cancelActiveRunBookingTolerant's
  // own comment.
  if (series.activeBookingId) {
    await cancelActiveRunBookingTolerant(db, series.activeBookingId, "Series ended by curator", Date.now());
  }

  const now = Date.now();
  const batch = db.batch();
  batch.update(seriesRef, { status: "ended", updatedAt: now });

  // Same query shape as updateSeries's propagation query — reuses the
  // (seriesId,startsAt) composite index, filters status in application code.
  const futureSnap = await db.collection("gigs")
    .where("seriesId", "==", seriesId).where("startsAt", ">", now).get();
  for (const doc of futureSnap.docs) {
    const status = doc.data().status as GigStatus;
    if (status === "open" || status === "draft") {
      batch.update(doc.ref, { status: "cancelled", updatedAt: now });
    }
  }

  await batch.commit();
  return { ok: true };
});

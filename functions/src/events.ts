/**
 * SP6 events/ticketing Task 4: the event and ticket-tier LIFECYCLE callables
 * (create/update an event, upsert its tiers, publish it). Every callable here
 * is Cloud-Functions-only per firestore.rules (`events/{eventId}` and its
 * `tiers` subcollection both read "allow write: if false"): this file is
 * the only writer.
 *
 * Guard chain on every callable, per the sub-project's binding rules:
 * requireAuthUid -> requireVerifiedEmail -> [pure content validation] ->
 * requireProfileMember(curatorProfileId, uid) -> requireApprovedCuratorProfile.
 * Deliberately NOT gated on requireCuratorChargeable anywhere in this file:
 * ticket money collects on the platform account, not a connected account, so
 * nothing here depends on the curator's Stripe Connect onboarding state.
 *
 * cancelEventCore at the bottom is a plain (non-onCall) helper only: Task 6
 * wraps it with the real `cancelEvent` callable (guards + the refund loop).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  isValidDocId, deriveEventGenres, tierProjection, SETTLEMENT_CLAIM_STALE_MS, GIG_ALREADY_PROMOTED_MESSAGE,
  ARTIST_TAG_UNKNOWN_MESSAGE,
  type AgeRestriction, type EventAct, type EventDoc, type GigDoc, type GigPublicLocation, type GigPrivateLocation,
  type TicketTierDoc, type CuratorSubtype, type CuratorDetails, type BookingRequestDoc, type ProfileDoc,
  type AttendeeDoc,
} from "@gatekeep/shared";
import {
  requireAuthUid, requireVerifiedEmail, requireProfileMember, requireApprovedCuratorProfile,
} from "./guards.js";
import {
  validateEventInput, validateTierInput, validateCuratorGenres, DEFAULT_MAX_TICKETS_PER_BUYER,
  EVENT_REMINDER_WINDOW_MS,
} from "./eventsCore.js";
import { resolveGigLocation, validateLocationInput, type GigLocationInput } from "./gigs.js";
import { geocoderApiKey } from "./geocode.js";
import { stripeSecretKey } from "./stripeClient.js";
import { refundOrdersForCancelledEvent, type CancelledEventOrdersResult } from "./ticketing.js";
import { notifyFollowers } from "./follows.js";
import { announceTargets, showAnnouncedNote, onTheBillNote, showRescheduledNote, notifyLineupMembers } from "./announce.js";
import { deriveLineupMusicianProfileIds, reconcileTaggedActs, notifyPendingTags } from "./eventArtistTags.js";

const MAX_TIERS_PER_EVENT = 20;

// events/{eventId}/private/address: the door address behind an event's
// public-precision location. Mirrors gigs/{id}/private/location's shape
// exactly (same fields, same optionality); see gigs.ts's GigPrivateLocation
// and the firestore.rules comment on this path's read gate.
export interface EventPrivateAddress {
  address: string; geo: { lat: number; lng: number } | null; geocodedFrom?: string;
}

export type EventSourceInput =
  // Reuses GigLocationInput verbatim (same shape createGig accepts):
  // location is optional here for the identical reason it's optional on
  // CreateGigInput: a venue profile falls back to its own profile address
  // when omitted (resolveGigLocation's job, shared with createGig).
  | { kind: "standalone"; location?: GigLocationInput }
  // Promoting a filled gig to an event: the gig's own public-precision
  // location + private address are copied verbatim, never re-geocoded.
  | { kind: "gig"; gigId: string };

export interface CreateEventInput {
  curatorProfileId: string; source: EventSourceInput;
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[]; posterPath?: string | null;
  curatorGenres?: string[];
  doorsAt?: number | null; ageRestriction?: AgeRestriction;
}

export interface UpdateEventInput {
  curatorProfileId: string; eventId: string;
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[]; posterPath?: string | null;
  curatorGenres?: string[];
  doorsAt?: number | null; ageRestriction?: AgeRestriction;
}

export interface SetEventTiersInput {
  curatorProfileId: string; eventId: string;
  tiers: Array<{
    tierId?: string; name: string; priceCents: number; capacity: number;
    saleStartsAt: number | null; saleEndsAt: number | null;
  }>;
}

export interface PublishEventInput { curatorProfileId: string; eventId: string; }

// Defensive-runtime shape check for the discriminated source union, same
// convention as eventsCore.ts's validators: the declared param type only
// binds a trusted caller, the actual onCall payload can be any JSON value.
function validateSourceInput(source: unknown): void {
  if (typeof source !== "object" || source === null) {
    throw new HttpsError("invalid-argument", "A source is required.");
  }
  const kind = (source as { kind?: unknown }).kind;
  if (kind === "standalone") {
    const v = validateLocationInput((source as { location?: unknown }).location);
    if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
    return;
  }
  if (kind === "gig") {
    if (!isValidDocId((source as { gigId?: unknown }).gigId)) {
      throw new HttpsError("invalid-argument", "A gig id is required.");
    }
    return;
  }
  throw new HttpsError("invalid-argument", 'Source kind must be "standalone" or "gig".');
}

// validateEventInput checks each act's kind/name only (it has no Firestore
// access to check further); this fills in the one extra thing worth
// checking without a DB read: a "booking" act's linkage ids are shaped like
// real doc ids, so a forged/garbage id doesn't silently ride along into
// lineupMusicianProfileIds (which Task 9's musician-page query trusts).
function validateLineupIdentity(lineup: EventAct[]): void {
  for (const act of lineup) {
    if (act.kind === "booking" && (!isValidDocId(act.bookingId) || !isValidDocId(act.musicianProfileId))) {
      throw new HttpsError("invalid-argument", "Invalid booking act.");
    }
  }
}

// validateLineupIdentity above only checks a booking act's ids LOOK like doc
// ids; it has no Firestore access to check they name a REAL relationship.
// Without this, a curator could fabricate { kind: "booking", bookingId:
// "<any doc id>", musicianProfileId: "<any real musician profile>" } with no
// actual booking behind it, and that id would land in
// lineupMusicianProfileIds, which Task 9's musician-page query trusts as
// proof the musician actually played this event, faking "X plays our venue"
// on musician X's own public page with zero real relationship. This loads
// every referenced booking (batched via getAll, same idiom SP5's sweep uses
// for a bounded id list, rather than one get() per act) and requires ALL of:
// the booking exists, it belongs to THIS curator profile, its
// musicianProfileId matches the act's, and it's "confirmed" (the one
// BookingStatus meaning an accepted, booked engagement; bookings.ts exports
// no broader status set that fits "booked", so this checks the single
// literal directly rather than inventing a grouping for one caller).
async function verifyLineupBookingActs(
  db: Firestore, curatorProfileId: string, lineup: EventAct[],
): Promise<void> {
  const bookingActs = lineup.filter(
    (act): act is Extract<EventAct, { kind: "booking" }> => act.kind === "booking");
  if (bookingActs.length === 0) return;

  const uniqueIds = [...new Set(bookingActs.map((act) => act.bookingId))];
  const snaps = await db.getAll(...uniqueIds.map((id) => db.doc(`bookings/${id}`)));
  const byId = new Map(snaps.map((snap) => [snap.id, snap]));

  for (const act of bookingActs) {
    const snap = byId.get(act.bookingId);
    if (!snap?.exists) {
      throw new HttpsError("failed-precondition", `Booking ${act.bookingId} does not exist.`);
    }
    const booking = snap.data() as BookingRequestDoc;
    if (booking.curatorProfileId !== curatorProfileId) {
      throw new HttpsError("failed-precondition",
        `Booking ${act.bookingId} does not belong to this curator profile.`);
    }
    if (booking.musicianProfileId !== act.musicianProfileId) {
      throw new HttpsError("failed-precondition",
        `Booking ${act.bookingId} does not name the musician profile given in the lineup.`);
    }
    if (booking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", `Booking ${act.bookingId} is not a confirmed booking.`);
    }
  }
}

// EventDoc.genres: the discovery-surface genre projection. A curator-set
// curatorGenres list always wins (deriveEventGenres's own precedence rule);
// otherwise this reads each booking act's profile once and derives the
// event's genres from the union of their portfolio genres.
export async function computeEventGenres(
  db: Firestore, lineup: EventAct[], curatorGenres: string[] | undefined,
): Promise<string[]> {
  if (curatorGenres && curatorGenres.length > 0) return deriveEventGenres([], curatorGenres);
  const ids = [...new Set(lineup.filter((a): a is Extract<EventAct, { kind: "booking" }> => a.kind === "booking")
    .map((a) => a.musicianProfileId))];
  const snaps = await Promise.all(ids.map((id) => db.doc(`profiles/${id}`).get()));
  const actGenres = snaps.map((s) => ((s.data() as ProfileDoc | undefined)?.portfolio?.genres ?? []));
  return deriveEventGenres(actGenres, null);
}

// posterPath, when set, must be a processed photo path belonging to THIS
// curator profile (a string-prefix check against publicPhotoPath's own
// shape, see storagePaths.ts): otherwise a curator could point an event at
// another profile's poster (or an unprocessed/nonexistent path). Omitted or
// null both mean "no poster" (createEvent's default; updateEvent's way to
// clear one, matching this callable family's full-replace convention).
function resolvePosterPath(posterPath: string | null | undefined, curatorProfileId: string): string | null {
  if (posterPath === undefined || posterPath === null) return null;
  if (typeof posterPath !== "string" || !posterPath.startsWith(`public/photos/${curatorProfileId}/poster-`)) {
    throw new HttpsError("invalid-argument", "Invalid poster path.");
  }
  return posterPath;
}

export const createEvent = onCall<CreateEventInput>(
  { region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.curatorProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile id is required.");
    }
    validateEventInput(input);
    validateLineupIdentity(input.lineup);
    // SP11: tags are created by tagEventArtist against a saved event, so a
    // create payload never carries one. Both editors disable the picker
    // until the event exists and say so.
    if (input.lineup.some((a) => a.kind === "tagged")) {
      throw new HttpsError("invalid-argument", ARTIST_TAG_UNKNOWN_MESSAGE);
    }
    validateSourceInput(input.source);
    const curatorGenres = validateCuratorGenres(input.curatorGenres);
    const posterPath = resolvePosterPath(input.posterPath, input.curatorProfileId);

    // sequential is deliberate, mirroring createGig's identical rationale:
    // parallelizing makes rejection order nondeterministic and would leak
    // profile existence/type/approval status to non-members.
    await requireProfileMember(input.curatorProfileId, uid);
    const profileSnap = await requireApprovedCuratorProfile(input.curatorProfileId);
    const profile = profileSnap.data()!;

    const db = getFirestore();
    await verifyLineupBookingActs(db, input.curatorProfileId, input.lineup);
    const genres = await computeEventGenres(db, input.lineup, curatorGenres);

    let location: GigPublicLocation;
    let privateAddress: EventPrivateAddress;
    let gigId: string | null = null;

    if (input.source.kind === "gig") {
      gigId = input.source.gigId;
      const gigSnap = await db.doc(`gigs/${gigId}`).get();
      if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
      const gig = gigSnap.data() as GigDoc;
      if (gig.curatorProfileId !== input.curatorProfileId) {
        throw new HttpsError("permission-denied", "That gig does not belong to this curator profile.");
      }
      if (gig.status !== "filled") {
        throw new HttpsError("failed-precondition", "Only a filled gig can be promoted to an event.");
      }
      // SP10 Task 21: a gig promotes to at most one live event. A cancelled
      // event does not block a fresh promotion (the curator may be re-running
      // the show); anything draft, published or completed does.
      const priorEvents = await db.collection("events").where("gigId", "==", gigId).get();
      if (priorEvents.docs.some((d) => (d.data() as EventDoc).status !== "cancelled")) {
        throw new HttpsError("failed-precondition", GIG_ALREADY_PROMOTED_MESSAGE);
      }
      location = gig.location;
      const privLocSnap = await db.doc(`gigs/${gigId}/private/location`).get();
      const privLoc = privLocSnap.data() as GigPrivateLocation | undefined;
      if (!privLoc) throw new HttpsError("internal", "This gig's location is missing.");
      privateAddress = { address: privLoc.address, geo: privLoc.geo, geocodedFrom: privLoc.geocodedFrom };
    } else {
      const subtype = profile.subtype as CuratorSubtype;
      const isVenue = subtype === "venue";
      const curatorLocation = profile.curator?.location as CuratorDetails["location"] | undefined;
      const { location: loc, privateLocation } = await resolveGigLocation(
        uid, isVenue, profile.name as string, curatorLocation, input.source.location);
      location = loc;
      privateAddress = {
        address: privateLocation.address, geo: privateLocation.geo, geocodedFrom: privateLocation.geocodedFrom,
      };
    }

    const now = Date.now();
    const eventRef = db.collection("events").doc();
    const event: EventDoc = {
      curatorProfileId: input.curatorProfileId,
      title: input.title.trim(), description: input.description.trim(),
      location, startsAt: input.startsAt, endsAt: input.endsAt,
      posterPath, status: "draft",
      maxTicketsPerBuyer: input.maxTicketsPerBuyer ?? DEFAULT_MAX_TICKETS_PER_BUYER,
      lineup: input.lineup, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(input.lineup),
      gigId, createdAt: now, updatedAt: now,
      doorsAt: input.doorsAt ?? null, ageRestriction: input.ageRestriction ?? "all_ages",
      genres, curatorGenres: curatorGenres ?? [], priceFromCents: null, hasFreeTier: false,
    };

    const batch = db.batch();
    batch.set(eventRef, event);
    batch.set(db.doc(`events/${eventRef.id}/private/address`), privateAddress);
    await batch.commit();

    return { eventId: eventRef.id };
  });

export const updateEvent = onCall<UpdateEventInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.curatorProfileId)) {
    throw new HttpsError("invalid-argument", "A curator profile id is required.");
  }
  if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
  // Re-validates the same content shape createEvent does. Notably this
  // includes validateEventInput's blanket "startsAt must be in the future"
  // check, which, applied here with no publish-status special-casing, IS
  // the enforcement of "a published event's startsAt can't move earlier than
  // now": there is no separate rule to write, this check already covers it
  // for a draft edit too (moving a draft's date into the past makes no more
  // sense than doing so for a published one).
  validateEventInput(input);
  validateLineupIdentity(input.lineup);
  const curatorGenres = validateCuratorGenres(input.curatorGenres);
  const posterPath = resolvePosterPath(input.posterPath, input.curatorProfileId);

  await requireProfileMember(input.curatorProfileId, uid);
  await requireApprovedCuratorProfile(input.curatorProfileId);

  const db = getFirestore();
  await verifyLineupBookingActs(db, input.curatorProfileId, input.lineup);
  const genres = await computeEventGenres(db, input.lineup, curatorGenres);

  const eventRef = db.doc(`events/${input.eventId}`);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = eventSnap.data() as EventDoc;
  // curatorProfileId/gigId are never accepted as update fields at all (see
  // this input type above); this cross-check just refuses a caller who is
  // a member of ProfileA from editing an event that actually belongs to
  // ProfileB by claiming ProfileA in the request.
  if (event.curatorProfileId !== input.curatorProfileId) {
    throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
  }
  if (event.status !== "draft" && event.status !== "published") {
    throw new HttpsError("failed-precondition", `Cannot edit an event in status "${event.status}".`);
  }

  // SP11: the client resends the whole lineup, tagged acts included. Their
  // status is server state, so every tagged entry is replaced by the stored
  // copy and an entry the server has never seen is refused.
  const lineup = reconcileTaggedActs(event.lineup ?? [], input.lineup);

  await eventRef.update({
    title: input.title.trim(), description: input.description.trim(),
    startsAt: input.startsAt, endsAt: input.endsAt,
    maxTicketsPerBuyer: input.maxTicketsPerBuyer ?? DEFAULT_MAX_TICKETS_PER_BUYER,
    lineup, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(lineup),
    posterPath, updatedAt: Date.now(),
    // Full-replace, like every other field on this callable: an omitted
    // doorsAt clears the door time and an omitted ageRestriction returns the
    // event to all ages, so the editors on both clients always resend both.
    doorsAt: input.doorsAt ?? null, ageRestriction: input.ageRestriction ?? "all_ages",
    genres, curatorGenres: curatorGenres ?? [],
  });

  // SP7 Task 5: fan-out on a published event's edit. Only applies once the
  // event is already public (a draft edit has no followers to tell yet).
  if (event.status === "published") {
    const updated: EventDoc = {
      ...event, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt,
      lineup, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(lineup), genres,
    };
    // A lineup addition announces only to the NEW act(s)' own followers.
    // announceTargets(updated) would re-notify the venue/genre followers who
    // already got the publish-time announce under this same key, so it is
    // deliberately not used here. This also tells the newly added act's own
    // profile members they're on the bill.
    const added = updated.lineupMusicianProfileIds.filter((id) => !event.lineupMusicianProfileIds.includes(id));
    if (added.length > 0) {
      // Best-effort, post-commit notification. A failure here must never
      // surface as an error on an already-committed lineup update.
      try {
        await notifyFollowers(added, showAnnouncedNote(input.eventId, updated), `announce:${input.eventId}`);
        await notifyLineupMembers(db, added, onTheBillNote(input.eventId, updated), `bill:${input.eventId}`);
      } catch (e) {
        console.error(`updateEvent: lineup-addition fan-out failed for event ${input.eventId}`, e);
      }
    }
    // A date change reaches every existing follower (venue/artist/genre) AND
    // every current valid/checked-in ticket holder, keyed per new date so a
    // second reschedule to a DIFFERENT date notifies again.
    // Compared at minute granularity, not raw milliseconds: the editor forms
    // on both platforms bind a minute-precision datetime control, so an
    // unchanged Save on an event whose stored startsAt carries seconds would
    // otherwise read as a reschedule and tell every follower and ticket
    // holder the show moved.
    const rescheduled = Math.floor(input.startsAt / 60_000) !== Math.floor(event.startsAt / 60_000);
    if (rescheduled) {
      // Best-effort, post-commit notification. A failure here must never
      // surface as an error on an already-committed reschedule.
      try {
        const attendees = await db.collection(`events/${input.eventId}/attendees`)
          .where("status", "in", ["valid", "checked_in"]).get();
        const holders = [...new Set(attendees.docs.map((a) => (a.data() as AttendeeDoc).ownerUid))];
        await notifyFollowers(announceTargets(updated), showRescheduledNote(input.eventId, updated, input.startsAt),
          `resched:${input.eventId}:${input.startsAt}`, holders);
      } catch (e) {
        console.error(`updateEvent: reschedule fan-out failed for event ${input.eventId}`, e);
      }
      // Re-arm the 24h reminder when the show moved back out of its window.
      // Not part of the try above: this is a real state change, not a
      // notification, and must still happen even if the fan-out above failed.
      if (event.reminderSentAt !== undefined && input.startsAt - Date.now() > EVENT_REMINDER_WINDOW_MS) {
        await eventRef.update({ reminderSentAt: FieldValue.delete() });
      }
    }
  }

  return { ok: true };
});

export const setEventTiers = onCall<SetEventTiersInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.curatorProfileId)) {
    throw new HttpsError("invalid-argument", "A curator profile id is required.");
  }
  if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
  if (!Array.isArray(input.tiers) || input.tiers.length < 1 || input.tiers.length > MAX_TIERS_PER_EVENT) {
    throw new HttpsError("invalid-argument", `An event must have 1-${MAX_TIERS_PER_EVENT} ticket tiers.`);
  }
  const seenIds = new Set<string>();
  for (const t of input.tiers) {
    validateTierInput(t);
    if (t.tierId !== undefined) {
      if (!isValidDocId(t.tierId)) throw new HttpsError("invalid-argument", "Invalid tier id.");
      if (seenIds.has(t.tierId)) throw new HttpsError("invalid-argument", "Duplicate tier id.");
      seenIds.add(t.tierId);
    }
  }

  await requireProfileMember(input.curatorProfileId, uid);
  await requireApprovedCuratorProfile(input.curatorProfileId);

  const db = getFirestore();
  const eventRef = db.doc(`events/${input.eventId}`);

  await db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    if (event.curatorProfileId !== input.curatorProfileId) {
      throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
    }
    if (event.status !== "draft" && event.status !== "published") {
      throw new HttpsError("failed-precondition", `Cannot set tiers on an event in status "${event.status}".`);
    }

    const tiersRef = eventRef.collection("tiers");
    const existingSnap = await tx.get(tiersRef);
    const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data() as TicketTierDoc]));

    for (const t of input.tiers) {
      if (t.tierId && !existingById.has(t.tierId)) {
        throw new HttpsError("invalid-argument", `Unknown ticket tier: ${t.tierId}.`);
      }
    }

    // Deletions: an existing tier omitted from this payload. Only legal
    // while the event is still a draft: once published, a tier's id may be
    // out there on an already-minted ticket/order, so it can only ever be
    // upserted (capacity/window/name edits), never removed.
    const keepIds = new Set(input.tiers.filter((t) => t.tierId).map((t) => t.tierId!));
    for (const [id] of existingById) {
      if (keepIds.has(id)) continue;
      if (event.status !== "draft") {
        throw new HttpsError("failed-precondition", "Tiers can only be removed while the event is a draft.");
      }
      tx.delete(tiersRef.doc(id));
    }

    // Upserts: sortOrder is always the tier's index in THIS payload (also
    // how a reorder is expressed); soldCount is preserved from the prior
    // doc for an existing tier, or starts at 0 for a new one, and a
    // capacity drop below an already-sold count is refused regardless of
    // draft/published (soldCount must never exceed capacity, independent of
    // the delete-while-draft-only rule above).
    input.tiers.forEach((t, index) => {
      const prior = t.tierId ? existingById.get(t.tierId) : undefined;
      if (prior && t.capacity < prior.soldCount) {
        throw new HttpsError("invalid-argument",
          `Capacity cannot drop below the ${prior.soldCount} tickets already sold for "${prior.name}".`);
      }
      const tier: TicketTierDoc = {
        name: t.name.trim(), priceCents: t.priceCents, capacity: t.capacity,
        soldCount: prior?.soldCount ?? 0,
        saleStartsAt: t.saleStartsAt ?? null, saleEndsAt: t.saleEndsAt ?? null,
        sortOrder: index,
      };
      tx.set(t.tierId ? tiersRef.doc(t.tierId) : tiersRef.doc(), tier);
    });

    const projection = tierProjection(input.tiers.map((t) => ({ priceCents: t.priceCents })));
    tx.update(eventRef, { updatedAt: Date.now(), ...projection });
  });

  return { ok: true };
});

export const publishEvent = onCall<PublishEventInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.curatorProfileId)) {
    throw new HttpsError("invalid-argument", "A curator profile id is required.");
  }
  if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");

  await requireProfileMember(input.curatorProfileId, uid);
  // Deliberately no requireCuratorChargeable here (or anywhere in this
  // file): ticket money collects on the platform Stripe account, not a
  // connected account, so publishing an event has no Stripe-onboarding
  // precondition, unlike publishGig's booking-money path.
  await requireApprovedCuratorProfile(input.curatorProfileId);

  const db = getFirestore();
  const eventRef = db.doc(`events/${input.eventId}`);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = eventSnap.data() as EventDoc;
  if (event.curatorProfileId !== input.curatorProfileId) {
    throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
  }
  if (event.status !== "draft") {
    throw new HttpsError("failed-precondition", `Cannot publish an event in status "${event.status}".`);
  }
  // Mirrors publishGig's P1 guard: a draft can sit unpublished indefinitely,
  // so without this a publish after startsAt has already elapsed would put
  // a bookable-looking "published" event for a date that already passed
  // onto the world-readable surface.
  if (event.startsAt < Date.now()) {
    throw new HttpsError("failed-precondition", "This event's date has already passed.");
  }

  const tiersSnap = await eventRef.collection("tiers").limit(1).get();
  if (tiersSnap.empty) {
    throw new HttpsError("failed-precondition", "Add at least one ticket tier before publishing.");
  }

  await eventRef.update({ status: "published", updatedAt: Date.now() });

  // SP7 Task 5: fan-out on publish. Followers of the venue, every lineup
  // act's musician profile, and the event's genres all hear "show
  // announced" once, keyed per event, so a later lineup addition's own
  // fan-out (see updateEvent below) never re-notifies these same fans.
  // Every lineup act's own profile members separately hear "you're on the
  // bill", under their own key.
  // Best-effort, post-commit notification. A failure here must never
  // surface as an error on an already-committed publish.
  try {
    const published: EventDoc = { ...event, status: "published" };
    await notifyFollowers(announceTargets(published), showAnnouncedNote(input.eventId, published), `announce:${input.eventId}`);
    await notifyLineupMembers(db, published.lineupMusicianProfileIds, onTheBillNote(input.eventId, published), `bill:${input.eventId}`);
    await notifyPendingTags(db, input.eventId, published);
  } catch (e) {
    console.error(`publishEvent: fan-out failed for event ${input.eventId}`, e);
  }

  return { ok: true };
});

// NOT an onCall export: the plain status-flip mechanics `cancelEvent` below
// wraps with the guard chain and the ticket-refund loop. paymentsSweep.ts's
// retry step never calls this directly (it only re-drives the refund loop
// for events already "cancelled", and this throws on any other status).
//
// REFUSED once `event.settlementStartedAt` is set (Task 7 fix round 1, money
// review Important 2). paymentsSweep.ts's T+1 ticket settlement stamps that
// field, transactionally, immediately before it transfers the event's ticket
// revenue to the curator, and this is the other half of that CAS: without
// this guard, a cancel landing in the gap between the transfer succeeding and
// the settlement's own completion write committing would refund every buyer
// on top of a transfer the curator already received, a double spend against
// the platform. An event that ended but has NOT yet reached settlement
// (settlementStartedAt still unset, whether or not it is even T+1 yet) is
// still cancellable, matching the "the show never happened" case this
// callable exists for.
//
// Also refused on a fresh `settlementClaimedAt` (SP10 Task 9); see
// paymentsSweep.ts's claimSettlementStart.
export async function cancelEventCore(eventId: string, now: number): Promise<void> {
  const db = getFirestore();
  const eventRef = db.doc(`events/${eventId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);
    if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = snap.data() as EventDoc;
    if (event.status !== "draft" && event.status !== "published") {
      throw new HttpsError("failed-precondition", `Cannot cancel an event in status "${event.status}".`);
    }
    if (event.settlementStartedAt != null) {
      throw new HttpsError("failed-precondition",
        "This event's ticket settlement has already started and can no longer be cancelled.");
    }
    // SP10 Task 9 (sp6 #14): a FRESH settlement claim means a transfer may be
    // in flight right now (or an ambiguous failure left its fate unknown); a
    // cancel that refunded buyers under it could double-spend against a
    // transfer that then lands. A stale claim (24h with no settlementStartedAt)
    // is a settlement that keeps failing, and the show is cancellable again.
    const claimedAt = event.settlementClaimedAt;
    if (claimedAt != null && now - claimedAt < SETTLEMENT_CLAIM_STALE_MS) {
      throw new HttpsError("failed-precondition",
        "This event's ticket settlement is in progress and it cannot be cancelled right now.");
    }
    tx.update(eventRef, { status: "cancelled", cancelledAt: now, updatedAt: now });
  });
}

export interface CancelEventInput { curatorProfileId: string; eventId: string; reason?: string; }

// Task 6: flips a draft/published event to "cancelled" (halting sales,
// since createTicketOrder checks status) and then refunds every affected order.
//
// IDEMPOTENT AT THE EVENT LEVEL, deliberately: a second call against an
// already-cancelled event skips the status flip (cancelEventCore only
// accepts draft/published, so calling it again would throw) and goes
// straight to re-driving the refund loop, which, for an event whose orders
// are all already "cancelled_refunded"/"expired", finds nothing left to do.
// This is the exact same idempotent function paymentsSweep.ts's retry step
// calls for any cancelled event that still has unresolved orders, so a
// curator retrying a failed cancel and the hourly sweep converge on
// identical behavior.
//
// `reason`, when given, is folded into the cancellation notification only.
// EventDoc carries no persisted cancel-reason field (nothing downstream reads
// one yet), so there is nothing else to store it on.
export const cancelEvent = onCall<CancelEventInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.curatorProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile id is required.");
    }
    if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) {
      throw new HttpsError("invalid-argument", "Invalid cancellation reason.");
    }

    await requireProfileMember(input.curatorProfileId, uid);
    await requireApprovedCuratorProfile(input.curatorProfileId);

    const db = getFirestore();
    const eventRef = db.doc(`events/${input.eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    if (event.curatorProfileId !== input.curatorProfileId) {
      throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
    }

    const now = Date.now();
    if (event.status !== "cancelled") {
      await cancelEventCore(input.eventId, now);
    }

    // Batched loop, not one transaction (binding money invariant): each
    // order resolves independently inside refundOrdersForCancelledEvent, so
    // one order's failure can never wedge another's, and a failure here is
    // escalated to adminAlerts rather than thrown back at the caller. The
    // event is cancelled either way, and the sweep's retry step finishes
    // whatever this call could not.
    await refundOrdersForCancelledEvent(input.eventId, event.title, now, input.reason);

    return { ok: true };
  });

// ---------------------------------------------------------------------------
// SP10 Task 10: moderation cancel + refund (events follow the profile)
// ---------------------------------------------------------------------------
// Copy holders see in the cancellation notification when a curator is
// unpublished (spec section 5.1). Fixed here so review.ts's cascade and
// scheduled.ts's retry step send the same words.
export const ORGANIZER_INACTIVE_REASON = "The organizer's account is no longer active";

export type ModerationActor =
  | { kind: "admin"; uid: string }
  | { kind: "system"; cause: "profile_unpublished" };

export interface ModerationCancelResult {
  outcome: "cancelled" | "already_cancelled" | "skipped_completed";
  orders: CancelledEventOrdersResult;
}

// eventCascadeRetries/{eventId}: written by review.ts when one event of the
// cascade throws, drained by dailySweep step 9. Server-only (firestore.rules).
export interface EventCascadeRetryDoc {
  profileId: string; reason: string; attempts: number; lastError: string; createdAt: number;
}

// The moderation twin of cancelEvent: no guard chain (the caller is an admin
// callable, the reject cascade, or the daily sweep), no curator-approval
// requirement (the whole point is that the curator is no longer approved),
// same two helpers in the same order. A completed event is untouched: its
// settlement has run and the show happened. Idempotent at the event level
// exactly like cancelEvent: an already-cancelled event skips the status flip
// and re-drives the refund loop. Per-order failures are escalated to
// adminAlerts inside refundOrdersForCancelledEvent and retried hourly by
// paymentsSweep's retryCancelledEventRefunds, so they do NOT throw here;
// only cancelEventCore's own refusal (settlement claimed, malformed doc)
// propagates, which is what lands an event in eventCascadeRetries.
export async function cancelAndRefundEventForModeration(
  eventId: string, reason: string, actor: ModerationActor,
): Promise<ModerationCancelResult> {
  const db = getFirestore();
  const snap = await db.doc(`events/${eventId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = snap.data() as EventDoc;
  const now = Date.now();
  const empty: CancelledEventOrdersResult = { ordersRefunded: 0, pendingExpired: 0, pendingDeferred: 0, errors: 0 };
  if (event.status === "completed") return { outcome: "skipped_completed", orders: empty };

  let outcome: ModerationCancelResult["outcome"] = "already_cancelled";
  if (event.status !== "cancelled") {
    await cancelEventCore(eventId, now);
    outcome = "cancelled";
  }
  const by = actor.kind === "admin" ? `admin ${actor.uid}` : actor.cause;
  console.info(`cancelAndRefundEventForModeration: event ${eventId} ${outcome} (${by})`);
  const orders = await refundOrdersForCancelledEvent(eventId, event.title, now, reason);
  return { outcome, orders };
}

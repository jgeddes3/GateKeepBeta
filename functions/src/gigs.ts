import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateGigContent, validateBudget, isValidDocId,
  MAX_OPEN_GIGS_PER_PROFILE,
  type GigContentInput, type GigBudget, type GigDoc, type GigPrivateLocation, type GigPublicLocation,
  type AddressVisibility, type CuratorSubtype, type CuratorDetails,
} from "@gatekeep/shared";
import {
  requireAuthUid, requireVerifiedEmail, requireProfileMember, requireApprovedCuratorProfile,
} from "./guards.js";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";
import { getGeocoder, coarsen, geocoderApiKey, consumeGeocodeBudget } from "./geocode.js";

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

const MAX_ADDRESS_LENGTH = 300;
export const GEOCODE_FAILURE_MESSAGE = "Could not locate that — check spelling and try again.";

// A gig's location input is always optional — createGig falls back to the
// curator's own profile address for venues (or requires it outright for
// non-venues); updateGig, when this is entirely omitted, leaves the gig's
// existing location untouched (no re-geocode).
export interface GigLocationInput {
  address?: string | null;
  addressVisibility?: AddressVisibility;
}

export interface CreateGigInput extends GigContentInput {
  profileId: string;
  budget: GigBudget;
  startsAt: number;
  location?: GigLocationInput;
}

export interface UpdateGigInput extends GigContentInput {
  gigId: string;
  budget: GigBudget;
  startsAt: number;
  location?: GigLocationInput;
}

export function validateLocationInput(loc: unknown): Result {
  if (loc === undefined) return { ok: true };
  if (typeof loc !== "object" || loc === null || Array.isArray(loc)) return fail("Invalid location.");
  const l = loc as GigLocationInput;
  if (l.address != null && (typeof l.address !== "string" || l.address.trim().length > MAX_ADDRESS_LENGTH)) {
    return fail(`Address must be a string of at most ${MAX_ADDRESS_LENGTH} characters.`);
  }
  if (l.addressVisibility !== undefined
      && l.addressVisibility !== "public" && l.addressVisibility !== "neighborhood") {
    return fail("Invalid address visibility.");
  }
  return { ok: true };
}

function isValidStartsAt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// Shared "input validation" step (title/description/wants/duration/provisions
// + budget + startsAt + location shape) for both createGig and updateGig —
// runs BEFORE any authz guard, matching the ordering convention. Subtype-
// dependent business rules (venue-vs-non-venue address requirement) can't
// live here: they need the profile's subtype, only known once a guard below
// has read the profile.
function validateGigInput(input: CreateGigInput | UpdateGigInput): Result {
  const content = validateGigContent(input);
  if (!content.ok) return content;
  const budget = validateBudget(input.budget);
  if (!budget.ok) return budget;
  if (!isValidStartsAt(input.startsAt)) return fail("A valid start time is required.");
  return validateLocationInput(input.location);
}

// Location resolution shared by createGig and createSeries (a series'
// template stores the exact same resolved public/private split a one-off
// gig does — Task 7's materializer copies it onto each occurrence without
// re-geocoding). Not reused by updateGig/updateSeries: an update additionally
// supports a "visibility-only, reuse the already-exact private address"
// branch that doesn't fit this always-(re)geocode shape.
export async function resolveGigLocation(
  uid: string,
  isVenue: boolean,
  venueName: string,
  curatorLocation: CuratorDetails["location"] | undefined,
  locationInput: GigLocationInput | undefined,
): Promise<{ location: GigPublicLocation; privateLocation: GigPrivateLocation }> {
  const overrideAddress = typeof locationInput?.address === "string" ? locationInput.address.trim() : "";
  let resolvedAddress: string;
  if (overrideAddress.length > 0) {
    resolvedAddress = overrideAddress;
  } else if (isVenue) {
    // Approved venue profiles always have an address (submitProfileForReview's
    // gate requires one) — this is a defensive backstop, not a normal path.
    if (!curatorLocation?.address) {
      throw new HttpsError("failed-precondition", "This venue profile has no address set yet.");
    }
    resolvedAddress = curatorLocation.address;
  } else {
    throw new HttpsError("invalid-argument", "An address is required for this gig.");
  }

  const defaultVisibility: AddressVisibility = isVenue ? "public" : "neighborhood";
  const visibility = locationInput?.addressVisibility ?? defaultVisibility;

  // S2: this path always creates a brand-new gig/series doc (no prior
  // private location to compare against), so it always consumes the daily
  // geocode budget — the "skip when unchanged" optimization only applies to
  // updateGig/updateSeries's re-submission case below.
  await consumeGeocodeBudget(uid);
  const result = await getGeocoder().geocode(resolvedAddress);
  if (!result) throw new HttpsError("invalid-argument", GEOCODE_FAILURE_MESSAGE);

  const publicGeo = visibility === "public" ? { lat: result.lat, lng: result.lng } : coarsen(result);
  const location: GigPublicLocation = {
    venueName: isVenue ? venueName : null, neighborhood: result.neighborhood, city: result.city,
    geo: publicGeo, addressVisibility: visibility,
    address: visibility === "public" ? resolvedAddress : null,
  };
  const privateLocation: GigPrivateLocation = {
    address: resolvedAddress, geo: { lat: result.lat, lng: result.lng }, geocodedFrom: resolvedAddress,
  };
  return { location, privateLocation };
}

export const createGig = onCall<CreateGigInput>({ region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
  const v = validateGigInput(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  // sequential is deliberate — mirrors updateCuratorProfile's rationale:
  // parallelizing makes rejection order nondeterministic and would leak
  // profile existence/type/approval status to non-members.
  await requireProfileMember(input.profileId, uid);
  const profileSnap = await requireApprovedCuratorProfile(input.profileId);
  const profile = profileSnap.data()!;
  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const curatorLocation = profile.curator?.location as CuratorDetails["location"] | undefined;

  const { location, privateLocation } = await resolveGigLocation(
    uid, isVenue, profile.name as string, curatorLocation, input.location);

  const now = Date.now();
  const db = getFirestore();
  const gigRef = db.collection("gigs").doc();
  const gig: GigDoc = {
    curatorProfileId: input.profileId, seriesId: null, detachedFromTemplate: false,
    title: input.title.trim(), description: input.description.trim(),
    wants: { genres: input.wants.genres, actSizes: input.wants.actSizes },
    budget: { minCents: input.budget.minCents, maxCents: input.budget.maxCents, structure: input.budget.structure },
    startsAt: input.startsAt, durationMinutes: input.durationMinutes,
    provisions: {
      hasPA: input.provisions.hasPA ?? null, hasBackline: input.provisions.hasBackline ?? null,
      notes: input.provisions.notes ?? null,
    },
    location,
    status: "draft", createdAt: now, updatedAt: now,
  };

  const batch = db.batch();
  batch.set(gigRef, gig);
  batch.set(db.doc(`gigs/${gigRef.id}/private/location`), privateLocation);
  await batch.commit();

  return { gigId: gigRef.id };
});

export const publishGig = onCall<{ gigId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { gigId } = req.data;
  if (!isValidDocId(gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");

  const db = getFirestore();
  const gigRef = db.doc(`gigs/${gigId}`);
  const gigSnap = await gigRef.get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;
  await requireProfileMember(gig.curatorProfileId, uid);
  // A profile can be rejected/unpublished after a gig was created against it
  // (Task 6 lands the cascade that closes/pauses live gigs+series on that
  // event, but until it runs — or for a gig created before it existed — a
  // member of a no-longer-approved profile must not be able to publish new
  // content into the world-readable "open" surface).
  await requireApprovedCuratorProfile(gig.curatorProfileId);
  if (gig.status !== "draft") {
    throw new HttpsError("failed-precondition", `Cannot publish a gig in status "${gig.status}".`);
  }
  // P1: a draft can sit unpublished indefinitely (e.g. drafted, then
  // abandoned) — without this check, publishing it after its startsAt has
  // already elapsed would put a bookable-looking "open" gig for a date that
  // already passed onto the world-readable surface, where it would then sit
  // until the NEXT day's sweep finally closes it (up to a 24h window).
  if (gig.startsAt < Date.now()) {
    throw new HttpsError("failed-precondition", "This gig's date has already passed.");
  }

  const openCount = await db.collection("gigs")
    .where("curatorProfileId", "==", gig.curatorProfileId)
    .where("status", "==", "open")
    .count().get();
  if (openCount.data().count >= MAX_OPEN_GIGS_PER_PROFILE) {
    throw new HttpsError("resource-exhausted",
      `A profile may have at most ${MAX_OPEN_GIGS_PER_PROFILE} open gigs.`);
  }

  await gigRef.update({ status: "open", updatedAt: Date.now() });
  return { ok: true };
});

export const updateGig = onCall<UpdateGigInput>({ region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  if (!isValidDocId(input?.gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");
  const v = validateGigInput(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  const db = getFirestore();
  const gigRef = db.doc(`gigs/${input.gigId}`);
  const gigSnap = await gigRef.get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;

  await requireProfileMember(gig.curatorProfileId, uid);
  // Same rationale as publishGig: a member of a since-rejected/unpublished
  // profile must not keep editing a (possibly still world-readable "open")
  // gig's content. cancelGig deliberately keeps membership-only — cancelling
  // only narrows exposure, it never adds any.
  await requireApprovedCuratorProfile(gig.curatorProfileId);
  if (gig.status === "cancelled" || gig.status === "taken_down") {
    throw new HttpsError("failed-precondition", `Cannot edit a gig in status "${gig.status}".`);
  }

  const privateRef = db.doc(`gigs/${input.gigId}/private/location`);
  let publicLocation = gig.location;
  let privateLocation: GigPrivateLocation | undefined;

  if (input.location !== undefined) {
    const overrideAddress = typeof input.location.address === "string" ? input.location.address.trim() : "";
    const newVisibility = input.location.addressVisibility ?? gig.location.addressVisibility;
    let resolvedAddress: string; let lat: number; let lng: number;
    let neighborhood: string | null; let city: string; let geocodedFrom: string;

    if (overrideAddress.length > 0) {
      const currentPrivate = (await privateRef.get()).data() as GigPrivateLocation | undefined;
      if (currentPrivate?.geocodedFrom === overrideAddress) {
        // S2: unchanged address input — reuse the already-resolved geocode
        // rather than re-querying (and re-charging the daily budget for)
        // the exact same address a member just re-submitted.
        if (!currentPrivate.geo) {
          throw new HttpsError("internal", "This gig's stored location is missing coordinates.");
        }
        resolvedAddress = overrideAddress; lat = currentPrivate.geo.lat; lng = currentPrivate.geo.lng;
        neighborhood = gig.location.neighborhood; city = gig.location.city; geocodedFrom = overrideAddress;
      } else {
        // Address change — re-geocode.
        await consumeGeocodeBudget(uid);
        const result = await getGeocoder().geocode(overrideAddress);
        if (!result) throw new HttpsError("invalid-argument", GEOCODE_FAILURE_MESSAGE);
        resolvedAddress = overrideAddress; lat = result.lat; lng = result.lng;
        neighborhood = result.neighborhood; city = result.city; geocodedFrom = overrideAddress;
      }
    } else {
      // Visibility-only change (or a no-op location object) — reuse the
      // already-exact private geo/address rather than re-geocoding.
      const currentPrivate = (await privateRef.get()).data() as GigPrivateLocation;
      // P7: explicit guard instead of a `.geo!` non-null assertion — a
      // corrupted/partially-written private/location subdoc must surface a
      // clear internal error here, not an uncaught TypeError on `.lat`.
      if (!currentPrivate.geo) {
        throw new HttpsError("internal", "This gig's stored location is missing coordinates.");
      }
      resolvedAddress = currentPrivate.address;
      lat = currentPrivate.geo.lat; lng = currentPrivate.geo.lng;
      neighborhood = gig.location.neighborhood; city = gig.location.city;
      geocodedFrom = currentPrivate.geocodedFrom ?? currentPrivate.address;
    }

    const publicGeo = newVisibility === "public" ? { lat, lng } : coarsen({ lat, lng, neighborhood, city });
    publicLocation = {
      venueName: gig.location.venueName, neighborhood, city,
      geo: publicGeo, addressVisibility: newVisibility,
      address: newVisibility === "public" ? resolvedAddress : null,
    };
    privateLocation = { address: resolvedAddress, geo: { lat, lng }, geocodedFrom };
  }

  const updates: Partial<GigDoc> = {
    title: input.title.trim(), description: input.description.trim(),
    wants: { genres: input.wants.genres, actSizes: input.wants.actSizes },
    budget: { minCents: input.budget.minCents, maxCents: input.budget.maxCents, structure: input.budget.structure },
    startsAt: input.startsAt, durationMinutes: input.durationMinutes,
    provisions: {
      hasPA: input.provisions.hasPA ?? null, hasBackline: input.provisions.hasBackline ?? null,
      notes: input.provisions.notes ?? null,
    },
    location: publicLocation,
    updatedAt: Date.now(),
    // A direct edit detaches a series occurrence from its template — it
    // stops receiving the template's future edits (spec §4).
    ...(gig.seriesId ? { detachedFromTemplate: true } : {}),
  };

  const batch = db.batch();
  batch.update(gigRef, updates);
  if (privateLocation) batch.set(privateRef, privateLocation);
  await batch.commit();

  return { ok: true };
});

export const cancelGig = onCall<{ gigId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { gigId } = req.data;
  if (!isValidDocId(gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");

  const gigRef = getFirestore().doc(`gigs/${gigId}`);
  const gigSnap = await gigRef.get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;
  await requireProfileMember(gig.curatorProfileId, uid);
  if (gig.status !== "draft" && gig.status !== "open") {
    throw new HttpsError("failed-precondition", `Cannot cancel a gig in status "${gig.status}".`);
  }

  await gigRef.update({ status: "cancelled", updatedAt: Date.now() });
  return { ok: true };
});

export interface TakedownGigInput { gigId: string; scope: "occurrence" | "series"; reason: string; }

export const takedownGig = onCall<TakedownGigInput>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { gigId, scope, reason } = req.data ?? ({} as TakedownGigInput);
  if (!isValidDocId(gigId)) throw new HttpsError("invalid-argument", "A gig id is required.");
  if (scope !== "occurrence" && scope !== "series") {
    throw new HttpsError("invalid-argument", 'Scope must be "occurrence" or "series".');
  }
  if (typeof reason !== "string" || reason.trim().length < 1 || reason.trim().length > 500) {
    throw new HttpsError("invalid-argument", "A reason (1-500 characters) is required.");
  }
  const trimmedReason = reason.trim();

  const db = getFirestore();
  const gigRef = db.doc(`gigs/${gigId}`);
  const gigSnap = await gigRef.get();
  if (!gigSnap.exists) throw new HttpsError("not-found", "Gig not found.");
  const gig = gigSnap.data() as GigDoc;
  if (gig.status === "taken_down") {
    throw new HttpsError("failed-precondition", "That gig has already been taken down.");
  }
  if (scope === "series" && !gig.seriesId) {
    throw new HttpsError("failed-precondition", "That gig isn't part of a series.");
  }

  const now = Date.now();
  const batch = db.batch();
  batch.update(gigRef, { status: "taken_down", updatedAt: now });

  let siblingsAffected = 0;
  if (scope === "series") {
    const seriesRef = db.doc(`gigSeries/${gig.seriesId}`);
    batch.update(seriesRef, { status: "paused", updatedAt: now });
    // P11: sweeps status=="open" siblings only, by design — as of this
    // wave the materializer (scheduled.ts) only ever creates occurrences
    // directly into "open", so every currently-live occurrence of a series
    // is reachable this way. This narrows automatically if a future gig
    // status is introduced (e.g. sub-4's "filled"/booked state) that is
    // ALSO publicly/live-reachable without being "open" — revisit this
    // filter then, or a series takedown will silently leave such
    // occurrences up.
    const siblingsSnap = await db.collection("gigs")
      .where("seriesId", "==", gig.seriesId)
      .where("status", "==", "open")
      .get();
    for (const doc of siblingsSnap.docs) {
      if (doc.id === gigId) continue; // this occurrence is already handled above
      batch.update(doc.ref, { status: "taken_down", updatedAt: now });
      siblingsAffected++;
    }
  }
  await batch.commit();

  await writeAudit({
    actorUid, action: "gig_taken_down", targetId: gigId,
    detail: `[${scope}] ${trimmedReason}`,
  });

  const scopeNote = scope === "series"
    ? ` This series' other open dates (${siblingsAffected}) were also taken down, and the series was paused.`
    : "";
  await notifyProfileMembers(gig.curatorProfileId, {
    kind: "gig_moderation",
    title: `Your gig "${gig.title}" was taken down`,
    body: `Reviewer note: ${trimmedReason}${scopeNote}`,
  });

  return { ok: true };
});

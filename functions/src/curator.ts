import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import {
  validateLookingFor, isValidDocId,
  MAX_ABOUT_LENGTH, MAX_ADDRESS_LENGTH, MAX_CITY_LENGTH, MAX_AMENITY_NOTES_LENGTH, MAX_CAPACITY,
  type CuratorDetails, type LookingFor, type CuratorSubtype,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireCuratorProfile } from "./guards.js";
import { getGeocoder, geocoderApiKey, consumeGeocodeBudget } from "./geocode.js";
import { bucket, logDeleteFailure } from "./storage.js";

type Amenities = CuratorDetails["amenities"];
type CuratorLocationInput = { address: string | null; city: string };

export interface CuratorProfileUpdateInput {
  profileId: string;
  about?: string;
  lookingFor?: LookingFor;
  amenities?: Amenities;
  advertisingInterest?: boolean;
  location?: CuratorLocationInput;
}

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

// MAX_ABOUT_LENGTH / MAX_ADDRESS_LENGTH / MAX_CITY_LENGTH /
// MAX_AMENITY_NOTES_LENGTH / MAX_CAPACITY now live in @gatekeep/shared so
// client forms (web + mobile) validate against the exact same numbers
// instead of re-declared copies that could drift from this server gate.
const INDOOR_OUTDOOR_VALUES = ["indoor", "outdoor", "both"] as const;

// Field-shape/type/range validation only. The venue-vs-non-venue address
// rule needs the profile's subtype, which is only known once
// requireCuratorProfile has read the doc (after membership is established
// below), checking it here would mean reading the profile before we know
// the caller is even a member, the same existence/type-leak concern
// portfolio.ts's updatePortfolio documents for its own guard ordering.
function validateCuratorUpdate(input: CuratorProfileUpdateInput): Result {
  if (typeof input !== "object" || input === null) return fail("Invalid curator profile update.");
  if (!isValidDocId(input.profileId)) return fail("Invalid profile id.");
  if (input.about === undefined && input.lookingFor === undefined && input.amenities === undefined
      && input.advertisingInterest === undefined && input.location === undefined) {
    return fail("Nothing to update.");
  }
  if (input.about !== undefined) {
    if (typeof input.about !== "string" || input.about.length > MAX_ABOUT_LENGTH) {
      return fail(`About must be a string of at most ${MAX_ABOUT_LENGTH} characters.`);
    }
  }
  if (input.lookingFor !== undefined) {
    const v = validateLookingFor(input.lookingFor);
    if (!v.ok) return v;
  }
  if (input.amenities !== undefined) {
    const a = input.amenities;
    if (typeof a !== "object" || a === null || Array.isArray(a)) return fail("Invalid amenities.");
    if (a.capacity != null && (typeof a.capacity !== "number" || !Number.isInteger(a.capacity)
        || a.capacity < 0 || a.capacity > MAX_CAPACITY)) {
      return fail("Capacity must be a non-negative whole number.");
    }
    if (a.hasPA != null && typeof a.hasPA !== "boolean") return fail("Invalid PA answer.");
    if (a.hasBackline != null && typeof a.hasBackline !== "boolean") return fail("Invalid backline answer.");
    if (a.indoorOutdoor != null && !(INDOOR_OUTDOOR_VALUES as readonly string[]).includes(a.indoorOutdoor)) {
      return fail("Invalid indoor/outdoor answer.");
    }
    if (a.notes != null && (typeof a.notes !== "string" || a.notes.length > MAX_AMENITY_NOTES_LENGTH)) {
      return fail(`Amenity notes must be at most ${MAX_AMENITY_NOTES_LENGTH} characters.`);
    }
  }
  if (input.advertisingInterest !== undefined && typeof input.advertisingInterest !== "boolean") {
    return fail("Invalid advertising interest answer.");
  }
  if (input.location !== undefined) {
    const loc = input.location;
    if (typeof loc !== "object" || loc === null || Array.isArray(loc)) return fail("Invalid location.");
    if (typeof loc.city !== "string" || loc.city.trim().length < 1 || loc.city.trim().length > MAX_CITY_LENGTH) {
      return fail(`City is required (1-${MAX_CITY_LENGTH} characters).`);
    }
    if (loc.address != null && (typeof loc.address !== "string" || loc.address.trim().length > MAX_ADDRESS_LENGTH)) {
      return fail(`Address must be a string of at most ${MAX_ADDRESS_LENGTH} characters.`);
    }
  }
  return { ok: true };
}

export const updateCuratorProfile = onCall<CuratorProfileUpdateInput>(
  { region: "us-central1", secrets: [geocoderApiKey] }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateCuratorUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate, parallelizing makes rejection order
  // nondeterministic and would leak profile existence/type to non-members
  // (mirrors updatePortfolio's identical rationale in portfolio.ts).
  await requireProfileMember(input.profileId, uid);
  const snap = await requireCuratorProfile(input.profileId);
  const subtype = snap.data()?.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";

  // Venues geocode their full street address (public); planners/hosts only
  // ever geocode the city string, and always store a null address and
  // neighborhood, a city-level pin, not a precise one.
  let locationUpdate: CuratorDetails["location"] | undefined;
  if (input.location !== undefined) {
    const { address, city } = input.location;
    const trimmedAddress = typeof address === "string" ? address.trim() : "";
    const hasAddress = trimmedAddress.length > 0;
    if (!isVenue && hasAddress) {
      throw new HttpsError("invalid-argument", "Only venues can set a street address.");
    }
    const query = isVenue && hasAddress ? trimmedAddress : city.trim();
    const currentLocation = snap.data()?.curator?.location as CuratorDetails["location"] | undefined;
    if (currentLocation?.geocodedFrom === query) {
      // S2: unchanged input, the caller re-submitted the exact same
      // address/city that already produced the stored geo. Reuse it as-is
      // rather than paying for a geocode call (and its daily budget charge)
      // that would just re-derive the same result, a curator re-saving
      // other fields (about/amenities/etc.) alongside an untouched location
      // must not cost a geocode every time.
      locationUpdate = currentLocation;
    } else {
      await consumeGeocodeBudget(uid);
      const result = await getGeocoder().geocode(query);
      if (!result) {
        throw new HttpsError("invalid-argument", "Could not locate that. Check spelling and try again.");
      }
      locationUpdate = isVenue && hasAddress
        ? { address: trimmedAddress, city: result.city, neighborhood: result.neighborhood,
            geo: { lat: result.lat, lng: result.lng }, geocodedFrom: query }
        : { address: null, city: result.city, neighborhood: null,
            geo: { lat: result.lat, lng: result.lng }, geocodedFrom: query };
    }
  }

  // Dotted-string-keys form (mirrors updatePortfolio): merges into the
  // curator map without clobbering fields this update didn't touch,
  // notably curator.photoPaths, which the photo pipeline owns.
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.about !== undefined) updates["curator.about"] = input.about.trim();
  if (input.lookingFor !== undefined) {
    updates["curator.lookingFor"] = {
      genres: input.lookingFor.genres, actSizes: input.lookingFor.actSizes, notes: input.lookingFor.notes ?? null,
    };
  }
  if (input.amenities !== undefined) {
    const a = input.amenities;
    updates["curator.amenities"] = {
      capacity: a.capacity ?? null, hasPA: a.hasPA ?? null, hasBackline: a.hasBackline ?? null,
      indoorOutdoor: a.indoorOutdoor ?? null, notes: a.notes ?? null,
    };
  }
  if (input.advertisingInterest !== undefined) updates["curator.advertisingInterest"] = input.advertisingInterest;
  if (locationUpdate !== undefined) updates["curator.location"] = locationUpdate;

  await getFirestore().doc(`profiles/${input.profileId}`).update(updates);
  return { ok: true };
});

// Companion to media.ts's processPhoto "gallery" branch, which only ever
// APPENDS (there's no client-driven overwrite for a gallery array the way
// avatar/cover overwrite-and-delete-old is automatic). A member removes a
// specific photo explicitly; this is the only path that ever deletes a
// public/photos/{profileId}/gallery-... object once it lands.
export const removeCuratorPhoto = onCall<{ profileId: string; path: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, path } = req.data;
    if (!isValidDocId(profileId) || typeof path !== "string" || path.length < 1 || path.length > 300) {
      throw new HttpsError("invalid-argument", "A profile id and photo path are required.");
    }
    // Defense-in-depth path-prefix assertion: storage.rules already confines
    // uploads under this exact prefix, so this is currently unreachable via
    // any legitimate write path, but validating shape before authz (the
    // ordering convention) means a malformed/foreign path is rejected before
    // ever touching the membership check below, rather than relying solely
    // on the array-membership lookup to no-op on it.
    if (!path.startsWith(`public/photos/${profileId}/gallery-`)) {
      throw new HttpsError("invalid-argument", "Invalid photo path.");
    }
    // sequential is deliberate, parallelizing makes rejection order
    // nondeterministic and would leak profile existence/type to non-members
    // (mirrors updateCuratorProfile's identical rationale above).
    await requireProfileMember(profileId, uid);
    const snap = await requireCuratorProfile(profileId);
    const photoPaths = (snap.data()?.curator as CuratorDetails | undefined)?.photoPaths ?? [];
    if (!photoPaths.includes(path)) {
      throw new HttpsError("not-found", "That photo isn't on this profile.");
    }
    // arrayRemove (not a read-filter-write of the array snapshot above) so a
    // concurrent processPhoto append landing between the read and this write
    // isn't clobbered, it removes every occurrence of `path` and no-ops if
    // it's already gone, rather than overwriting the whole array with a
    // possibly-stale copy.
    await getFirestore().doc(`profiles/${profileId}`).update({
      "curator.photoPaths": FieldValue.arrayRemove(path),
      updatedAt: Date.now(),
    });
    // Best-effort storage delete, log and continue if the object is
    // already gone (matches deleteProfile's cascade cleanup style).
    await bucket().file(path).delete().catch(logDeleteFailure("removeCuratorPhoto", "gallery photo", path));
    return { ok: true };
  });

// curatorAccess/{uid} maintenance (Task 6). The marker answers one question
//, "does this uid currently belong to >=1 APPROVED curator profile?", for
// firestore.rules' isApprovedCuratorMember() (see its comment there for why
// this can't live on a custom claim: profile-approval status changes can't
// force a token refresh). This is the RECOMPUTE path: a collection-group
// scan of every `members` doc for this uid, resolved against each matching
// profile's live type+status, so it stays correct when a uid belongs to
// more than one curator profile (losing access to one must not clear a
// marker still earned via another). Call sites that KNOW the answer can
// only go one direction (e.g. reviewProfile's approve, respondToInvite's
// accept, membership/approval can only be newly GAINING access at that
// instant) use a direct `.set({})` fast path instead; every call site where
// access could have been LOST (reviewProfile's reject-from-approved,
// removeMember) must use this recompute.
// SP4 (Task 13 item 7): pages the memberships collection-group scan
// (100/page, cursor loop) instead of one unbounded `.get()`, a uid that
// belongs to many profiles across the app's lifetime (many bands, many
// curator profiles) is unbounded, same defensive-pagination rationale as
// scheduled.ts's own `paginate()` helper. Behavior-preserving: still visits
// EVERY membership doc for this uid before deciding hasApprovedCurator, just
// PAGE_SIZE at a time. Not reused from scheduled.ts directly (that module
// imports THIS one, syncCuratorAccess is a step-5 call site, so importing
// back would cycle); the loop is small enough to duplicate locally.
const MEMBERSHIP_SCAN_PAGE_SIZE = 100;

export async function syncCuratorAccess(uid: string): Promise<void> {
  // SP4 (Task 13 item 1): a malformed uid reaching this far (currently only
  // reachable via the daily sweep's curatorAccessRetries retry queue, see
  // scheduled.ts step 5, itself only admin-SDK-writable, never client-
  // writable) must fail loudly and distinctly rather than silently
  // misbehaving against `curatorAccess/{uid}` / the membership query below.
  if (!isValidDocId(uid)) {
    throw new Error(`syncCuratorAccess: invalid uid "${String(uid)}"`);
  }
  const db = getFirestore();
  const profileIds: string[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let page = db.collectionGroup("members").where("uid", "==", uid)
      .orderBy(FieldPath.documentId()).limit(MEMBERSHIP_SCAN_PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const profileId = d.ref.parent.parent?.id;
      if (profileId) profileIds.push(profileId);
    }
    if (snap.docs.length < MEMBERSHIP_SCAN_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  let hasApprovedCurator = false;
  for (const profileId of profileIds) {
    const p = await db.doc(`profiles/${profileId}`).get();
    const data = p.data();
    if (data?.type === "curator" && data?.status === "approved") { hasApprovedCurator = true; break; }
  }
  const ref = db.doc(`curatorAccess/${uid}`);
  // Presence-only marker, contents never read (firestore.rules'
  // isApprovedCuratorMember() only checks exists()), so an empty object is
  // the whole payload.
  if (hasApprovedCurator) await ref.set({});
  else await ref.delete();
}

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioUpdateInput, type BookingUpdateInput, type BookingDoc, type RateAmount, type PortfolioData,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";
import { rebuildBookingProjections } from "./bookingVisibility.js";

// Strips any extra/untrusted keys off a rate object and normalizes an
// absent (undefined) rate the same as an explicit null. Without this, a
// member could persist arbitrary extra keys/nested JSON into
// private/booking by reference, and `note` could end up absent from the
// stored doc even though RateAmount promises it present-and-nullable.
const rate = (r: RateAmount | null | undefined): RateAmount | null =>
  r == null ? null : { amountCents: r.amountCents, note: r.note ?? null };

export const updatePortfolio = onCall<PortfolioUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validatePortfolioUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate, parallelizing makes rejection order
  // nondeterministic and would leak profile existence/type to non-members
  await requireProfileMember(input.profileId, uid);
  const snap = await requireMusicianProfile(input.profileId);

  // Dotted-string-keys form: the Admin SDK treats dotted string keys in a
  // plain object passed to update() as field paths, so this merges into the
  // portfolio map without clobbering the photo paths the media pipeline owns.
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.bio !== undefined) updates["portfolio.bio"] = input.bio.trim();
  if (input.genres !== undefined) updates["portfolio.genres"] = input.genres;
  // Explicit mapping: stores only the validated fields (an untrusted link object
  // could carry extra keys) and the trimmed URL the validator actually checked.
  if (input.externalLinks !== undefined) {
    updates["portfolio.externalLinks"] = input.externalLinks.map((l) => ({ kind: l.kind, url: l.url.trim() }));
  }

  // Legacy data: profiles created before the portfolio seed (Task 5) may lack
  // the portfolio map entirely, or hold only a partial map (e.g. the media
  // pipeline wrote avatarPhotoPath before any updatePortfolio call ever
  // ran). Backfill is field-wise, not map-level, so a partial legacy map
  // still ends up complete, and photo paths are only null-defaulted when
  // genuinely absent, never clobbered.
  const pf = snap.data()?.portfolio as Partial<PortfolioData> | undefined;
  if (input.bio === undefined && pf?.bio === undefined) updates["portfolio.bio"] = "";
  if (input.genres === undefined && pf?.genres === undefined) updates["portfolio.genres"] = [];
  if (input.externalLinks === undefined && pf?.externalLinks === undefined) updates["portfolio.externalLinks"] = [];
  if (pf?.avatarPhotoPath === undefined) updates["portfolio.avatarPhotoPath"] = null;
  if (pf?.coverPhotoPath === undefined) updates["portfolio.coverPhotoPath"] = null;

  await getFirestore().doc(`profiles/${input.profileId}`).update(updates);
  return { ok: true };
});

export const updateBookingInfo = onCall<BookingUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validateBookingUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate, parallelizing makes rejection order
  // nondeterministic and would leak profile existence/type to non-members
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);
  // Normalize absent → null and strip untrusted extra keys via `rate()`:
  // the validator accepts omitted keys, the stored BookingDoc promises
  // present-and-nullable, and Firestore rejects `undefined`.
  const docData: BookingDoc = {
    rates: {
      perHour: rate(input.rates.perHour),
      perSong: rate(input.rates.perSong),
      perSet: rate(input.rates.perSet),
    },
    preferences: {
      gigTypes: input.preferences.gigTypes,
      travelRadiusKm: input.preferences.travelRadiusKm ?? null,
      actSize: input.preferences.actSize ?? null,
      typicalSetMinutes: input.preferences.typicalSetMinutes ?? null,
      bringsOwnPA: input.preferences.bringsOwnPA ?? null,
      availabilityPattern: input.preferences.availabilityPattern ?? null,
    },
    // validateBookingUpdate (validateBookingVisibility) already confirmed
    // this carries exactly the four legal keys with in-set values, the
    // callable always writes a complete visibility going forward; legacy
    // docs written before this field existed are converged by
    // backfillBookingVisibility (Task 3).
    visibility: input.visibility,
    updatedAt: Date.now(),
  };
  // full-doc last-write-wins between members is accepted for v1, and, since
  // rebuildBookingProjections(profileId, docData) folds this write into its
  // own batch alongside both projections (SP4 quality-fix: atomic
  // source+projection commit, see that function's comment), "last write
  // wins" now applies to the whole triple at once: no window where the
  // source has landed but curatorBooking/publicBooking still reflect an
  // older write. A profile delete racing this call is a separate, still-
  // accepted race (mirrors account.ts's documented-race precedent): if
  // deleteProfile's recursiveDelete is mid-flight, this batch can still
  // commit afterward and recreate an orphaned private/booking doc under a
  // profile that's otherwise gone. That's distinct from, and narrower than
  //, the resurrection risk in rebuildBookingProjections' missing-source
  // clear branch (not reachable from here, since this call always passes
  // `docData`): a caller that hits that branch (e.g. backfillBookingVisibility,
  // or any future direct rebuild) while recursiveDelete is also running can
  // recreate profiles/{id} from nothing, as an inert stub containing only
  // `{publicBooking: null}`.
  await rebuildBookingProjections(input.profileId, docData);
  return { ok: true };
});

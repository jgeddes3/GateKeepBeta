import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioUpdateInput, type BookingUpdateInput, type BookingDoc, type RateAmount, type PortfolioData,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile } from "./guards.js";

// Strips any extra/untrusted keys off a rate object and normalizes an
// absent (undefined) rate the same as an explicit null. Without this, a
// member could persist arbitrary extra keys/nested JSON into
// private/booking by reference — and `note` could end up absent from the
// stored doc even though RateAmount promises it present-and-nullable.
const rate = (r: RateAmount | null | undefined): RateAmount | null =>
  r == null ? null : { amountCents: r.amountCents, note: r.note ?? null };

export const updatePortfolio = onCall<PortfolioUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const input = req.data;
  const v = validatePortfolioUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  // sequential is deliberate — parallelizing makes rejection order
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
  // still ends up complete — and photo paths are only null-defaulted when
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
  // sequential is deliberate — parallelizing makes rejection order
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
    updatedAt: Date.now(),
  };
  // full-doc last-write-wins between members is accepted for v1; a delete
  // racing this write can recreate an orphaned booking doc — accepted,
  // mirrors account.ts's documented-race precedent
  await getFirestore().doc(`profiles/${input.profileId}/private/booking`).set(docData);
  return { ok: true };
});

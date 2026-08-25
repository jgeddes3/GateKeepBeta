import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioUpdateInput, type BookingUpdateInput, type BookingDoc,
} from "@gatekeep/shared";

export function requireAuthUid(req: { auth?: { uid?: string } }): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

// Any member may edit portfolio content (spec §6) — contrast requireProfileAdmin
// in profiles.ts, which gates membership/deletion actions.
export async function requireProfileMember(profileId: string, uid: string) {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists) throw new HttpsError("permission-denied", "Only profile members can do that.");
}

export async function requireMusicianProfile(profileId: string) {
  const p = await getFirestore().doc(`profiles/${profileId}`).get();
  if (!p.exists) throw new HttpsError("not-found", "Profile not found.");
  if (p.data()?.type !== "musician") {
    throw new HttpsError("failed-precondition", "Portfolios belong to musician profiles.");
  }
  return p;
}

export const updatePortfolio = onCall<PortfolioUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const input = req.data;
  const v = validatePortfolioUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);

  // Dotted-string-keys form: the Admin SDK treats dotted string keys in a
  // plain object passed to update() as field paths, so this merges into the
  // portfolio map without clobbering the photo paths the media pipeline owns.
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.bio !== undefined) updates["portfolio.bio"] = input.bio;
  if (input.genres !== undefined) updates["portfolio.genres"] = input.genres;
  // Explicit mapping: stores only the validated fields (an untrusted link object
  // could carry extra keys) and the trimmed URL the validator actually checked.
  if (input.externalLinks !== undefined) {
    updates["portfolio.externalLinks"] = input.externalLinks.map((l) => ({ kind: l.kind, url: l.url.trim() }));
  }
  await getFirestore().doc(`profiles/${input.profileId}`).update(updates);
  return { ok: true };
});

export const updateBookingInfo = onCall<BookingUpdateInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const input = req.data;
  const v = validateBookingUpdate(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  await requireProfileMember(input.profileId, uid);
  await requireMusicianProfile(input.profileId);
  // Normalize absent → null: the validator accepts omitted keys, the stored
  // BookingDoc promises present-and-nullable, and Firestore rejects `undefined`.
  const docData: BookingDoc = {
    rates: {
      perHour: input.rates.perHour ?? null,
      perSong: input.rates.perSong ?? null,
      perSet: input.rates.perSet ?? null,
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
  await getFirestore().doc(`profiles/${input.profileId}/private/booking`).set(docData);
  return { ok: true };
});

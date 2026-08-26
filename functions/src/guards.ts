import { HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type DocumentSnapshot } from "firebase-admin/firestore";

// Shared onCall guards used across portfolio/booking (and, in future
// sub-projects, track/media) callables. profiles.ts and members.ts keep
// their own local requireAuth/requireVerifiedEmail copies for now —
// consolidating those is deferred to sub-project 3.

export function requireAuthUid(req: { auth?: { uid?: string } }): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

export function requireVerifiedEmail(req: { auth?: { token?: Record<string, unknown> } }): void {
  if (req.auth?.token?.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Please verify your email address first.");
  }
}

// Any member may edit portfolio content (spec §6) — contrast requireProfileAdmin
// in profiles.ts, which gates membership/deletion actions.
export async function requireProfileMember(profileId: string, uid: string): Promise<void> {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists) throw new HttpsError("permission-denied", "Only profile members can do that.");
}

export async function requireMusicianProfile(profileId: string): Promise<DocumentSnapshot> {
  const p = await getFirestore().doc(`profiles/${profileId}`).get();
  if (!p.exists) throw new HttpsError("not-found", "Profile not found.");
  if (p.data()?.type !== "musician") {
    throw new HttpsError("failed-precondition", "Portfolios belong to musician profiles.");
  }
  return p;
}

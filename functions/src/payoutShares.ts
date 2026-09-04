import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { isValidDocId, validatePayoutShares, SHARES_ADMIN_MESSAGE, type PayoutShare, type StripeProfileDoc } from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { notifyProfileAdmins } from "./notifications.js";

export async function loadShares(db: Firestore, profileId: string): Promise<PayoutShare[] | null> {
  const snap = await db.doc(`profiles/${profileId}/private/stripe`).get();
  const shares = (snap.data() as StripeProfileDoc | undefined)?.shares;
  return shares && shares.length > 0 ? shares : null;
}

async function memberUids(db: Firestore, profileId: string): Promise<Set<string>> {
  const snap = await db.collection(`profiles/${profileId}/members`).get();
  return new Set(snap.docs.map((d) => d.id));
}

// The explicit member read below (not requireProfileAdmin) is what gives an
// admin-only failure the shares-specific SHARES_ADMIN_MESSAGE.
export const setPayoutShares = onCall<{ profileId: string; shares: PayoutShare[] | null }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, shares } = req.data ?? ({} as { profileId: string; shares: null });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    const db = getFirestore();
    const member = await db.doc(`profiles/${profileId}/members/${uid}`).get();
    if (!member.exists || member.data()?.role !== "admin") throw new HttpsError("permission-denied", SHARES_ADMIN_MESSAGE);
    const ref = db.doc(`profiles/${profileId}/private/stripe`);
    if (shares === null) {
      await ref.set({ shares: null, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
      return { ok: true };
    }
    const v = validatePayoutShares(shares, await memberUids(db, profileId));
    if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
    await ref.set({ shares: v.shares, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    return { ok: true };
  });

// removeMember calls this after its transaction: the leaving member's percent
// joins the band fund so the shares still sum to 100.
export async function reassignShareOnRemoval(db: Firestore, profileId: string, uid: string, now: number): Promise<void> {
  const shares = await loadShares(db, profileId);
  if (!shares) return;
  const leaving = shares.find((s) => s.payee.kind === "member" && s.payee.uid === uid);
  if (!leaving) return;
  const rest = shares.filter((s) => s !== leaving);
  const fund = rest.find((s) => s.payee.kind === "profile");
  const next: PayoutShare[] = fund
    ? rest.map((s) => (s === fund ? { payee: s.payee, percent: s.percent + leaving.percent } : s))
    : [...rest, { payee: { kind: "profile" }, percent: leaving.percent }];
  await db.doc(`profiles/${profileId}/private/stripe`).set({ shares: next, sharesUpdatedAt: now, updatedAt: now }, { merge: true });
  try {
    await notifyProfileAdmins(profileId, {
      kind: "system", title: "Payout shares changed",
      body: `A member left, so their ${leaving.percent}% share now goes to the band fund. Review the shares if that is not what you want.`,
    });
  } catch (e) {
    console.error(`reassignShareOnRemoval: notification failed for ${profileId}`, e);
  }
}

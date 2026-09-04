/**
 * SP5c Task 8: `getPayoutHistory`, the one read path both clients use for
 * payout history (web Task 9/10, mobile Task 11/12). Reads the `ledger`
 * collection, scoped either to a profile (any member may read the profile's
 * shared rows) or to the caller's own rows (`uid` is always the caller's,
 * never client-supplied). Pages newest-first via Task 2's composite indexes
 * `(profileId, at desc)` and `(uid, at desc)`.
 *
 * Cursor shape: `writeLedger` (paymentsCore.ts) names ledger docs
 * `${kind}:${stripeId}`, which routinely contain colons and run past 64
 * characters, so this file's own cursor validation (below) is deliberately
 * looser than `isValidDocId` (@gatekeep/shared), which would reject every
 * real cursor id.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type HistoryRow, type LedgerEntry, type PayoutHistoryScope } from "@gatekeep/shared";
import { requireAuthUid, requireProfileMember } from "./guards.js";

const PAGE = 20;

// Looser than isValidDocId on purpose (see file header): a cursor id just
// has to be a non-empty string, at most 1500 bytes, with no "/" (Firestore
// doc ids may not contain "/"; a plain length/type check would let one
// through and break startAfter).
function isValidCursorId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !id.includes("/") && Buffer.byteLength(id, "utf8") <= 1500;
}

export const getPayoutHistory = onCall<{ scope: PayoutHistoryScope; cursor?: string | null }>(
  { region: "us-central1" },
  async (req) => {
    const uid = requireAuthUid(req);
    const scope = req.data?.scope;
    const db = getFirestore();

    let q: FirebaseFirestore.Query;
    if (scope?.kind === "profile") {
      if (!isValidDocId(scope.profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
      await requireProfileMember(scope.profileId, uid);
      q = db.collection("ledger").where("profileId", "==", scope.profileId);
    } else if (scope?.kind === "user") {
      q = db.collection("ledger").where("uid", "==", uid);
    } else {
      throw new HttpsError("invalid-argument", "Unknown history scope.");
    }
    q = q.orderBy("at", "desc").orderBy("__name__", "desc").limit(PAGE + 1);

    const cursor = req.data?.cursor;
    if (cursor) {
      // Controller ruling: split at the FIRST colon only, `writeLedger`'s
      // doc ids are `${kind}:${stripeId}` and the id half can itself
      // contain colons.
      const sep = cursor.indexOf(":");
      const atRaw = sep === -1 ? cursor : cursor.slice(0, sep);
      const id = sep === -1 ? "" : cursor.slice(sep + 1);
      const at = Number(atRaw);
      if (!Number.isFinite(at) || !isValidCursorId(id)) {
        throw new HttpsError("invalid-argument", "Invalid cursor.");
      }
      q = q.startAfter(at, id);
    }

    const snap = await q.get();
    const docs = snap.docs.slice(0, PAGE);

    // One profile's members only, never an unbounded read across profiles.
    const labels = new Map<string, string>();
    if (scope.kind === "profile") {
      const members = await db.collection(`profiles/${scope.profileId}/members`).get();
      for (const m of members.docs) labels.set(m.id, (m.data().label as string) || "member");
    }

    const rows: HistoryRow[] = docs.map((d) => {
      const e = d.data() as LedgerEntry;
      return {
        id: d.id,
        kind: e.kind,
        amountCents: e.amountCents,
        at: e.at,
        detail: e.detail,
        sourced: e.sourced ?? null,
        uid: e.uid ?? null,
        label: e.uid ? (labels.get(e.uid) ?? null) : null,
        ref: {
          bookingId: e.bookingId ?? undefined,
          gigId: e.gigId ?? undefined,
          eventId: e.eventId ?? undefined,
          orderId: e.orderId ?? undefined,
        },
      };
    });

    const last = docs[docs.length - 1];
    const nextCursor = snap.docs.length > PAGE && last ? `${(last.data() as LedgerEntry).at}:${last.id}` : null;
    return { rows, nextCursor };
  },
);

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE,
  type TicketDoc, type EventDoc, type TicketTransferDoc, type TicketOrderDoc,
} from "@gatekeep/shared";
import { writeAudit } from "./review.js";

// Consumes membership invariants (Task 8: never-zero-admins per profile) and
// the users/{uid} tree created by onUserCreated (Task 5).
//
// Known limitation (v1, accepted per task dispatch): the sole-admin check
// below is a plain read, not transactional like removeMember's (Task 8).
// Account deletion is a rare, user-initiated action, so a race between two
// concurrent deletions/removals is an acceptable risk for now rather than a
// reason to add transactional complexity here.

const RETRY_SAFE_MESSAGE = "Account deletion did not complete. It is safe to try again.";

// SP10 Task 13 (spec section 5.3, cross #2): nothing is unwound by
// deletion. Tickets, then transfers, then orders, each with its own
// client-keyed message. The transfer and order scans filter status in
// memory off a single-field query: both are bounded by one user's own
// history, and neither has a (uid, status) composite today.
async function assertNothingOutstanding(db: FirebaseFirestore.Firestore, uid: string, now: number): Promise<void> {
  const tickets = await db.collection(`users/${uid}/tickets`).where("status", "in", ["valid", "checked_in"]).get();
  const eventIds = [...new Set(tickets.docs.map((d) => (d.data() as TicketDoc).eventId))];
  for (const eventId of eventIds) {
    const event = (await db.doc(`events/${eventId}`).get()).data() as EventDoc | undefined;
    if (event && event.endsAt > now) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TICKETS_MESSAGE);
  }

  const [fromSnap, toSnap] = await Promise.all([
    db.collection("transfers").where("fromUid", "==", uid).get(),
    db.collection("transfers").where("toUid", "==", uid).get(),
  ]);
  const offered = [...fromSnap.docs, ...toSnap.docs].some((d) => (d.data() as TicketTransferDoc).status === "offered");
  if (offered) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TRANSFERS_MESSAGE);

  const orders = await db.collection("orders").where("buyerUid", "==", uid).get();
  if (orders.docs.some((d) => (d.data() as TicketOrderDoc).status === "pending")) {
    throw new HttpsError("failed-precondition", DELETE_ACCOUNT_ORDERS_MESSAGE);
  }
}

export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();
  const now = Date.now();

  await assertNothingOutstanding(db, uid, now);

  // Block deletion while sole admin anywhere (spec section 4).
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0) {
    throw new HttpsError("failed-precondition",
      `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
  }

  // Remove the curatorAccess marker (+ any pending retry doc), then
  // memberships, then the user doc tree, then the auth account. Each phase
  // is independently retry-idempotent (re-deleting an already-deleted
  // membership/doc, or re-deleting an already-deleted auth user, is a no-op
  // or a clean not-found), so on partial failure we don't attempt a
  // compensating rollback. Instead we log which phase failed for diagnosis
  // and tell the client it's safe to call deleteAccount again, rather than
  // surfacing a raw internal error or silently leaving things half-deleted.
  //
  // S5: curatorAccess/{uid} goes first so a stale marker never outlives the
  // account it describes (deleteUser below can't be undone if a later phase
  // fails, but a stale-but-harmless leftover membership doc is a smaller
  // residual risk than a stale-but-ACTIVE-privilege marker surviving the
  // account it describes).
  try {
    await Promise.all([
      db.doc(`curatorAccess/${uid}`).delete(),
      db.doc(`curatorAccessRetries/${uid}`).delete(),
    ]);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "curatorAccess" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await Promise.all(memberships.docs.map((m) => m.ref.delete()));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "memberships" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await db.recursiveDelete(db.doc(`users/${uid}`));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "firestore" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "auth" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  // Written after the auth user is gone: the trail records what happened,
  // never a deletion that then failed.
  await writeAudit({ actorUid: uid, action: "account_deleted", targetId: uid, detail: `memberships removed: ${memberships.size}` });
  return { ok: true };
});

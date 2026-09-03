import { getFirestore } from "firebase-admin/firestore";
import type { NotificationDoc } from "@gatekeep/shared";

// Capped so a user with an unbounded number of stale/duplicate push token
// docs can't make a single notification hold this function open forever.
const PUSH_TOKEN_FANOUT_CAP = 20;
const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

// One Expo push ticket per message, in request order.
interface ExpoPushTicket { status: "ok" | "error"; message?: string; details?: { error?: string } }

// SP10 Task 15 (sp1 #6, rules F9): newest device first, so the cap never
// drops the phone the user is holding in favour of 20 dead installs.
// createdAt is required and typed int by firestore.rules, so every token doc
// participates in the order.
export async function loadPushTokenIds(uid: string): Promise<string[]> {
  const tokens = await getFirestore().collection(`users/${uid}/pushTokens`)
    .orderBy("createdAt", "desc").limit(PUSH_TOKEN_FANOUT_CAP).get();
  return tokens.docs.map((t) => t.id);
}

// Pure: which of the tokens we just posted did Expo mark as unregistered.
// Anything that is not the documented { data: ticket[] } shape yields [] so
// a malformed or error-envelope response never deletes a live token.
export function deadTokenIdsFromExpoResponse(tokenIds: string[], body: unknown): string[] {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const dead: string[] = [];
  data.forEach((ticket, i) => {
    const t = ticket as ExpoPushTicket | null | undefined;
    if (t?.status === "error" && t.details?.error === "DeviceNotRegistered" && tokenIds[i]) dead.push(tokenIds[i]);
  });
  return dead;
}

// SP7: dedupeKey makes the inbox write create-if-absent. create() fails with
// ALREADY_EXISTS (gRPC 6) when a prior fan-out wrote this key: leave that doc
// untouched (no re-surfacing, no second push) and report false so callers
// that count actual notifications (e.g. follows.ts's fan-out) stay accurate.
export async function notifyUser(
  uid: string, note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey?: string,
): Promise<boolean> {
  const db = getFirestore();
  const full: NotificationDoc = { ...note, read: false, createdAt: Date.now() };
  const col = db.collection(`users/${uid}/notifications`);
  if (dedupeKey) {
    try { await col.doc(dedupeKey).create(full); }
    catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }
  } else {
    await col.add(full);
  }

  // SP10 Task 15: newest-first, capped selection (see loadPushTokenIds above).
  const tokenIds = await loadPushTokenIds(uid);
  if (tokenIds.length === 0) return true;
  const messages = tokenIds.map((to) => ({ to, title: note.title, body: note.body }));
  let body: unknown = null;
  try {
    const res = await fetch(EXPO_PUSH_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
      // A hung exp.host endpoint must not hold this function open indefinitely.
      signal: AbortSignal.timeout(5_000),
    });
    body = await res.json();
  } catch (e) {
    console.error("expo push failed", e); // inbox write already succeeded; push is best-effort
    return true;
  }
  // Prune tokens Expo says are dead so they stop consuming the fan-out cap
  // and stop reaching a device that has since signed into another account.
  const dead = deadTokenIdsFromExpoResponse(tokenIds, body);
  if (dead.length === 0) return true;
  const results = await Promise.allSettled(dead.map((id) => db.doc(`users/${uid}/pushTokens/${id}`).delete()));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error("push token prune failed", { uid, token: dead[i] }, r.reason);
  });
  return true;
}

export async function notifyProfileMembers(profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">) {
  const members = await getFirestore().collection(`profiles/${profileId}/members`).get();
  await Promise.all(members.docs.map((m) => notifyUser(m.id, note)));
}

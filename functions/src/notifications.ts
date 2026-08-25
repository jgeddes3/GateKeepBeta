import { getFirestore } from "firebase-admin/firestore";
import type { NotificationDoc } from "@gatekeep/shared";

export async function notifyUser(uid: string, note: Omit<NotificationDoc, "read" | "createdAt">): Promise<void> {
  const db = getFirestore();
  const full: NotificationDoc = { ...note, read: false, createdAt: Date.now() };
  await db.collection(`users/${uid}/notifications`).add(full);

  // Capped so a user with an unbounded number of stale/duplicate push token
  // docs can't make a single notification hold this function open forever.
  const tokens = await db.collection(`users/${uid}/pushTokens`).limit(20).get();
  if (tokens.empty) return;
  const messages = tokens.docs.map((t) => ({ to: t.id, title: note.title, body: note.body }));
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
      // A hung exp.host endpoint must not hold this function open indefinitely.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    console.error("expo push failed", e); // inbox write already succeeded; push is best-effort
  }
}

export async function notifyProfileMembers(profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">) {
  const members = await getFirestore().collection(`profiles/${profileId}/members`).get();
  await Promise.all(members.docs.map((m) => notifyUser(m.id, note)));
}

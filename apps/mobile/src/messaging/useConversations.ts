import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import type { ConversationRefDoc } from "@gatekeep/shared";

// Mobile twin of Task 6's web hook (apps/web's own useConversations,
// landing in this same sub-project): same names, same shapes, so the two
// clients keep one vocabulary.
//
// Spec section 4 (data facts amended after the plan was written): a
// profile's conversation list comes from its OWN mirror subcollection
// profiles/{profileId}/conversations/{pairId} (ConversationRefDoc), never a
// top-level `conversations` collection query. firestore.rules cannot prove
// a list rule for a top-level `participants array-contains` query, so there
// is no client list of the top-level collection at all; the mirror is
// ordered by lastMessageAt and IS the row the inbox renders.
export type ConversationRow = ConversationRefDoc;

// row.unread is already THIS profile's own count (it lives only on that
// profile's own mirror, never a cross-profile map), so this is a thin
// accessor. `profileId` is kept in the signature for parity with the web
// hook (same names, same shapes) and so a call site is explicit about whose
// unread count it means; it does not change the returned value.
export function unreadFor(row: ConversationRow, profileId: string): number {
  void profileId;
  return row.unread;
}

// A short, relative "2h"/"3d" stamp for a row's last-message time and a
// bubble's own timestamp, shared by ConversationList and ConversationThread.
export function formatConversationTime(atMs: number): string {
  const diff = Date.now() - atMs;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(atMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// `profileId` is expected to be STABLE for the lifetime of one hook
// instance: both index screens mount ConversationList with `key={profileId}`
// (the same remount-on-switch idiom (musician)/bookings.tsx's BookingInbox
// and (musician)/dashboard.tsx's EarningsPanel already use), so a profile
// switch always gets a fresh instance rather than this hook needing its own
// render-time-reset bookkeeping for a mid-lifetime id change.
export function useConversations(profileId: string | null): {
  rows: ConversationRow[] | "loading" | "error";
  retry: () => void;
} {
  const [rows, setRows] = useState<ConversationRow[] | "loading" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, `profiles/${profileId}/conversations`), orderBy("lastMessageAt", "desc"), limit(50)),
      (snap) => { if (!cancelled) setRows(snap.docs.map((d) => d.data() as ConversationRefDoc)); },
      () => { if (!cancelled) setRows("error"); },
    );
    return () => { cancelled = true; unsub(); };
  }, [profileId, attempt]);

  // A plain event-handler setState (not inside the effect body), so this
  // needs no react-hooks/set-state-in-effect exception: it fires only from
  // a user's Retry press.
  return { rows, retry: () => { setRows("loading"); setAttempt((a) => a + 1); } };
}

// Task 11's tab badge: one listener per profile id (a user rarely holds
// more than a couple of profiles of one type), summed with unreadFor.
// Unlike useConversations above, the id SET can legitimately change across
// this hook's lifetime (the tab badge lives above any per-profile remount),
// so a genuine id removed from the set must not leave a stale total behind:
// the render-time reset below (same idiom as GigDetailSheet's trackedGigId)
// clears every prior total the moment the id set changes, synchronously
// during render rather than as an unconditional setState inside the effect
// body.
export function useUnreadTotal(profileIds: string[]): number {
  const [totals, setTotals] = useState<Record<string, number>>({});
  const key = [...profileIds].sort().join(",");
  const [trackedKey, setTrackedKey] = useState(key);
  if (key !== trackedKey) {
    setTrackedKey(key);
    setTotals({});
  }

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    const { db } = getFirebase();
    const unsubs = ids.map((id) => onSnapshot(
      query(collection(db, `profiles/${id}/conversations`), orderBy("lastMessageAt", "desc"), limit(50)),
      (snap) => {
        const total = snap.docs.reduce((sum, d) => sum + unreadFor(d.data() as ConversationRefDoc, id), 0);
        setTotals((prev) => ({ ...prev, [id]: total }));
      },
      () => setTotals((prev) => ({ ...prev, [id]: 0 })),
    ));
    return () => unsubs.forEach((u) => u());
  }, [key]);

  return Object.values(totals).reduce((sum, n) => sum + n, 0);
}

import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { SEARCH_DAILY_BUDGET, SEARCH_LIMIT_MESSAGE } from "@gatekeep/shared";

// Per-uid daily search counter, the geocodeBudgets shape: keyed by UTC
// calendar date, overwritten with a fresh {date, count: 1} the moment the
// stored date no longer matches, transactional so concurrent calls cannot
// both squeak under the ceiling.
export async function consumeSearchBudget(uid: string, now: number = Date.now()): Promise<void> {
  const db = getFirestore();
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const ref = db.doc(`searchBudgets/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const count = data?.date === dateKey ? ((data.count as number | undefined) ?? 0) : 0;
    if (count >= SEARCH_DAILY_BUDGET) throw new HttpsError("resource-exhausted", SEARCH_LIMIT_MESSAGE);
    tx.set(ref, { date: dateKey, count: count + 1 });
  });
}

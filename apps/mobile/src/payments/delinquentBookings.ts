import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

// SP5 Task 15 review round 1 (low #14): the client query GatePrompt's
// CuratorDelinquentGate and DelinquencyBanner both need, extracted here so
// there's exactly ONE copy of it. Pinned to curatorProfileId == <this
// profile> (provable under firestore.rules' bookings read rule:
// isMember(resource.data.curatorProfileId) evaluates over a query-wide
// constant, same shape as BookingInbox's own curator-side queries). No
// orderBy: an equality-only compound query needs no extra composite index.
const MAX_LINKED = 5;

export async function fetchDelinquentBookingIds(curatorProfileId: string): Promise<string[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(collection(db, "bookings"),
    where("curatorProfileId", "==", curatorProfileId), where("paymentSummary.state", "==", "delinquent"), limit(MAX_LINKED)));
  return snap.docs.map((d) => d.id);
}

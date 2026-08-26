import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type UserDoc, type AdminNoteDoc } from "@gatekeep/shared";
import { requireAdmin, writeAudit } from "./review.js";
import { computeDisplayNameLowerFix } from "./authTriggers.js";

const MAX_QUERY_LENGTH = 80;
const SEARCH_LIMIT = 10;

// Prefix range query over the lowercase index field: everything from `lower`
// (inclusive) up to the first string that is NOT prefixed by `lower`.
// U+F8FF (Private Use Area) is Firestore's own documented idiom for this — a
// codepoint high enough that it sorts after virtually any realistic name
// character — so `< lower + ""` captures every doc whose
// displayNameLower starts with `lower`. Range is on a single field, so this
// needs only Firestore's automatic single-field index — no composite index
// entry.
export const searchUsersByName = onCall<{ q: string }>({ region: "us-central1" }, async (req) => {
  requireAdmin(req);
  const { q } = req.data;
  if (typeof q !== "string") {
    throw new HttpsError("invalid-argument", "A search query is required.");
  }
  const trimmed = q.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_QUERY_LENGTH) {
    throw new HttpsError("invalid-argument", `Query must be 1-${MAX_QUERY_LENGTH} characters.`);
  }
  const lower = trimmed.toLowerCase();
  const db = getFirestore();
  const snap = await db.collection("users")
    .where("displayNameLower", ">=", lower)
    .where("displayNameLower", "<", lower + "")
    .limit(SEARCH_LIMIT)
    .get();
  const results = snap.docs.map((d) => {
    const data = d.data() as UserDoc;
    return { uid: d.id, displayName: data.displayName, email: data.email };
  });
  return { results };
});

const BACKFILL_PAGE_SIZE = 300;

// Admin one-shot: pages every users/{uid} doc (documentId()-ordered, ~300 at
// a time so a single page never risks Firestore's 500-write batch cap once
// paired with the batch below) and writes displayNameLower wherever it's
// missing or stale relative to the current displayName. Needed once at
// deploy for pre-Task-8 accounts (onUserCreated/onUserDocWritten only cover
// accounts created/edited from here on); tests also use it directly against
// seeded legacy users.
export const backfillDisplayNameLower = onCall<Record<string, never>>(
  { region: "us-central1", timeoutSeconds: 540 },
  async (req) => {
    requireAdmin(req);
    const db = getFirestore();
    let updated = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = db.collection("users").orderBy("__name__").limit(BACKFILL_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;

      const batch = db.batch();
      let batchOps = 0;
      for (const doc of snap.docs) {
        const fix = computeDisplayNameLowerFix(doc.data());
        if (fix !== null) {
          batch.update(doc.ref, { displayNameLower: fix });
          batchOps++;
          updated++;
        }
      }
      if (batchOps > 0) await batch.commit();

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < BACKFILL_PAGE_SIZE) break; // last page
    }
    return { updated };
  },
);

const MAX_FLAG_TEXT_LENGTH = 500;

// Appends a note to adminNotes/{uid} (keyed by the USER's uid, matching
// firestore.rules' existing adminNotes/{uid} wildcard — that collection is
// admin-read-only and write:false for every client, so the Admin SDK write
// here is the only path that can ever touch it).
//
// A read-modify-write transaction, not FieldValue.arrayUnion(): arrayUnion
// dedupes array entries by deep-equality, and two flags that happen to carry
// identical byUid/at/text (a real possibility if `at`'s millisecond
// resolution collides across two fast successive calls) would silently
// collapse into a single stored entry. A transaction always appends,
// regardless of content.
export const flagAccount = onCall<{ uid: string; text: string }>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { uid, text } = req.data;
  if (!isValidDocId(uid)) {
    throw new HttpsError("invalid-argument", "A user id is required.");
  }
  if (typeof text !== "string") {
    throw new HttpsError("invalid-argument", "Flag text is required.");
  }
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_FLAG_TEXT_LENGTH) {
    throw new HttpsError("invalid-argument", `Flag text must be 1-${MAX_FLAG_TEXT_LENGTH} characters.`);
  }

  const db = getFirestore();
  const ref = db.doc(`adminNotes/${uid}`);
  const entry = { byUid: actorUid, at: Date.now(), text: trimmed };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = (snap.data()?.notes as AdminNoteDoc["notes"] | undefined) ?? [];
    const notes: AdminNoteDoc["notes"] = [...existing, entry];
    tx.set(ref, { notes });
  });

  await writeAudit({ actorUid, action: "account_flagged", targetId: uid, detail: trimmed });
  return { ok: true };
});

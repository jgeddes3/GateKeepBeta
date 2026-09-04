import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import {
  validateSavedSearchInput, savedSearchLabel, matchesSavedSearch, kindForFace, refKindForKind, normalizeWords, isValidDocId,
  SAVED_SEARCH_LIMIT, SAVED_SEARCH_SCAN_CAP, SAVED_SEARCH_LIMIT_MESSAGE,
  type SavedSearchDoc, type SavedSearchInput, type SearchIndexDoc, type SearchFilters,
} from "@gatekeep/shared";
import { requireAuthUid } from "./guards.js";
import { notifyUser } from "./notifications.js";

// Canonical form for duplicate detection: normalized words plus the filters
// with keys sorted, so " Owls " and "owls" with the same filters collapse.
function fingerprint(face: string, q: string, filters: SearchFilters): string {
  const keys = Object.keys(filters).filter((k) => filters[k as keyof SearchFilters] !== undefined).sort();
  return `${face}|${normalizeWords(q).join(" ")}|${keys.map((k) => `${k}=${JSON.stringify(filters[k as keyof SearchFilters])}`).join("&")}`;
}

export const saveSearch = onCall<SavedSearchInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const v = validateSavedSearchInput(req.data);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
  const { face, q, filters } = v.input;
  const db = getFirestore();
  const existing = await db.collection("savedSearches").where("uid", "==", uid).limit(SAVED_SEARCH_LIMIT + 1).get();
  const fp = fingerprint(face, q, filters);
  for (const d of existing.docs) {
    const s = d.data() as SavedSearchDoc;
    if (fingerprint(s.face, s.q, s.filters) === fp) return { id: d.id };
  }
  if (existing.size >= SAVED_SEARCH_LIMIT) throw new HttpsError("failed-precondition", SAVED_SEARCH_LIMIT_MESSAGE);
  const doc: SavedSearchDoc = {
    uid, face, kind: kindForFace(face), q, filters, label: savedSearchLabel(face, q, filters), createdAt: Date.now(), lastMatchedAt: null,
  };
  const ref = await db.collection("savedSearches").add(doc);
  return { id: ref.id };
});

export const deleteSavedSearch = onCall<{ id: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const id = req.data?.id;
  if (!isValidDocId(id)) throw new HttpsError("invalid-argument", "Invalid saved search.");
  const db = getFirestore();
  const ref = db.doc(`savedSearches/${id}`);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as SavedSearchDoc).uid !== uid) throw new HttpsError("not-found", "Saved search not found.");
  await ref.delete();
  return { ok: true };
});

// An index doc is created when its source becomes public (and re-created if
// it leaves and returns), so this fires exactly at "something new appeared".
// The dedupe key holds the notification to one per saved search and doc.
export const onSearchIndexCreated = onDocumentCreated("searchIndex/{docId}", async (event) => {
  const docId = event.params.docId;
  try {
    const doc = event.data?.data() as SearchIndexDoc | undefined;
    if (!doc) return;
    const db = getFirestore();
    const now = Date.now();
    const snap = await db.collection("savedSearches").where("kind", "==", doc.kind).orderBy("createdAt", "asc").limit(SAVED_SEARCH_SCAN_CAP).get();
    for (const d of snap.docs) {
      const saved = d.data() as SavedSearchDoc;
      try {
        if (!matchesSavedSearch(doc, saved, now)) continue;
        const written = await notifyUser(saved.uid, {
          kind: "saved_search_match", refId: doc.sourceId, refKind: refKindForKind(doc.kind),
          title: "New match for a saved search", body: `${doc.title} matches "${saved.label}".`,
        }, `saved_search:${d.id}:${docId}`);
        if (written) await d.ref.update({ lastMatchedAt: now });
      } catch (e) {
        console.error("savedSearches: alert failed", d.id, docId, e);
      }
    }
  } catch (e) {
    console.error("savedSearches: scan failed", docId, e);
  }
});

import { useState } from "react";
import { Alert } from "react-native";
import { doc, getDoc } from "firebase/firestore";
import {
  hasSavedSearchCriteria, SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE,
  type SavedSearchDoc, type SearchFace, type SearchFilters,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { Button } from "../ui";
import { saveSearch } from "./searchApi";

// Mobile twin of apps/web/src/search/SaveSearchButton.tsx (Task 17, ruling
// 2): rendered in each face's header `right` slot, next to that face's own
// List | Map toggle where one exists. Reads the SAME live q/filters the
// face's own useSearch instance holds, rather than a second copy of "what is
// this search actually" that could drift from what's on screen.
//
// disabled carries its own accessibilityHint (SAVED_SEARCH_EMPTY_CRITERIA_
// MESSAGE, the exact copy validateSavedSearchInput's own empty-criteria
// failure uses server-side) so VoiceOver/TalkBack explains why without a
// press. The success alert reads the label back from the saved doc (rather
// than recomputing savedSearchLabel client-side) so it always matches
// exactly what the server and the saved-searches list both show. The cap
// error (failed-precondition, SAVED_SEARCH_LIMIT_MESSAGE) surfaces the same
// way: e.message is exactly the HttpsError message the server sent.
export function SaveSearchButton({ face, q, filters }: { face: SearchFace; q: string; filters: SearchFilters }) {
  const [saving, setSaving] = useState(false);
  const disabled = !hasSavedSearchCriteria(q, filters);

  const onPress = async () => {
    setSaving(true);
    try {
      const { id } = await saveSearch({ face, q, filters });
      const snap = await getDoc(doc(getFirebase().db, "savedSearches", id));
      const label = snap.exists() ? (snap.data() as SavedSearchDoc).label : "Search saved.";
      Alert.alert("Saved", label);
    } catch (e) {
      Alert.alert("Could not save", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      title="Save search"
      variant="secondary"
      disabled={disabled || saving}
      accessibilityHint={disabled ? SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE : undefined}
      onPress={() => void onPress()}
      style={{ minHeight: 36, paddingHorizontal: 12 }}
    />
  );
}

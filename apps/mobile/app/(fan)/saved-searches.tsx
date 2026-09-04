import { SavedSearchesScreen } from "../../src/search/SavedSearchesScreen";

// SP8 Task 17: reachable via router.push("/(fan)/saved-searches") from
// AccountScreen's own "Saved searches" row, exactly like `following`
// (hidden tab, see app/(fan)/_layout.tsx). Every role's saved searches live
// in the one `savedSearches` collection, so this single fan-tab screen lists
// them regardless of the signed-in user's active face/profile.
export default function Screen() {
  return <SavedSearchesScreen />;
}

import { callFn } from "../lib/callable";
import type { SearchInput, SearchOutput, SavedSearchInput } from "@gatekeep/shared";

// Mobile twin of apps/web/src/search/searchApi.ts (Task 8, Step 1): one door
// for the three search callables, same exported names and same shape as
// every other domain's callable wrapper on this client. callFn (not a bare
// httpsCallable) already retries a stale email-verified claim (lib/
// callable.ts's own comment); callers get back plain `.data` rather than an
// HttpsCallableResult wrapper.
export async function runSearch(input: SearchInput): Promise<SearchOutput> {
  return (await callFn<SearchInput, SearchOutput>("search", input)).data;
}

export async function saveSearch(input: SavedSearchInput): Promise<{ id: string }> {
  return (await callFn<SavedSearchInput, { id: string }>("saveSearch", input)).data;
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await callFn<{ id: string }, { ok: true }>("deleteSavedSearch", { id });
}

// Reads a callable error's `code` (e.g. "functions/resource-exhausted")
// without importing FunctionsError just to narrow it: useSearch.ts's own
// budget-hit branch is the first caller.
export function callableCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

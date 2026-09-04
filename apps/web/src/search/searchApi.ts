import { callFn } from "../lib/callable";
import type { SearchInput, SearchOutput, SavedSearchInput } from "@gatekeep/shared";

// One door for the three search callables, same shape as every other
// domain's callable wrappers: callFn (not a bare httpsCallable) so a stale
// email-verified claim retries once instead of failing outright (see
// lib/callable.ts's own comment), and callers get back plain `.data`
// rather than an HttpsCallableResult wrapper.
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
// budget-hit branch is the first caller, more will follow as later tasks
// add save/delete UI with their own error branches.
export function callableCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

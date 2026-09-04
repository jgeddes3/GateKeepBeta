"use client";
import { useEffect, useRef, useState } from "react";
import {
  hasSavedSearchCriteria, SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE,
  type SearchFace, type SearchFilters,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { saveSearch } from "./searchApi";

// Sits in each face's headerSlot, next to that face's own List | Map toggle
// (Task 8's header-slot contract): reads the SAME live q/filters the face's
// own useSearch instance holds, rather than a second copy of "what is this
// search actually" that could drift from what's on screen.
//
// disabled carries its own title (SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE, the
// exact copy validateSavedSearchInput's own empty-criteria failure uses
// server-side) so a user who hovers a disabled button understands why
// without having to click it first. The cap error (failed-precondition,
// SAVED_SEARCH_LIMIT_MESSAGE) surfaces the same way: e.message is exactly
// the HttpsError message the server sent, so this never restates it.
export function SaveSearchButton({ face, q, filters }: { face: SearchFace; q: string; filters: SearchFilters }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const disabled = !hasSavedSearchCriteria(q, filters);

  const onClick = async () => {
    setState("saving");
    setError(null);
    try {
      await saveSearch({ face, q, filters });
      setState("saved");
      savedTimer.current = setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("idle");
      setError(e instanceof Error ? e.message : "Could not save that search.");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || state === "saving"}
        title={disabled ? SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE : undefined}
        onClick={() => void onClick()}
      >
        {state === "saved" ? "Saved" : "Save search"}
      </Button>
      {error && <span role="alert" className="font-sora text-xs text-gk-warning">{error}</span>}
    </div>
  );
}

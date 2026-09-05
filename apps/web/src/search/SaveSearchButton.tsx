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
    // Fix round 2 (finding #1): the disabled hint used to render inline in
    // this button's own row, which is the search header's own no-wrap flex
    // row on every face (Task 8's headerSlot contract): at 360px that
    // sentence wrapped onto several lines and squeezed the search input out
    // of the row. Stacked onto its own line below the button now, and
    // hidden below the sm breakpoint entirely, so the header row's own
    // width never depends on this sentence fitting.
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || state === "saving"}
          onClick={() => void onClick()}
        >
          {state === "saved" ? "Saved" : "Save search"}
        </Button>
        {error && <span role="alert" className="font-sora text-xs text-gk-warning">{error}</span>}
      </div>
      {disabled && (
        <span className="hidden font-sora text-xs text-gk-muted sm:inline">{SAVED_SEARCH_EMPTY_CRITERIA_MESSAGE}</span>
      )}
    </div>
  );
}

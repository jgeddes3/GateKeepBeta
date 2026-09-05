"use client";
import { useState } from "react";
import {
  FACE_FILTER_KEYS, GENRES, SEARCH_LOCATION_OFF_MESSAGE, SEARCH_MAX_GENRES,
  type ActSize, type SearchFace, type SearchFilters, type SearchWhen,
} from "@gatekeep/shared";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { UseBrowserLocationState } from "./useBrowserLocation";

const WHEN_CHIPS: { value: SearchWhen; label: string }[] = [
  { value: "tonight", label: "Tonight" },
  { value: "weekend", label: "This weekend" },
  { value: "month", label: "Next 30 days" },
];

const ACT_SIZE_CHIPS: { value: ActSize; label: string }[] = [
  { value: "solo", label: "Solo" },
  { value: "duo", label: "Duo" },
  { value: "band", label: "Band" },
];

// value strings, not raw cents, so SelectItem's own value prop stays a
// string; "any" clears budgetMinCents entirely rather than sending 0.
const BUDGET_OPTIONS: { value: string; label: string; cents?: number }[] = [
  { value: "any", label: "Any" },
  { value: "10000", label: "$100+", cents: 10000 },
  { value: "25000", label: "$250+", cents: 25000 },
  { value: "50000", label: "$500+", cents: 50000 },
  { value: "100000", label: "$1,000+", cents: 100000 },
];

// Renders only the chips/controls FACE_FILTER_KEYS[face] allows: the same
// single source of truth the callable itself validates filters against
// (packages/shared/src/search.ts validateFilters), so a face can never
// show, let alone submit, a filter key it doesn't support.
export function FilterBar({ face, filters, onChange, location }: {
  face: SearchFace;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  location: UseBrowserLocationState;
}) {
  const allowed = FACE_FILTER_KEYS[face];
  const has = (key: keyof SearchFilters) => (allowed as readonly string[]).includes(key);
  const genres = filters.genres ?? [];
  const genresAtCap = genres.length >= SEARCH_MAX_GENRES;
  const locationOff = location.status === "denied" || location.status === "unsupported";

  // City is a free-text field applied on blur/Enter (not every keystroke,
  // unlike the debounced search box: filters change fetches instantly,
  // with no debounce of their own, so a live-typed city would fire a
  // request per character). This local draft is the only thing that
  // tracks each keystroke; it re-syncs from the committed filter whenever
  // that changes from elsewhere (e.g. a saved search loading in later), via
  // the same render-time reset useMyProfiles.ts's own trackedUid uses
  // rather than a useEffect (eslint-config-next's react-hooks/set-state-in-
  // effect rule flags a setState call reachable synchronously from an
  // effect).
  const [cityDraft, setCityDraft] = useState(filters.city ?? "");
  const [trackedCity, setTrackedCity] = useState(filters.city);
  if (filters.city !== trackedCity) {
    setTrackedCity(filters.city);
    setCityDraft(filters.city ?? "");
  }
  const commitCity = () => {
    const trimmed = cityDraft.trim();
    onChange({ ...filters, city: trimmed === "" ? undefined : trimmed });
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {has("when") && WHEN_CHIPS.map((w) => (
          <Chip key={w.value} active={filters.when === w.value}
            onClick={() => onChange({ ...filters, when: filters.when === w.value ? "any" : w.value })}>
            {w.label}
          </Chip>
        ))}

        {has("freeOnly") && (
          <Chip active={!!filters.freeOnly} onClick={() => onChange({ ...filters, freeOnly: !filters.freeOnly })}>
            Free
          </Chip>
        )}
        {has("hasAudio") && (
          <Chip active={!!filters.hasAudio} onClick={() => onChange({ ...filters, hasAudio: !filters.hasAudio })}>
            Has audio
          </Chip>
        )}
        {/* SP11 (spec 3.4): the spec calls this a checkbox on web, but
            FilterBar has no checkbox control and every sibling boolean here
            is a Chip with aria-pressed, so it ships as a chip (plan-recorded
            deviation, task-11 brief step 5). */}
        {has("allAges") && (
          <Chip active={!!filters.allAges} onClick={() => onChange({ ...filters, allAges: !filters.allAges })}>
            All ages only
          </Chip>
        )}

        {has("actSize") && ACT_SIZE_CHIPS.map((a) => (
          <Chip key={a.value} active={filters.actSize === a.value}
            onClick={() => onChange({ ...filters, actSize: filters.actSize === a.value ? undefined : a.value })}>
            {a.label}
          </Chip>
        ))}

        {has("nearMe") && (
          // Chip itself doesn't forward a `title` prop; a wrapping span
          // carries the tooltip instead, matching how any other
          // non-Chip-supported HTML attribute would have to reach this
          // control.
          <span title={locationOff ? SEARCH_LOCATION_OFF_MESSAGE : undefined}>
            <Chip
              active={!!filters.nearMe && location.status === "granted"}
              disabled={locationOff}
              onClick={() => {
                if (location.status !== "granted") { location.request(); return; }
                onChange({ ...filters, nearMe: !filters.nearMe });
              }}
            >
              Near me
            </Chip>
          </span>
        )}

        {has("budgetMinCents") && (
          <Select
            value={filters.budgetMinCents !== undefined ? String(filters.budgetMinCents) : "any"}
            onValueChange={(v) => onChange({ ...filters, budgetMinCents: v === "any" ? undefined : Number(v) })}
          >
            <SelectTrigger size="sm" aria-label="Minimum budget" className="w-fit"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BUDGET_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {has("city") && (
          <Input
            value={cityDraft}
            onChange={(e) => setCityDraft(e.target.value)}
            onBlur={commitCity}
            onKeyDown={(e) => { if (e.key === "Enter") commitCity(); }}
            placeholder="City"
            aria-label="City"
            className="w-36"
          />
        )}

        {has("availableOn") && (
          <label className="flex items-center gap-1.5 font-sora text-sm text-gk-muted">
            Free on
            <Input
              type="date"
              value={filters.availableOn ?? ""}
              onChange={(e) => onChange({ ...filters, availableOn: e.target.value === "" ? undefined : e.target.value })}
              className="w-auto"
            />
          </label>
        )}
      </div>

      {has("genres") && (
        <div className="flex flex-wrap gap-2">
          {GENRES.map((g) => {
            const active = genres.includes(g);
            return (
              <Chip
                key={g}
                active={active}
                disabled={genresAtCap && !active}
                onClick={() => onChange({
                  ...filters,
                  genres: active ? genres.filter((x) => x !== g) : genresAtCap ? genres : [...genres, g],
                })}
              >
                {formatChipLabel(g)}
              </Chip>
            );
          })}
        </div>
      )}

      {has("nearMe") && locationOff && (
        <p className="font-sora text-xs text-gk-muted">{SEARCH_LOCATION_OFF_MESSAGE}</p>
      )}
    </div>
  );
}

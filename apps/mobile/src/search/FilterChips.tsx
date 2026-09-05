import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  FACE_FILTER_KEYS, GENRES, SEARCH_LOCATION_OFF_MESSAGE, SEARCH_MAX_GENRES,
  type ActSize, type SearchFace, type SearchFilters, type SearchWhen,
} from "@gatekeep/shared";
import { formatChipLabel } from "../discover/discoverQueries";
import type { DeckLocationState } from "../discover/useDeckLocation";
import { Chip, Input, Text } from "../ui";
import { tokens } from "../theme/tokens";

// Mobile twin of apps/web/src/search/FilterBar.tsx: renders only the chips
// FACE_FILTER_KEYS[face] allows, the same single source of filter
// membership the callable itself validates against (packages/shared/src/
// search.ts validateFilters), so a face can never show, let alone submit, a
// filter key it doesn't support.

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

// value strings, not raw cents, so budgetMinCents can stay undefined for
// "any" without a magic 0 sentinel value in this list.
const BUDGET_OPTIONS: { label: string; cents: number | undefined }[] = [
  { label: "Any", cents: undefined },
  { label: "$100+", cents: 10_000 },
  { label: "$250+", cents: 25_000 },
  { label: "$500+", cents: 50_000 },
  { label: "$1,000+", cents: 100_000 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function FilterChips({ face, filters, onChange, location }: {
  face: SearchFace;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  location: Pick<DeckLocationState, "location" | "promptVisible" | "enable">;
}) {
  const allowed = FACE_FILTER_KEYS[face];
  const has = (key: keyof SearchFilters) => (allowed as readonly string[]).includes(key);
  const genres = filters.genres ?? [];
  const genresAtCap = genres.length >= SEARCH_MAX_GENRES;

  // City is a free-text field applied on blur/submit, not on every
  // keystroke (unlike q, which debounces; a filter change fetches
  // instantly, with no debounce of its own, so a live-typed city would fire
  // a request per character). This local draft is the only thing that
  // tracks each keystroke; it re-syncs from the committed filter whenever
  // that changes from elsewhere (e.g. a saved search loading in later,
  // Task 17), via the same render-time reset useSearch.ts's own trackedKey
  // uses rather than a useEffect.
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

  // availableOn has no date-picker dependency on mobile (ruling: the
  // YYYY-MM-DD placeholder hint is the affordance); applied live once the
  // typed text matches the full date shape, and cleared once the field is
  // emptied back out.
  const [dateDraft, setDateDraft] = useState(filters.availableOn ?? "");
  const [trackedDate, setTrackedDate] = useState(filters.availableOn);
  if (filters.availableOn !== trackedDate) {
    setTrackedDate(filters.availableOn);
    setDateDraft(filters.availableOn ?? "");
  }
  const onDateChange = (text: string) => {
    setDateDraft(text);
    if (text === "") { onChange({ ...filters, availableOn: undefined }); return; }
    if (DATE_RE.test(text)) onChange({ ...filters, availableOn: text });
  };

  const showChipRow = has("when") || has("freeOnly") || has("allAges") || has("hasAudio") || has("nearMe")
    || has("budgetMinCents") || has("actSize");

  return (
    <View style={{ gap: tokens.space.sm }}>
      {showChipRow && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {has("when") && WHEN_CHIPS.map((w) => (
            <Chip
              key={w.value}
              label={w.label}
              active={filters.when === w.value}
              onPress={() => onChange({ ...filters, when: filters.when === w.value ? "any" : w.value })}
            />
          ))}

          {has("freeOnly") && (
            <Chip label="Free" active={!!filters.freeOnly} onPress={() => onChange({ ...filters, freeOnly: !filters.freeOnly })} />
          )}
          {/* SP11 (spec 3.4): the fan-facing all-ages filter. */}
          {has("allAges") && (
            <Chip label="All ages only" active={!!filters.allAges}
              onPress={() => onChange({ ...filters, allAges: !filters.allAges })} />
          )}
          {has("hasAudio") && (
            <Chip label="Has audio" active={!!filters.hasAudio} onPress={() => onChange({ ...filters, hasAudio: !filters.hasAudio })} />
          )}

          {has("nearMe") && (
            <Chip
              label="Near me"
              // Never active without an actual fix: the checked value here is
              // the same guard useSearch.ts's buildInput applies before the
              // filter ever reaches the callable.
              active={!!filters.nearMe && location.location != null}
              onPress={() => {
                if (location.location) {
                  onChange({ ...filters, nearMe: !filters.nearMe });
                  return;
                }
                // No fix yet, so this tap can't turn the filter on. Unlike
                // web (no path back into a denied browser permission, so its
                // chip just goes inert), mobile's enable() can still do
                // something: it re-asks the OS prompt when askable, or falls
                // through to the Settings app when it isn't (useDeckLocation
                // .ts's own comment; the deck empty state's identical "Turn
                // on location" button uses the same call). Skipped only
                // while the initial prompt sheet is still up, so this chip
                // and that sheet never fight over the one OS dialog.
                if (!location.promptVisible) void location.enable();
              }}
            />
          )}

          {has("budgetMinCents") && BUDGET_OPTIONS.map((o) => (
            <Chip
              key={o.label}
              label={o.label}
              active={filters.budgetMinCents === o.cents}
              onPress={() => onChange({ ...filters, budgetMinCents: o.cents })}
            />
          ))}

          {has("actSize") && ACT_SIZE_CHIPS.map((a) => (
            <Chip
              key={a.value}
              label={a.label}
              active={filters.actSize === a.value}
              onPress={() => onChange({ ...filters, actSize: filters.actSize === a.value ? undefined : a.value })}
            />
          ))}
        </ScrollView>
      )}

      {has("genres") && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {GENRES.map((g) => {
            const active = genres.includes(g);
            return (
              <Chip
                key={g}
                label={formatChipLabel(g)}
                active={active}
                disabled={genresAtCap && !active}
                onPress={() => onChange({
                  ...filters,
                  genres: active ? genres.filter((x) => x !== g) : genresAtCap ? genres : [...genres, g],
                })}
              />
            );
          })}
        </ScrollView>
      )}

      {(has("city") || has("availableOn")) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {has("city") && (
            <Input
              value={cityDraft}
              onChangeText={setCityDraft}
              onBlur={commitCity}
              onSubmitEditing={commitCity}
              returnKeyType="search"
              placeholder="City"
              style={{ flex: 1, minWidth: 120 }}
            />
          )}
          {has("availableOn") && (
            <Input
              value={dateDraft}
              onChangeText={onDateChange}
              keyboardType="numbers-and-punctuation"
              placeholder="Free on (YYYY-MM-DD)"
              style={{ flex: 1, minWidth: 160 }}
            />
          )}
        </View>
      )}

      {has("nearMe") && location.location === null && (
        <Text variant="meta" muted>{SEARCH_LOCATION_OFF_MESSAGE}</Text>
      )}
    </View>
  );
}

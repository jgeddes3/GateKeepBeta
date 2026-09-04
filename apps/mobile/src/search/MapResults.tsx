import type { Region } from "react-native-maps";
import type { SearchPin } from "@gatekeep/shared";
import { formatGigDateTime } from "../gigs/GigForms";
import { Button, Card, Text } from "../ui";
import { tokens } from "../theme/tokens";
import { ResultsMap } from "./ResultsMap";

// Fix round 1 (minor #2): FanFace and MusicianFace's gigs segment both
// rendered the same "ResultsMap plus a selected-pin Card" pair, one with a
// SelectedShowCard and one with a SelectedGigCard that only differed in
// what onOpen actually did (route push vs GigDetailSheet). One component
// now: the row/pin "Open" action lives entirely in the caller's onOpen,
// this only ever calls it with the selected pin.
//
// Renders a Fragment, not a wrapping View: both callers place this inside
// a ScrollView whose own contentContainerStyle carries the gap, and a
// Fragment keeps ResultsMap and the selected Card as that ScrollView's own
// flex children (same host-view layout as before this extraction) rather
// than nesting them inside an extra View the gap would have to skip past.
export function MapResults({ pins, initialRegion, selected, onSelect, onOpen }: {
  pins: SearchPin[];
  initialRegion?: Region;
  selected: SearchPin | null;
  onSelect: (pin: SearchPin) => void;
  onOpen: (pin: SearchPin) => void;
}) {
  return (
    <>
      <ResultsMap pins={pins} onSelect={onSelect} initialRegion={initialRegion} />
      {selected && (
        <Card style={{ gap: tokens.space.xs }}>
          <Text variant="label">{selected.title}</Text>
          <Text variant="meta" muted>{selected.subtitle}</Text>
          {selected.startsAt != null && <Text variant="meta" muted>{formatGigDateTime(selected.startsAt)}</Text>}
          <Button
            title="Open"
            onPress={() => onOpen(selected)}
            style={{ marginTop: tokens.space.xs, alignSelf: "flex-start" }}
          />
        </Card>
      )}
    </>
  );
}

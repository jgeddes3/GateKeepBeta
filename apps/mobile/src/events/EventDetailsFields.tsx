import { useState } from "react";
import { View } from "react-native";
import {
  AGE_RESTRICTIONS, AGE_RESTRICTION_LABEL, DOORS_MAX_BEFORE_START_MS, EVENT_DOORS_MESSAGE,
  type AgeRestriction, type EventDoc,
} from "@gatekeep/shared";
import {
  OneOffDateTimeFields, oneOffDateTimeToMs, oneOffDateTimeFrom, emptyOneOffDateTime,
  type OneOffDateTimeState,
} from "../gigs/GigForms";
import { Text, Button, Card, Chip, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";

// Sub-project 11 (spec section 3.4, task 14): the curator event screen's
// "Details" card, doors and age only. This screen's own header comment
// records title/description/dates as a deliberate SP6 scoping decision that
// stays web-edit-only, so this is exactly the two fields the plan names for
// it, nothing else.
//
// Doors reuses the SAME three-input shape src/gigs/GigForms.tsx's own
// OneOffDateTimeFields already established on this platform (there is no
// date-picker dependency in this app, and this task adds none): Date
// (YYYY-MM-DD), then HH and MM. Seeded from event.doorsAt when set, from the
// event's own start date with a blank time otherwise, so Clear always has a
// sane date to return to. Save composes local-time epoch ms the same way
// oneOffDateTimeToMs already does for tier sale windows, applies the same
// client-side doors hint web's EventEditor uses (a light UX pre-check; the
// server's validateEventInput remains the sole authority), and hands the
// result up through onSave. This component never calls updateEvent itself:
// the screen owns that one save path (shared with LineupEditor's own
// mutations, see [eventId].tsx's saveEvent) so a single code path writes
// doors/age/lineup onto this doc.
export interface EventDetailsSave { doorsAt: number | null; ageRestriction: AgeRestriction; }

const seedDoors = (event: EventDoc): OneOffDateTimeState =>
  event.doorsAt != null
    ? oneOffDateTimeFrom(event.doorsAt)
    : { ...emptyOneOffDateTime(), date: oneOffDateTimeFrom(event.startsAt).date };

export function EventDetailsFields({ event, onSave, busy, error }: {
  event: EventDoc; onSave: (v: EventDetailsSave) => void; busy: boolean; error: string | null;
}) {
  const [doors, setDoors] = useState<OneOffDateTimeState>(() => seedDoors(event));
  const [age, setAge] = useState<AgeRestriction>(event.ageRestriction ?? "all_ages");
  const [hintError, setHintError] = useState<string | null>(null);

  const save = () => {
    setHintError(null);
    // A fully blank three-input set (never touched, or after Clear) means
    // "no doors time", not a validation failure: only a partially filled or
    // genuinely out-of-range value hits the hint below, mirroring web's own
    // `if (doorsInput && ...)` gate on its single datetime-local field.
    const isBlank = !doors.date.trim() && !doors.hour.trim() && !doors.minute.trim();
    const doorsAt = oneOffDateTimeToMs(doors);
    if (!isBlank && (doorsAt == null || doorsAt >= event.startsAt || event.startsAt - doorsAt > DOORS_MAX_BEFORE_START_MS)) {
      setHintError(EVENT_DOORS_MESSAGE);
      return;
    }
    onSave({ doorsAt: isBlank ? null : doorsAt, ageRestriction: age });
  };

  return (
    <Card style={{ gap: tokens.space.md }}>
      <Text variant="label">Details</Text>
      <View style={{ gap: 4 }}>
        <Text variant="meta" muted>Doors (optional)</Text>
        <OneOffDateTimeFields value={doors} onChange={setDoors} />
        <Button variant="secondary" title="Clear" onPress={() => setDoors(emptyOneOffDateTime())}
          disabled={busy} style={{ alignSelf: "flex-start" }} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="meta" muted>Age</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.space.sm }}>
          {AGE_RESTRICTIONS.map((a) => (
            <Chip key={a} label={AGE_RESTRICTION_LABEL[a]} active={age === a} onPress={() => setAge(a)} disabled={busy} />
          ))}
        </View>
      </View>
      <ErrorBanner message={hintError ?? error} />
      <Button title={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} style={{ alignSelf: "flex-start" }} />
    </Card>
  );
}

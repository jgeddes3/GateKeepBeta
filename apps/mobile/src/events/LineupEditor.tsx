import { useState } from "react";
import { View } from "react-native";
import type { EventAct, EventDoc, TaggedActStatus } from "@gatekeep/shared";
import { callFn } from "../lib/callable";
import { ArtistPickerSheet } from "./ArtistPickerSheet";
import { Text, Button, Card, Input, ErrorBanner, IconTrash } from "../ui";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

// Sub-project 11 (spec section 3.5, task 14): the curator event screen's
// "Lineup" card, replacing the read-only list this screen shipped with
// (its own header comment records that as a deliberate SP6 scoping gap).
// Mirrors web's LineupFields (apps/web/src/events/EventEditor.tsx) but
// saves immediately on every non-tag mutation rather than buffering into a
// "Save changes" button, since this screen has no content-editing save
// button to piggyback on: `onChange` IS the save, routed by the screen
// through the same updateEvent full-replace call EventDetailsFields uses
// (see [eventId].tsx's saveEvent), so one code path writes this doc.
//
// Reads event.lineup directly rather than keeping a local copy: the
// screen's own onSnapshot subscription re-renders this after every save,
// tag/untag included, per this task's own wiring note. tagEventArtist and
// untagEventArtist are the ONLY writers of a tagged act's stored status
// (eventArtistTags.ts's own header comment); this component never invents
// or edits one, it only reports the picked profile id and surfaces a
// failure locally.
//
// Fix round 1 (review): `busy`/`error` now come from the screen, same
// contract as EventDetailsFields, and reflect ONLY this card's own
// mutations (add/remove act, routed through onChange), never the Details
// card's save. Every action that could race a full-replace updateEvent
// write against another (Add act, remove, Untag, Tag a GateKeep artist)
// disables while `busy` is true, so a second rapid tap can't overwrite the
// first save through the full-replace shape. `localError` covers this
// card's own tag/untag failures and the client-side last-act guard below;
// it and the passed-in `error` share one ErrorBanner since both describe a
// failure to save THIS card's own edit.
const TAG_STATUS_LABEL: Record<TaggedActStatus, string> = { pending: "Pending", accepted: "Accepted", declined: "Declined" };

interface TagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }
interface UntagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }

// validateEventInput's own lineup bound (functions/src/eventsCore.ts): no
// shared message constant exists for this yet, so the exact server string
// is reused verbatim rather than inventing a client-only paraphrase that
// could drift from it.
const LINEUP_COUNT_MESSAGE = "Lineup must have 1-20 acts.";

export function LineupEditor({ event, eventId, onChange, busy, error }: {
  event: EventDoc; eventId: string; onChange: (lineup: EventAct[]) => void;
  busy: boolean; error: string | null;
}) {
  const t = useTokens();
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [untagBusyId, setUntagBusyId] = useState<string | null>(null);
  const lineup = event.lineup;

  const addAct = () => {
    const name = draft.trim();
    if (!name) return;
    setLocalError(null);
    onChange([...lineup, { kind: "external", name }]);
    setDraft("");
  };

  const removeAt = (i: number) => {
    // Client-side pre-check mirroring validateEventInput's own "1-20 acts"
    // bound: a light UX pre-check only (the server remains the sole
    // authority), but there's no reason to round-trip a removal the server
    // is certain to reject.
    if (lineup.length <= 1) {
      setLocalError(LINEUP_COUNT_MESSAGE);
      return;
    }
    setLocalError(null);
    onChange(lineup.filter((_, idx) => idx !== i));
  };

  // tagEventArtist is the ONLY writer of a `tagged` act's stored copy
  // (eventArtistTags.ts's own header comment); the screen's own onSnapshot
  // listener picks the new row up once the call lands, so this never
  // touches `lineup` locally on success, only on failure (localError).
  const handlePick = async (musicianProfileId: string) => {
    setLocalError(null);
    try {
      await callFn<TagEventArtistPayload, { actIndex: number }>("tagEventArtist",
        { curatorProfileId: event.curatorProfileId, eventId, musicianProfileId });
    } catch (e) {
      // The ARTIST_TAG_* messages (duplicate, unapproved, cap) are surfaced
      // verbatim, same discipline every other callable rejection in this
      // codebase follows.
      setLocalError(e instanceof Error ? e.message : "Could not tag this artist.");
    }
  };

  const untag = async (musicianProfileId: string) => {
    setLocalError(null);
    setUntagBusyId(musicianProfileId);
    try {
      await callFn<UntagEventArtistPayload, { ok: true }>("untagEventArtist",
        { curatorProfileId: event.curatorProfileId, eventId, musicianProfileId });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Could not untag this artist.");
    } finally {
      setUntagBusyId(null);
    }
  };

  return (
    <Card style={{ gap: tokens.space.md }}>
      <Text variant="label">Lineup</Text>
      {lineup.length === 0 && <Text muted>No acts yet.</Text>}
      {lineup.map((act, i) => (
        <View key={`${act.kind}-${i}-${act.name}`} style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1}>{act.name}</Text>
            {act.kind === "booking" && <Text variant="meta" muted>(booked act)</Text>}
            {act.kind === "tagged" && <Text variant="meta" muted>{TAG_STATUS_LABEL[act.status]}</Text>}
          </View>
          {act.kind === "tagged" && (
            <Button variant="ghost" title={untagBusyId === act.musicianProfileId ? "Untagging…" : "Untag"}
              onPress={() => void untag(act.musicianProfileId)} disabled={busy || untagBusyId === act.musicianProfileId} />
          )}
          <Button variant="ghost" onPress={() => removeAt(i)} disabled={busy} accessibilityLabel={`Remove ${act.name}`}>
            <IconTrash size={16} color={t.muted} />
          </Button>
        </View>
      ))}
      <ErrorBanner message={localError ?? error} />
      <View style={{ flexDirection: "row", gap: tokens.space.sm, alignItems: "center" }}>
        <Input value={draft} onChangeText={setDraft} placeholder="Act name" maxLength={80} editable={!busy} style={{ flex: 1 }} />
        <Button variant="secondary" title="Add act" onPress={addAct} disabled={busy || !draft.trim()} />
      </View>
      <Button variant="secondary" title="Tag a GateKeep artist" onPress={() => setPickerOpen(true)} disabled={busy} />
      <ArtistPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)}
        onPick={(profileId) => void handlePick(profileId)} />
    </Card>
  );
}

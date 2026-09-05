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
const TAG_STATUS_LABEL: Record<TaggedActStatus, string> = { pending: "Pending", accepted: "Accepted", declined: "Declined" };

interface TagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }
interface UntagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }

export function LineupEditor({ event, eventId, onChange }: {
  event: EventDoc; eventId: string; onChange: (lineup: EventAct[]) => void;
}) {
  const t = useTokens();
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [untagBusyId, setUntagBusyId] = useState<string | null>(null);
  const lineup = event.lineup;

  const addAct = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([...lineup, { kind: "external", name }]);
    setDraft("");
  };

  const removeAt = (i: number) => onChange(lineup.filter((_, idx) => idx !== i));

  const handlePick = async (musicianProfileId: string) => {
    setTagError(null);
    try {
      await callFn<TagEventArtistPayload, { actIndex: number }>("tagEventArtist",
        { curatorProfileId: event.curatorProfileId, eventId, musicianProfileId });
    } catch (e) {
      // The ARTIST_TAG_* messages (duplicate, unapproved, cap) are surfaced
      // verbatim, same discipline every other callable rejection in this
      // codebase follows.
      setTagError(e instanceof Error ? e.message : "Could not tag this artist.");
    }
  };

  const untag = async (musicianProfileId: string) => {
    setTagError(null);
    setUntagBusyId(musicianProfileId);
    try {
      await callFn<UntagEventArtistPayload, { ok: true }>("untagEventArtist",
        { curatorProfileId: event.curatorProfileId, eventId, musicianProfileId });
    } catch (e) {
      setTagError(e instanceof Error ? e.message : "Could not untag this artist.");
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
              onPress={() => void untag(act.musicianProfileId)} disabled={untagBusyId === act.musicianProfileId} />
          )}
          <Button variant="ghost" onPress={() => removeAt(i)} accessibilityLabel={`Remove ${act.name}`}>
            <IconTrash size={16} color={t.muted} />
          </Button>
        </View>
      ))}
      <ErrorBanner message={tagError} />
      <View style={{ flexDirection: "row", gap: tokens.space.sm, alignItems: "center" }}>
        <Input value={draft} onChangeText={setDraft} placeholder="Act name" maxLength={80} style={{ flex: 1 }} />
        <Button variant="secondary" title="Add act" onPress={addAct} disabled={!draft.trim()} />
      </View>
      <Button variant="secondary" title="Tag a GateKeep artist" onPress={() => setPickerOpen(true)} />
      <ArtistPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)}
        onPick={(profileId) => void handlePick(profileId)} />
    </Card>
  );
}

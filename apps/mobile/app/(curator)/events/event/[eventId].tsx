import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, onSnapshot, collection, getDocs, orderBy, query } from "firebase/firestore";
import { getFirebase } from "../../../../src/lib/firebase";
import { callFn } from "../../../../src/lib/callable";
import { useAuth } from "../../../../src/auth/AuthProvider";
import type { AgeRestriction, EventAct, EventDoc, TicketTierDoc } from "@gatekeep/shared";
import { gigLocationLabel } from "../../../../src/bookings/BookingForms";
import {
  formatEventFullDate, formatEventTimeRange, EVENT_STATUS_LABEL, EVENT_STATUS_TONE,
} from "../../../../src/events/eventDisplay";
import { TierEditor, TierSalesStats, tierRowFrom, type TierRowState } from "../../../../src/events/TierEditor";
import { PosterField } from "../../../../src/events/PosterField";
import { EventDetailsFields, type EventDetailsSave } from "../../../../src/events/EventDetailsFields";
import { LineupEditor } from "../../../../src/events/LineupEditor";
import {
  Text, Button, Card, StatusBadge, TextArea, PageBackground, Skeleton, SkeletonCard, ErrorBanner,
} from "../../../../src/ui";
import { tokens } from "../../../../src/theme/tokens";
import { useTokens } from "../../../../src/theme/ThemeProvider";

// Sub-project 6 task 12: the ticketed-event management screen. Brief anatomy
// (verbatim): status, tiers editor per callable constraints, publish/cancel
// with destructive confirm, per-tier sold/capacity, sales total. Content
// editing (title/description/dates, mirrors web's EventEditContentForm) is
// deliberately NOT part of this screen: the brief's own anatomy for this
// task names exactly the five things above, unlike web's Task 10 twin, which
// bundles content editing alongside tiers/publish/cancel. Title, description,
// and dates stay web-edit-only, the same kind of recorded scoping decision
// Task 10's own report made for its poster-upload and lineup-picker gaps.
//
// Sub-project 11 task 14 (spec sections 3.4/3.5) adds exactly the two
// surfaces the plan names for THIS screen on top of that: doors/age
// (EventDetailsFields) and the artist-tag lineup editor (LineupEditor),
// both full-replace `updateEvent` writers through the shared saveEvent
// below, same as savePoster already is.

// ---------- Cancel confirm (controller ruling 9, binding): an inline
// destructive panel, NOT a Sheet, mirroring src/bookings/CancelDialog.tsx
// exactly (sp9b ruling 5's own precedent for this codebase). ----------
function CancelEventPanel({ curatorProfileId, eventId, title, onClose, onCancelled }: {
  curatorProfileId: string; eventId: string; title: string; onClose: () => void; onCancelled: () => void;
}) {
  const t = useTokens();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await callFn("cancelEvent",
        { curatorProfileId, eventId, reason: reason.trim() || undefined });
      onCancelled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel this event.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: t.destructive, borderRadius: tokens.radius.card,
      padding: tokens.space.md, gap: tokens.space.md, backgroundColor: t.destructive + "24" }}>
      <Text variant="label">Cancel &quot;{title}&quot;?</Text>
      {/* Controller ruling from Task 10's own web twin, carried here
          verbatim: the confirm panel must spell out that cancelEvent
          auto-refunds everything. */}
      <Text color={t.destructive}>
        This cancels the event and automatically refunds every ticket already sold, in full. This can&apos;t be undone.
      </Text>
      <TextArea numberOfLines={2} maxLength={500} value={reason} editable={!busy}
        onChangeText={setReason} placeholder="Reason (optional, shown to ticket holders)" style={{ minHeight: 50 }} />
      <ErrorBanner message={error} />
      <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Button variant="destructive" title={busy ? "Cancelling…" : "Confirm cancellation"} onPress={() => void submit()} disabled={busy} />
        <Button variant="secondary" title="Back" onPress={onClose} disabled={busy} />
      </View>
    </View>
  );
}

export default function EventManagementScreen() {
  const { eventId: rawEventId } = useLocalSearchParams<{ eventId: string }>();
  const eventId = rawEventId ?? "";
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const [event, setEvent] = useState<EventDoc | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterError, setPosterError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Render-time reset, same idiom as [gigId].tsx's privLocGigId: this screen
  // does not remount when navigating from one event's management screen
  // directly to another's (same route pattern, different eventId).
  const [loadedEventId, setLoadedEventId] = useState(eventId);
  if (eventId !== loadedEventId) { setLoadedEventId(eventId); setEvent(null); }

  useEffect(() => {
    if (!eventId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "events", eventId),
      (s) => setEvent(s.exists() ? (s.data() as EventDoc) : null),
      () => setEvent(null));
  }, [eventId]);

  // Tiers one-shot buffer for TierEditor (see that file's own header comment
  // on why this is deliberately not a live subscription): re-fetched only
  // when `eventId` itself changes, same pattern as event/[eventId]'s render-
  // time reset above and web's EventsManager.tsx tiersEventId trick.
  const [tiersEventId, setTiersEventId] = useState<string | null>(null);
  const [initialTiers, setInitialTiers] = useState<TierRowState[] | "loading">("loading");
  if (eventId !== tiersEventId) { setTiersEventId(eventId); setInitialTiers("loading"); }
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder")))
      .then((snap) => { if (!cancelled) setInitialTiers(snap.docs.map((d) => tierRowFrom(d.id, d.data() as TicketTierDoc))); })
      .catch((e) => { console.error("EventManagementScreen: tier load failed", eventId, e); if (!cancelled) setInitialTiers([]); });
    return () => { cancelled = true; };
  }, [eventId]);

  if (!user || !event || initialTiers === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={28} width="60%" />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </View>
    );
  }

  const editable = event.status === "draft" || event.status === "published";

  const publish = async () => {
    setPublishBusy(true);
    setPublishError(null);
    try {
      await callFn("publishEvent", { curatorProfileId: event.curatorProfileId, eventId });
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setPublishBusy(false);
    }
  };

  // The mobile screen has no title/description/dates editor, so the poster
  // saves on its own through updateEvent's full-replace payload: every
  // current field of the live event doc plus the new posterPath. Content
  // stays web-edit-only (this file's own header), this is the one field
  // mobile writes on its own here.
  const savePoster = async (path: string | null) => {
    setPosterBusy(true);
    setPosterError(null);
    try {
      await callFn("updateEvent", {
        curatorProfileId: event.curatorProfileId, eventId,
        title: event.title, description: event.description, startsAt: event.startsAt, endsAt: event.endsAt,
        maxTicketsPerBuyer: event.maxTicketsPerBuyer, lineup: event.lineup, posterPath: path,
        doorsAt: event.doorsAt ?? null, ageRestriction: event.ageRestriction ?? "all_ages",
      });
    } catch (e) {
      setPosterError(e instanceof Error ? e.message : "Could not save the poster.");
    } finally {
      setPosterBusy(false);
    }
  };

  // Task 14's second writer of this doc, sharing one code path with
  // EventDetailsFields' Save button and LineupEditor's own tag-free
  // mutations (add/remove act): full-replace, like savePoster above, always
  // resending whichever of doorsAt/ageRestriction/lineup this particular
  // call is NOT changing from the live event doc, so neither caller
  // clobbers the other's last write.
  const saveEvent = async (patch: { doorsAt?: number | null; ageRestriction?: AgeRestriction; lineup?: EventAct[] }) => {
    setSaveBusy(true);
    setSaveError(null);
    try {
      await callFn("updateEvent", {
        curatorProfileId: event.curatorProfileId, eventId,
        title: event.title, description: event.description, startsAt: event.startsAt, endsAt: event.endsAt,
        maxTicketsPerBuyer: event.maxTicketsPerBuyer, posterPath: event.posterPath,
        lineup: patch.lineup ?? event.lineup,
        doorsAt: patch.doorsAt !== undefined ? patch.doorsAt : (event.doorsAt ?? null),
        ageRestriction: patch.ageRestriction ?? (event.ageRestriction ?? "all_ages"),
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <Text variant="heading" style={{ flex: 1 }}>{event.title || "Untitled event"}</Text>
          <StatusBadge label={EVENT_STATUS_LABEL[event.status]} status={EVENT_STATUS_TONE[event.status]} />
        </View>
        {event.gigId && <Text variant="meta" muted>Promoted from a booked gig.</Text>}

        <Card style={{ gap: 4 }}>
          <Text variant="label">{formatEventFullDate(event.startsAt)}</Text>
          <Text muted>{formatEventTimeRange(event.startsAt, event.endsAt)}</Text>
          <Text muted>{gigLocationLabel(event.location)}</Text>
        </Card>

        {editable && (
          <EventDetailsFields
            event={event} busy={saveBusy} error={saveError}
            onSave={(v: EventDetailsSave) => void saveEvent(v)}
          />
        )}

        {editable && (
          <LineupEditor event={event} eventId={eventId} onChange={(lineup) => void saveEvent({ lineup })} />
        )}

        {editable && (
          <Card style={{ gap: tokens.space.sm }}>
            <Text variant="label">Poster</Text>
            <PosterField
              curatorProfileId={event.curatorProfileId} value={event.posterPath}
              onChange={(path) => void savePoster(path)} saving={posterBusy} saveError={posterError}
            />
          </Card>
        )}

        <TierSalesStats eventId={eventId} />

        <View style={{ gap: tokens.space.sm }}>
          <Button title="Door scanner & attendees" onPress={() => router.push({ pathname: "/(curator)/events/scan/[eventId]", params: { eventId } })} />
        </View>

        <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg, gap: tokens.space.md }}>
          <Text variant="title">Ticket tiers</Text>
          <TierEditor
            key={eventId} curatorProfileId={event.curatorProfileId} eventId={eventId}
            eventStatus={event.status} initialTiers={initialTiers}
          />
        </View>

        {event.status === "draft" && (
          <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg, gap: tokens.space.sm }}>
            <Button title={publishBusy ? "Publishing…" : "Publish event"} disabled={publishBusy} onPress={() => void publish()} />
            <ErrorBanner message={publishError} />
          </View>
        )}

        {editable && (
          <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg }}>
            {showCancel ? (
              <CancelEventPanel
                curatorProfileId={event.curatorProfileId} eventId={eventId} title={event.title}
                onClose={() => setShowCancel(false)} onCancelled={() => setShowCancel(false)}
              />
            ) : (
              <Button variant="secondary" onPress={() => setShowCancel(true)} style={{ alignSelf: "flex-start" }}>
                <Text variant="label" color={t.destructive}>Cancel this event</Text>
              </Button>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

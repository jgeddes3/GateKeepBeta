import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { doc, getDoc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { callFn } from "../../../src/lib/callable";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import {
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, BUDGET_STRUCTURE_LABEL, WEEKDAY_LABELS, GIG_STATUS_TONE,
  formatGigDateTime, formatCents,
  LocationFields, MAX_ADDRESS_LENGTH, OneOffDateTimeFields, emptyOneOffDateTime, oneOffDateTimeFrom, oneOffDateTimeToMs,
  type LocationValue,
} from "../../../src/gigs/GigForms";
import { EVENT_STATUS_LABEL, EVENT_STATUS_TONE, formatEventFullDate, formatGigTime } from "../../../src/events/eventDisplay";
import { TierBars } from "../../../src/events/TierEditor";
import { formatChipLabel } from "../../../src/discover/discoverQueries";
import { GENRES, type ProfileDoc, type GigDoc, type GigSeriesDoc, type EventDoc, type EventAct } from "@gatekeep/shared";
import {
  Text, Button, Card, Chip, Input, TextArea, StatusBadge, PageBackground, Skeleton, SkeletonCard, ErrorBanner,
  IconPlus, IconTrash, IconTicket, IconWarningCircle,
} from "../../../src/ui";
import { useTokens } from "../../../src/theme/ThemeProvider";
import { tokens } from "../../../src/theme/tokens";

type GigRow = GigDoc & { id: string };
type SeriesRow = GigSeriesDoc & { id: string };
type EventRow = EventDoc & { id: string };

// Sorted ascending (soonest first) for open/drafts, "what's coming up" is
// the useful question there, and descending (most recent first) for the
// past group, where "what just happened" matters more. Mirrors web's
// dashboard/curator/[profileId]/gigs/page.tsx exactly. Widened to a bare
// `{startsAt}` shape (Task 12) so both GigRow and EventRow share the same
// two comparators instead of near-duplicate copies.
const byStartsAtAsc = (a: { startsAt: number }, b: { startsAt: number }) => a.startsAt - b.startsAt;
const byStartsAtDesc = (a: { startsAt: number }, b: { startsAt: number }) => b.startsAt - a.startsAt;

function GigListItem({ gig, onPress, onSeriesPress }: {
  gig: GigRow; onPress: () => void; onSeriesPress: () => void;
}) {
  const t = useTokens();
  return (
    <Pressable onPress={onPress}>
      <Card style={{ padding: tokens.space.md, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{gig.title || "Untitled gig"}</Text>
          <StatusBadge label={GIG_STATUS_LABEL[gig.status]} status={GIG_STATUS_TONE[gig.status]} />
        </View>
        <Text variant="meta" muted>
          {formatGigDateTime(gig.startsAt)}
          {" · "}{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
        </Text>
        {gig.seriesId && (
          <Pressable onPress={onSeriesPress} hitSlop={8}>
            <Text variant="meta" color={t.accent}>series{gig.detachedFromTemplate ? " (detached)" : ""} →</Text>
          </Pressable>
        )}
      </Card>
    </Pressable>
  );
}

// ---------- Ticketed-event row (Task 12: events index gains ticketed-event
// rows alongside the existing gig rows, tap -> management). RN twin of
// web's EventsManager.tsx EventListRow, poster thumb omitted (this task
// ships poster-less event creation, mirroring web Task 10's own scoping
// note; every event here renders via plain text, same as GigListItem's own
// thumb-less card). ----------
function EventListItem({ event, onPress }: { event: EventRow; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <Card style={{ padding: tokens.space.md, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{event.title || "Untitled event"}</Text>
          <StatusBadge label={EVENT_STATUS_LABEL[event.status]} status={EVENT_STATUS_TONE[event.status]} />
        </View>
        <Text variant="meta" muted>{formatEventFullDate(event.startsAt)} · {formatGigTime(event.startsAt)}</Text>
        <TierBars eventId={event.id} />
      </Card>
    </Pressable>
  );
}

// ---------- Event creation (Task 12 ruling 5: "create-standalone +
// promote-filled-gig entry points" on the index; there's no separate route
// for this in the brief's file list, so it's a local view-state overlay on
// this same screen, mirroring web's EventsManager.tsx "list/picker/create"
// state machine exactly). Content editing after creation (title/description/
// dates/lineup) stays web-only, see event/[eventId].tsx's own header note:
// this create form is the ONLY place mobile ever writes those fields. ----------

// apps/mobile never depends on functions/src types (same boundary GigForms.tsx's
// CreateGigPayload documents): createEvent's real input interface lives in
// functions/src/events.ts and is hand-mirrored below, matching web's own
// EventEditor.tsx EventSourceInput/CreateEventPayload byte-for-byte.
type EventSourceInput =
  | { kind: "standalone"; location?: { address?: string | null; addressVisibility?: "public" | "neighborhood" } }
  | { kind: "gig"; gigId: string };
interface CreateEventPayload {
  curatorProfileId: string; source: EventSourceInput;
  title: string; description: string; startsAt: number; endsAt: number; lineup: EventAct[];
  curatorGenres?: string[];
}

// ---------- Genres editor (SP7 Task 11, controller ruling): a curator can
// override the event's discovery genres directly, for when its lineup is all
// external acts with no GateKeep profile of their own to derive genres from
// (EventDoc.genres' own doc comment: curatorGenres wins when set, else the
// union of lineup booking acts' portfolio.genres). The RN twin of web's own
// GenresFields (apps/web/src/events/EventEditor.tsx): same GENRES list, same
// 3-pick cap, same at-cap disabled state and same helper copy, built on this
// app's Chip primitive (BioGenresForm's own genre picker already uses it)
// rather than web's. ----------
function GenresFields({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const atCap = selected.length >= 3;
  const toggle = (g: string) =>
    onChange(selected.includes(g) ? selected.filter((x) => x !== g) : selected.length < 3 ? [...selected, g] : selected);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => {
          const active = selected.includes(g);
          // Fix round 1 (review, Minor): once 3 are selected, an unselected
          // chip disables rather than accepting a silent no-op tap (toggle's
          // own `selected.length < 3` guard already refused the fourth
          // pick; this just makes that refusal visible on the chip itself).
          // An already-selected chip stays enabled so it can still be
          // deselected at the cap.
          return (
            <Chip key={g} label={formatChipLabel(g)} active={active} onPress={() => toggle(g)}
              disabled={atCap && !active} />
          );
        })}
      </View>
      <Text variant="meta" muted>Used when your acts have no GateKeep profile. Up to three.</Text>
    </View>
  );
}

function LineupFields({ lineup, onChange }: { lineup: EventAct[]; onChange: (v: EventAct[]) => void }) {
  const t = useTokens();
  const [draft, setDraft] = useState("");
  const addAct = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([...lineup, { kind: "external", name }]);
    setDraft("");
  };
  return (
    <View style={{ gap: 8 }}>
      {lineup.map((act, i) => (
        <View key={`${act.kind}-${i}-${act.name}`} style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8,
          borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.sm, paddingVertical: 6, paddingHorizontal: 10,
        }}>
          <Text style={{ flex: 1 }} numberOfLines={1}>
            {act.name}{act.kind === "booking" ? " (booked act)" : ""}
          </Text>
          <Button variant="ghost" onPress={() => onChange(lineup.filter((_, idx) => idx !== i))} accessibilityLabel={`Remove ${act.name}`}>
            <IconTrash size={16} color={t.muted} />
          </Button>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Input value={draft} onChangeText={setDraft} placeholder="Act name" maxLength={80} style={{ flex: 1 }} />
        <Button variant="secondary" title="Add act" onPress={addAct} disabled={!draft.trim()} />
      </View>
      <Text variant="meta" muted>At least one act is required.</Text>
    </View>
  );
}

function GigPromotePicker({ gigs, onPick, onClose }: { gigs: GigRow[]; onPick: (gig: GigRow) => void; onClose: () => void }) {
  return (
    <View style={{ gap: tokens.space.md }}>
      <Text variant="title">Promote a filled gig</Text>
      {gigs.length === 0 ? (
        <Text muted>No filled gigs are available to promote. A gig needs a confirmed act before it can become a ticketed event.</Text>
      ) : (
        <View style={{ gap: tokens.space.sm }}>
          {gigs.map((g) => (
            <Pressable key={g.id} onPress={() => onPick(g)}>
              <Card style={{ gap: 4 }}>
                <Text variant="label" numberOfLines={1}>{g.title || "Untitled gig"}</Text>
                <Text variant="meta" muted>{formatGigDateTime(g.startsAt)}</Text>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
      <Button variant="secondary" title="Back" onPress={onClose} />
    </View>
  );
}

function EventCreateForm({ profileId, isVenue, curatorAddress, source, seedTitle, seedStartsAt, seedLineup, onCreated, onCancel }: {
  profileId: string; isVenue: boolean; curatorAddress: string | null; source: EventSourceInput;
  seedTitle?: string; seedStartsAt?: number; seedLineup?: EventAct[];
  onCreated: (eventId: string) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(seedTitle ?? "");
  const [description, setDescription] = useState("");
  const [startDT, setStartDT] = useState(seedStartsAt ? oneOffDateTimeFrom(seedStartsAt) : emptyOneOffDateTime());
  const [endDT, setEndDT] = useState(seedStartsAt ? oneOffDateTimeFrom(seedStartsAt + 2 * 3_600_000) : emptyOneOffDateTime());
  const [lineup, setLineup] = useState<EventAct[]>(seedLineup ?? []);
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: isVenue ? "public" : "neighborhood" });
  const [genres, setGenres] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) { setError("Title must be 1-120 characters."); return; }
    const startsAt = oneOffDateTimeToMs(startDT);
    const endsAt = oneOffDateTimeToMs(endDT);
    if (startsAt == null) { setError("Pick a start date and time."); return; }
    if (endsAt == null || endsAt <= startsAt) { setError("End time must be after the start time."); return; }
    if (startsAt <= Date.now()) { setError("Start time must be in the future."); return; }
    if (lineup.length === 0) { setError("Add at least one act to the lineup."); return; }

    let resolvedSource: EventSourceInput = source;
    if (source.kind === "standalone") {
      const trimmedAddress = location.address.trim();
      if (!isVenue && trimmedAddress.length === 0) { setError("An address is required for this event."); return; }
      if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
      resolvedSource = { kind: "standalone", location: { address: trimmedAddress || null, addressVisibility: location.visibility } };
    }

    setBusy(true);
    try {
      const payload: CreateEventPayload = {
        curatorProfileId: profileId, source: resolvedSource, title: trimmedTitle, description: description.trim(), startsAt, endsAt, lineup,
        curatorGenres: genres.length > 0 ? genres : undefined,
      };
      const { data } = await callFn<CreateEventPayload, { eventId: string }>("createEvent", payload);
      onCreated(data.eventId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create this event.");
    } finally {
      setBusy(false);
    }
  };

  const currentLabel = source.kind === "gig"
    ? "This event's location comes from the promoted gig."
    : isVenue
      ? (curatorAddress ? `Your venue's address on file: ${curatorAddress}` : "No venue address on file yet.")
      : "Enter the address for this event.";

  return (
    <View style={{ gap: tokens.space.lg }}>
      <Text variant="title">{source.kind === "gig" ? "Promote to a ticketed event" : "New ticketed event"}</Text>
      <View style={{ gap: 4 }}>
        <Text variant="label">Title</Text>
        <Input maxLength={120} value={title} onChangeText={setTitle} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="label">Description</Text>
        <TextArea numberOfLines={4} maxLength={4000} value={description} onChangeText={setDescription} style={{ minHeight: 90 }} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="label">Starts</Text>
        <OneOffDateTimeFields value={startDT} onChange={setStartDT} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="label">Ends</Text>
        <OneOffDateTimeFields value={endDT} onChange={setEndDT} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="label">Lineup</Text>
        <LineupFields lineup={lineup} onChange={setLineup} />
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="label">Genres (optional)</Text>
        <GenresFields selected={genres} onChange={setGenres} />
      </View>
      {source.kind === "standalone" ? (
        <LocationFields
          isVenue={isVenue} addressRequired={!isVenue} currentLabel={currentLabel} value={location} onChange={setLocation}
          entityNoun="event"
        />
      ) : (
        <Text muted>{currentLabel}</Text>
      )}
      <ErrorBanner message={error} />
      <Button title={busy ? "Creating…" : "Create event (draft)"} disabled={busy} onPress={() => void submit()} />
      <Button variant="secondary" title="Back" onPress={onCancel} disabled={busy} />
    </View>
  );
}

// Local view-state machine, not a nested route (mirrors web's EventsManager
// "list/picker/create" states exactly, see this file's own comment above
// LineupFields): "list" is the default; "picker" is the gig-promotion step;
// "create" covers both standalone and promoted-gig creation.
type EventView =
  | { kind: "list" }
  | { kind: "picker" }
  | { kind: "create"; source: EventSourceInput; seedTitle?: string; seedStartsAt?: number; seedLineup?: EventAct[] };

export default function GigsList() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [gigs, setGigs] = useState<GigRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [view, setView] = useState<EventView>({ kind: "list" });

  // Same render-time-reset + late-callback guard as (curator)/dashboard.tsx:
  // this tab's landing screen stays mounted across a profile-context switch
  // (the outer Tabs navigator keeps a tab's nested Stack mounted in the
  // background by default), so without both of these, switching curator
  // profiles could leave the PREVIOUS profile's gigs/series on screen, the
  // render-time reset alone still has a narrow post-commit window where a
  // still-in-flight onSnapshot callback for the OLD profileId can resolve
  // after the reset but before its own effect cleanup unsubscribes it (React
  // runs effect cleanup at the passive-effect flush, after commit+paint, not
  // synchronously during the render-time reset below).
  const activeIdRef = useRef(profileId);
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null); setGigs([]); setSeries([]); setEvents([]); setView({ kind: "list" });
  }

  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => { if (activeIdRef.current !== forId) return; setProfile(s.exists() ? (s.data() as ProfileDoc) : null); },
      () => { if (activeIdRef.current !== forId) return; setProfile(null); });
  }, [profileId]);
  // where(curatorProfileId=='X') with NO status filter, rules-provable for a
  // member via the member disjunct alone (see firestore.rules' comment on
  // gigs' read rule + tests-rules/rules.test.ts's "curator dashboard" test),
  // and needs no composite index (single equality field). Every status comes
  // back in one listener; the open/drafts/past grouping below is purely
  // client-side. Mirrors web's identical query exactly.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setGigs(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))); });
  }, [profileId]);
  // Same shape for gigSeries, its read rule (isMember(curatorProfileId) ||
  // isAdmin(), no public disjunct) is provable the identical way.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigSeries"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setSeries(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigSeriesDoc) }))); });
  }, [profileId]);
  // where(curatorProfileId=='X') with NO status filter: rules-provable for a
  // member via the isMember disjunct alone (firestore.rules' events read
  // rule), same shape as the gigs query above, and every status comes back
  // in one listener. Mirrors web's EventsManager.tsx identical query.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "events"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setEvents(s.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) }))); });
  }, [profileId]);

  if (!user || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">No curator profile</Text>
          <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to see its gigs.</Text>
        </View>
      </View>
    );
  }
  if (!profile) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={44} />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </View>
    );
  }

  // A gig, once promoted, stays ineligible for "Promote a gig" regardless of
  // its resulting event's status (including cancelled), mirrors web's
  // EventsManager.tsx identical `usedGigIds` rule.
  const usedGigIds = new Set(events.filter((e) => e.gigId).map((e) => e.gigId));
  const eligibleGigsForPromotion = gigs.filter((g) => g.status === "filled" && !usedGigIds.has(g.id));

  const promoteGig = async (gig: GigRow) => {
    let seedLineup: EventAct[] = [];
    if (gig.bookingId && gig.bookedMusicianProfileId) {
      try {
        const snap = await getDoc(doc(getFirebase().db, "profiles", gig.bookedMusicianProfileId));
        const actName = snap.exists() ? (snap.data() as ProfileDoc).name : gig.title;
        seedLineup = [{ kind: "booking", bookingId: gig.bookingId, musicianProfileId: gig.bookedMusicianProfileId, name: actName }];
      } catch (e) {
        console.warn("GigsList: booked-act name lookup failed, promoting without a seeded lineup", gig.id, e);
      }
    }
    setView({ kind: "create", source: { kind: "gig", gigId: gig.id }, seedTitle: gig.title, seedStartsAt: gig.startsAt, seedLineup });
  };

  if (view.kind === "picker") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <ScrollView contentContainerStyle={{ padding: tokens.space.lg }} keyboardShouldPersistTaps="handled">
          <GigPromotePicker gigs={eligibleGigsForPromotion} onPick={(g) => void promoteGig(g)} onClose={() => setView({ kind: "list" })} />
        </ScrollView>
      </View>
    );
  }
  if (view.kind === "create") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <ScrollView contentContainerStyle={{ padding: tokens.space.lg }} keyboardShouldPersistTaps="handled">
          <EventCreateForm
            profileId={profileId} isVenue={profile.subtype === "venue"} curatorAddress={profile.curator?.location?.address ?? null}
            source={view.source} seedTitle={view.seedTitle} seedStartsAt={view.seedStartsAt} seedLineup={view.seedLineup}
            onCreated={(eventId) => {
              setView({ kind: "list" });
              router.push({ pathname: "/(curator)/events/event/[eventId]", params: { eventId } });
            }}
            onCancel={() => setView({ kind: "list" })}
          />
        </ScrollView>
      </View>
    );
  }

  const open = gigs.filter((g) => g.status === "open").sort(byStartsAtAsc);
  const drafts = gigs.filter((g) => g.status === "draft").sort(byStartsAtAsc);
  const past = gigs.filter((g) => g.status === "closed" || g.status === "cancelled" || g.status === "taken_down").sort(byStartsAtDesc);
  const activeEvents = events.filter((e) => e.status === "draft" || e.status === "published").sort(byStartsAtAsc);
  const pastEvents = events.filter((e) => e.status === "completed" || e.status === "cancelled").sort(byStartsAtDesc);

  const openGig = (gigId: string) => router.push({ pathname: "/(curator)/events/[gigId]", params: { gigId } });
  const openSeries = (seriesId: string) => router.push({ pathname: "/(curator)/events/series/[seriesId]", params: { seriesId } });
  const openEvent = (eventId: string) => router.push({ pathname: "/(curator)/events/event/[eventId]", params: { eventId } });

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }} keyboardShouldPersistTaps="handled">
        {profile.status === "approved" ? (
          <Button title="+ Post a new gig" onPress={() => router.push("/(curator)/events/new")} />
        ) : (
          <Text muted>Your curator profile must be approved before you can post gigs.</Text>
        )}

        <View style={{ gap: 8 }}>
          <Text variant="title">Open ({open.length})</Text>
          {open.length === 0 && <Text muted>No open gigs.</Text>}
          {open.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="title">Drafts ({drafts.length})</Text>
          {drafts.length === 0 && <Text muted>No drafts.</Text>}
          {drafts.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="title">Past & closed ({past.length})</Text>
          {past.length === 0 && <Text muted>Nothing here yet.</Text>}
          {past.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: tokens.space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
            <Text variant="title">Ticketed events</Text>
            {profile.status === "approved" ? (
              <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
                <Button variant="secondary" onPress={() => setView({ kind: "picker" })}>
                  <Text variant="label">Promote a gig</Text>
                </Button>
                <Button onPress={() => setView({ kind: "create", source: { kind: "standalone" } })}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
                    <IconPlus size={16} color={t.onAccent} />
                    <Text variant="label" color={t.onAccent}>New event</Text>
                  </View>
                </Button>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <IconWarningCircle size={14} color={t.muted} />
                <Text variant="meta" muted>Your curator profile must be approved before you can create events.</Text>
              </View>
            )}
          </View>
          {activeEvents.length === 0 && pastEvents.length === 0 ? (
            <Card style={{ alignItems: "center", gap: 4, paddingVertical: tokens.space.lg }}>
              <IconTicket size={22} color={t.muted} />
              <Text variant="label" style={{ textAlign: "center" }}>No ticketed events yet</Text>
              <Text variant="meta" muted style={{ textAlign: "center" }}>
                Create a standalone ticketed event, or promote a gig you&apos;ve already booked.
              </Text>
            </Card>
          ) : (
            <>
              {activeEvents.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text variant="meta" muted>Active ({activeEvents.length})</Text>
                  {activeEvents.map((e) => <EventListItem key={e.id} event={e} onPress={() => openEvent(e.id)} />)}
                </View>
              )}
              {pastEvents.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text variant="meta" muted>Past &amp; cancelled ({pastEvents.length})</Text>
                  {pastEvents.map((e) => <EventListItem key={e.id} event={e} onPress={() => openEvent(e.id)} />)}
                </View>
              )}
            </>
          )}
        </View>

        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 }}>
          <Text variant="title">Series ({series.length})</Text>
          {series.length === 0 && <Text muted>No recurring series yet.</Text>}
          {series.map((s) => (
            <Pressable key={s.id} onPress={() => openSeries(s.id)}>
              <Card style={{ padding: tokens.space.md, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{s.template.title || "Untitled series"}</Text>
                  <StatusBadge label={SERIES_STATUS_LABEL[s.status]} status="neutral" />
                </View>
                <Text variant="meta" muted>
                  {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:{String(s.recurrence.minute).padStart(2, "0")}, {s.recurrence.cadence}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

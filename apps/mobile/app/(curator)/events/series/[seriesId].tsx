import { useEffect, useState } from "react";
import { ScrollView, View, Pressable, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../../src/lib/firebase";
import { callFn } from "../../../../src/lib/callable";
import { useAuth } from "../../../../src/auth/AuthProvider";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields, RecurrenceFields,
  contentFrom, provisionsFrom, budgetFrom, recurrenceFrom, endDateInputToLaunchTzEndMs, MAX_ADDRESS_LENGTH,
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, SERIES_STATUS_TONE, WEEKDAY_LABELS, formatGigDateTime,
  type ContentState, type ProvisionsState, type BudgetState, type RecurrenceState, type LocationValue,
  type UpdateSeriesPayload,
} from "../../../../src/gigs/GigForms";
import {
  validateGigContent, validateBudget, validateRecurrence,
  type ProfileDoc, type CuratorSubtype, type GigDoc, type GigSeriesDoc, type GigContentInput, type GigBudget,
} from "@gatekeep/shared";
import { Text, Button, Card, StatusBadge, PageBackground, Skeleton, SkeletonCard, ErrorBanner } from "../../../../src/ui";
import { useTokens } from "../../../../src/theme/ThemeProvider";
import { tokens } from "../../../../src/theme/tokens";

type OccurrenceRow = GigDoc & { id: string };

// The template editor, keyed by seriesId by the parent, so it seeds its
// local state once from the first snapshot (same "seed once, never reseed"
// contract as GigEditForm / CuratorForms.tsx's forms).
function SeriesTemplateForm({ seriesId, series, isVenue }: { seriesId: string; series: GigSeriesDoc; isVenue: boolean }) {
  const [content, setContent] = useState<ContentState>(contentFrom(series.template));
  const [budget, setBudget] = useState<BudgetState>(budgetFrom(series.template.budget));
  const [provisions, setProvisions] = useState<ProvisionsState>(provisionsFrom(series.template.provisions));
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: series.template.location.addressVisibility });
  const [recurrence, setRecurrence] = useState<RecurrenceState>(recurrenceFrom(series.recurrence, series.fillMode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentLabel = `Currently on file: ${series.templatePrivateLocation.address} ` +
    `(${series.template.location.addressVisibility === "public" ? "shown publicly" : "neighborhood only, publicly"})`;

  const save = async () => {
    setError(null);
    const wants = { genres: content.genres, actSizes: content.actSizes };
    const durationMinutes = Number(content.duration);
    const contentInput: GigContentInput = {
      title: content.title, description: content.description, wants, durationMinutes,
      provisions: { hasPA: provisions.hasPA, hasBackline: provisions.hasBackline, notes: provisions.notes.trim() || null },
    };
    const cv = validateGigContent(contentInput);
    if (!cv.ok) { setError(cv.reason); return; }

    const minDollars = Number(budget.min); const maxDollars = Number(budget.max);
    if (budget.min.trim() === "" || budget.max.trim() === "" || !Number.isFinite(minDollars) || !Number.isFinite(maxDollars)) {
      setError("Enter a minimum and maximum budget.");
      return;
    }
    const budgetInput: GigBudget = { minCents: Math.round(minDollars * 100), maxCents: Math.round(maxDollars * 100), structure: budget.structure };
    const bv = validateBudget(budgetInput);
    if (!bv.ok) { setError(bv.reason); return; }

    const recurrenceInput = {
      weekday: recurrence.weekday, hour: Number(recurrence.hour), minute: Number(recurrence.minute),
      cadence: recurrence.cadence, endDate: endDateInputToLaunchTzEndMs(recurrence.endDate),
    };
    const rv = validateRecurrence(recurrenceInput, Date.now());
    if (!rv.ok) { setError(rv.reason); return; }

    const trimmedAddress = location.address.trim();
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    // Same omit-when-unchanged rule as the gig editor, updateSeries treats
    // an omitted location as "leave the template's location untouched,"
    // which also skips the propagation loop's extra private/location
    // subdoc rewrite on every future occurrence.
    const locationChanged = trimmedAddress.length > 0 || location.visibility !== series.template.location.addressVisibility;

    setBusy(true);
    try {
      const payload: UpdateSeriesPayload = locationChanged
        ? { seriesId, ...contentInput, budget: budgetInput, recurrence: recurrenceInput, fillMode: recurrence.fillMode,
            location: { address: trimmedAddress || null, addressVisibility: location.visibility } }
        : { seriesId, ...contentInput, budget: budgetInput, recurrence: recurrenceInput, fillMode: recurrence.fillMode };
      await callFn("updateSeries", payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text muted>
        Saving applies to future, unedited dates only. Occurrences you&#39;ve edited directly (in the gig editor)
        have detached from this template and won&#39;t change.
      </Text>
      <ContentFields value={content} onChange={setContent} />
      <BudgetFields value={budget} onChange={setBudget} />
      <RecurrenceFields value={recurrence} onChange={setRecurrence} />
      <ProvisionsFields value={provisions} onChange={setProvisions} />
      <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
      {/* P10: mirrors web's identical copy, a visibility change here only
          reaches future, still-attached occurrences. */}
      <Text variant="meta" muted>
        Occurrences you&#39;ve edited individually keep their current address visibility.
      </Text>
      <ErrorBanner message={error} />
      <Button title={busy ? "Saving…" : "Save template"} disabled={busy} onPress={() => void save()} />
    </View>
  );
}

export default function SeriesDetail() {
  const { seriesId: rawSeriesId } = useLocalSearchParams<{ seriesId: string }>();
  const seriesId = rawSeriesId ?? "";
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [series, setSeries] = useState<GigSeriesDoc | null>(null);
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);

  // Render-time reset: navigating from one series' detail screen to
  // another's (same route pattern, different seriesId) does NOT remount this
  // screen, so without this the second series' screen would show the first
  // series' stale doc/occurrences/profile until the new subscriptions
  // resolve.
  const [lastSeriesId, setLastSeriesId] = useState(seriesId);
  if (seriesId !== lastSeriesId) { setLastSeriesId(seriesId); setSeries(null); setOccurrences([]); setProfile(null); }

  useEffect(() => {
    if (!seriesId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "gigSeries", seriesId),
      (s) => setSeries(s.exists() ? (s.data() as GigSeriesDoc) : null),
      () => setSeries(null));
  }, [seriesId]);
  // Keyed off the series' OWN curatorProfileId, not whichever profile
  // happens to be "active" in the global ContextSwitcher, which is
  // independent and can change while this screen (reached by a Stack push)
  // stays mounted in the background on the "events" tab. Keying the PROFILE
  // lookup off activeContext instead would let this screen briefly show a
  // DIFFERENT curator's subtype (wrong isVenue) after such a switch, a
  // correctness issue, not just a staleness race. This query is also what
  // makes the occurrences list below rules-provable at all (gigs' read rule
  // has no seriesId-based disjunct, only status=='open' or
  // isMember(curatorProfileId)); where(curatorProfileId)+where(seriesId) is
  // two plain equality filters, no composite index needed. Sorted
  // client-side by startsAt. Mirrors web's identical query exactly.
  const curatorProfileId = series?.curatorProfileId ?? null;
  useEffect(() => {
    if (!curatorProfileId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", curatorProfileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [curatorProfileId]);
  useEffect(() => {
    if (!curatorProfileId) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", curatorProfileId), where("seriesId", "==", seriesId)),
      (s) => setOccurrences(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) })).sort((a, b) => a.startsAt - b.startsAt)));
  }, [curatorProfileId, seriesId]);

  if (!user || !series || !profile) {
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

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const cadenceSummary =
    `${WEEKDAY_LABELS[series.recurrence.weekday]}s, ` +
    `${String(series.recurrence.hour).padStart(2, "0")}:${String(series.recurrence.minute).padStart(2, "0")} (UTC), ${series.recurrence.cadence}`;

  const doPause = async () => {
    setPauseBusy(true);
    try {
      await callFn("pauseSeries", { seriesId });
    } catch (e) {
      Alert.alert("Could not pause this series", e instanceof Error ? e.message : "Try again.");
    } finally {
      setPauseBusy(false);
    }
  };
  const pause = () => {
    Alert.alert("Pause this series?", "No new dates will be created going forward, already-open dates stay open. This can't be undone.",
      [{ text: "Keep active", style: "cancel" }, { text: "Pause", style: "destructive", onPress: () => void doPause() }]);
  };
  const doEnd = async () => {
    setEndBusy(true);
    try {
      await callFn("endSeries", { seriesId });
    } catch (e) {
      Alert.alert("Could not end this series", e instanceof Error ? e.message : "Try again.");
    } finally {
      setEndBusy(false);
    }
  };
  const end = () => {
    Alert.alert("End this series?", "Future open or draft dates will be cancelled and no new dates will be created. This can't be undone.",
      [{ text: "Keep series", style: "cancel" }, { text: "End series", style: "destructive", onPress: () => void doEnd() }]);
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }} keyboardShouldPersistTaps="handled">
        <Text variant="heading">{series.template.title || "Untitled series"}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text variant="label" muted>Status</Text>
          <StatusBadge label={SERIES_STATUS_LABEL[series.status]} status={SERIES_STATUS_TONE[series.status]} />
        </View>
        <Text muted>{cadenceSummary}</Text>
        {series.status === "ended"
          ? <Text muted>This series has ended and can no longer be edited.</Text>
          : <SeriesTemplateForm key={seriesId} seriesId={seriesId} series={series} isVenue={isVenue} />}
        <View style={{ flexDirection: "row", gap: 8, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 }}>
          {series.status === "active" && (
            <Button title={pauseBusy ? "Pausing…" : "Pause series"} variant="secondary" disabled={pauseBusy} onPress={pause} />
          )}
          {series.status !== "ended" && (
            <Button title={endBusy ? "Ending…" : "End series"} variant="destructive" disabled={endBusy} onPress={end} />
          )}
        </View>
        <View style={{ gap: 8 }}>
          <Text variant="title">Occurrences</Text>
          {occurrences.length === 0 && (
            <Text muted>No dates yet. The daily sweep materializes upcoming occurrences from this template automatically.</Text>
          )}
          {occurrences.map((occ) => (
            <Pressable key={occ.id} onPress={() => router.push({ pathname: "/(curator)/events/[gigId]", params: { gigId: occ.id } })}>
              <Card style={{ padding: tokens.space.md, gap: 4 }}>
                <Text variant="label">{formatGigDateTime(occ.startsAt)}</Text>
                <Text variant="meta" muted>
                  {GIG_STATUS_LABEL[occ.status]}{occ.detachedFromTemplate && " · detached"}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

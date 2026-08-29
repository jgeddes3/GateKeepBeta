import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields, RecurrenceFields, OneOffDateTimeFields,
  emptyContent, emptyBudget, emptyProvisions, emptyRecurrence, emptyOneOffDateTime, oneOffDateTimeToMs, endDateInputToUtcMs,
  MAX_ADDRESS_LENGTH,
  type LocationValue, type CreateGigPayload, type CreateSeriesPayload,
} from "../../../src/gigs/GigForms";
import {
  validateGigContent, validateBudget, validateRecurrence,
  type ProfileDoc, type CuratorSubtype, type GigContentInput, type GigBudget, type AddressVisibility,
} from "@gatekeep/shared";
import { Text, Button, Chip, PageBackground, Skeleton, SkeletonCard, ErrorBanner } from "../../../src/ui";
import { tokens } from "../../../src/theme/tokens";

// The composer's one-off/series fork mirrors web's gigs/new/page.tsx exactly
// (and /join's musician/curator toggle before it), a single screen, since
// the shared fields (content/budget/provisions/location) are identical and
// only the "when" section differs.
export default function NewGigOrSeries() {
  const { user } = useAuth();
  const router = useRouter();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [isSeries, setIsSeries] = useState(false);
  const [content, setContent] = useState(emptyContent());
  const [budget, setBudget] = useState(emptyBudget());
  const [provisions, setProvisions] = useState(emptyProvisions());
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: "public" });
  const [visibilityTouched, setVisibilityTouched] = useState(false);
  const [oneOffDateTime, setOneOffDateTime] = useState(emptyOneOffDateTime());
  const [recurrence, setRecurrence] = useState(emptyRecurrence());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same render-time-reset + late-callback guard as (curator)/dashboard.tsx
  // and events/index.tsx: this composer screen can stay mounted in the
  // background across a profile-context switch (the outer Tabs navigator
  // keeps the "events" tab's nested Stack, wherever it's currently
  // positioned, mounted when another tab is active), so without this the
  // form's `profile` (isVenue/approval-status/venue-address label) could go
  // stale relative to `profileId` (read fresh from activeContext every
  // render, and what the submit payload actually uses) after switching back.
  // Deliberately only resets `profile`, not the typed-in form fields, this
  // is external truth read from Firestore, not user-entered content.
  const activeIdRef = useRef(profileId);
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null);
  }

  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => { if (activeIdRef.current !== forId) return; setProfile(s.exists() ? (s.data() as ProfileDoc) : null); },
      () => { if (activeIdRef.current !== forId) return; setProfile(null); });
  }, [profileId]);

  if (!user || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">No curator profile</Text>
          <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to post a gig.</Text>
        </View>
      </View>
    );
  }
  if (!profile) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={28} width="60%" />
          <SkeletonCard />
        </View>
      </View>
    );
  }
  if (profile.status !== "approved") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, padding: tokens.space.lg }}>
          <Text muted>Your curator profile must be approved before you can post gigs.</Text>
        </View>
      </View>
    );
  }

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  // Same defaulting rule resolveGigLocation applies server-side
  // (isVenue ? "public" : "neighborhood"), computed at render time from the
  // subtype rather than seeded into state on mount. `visibilityTouched`
  // tracks whether the curator has actually picked a value yet.
  const defaultVisibility: AddressVisibility = isVenue ? "public" : "neighborhood";
  const effectiveLocation: LocationValue = visibilityTouched ? location : { ...location, visibility: defaultVisibility };
  const curatorAddress = profile.curator?.location?.address ?? null;
  const currentLabel = isVenue
    ? (curatorAddress ? `Your venue's address on file: ${curatorAddress}` : "No venue address on file yet.")
    : "Enter the address for this specific gig.";

  const submit = async () => {
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

    const trimmedAddress = effectiveLocation.address.trim();
    if (!isVenue && trimmedAddress.length === 0) { setError("An address is required for this gig."); return; }
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    const locationInput = { address: trimmedAddress || null, addressVisibility: effectiveLocation.visibility };

    setBusy(true);
    try {
      if (isSeries) {
        const recurrenceInput = {
          weekday: recurrence.weekday, hour: Number(recurrence.hour), minute: Number(recurrence.minute),
          cadence: recurrence.cadence, endDate: endDateInputToUtcMs(recurrence.endDate),
        };
        const rv = validateRecurrence(recurrenceInput, Date.now());
        if (!rv.ok) { setError(rv.reason); setBusy(false); return; }
        const payload: CreateSeriesPayload = {
          profileId, ...contentInput, budget: budgetInput,
          recurrence: recurrenceInput, fillMode: recurrence.fillMode, location: locationInput,
        };
        const { data } = await httpsCallable<CreateSeriesPayload, { seriesId: string }>(
          getFirebase().functions, "createSeries")(payload);
        router.replace({ pathname: "/(curator)/events/series/[seriesId]", params: { seriesId: data.seriesId } });
      } else {
        const startsAt = oneOffDateTimeToMs(oneOffDateTime);
        if (startsAt === null || startsAt <= 0) { setError("Pick a date and time."); setBusy(false); return; }
        const payload: CreateGigPayload = { profileId, ...contentInput, budget: budgetInput, startsAt, location: locationInput };
        const { data } = await httpsCallable<CreateGigPayload, { gigId: string }>(
          getFirebase().functions, "createGig")(payload);
        router.replace({ pathname: "/(curator)/events/[gigId]", params: { gigId: data.gigId } });
      }
    } catch (e) {
      // Surfaces server errors verbatim, including the geocode failure
      // message and (for series) the resource-exhausted active-series cap,
      // createGig itself has no cap check (that's publishGig's job, on the
      // gig editor screen), so a one-off's cap error can't appear here.
      setError(e instanceof Error ? e.message : "Could not create this.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", gap: 8 }}>
          {([false, true] as const).map((s) => (
            <Chip key={String(s)} label={s ? "Recurring series" : "One-off gig"} active={isSeries === s} onPress={() => setIsSeries(s)} />
          ))}
        </View>
        <ContentFields value={content} onChange={setContent} />
        <BudgetFields value={budget} onChange={setBudget} />
        <ProvisionsFields value={provisions} onChange={setProvisions} />
        {isSeries ? (
          <RecurrenceFields value={recurrence} onChange={setRecurrence} />
        ) : (
          <OneOffDateTimeFields value={oneOffDateTime} onChange={setOneOffDateTime} />
        )}
        <LocationFields isVenue={isVenue} addressRequired={!isVenue} currentLabel={currentLabel}
          value={effectiveLocation}
          onChange={(v) => { setVisibilityTouched(true); setLocation(v); }} />
        <ErrorBanner message={error} />
        <Button title={busy ? "Creating…" : isSeries ? "Create series" : "Create gig (draft)"} disabled={busy} onPress={() => void submit()} />
      </ScrollView>
    </View>
  );
}

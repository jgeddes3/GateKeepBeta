import { useEffect, useState } from "react";
import { ScrollView, View, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { callFn } from "../../../src/lib/callable";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useCounterparty } from "../../../src/bookings/BookingInbox";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields, OneOffDateTimeFields,
  contentFrom, provisionsFrom, budgetFrom, oneOffDateTimeFrom, oneOffDateTimeToMs, MAX_ADDRESS_LENGTH,
  GIG_STATUS_LABEL, GIG_STATUS_TONE,
  type ContentState, type ProvisionsState, type BudgetState, type LocationValue, type UpdateGigPayload,
} from "../../../src/gigs/GigForms";
import {
  validateGigContent, validateBudget,
  type ProfileDoc, type CuratorSubtype, type GigDoc, type GigPrivateLocation, type GigContentInput, type GigBudget,
} from "@gatekeep/shared";
import { Text, Button, Card, StatusBadge, PageBackground, Skeleton, SkeletonCard, ErrorBanner } from "../../../src/ui";
import { useTokens } from "../../../src/theme/ThemeProvider";
import { tokens } from "../../../src/theme/tokens";

// The actual content editor, keyed by gigId (not gig.updatedAt) by the
// parent below, so it seeds its local state ONCE from the first snapshot and
// never again: neither a live update from elsewhere (e.g. runDailySweep
// closing this gig) nor this form's own save (which echoes right back
// through the parent's onSnapshot) should wipe in-progress edits. Same
// contract as CuratorForms.tsx's forms / web's GigEditForm.
function GigEditForm({ gigId, gig, isVenue, currentLabel }: {
  gigId: string; gig: GigDoc; isVenue: boolean; currentLabel: string;
}) {
  const [content, setContent] = useState<ContentState>(contentFrom(gig));
  const [budget, setBudget] = useState<BudgetState>(budgetFrom(gig.budget));
  const [provisions, setProvisions] = useState<ProvisionsState>(provisionsFrom(gig.provisions));
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: gig.location.addressVisibility });
  const [dateTime, setDateTime] = useState(oneOffDateTimeFrom(gig.startsAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const startsAt = oneOffDateTimeToMs(dateTime);
    if (startsAt === null || startsAt <= 0) { setError("Pick a valid date and time."); return; }

    const trimmedAddress = location.address.trim();
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    // Omit `location` entirely (rather than resending an unchanged one) when
    // the curator neither typed a new address nor picked a different
    // visibility, updateGig treats an omitted location as "leave it
    // untouched," skipping a redundant re-geocode + private-doc rewrite.
    const locationChanged = trimmedAddress.length > 0 || location.visibility !== gig.location.addressVisibility;

    setBusy(true);
    try {
      const payload: UpdateGigPayload = locationChanged
        ? { gigId, ...contentInput, budget: budgetInput, startsAt,
            location: { address: trimmedAddress || null, addressVisibility: location.visibility } }
        : { gigId, ...contentInput, budget: budgetInput, startsAt };
      await callFn("updateGig", payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <ContentFields value={content} onChange={setContent} />
      <BudgetFields value={budget} onChange={setBudget} />
      <OneOffDateTimeFields value={dateTime} onChange={setDateTime} />
      <ProvisionsFields value={provisions} onChange={setProvisions} />
      <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
      <ErrorBanner message={error} />
      <Button title={busy ? "Saving…" : "Save changes"} disabled={busy} onPress={() => void save()} />
    </View>
  );
}

function BookedActCard({ bookingId, musicianProfileId }: { bookingId: string; musicianProfileId: string | null }) {
  const router = useRouter();
  const act = useCounterparty(musicianProfileId ?? undefined);
  return (
    <Card style={{ gap: 8 }}>
      <Text variant="label">Booked act</Text>
      {act === "loading" ? <Skeleton height={16} width="50%" />
        : act ? (
          <Text
            style={act.handle ? { textDecorationLine: "underline" } : undefined}
            onPress={act.handle ? () => router.push({ pathname: "/artist/[handle]", params: { handle: act.handle! } }) : undefined}
          >
            {act.name}
          </Text>
        ) : <Text muted>Profile no longer available.</Text>}
      <Button title="Open the booking →" variant="secondary"
        onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId } })} />
    </Card>
  );
}

// Both a standalone one-off gig's editor AND the destination "occurrence
// edit routes to the gig editor" sends a series occurrence to, updateGig
// treats both identically (same callable, same detachment side effect for
// anything with a seriesId), so one screen correctly serves both.
export default function GigEditor() {
  const { gigId: rawGigId } = useLocalSearchParams<{ gigId: string }>();
  const gigId = rawGigId ?? "";
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [gig, setGig] = useState<GigDoc | null>(null);
  const [privateLoc, setPrivateLoc] = useState<GigPrivateLocation | null | "loading">("loading");
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  // Render-time reset for the private/location one-shot getDoc (and gig
  // itself): navigating from one gig's editor to another's (same route
  // pattern, different gigId) does NOT remount this screen, so without this
  // the second gig's screen would show the first gig's stale exact address
  // (and stale gig doc) until the new subscriptions resolve. Mirrors web's
  // identical privLocGigId trick.
  const [privLocGigId, setPrivLocGigId] = useState(gigId);
  if (gigId !== privLocGigId) { setPrivLocGigId(gigId); setPrivateLoc("loading"); setGig(null); setProfile(null); }

  useEffect(() => {
    if (!gigId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "gigs", gigId),
      (s) => setGig(s.exists() ? (s.data() as GigDoc) : null),
      () => setGig(null));
  }, [gigId]);
  // The gig's OWN curatorProfileId, not whichever profile happens to be
  // "active" in the global ContextSwitcher, those are independent, and a
  // curator can switch their active profile while this screen (reached by a
  // Stack push) stays mounted in the background on the "events" tab. Keying
  // off activeContext instead would let this screen briefly show a DIFFERENT
  // curator's subtype/venue-address (wrong isVenue, wrong "currently on
  // file" fallback) after such a switch, this is a correctness issue, not
  // just a staleness race, so there's no safe way to derive it from
  // anywhere but the gig doc itself. Only transitions when gigId itself
  // changes (already handled by the render-time reset above), so no extra
  // late-callback guard is needed here.
  const curatorProfileId = gig?.curatorProfileId ?? null;
  useEffect(() => {
    if (!curatorProfileId) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", curatorProfileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [curatorProfileId]);
  useEffect(() => {
    if (!gigId) return;
    const { db } = getFirebase();
    // `cancelled` guards a stale WRITE the same way (curator)/dashboard.tsx's
    // effects do: navigating gig A's editor to gig B's can let A's getDoc
    // resolve after B's effect has already started.
    let cancelled = false;
    void getDoc(doc(db, `gigs/${gigId}/private/location`))
      .then((s) => { if (!cancelled) setPrivateLoc(s.exists() ? (s.data() as GigPrivateLocation) : null); })
      .catch(() => { if (!cancelled) setPrivateLoc(null); });
    return () => { cancelled = true; };
  }, [gigId]);

  if (!user || !gig || !profile || privateLoc === "loading") {
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
  const currentLabel = privateLoc
    ? `Currently on file: ${privateLoc.address} (${gig.location.addressVisibility === "public" ? "shown publicly" : "neighborhood only, publicly"})`
    : "No exact address on file.";
  // Mirrors updateGig's own gate exactly, cancelled/taken_down gigs reject
  // the callable outright, so the edit form is hidden rather than left live
  // and doomed to a failed-precondition on save. "closed" (auto-closed past
  // gigs) is deliberately still editable, matching the server.
  const editable = gig.status !== "cancelled" && gig.status !== "taken_down";

  const publish = async () => {
    setPublishBusy(true); setPublishError(null);
    try {
      await callFn("publishGig", { gigId });
    } catch (e) {
      // The MAX_OPEN_GIGS_PER_PROFILE cap error (resource-exhausted) lands
      // here verbatim, this is the one place that error can ever surface.
      setPublishError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setPublishBusy(false);
    }
  };
  const doCancel = async () => {
    setCancelBusy(true);
    try {
      await callFn("cancelGig", { gigId });
    } catch (e) {
      Alert.alert("Could not cancel this gig", e instanceof Error ? e.message : "Try again.");
    } finally {
      setCancelBusy(false);
    }
  };
  const cancel = () => {
    Alert.alert(`Cancel "${gig.title}"?`, "Musicians will no longer see or apply to it. This can't be undone.",
      [{ text: "Keep gig", style: "cancel" }, { text: "Cancel gig", style: "destructive", onPress: () => void doCancel() }]);
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg }} keyboardShouldPersistTaps="handled">
        <Text variant="heading">{gig.title || "Untitled gig"}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text variant="label" muted>Status</Text>
          <StatusBadge label={GIG_STATUS_LABEL[gig.status]} status={GIG_STATUS_TONE[gig.status]} />
        </View>
        {gig.seriesId && (
          <Card style={{ gap: 8 }}>
            <Text muted={gig.detachedFromTemplate} color={gig.detachedFromTemplate ? undefined : t.warning}>
              {gig.detachedFromTemplate
                ? "This date was edited directly and no longer follows its series' template."
                : "Part of a recurring series. Saving any change here will detach this date from the series; future template edits won't apply to it anymore."}
            </Text>
            <Button title="View series →" variant="secondary"
              onPress={() => router.push({ pathname: "/(curator)/events/series/[seriesId]", params: { seriesId: gig.seriesId! } })} />
          </Card>
        )}
        {gig.bookingId && <BookedActCard bookingId={gig.bookingId} musicianProfileId={gig.bookedMusicianProfileId} />}
        {!editable && <Text muted>This gig is {GIG_STATUS_LABEL[gig.status].toLowerCase()} and can no longer be edited.</Text>}
        {editable && <GigEditForm key={gigId} gigId={gigId} gig={gig} isVenue={isVenue} currentLabel={currentLabel} />}
        {gig.status === "draft" && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 }}>
            <Button title={publishBusy ? "Publishing…" : "Publish"} disabled={publishBusy} onPress={() => void publish()} />
            <ErrorBanner message={publishError} />
          </View>
        )}
        {(gig.status === "draft" || gig.status === "open") && (
          <Button title={cancelBusy ? "Cancelling…" : "Cancel this gig"} variant="destructive"
            disabled={cancelBusy} onPress={cancel} style={{ alignSelf: "flex-start" }} />
        )}
      </ScrollView>
    </View>
  );
}

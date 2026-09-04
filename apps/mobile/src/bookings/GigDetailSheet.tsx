import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { type GigDoc } from "@gatekeep/shared";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import {
  DEPOSIT_HONESTY_LINE, DEPOSIT_HONESTY_RUN_LINE, OfferFields, buildOfferPayload, emptyOffer, errorCode,
  formatDuration, gigLocationLabel, type OfferState,
} from "./BookingForms";
import { useProfileContext } from "../shell/ProfileContext";
import { GatePrompt } from "../payments/GatePrompt";
import { Text, Button, Chip, StatusBadge, ErrorBanner, Sheet, Skeleton, IconX } from "../ui";
import { useTokens } from "../theme/ThemeProvider";

// SP8 Task 15: pulled out of the placeholder musician "Find gigs" screen
// (deleted this task), where ApplyPanel and the gig detail body lived inline behind a hand-rolled
// Modal. Both move here verbatim (same applyToGig call, same GatePrompt
// handling, same copy); only the outer chrome changes, the hand-rolled
// Modal is replaced by the shared Sheet primitive so MusicianFace's two
// segments (and Task 17's deep link) can open one gig's detail from
// anywhere without owning their own Modal markup.

type Gig = GigDoc & { id: string };

function ApplyPanel({ gig, gigId }: { gig: Gig; gigId: string }) {
  const { myProfiles } = useProfileContext();
  const t = useTokens();
  const musicianProfiles = useMemo(
    () => myProfiles.filter((p) => p.type === "musician" && p.status === "approved"),
    [myProfiles],
  );
  const [selectedOverride, setSelectedOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyApplied, setAlreadyApplied] = useState(false);
  const [applied, setApplied] = useState(false);

  // Derived, not effect-reset: the default selection is a pure function of
  // the fetched list + whatever's been explicitly picked.
  const selected = selectedOverride && musicianProfiles.some((m) => m.profileId === selectedOverride)
    ? selectedOverride
    : (musicianProfiles.length > 0 ? musicianProfiles[0].profileId : "");

  if (musicianProfiles.length === 0) {
    return (
      <Text muted>
        You need an approved musician profile to apply. Switch to one, or join as a musician from the account tab.
      </Text>
    );
  }

  const submit = async () => {
    setError(null);
    const { payload, error: buildError } = buildOfferPayload(gig.budget.structure, offer);
    if (buildError || !payload) { setError(buildError ?? "Invalid offer."); return; }
    setBusy(true);
    try {
      await callFn<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>("applyToGig", { gigId, musicianProfileId: selected, offer: payload });
      setApplied(true);
    } catch (e) {
      if (errorCode(e) === "functions/already-exists") setAlreadyApplied(true);
      else setError(e instanceof Error ? e.message : "Could not submit your application.");
    } finally {
      setBusy(false);
    }
  };

  if (applied) return <Text color={t.success}>Application sent! The curator has been notified.</Text>;
  if (alreadyApplied) return <Text muted>There&apos;s already an open booking between this act and this gig.</Text>;

  return (
    <View style={{ gap: 10 }}>
      <Text variant="label">Applying as</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {musicianProfiles.map((m) => (
          <Chip key={m.profileId} label={m.name} active={selected === m.profileId} onPress={() => setSelectedOverride(m.profileId)} />
        ))}
      </View>
      <OfferFields structure={gig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />
      {error && <GatePrompt message={error} viewerIsMusician onRetry={() => void submit()} />}
      <Button title={busy ? "Applying…" : "Apply"} disabled={busy} onPress={() => void submit()} />
      <Text variant="meta" muted>{gig.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</Text>
    </View>
  );
}

// gigId non-null opens the sheet (visible={gigId !== null}); the gig itself
// is fetched fresh on every open (getDoc(doc(db, "gigs", gigId)), public
// rules allow an open gig read) rather than trusting a caller-supplied doc,
// so a stale search result never shows stale budget/status. A load failure
// (deleted gig, offline) surfaces as an ErrorBanner inside the sheet rather
// than a blank one.
export function GigDetailSheet({ gigId, onClose }: { gigId: string | null; onClose: () => void }) {
  const t = useTokens();
  const [gig, setGig] = useState<Gig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Render-time reset (the same idiom useSearch.ts's own trackedKey uses,
  // and GenrePickerSheet's trackedUid before it): every time gigId itself
  // changes, drop the previous gig/error and flip to loading synchronously,
  // during render, not inside the effect body below (react-hooks/
  // set-state-in-effect flags a setState called unconditionally at the top
  // of an effect; this is the sanctioned alternative for "reset derived
  // state when a prop changes").
  const [trackedGigId, setTrackedGigId] = useState(gigId);
  if (gigId !== trackedGigId) {
    setTrackedGigId(gigId);
    setGig(null);
    setError(null);
    setLoading(gigId !== null);
  }

  useEffect(() => {
    if (!gigId) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, "gigs", gigId))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) setGig({ id: snap.id, ...(snap.data() as GigDoc) });
        else setError("This gig is no longer available.");
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load this gig.");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [gigId]);

  return (
    <Sheet visible={gigId !== null} onClose={onClose}>
      {/* Sheet takes no stance on keyboard avoidance (its own header
          comment), and the Apply flow's amount/note fields need one so the
          keyboard doesn't cover them on device, same pattern ShowPosts.tsx
          already established for its own Sheet-hosted form. */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <ScrollView style={{ maxHeight: "85%" }} contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
            <IconX size={18} color={t.muted} />
            <Text muted>Close</Text>
          </Pressable>
          {loading && (
            <View style={{ gap: 8 }}>
              <Skeleton height={20} width="60%" />
              <Skeleton height={14} width="40%" />
            </View>
          )}
          {error && <ErrorBanner message={error} />}
          {gig && (
            <>
              <Text variant="heading">{gig.title || "Untitled gig"}</Text>
              <Text muted>{formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}</Text>
              <Text>{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}</Text>
              {!!gig.description && <Text>{gig.description}</Text>}
              {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
                <Text muted>
                  Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
                </Text>
              )}
              <Text muted>{gigLocationLabel(gig.location)}</Text>
              {gig.seriesId != null && (
                <StatusBadge label={gig.fillMode === "whole_run" ? "Books as a run" : "Part of a recurring series"} status="neutral" />
              )}
              {gig.fillMode === "whole_run" && (
                <Text muted>Applying here applies to every open date of this run, plus dates added later, under one booking.</Text>
              )}
              <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: 12, gap: 8 }}>
                <Text variant="title">Apply for this gig</Text>
                <ApplyPanel key={gig.id} gig={gig} gigId={gig.id} />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

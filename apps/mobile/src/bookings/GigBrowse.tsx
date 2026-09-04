import { useEffect, useMemo, useState } from "react";
import { View, Pressable, Modal, ScrollView } from "react-native";
import { collection, getDocs, orderBy, query, where, type QueryConstraint } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { GENRES, type GigDoc, type BudgetStructure } from "@gatekeep/shared";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import {
  DEPOSIT_HONESTY_LINE, DEPOSIT_HONESTY_RUN_LINE, OfferFields, buildOfferPayload, emptyOffer, errorCode,
  formatDuration, gigLocationLabel, launchTzDayStartMs, launchTzNextDayStartMs, type OfferState,
} from "./BookingForms";
import { useProfileContext } from "../shell/ProfileContext";
import { GatePrompt } from "../payments/GatePrompt";
import {
  Text, Button, Card, Chip, Input, StatusBadge, PageBackground, PhotoScrim, PhotoPlaceholder,
  SkeletonCard, ErrorBanner, IconMusicNotes, IconX,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN port of ../../../web/src/bookings/GigBrowse.tsx (+ the gig detail
// page's ApplyPanel, app/gigs/[gigId]/page.tsx), SP4 Task 12. Mounted as
// the musician "Find gigs" tab (apps/mobile/app/(musician)/gigs.tsx).
//
// Deviations from web, all task-sanctioned:
// - Filters are chip-toggles for genre/structure + a simple YYYY-MM-DD
//   from/to text entry (SP3 ruling 14 precedent), no city filter (not
//   listed in Task 12's brief, unlike web's).
// - Gig detail is a Modal on this same screen (mobile-appropriate) instead
//   of a separate route, includes the Apply flow inline.
// - Series badge reads gig.fillMode straight off the public gig doc (Task 22
//   stamps it on every occurrence), same as web's grid; no gigSeries fetch
//   on this screen either.
// - The Apply panel's musician-profile picker reuses ProfileContext's
//   `myProfiles` (already the same collectionGroup(members)-derived list
//   web's ApplyPanel builds with its own query) rather than re-querying.

type GigRow = GigDoc & { id: string };

function ApplyPanel({ gig, gigId }: { gig: GigRow; gigId: string }) {
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

function GigDetailModal({ gig, onClose }: { gig: GigRow | null; onClose: () => void }) {
  const t = useTokens();
  return (
    <Modal visible={gig != null} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ maxHeight: "85%", backgroundColor: t.surface, borderTopLeftRadius: tokens.radius.card, borderTopRightRadius: tokens.radius.card, borderColor: t.border, borderWidth: 1 }}>
          <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: 10 }} keyboardShouldPersistTaps="handled">
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
              <IconX size={18} color={t.muted} />
              <Text muted>Close</Text>
            </Pressable>
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
        </View>
      </View>
    </Modal>
  );
}

// Photo-forward card (9A parity): a fixed-height cover showing the branded
// PhotoPlaceholder (no real photo is wired through here, and none may be
// added without a new Storage read, exactly as on web's browse grid) under
// the standard dark scrim, with the title in Syne and the price in the ember
// treatment sitting on the scrim; the meta (date, looking-for, location,
// series) sits in the card body below.
function GigCard({ gig, onPress }: { gig: GigRow; onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable onPress={onPress}>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <View style={{ height: 144 }}>
          <PhotoPlaceholder icon={<IconMusicNotes size={28} color={t.muted} />} />
          <PhotoScrim />
          <View style={{ position: "absolute", left: 12, right: 12, bottom: 10, flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <Text variant="title" color={tokens.dark.text} numberOfLines={1} style={{ flex: 1 }}>
              {gig.title || "Untitled gig"}
            </Text>
            <View style={{ backgroundColor: t.accent, borderRadius: tokens.radius.pill, paddingVertical: 4, paddingHorizontal: 10 }}>
              <Text variant="label" color={t.onAccent}>
                {formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
              </Text>
            </View>
          </View>
        </View>
        <View style={{ padding: tokens.space.lg, gap: 6 }}>
          <Text variant="meta" muted>{formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}</Text>
          {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
            <Text variant="meta" muted>
              Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
            </Text>
          )}
          <Text variant="meta" muted>{gigLocationLabel(gig.location)}</Text>
          {gig.seriesId != null && (
            <StatusBadge label={gig.fillMode === "whole_run" ? "Books as a run" : "Part of a recurring series"} status="neutral" />
          )}
        </View>
      </Card>
    </Pressable>
  );
}

// status=="open" ordered startsAt is the one query shape firestore.rules
// can prove without a membership/admin disjunct, mirrors web's identical
// query. Genre/structure are pure client-side filters over that result; the
// date range is mapped onto the query itself as a range on the
// already-indexed startsAt field (gigs(status,startsAt), no new index
// needed).
export function GigBrowse() {
  const [gigs, setGigs] = useState<GigRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [structure, setStructure] = useState<BudgetStructure | "any">("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedGigId, setSelectedGigId] = useState<string | null>(null);

  // SP4 (Task 13 item 9): the effect below depends on the PARSED boundaries,
  // not the raw fromDate/toDate strings, those change on every keystroke
  // (onChangeText fires per character), but launchTzDayStartMs/
  // launchTzNextDayStartMs return null for every incomplete/invalid
  // intermediate value (see their own "round-trip-validated" contracts in
  // BookingForms.tsx) and only produce a genuinely NEW numeric boundary once
  // a full valid "YYYY-MM-DD" lands. Memoizing them means the query effect's
  // dependency array only changes (and re-fetches) when the actual bound
  // does, typing "2026-08-25" one character at a time no longer re-queries
  // on every one of those keystrokes.
  const fromMs = useMemo(() => launchTzDayStartMs(fromDate), [fromDate]);
  const toMs = useMemo(() => launchTzNextDayStartMs(toDate), [toDate]);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const constraints: QueryConstraint[] = [where("status", "==", "open")];
    if (fromMs != null) constraints.push(where("startsAt", ">=", fromMs));
    if (toMs != null) constraints.push(where("startsAt", "<", toMs));
    constraints.push(orderBy("startsAt"));
    getDocs(query(collection(db, "gigs"), ...constraints))
      .then((snap) => {
        if (cancelled) return;
        setGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setGigs([]);
        setError(e instanceof Error ? e.message : "Could not load gigs.");
      });
    return () => { cancelled = true; };
  }, [fromMs, toMs]);

  const filtered = useMemo(() => {
    if (gigs === "loading") return [];
    return gigs.filter((g) => (genre === null || g.wants.genres.includes(genre)) && (structure === "any" || g.budget.structure === structure));
  }, [gigs, genre, structure]);

  const selectedGig = selectedGigId && gigs !== "loading" ? (gigs.find((g) => g.id === selectedGigId) ?? null) : null;

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg }} keyboardShouldPersistTaps="handled">
        <Text variant="heading">Find gigs</Text>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip label="All genres" active={genre === null} onPress={() => setGenre(null)} />
            {GENRES.map((g) => <Chip key={g} label={g} active={genre === g} onPress={() => setGenre(genre === g ? null : g)} />)}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip label="Any structure" active={structure === "any"} onPress={() => setStructure("any")} />
            {(["perHour", "perSong", "perSet"] as const).map((s) => (
              <Chip key={s} label={BUDGET_STRUCTURE_LABEL[s]} active={structure === s} onPress={() => setStructure(s)} />
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ gap: 4 }}>
              <Text variant="meta">From (YYYY-MM-DD)</Text>
              <Input value={fromDate} onChangeText={(t) => setFromDate(t.replace(/[^0-9-]/g, ""))}
                placeholder="YYYY-MM-DD" maxLength={10} style={{ width: 130 }} />
            </View>
            <View style={{ gap: 4 }}>
              <Text variant="meta">To (YYYY-MM-DD)</Text>
              <Input value={toDate} onChangeText={(t) => setToDate(t.replace(/[^0-9-]/g, ""))}
                placeholder="YYYY-MM-DD" maxLength={10} style={{ width: 130 }} />
            </View>
          </View>
        </View>
        {error && <ErrorBanner message={`Could not load gigs: ${error}`} />}
        {gigs === "loading" && (
          <View style={{ gap: 10 }}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}
        {gigs !== "loading" && filtered.length === 0 && !error && (
          <Card style={{ alignItems: "center", gap: 6 }}>
            <Text variant="title">No matching gigs</Text>
            <Text muted style={{ textAlign: "center" }}>No open gigs match these filters.</Text>
          </Card>
        )}
        <View style={{ gap: 10 }}>
          {filtered.map((g) => <GigCard key={g.id} gig={g} onPress={() => setSelectedGigId(g.id)} />)}
        </View>
        <GigDetailModal gig={selectedGig} onClose={() => setSelectedGigId(null)} />
      </ScrollView>
    </View>
  );
}

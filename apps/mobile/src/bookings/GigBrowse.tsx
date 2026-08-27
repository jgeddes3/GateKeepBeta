import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, Modal, ScrollView } from "react-native";
import { collection, getDocs, orderBy, query, where, type QueryConstraint } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { GENRES, type GigDoc, type BudgetStructure } from "@gatekeep/shared";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL, Chip, Badge } from "../gigs/GigForms";
import {
  DEPOSIT_HONESTY_LINE, ErrorBox, OfferFields, buildOfferPayload, emptyOffer, errorCode,
  formatDuration, gigLocationLabel, launchTzDayStartMs, launchTzNextDayStartMs, type OfferState,
} from "./BookingForms";
import { useProfileContext } from "../shell/ProfileContext";

// RN port of ../../../web/src/bookings/GigBrowse.tsx (+ the gig detail
// page's ApplyPanel, app/gigs/[gigId]/page.tsx) — SP4 Task 12. Mounted as
// the musician "Find gigs" tab (apps/mobile/app/(musician)/gigs.tsx).
//
// Deviations from web, all task-sanctioned:
// - Filters are chip-toggles for genre/structure + a simple YYYY-MM-DD
//   from/to text entry (SP3 ruling 14 precedent) — no city filter (not
//   listed in Task 12's brief, unlike web's).
// - Gig detail is a Modal on this same screen (mobile-appropriate) instead
//   of a separate route — includes the Apply flow inline.
// - Series badge is ALWAYS the softer "Part of a recurring series" copy
//   derived from seriesId != null alone — no gigSeries fetch anywhere on
//   this screen (mobile explicitly skips the fillMode reveal web's separate
//   gig-detail page attempts for members).
// - The Apply panel's musician-profile picker reuses ProfileContext's
//   `myProfiles` (already the same collectionGroup(members)-derived list
//   web's ApplyPanel builds with its own query) rather than re-querying.

type GigRow = GigDoc & { id: string };

function ApplyPanel({ gig, gigId }: { gig: GigRow; gigId: string }) {
  const { myProfiles } = useProfileContext();
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
      <Text style={{ color: "#666" }}>
        You need an approved musician profile to apply — switch to one, or join as a musician from the account tab.
      </Text>
    );
  }

  const submit = async () => {
    setError(null);
    const { payload, error: buildError } = buildOfferPayload(gig.budget.structure, offer);
    if (buildError || !payload) { setError(buildError ?? "Invalid offer."); return; }
    setBusy(true);
    try {
      await httpsCallable<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>(
        getFirebase().functions, "applyToGig")({ gigId, musicianProfileId: selected, offer: payload });
      setApplied(true);
    } catch (e) {
      if (errorCode(e) === "functions/already-exists") setAlreadyApplied(true);
      else setError(e instanceof Error ? e.message : "Could not submit your application.");
    } finally {
      setBusy(false);
    }
  };

  if (applied) return <Text style={{ color: "#16a34a" }}>Application sent! The curator has been notified.</Text>;
  if (alreadyApplied) return <Text style={{ color: "#666" }}>There&apos;s already an open booking between this act and this gig.</Text>;

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontWeight: "700" }}>Applying as</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {musicianProfiles.map((m) => (
          <Chip key={m.profileId} label={m.name} active={selected === m.profileId} onPress={() => setSelectedOverride(m.profileId)} />
        ))}
      </View>
      <OfferFields structure={gig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />
      {error && <ErrorBox message={error} />}
      <Pressable onPress={() => void submit()} disabled={busy}
        style={{ backgroundColor: "#111", paddingVertical: 12, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Applying…" : "Apply"}</Text>
      </Pressable>
      <Text style={{ color: "#666", fontSize: 12 }}>{DEPOSIT_HONESTY_LINE}</Text>
    </View>
  );
}

function GigDetailModal({ gig, onClose }: { gig: GigRow | null; onClose: () => void }) {
  return (
    <Modal visible={gig != null} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#00000099", justifyContent: "flex-end" }}>
        <View style={{ maxHeight: "85%", backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
            <Pressable onPress={onClose}><Text style={{ color: "#666" }}>✕ Close</Text></Pressable>
            {gig && (
              <>
                <Text style={{ fontSize: 20, fontWeight: "700" }}>{gig.title || "Untitled gig"}</Text>
                <Text style={{ color: "#666" }}>{formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}</Text>
                <Text>{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}</Text>
                {!!gig.description && <Text>{gig.description}</Text>}
                {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
                  <Text style={{ color: "#666" }}>
                    Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
                  </Text>
                )}
                <Text style={{ color: "#666" }}>{gigLocationLabel(gig.location)}</Text>
                {gig.seriesId != null && <Badge label="Part of a recurring series" bg="#e0e7ff" />}
                <View style={{ borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 12, gap: 8 }}>
                  <Text style={{ fontSize: 16, fontWeight: "700" }}>Apply for this gig</Text>
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

function GigCard({ gig, onPress }: { gig: GigRow; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 6 }}>
      <Text style={{ fontWeight: "700" }}>{gig.title || "Untitled gig"}</Text>
      <Text style={{ color: "#666", fontSize: 13 }}>{formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}</Text>
      <Text style={{ fontSize: 13 }}>
        {formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
      </Text>
      {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
        <Text style={{ color: "#666", fontSize: 13 }}>
          Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
        </Text>
      )}
      <Text style={{ color: "#666", fontSize: 13 }}>{gigLocationLabel(gig.location)}</Text>
      {gig.seriesId != null && <Badge label="Part of a recurring series" bg="#e0e7ff" />}
    </Pressable>
  );
}

// status=="open" ordered startsAt is the one query shape firestore.rules
// can prove without a membership/admin disjunct — mirrors web's identical
// query. Genre/structure are pure client-side filters over that result; the
// date range is mapped onto the query itself as a range on the
// already-indexed startsAt field (gigs(status,startsAt) — no new index
// needed).
export function GigBrowse() {
  const [gigs, setGigs] = useState<GigRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [structure, setStructure] = useState<BudgetStructure | "any">("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedGigId, setSelectedGigId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const constraints: QueryConstraint[] = [where("status", "==", "open")];
    const fromMs = launchTzDayStartMs(fromDate);
    const toMs = launchTzNextDayStartMs(toDate);
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
  }, [fromDate, toDate]);

  const filtered = useMemo(() => {
    if (gigs === "loading") return [];
    return gigs.filter((g) => (genre === null || g.wants.genres.includes(genre)) && (structure === "any" || g.budget.structure === structure));
  }, [gigs, genre, structure]);

  const selectedGig = selectedGigId && gigs !== "loading" ? (gigs.find((g) => g.id === selectedGigId) ?? null) : null;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Find gigs</Text>
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
            <Text>From (YYYY-MM-DD)</Text>
            <TextInput value={fromDate} onChangeText={(t) => setFromDate(t.replace(/[^0-9-]/g, ""))}
              placeholder="YYYY-MM-DD" maxLength={10} style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 130 }} />
          </View>
          <View style={{ gap: 4 }}>
            <Text>To (YYYY-MM-DD)</Text>
            <TextInput value={toDate} onChangeText={(t) => setToDate(t.replace(/[^0-9-]/g, ""))}
              placeholder="YYYY-MM-DD" maxLength={10} style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 130 }} />
          </View>
        </View>
      </View>
      {error && <ErrorBox message={`Could not load gigs: ${error}`} />}
      {gigs === "loading" && <Text>Loading…</Text>}
      {gigs !== "loading" && filtered.length === 0 && !error && <Text style={{ color: "#666" }}>No open gigs match these filters.</Text>}
      <View style={{ gap: 10 }}>
        {filtered.map((g) => <GigCard key={g.id} gig={g} onPress={() => setSelectedGigId(g.id)} />)}
      </View>
      <GigDetailModal gig={selectedGig} onClose={() => setSelectedGigId(null)} />
    </ScrollView>
  );
}

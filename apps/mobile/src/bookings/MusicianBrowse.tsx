import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { GENRES, type ProfileDoc, type MusicianSubtype, type CuratorBookingDoc, type BudgetStructure, type GigDoc } from "@gatekeep/shared";
import { formatCents, formatGigDateTime, BUDGET_STRUCTURE_LABEL, Chip } from "../gigs/GigForms";
import { DEPOSIT_HONESTY_LINE, ErrorBox, OfferFields, buildOfferPayload, emptyOffer, errorCode, type OfferState } from "./BookingForms";

// RN port of ../../../web/src/bookings/MusicianBrowse.tsx (+ OfferComposer.tsx)
// — SP4 Task 12. Mounted as the curator "Find musicians" tab
// (apps/mobile/app/(curator)/musicians.tsx). Task 12's file list has no
// standalone mobile OfferComposer.tsx (unlike web's split) — the offer flow
// is embedded inline here, the same way GigBrowse's ApplyPanel is embedded
// inline in its own detail modal.

type MusicianRow = ProfileDoc & { id: string };

// MusicianSubtype ("solo"|"band") is the only act-size-shaped field
// present on a musician's own profile doc without an extra per-card read —
// same placeholder-grade tradeoff as web's filter.
const ACT_SIZE_OPTIONS: MusicianSubtype[] = ["solo", "band"];
const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };
const RATE_STRUCTURES: BudgetStructure[] = ["perHour", "perSong", "perSet"];

const primaryBtn = { backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 };
const secondaryBtn = { borderWidth: 1 as const, borderColor: "#bbb", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 };

function RatesSummary({ rates }: { rates: CuratorBookingDoc["rates"] }) {
  const parts = RATE_STRUCTURES
    .map((k) => (rates[k] ? `${formatCents(rates[k]!.amountCents)} ${BUDGET_STRUCTURE_LABEL[k]}` : null))
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return <Text style={{ color: "#666", fontSize: 13 }}>No public rates.</Text>;
  return <Text style={{ fontSize: 13 }}>{parts.join(" · ")}</Text>;
}

// Curator picks one of THEIR OWN open gigs and sends offerGig to a specific
// musician profile. Terms form mirrors GigBrowse's Apply panel
// (buildOfferPayload/OfferFields are shared between the two doors).
function OfferComposer({ curatorProfileId, musicianProfileId, musicianName, onClose }: {
  curatorProfileId: string; musicianProfileId: string; musicianName: string; onClose: () => void;
}) {
  const router = useRouter();
  const [openGigs, setOpenGigs] = useState<(GigDoc & { id: string })[] | "loading">("loading");
  const [gigOverride, setGigOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySent, setAlreadySent] = useState(false);
  // SP4 (Task 13 item 9): the returned bookingId (not just a `sent` boolean)
  // — web parity (src/bookings/OfferComposer.tsx's identical "View the
  // booking thread ->" deep link) — so a curator who just sent an offer can
  // jump straight into the thread instead of having to find it again from
  // their bookings tab.
  const [bookingId, setBookingId] = useState<string | null>(null);

  // Live (not one-shot) — the curator's open-gigs set can change while this
  // panel is open. Needs gigs(curatorProfileId,status,startsAt), already
  // shipped (SP3/Task 2).
  useEffect(() => {
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", curatorProfileId), where("status", "==", "open"), orderBy("startsAt")),
      (snap) => setOpenGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))),
      (e) => { setOpenGigs([]); setError(e instanceof Error ? e.message : "Could not load your open gigs."); });
    return unsub;
  }, [curatorProfileId]);

  const selectedGigId = gigOverride && openGigs !== "loading" && openGigs.some((g) => g.id === gigOverride)
    ? gigOverride
    : (openGigs !== "loading" && openGigs.length > 0 ? openGigs[0].id : "");
  const selectedGig = openGigs !== "loading" ? (openGigs.find((g) => g.id === selectedGigId) ?? null) : null;

  const submit = async () => {
    if (!selectedGig) { setError("Pick a gig to offer."); return; }
    setError(null);
    const { payload, error: buildError } = buildOfferPayload(selectedGig.budget.structure, offer);
    if (buildError || !payload) { setError(buildError ?? "Invalid offer."); return; }
    setBusy(true);
    try {
      const { data } = await httpsCallable<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>(
        getFirebase().functions, "offerGig")({ gigId: selectedGig.id, musicianProfileId, offer: payload });
      setBookingId(data.bookingId);
    } catch (e) {
      if (errorCode(e) === "functions/already-exists") setAlreadySent(true);
      else setError(e instanceof Error ? e.message : "Could not send this offer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, marginTop: 8, gap: 10 }}>
      <Text style={{ fontWeight: "700" }}>Offer a gig to {musicianName}</Text>
      {bookingId ? (
        <>
          <Text style={{ color: "#16a34a" }}>Offer sent!</Text>
          <Pressable onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId } })}>
            <Text style={{ textDecorationLine: "underline" }}>View the booking thread →</Text>
          </Pressable>
          <Pressable onPress={onClose} style={secondaryBtn}><Text>Close</Text></Pressable>
        </>
      ) : alreadySent ? (
        <>
          <Text style={{ color: "#666" }}>There is already an open booking request between this act and that gig.</Text>
          <Pressable onPress={onClose} style={secondaryBtn}><Text>Close</Text></Pressable>
        </>
      ) : openGigs === "loading" ? (
        <Text>Loading your open gigs…</Text>
      ) : openGigs.length === 0 ? (
        <>
          <Text style={{ color: "#666" }}>You have no open gigs to offer right now. Post one from the Events tab first.</Text>
          <Pressable onPress={onClose} style={secondaryBtn}><Text>Close</Text></Pressable>
        </>
      ) : (
        <>
          <Text style={{ fontWeight: "600" }}>Gig</Text>
          <View style={{ gap: 6 }}>
            {openGigs.map((g) => (
              <Chip key={g.id} label={`${g.title || "Untitled gig"} — ${formatGigDateTime(g.startsAt)}`}
                active={selectedGigId === g.id} onPress={() => setGigOverride(g.id)} />
            ))}
          </View>
          {selectedGig && <OfferFields structure={selectedGig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />}
          {error && <ErrorBox message={error} />}
          <Text style={{ color: "#666", fontSize: 12 }}>{DEPOSIT_HONESTY_LINE}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={() => void submit()} disabled={busy} style={[primaryBtn, { opacity: busy ? 0.6 : 1 }]}>
              <Text style={{ color: "#fff" }}>{busy ? "Sending…" : "Send offer"}</Text>
            </Pressable>
            <Pressable onPress={onClose} disabled={busy} style={secondaryBtn}><Text>Cancel</Text></Pressable>
          </View>
        </>
      )}
    </View>
  );
}

function MusicianCard({ curatorProfileId, musician }: { curatorProfileId: string; musician: MusicianRow }) {
  const router = useRouter();
  const [booking, setBooking] = useState<CuratorBookingDoc | null | "loading">("loading");
  const [offering, setOffering] = useState(false);

  // Per-card private/curatorBooking read — the caller has curatorAccess via
  // their own approved curator profile membership (firestore.rules); n+1
  // over the list accepted at v1 (spec §1 placeholder grade), same tradeoff
  // as GigBrowse's series-badge decision.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${musician.id}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as CuratorBookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; };
  }, [musician.id]);

  return (
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 6 }}>
      <Text style={{ fontWeight: "700" }}>{musician.name}</Text>
      {musician.portfolio?.genres && musician.portfolio.genres.length > 0 && (
        <Text style={{ color: "#666", fontSize: 13 }}>{musician.portfolio.genres.join(" · ")}</Text>
      )}
      {booking === "loading" ? (
        <Text style={{ color: "#999", fontSize: 13 }}>Loading rates…</Text>
      ) : booking ? (
        <>
          <RatesSummary rates={booking.rates} />
          {/* Counts BOOKINGS, not dates — an 8-date completed whole-run
              booking is +1 here, not +8 (booking-scoped reliability
              summary). */}
          <Text style={{ fontSize: 13, color: "#666" }}>
            {booking.reliability.noShowCount} no-shows / {booking.reliability.completedCount} bookings
          </Text>
        </>
      ) : (
        <Text style={{ color: "#666", fontSize: 13 }}>No booking info shared yet.</Text>
      )}
      <View style={{ flexDirection: "row", gap: 14 }}>
        <Pressable onPress={() => router.push({ pathname: "/artist/[handle]", params: { handle: musician.handle } })}>
          <Text style={{ textDecorationLine: "underline" }}>View portfolio</Text>
        </Pressable>
        <Pressable onPress={() => setOffering((v) => !v)}>
          <Text style={{ textDecorationLine: "underline" }}>{offering ? "Cancel" : "Offer a gig"}</Text>
        </Pressable>
      </View>
      {offering && (
        <OfferComposer key={`${curatorProfileId}-${musician.id}`} curatorProfileId={curatorProfileId}
          musicianProfileId={musician.id} musicianName={musician.name} onClose={() => setOffering(false)} />
      )}
    </View>
  );
}

// Find musicians (apps/mobile/app/(curator)/musicians.tsx): the curator-
// context browse of approved musician acts. type=="musician" &&
// status=="approved" is two pure-equality filters — provable under
// firestore.rules' profiles read rule, no composite index needed.
export function MusicianBrowse({ curatorProfileId }: { curatorProfileId: string }) {
  const [musicians, setMusicians] = useState<MusicianRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [actSize, setActSize] = useState<MusicianSubtype | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, "profiles"), where("type", "==", "musician"), where("status", "==", "approved")))
      .then((snap) => {
        if (cancelled) return;
        setMusicians(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })));
      })
      .catch((e) => {
        if (cancelled) return;
        setMusicians([]);
        setError(e instanceof Error ? e.message : "Could not load musicians.");
      });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (musicians === "loading") return [];
    return musicians.filter((m) =>
      (genre === null || (m.portfolio?.genres ?? []).includes(genre))
      && (actSize === null || m.subtype === actSize));
  }, [musicians, genre, actSize]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Find musicians</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Chip label="All genres" active={genre === null} onPress={() => setGenre(null)} />
        {GENRES.map((g) => <Chip key={g} label={g} active={genre === g} onPress={() => setGenre(genre === g ? null : g)} />)}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Any act size" active={actSize === null} onPress={() => setActSize(null)} />
        {ACT_SIZE_OPTIONS.map((a) => (
          <Chip key={a} label={ACT_SIZE_LABEL[a]} active={actSize === a} onPress={() => setActSize(actSize === a ? null : a)} />
        ))}
      </View>
      {error && <ErrorBox message={`Could not load musicians: ${error}`} />}
      {musicians === "loading" && <Text>Loading…</Text>}
      {musicians !== "loading" && filtered.length === 0 && !error && <Text style={{ color: "#666" }}>No approved musicians match these filters.</Text>}
      <View style={{ gap: 10 }}>
        {filtered.map((m) => <MusicianCard key={m.id} curatorProfileId={curatorProfileId} musician={m} />)}
      </View>
    </ScrollView>
  );
}

import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { type BookingRates, type BudgetStructure, type GigDoc } from "@gatekeep/shared";
import { formatCents, formatGigDateTime, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { DEPOSIT_HONESTY_LINE, DEPOSIT_HONESTY_RUN_LINE, OfferFields, buildOfferPayload, emptyOffer, errorCode, type OfferState } from "./BookingForms";
import { GatePrompt } from "../payments/GatePrompt";
import { Text, Button, Card, Chip, Skeleton } from "../ui";
import { useTokens } from "../theme/ThemeProvider";

// SP8 Task 15: extracted verbatim from the placeholder curator "Find
// musicians" screen (deleted this task), where it was defined inline. Same props, same
// behaviour; only the module boundary changed, so this file's own doors
// (CuratorArtistRow under src/search, opening this in a Sheet) can reach it
// without importing a whole browse screen.

const RATE_STRUCTURES: BudgetStructure[] = ["perHour", "perSong", "perSet"];
// A projection with no rates block at all (summary-only doc, sp4 audit
// finding 1) renders exactly like a musician who set none: "No public rates."
export const NULL_RATES: BookingRates = { perHour: null, perSong: null, perSet: null };

export function RatesSummary({ rates }: { rates: BookingRates }) {
  const parts = RATE_STRUCTURES
    .map((k) => (rates[k] ? `${formatCents(rates[k]!.amountCents)} ${BUDGET_STRUCTURE_LABEL[k]}` : null))
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return <Text variant="meta" muted>No public rates.</Text>;
  return <Text variant="meta">{parts.join(" · ")}</Text>;
}

// Curator picks one of THEIR OWN open gigs and sends offerGig to a specific
// musician profile. Terms form mirrors GigDetailSheet's Apply panel
// (buildOfferPayload/OfferFields are shared between the two doors).
export function OfferComposer({ curatorProfileId, musicianProfileId, musicianName, onClose }: {
  curatorProfileId: string; musicianProfileId: string; musicianName: string; onClose: () => void;
}) {
  const router = useRouter();
  const t = useTokens();
  const [openGigs, setOpenGigs] = useState<(GigDoc & { id: string })[] | "loading">("loading");
  const [gigOverride, setGigOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySent, setAlreadySent] = useState(false);
  // SP4 (Task 13 item 9): the returned bookingId (not just a `sent` boolean),
  // web parity (src/bookings/OfferComposer.tsx's identical "View the
  // booking thread ->" deep link), so a curator who just sent an offer can
  // jump straight into the thread instead of having to find it again from
  // their bookings tab.
  const [bookingId, setBookingId] = useState<string | null>(null);

  // Live (not one-shot), the curator's open-gigs set can change while this
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
      const { data } = await callFn<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>("offerGig", { gigId: selectedGig.id, musicianProfileId, offer: payload });
      setBookingId(data.bookingId);
    } catch (e) {
      if (errorCode(e) === "functions/already-exists") setAlreadySent(true);
      else setError(e instanceof Error ? e.message : "Could not send this offer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginTop: 8, gap: 10 }}>
      <Text variant="label">Offer a gig to {musicianName}</Text>
      {bookingId ? (
        <>
          <Text color={t.success}>Offer sent!</Text>
          <Button title="View the booking thread →" variant="secondary"
            onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId } })} />
          <Button title="Close" variant="secondary" onPress={onClose} />
        </>
      ) : alreadySent ? (
        <>
          <Text muted>There is already an open booking request between this act and that gig.</Text>
          <Button title="Close" variant="secondary" onPress={onClose} />
        </>
      ) : openGigs === "loading" ? (
        <Skeleton height={16} width="70%" />
      ) : openGigs.length === 0 ? (
        <>
          <Text muted>You have no open gigs to offer right now. Post one from the Events tab first.</Text>
          <Button title="Close" variant="secondary" onPress={onClose} />
        </>
      ) : (
        <>
          <Text variant="label">Gig</Text>
          <View style={{ gap: 6 }}>
            {openGigs.map((g) => (
              <Chip key={g.id} label={`${g.title || "Untitled gig"}, ${formatGigDateTime(g.startsAt)}`}
                active={selectedGigId === g.id} onPress={() => setGigOverride(g.id)} />
            ))}
          </View>
          {selectedGig && <OfferFields structure={selectedGig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />}
          {error && <GatePrompt message={error} curatorProfileId={curatorProfileId} onRetry={() => void submit()} />}
          <Text variant="meta" muted>{selectedGig?.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title={busy ? "Sending…" : "Send offer"} disabled={busy} onPress={() => void submit()} />
            <Button title="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
          </View>
        </>
      )}
    </Card>
  );
}

"use client";
import { useEffect, useId, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatGigDateTime, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { DEPOSIT_HONESTY_LINE, OfferFields, buildOfferPayload, emptyOffer, type OfferState } from "./BookingForms";
import { GatePrompt } from "../payments/GatePrompt";
import type { GigDoc } from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type GigRow = GigDoc & { id: string };

// Used from Find musicians (apps/web/src/bookings/MusicianBrowse.tsx): a
// curator picks one of THEIR OWN open gigs and sends offerGig to a specific
// musician profile. Terms form mirrors the gig detail page's Apply panel
// (buildOfferPayload/OfferFields are shared between the two doors).
export function OfferComposer({ curatorProfileId, musicianProfileId, musicianName, onClose }: {
  curatorProfileId: string; musicianProfileId: string; musicianName: string; onClose: () => void;
}) {
  // MusicianBrowse can open several OfferComposer instances on the same
  // page (one per musician card), so a literal "offer-composer-gig" id would
  // collide across them; useId() gives each mounted instance its own.
  const gigSelectId = useId();
  const [openGigs, setOpenGigs] = useState<GigRow[] | "loading">("loading");
  const [gigOverride, setGigOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySent, setAlreadySent] = useState(false);
  const [bookingId, setBookingId] = useState<string | null>(null);

  // Live (not one-shot): the curator's open-gigs set can change while this
  // panel is open (another tab publishing/cancelling a gig); needs its own
  // 3-field composite index, already present (gigs(curatorProfileId,status,
  // startsAt), see firestore.indexes.json, shipped with SP3/Task 2).
  useEffect(() => {
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"),
        where("curatorProfileId", "==", curatorProfileId), where("status", "==", "open"), orderBy("startsAt")),
      (snap) => setOpenGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))),
      (e) => { setOpenGigs([]); setError(e instanceof Error ? e.message : "Could not load your open gigs."); });
    return unsub;
  }, [curatorProfileId]);

  // Derived default selection (no setState-in-effect, see the gig detail
  // page's ApplyPanel comment for the same rationale).
  const selectedGigId = gigOverride && openGigs !== "loading" && openGigs.some((g) => g.id === gigOverride)
    ? gigOverride
    : (openGigs !== "loading" && openGigs.length > 0 ? openGigs[0].id : "");
  const selectedGig = openGigs !== "loading" ? openGigs.find((g) => g.id === selectedGigId) ?? null : null;

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
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/already-exists") setAlreadySent(true);
      else setError(e instanceof Error ? e.message : "Could not send this offer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-2 p-4">
      <CardContent className="grid gap-3 p-0">
        <p className="font-syne text-base font-semibold text-gk-text">Offer a gig to {musicianName}</p>
        {bookingId ? (
          <>
            <p className="font-sora text-sm text-gk-success">Offer sent!</p>
            <Button asChild variant="link" className="h-auto justify-self-start p-0">
              <a href={`/dashboard/bookings/${bookingId}`}>View the booking thread →</a>
            </Button>
            <Button type="button" variant="secondary" onClick={onClose} className="justify-self-start">Close</Button>
          </>
        ) : alreadySent ? (
          <>
            <p className="font-sora text-sm text-gk-muted">There is already an open booking request between this act and that gig.</p>
            <Button type="button" variant="secondary" onClick={onClose} className="justify-self-start">Close</Button>
          </>
        ) : openGigs === "loading" ? (
          <p className="font-sora text-sm text-gk-muted">Loading your open gigs…</p>
        ) : openGigs.length === 0 ? (
          <>
            <p className="font-sora text-sm text-gk-muted">
              You have no open gigs to offer right now.{" "}
              <a
                href={`/dashboard/curator/${curatorProfileId}/gigs/new`}
                className="text-gk-text underline underline-offset-4 hover:text-gk-accent"
              >
                Post a gig
              </a>.
            </p>
            <Button type="button" variant="secondary" onClick={onClose} className="justify-self-start">Close</Button>
          </>
        ) : (
          <>
            <div className="grid max-w-sm gap-1.5">
              <label htmlFor={gigSelectId} className="font-sora text-sm font-medium text-gk-text">Gig</label>
              <Select value={selectedGigId} onValueChange={setGigOverride}>
                <SelectTrigger id={gigSelectId} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {openGigs.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {(g.title || "Untitled gig")} · {formatGigDateTime(g.startsAt)} ({BUDGET_STRUCTURE_LABEL[g.budget.structure]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedGig && <OfferFields structure={selectedGig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />}
            {/* SP5 Task 15: offerGig's own gates (requireCuratorChargeable)
                throw CURATOR_CARD_REQUIRED_MESSAGE/CURATOR_DELINQUENT_MESSAGE
                verbatim: GatePrompt opens SaveCardModal inline (retrying this
                same submit once saved) or links to the overdue booking; any
                other error falls through to the same plain warning line this
                used to render directly. */}
            {error && <GatePrompt message={error} curatorProfileId={curatorProfileId} onRetry={submit} />}
            <p className="font-sora text-xs text-gk-muted">{DEPOSIT_HONESTY_LINE}</p>
            <div className="flex gap-2">
              <Button onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send offer"}</Button>
              <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

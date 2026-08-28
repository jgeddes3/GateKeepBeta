"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatGigDateTime, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { DEPOSIT_HONESTY_LINE, OfferFields, buildOfferPayload, emptyOffer, type OfferState } from "./BookingForms";
import { GatePrompt } from "../payments/GatePrompt";
import type { GigDoc } from "@gatekeep/shared";

type GigRow = GigDoc & { id: string };

// Used from Find musicians (apps/web/src/bookings/MusicianBrowse.tsx): a
// curator picks one of THEIR OWN open gigs and sends offerGig to a specific
// musician profile. Terms form mirrors the gig detail page's Apply panel
// (buildOfferPayload/OfferFields are shared between the two doors).
export function OfferComposer({ curatorProfileId, musicianProfileId, musicianName, onClose }: {
  curatorProfileId: string; musicianProfileId: string; musicianName: string; onClose: () => void;
}) {
  const [openGigs, setOpenGigs] = useState<GigRow[] | "loading">("loading");
  const [gigOverride, setGigOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySent, setAlreadySent] = useState(false);
  const [bookingId, setBookingId] = useState<string | null>(null);

  // Live (not one-shot) — the curator's open-gigs set can change while this
  // panel is open (another tab publishing/cancelling a gig); needs its own
  // 3-field composite index, already present (gigs(curatorProfileId,status,
  // startsAt) — see firestore.indexes.json, shipped with SP3/Task 2).
  useEffect(() => {
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"),
        where("curatorProfileId", "==", curatorProfileId), where("status", "==", "open"), orderBy("startsAt")),
      (snap) => setOpenGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))),
      (e) => { setOpenGigs([]); setError(e instanceof Error ? e.message : "Could not load your open gigs."); });
    return unsub;
  }, [curatorProfileId]);

  // Derived default selection (no setState-in-effect — see the gig detail
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
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginTop: 8, display: "grid", gap: 10 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Offer a gig to {musicianName}</p>
      {bookingId ? (
        <>
          <p style={{ color: "#16a34a", margin: 0 }}>Offer sent!</p>
          <p style={{ margin: 0 }}><a href={`/dashboard/bookings/${bookingId}`}>View the booking thread →</a></p>
          <button type="button" onClick={onClose}>Close</button>
        </>
      ) : alreadySent ? (
        <>
          <p style={{ color: "#666", margin: 0 }}>There is already an open booking request between this act and that gig.</p>
          <button type="button" onClick={onClose}>Close</button>
        </>
      ) : openGigs === "loading" ? (
        <p style={{ margin: 0 }}>Loading your open gigs…</p>
      ) : openGigs.length === 0 ? (
        <>
          <p style={{ margin: 0, color: "#666" }}>
            You have no open gigs to offer right now. <a href={`/dashboard/curator/${curatorProfileId}/gigs/new`}>Post a gig</a>.
          </p>
          <button type="button" onClick={onClose}>Close</button>
        </>
      ) : (
        <>
          <label>Gig:{" "}
            <select value={selectedGigId} onChange={(e) => setGigOverride(e.target.value)}>
              {openGigs.map((g) => (
                <option key={g.id} value={g.id}>
                  {(g.title || "Untitled gig")} — {formatGigDateTime(g.startsAt)} ({BUDGET_STRUCTURE_LABEL[g.budget.structure]})
                </option>
              ))}
            </select>
          </label>
          {selectedGig && <OfferFields structure={selectedGig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />}
          {/* SP5 Task 15: offerGig's own gates (requireCuratorChargeable)
              throw CURATOR_CARD_REQUIRED_MESSAGE/CURATOR_DELINQUENT_MESSAGE
              verbatim — GatePrompt opens SaveCardModal inline (retrying this
              same submit once saved) or links to the overdue booking; any
              other error falls through to the same plain warning line this
              used to render directly. */}
          {error && <GatePrompt message={error} curatorProfileId={curatorProfileId} onRetry={submit} />}
          <p style={{ color: "#666", fontSize: 13, margin: 0 }}>{DEPOSIT_HONESTY_LINE}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send offer"}</button>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

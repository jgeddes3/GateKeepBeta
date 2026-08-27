"use client";
import { useState } from "react";
import { OfferFields, buildOfferPayload, emptyOffer, type OfferState, type OfferPayload } from "./BookingForms";
import type { BudgetStructure } from "@gatekeep/shared";

// Task 10's counter-offer form on the booking thread screen — same fields
// as Task 9's apply/offer composers (OfferFields, buildOfferPayload —
// exactly the client-side mirror of validateOfferInput counterBooking runs
// server-side), wrapped as a dumb value/submit component so BookingThread
// owns the actual counterBooking call, its busy lock, and its verbatim-
// server-error surface (this component only owns CLIENT-side validation —
// the `error` prop is for the server's own error message, shown alongside
// any local validation failure).
export function OfferForm({ structure, busy, error, onSubmit, onCancel, submitLabel = "Send counter" }: {
  structure: BudgetStructure;
  busy: boolean;
  error: string | null;
  onSubmit: (payload: OfferPayload) => void;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const { payload, error: buildError } = buildOfferPayload(structure, offer);
    if (buildError || !payload) { setLocalError(buildError ?? "Invalid offer."); return; }
    setLocalError(null);
    onSubmit(payload);
  };

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, display: "grid", gap: 10 }}>
      <OfferFields structure={structure} value={offer} onChange={setOffer} disabled={busy} />
      {(localError ?? error) && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {localError ?? error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy}>{busy ? "Sending…" : submitLabel}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

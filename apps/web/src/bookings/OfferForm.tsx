"use client";
import { useState } from "react";
import { OfferFields, buildOfferPayload, emptyOffer, type OfferState, type OfferPayload } from "./BookingForms";
import type { BudgetStructure } from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { IconWarning } from "../ui/icons";

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
    <Card className="p-4">
      <CardContent className="grid gap-4 p-0">
        <OfferFields structure={structure} value={offer} onChange={setOffer} disabled={busy} />
        {(localError ?? error) && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
          >
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {localError ?? error}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={submit} disabled={busy}>{busy ? "Sending…" : submitLabel}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

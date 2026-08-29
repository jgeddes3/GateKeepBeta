import { useState } from "react";
import { View } from "react-native";
import { OfferFields, buildOfferPayload, emptyOffer, ErrorBox, type OfferState, type OfferPayload } from "./BookingForms";
import type { BudgetStructure } from "@gatekeep/shared";
import { Button, Card } from "../ui";
import { tokens } from "../theme/tokens";

// RN port of ../../../web/src/bookings/OfferForm.tsx, the booking thread
// screen's counter-offer form (SP4 Task 12). Same fields as GigBrowse's
// Apply panel / MusicianBrowse's offer composer (OfferFields,
// buildOfferPayload, the client-side mirror of validateOfferInput
// counterBooking runs server-side), wrapped as a dumb value/submit
// component: BookingThread owns the actual counterBooking call, its busy
// lock, and its verbatim-server-error surface (the `error` prop here is for
// THAT, this component only owns client-side validation).
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
    <Card style={{ gap: tokens.space.md }}>
      <OfferFields structure={structure} value={offer} onChange={setOffer} disabled={busy} />
      {(localError ?? error) && <ErrorBox message={(localError ?? error)!} />}
      <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Button title={busy ? "Sending…" : submitLabel} onPress={submit} disabled={busy} />
        <Button title="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
      </View>
    </Card>
  );
}

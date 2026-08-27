import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { OfferFields, buildOfferPayload, emptyOffer, ErrorBox, type OfferState, type OfferPayload } from "./BookingForms";
import type { BudgetStructure } from "@gatekeep/shared";

// RN port of ../../../web/src/bookings/OfferForm.tsx — the booking thread
// screen's counter-offer form (SP4 Task 12). Same fields as GigBrowse's
// Apply panel / MusicianBrowse's offer composer (OfferFields,
// buildOfferPayload — the client-side mirror of validateOfferInput
// counterBooking runs server-side), wrapped as a dumb value/submit
// component: BookingThread owns the actual counterBooking call, its busy
// lock, and its verbatim-server-error surface (the `error` prop here is for
// THAT — this component only owns client-side validation).
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
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 10 }}>
      <OfferFields structure={structure} value={offer} onChange={setOffer} disabled={busy} />
      {(localError ?? error) && <ErrorBox message={(localError ?? error)!} />}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={submit} disabled={busy}
          style={{ backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: "#fff" }}>{busy ? "Sending…" : submitLabel}</Text>
        </Pressable>
        <Pressable onPress={onCancel} disabled={busy}
          style={{ borderWidth: 1, borderColor: "#bbb", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 }}>
          <Text>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

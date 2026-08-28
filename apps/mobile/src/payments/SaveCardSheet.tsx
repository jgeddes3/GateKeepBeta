import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { stripeEnabled, runSetupSheet, setupIntentIdFromClientSecret } from "./stripe";

// SP5b — the native counterpart of apps/web/src/payments/SaveCardModal.tsx.
// Same flow, with the PaymentSheet replacing Elements:
//  1. createSetupIntent({profileId}) -> clientSecret.
//  2a. REAL mode: initPaymentSheet(setupIntentClientSecret)+present (cards +
//      Apple Pay + Google Pay), then refreshPaymentMethod({profileId,
//      setupIntentId}) — the id parsed off the client secret is the same one
//      web reads from confirmSetup's result, and passing it is what pins THIS
//      card as the customer default (see refreshPaymentMethod's as-built note
//      in functions/src/payments.ts).
//  2b. FAKE mode (!stripeEnabled): createSetupIntent already marked the card
//      saved server-side before returning (SaveCardModal's header documents
//      why) — show the confirmation, no sheet, no refresh call.
// A user-cancelled sheet is silent (no error, stays open) — parity with web's
// modal close.
export function SaveCardSheet({ profileId, onSaved, onClose }: {
  profileId: string; onSaved: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fakeSaved, setFakeSaved] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable<{ profileId: string }, { clientSecret: string; customerId: string }>(
        getFirebase().functions, "createSetupIntent")({ profileId });
      if (!stripeEnabled) {
        setFakeSaved(true);
        return;
      }
      const outcome = await runSetupSheet(res.data.clientSecret);
      if (!outcome.ok) {
        if (!outcome.cancelled) setError(outcome.message ?? "Could not save the card.");
        return;
      }
      // The card and SetupIntent both succeeded with Stripe; only our own
      // follow-up can fail past here — same honest distinction web draws.
      try {
        await httpsCallable(getFirebase().functions, "refreshPaymentMethod")({
          profileId, setupIntentId: setupIntentIdFromClientSecret(res.data.clientSecret),
        });
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message
          : "The card was saved with Stripe, but we couldn't confirm it here — try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start card setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 10 }}>
      <Text style={{ fontWeight: "600" }}>Save a payment card</Text>
      {error && (
        <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
          borderRadius: 8, padding: 12, color: "#92400e" }}>{error}</Text>
      )}
      {fakeSaved ? (
        <>
          <Text style={{ color: "#166534" }}>
            Test card saved (visa •••• 4242) — no real payment sheet runs in the emulator.
          </Text>
          <Pressable onPress={onSaved} style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 10 }}>
            <Text>Done</Text>
          </Pressable>
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable onPress={() => void start()} disabled={busy}
            style={{ backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
            <Text style={{ color: "#fff" }}>{busy ? "Starting…" : "Add a card"}</Text>
          </Pressable>
          <Pressable onPress={onClose} disabled={busy}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

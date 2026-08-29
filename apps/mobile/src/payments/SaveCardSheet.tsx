import { useState } from "react";
import { View } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { stripeEnabled, runSetupSheet, setupIntentIdFromClientSecret, sheetAppearanceFromTokens } from "./stripe";
import { Text, Button, Card, Callout } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5b: the native counterpart of apps/web/src/payments/SaveCardModal.tsx.
// Same flow, with the PaymentSheet replacing Elements:
//  1. createSetupIntent({profileId}) -> clientSecret.
//  2a. REAL mode: initPaymentSheet(setupIntentClientSecret)+present (cards +
//      Apple Pay + Google Pay), then refreshPaymentMethod({profileId,
//      setupIntentId}): the id parsed off the client secret is the same one
//      web reads from confirmSetup's result, and passing it is what pins THIS
//      card as the customer default (see refreshPaymentMethod's as-built note
//      in functions/src/payments.ts).
//  2b. FAKE mode (!stripeEnabled): createSetupIntent already marked the card
//      saved server-side before returning (SaveCardModal's header documents
//      why), show the confirmation, no sheet, no refresh call.
// A user-cancelled sheet is silent (no error, stays open), parity with web's
// modal close.
export function SaveCardSheet({ profileId, onSaved, onClose }: {
  profileId: string; onSaved: () => void; onClose: () => void;
}) {
  const t = useTokens();
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
      const outcome = await runSetupSheet(res.data.clientSecret, sheetAppearanceFromTokens(t));
      if (!outcome.ok) {
        if (!outcome.cancelled) setError(outcome.message ?? "Could not save the card.");
        return;
      }
      // The card and SetupIntent both succeeded with Stripe; only our own
      // follow-up can fail past here, same honest distinction web draws.
      try {
        await httpsCallable(getFirebase().functions, "refreshPaymentMethod")({
          profileId, setupIntentId: setupIntentIdFromClientSecret(res.data.clientSecret),
        });
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message
          : "The card was saved with Stripe, but we couldn't confirm it here, try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start card setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: tokens.space.md }}>
      <Text variant="label">Save a payment card</Text>
      {error && <Callout tone="warning"><Text color={t.warning}>{error}</Text></Callout>}
      {fakeSaved ? (
        <>
          <Text color={t.success}>
            Test card saved (visa •••• 4242). No real payment sheet runs in the emulator.
          </Text>
          <Button title="Done" variant="secondary" onPress={onSaved} style={{ alignSelf: "flex-start" }} />
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
          <Button title={busy ? "Starting…" : "Add a card"} onPress={() => void start()} disabled={busy} />
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
        </View>
      )}
    </Card>
  );
}

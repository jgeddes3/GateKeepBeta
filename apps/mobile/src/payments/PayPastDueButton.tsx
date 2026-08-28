import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { stripeEnabled, runPaymentSheet } from "./stripe";

// SP5b Task 4 — the native counterpart of apps/web/src/payments/
// PayPastDueButton.tsx. Same dispatcher-driven flow: `payPastDue`
// DISPATCHES server-side on which debt {bookingId, gigId} actually owes (see
// functions/src/payments.ts's header on the dispatcher) — this button just
// triggers it and doesn't need to know which kind of debt it is. No
// client-supplied amount ever crosses this boundary; the server picks both
// which debt and how much.
//
// Two response shapes (PayPastDueResult, mirrored here — not imported, same
// boundary web's copy respects: this app never depends on functions/src
// types):
//  - FAKE STRIPE (emulator): `done: true` — the callable already finalized
//    the charge by the time it returns; nothing left for the client to do.
//  - REAL: `done: false, clientSecret` — the PaymentSheet replaces web's
//    Elements/ConfirmForm split; runPaymentSheet(clientSecret) is the same
//    native sheet SaveCardSheet's setup-intent flow uses, confirming a
//    PaymentIntent instead of a SetupIntent.
interface PayPastDueResult { done: boolean; amountCents: number; clientSecret?: string; }

export function PayPastDueButton({ bookingId, gigId, onDone }: {
  bookingId: string; gigId: string;
  // Optional: fired once the payment is confirmed (fake path) or the sheet
  // succeeds (real path) — the curator card-on-file row uses this to refresh
  // Stripe status (a cleared delinquency), not to refresh the row itself
  // (the live onSnapshot already covers that).
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable<{ bookingId: string; gigId: string }, PayPastDueResult>(
        getFirebase().functions, "payPastDue")({ bookingId, gigId });
      if (res.data.done) {
        setDone(true);
        onDone?.();
        return;
      }
      if (!res.data.clientSecret) {
        setError("Could not start this payment — try again.");
        return;
      }
      if (!stripeEnabled) {
        // Defensive only: FakeStripe confirms synchronously (done:true), so a
        // clientSecret without a key means a config mismatch, not a user path.
        setError("This payment needs the payment sheet, which isn't configured in this build.");
        return;
      }
      const outcome = await runPaymentSheet(res.data.clientSecret);
      if (outcome.ok) {
        // payment_intent.succeeded finalizes the doc out-of-band; the row's
        // onSnapshot picks the terminal write up on its own (web's comment).
        setDone(true);
        onDone?.();
      } else if (!outcome.cancelled) {
        setError(outcome.message ?? "Could not complete the payment.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not pay this now.");
    } finally {
      setBusy(false);
    }
  };

  // The delinquency LIFT (clearDelinquencyIfSettled) is NOT guaranteed to
  // have landed by the time either success path gets here — the real-Stripe
  // path finalizes off the payment_intent.succeeded webhook (fully async,
  // arrives after this call already returned), and even the fake-mode
  // `done:true` path's onDone() just triggers a fresh getStripeStatus read
  // that can still race the finalize write by a beat. The copy says so
  // rather than implying the delinquency banner/card row already reflects
  // it (mirrors web's identical review-round comment).
  if (done) {
    return <Text style={{ color: "#166534" }}>Payment sent — clearing any overdue status may take a moment.</Text>;
  }
  return (
    <View style={{ gap: 6 }}>
      {error && (
        <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
          borderRadius: 8, padding: 12, color: "#92400e" }}>{error}</Text>
      )}
      <Pressable onPress={() => void start()} disabled={busy} style={{ alignSelf: "flex-start" }}>
        <Text style={{ color: "#dc2626", textDecorationLine: "underline" }}>
          {busy ? "Starting…" : "Pay now"}
        </Text>
      </Pressable>
    </View>
  );
}

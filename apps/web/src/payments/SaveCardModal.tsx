"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { getFirebase } from "../lib/firebase";
import { getStripeJs, stripeEnabled } from "./stripeLoader";

// House idiom (see src/bookings/CancelDialog.tsx): "use client",
// httpsCallable(getFirebase().functions, ...), inline styles, verbatim
// server-error surfacing, a busy/error pair of local state.
//
// FLOW:
//  1. createSetupIntent({profileId}) — ensures a Stripe customer exists and
//     returns a SetupIntent client secret.
//  2a. REAL mode (stripeEnabled): mount <Elements clientSecret> +
//      PaymentElement, confirm with stripe.confirmSetup({redirect:
//      "if_required"}), then call refreshPaymentMethod({profileId,
//      setupIntentId}) — passing the confirmed SetupIntent's id is what
//      pins THAT card as the customer default (see the as-built comment on
//      refreshPaymentMethod in functions/src/payments.ts — without it a
//      second saved card would silently re-pin whatever was already
//      default).
//  2b. FAKE mode (!stripeEnabled, the emulator posture — no publishable key
//      configured): there is no Elements flow to run against FakeStripe (no
//      real card form exists). createSetupIntent's own as-built
//      implementation already does everything a confirm+refresh round trip
//      would: on FakeStripe it marks the card saved, resolves the fake's
//      default payment method, pins it as the customer default via
//      setDefaultPaymentMethod, AND writes cardBrand/cardLast4/
//      defaultPaymentMethodId onto profiles/{profileId}/private/stripe —
//      all before the callable returns. Calling refreshPaymentMethod
//      afterward would be a redundant round trip producing the identical
//      doc. So the fake path is exactly: createSetupIntent() -> show a
//      "test card saved" confirmation -> onSaved().
export function SaveCardModal({ profileId, onSaved, onClose }: {
  profileId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [fakeSaved, setFakeSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable<{ profileId: string }, { clientSecret: string; customerId: string }>(
        getFirebase().functions, "createSetupIntent")({ profileId });
      if (stripeEnabled) {
        setClientSecret(res.data.clientSecret);
      } else {
        // Fake path: the callable already saved the card (see the header
        // note above) — nothing left to confirm.
        setFakeSaved(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start card setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, display: "grid", gap: 10 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Save a payment card</p>
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      {fakeSaved ? (
        <>
          <p style={{ margin: 0, color: "#166534" }}>Test card saved (visa •••• 4242) — no real Stripe Elements form runs in the emulator.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onSaved}>Done</button>
          </div>
        </>
      ) : clientSecret ? (
        <Elements stripe={getStripeJs()} options={{ clientSecret }}>
          <CardConfirmForm profileId={profileId} onSaved={onSaved} onCancel={onClose} />
        </Elements>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={start} disabled={busy}>{busy ? "Starting…" : "Add a card"}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// Split out so useStripe()/useElements() only run inside the <Elements>
// provider they need — the outer SaveCardModal renders this ONLY once
// clientSecret (and thus a live Elements context) exists.
function CardConfirmForm({ profileId, onSaved, onCancel }: {
  profileId: string; onSaved: () => void; onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: confirmError, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Could not save the card.");
      setBusy(false);
      return;
    }
    if (!setupIntent) {
      setError("Could not confirm the card setup — try again.");
      setBusy(false);
      return;
    }
    try {
      // Passes the CONFIRMED SetupIntent's id — see the header note on why
      // this (not a bare refresh) is what pins THIS card as the default.
      await httpsCallable(getFirebase().functions, "refreshPaymentMethod")(
        { profileId, setupIntentId: setupIntent.id });
      onSaved();
    } catch (e) {
      // The card and the SetupIntent both succeeded with Stripe; only our
      // own follow-up call failed — a friendly-but-honest distinction.
      setError(e instanceof Error ? e.message : "The card was saved with Stripe, but we couldn't confirm it here — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <PaymentElement />
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={confirm} disabled={busy || !stripe || !elements}>{busy ? "Saving…" : "Save card"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

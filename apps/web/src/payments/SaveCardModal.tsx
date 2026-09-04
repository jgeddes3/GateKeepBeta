"use client";
import { useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { callFn } from "../lib/callable";
import { getStripeJs, stripeEnabled } from "./stripeLoader";
import { gkStripeAppearance } from "./stripeAppearance";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { IconWarning } from "../ui/icons";

// House idiom (see src/bookings/CancelDialog.tsx): "use client",
// callFn(...) (lib/callable.ts, Task 27), inline styles, verbatim
// server-error surfacing, a busy/error pair of local state.
//
// FLOW:
//  1. createSetupIntent({profileId}): ensures a Stripe customer exists and
//     returns a SetupIntent client secret.
//  2a. REAL mode (stripeEnabled): mount <Elements clientSecret> +
//      PaymentElement, confirm with stripe.confirmSetup({redirect:
//      "if_required"}), then call refreshPaymentMethod({profileId,
//      setupIntentId}): passing the confirmed SetupIntent's id is what
//      pins THAT card as the customer default (see the as-built comment on
//      refreshPaymentMethod in functions/src/payments.ts, without it a
//      second saved card would silently re-pin whatever was already
//      default).
//  2b. FAKE mode (!stripeEnabled, the emulator posture: no publishable key
//      configured): there is no Elements flow to run against FakeStripe (no
//      real card form exists). createSetupIntent's own as-built
//      implementation already does everything a confirm+refresh round trip
//      would: on FakeStripe it marks the card saved, resolves the fake's
//      default payment method, pins it as the customer default via
//      setDefaultPaymentMethod, AND writes cardBrand/cardLast4/
//      defaultPaymentMethodId onto profiles/{profileId}/private/stripe,
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
  // Reads computed CSS custom properties off the document (real DOM work),
  // same render-body-work-avoidance idiom this app's own useMemo'd
  // `filtered` lists already use elsewhere, computed once per mount rather
  // than on every render.
  const appearance = useMemo(() => gkStripeAppearance(), []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await callFn<{ profileId: string }, { clientSecret: string; customerId: string }>("createSetupIntent", { profileId });
      if (stripeEnabled) {
        setClientSecret(res.data.clientSecret);
      } else {
        // Fake path: the callable already saved the card (see the header
        // note above), nothing left to confirm.
        setFakeSaved(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start card setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <CardContent className="grid gap-3 p-0">
        <p className="font-syne text-base font-semibold text-gk-text">Save a payment card</p>
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
          >
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
        {fakeSaved ? (
          <>
            <p className="font-sora text-sm text-gk-success">
              Test card saved (visa •••• 4242). No real Stripe Elements form runs in the emulator.
            </p>
            <div className="flex gap-2">
              <Button onClick={onSaved}>Done</Button>
            </div>
          </>
        ) : clientSecret ? (
          <Elements stripe={getStripeJs()} options={{ clientSecret, appearance }}>
            <CardConfirmForm profileId={profileId} onSaved={onSaved} onCancel={onClose} />
          </Elements>
        ) : (
          <div className="flex gap-2">
            <Button onClick={start} disabled={busy}>{busy ? "Starting…" : "Add a card"}</Button>
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Split out so useStripe()/useElements() only run inside the <Elements>
// provider they need: the outer SaveCardModal renders this ONLY once
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
      setError("Could not confirm the card setup, try again.");
      setBusy(false);
      return;
    }
    try {
      // Passes the CONFIRMED SetupIntent's id, see the header note on why
      // this (not a bare refresh) is what pins THIS card as the default.
      await callFn("refreshPaymentMethod",
        { profileId, setupIntentId: setupIntent.id });
      onSaved();
    } catch (e) {
      // The card and the SetupIntent both succeeded with Stripe; only our
      // own follow-up call failed: a friendly-but-honest distinction.
      setError(e instanceof Error ? e.message : "The card was saved with Stripe, but we couldn't confirm it here, try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <PaymentElement />
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={confirm} disabled={busy || !stripe || !elements}>{busy ? "Saving…" : "Save card"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

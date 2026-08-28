"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { getFirebase } from "../lib/firebase";
import { getStripeJs } from "./stripeLoader";

// SP5 Task 15 — pays down an overdue settlement OR an exhausted birth
// deposit for one occurrence. `payPastDue` DISPATCHES server-side on which
// debt {bookingId, gigId} actually owes (see functions/src/payments.ts's
// header on the dispatcher) — this button just triggers it and doesn't need
// to know which kind of debt it is.
//
// Two response shapes (PayPastDueResult, mirrored here — not imported, since
// apps/web never depends on functions/src types, same boundary every other
// payments component in this app respects):
//  - FAKE STRIPE (emulator): `done: true` — the callable already finalized
//    the charge by the time it returns; nothing left for the browser to do.
//  - REAL: `done: false, clientSecret` — the SAME on-session confirm flow as
//    SaveCardModal's CardConfirmForm (an Elements PaymentElement against the
//    returned clientSecret, confirmed with stripe.confirmPayment({redirect:
//    "if_required"})), except this confirms a PaymentIntent, not a
//    SetupIntent.
interface PayPastDueResult {
  done: boolean; amountCents: number; clientSecret?: string;
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
      {message}
    </p>
  );
}

// Split out so useStripe()/useElements() only run inside the live <Elements>
// context PayPastDueButton renders this into — mirrors SaveCardModal's
// CardConfirmForm split for the identical reason.
function ConfirmForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Could not complete the payment.");
      setBusy(false);
      return;
    }
    // The payment_intent.succeeded webhook finalizes the doc out-of-band
    // (transfer, terminal write, ledger, delinquency lift) — the live
    // onSnapshot in PaymentsPanel picks up the resulting write on its own;
    // this just tells the caller the confirm step itself is done.
    onDone();
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <PaymentElement />
      {error && <ErrorBox message={error} />}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={confirm} disabled={busy || !stripe || !elements}>{busy ? "Paying…" : "Pay now"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

export function PayPastDueButton({ bookingId, gigId, onDone }: {
  bookingId: string; gigId: string;
  // Optional: fired once the payment is confirmed (fake path) or the
  // on-session confirm succeeds (real path) — PaymentsPanel uses this to
  // refresh the curator's Stripe status (a cleared delinquency), not to
  // refresh the row itself (the live onSnapshot already covers that).
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
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
      } else if (res.data.clientSecret) {
        setClientSecret(res.data.clientSecret);
      } else {
        // Real mode's own non-success exit with no clientSecret at all — see
        // PayPastDueResult's header. Not expected in practice; a friendly
        // fallback rather than a silent no-op button.
        setError("Could not start this payment — try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not pay this now.");
    } finally {
      setBusy(false);
    }
  };

  // Review round 1 (low #13): the delinquency LIFT (clearDelinquencyIfSettled)
  // is NOT guaranteed to have landed by the time either success path gets
  // here — the real-Stripe path finalizes off the payment_intent.succeeded
  // webhook (fully async, arrives after this confirm call already returned),
  // and even the fake-mode `done:true` path's onDone() just triggers a fresh
  // getStripeStatus read that can still race the finalize write by a beat.
  // The copy says so rather than implying the delinquency banner/card row is
  // guaranteed to already reflect it.
  if (done) return <p style={{ margin: 0, color: "#166534" }}>Payment sent — clearing any overdue status may take a moment.</p>;

  if (clientSecret) {
    return (
      <Elements stripe={getStripeJs()} options={{ clientSecret }}>
        <ConfirmForm onDone={() => { setDone(true); onDone?.(); }} onCancel={() => setClientSecret(null)} />
      </Elements>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {error && <ErrorBox message={error} />}
      <button onClick={start} disabled={busy} style={{ width: "fit-content", color: "#dc2626" }}>
        {busy ? "Starting…" : "Pay now"}
      </button>
    </div>
  );
}

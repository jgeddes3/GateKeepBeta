"use client";
import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../src/lib/firebase";
import { clearOnboardingProfileId, readOnboardingProfileId } from "../../../../../src/payments/onboardingRedirect";

// Stripe's return_url for account_onboarding — hit once the musician
// finishes (or exits) the hosted onboarding flow. getStripeStatus re-syncs
// the cached gate flags server-side (syncStripeAccountFlags) as a side
// effect of being called at all, so this page's own job is just to surface
// an immediate, friendly result; the Earnings page's own load re-syncs
// again regardless.
type Result = "loading" | "no-profile" | "error" | { payoutsEnabled: boolean };

export default function OnboardingReturnPage() {
  const [result, setResult] = useState<Result>("loading");
  useEffect(() => {
    let cancelled = false;
    // The whole body runs inside the async IIFE (including the no-profileId
    // exit) so every setState call is deferred to a callback rather than
    // firing synchronously during the effect body — react-hooks/
    // set-state-in-effect flags the latter as a cascading-render hazard.
    (async () => {
      const profileId = readOnboardingProfileId();
      if (!profileId) {
        if (!cancelled) setResult("no-profile");
        return;
      }
      clearOnboardingProfileId(); // one-shot — this page is the terminal step of one onboarding attempt
      try {
        const res = await httpsCallable<{ profileId: string }, { payoutsEnabled: boolean }>(
          getFirebase().functions, "getStripeStatus")({ profileId });
        if (!cancelled) setResult({ payoutsEnabled: res.data.payoutsEnabled });
      } catch {
        if (!cancelled) setResult("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ maxWidth: 560, margin: "40px auto", display: "grid", gap: 16 }}>
      <h1>Payout setup</h1>
      {result === "loading" && <p>Checking your account…</p>}
      {(result === "no-profile" || result === "error") && (
        <p>We couldn&apos;t re-check your account automatically — check your status on the Earnings page.</p>
      )}
      {typeof result === "object" && (
        <p>
          {result.payoutsEnabled
            ? "You're all set — payouts are enabled."
            : "Almost there — Stripe is still verifying your account. This can take a few minutes."}
        </p>
      )}
      <p><a href="/dashboard/earnings">Back to Earnings</a></p>
    </main>
  );
}

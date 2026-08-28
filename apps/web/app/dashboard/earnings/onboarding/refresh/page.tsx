"use client";
import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../src/lib/firebase";
import { readOnboardingProfileId } from "../../../../../src/payments/onboardingRedirect";

// Stripe's refresh_url for account_onboarding — hit when a previously issued
// account link has EXPIRED (Stripe's own expired-link contract: the hosted
// flow redirects here instead of completing, and the fix is simply to mint a
// fresh link and send the browser straight back). Deliberately does NOT
// clear the stashed profileId (see onboardingRedirect.ts) — the eventual
// return_url hit is still the terminal step of this same attempt and needs
// it.
export default function OnboardingRefreshPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Whole body inside the async IIFE, same reason as the return page's
    // effect: a synchronous setState in the effect body (the no-profileId
    // exit) trips react-hooks/set-state-in-effect.
    (async () => {
      const profileId = readOnboardingProfileId();
      if (!profileId) {
        if (!cancelled) setError("We couldn't tell which profile this was for — start payout setup again from the Earnings page.");
        return;
      }
      try {
        const res = await httpsCallable<{ profileId: string }, { url: string }>(
          getFirebase().functions, "createOnboardingLink")({ profileId });
        if (!cancelled) window.location.assign(res.data.url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not restart payout setup.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ maxWidth: 560, margin: "40px auto", display: "grid", gap: 16 }}>
      <h1>Payout setup</h1>
      {!error && <p>Getting a fresh setup link…</p>}
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e" }}>
          {error}
        </p>
      )}
      <p><a href="/dashboard/earnings">Back to Earnings</a></p>
    </main>
  );
}

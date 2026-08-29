"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../src/lib/firebase";
import { clearOnboardingProfileId, readOnboardingProfileId } from "../../../../../src/payments/onboardingRedirect";
import { Button } from "../../../../../src/ui/button";
import { Card, CardContent } from "../../../../../src/ui/card";
import { IconCheck, IconWarning } from "../../../../../src/ui/icons";

// Stripe's return_url for account_onboarding, hit once the musician
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
    // firing synchronously during the effect body: react-hooks/
    // set-state-in-effect flags the latter as a cascading-render hazard.
    (async () => {
      const profileId = readOnboardingProfileId();
      if (!profileId) {
        if (!cancelled) setResult("no-profile");
        return;
      }
      clearOnboardingProfileId(); // one-shot: this page is the terminal step of one onboarding attempt
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
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 sm:py-24">
      <div className="w-full max-w-sm">
        <Button asChild variant="link" className="mb-8 h-auto p-0">
          <Link href="/dashboard/earnings">&larr; Back to Earnings</Link>
        </Button>
        <Card>
          <CardContent className="grid gap-3">
            <h1 className="font-syne text-2xl font-bold text-gk-text">Payout setup</h1>
            {result === "loading" && (
              <p className="font-sora text-sm text-gk-muted">Checking your account…</p>
            )}
            {(result === "no-profile" || result === "error") && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                We couldn&apos;t re-check your account automatically. Check your status on the Earnings page.
              </p>
            )}
            {typeof result === "object" && (
              result.payoutsEnabled ? (
                <p className="flex items-start gap-2 rounded-gk border border-gk-success/40 bg-gk-success/14 px-3.5 py-2.5 font-sora text-sm text-gk-success">
                  <IconCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  You&apos;re all set: payouts are enabled.
                </p>
              ) : (
                <p className="font-sora text-sm text-gk-text">
                  Almost there: Stripe is still verifying your account. This can take a few minutes.
                </p>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

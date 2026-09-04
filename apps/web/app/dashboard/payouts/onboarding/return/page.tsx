"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { callFn } from "../../../../../src/lib/callable";
import { Button } from "../../../../../src/ui/button";
import { Card, CardContent } from "../../../../../src/ui/card";
import { IconCheck, IconWarning } from "../../../../../src/ui/icons";

// SP5c Task 10: createMemberOnboardingLink's return_url (functions/src/
// memberPayouts.ts), hit once the person finishes (or exits) the hosted
// onboarding flow. Mirrors apps/web/app/dashboard/earnings/onboarding/
// return/page.tsx, but with no profileId to recover: getMemberPayoutStatus
// reads the caller's own uid off the auth token, so there is no
// sessionStorage bridge like onboardingRedirect.ts's profile-scoped one.
// getMemberPayoutStatus re-syncs the cached gate flags server-side
// (syncMemberAccountFlags) as a side effect of being called at all, so this
// page's own job is just to surface an immediate, friendly result; the
// dashboard card's own load re-syncs again regardless.
type Result = "loading" | "error" | { payoutsEnabled: boolean };

export default function MemberPayoutsReturnPage() {
  const [result, setResult] = useState<Result>("loading");
  useEffect(() => {
    let cancelled = false;
    // Whole body inside the async IIFE so every setState call is deferred to
    // a callback rather than firing synchronously during the effect body
    // (react-hooks/set-state-in-effect).
    (async () => {
      try {
        const res = await callFn<object, { payoutsEnabled: boolean }>("getMemberPayoutStatus", {});
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
          <Link href="/dashboard#payouts">&larr; Back to dashboard</Link>
        </Button>
        <Card>
          <CardContent className="grid gap-3">
            <h1 className="font-syne text-2xl font-bold text-gk-text">Payout setup</h1>
            {result === "loading" && (
              <p className="font-sora text-sm text-gk-muted">Checking your account…</p>
            )}
            {result === "error" && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                We couldn&apos;t re-check your account automatically. Check your status on the dashboard.
              </p>
            )}
            {typeof result === "object" && (
              result.payoutsEnabled ? (
                <p className="flex items-start gap-2 rounded-gk border border-gk-success/40 bg-gk-success/14 px-3.5 py-2.5 font-sora text-sm text-gk-success">
                  <IconCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Payouts enabled
                </p>
              ) : (
                <p className="font-sora text-sm text-gk-text">Still verifying</p>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

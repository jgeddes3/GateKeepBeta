"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { callFn } from "../../../../../src/lib/callable";
import { Button } from "../../../../../src/ui/button";
import { Card, CardContent } from "../../../../../src/ui/card";
import { IconWarning } from "../../../../../src/ui/icons";

// SP5c Task 10: createMemberOnboardingLink's refresh_url (functions/src/
// memberPayouts.ts), hit when a previously issued account link has EXPIRED
// (Stripe's expired-link contract: the hosted flow redirects here instead
// of completing, and the fix is to mint a fresh link and send the browser
// straight back). Mirrors apps/web/app/dashboard/earnings/onboarding/
// refresh/page.tsx, but with nothing to recover from sessionStorage: the
// callable re-derives everything from the signed-in caller's own uid.
export default function MemberPayoutsRefreshPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Whole body inside the async IIFE, same reason as the return page's
    // effect.
    (async () => {
      try {
        const res = await callFn<object, { url: string }>("createMemberOnboardingLink", {});
        if (!cancelled) window.location.assign(res.data.url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not restart payout setup.");
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
            {!error && <p className="font-sora text-sm text-gk-muted">Getting a fresh setup link…</p>}
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

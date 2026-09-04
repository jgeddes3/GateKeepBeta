"use client";
import { useEffect, useId, useRef, useState } from "react";
import { callFn } from "../lib/callable";
import { formatCents } from "../gigs/GigForms";
import { PayoutHistoryList } from "./PayoutHistoryList";
import {
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, INSTANT_PAYOUT_MIN_CENTS,
  instantFeePreviewCents,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { IconWarning } from "../ui/icons";

// SP5c Task 10: the member (person-scoped) twin of EarningsPanel.tsx's
// musician-profile payouts panel. Same house idiom throughout: "use client",
// callFn(...) (lib/callable.ts) + inline styles, verbatim server-error
// surfacing, busy/error local state. Unlike EarningsPanel there is no admin
// gate here (every signed-in account, fans included, owns its own payout
// setup and cash-out; requestMemberPayout/getMemberPayoutStatus/
// createMemberOnboardingLink, functions/src/memberPayouts.ts, carry no admin
// check of their own either, only "is this the signed-in uid's own doc").

interface MemberPayoutStatus {
  hasAccount: boolean;
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  instantEligible: boolean;
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
  heldCents: number;
}
interface RequestMemberPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors EarningsPanel.tsx's own MAX_PREVIEW_CENTS: keeps an absurd/
// malformed typed amount from reaching instantFeePreviewCents's own
// assertCents and throwing mid-render. The server independently re-enforces
// this; this bound is only to keep the CLIENT from crashing on a bad preview.
const MAX_PREVIEW_CENTS = 2 ** 45;

// Identical to EarningsPanel.tsx's parseDollarsToCents: dollars-string input
// -> whole cents, or null when not a usable amount. UI-only validation, the
// server (requestMemberPayout) is the actual authority.
function parseDollarsToCents(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents < 100 || cents > MAX_PREVIEW_CENTS ? null : cents;
}

export function MemberPayoutsCard({ uid }: { uid: string }) {
  // Mirrors EarningsPanel's own useId() rationale: a literal id would be
  // fine here (this card mounts once per dashboard), but useId keeps the
  // pattern identical between the two panels.
  const amountFieldId = useId();
  const [status, setStatus] = useState<MemberPayoutStatus | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);
  // ONE UUID per cash-out press, same as-built contract EarningsPanel's own
  // requestRef documents: a RETRY of the same press (same method+amount)
  // reuses this id so requestMemberPayout replays rather than double-pays; a
  // changed amount/method (or a press after a completed one) mints a new one.
  const requestRef = useRef<{ id: string; method: "standard" | "instant"; amountCents: number } | null>(null);
  // Hoisted once per render, same as EarningsPanel, so the fee preview label
  // and the Instant-button gating logic can never disagree about what "the
  // typed amount" currently parses to.
  const previewCents = parseDollarsToCents(amount);
  const previewFeeCents = previewCents != null ? instantFeePreviewCents(previewCents) : null;
  const belowInstantMin = previewCents != null && previewCents < INSTANT_PAYOUT_MIN_CENTS;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callFn<object, MemberPayoutStatus>("getMemberPayoutStatus", {});
        if (cancelled) return;
        setStatus(res.data);
        // Default the amount field to the full available balance, but only
        // when the field is still empty (first load, or right after a
        // completed payout cleared it), never clobbering something the user
        // is mid-typing. Same as EarningsPanel.
        setAmount((prev) => (prev === "" && res.data.availableBalanceCents != null)
          ? (res.data.availableBalanceCents / 100).toString() : prev);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
    // uid: reload on a signed-in identity change (this card has no key-based
    // remount at its mount site, unlike ProfilesList/NotificationsList on
    // this same dashboard page).
  }, [uid, reloadKey]);

  const setupPayouts = async () => {
    setOnboardBusy(true);
    setOnboardError(null);
    try {
      const res = await callFn<object, { url: string }>("createMemberOnboardingLink", {});
      // No sessionStorage bridge needed here (unlike onboardingRedirect.ts
      // for the profile flow): the return page has no id to recover, it
      // just re-checks the signed-in caller's own status.
      window.location.assign(res.data.url);
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : "Could not start payout setup.");
      setOnboardBusy(false);
    }
  };

  const submitPayout = async (method: "standard" | "instant") => {
    if (typeof status !== "object") return;
    const amountCents = parseDollarsToCents(amount);
    if (amountCents == null) {
      setPayoutError("Enter at least $1.00.");
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    setPayoutMessage(null);
    try {
      if (!requestRef.current || requestRef.current.method !== method || requestRef.current.amountCents !== amountCents) {
        requestRef.current = { id: crypto.randomUUID(), method, amountCents };
      }
      const res = await callFn<
        { amountCents: number; method: "standard" | "instant"; requestId: string },
        RequestMemberPayoutResult
      >("requestMemberPayout", { amountCents, method, requestId: requestRef.current.id });
      const verb = res.data.replayed ? "Already sent" : "Sent";
      setPayoutMessage(res.data.feeCents > 0
        ? `${verb}: ${formatCents(res.data.netCents)} (fee ${formatCents(res.data.feeCents)}).`
        : `${verb}: ${formatCents(res.data.netCents)}${method === "standard" ? ", arrives in 1-3 business days." : "."}`);
      requestRef.current = null; // done: a later press is a NEW cash-out
      setAmount(""); // re-defaults to the fresh balance once status reloads
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPayoutError(e instanceof Error ? e.message : "Could not send the payout.");
    } finally {
      setPayoutBusy(false);
    }
  };

  return (
    <section id="payouts" className="grid gap-4">
      <div>
        <h2 className="font-syne text-lg font-semibold text-gk-text">Your payouts</h2>
        <p className="mt-1 font-sora text-sm text-gk-muted">Money bands pay you lands here.</p>
      </div>
      {status === "loading" && (
        <div className="grid gap-2" role="status" aria-label="Loading your payouts">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-40" />
        </div>
      )}
      {status === "error" && (
        <p className="flex flex-wrap items-center gap-2 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="shrink-0" aria-hidden="true" />
          Couldn&apos;t load payout status.
          <Button onClick={() => setReloadKey((k) => k + 1)} variant="link" className="h-auto p-0">Retry</Button>
        </p>
      )}
      {typeof status === "object" && (
        <>
          {!status.hasAccount ? (
            <div className="grid gap-2.5">
              <Button onClick={setupPayouts} disabled={onboardBusy} className="w-fit">
                {onboardBusy ? "Redirecting…" : "Set up payouts"}
              </Button>
              {onboardError && (
                <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                  <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {onboardError}
                </p>
              )}
            </div>
          ) : !status.payoutsEnabled ? (
            <p className="flex flex-wrap items-center gap-2 font-sora text-sm text-gk-text">
              Verifying your account
              <Button onClick={() => setReloadKey((k) => k + 1)} variant="link" className="h-auto p-0">Retry</Button>
            </p>
          ) : (
            <div className="grid gap-3">
              <div>
                <p className="font-sora text-sm text-gk-muted">Available balance</p>
                {/* availableBalanceCents null renders "unavailable", never
                    $0.00, same reasoning as EarningsPanel's own comment: a
                    real 0 balance and "we don't know yet" must never look
                    the same. */}
                <p className="mt-0.5 font-syne text-2xl font-bold text-gk-text sm:text-3xl">
                  {status.availableBalanceCents == null ? "Balance unavailable: try again shortly" : formatCents(status.availableBalanceCents)}
                </p>
                {status.availableBalanceCents != null && status.instantAvailableBalanceCents != null
                  && status.instantAvailableBalanceCents !== status.availableBalanceCents && (
                  <p className="mt-0.5 font-sora text-sm text-gk-muted">
                    Instant available: {formatCents(status.instantAvailableBalanceCents)}
                  </p>
                )}
              </div>
              <div className="grid max-w-40 gap-1.5">
                <label htmlFor={amountFieldId} className="font-sora text-sm font-medium text-gk-text">
                  Amount to cash out
                </label>
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="font-sora text-sm text-gk-muted">$</span>
                  <Input id={amountFieldId} type="number" min="1" step="0.01" value={amount}
                    onChange={(e) => { setAmount(e.target.value); setPayoutError(null); }}
                    disabled={payoutBusy || status.availableBalanceCents == null}
                    aria-label="Amount to cash out (dollars)" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => submitPayout("standard")} disabled={payoutBusy} variant="secondary">
                  Standard (free, 1–3 business days)
                </Button>
                <Button onClick={() => submitPayout("instant")}
                  disabled={payoutBusy || !status.instantEligible || belowInstantMin
                    || (previewCents != null && previewFeeCents != null && previewFeeCents >= previewCents)}
                  title={!status.instantEligible ? PAYOUT_INSTANT_INELIGIBLE_MESSAGE
                    : belowInstantMin ? PAYOUT_INSTANT_MIN_MESSAGE : undefined}>
                  {`Instant${previewCents != null && previewFeeCents != null ? ` (fee ${formatCents(previewFeeCents)})` : ""}`}
                </Button>
              </div>
              {payoutError && (
                <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                  <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {payoutError}
                </p>
              )}
              {payoutMessage && (
                <p className="font-sora text-sm text-gk-success">{payoutMessage}</p>
              )}
            </div>
          )}
          {status.heldCents > 0 && (
            <div>
              <p className="font-sora text-sm text-gk-text">Waiting for you: {formatCents(status.heldCents)}</p>
              <p className="mt-0.5 font-sora text-xs text-gk-muted">
                It moves to your balance as soon as your account is verified.
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <h3 className="font-syne text-sm font-semibold text-gk-text">History</h3>
            <PayoutHistoryList scope={{ kind: "user" }} />
          </div>
        </>
      )}
    </section>
  );
}

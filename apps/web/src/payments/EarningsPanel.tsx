"use client";
import { useEffect, useId, useRef, useState } from "react";
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import { rememberOnboardingProfileId } from "./onboardingRedirect";
import {
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, INSTANT_PAYOUT_MIN_CENTS,
  instantFeePreviewCents,
  type PaymentDoc, type StripeStatusResult,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { IconEarnings, IconWarning } from "../ui/icons";

// SP5 Task 14: the musician's payouts surface. House idiom throughout (see
// src/bookings/CancelDialog.tsx): "use client", callFn(...) (lib/callable.ts,
// Task 27) + inline styles, verbatim server-error surfacing, busy/error
// local state.

interface RequestPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors money.ts's assertCents ceiling. Keeps an absurd/malformed typed
// amount from reaching instantFeePreviewCents's own assertCents and throwing
// mid-render (the server independently re-enforces this; this bound is only
// to keep the CLIENT from crashing on a bad preview input).
const MAX_PREVIEW_CENTS = 2 ** 45;

// dollars-string input -> whole cents, or null when not a usable amount.
// UI-only validation: the server is the actual authority (invariant #1: no
// client-supplied amounts drive what's charged/paid; this only shapes what
// the client SENDS as amountCents, which requestPayout independently checks
// against the live balance). The 100-cent floor mirrors requestPayout's own
// ("Cash out at least $1, as a whole number of cents."): a naive `n > 0`
// check let a value that rounds to well under $1 (or even to 0, for a tiny
// fractional-cent typo) sail through as "valid" for both the fee preview and
// the button-enabled state.
function parseDollarsToCents(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents < 100 || cents > MAX_PREVIEW_CENTS ? null : cents;
}

type PaymentRow = PaymentDoc & { id: string; bookingId: string };

// The profile's payment docs across its 50 most-recently-updated bookings as
// the musician side: one onSnapshot on the bookings list (rules-provable:
// musicianProfileId pinned, same shape as BookingInbox's own query), ordered
// by updatedAt desc via the (musicianProfileId ASC, updatedAt DESC)
// composite index that ALREADY EXISTS (SP4 Task 11, see
// firestore.indexes.json), then an n+1 one-shot getDocs per booking's
// payments subcollection (same acceptable n+1 idiom as BookingInbox's
// useRowGigTitle/useNextOccurrence: inbox/earnings scale, not a paginated
// list).
function usePaymentRows(profileId: string): PaymentRow[] {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Bumped on every onSnapshot fire so a late-resolving OLDER fan-out (the
    // Promise.all over a booking's payments subcollections) can never
    // clobber a NEWER one's result: onSnapshot can fire again (a booking
    // updated) before the previous fire's n+1 getDocs calls have all
    // settled, and network timing gives no guarantee the older fire resolves
    // first.
    let generation = 0;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, "bookings"), where("musicianProfileId", "==", profileId),
        orderBy("updatedAt", "desc"), limit(50)),
      async (snap) => {
        const myGeneration = ++generation;
        const perBooking = await Promise.all(snap.docs.map(async (b) => {
          try {
            const paySnap = await getDocs(collection(db, `bookings/${b.id}/payments`));
            // Spread first, id/bookingId set AFTER (last-one-wins, no
            // duplicate-key error): PaymentDoc already carries its own
            // `bookingId` field (== b.id here); overriding it with the
            // known-good b.id means the row's key (below) never depends on
            // trusting a server-written field to match its own parent path.
            return paySnap.docs.map((d) => ({ ...(d.data() as PaymentDoc), id: d.id, bookingId: b.id }));
          } catch {
            return []; // permission-denied/offline on one booking's subcollection: drop it, not the whole panel
          }
        }));
        if (!cancelled && myGeneration === generation) setRows(perBooking.flat());
      },
      () => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; unsubscribe(); };
  }, [profileId]);
  return rows;
}

function PendingSettlementsList({ rows }: { rows: PaymentRow[] }) {
  const pending = rows
    .filter((r) => r.settlement.status === "pending" || r.settlement.status === "past_due")
    .sort((a, b) => a.occurrenceStartsAt - b.occurrenceStartsAt);
  if (pending.length === 0) {
    return (
      <p className="font-sora text-sm text-gk-muted">
        Nothing pending right now. A confirmed date shows up here once it&apos;s played and waiting to settle.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {pending.map((r) => (
        <li
          key={`${r.bookingId}:${r.id}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5"
        >
          <span className="font-sora text-sm text-gk-text">{formatGigDateTime(r.occurrenceStartsAt)}</span>
          {/* Status chip (spec 4): past_due is the one genuinely urgent
              state here (money that should be settling is stalled on the
              CURATOR's side); an ordinary pending settlement is expected,
              not cautionary, so it stays neutral.
              Review round 1: whitespace-normal (Badge's own base class is
              nowrap). "pays out ~{date}" can run long enough to overflow a
              360px viewport as one unbroken line; this lets it wrap. */}
          <Badge
            variant={r.settlement.status === "past_due" ? "destructive" : "secondary"}
            className="whitespace-normal text-right"
          >
            {r.settlement.status === "past_due"
              ? "curator payment delayed"
              : `pays out ~${r.settlement.settleAfter != null ? formatGigDateTime(r.settlement.settleAfter) : "after the gig"}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// History caps at 20, same as BookingInbox's own history list (SP4 Task 10):
// a generous soft cap so an unusually busy profile's Earnings page stays
// bounded without pagination UI yet.
const HISTORY_LIMIT = 20;

function HistoryList({ rows }: { rows: PaymentRow[] }) {
  const history = rows
    .filter((r) => r.transfer.status === "transferred" || r.deposit.status === "forfeited")
    .sort((a, b) => (b.transfer.transferredAt ?? b.updatedAt) - (a.transfer.transferredAt ?? a.updatedAt))
    .slice(0, HISTORY_LIMIT);
  if (history.length === 0) {
    return (
      <p className="flex items-start gap-2 font-sora text-sm text-gk-muted">
        <IconEarnings size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        No payout history yet. Play a gig and your first payout lands here.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {history.map((r) => (
        <li
          key={`${r.bookingId}:${r.id}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5"
        >
          <span className="font-sora text-sm text-gk-text">{formatGigDateTime(r.occurrenceStartsAt)}</span>
          {/* Review round 1: whitespace-normal (Badge's own base class is
              nowrap). The worst case here is a forfeited deposit AND a
              transfer both landing on the same row, which joins two full
              money sentences (a "Forfeited deposit..." clause plus a
              "Paid $Y" clause) into one string that can easily outrun a
              360px viewport as one unbroken line, so this lets it wrap
              instead of forcing horizontal overflow. */}
          <Badge variant="success" className="whitespace-normal text-right">
            {r.deposit.status === "forfeited" && `Forfeited deposit: received 100% (${formatCents(r.deposit.sliceCents)})`}
            {r.deposit.status === "forfeited" && r.transfer.status === "transferred" && "; "}
            {r.transfer.status === "transferred" && r.transfer.amountCents != null
              && `Paid ${formatCents(r.transfer.amountCents)}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function EarningsPanel({ profileId, name }: { profileId: string; name: string }) {
  // The earnings page mounts one EarningsPanel per musician profile the
  // signed-in account has (MusicianProfilesList), so a literal
  // "earnings-cashout-amount" id would collide across two-plus panels on
  // the same page; useId() gives each mounted instance its own.
  const amountFieldId = useId();
  const [status, setStatus] = useState<StripeStatusResult | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);
  // ONE UUID per cash-out press (as-built contract #1 in the payments plan,
  // Task 13's correction): a RETRY of the same press (same method+amount)
  // reuses this id so requestPayout replays rather than double-pays; a
  // changed amount/method (or a press after a completed one) is a NEW
  // cash-out and mints its own id.
  const requestRef = useRef<{ id: string; method: "standard" | "instant"; amountCents: number } | null>(null);
  const rows = usePaymentRows(profileId);
  // Hoisted once per render (not recomputed inline at each use site) so the
  // fee preview label and the Instant-button gating logic below can never
  // disagree about what "the typed amount" currently parses to.
  const previewCents = parseDollarsToCents(amount);
  const previewFeeCents = previewCents != null ? instantFeePreviewCents(previewCents) : null;
  // Owner ruling (M4): the $10 instant minimum, mirrored client-side so the
  // Instant button disables (with an explaining tooltip) below it rather than
  // letting the server bounce it. requestPayout is the actual authority; this
  // only pre-empts the round trip. A standard payout stays available below $10.
  const belowInstantMin = previewCents != null && previewCents < INSTANT_PAYOUT_MIN_CENTS;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callFn<{ profileId: string }, StripeStatusResult>("getStripeStatus", { profileId });
        if (cancelled) return;
        setStatus(res.data);
        // Default the amount field to the full available balance, but only
        // when the field is still empty (first load, or right after a
        // completed payout cleared it), never clobbering something the user
        // is mid-typing.
        setAmount((prev) => (prev === "" && res.data.availableBalanceCents != null)
          ? (res.data.availableBalanceCents / 100).toString() : prev);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [profileId, reloadKey]);

  const setupPayouts = async () => {
    setOnboardBusy(true);
    setOnboardError(null);
    try {
      const res = await callFn<{ profileId: string }, { url: string }>("createOnboardingLink", { profileId });
      // Stripe's return/refresh URLs carry no query params of their own
      // (see onboardingRedirect.ts): stash the profile here first so the
      // return page can re-sync THIS profile's status.
      rememberOnboardingProfileId(profileId);
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
      // Minted INSIDE the try (not before it): crypto.randomUUID() throws in
      // a non-secure-context browser, and minting it ahead of the try would
      // leave payoutBusy stuck true forever (the throw would skip both the
      // catch below and the finally that resets it).
      if (!requestRef.current || requestRef.current.method !== method || requestRef.current.amountCents !== amountCents) {
        requestRef.current = { id: crypto.randomUUID(), method, amountCents };
      }
      const res = await callFn<
        { profileId: string; amountCents: number; method: "standard" | "instant"; requestId: string },
        RequestPayoutResult
      >("requestPayout",
        { profileId, amountCents, method, requestId: requestRef.current.id });
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
    <section className="grid gap-4 border-t border-gk-border pt-6">
      <h2 className="font-syne text-lg font-semibold text-gk-text">{name}</h2>
      {status === "loading" && (
        <div className="grid gap-2" role="status" aria-label={`Loading ${name}'s earnings`}>
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
          {status.delinquent && (
            <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-destructive/40 bg-gk-destructive/14 px-3.5 py-2.5 font-sora text-sm text-gk-destructive">
              <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              A booking you&apos;re part of has an overdue curator payment.
            </p>
          )}
          {!(status.hasAccount && status.payoutsEnabled) ? (
            <div className="grid gap-2.5">
              <p className="font-sora text-sm text-gk-text">Set up payouts to get paid for your bookings.</p>
              <Button onClick={setupPayouts} disabled={onboardBusy} className="w-fit">
                {onboardBusy ? "Redirecting…" : "Set up payouts"}
              </Button>
              {onboardError && (
                <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                  <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {onboardError}
                </p>
              )}
              <p className="font-sora text-xs text-gk-muted">
                Your first payout may be held for about 7 days while Stripe verifies your account.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              <div>
                <p className="font-sora text-sm text-gk-muted">Available balance</p>
                {/* availableBalanceCents null renders "unavailable", never
                    $0.00 (binding: see this file's own MAX_PREVIEW_CENTS/
                    parseDollarsToCents comments for why a real 0 balance and
                    "we don't know yet" must never look the same). */}
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
          <div className="grid gap-2">
            <h3 className="font-syne text-sm font-semibold text-gk-text">Pending settlements</h3>
            <PendingSettlementsList rows={rows} />
          </div>
          <div className="grid gap-2">
            <h3 className="font-syne text-sm font-semibold text-gk-text">History</h3>
            <HistoryList rows={rows} />
          </div>
        </>
      )}
    </section>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import { instantFeePreviewCents } from "./fees";
import { rememberOnboardingProfileId } from "./onboardingRedirect";
import type { StripeStatusResult } from "./types";
import { PAYOUT_INSTANT_INELIGIBLE_MESSAGE, type PaymentDoc } from "@gatekeep/shared";

// SP5 Task 14 — the musician's payouts surface. House idiom throughout (see
// src/bookings/CancelDialog.tsx): "use client", httpsCallable + inline
// styles, verbatim server-error surfacing, busy/error local state.

interface RequestPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors money.ts's assertCents ceiling — keeps an absurd/malformed typed
// amount from reaching instantFeePreviewCents's own assertCents and throwing
// mid-render (the server independently re-enforces this; this bound is only
// to keep the CLIENT from crashing on a bad preview input).
const MAX_PREVIEW_CENTS = 2 ** 45;

// dollars-string input -> whole cents, or null when not a usable amount.
// UI-only validation — the server is the actual authority (invariant #1: no
// client-supplied amounts drive what's charged/paid; this only shapes what
// the client SENDS as amountCents, which requestPayout independently checks
// against the live balance). The 100-cent floor mirrors requestPayout's own
// ("Cash out at least $1, as a whole number of cents.") — a naive `n > 0`
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
// the musician side — one onSnapshot on the bookings list (rules-provable:
// musicianProfileId pinned, same shape as BookingInbox's own query), ordered
// by updatedAt desc via the (musicianProfileId ASC, updatedAt DESC)
// composite index that ALREADY EXISTS (SP4 Task 11 — see
// firestore.indexes.json), then an n+1 one-shot getDocs per booking's
// payments subcollection (same acceptable n+1 idiom as BookingInbox's
// useRowGigTitle/useNextOccurrence — inbox/earnings scale, not a paginated
// list).
function usePaymentRows(profileId: string): PaymentRow[] {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Bumped on every onSnapshot fire so a late-resolving OLDER fan-out (the
    // Promise.all over a booking's payments subcollections) can never
    // clobber a NEWER one's result — onSnapshot can fire again (a booking
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
            // duplicate-key error) — PaymentDoc already carries its own
            // `bookingId` field (== b.id here); overriding it with the
            // known-good b.id means the row's key (below) never depends on
            // trusting a server-written field to match its own parent path.
            return paySnap.docs.map((d) => ({ ...(d.data() as PaymentDoc), id: d.id, bookingId: b.id }));
          } catch {
            return []; // permission-denied/offline on one booking's subcollection — drop it, not the whole panel
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
  if (pending.length === 0) return <p style={{ color: "#666" }}>Nothing pending.</p>;
  return (
    <ul>
      {pending.map((r) => (
        <li key={`${r.bookingId}:${r.id}`}>
          {formatGigDateTime(r.occurrenceStartsAt)}
          {" — "}
          {r.settlement.status === "past_due"
            ? "curator payment delayed"
            : `pays out ~${r.settlement.settleAfter != null ? formatGigDateTime(r.settlement.settleAfter) : "after the gig"}`}
        </li>
      ))}
    </ul>
  );
}

// History caps at 20, same as BookingInbox's own history list (SP4 Task 10) —
// a generous soft cap so an unusually busy profile's Earnings page stays
// bounded without pagination UI yet.
const HISTORY_LIMIT = 20;

function HistoryList({ rows }: { rows: PaymentRow[] }) {
  const history = rows
    .filter((r) => r.transfer.status === "transferred" || r.deposit.status === "forfeited")
    .sort((a, b) => (b.transfer.transferredAt ?? b.updatedAt) - (a.transfer.transferredAt ?? a.updatedAt))
    .slice(0, HISTORY_LIMIT);
  if (history.length === 0) return <p style={{ color: "#666" }}>No payout history yet.</p>;
  return (
    <ul>
      {history.map((r) => (
        <li key={`${r.bookingId}:${r.id}`}>
          {formatGigDateTime(r.occurrenceStartsAt)}
          {" — "}
          {r.deposit.status === "forfeited" && `Forfeited deposit — received 100% (${formatCents(r.deposit.sliceCents)})`}
          {r.deposit.status === "forfeited" && r.transfer.status === "transferred" && "; "}
          {r.transfer.status === "transferred" && r.transfer.amountCents != null
            && `Paid ${formatCents(r.transfer.amountCents)}`}
        </li>
      ))}
    </ul>
  );
}

export function EarningsPanel({ profileId, name }: { profileId: string; name: string }) {
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
  // changed amount/method — or a press after a completed one — is a NEW
  // cash-out and mints its own id.
  const requestRef = useRef<{ id: string; method: "standard" | "instant"; amountCents: number } | null>(null);
  const rows = usePaymentRows(profileId);
  // Hoisted once per render (not recomputed inline at each use site) so the
  // fee preview label and the Instant-button gating logic below can never
  // disagree about what "the typed amount" currently parses to.
  const previewCents = parseDollarsToCents(amount);
  const previewFeeCents = previewCents != null ? instantFeePreviewCents(previewCents) : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await httpsCallable<{ profileId: string }, StripeStatusResult>(
          getFirebase().functions, "getStripeStatus")({ profileId });
        if (cancelled) return;
        setStatus(res.data);
        // Default the amount field to the full available balance — but only
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
      const res = await httpsCallable<{ profileId: string }, { url: string }>(
        getFirebase().functions, "createOnboardingLink")({ profileId });
      // Stripe's return/refresh URLs carry no query params of their own
      // (see onboardingRedirect.ts) — stash the profile here first so the
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
      const res = await httpsCallable<
        { profileId: string; amountCents: number; method: "standard" | "instant"; requestId: string },
        RequestPayoutResult
      >(getFirebase().functions, "requestPayout")(
        { profileId, amountCents, method, requestId: requestRef.current.id });
      const verb = res.data.replayed ? "Already sent" : "Sent";
      setPayoutMessage(res.data.feeCents > 0
        ? `${verb} — ${formatCents(res.data.netCents)} (fee ${formatCents(res.data.feeCents)}).`
        : `${verb} — ${formatCents(res.data.netCents)}${method === "standard" ? ", arrives in 1-3 business days." : "."}`);
      requestRef.current = null; // done — a later press is a NEW cash-out
      setAmount(""); // re-defaults to the fresh balance once status reloads
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPayoutError(e instanceof Error ? e.message : "Could not send the payout.");
    } finally {
      setPayoutBusy(false);
    }
  };

  return (
    <section style={{ borderTop: "1px solid #eee", paddingTop: 24, display: "grid", gap: 12 }}>
      <h2>{name}</h2>
      {status === "loading" && <p>Loading…</p>}
      {status === "error" && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e" }}>
          Couldn&apos;t load payout status.{" "}
          <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </p>
      )}
      {typeof status === "object" && (
        <>
          {status.delinquent && (
            <p style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12, color: "#991b1b", margin: 0 }}>
              A booking you&apos;re part of has an overdue curator payment.
            </p>
          )}
          {!(status.hasAccount && status.payoutsEnabled) ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ margin: 0 }}>Set up payouts to get paid for your bookings.</p>
              <div>
                <button onClick={setupPayouts} disabled={onboardBusy}>
                  {onboardBusy ? "Redirecting…" : "Set up payouts"}
                </button>
              </div>
              {onboardError && (
                <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
                  {onboardError}
                </p>
              )}
              <p style={{ margin: 0, fontSize: 13, color: "#666" }}>
                Your first payout may be held for about 7 days while Stripe verifies your account.
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <p style={{ margin: 0, fontSize: 13, color: "#666" }}>Available balance</p>
                <p style={{ margin: "2px 0 0", fontSize: 28, fontWeight: 700 }}>
                  {status.availableBalanceCents == null ? "Balance unavailable — try again shortly" : formatCents(status.availableBalanceCents)}
                </p>
                {status.availableBalanceCents != null && status.instantAvailableBalanceCents != null
                  && status.instantAvailableBalanceCents !== status.availableBalanceCents && (
                  <p style={{ margin: "2px 0 0", fontSize: 13, color: "#666" }}>
                    Instant available: {formatCents(status.instantAvailableBalanceCents)}
                  </p>
                )}
              </div>
              <div>
                <label>
                  Amount to cash out{" "}
                  <input type="number" min="1" step="0.01" value={amount}
                    onChange={(e) => { setAmount(e.target.value); setPayoutError(null); }}
                    disabled={payoutBusy || status.availableBalanceCents == null}
                    style={{ width: 100 }} aria-label="Amount to cash out (dollars)" />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => submitPayout("standard")} disabled={payoutBusy}>
                  Standard (free, 1–3 business days)
                </button>
                <button onClick={() => submitPayout("instant")}
                  disabled={payoutBusy || !status.instantEligible
                    || (previewCents != null && previewFeeCents != null && previewFeeCents >= previewCents)}
                  title={!status.instantEligible ? PAYOUT_INSTANT_INELIGIBLE_MESSAGE : undefined}>
                  {`Instant${previewCents != null && previewFeeCents != null ? ` — fee ${formatCents(previewFeeCents)}` : ""}`}
                </button>
              </div>
              {payoutError && (
                <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
                  {payoutError}
                </p>
              )}
              {payoutMessage && (
                <p style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 12, color: "#166534", margin: 0 }}>
                  {payoutMessage}
                </p>
              )}
            </div>
          )}
          <div>
            <h3>Pending settlements</h3>
            <PendingSettlementsList rows={rows} />
          </div>
          <div>
            <h3>History</h3>
            <HistoryList rows={rows} />
          </div>
        </>
      )}
    </section>
  );
}

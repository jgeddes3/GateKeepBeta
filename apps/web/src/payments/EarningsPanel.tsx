"use client";
import { useEffect, useRef, useState } from "react";
import { collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import { instantFeePreviewCents } from "./fees";
import { rememberOnboardingProfileId } from "./onboardingRedirect";
import type { PaymentDoc } from "@gatekeep/shared";

// SP5 Task 14 — the musician's payouts surface. House idiom throughout (see
// src/bookings/CancelDialog.tsx): "use client", httpsCallable + inline
// styles, verbatim server-error surfacing, busy/error local state.

export interface StripeStatusResult {
  hasCard: boolean; cardBrand: string | null; cardLast4: string | null;
  hasAccount: boolean; transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  delinquent: boolean;
  // As-built correction (Task 13): 0 means "asked, nothing there"; null means
  // "Stripe couldn't be read just now" — MUST render as "balance unavailable",
  // never $0.00.
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
}
interface RequestPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors money.ts's assertCents ceiling — keeps an absurd/malformed typed
// amount from reaching instantFeePreviewCents's own assertCents and throwing
// mid-render (the server independently re-enforces this; this bound is only
// to keep the CLIENT from crashing on a bad preview input).
const MAX_PREVIEW_CENTS = 2 ** 45;

// dollars-string input -> whole cents, or null when not a usable positive
// amount. UI-only validation — the server is the actual authority (invariant
// #1: no client-supplied amounts drive what's charged/paid; this only shapes
// what the client SENDS as amountCents, which requestPayout independently
// checks against the live balance).
function parseDollarsToCents(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > MAX_PREVIEW_CENTS ? null : cents;
}

type PaymentRow = PaymentDoc & { id: string };

// The profile's payment docs across every booking it's the musician side of
// — one onSnapshot on the bookings list (rules-provable: musicianProfileId
// pinned, same shape as BookingInbox's own query), then an n+1 one-shot
// getDocs per booking's payments subcollection (same acceptable n+1 idiom as
// BookingInbox's useRowGigTitle/useNextOccurrence — inbox/earnings scale,
// not a paginated list). No orderBy on the bookings query on purpose: adding
// one here would need a NEW composite index (musicianProfileId, updatedAt)
// that nothing else in the app defines yet; a plain equality filter is
// covered by Firestore's automatic single-field index, and results are
// sorted client-side below instead.
function usePaymentRows(profileId: string): PaymentRow[] {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, "bookings"), where("musicianProfileId", "==", profileId)),
      async (snap) => {
        const perBooking = await Promise.all(snap.docs.map(async (b) => {
          try {
            const paySnap = await getDocs(collection(db, `bookings/${b.id}/payments`));
            // PaymentDoc already carries its own `bookingId` field (== b.id
            // here) — the spread supplies it, no need to set it separately.
            return paySnap.docs.map((d) => ({ id: d.id, ...(d.data() as PaymentDoc) }));
          } catch {
            return []; // permission-denied/offline on one booking's subcollection — drop it, not the whole panel
          }
        }));
        if (!cancelled) setRows(perBooking.flat());
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
        <li key={r.id}>
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

function HistoryList({ rows }: { rows: PaymentRow[] }) {
  const history = rows
    .filter((r) => r.transfer.status === "transferred" || r.deposit.status === "forfeited")
    .sort((a, b) => (b.transfer.transferredAt ?? b.updatedAt) - (a.transfer.transferredAt ?? a.updatedAt));
  if (history.length === 0) return <p style={{ color: "#666" }}>No payout history yet.</p>;
  return (
    <ul>
      {history.map((r) => (
        <li key={r.id}>
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
      setPayoutError("Enter a whole-dollar amount greater than $0.");
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    setPayoutMessage(null);
    if (!requestRef.current || requestRef.current.method !== method || requestRef.current.amountCents !== amountCents) {
      requestRef.current = { id: crypto.randomUUID(), method, amountCents };
    }
    try {
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
              </div>
              <div>
                <label>
                  Amount to cash out{" "}
                  <input type="number" min="0.01" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)} disabled={payoutBusy}
                    style={{ width: 100 }} aria-label="Amount to cash out (dollars)" />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => submitPayout("standard")} disabled={payoutBusy}>
                  Standard (free, 1–3 business days)
                </button>
                <button onClick={() => submitPayout("instant")} disabled={payoutBusy || !status.instantEligible}
                  title={!status.instantEligible ? "Instant payouts need an eligible debit card on your Stripe account." : undefined}>
                  {(() => {
                    const preview = parseDollarsToCents(amount);
                    return `Instant${preview != null ? ` — fee ${formatCents(instantFeePreviewCents(preview))}` : ""}`;
                  })()}
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

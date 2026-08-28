"use client";
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import { useRole, useOccurrences } from "../bookings/BookingThread";
import { SaveCardModal } from "./SaveCardModal";
import { TrueUpForm } from "./TrueUpForm";
import { PayPastDueButton } from "./PayPastDueButton";
import type { StripeStatusResult } from "./types";
import {
  SETTLEMENT_RETRY_OFFSETS_MS, resolveFeePolicy,
  type BookingRequestDoc, type PaymentDoc,
} from "@gatekeep/shared";

// SP5 Task 15 — the booking detail page's money surface: subscribes to
// bookings/{id}/payments (rules permit either side's members + admins — see
// firestore.rules' Sub-project 5 section) and renders one row per occurrence
// plus a card-on-file row and a totals footer. Curator-side (and dual
// "both") members get the actions (report actuals, pay past due, update the
// card); musicians see the same rows read-only, musician-framed.

// Mirrors functions/src/paymentsCore.ts's DEPOSIT_EXHAUSTED_ATTEMPTS
// (SETTLEMENT_RETRY_OFFSETS_MS.length retries, plus the original attempt) —
// that constant is functions-only, so this is the SAME derivation from the
// one shared constant it's actually built from, not a second hand-copied
// number that could drift from it.
const DEPOSIT_EXHAUSTED_ATTEMPTS = SETTLEMENT_RETRY_OFFSETS_MS.length + 1;

type Row = PaymentDoc & { id: string };

function usePaymentRows(bookingId: string): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    const unsub = onSnapshot(collection(db, `bookings/${bookingId}/payments`),
      (snap) => setRows(
        snap.docs.map((d) => ({ ...(d.data() as PaymentDoc), id: d.id }))
          .sort((a, b) => a.occurrenceStartsAt - b.occurrenceStartsAt)),
      () => setRows([]));
    return () => unsub();
  }, [bookingId]);
  return rows;
}

type RowKind =
  | "forfeited" | "paid" | "refunded" | "waived"
  | "settlementPastDue" | "depositPastDue" | "settlementPending"
  | "depositHeld" | "depositUnpaid";

// Precedence, terminal-first: a row can only ever be in ONE of these at a
// time in steady state, but the ordering matters for the brief windows where
// more than one condition is technically true (e.g. a *_pending transient
// state alongside a settlement that hasn't moved yet).
function rowKind(row: Row): RowKind {
  if (row.deposit.status === "forfeited" || row.deposit.status === "forfeit_pending") return "forfeited";
  if (row.settlement.status === "paid") return "paid";
  if (row.deposit.status === "refunded" || row.deposit.status === "refund_pending") return "refunded";
  if (row.settlement.status === "waived") return "waived";
  if (row.settlement.status === "past_due") return "settlementPastDue";
  // An exhausted BIRTH deposit — payPastDue's OTHER debt shape (see its
  // header): no settlement is past_due yet, but the deposit's own retry
  // schedule ran out and the curator is (or is about to be) delinquent over
  // it. Without surfacing this, a curator whose only debt is a deposit would
  // have no way to find the "Pay now" button that clears the gate at all.
  if (row.deposit.status === "unpaid" && (row.deposit.depositAttempts ?? 0) >= DEPOSIT_EXHAUSTED_ATTEMPTS
    && (row.settlement.status === "not_due" || row.settlement.status === "pending")) {
    return "depositPastDue";
  }
  if (row.settlement.status === "pending") return "settlementPending";
  if (row.deposit.status === "held" || row.deposit.status === "applied") return "depositHeld";
  return "depositUnpaid";
}

function rowLabel(kind: RowKind, row: Row, isCuratorSide: boolean): string {
  const dateLabel = formatGigDateTime(row.occurrenceStartsAt);
  switch (kind) {
    case "forfeited":
      return isCuratorSide
        ? `Forfeited — ${formatCents(row.deposit.sliceCents)} paid to the musician`
        // Same copy EarningsPanel's HistoryList already uses for the
        // identical case — kept byte-identical so a musician sees the same
        // sentence on both surfaces.
        : `Forfeited deposit — received 100% (${formatCents(row.deposit.sliceCents)})`;
    case "paid": {
      const totalCents = (row.settlement.computedCents ?? 0) + (row.settlement.feeShareCents ?? 0) + (row.settlement.lateFeeCents ?? 0);
      return isCuratorSide
        ? `Paid — ${formatCents(totalCents)}`
        : (row.transfer.amountCents != null ? `Paid ${formatCents(row.transfer.amountCents)}` : "Paid");
    }
    case "refunded": return "Refunded";
    case "waived": return "Waived — nothing owed on this date";
    case "settlementPastDue": return isCuratorSide ? "Past due — pay now" : "Curator payment delayed";
    case "depositPastDue": return isCuratorSide ? "Deposit past due — pay now" : "Payment delayed";
    case "settlementPending": return isCuratorSide ? `Settles ${dateLabel}` : `Pays out ~${dateLabel}`;
    case "depositHeld": return isCuratorSide ? "Deposit held" : "Deposit held in escrow";
    case "depositUnpaid": return "Charges when the date is confirmed";
    default: return "";
  }
}

export function PaymentsPanel({ bookingId, uid }: { bookingId: string; uid: string }) {
  const [booking, setBooking] = useState<BookingRequestDoc | "loading" | "unavailable">("loading");
  const [openTrueUpFor, setOpenTrueUpFor] = useState<string | null>(null);
  const [showSaveCard, setShowSaveCard] = useState(false);
  const [stripeStatus, setStripeStatus] = useState<StripeStatusResult | "loading" | "error">("loading");
  const [stripeReloadKey, setStripeReloadKey] = useState(0);

  useEffect(() => {
    const unsub = onSnapshot(doc(getFirebase().db, "bookings", bookingId),
      (s) => setBooking(s.exists() ? (s.data() as BookingRequestDoc) : "unavailable"),
      () => setBooking("unavailable"));
    return unsub;
  }, [bookingId]);

  const musicianProfileId = booking !== "loading" && booking !== "unavailable" ? booking.musicianProfileId : undefined;
  const curatorProfileId = booking !== "loading" && booking !== "unavailable" ? booking.curatorProfileId : undefined;
  // Hooks run unconditionally, every render, in the same order — same rule
  // BookingThread itself follows; the early returns below happen AFTER.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const occurrences = useOccurrences(bookingId);
  const rows = usePaymentRows(bookingId);
  const isCuratorSide = role === "curator" || role === "both";

  useEffect(() => {
    if (!isCuratorSide || !curatorProfileId) return;
    let cancelled = false;
    // No synchronous setStripeStatus("loading") here (react-hooks/set-state
    // -in-effect) — same idiom as EarningsPanel's identical status effect:
    // the initial useState("loading") already covers first mount, and a
    // reload just leaves the PREVIOUS status on screen until the new one
    // resolves, rather than flashing back to "loading".
    httpsCallable<{ profileId: string }, StripeStatusResult>(getFirebase().functions, "getStripeStatus")({ profileId: curatorProfileId })
      .then((res) => { if (!cancelled) setStripeStatus(res.data); })
      .catch(() => { if (!cancelled) setStripeStatus("error"); });
    return () => { cancelled = true; };
  }, [isCuratorSide, curatorProfileId, stripeReloadKey]);

  if (booking === "loading" || booking === "unavailable" || role === "loading" || role === "none") return null;
  // Nothing to show before acceptBooking's saga has staged the payments
  // subcollection at all (an "open"/negotiating booking) — no empty panel.
  if (rows.length === 0) return null;

  const durationByGigId = new Map(occurrences.map((o) => [o.id, o.durationMinutes]));
  const feePolicy = resolveFeePolicy(booking.feePolicy);
  const amountCents = booking.acceptedTerms?.amountCents ?? 0;
  const songCount = booking.acceptedTerms?.expectedQuantity ?? null;

  let heldCents = 0, paidCents = 0, feesCents = 0;
  for (const r of rows) {
    if (r.deposit.status === "held" || r.deposit.status === "applied") {
      heldCents += r.deposit.sliceCents;
      paidCents += r.deposit.sliceCents + r.deposit.feeShareCents;
      feesCents += r.deposit.feeShareCents;
    }
    if (r.settlement.status === "paid") {
      paidCents += (r.settlement.computedCents ?? 0) + (r.settlement.feeShareCents ?? 0) + (r.settlement.lateFeeCents ?? 0);
      feesCents += r.settlement.feeShareCents ?? 0;
    }
  }

  return (
    <section style={{ borderTop: "1px solid #eee", paddingTop: 24, display: "grid", gap: 16 }}>
      <h2>Payments</h2>

      {isCuratorSide && curatorProfileId && (
        <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          {showSaveCard ? (
            <SaveCardModal profileId={curatorProfileId}
              onSaved={() => { setShowSaveCard(false); setStripeReloadKey((k) => k + 1); }}
              onClose={() => setShowSaveCard(false)} />
          ) : stripeStatus === "loading" ? (
            <p style={{ margin: 0, color: "#666" }}>Loading card status…</p>
          ) : stripeStatus === "error" ? (
            <p style={{ margin: 0, color: "#92400e" }}>
              Couldn&apos;t load your card status.{" "}
              <button onClick={() => setStripeReloadKey((k) => k + 1)}>Retry</button>
            </p>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span>
                {stripeStatus.hasCard
                  ? `Card on file: ${stripeStatus.cardBrand ?? "card"} •••• ${stripeStatus.cardLast4 ?? "----"}`
                  : "No card on file"}
              </span>
              <button onClick={() => setShowSaveCard(true)}>{stripeStatus.hasCard ? "Update card" : "Add a card"}</button>
            </div>
          )}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 10 }}>
        {rows.map((row) => {
          const kind = rowKind(row);
          return (
            <li key={row.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>{formatGigDateTime(row.occurrenceStartsAt)}</span>
                <span>{rowLabel(kind, row, isCuratorSide)}</span>
              </div>
              {isCuratorSide && (kind === "settlementPastDue" || kind === "depositPastDue") && (
                <PayPastDueButton bookingId={bookingId} gigId={row.id} onDone={() => setStripeReloadKey((k) => k + 1)} />
              )}
              {isCuratorSide && kind === "settlementPending" && booking.structure !== "perSet" && (
                openTrueUpFor === row.id ? (
                  <TrueUpForm
                    bookingId={bookingId} gigId={row.id} structure={booking.structure}
                    amountCents={amountCents} feePolicy={feePolicy}
                    durationMinutes={durationByGigId.get(row.id) ?? 0} songCount={songCount}
                    current={row.settlement.trueUp}
                    onDone={() => setOpenTrueUpFor(null)} onCancel={() => setOpenTrueUpFor(null)}
                  />
                ) : (
                  <button onClick={() => setOpenTrueUpFor(row.id)} style={{ width: "fit-content", fontSize: 13 }}>
                    Report actuals
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>

      <div style={{ borderTop: "1px solid #eee", paddingTop: 10 }}>
        <p style={{ margin: 0 }}>Held in escrow: {formatCents(heldCents)}</p>
        <p style={{ margin: 0 }}>Total paid so far: {formatCents(paidCents)} (includes {formatCents(feesCents)} in service fees)</p>
      </div>
    </section>
  );
}

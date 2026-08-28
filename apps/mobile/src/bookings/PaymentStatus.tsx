import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime, Badge } from "../gigs/GigForms";
import { useRole } from "./BookingThread";
import {
  SETTLEMENT_RETRY_OFFSETS_MS,
  type BookingRequestDoc, type DepositStatus, type PaymentDoc,
} from "@gatekeep/shared";

// SP5 Task 16 — mobile's READ-ONLY money surfaces. Two components:
//
//  * PaymentStatus — the per-occurrence status chips for one booking,
//    mounted under BookingThread by app/booking/[bookingId].tsx. An RN port
//    of apps/web/src/payments/PaymentsPanel.tsx's row-state mapping (its
//    rowKind/rowLabel and its totals accounting, INCLUDING that panel's
//    review-round fixes) with every ACTION stripped: no save-card row, no
//    "Report actuals", no "Pay now". Mobile ships read-only this
//    sub-project (spec §1, "Platforms") — native payment sheets need
//    @stripe/stripe-react-native and a new EAS dev build, which is sub-5b.
//  * EarningsCard — the musician dashboard's balance headline
//    (getStripeStatus), a strict subset of web's EarningsPanel with the
//    cash-out/onboarding controls replaced by "manage payouts on the web".
//
// Both live in this one file because the plan's Task 16 file list creates
// exactly one mobile source file, and they are the same thing from the two
// sides: what SP5's money engine looks like when you can only LOOK at it.

// Mirrors functions/src/paymentsCore.ts's DEPOSIT_EXHAUSTED_ATTEMPTS the same
// way web's PaymentsPanel does — derived from the one shared constant it is
// actually built from (SETTLEMENT_RETRY_OFFSETS_MS.length retries plus the
// original attempt), never a third hand-copied number.
const DEPOSIT_EXHAUSTED_ATTEMPTS = SETTLEMENT_RETRY_OFFSETS_MS.length + 1;

// Byte-identical to PaymentsPanel's own set (which in turn mirrors
// paymentsCore.ts's functions-only PAID_DEPOSIT_STATUSES): every deposit
// status where the curator's card was actually charged and the money hasn't
// come back to them — held/applied (escrow, then released into a
// settlement), forfeit_pending/forfeited (the curator still paid; only the
// DESTINATION changed) and refund_pending (charged, refund not yet
// completed).
const PAID_DEPOSIT_STATUSES = new Set<DepositStatus>([
  "held", "applied", "forfeit_pending", "forfeited", "refund_pending",
]);

type Row = PaymentDoc & { id: string };

// Same subscription web's PaymentsPanel uses, under the same rule: the
// bookings/{id}/payments read rule (firestore.rules' Sub-project 5 section)
// grants either side's members + admins, and a LIST scoped under one
// booking path is provable because the rule's get()s pin to the bookingId
// path segment. A permission-denied here (an observer/admin-less stranger)
// collapses to an empty list, which renders nothing at all.
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

// Precedence, terminal-first — copied from web's PaymentsPanel deliberately
// unchanged, including its ordering rationale: a row is only ever in ONE of
// these in steady state, but the order matters for the brief windows where
// more than one condition is technically true (a *_pending transient
// alongside a settlement that hasn't moved yet). Any change here must land
// on BOTH platforms or a musician sees a different status for the same date
// depending which app they opened.
function rowKind(row: Row): RowKind {
  if (row.deposit.status === "forfeited" || row.deposit.status === "forfeit_pending") return "forfeited";
  if (row.settlement.status === "paid") return "paid";
  if (row.deposit.status === "refunded" || row.deposit.status === "refund_pending") return "refunded";
  if (row.settlement.status === "waived") return "waived";
  if (row.settlement.status === "past_due") return "settlementPastDue";
  // An exhausted BIRTH deposit — payPastDue's OTHER debt shape: no
  // settlement is past_due yet, but the deposit's own retry schedule ran out
  // and the curator is (or is about to be) delinquent over it. Mobile can't
  // offer the "Pay now" button web attaches to this state, but it must still
  // NAME the debt — otherwise a curator whose only debt is a deposit sees a
  // booking that looks fine on their phone while they're gated out of
  // booking anywhere.
  if (row.deposit.status === "unpaid" && (row.deposit.depositAttempts ?? 0) >= DEPOSIT_EXHAUSTED_ATTEMPTS
    && (row.settlement.status === "not_due" || row.settlement.status === "pending")) {
    return "depositPastDue";
  }
  if (row.settlement.status === "pending") return "settlementPending";
  if (row.deposit.status === "held" || row.deposit.status === "applied") return "depositHeld";
  return "depositUnpaid";
}

// Chip palette, reusing the colors this app already assigns these meanings
// (GigForms' STATUS_BG / BookingInbox's "your turn" badge): amber =
// in-flight or attention, red = debt, green = done, indigo = scheduled,
// grey = nothing owed / nothing yet.
const CHIP: Record<RowKind, { bg: string; fg: string }> = {
  forfeited: { bg: "#fef3c7", fg: "#92400e" },
  paid: { bg: "#dcfce7", fg: "#166534" },
  refunded: { bg: "#f3f4f6", fg: "#374151" },
  waived: { bg: "#f3f4f6", fg: "#374151" },
  settlementPastDue: { bg: "#fee2e2", fg: "#991b1b" },
  depositPastDue: { bg: "#fee2e2", fg: "#991b1b" },
  settlementPending: { bg: "#e0e7ff", fg: "#111" },
  depositHeld: { bg: "#e0e7ff", fg: "#111" },
  depositUnpaid: { bg: "#f3f4f6", fg: "#374151" },
};

// Same strings web renders for the same states, side-framed the same way —
// kept verbatim so a musician reading "Forfeited deposit — received 100%
// (…)" on the web Earnings page sees that exact sentence on their phone too.
function rowLabel(kind: RowKind, row: Row, isCuratorSide: boolean): string {
  switch (kind) {
    case "forfeited": {
      // forfeit_pending is IN PROGRESS — the cancellation committed but the
      // transfer to the musician hasn't landed yet (DepositStatus's state
      // machine in types.ts). Only terminal "forfeited" gets paid/received
      // copy.
      if (row.deposit.status === "forfeit_pending") {
        return isCuratorSide ? "Forfeiting to the musician…" : "Forfeiting to you…";
      }
      return isCuratorSide
        ? `Forfeited — ${formatCents(row.deposit.sliceCents)} paid to the musician`
        : `Forfeited deposit — received 100% (${formatCents(row.deposit.sliceCents)})`;
    }
    case "paid": {
      const totalCents = (row.settlement.computedCents ?? 0) + (row.settlement.feeShareCents ?? 0) + (row.settlement.lateFeeCents ?? 0);
      return isCuratorSide
        ? `Paid — ${formatCents(totalCents)}`
        : (row.transfer.amountCents != null ? `Paid ${formatCents(row.transfer.amountCents)}` : "Paid");
    }
    case "refunded": return "Refunded";
    case "waived": return "Waived — nothing owed on this date";
    case "settlementPastDue": return isCuratorSide ? "Past due — pay on the web" : "Curator payment delayed";
    case "depositPastDue": return isCuratorSide ? "Deposit past due — pay on the web" : "Payment delayed";
    case "settlementPending": {
      // "Settles"/"Pays out" is settlement.settleAfter (gig END + the T+3
      // delay), NOT the occurrence's own start date. settleAfter is set once
      // the gig ends, which is a precondition for reaching "pending" at all,
      // so occurrenceStartsAt is a defensive fallback only.
      const settleLabel = formatGigDateTime(row.settlement.settleAfter ?? row.occurrenceStartsAt);
      return isCuratorSide ? `Settles ${settleLabel}` : `Pays out ~${settleLabel}`;
    }
    case "depositHeld": return isCuratorSide ? "Deposit held" : "Deposit held in escrow";
    case "depositUnpaid": return "Charges when the date is confirmed";
    default: {
      // Exhaustiveness guard, not a dead fallback — a new RowKind member
      // fails to compile here until it's handled above (web's identical
      // guard).
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

const rowStyle = { borderWidth: 1 as const, borderColor: "#eee", borderRadius: 8, padding: 10, gap: 6 };

// Mounted by app/booking/[bookingId].tsx beneath BookingThread. Subscribes
// to the booking doc independently of BookingThread's own subscription —
// the same ACCEPTED double listener web's PaymentsPanel keeps beside
// BookingThread's, for the same reason: these are self-contained surfaces,
// and one extra doc listener per booking screen is not worth coupling them
// through a shared parent context.
export function PaymentStatus({ bookingId, uid }: { bookingId: string; uid: string }) {
  const [booking, setBooking] = useState<BookingRequestDoc | "loading" | "unavailable">("loading");

  useEffect(() => {
    const unsub = onSnapshot(doc(getFirebase().db, "bookings", bookingId),
      (s) => setBooking(s.exists() ? (s.data() as BookingRequestDoc) : "unavailable"),
      () => setBooking("unavailable"));
    return unsub;
  }, [bookingId]);

  const musicianProfileId = booking !== "loading" && booking !== "unavailable" ? booking.musicianProfileId : undefined;
  const curatorProfileId = booking !== "loading" && booking !== "unavailable" ? booking.curatorProfileId : undefined;
  // Hooks run unconditionally, in the same order, every render — the early
  // returns below happen AFTER both.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const rows = usePaymentRows(bookingId);
  const isCuratorSide = role === "curator" || role === "both";

  if (booking === "loading" || booking === "unavailable" || role === "loading" || role === "none") return null;
  // Nothing to show before acceptBooking's saga staged the payments
  // subcollection at all (an open/negotiating booking) — no empty panel.
  if (rows.length === 0) return null;

  // Mirrors recomputePaymentSummary's per-status table field-for-field, as
  // web's panel does: heldCents is ESCROW ONLY ("held" — the one status
  // meaning the platform is currently sitting on this money unreleased),
  // while paidCents is broader (every status where the card was charged at
  // all, whether or not that money has since moved on). feesCents rides
  // along with paidCents because a forfeited/refund-pending deposit's fee
  // share was still charged to the curator.
  let heldCents = 0, paidCents = 0, feesCents = 0;
  for (const r of rows) {
    if (r.deposit.status === "held") heldCents += r.deposit.sliceCents;
    if (PAID_DEPOSIT_STATUSES.has(r.deposit.status)) {
      paidCents += r.deposit.sliceCents + r.deposit.feeShareCents;
      feesCents += r.deposit.feeShareCents;
    }
    if (r.settlement.status === "paid") {
      paidCents += (r.settlement.computedCents ?? 0) + (r.settlement.feeShareCents ?? 0) + (r.settlement.lateFeeCents ?? 0);
      feesCents += r.settlement.feeShareCents ?? 0;
    }
  }

  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Payments</Text>
      <View style={{ gap: 8 }}>
        {rows.map((row) => {
          const kind = rowKind(row);
          const chip = CHIP[kind];
          return (
            <View key={row.id} style={rowStyle}>
              <Text style={{ fontWeight: "700" }}>{formatGigDateTime(row.occurrenceStartsAt)}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                <Badge label={rowLabel(kind, row, isCuratorSide)} bg={chip.bg} fg={chip.fg} />
              </View>
            </View>
          );
        })}
      </View>
      <View style={{ gap: 2 }}>
        {isCuratorSide ? (
          <>
            <Text style={{ color: "#666", fontSize: 13 }}>Held in escrow: {formatCents(heldCents)}</Text>
            <Text style={{ color: "#666", fontSize: 13 }}>
              Total paid so far: {formatCents(paidCents)} (includes {formatCents(feesCents)} in service fees)
            </Text>
          </>
        ) : (
          <Text style={{ color: "#666", fontSize: 13 }}>Held in escrow for you: {formatCents(heldCents)}</Text>
        )}
        <Text style={{ color: "#666", fontSize: 13 }}>
          {isCuratorSide
            ? "Cards, past-due payments and receipts are managed on the web."
            : "Payout setup and cash-outs are managed on the web."}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// EarningsCard — the musician dashboard's read-only payouts summary.
// ---------------------------------------------------------------------------

// The subset of getStripeStatus's result this card renders. Web keeps the
// full shape in apps/web/src/payments/types.ts; mobile declares only what it
// USES so the card can never accidentally start depending on a field it
// doesn't display (there is no shared client type package, and copying the
// full interface would invite exactly that).
interface StripeStatusSummary {
  hasAccount: boolean;
  payoutsEnabled: boolean;
  delinquent: boolean;
  // 0 means "asked, nothing there"; null means "Stripe couldn't be read just
  // now" and MUST render as unavailable, never as $0.00 — a musician
  // deciding whether to chase a curator over an unpaid gig must not be shown
  // a fabricated zero balance.
  availableBalanceCents: number | null;
}

export function EarningsCard({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState<StripeStatusSummary | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    httpsCallable<{ profileId: string }, StripeStatusSummary>(getFirebase().functions, "getStripeStatus")({ profileId })
      .then((res) => { if (!cancelled) setStatus(res.data); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [profileId]);

  return (
    <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Earnings</Text>

      {status === "loading" && <Text style={{ color: "#666" }}>Loading…</Text>}

      {status === "error" && (
        <View style={{ backgroundColor: "#fef3c7", borderRadius: 8, padding: 10 }}>
          <Text style={{ color: "#92400e" }}>Couldn&apos;t load your payout status.</Text>
        </View>
      )}

      {typeof status === "object" && (
        <>
          {status.delinquent && (
            <View style={{ backgroundColor: "#fee2e2", borderRadius: 8, padding: 10 }}>
              <Text style={{ color: "#991b1b" }}>A booking you&apos;re part of has an overdue curator payment.</Text>
            </View>
          )}
          {status.hasAccount && status.payoutsEnabled ? (
            <View style={{ gap: 2 }}>
              <Text style={{ color: "#666", fontSize: 13 }}>Available balance</Text>
              <Text style={{ fontSize: 28, fontWeight: "700" }}>
                {status.availableBalanceCents == null
                  ? "Balance unavailable"
                  : formatCents(status.availableBalanceCents)}
              </Text>
              {status.availableBalanceCents == null && (
                <Text style={{ color: "#666", fontSize: 13 }}>Try again shortly.</Text>
              )}
            </View>
          ) : (
            <Text>
              {status.hasAccount
                ? "Payout setup isn't finished yet — you can't be paid until it is."
                : "You haven't set up payouts yet — you can't be paid until you do."}
            </Text>
          )}
          {/* No in-app action, by design: cash-outs, Stripe onboarding and
              card management are web-only this sub-project (spec §1 —
              native payment sheets are sub-5b). Deliberately plain text
              rather than a link, matching (musician)/portfolio.tsx's
              treatment of the still-placeholder public host: there is no
              real deployed web origin constant in this app to link to yet. */}
          <Text style={{ color: "#666", fontSize: 13 }}>
            Manage payouts on the web — set up or update your payout account and cash out there.
          </Text>
        </>
      )}
    </View>
  );
}

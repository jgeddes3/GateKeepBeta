import { useEffect, useState } from "react";
import { View, Pressable } from "react-native";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { useRouter } from "expo-router";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import { useRole, useOccurrences } from "./BookingThread";
import { SaveCardSheet } from "../payments/SaveCardSheet";
import { PayPastDueButton } from "../payments/PayPastDueButton";
import { TrueUpForm } from "../payments/TrueUpForm";
import {
  PAID_DEPOSIT_STATUSES, paymentRowKind, resolveFeePolicy,
  type BookingRequestDoc, type PaymentDoc, type PaymentRowKind, type StripeStatusResult,
} from "@gatekeep/shared";
import { Text, Card, StatusBadge, type StatusTone } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5 Task 16, mobile's money surfaces. PaymentStatus is the per-occurrence
// status chips for one booking, mounted under BookingThread by
// app/booking/[bookingId].tsx. An RN port of
// apps/web/src/payments/PaymentsPanel.tsx: the row-state ladder and the
// paidCents membership test are literally the same code (@gatekeep/shared's
// `paymentRowKind` / `PAID_DEPOSIT_STATUSES`), and the surrounding totals
// arithmetic mirrors that panel's field-for-field, INCLUDING its
// review-round fixes. SP5 shipped this read-only (spec §1, "Platforms",
// native payment sheets needed @stripe/stripe-react-native and a new EAS dev
// build, which was sub-5b); SP5b wires the curator actions up: a
// card-on-file row (SaveCardSheet), a native pay-past-due button
// (PayPastDueButton) beside the two past-due rows, and (Task 5) a "Report
// actuals" true-up mount (TrueUpForm) beside the settlementPending row,
// mirroring PaymentsPanel.tsx's own row-map placement exactly.
//
// ONE DELIBERATE DIVERGENCE from web's copy remains: the totals footer is
// side-gated differently. Web shows both lines to the curator side only (it
// renders inside a curator-gated block); mobile reaches the musician side
// too, so it shows the escrow line to both and the "total paid, including
// service fees" line only to the curator, whose bill that is. (SP5's other
// divergence, the two past-due labels reading "pay on the web", is
// REMOVED by SP5b: the curator labels now match web's action-bearing copy,
// since there's a button to press again.)
//
// This file used to also hold EarningsCard, the musician dashboard's
// read-only balance headline. SP5b Task 7 replaced it with the full
// EarningsPanel (Stripe onboarding + cash-out) at
// src/payments/EarningsPanel.tsx, so it's gone from here, the musician
// footer line below now links out to that panel instead of describing a
// web-only workflow.

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

// StatusBadge tone per row kind, reusing the meanings this app already
// assigns these states: warning = in-flight or attention, destructive =
// debt, success = done, neutral = scheduled / nothing owed / nothing yet.
// The badge's displayed WORD still comes from rowLabel below; this only
// picks the color family.
const CHIP_TONE: Record<PaymentRowKind, StatusTone> = {
  forfeited: "warning",
  paid: "success",
  refunded: "neutral",
  waived: "neutral",
  settlementPastDue: "destructive",
  depositPastDue: "destructive",
  settlementPending: "neutral",
  depositHeld: "neutral",
  depositUnpaid: "neutral",
};

// Web's strings for the same states, side-framed the same way, kept
// identical so a musician reading "Forfeited deposit: received 100% (…)" on
// the web Earnings page sees that exact sentence on their phone too,
// including the two past-due lines: SP5b wires up a real Pay Now button next
// to them (below), so the curator copy matches web's action-bearing wording
// again (see the file header's note on the removed divergence).
function rowLabel(kind: PaymentRowKind, row: Row, isCuratorSide: boolean): string {
  switch (kind) {
    case "forfeited": {
      // forfeit_pending is IN PROGRESS, the cancellation committed but the
      // transfer to the musician hasn't landed yet (DepositStatus's state
      // machine in types.ts). Only terminal "forfeited" gets paid/received
      // copy.
      if (row.deposit.status === "forfeit_pending") {
        return isCuratorSide ? "Forfeiting to the musician…" : "Forfeiting to you…";
      }
      return isCuratorSide
        ? `Forfeited: ${formatCents(row.deposit.sliceCents)} paid to the musician`
        : `Forfeited deposit: received 100% (${formatCents(row.deposit.sliceCents)})`;
    }
    case "paid": {
      const totalCents = (row.settlement.computedCents ?? 0) + (row.settlement.feeShareCents ?? 0) + (row.settlement.lateFeeCents ?? 0);
      return isCuratorSide
        ? `Paid: ${formatCents(totalCents)}`
        : (row.transfer.amountCents != null ? `Paid ${formatCents(row.transfer.amountCents)}` : "Paid");
    }
    case "refunded": return "Refunded";
    case "waived": return "Waived: nothing owed on this date";
    case "settlementPastDue": return isCuratorSide ? "Past due: pay now" : "Curator payment delayed";
    case "depositPastDue": return isCuratorSide ? "Deposit past due: pay now" : "Payment delayed";
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
      // Exhaustiveness guard, not a dead fallback, a new PaymentRowKind
      // member fails to compile here (and in web's identical guard) until
      // both platforms handle it.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

// Mounted by app/booking/[bookingId].tsx beneath BookingThread. Subscribes
// to the booking doc independently of BookingThread's own subscription, the
// same ACCEPTED double listener web's PaymentsPanel keeps beside
// BookingThread's, for the same reason: these are self-contained surfaces,
// and one extra doc listener per booking screen is not worth coupling them
// through a shared parent context.
export function PaymentStatus({ bookingId, uid }: { bookingId: string; uid: string }) {
  const t = useTokens();
  const router = useRouter();
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
  // Hooks run unconditionally, in the same order, every render, the early
  // returns below happen AFTER all three.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const occurrences = useOccurrences(bookingId);
  const rows = usePaymentRows(bookingId);
  const isCuratorSide = role === "curator" || role === "both";

  useEffect(() => {
    if (!isCuratorSide || !curatorProfileId) return;
    let cancelled = false;
    // No synchronous setStripeStatus("loading") here (react-hooks/set-state
    // -in-effect), same idiom as web's PaymentsPanel: the initial
    // useState("loading") already covers first mount, and a reload just
    // leaves the PREVIOUS status on screen until the new one resolves,
    // rather than flashing back to "loading".
    callFn<{ profileId: string }, StripeStatusResult>("getStripeStatus", { profileId: curatorProfileId })
      .then((res) => { if (!cancelled) setStripeStatus(res.data); })
      .catch(() => { if (!cancelled) setStripeStatus("error"); });
    return () => { cancelled = true; };
  }, [isCuratorSide, curatorProfileId, stripeReloadKey]);

  if (booking === "loading" || booking === "unavailable" || role === "loading" || role === "none") return null;
  // Nothing to show before acceptBooking's saga staged the payments
  // subcollection at all (an open/negotiating booking), no empty panel.
  if (rows.length === 0) return null;

  // Task 5's true-up mount keys a settlementPending row's occurrence back to
  // its own durationMinutes, same lookup web's PaymentsPanel builds from
  // the same useOccurrences hook.
  const durationByGigId = new Map(occurrences.map((o) => [o.id, o.durationMinutes]));

  // Mirrors recomputePaymentSummary's per-status table field-for-field, as
  // web's panel does: heldCents is ESCROW ONLY ("held", the one status
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
    <View style={{ gap: tokens.space.md, borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg }}>
      <Text variant="title">Payments</Text>

      {isCuratorSide && curatorProfileId && (
        <Card style={{ padding: tokens.space.md, gap: tokens.space.sm }}>
          {showSaveCard ? (
            <SaveCardSheet profileId={curatorProfileId}
              onSaved={() => { setShowSaveCard(false); setStripeReloadKey((k) => k + 1); }}
              onClose={() => setShowSaveCard(false)} />
          ) : stripeStatus === "loading" ? (
            <Text muted>Loading card status…</Text>
          ) : stripeStatus === "error" ? (
            <View style={{ gap: tokens.space.xs }}>
              <Text color={t.warning}>Couldn&apos;t load your card status.</Text>
              <Pressable onPress={() => setStripeReloadKey((k) => k + 1)}>
                <Text color={t.warning} style={{ textDecorationLine: "underline" }}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
              <Text>
                {stripeStatus.hasCard
                  ? `Card on file: ${stripeStatus.cardBrand ?? "card"} •••• ${stripeStatus.cardLast4 ?? "----"}`
                  : "No card on file"}
              </Text>
              <Pressable onPress={() => setShowSaveCard(true)}>
                <Text style={{ textDecorationLine: "underline" }}>
                  {stripeStatus.hasCard ? "Update card" : "Add a card"}
                </Text>
              </Pressable>
            </View>
          )}
        </Card>
      )}

      <View style={{ gap: tokens.space.sm }}>
        {rows.map((row) => {
          const kind = paymentRowKind(row);
          const tone = CHIP_TONE[kind];
          return (
            <View key={row.id} style={{ borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.card,
              padding: tokens.space.md, gap: tokens.space.sm }}>
              <Text variant="label">{formatGigDateTime(row.occurrenceStartsAt)}</Text>
              {/* StatusBadge sets its own alignSelf: "flex-start", so it sizes
                  to its text without a wrapper row. */}
              <StatusBadge label={rowLabel(kind, row, isCuratorSide)} status={tone} />
              {isCuratorSide && (kind === "settlementPastDue" || kind === "depositPastDue") && (
                <PayPastDueButton bookingId={bookingId} gigId={row.id} onDone={() => setStripeReloadKey((k) => k + 1)} />
              )}
              {isCuratorSide && kind === "settlementPending" && booking.structure !== "perSet" && (
                openTrueUpFor === row.id ? (
                  <TrueUpForm
                    bookingId={bookingId} gigId={row.id} structure={booking.structure}
                    amountCents={booking.acceptedTerms?.amountCents ?? 0} feePolicy={resolveFeePolicy(booking.feePolicy)}
                    durationMinutes={durationByGigId.get(row.id) ?? 0} songCount={booking.acceptedTerms?.expectedQuantity ?? null}
                    current={row.settlement.trueUp}
                    onDone={() => setOpenTrueUpFor(null)} onCancel={() => setOpenTrueUpFor(null)}
                  />
                ) : (
                  <Pressable onPress={() => setOpenTrueUpFor(row.id)} style={{ alignSelf: "flex-start" }}>
                    <Text variant="meta" style={{ textDecorationLine: "underline" }}>Report actuals</Text>
                  </Pressable>
                )
              )}
            </View>
          );
        })}
      </View>
      <View style={{ gap: tokens.space.xs }}>
        {/* Neutral on purpose for BOTH sides: heldCents is the escrow GROSS
            (the deposit slice the curator was charged), and the musician's
            eventual share of it is that minus the 2% commission, or, on a
            forfeit, all of it. "Held in escrow for you" would state a net
            the musician will not actually receive. */}
        <Text variant="meta" muted>Held in escrow: {formatCents(heldCents)}</Text>
        {/* The bill, so curator-side only, a musician has no "total paid". */}
        {isCuratorSide && (
          <Text variant="meta" muted>
            Total paid so far: {formatCents(paidCents)} (includes {formatCents(feesCents)} in service fees)
          </Text>
        )}
        {/* Curator-side line removed in SP5b: the card-on-file row above and
            the Pay Now buttons beside each past-due row now cover that
            surface natively. The musician line now links to the dashboard's
            EarningsPanel (Task 7) instead of pointing to the web app. */}
        {!isCuratorSide && (
          <Pressable onPress={() => router.push("/(musician)/dashboard")}>
            <Text variant="meta" style={{ textDecorationLine: "underline" }}>Manage payouts →</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

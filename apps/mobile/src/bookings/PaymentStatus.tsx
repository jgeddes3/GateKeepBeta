import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents, formatGigDateTime, Badge } from "../gigs/GigForms";
import { useRole } from "./BookingThread";
import { SaveCardSheet } from "../payments/SaveCardSheet";
import { PayPastDueButton } from "../payments/PayPastDueButton";
import {
  PAID_DEPOSIT_STATUSES, paymentRowKind,
  type BookingRequestDoc, type PaymentDoc, type PaymentRowKind, type StripeStatusResult,
} from "@gatekeep/shared";

// SP5 Task 16 — mobile's money surfaces. Two components:
//
//  * PaymentStatus — the per-occurrence status chips for one booking,
//    mounted under BookingThread by app/booking/[bookingId].tsx. An RN port
//    of apps/web/src/payments/PaymentsPanel.tsx: the row-state ladder and
//    the paidCents membership test are literally the same code
//    (@gatekeep/shared's `paymentRowKind` / `PAID_DEPOSIT_STATUSES`), and
//    the surrounding totals arithmetic mirrors that panel's field-for-field,
//    INCLUDING its review-round fixes. SP5 shipped this read-only (spec §1,
//    "Platforms" — native payment sheets needed @stripe/stripe-react-native
//    and a new EAS dev build, which was sub-5b); SP5b now wires the curator
//    actions up: a card-on-file row (SaveCardSheet) and a native pay-past-due
//    button (PayPastDueButton) beside the two past-due rows. "Report
//    actuals"/TrueUpForm is Task 5's scope, not this one.
//
//    ONE DELIBERATE DIVERGENCE from web's copy remains: the totals footer is
//    side-gated differently. Web shows both lines to the curator side only
//    (it renders inside a curator-gated block); mobile reaches the musician
//    side too, so it shows the escrow line to both and the "total paid,
//    including service fees" line only to the curator, whose bill that is.
//    (SP5's other divergence — the two past-due labels reading "pay on the
//    web" — is REMOVED by SP5b: the curator labels now match web's
//    action-bearing copy, since there's a button to press again.)
//  * EarningsCard — the musician dashboard's balance headline
//    (getStripeStatus), a strict subset of web's EarningsPanel with the
//    cash-out/onboarding controls replaced by "manage payouts on the web".
//
// Both live in this one file because the plan's Task 16 file list created
// exactly one mobile source file — EarningsCard stays untouched and
// read-only this sub-project (a later SP5b task removes it).

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

// Chip palette, reusing the colors this app already assigns these meanings
// (GigForms' STATUS_BG / BookingInbox's "your turn" badge): amber =
// in-flight or attention, red = debt, green = done, indigo = scheduled,
// grey = nothing owed / nothing yet. `fg` omitted where Badge's own default
// (#111) is already the right ink.
const CHIP: Record<PaymentRowKind, { bg: string; fg?: string }> = {
  forfeited: { bg: "#fef3c7", fg: "#92400e" },
  paid: { bg: "#dcfce7", fg: "#166534" },
  refunded: { bg: "#f3f4f6", fg: "#374151" },
  waived: { bg: "#f3f4f6", fg: "#374151" },
  settlementPastDue: { bg: "#fee2e2", fg: "#991b1b" },
  depositPastDue: { bg: "#fee2e2", fg: "#991b1b" },
  settlementPending: { bg: "#e0e7ff" },
  depositHeld: { bg: "#e0e7ff" },
  depositUnpaid: { bg: "#f3f4f6", fg: "#374151" },
};

// Web's strings for the same states, side-framed the same way — kept
// identical so a musician reading "Forfeited deposit — received 100% (…)" on
// the web Earnings page sees that exact sentence on their phone too,
// including the two past-due lines: SP5b wires up a real Pay Now button next
// to them (below), so the curator copy matches web's action-bearing wording
// again (see the file header's note on the removed divergence).
function rowLabel(kind: PaymentRowKind, row: Row, isCuratorSide: boolean): string {
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
    case "settlementPastDue": return isCuratorSide ? "Past due — pay now" : "Curator payment delayed";
    case "depositPastDue": return isCuratorSide ? "Deposit past due — pay now" : "Payment delayed";
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
      // Exhaustiveness guard, not a dead fallback — a new PaymentRowKind
      // member fails to compile here (and in web's identical guard) until
      // both platforms handle it.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

const rowStyle = { borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 10, gap: 6 };

// Mounted by app/booking/[bookingId].tsx beneath BookingThread. Subscribes
// to the booking doc independently of BookingThread's own subscription —
// the same ACCEPTED double listener web's PaymentsPanel keeps beside
// BookingThread's, for the same reason: these are self-contained surfaces,
// and one extra doc listener per booking screen is not worth coupling them
// through a shared parent context.
export function PaymentStatus({ bookingId, uid }: { bookingId: string; uid: string }) {
  const [booking, setBooking] = useState<BookingRequestDoc | "loading" | "unavailable">("loading");
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
  // Hooks run unconditionally, in the same order, every render — the early
  // returns below happen AFTER both.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const rows = usePaymentRows(bookingId);
  const isCuratorSide = role === "curator" || role === "both";

  useEffect(() => {
    if (!isCuratorSide || !curatorProfileId) return;
    let cancelled = false;
    // No synchronous setStripeStatus("loading") here (react-hooks/set-state
    // -in-effect) — same idiom as web's PaymentsPanel: the initial
    // useState("loading") already covers first mount, and a reload just
    // leaves the PREVIOUS status on screen until the new one resolves,
    // rather than flashing back to "loading".
    httpsCallable<{ profileId: string }, StripeStatusResult>(getFirebase().functions, "getStripeStatus")({ profileId: curatorProfileId })
      .then((res) => { if (!cancelled) setStripeStatus(res.data); })
      .catch(() => { if (!cancelled) setStripeStatus("error"); });
    return () => { cancelled = true; };
  }, [isCuratorSide, curatorProfileId, stripeReloadKey]);

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

      {isCuratorSide && curatorProfileId && (
        <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 12, gap: 8 }}>
          {showSaveCard ? (
            <SaveCardSheet profileId={curatorProfileId}
              onSaved={() => { setShowSaveCard(false); setStripeReloadKey((k) => k + 1); }}
              onClose={() => setShowSaveCard(false)} />
          ) : stripeStatus === "loading" ? (
            <Text style={{ color: "#666" }}>Loading card status…</Text>
          ) : stripeStatus === "error" ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: "#92400e" }}>Couldn&apos;t load your card status.</Text>
              <Pressable onPress={() => setStripeReloadKey((k) => k + 1)}>
                <Text style={{ color: "#92400e", textDecorationLine: "underline" }}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text>
                {stripeStatus.hasCard
                  ? `Card on file: ${stripeStatus.cardBrand ?? "card"} •••• ${stripeStatus.cardLast4 ?? "----"}`
                  : "No card on file"}
              </Text>
              <Pressable onPress={() => setShowSaveCard(true)}>
                <Text style={{ color: "#111", textDecorationLine: "underline" }}>
                  {stripeStatus.hasCard ? "Update card" : "Add a card"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      <View style={{ gap: 8 }}>
        {rows.map((row) => {
          const kind = paymentRowKind(row);
          const chip = CHIP[kind];
          return (
            <View key={row.id} style={rowStyle}>
              <Text style={{ fontWeight: "700" }}>{formatGigDateTime(row.occurrenceStartsAt)}</Text>
              {/* Badge sets its own alignSelf: "flex-start", so it sizes to
                  its text without a wrapper row. */}
              <Badge label={rowLabel(kind, row, isCuratorSide)} bg={chip.bg} fg={chip.fg} />
              {isCuratorSide && (kind === "settlementPastDue" || kind === "depositPastDue") && (
                <PayPastDueButton bookingId={bookingId} gigId={row.id} onDone={() => setStripeReloadKey((k) => k + 1)} />
              )}
            </View>
          );
        })}
      </View>
      <View style={{ gap: 2 }}>
        {/* Neutral on purpose for BOTH sides: heldCents is the escrow GROSS
            (the deposit slice the curator was charged), and the musician's
            eventual share of it is that minus the 2% commission — or, on a
            forfeit, all of it. "Held in escrow for you" would state a net
            the musician will not actually receive. */}
        <Text style={{ color: "#666", fontSize: 13 }}>Held in escrow: {formatCents(heldCents)}</Text>
        {/* The bill, so curator-side only — a musician has no "total paid". */}
        {isCuratorSide && (
          <Text style={{ color: "#666", fontSize: 13 }}>
            Total paid so far: {formatCents(paidCents)} (includes {formatCents(feesCents)} in service fees)
          </Text>
        )}
        {/* Curator-side line removed in SP5b: the card-on-file row above and
            the Pay Now buttons beside each past-due row now cover that
            surface natively. The musician line stays — payout setup and
            cash-outs remain web-only until Task 7. */}
        {!isCuratorSide && (
          <Text style={{ color: "#666", fontSize: 13 }}>Payout setup and cash-outs are managed on the web.</Text>
        )}
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
  const [reloadKey, setReloadKey] = useState(0);

  // No synchronous setStatus("loading") on reload — same idiom as web's
  // EarningsPanel: the initial useState covers first mount, and a retry
  // leaves the previous state on screen until the new one resolves rather
  // than flashing back through "Loading…".
  useEffect(() => {
    let cancelled = false;
    httpsCallable<{ profileId: string }, StripeStatusSummary>(getFirebase().functions, "getStripeStatus")({ profileId })
      .then((res) => { if (!cancelled) setStatus(res.data); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [profileId, reloadKey]);

  return (
    <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Earnings</Text>

      {status === "loading" && <Text style={{ color: "#666" }}>Loading…</Text>}

      {status === "error" && (
        <View style={{ backgroundColor: "#fef3c7", borderRadius: 8, padding: 10, gap: 6 }}>
          <Text style={{ color: "#92400e" }}>Couldn&apos;t load your payout status.</Text>
          {/* A READ retry, not a money action — re-running getStripeStatus is
              idempotent and moves nothing, so it stays on the read-only side
              of this sub-project's mobile boundary. Mirrors web's Retry on
              the same failure. */}
          <Pressable onPress={() => setReloadKey((k) => k + 1)}>
            <Text style={{ color: "#92400e", textDecorationLine: "underline" }}>Retry</Text>
          </Pressable>
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

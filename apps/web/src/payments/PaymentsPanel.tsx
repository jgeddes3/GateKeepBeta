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
import {
  PAID_DEPOSIT_STATUSES, paymentRowKind, resolveFeePolicy,
  type BookingRequestDoc, type PaymentDoc, type PaymentRowKind, type StripeStatusResult,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Badge, type badgeVariants } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { IconWarning } from "../ui/icons";
import type { VariantProps } from "class-variance-authority";

// SP5 Task 15 — the booking detail page's money surface: subscribes to
// bookings/{id}/payments (rules permit either side's members + admins — see
// firestore.rules' Sub-project 5 section) and renders one row per occurrence
// plus a card-on-file row and a totals footer. Curator-side (and dual
// "both") members get the actions (report actuals, pay past due, update the
// card); musicians see the same rows read-only, musician-framed.

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

// The row-state ladder itself now lives in @gatekeep/shared's
// paymentDisplay.ts (`paymentRowKind`), shared with mobile's PaymentStatus so
// the two surfaces can never classify the same date differently. Only the
// LABELS below stay here — this panel's copy is action-bearing ("Past due —
// pay now" sits next to the button that does it), which mobile's read-only
// port deliberately words differently.
function rowLabel(kind: PaymentRowKind, row: Row, isCuratorSide: boolean): string {
  switch (kind) {
    case "forfeited": {
      // Review round 1 (low #12): forfeit_pending is IN PROGRESS — the
      // cancellation committed but the transfer to the musician hasn't
      // landed yet (see DepositStatus's state-machine comment in types.ts).
      // Only the terminal "forfeited" status gets the "you received/paid"
      // copy; forfeit_pending gets its own in-progress line.
      if (row.deposit.status === "forfeit_pending") {
        return isCuratorSide ? "Forfeiting to the musician…" : "Forfeiting to you…";
      }
      return isCuratorSide
        ? `Forfeited — ${formatCents(row.deposit.sliceCents)} paid to the musician`
        // Same copy EarningsPanel's HistoryList already uses for the
        // identical case — kept byte-identical so a musician sees the same
        // sentence on both surfaces.
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
      // Review round 1 (medium #3): "Settles"/"Pays out" is when settlement
      // actually happens (settlement.settleAfter — gig END + the T+3 delay),
      // NOT the occurrence's own start date. settleAfter is set once the gig
      // ends, which is a precondition for a doc ever reaching "pending" in
      // the first place, so it's non-null in practice; occurrenceStartsAt is
      // a defensive fallback only (a doc somehow "pending" before its own
      // settleAfter was recorded).
      const settleLabel = formatGigDateTime(row.settlement.settleAfter ?? row.occurrenceStartsAt);
      return isCuratorSide ? `Settles ${settleLabel}` : `Pays out ~${settleLabel}`;
    }
    case "depositHeld": return isCuratorSide ? "Deposit held" : "Deposit held in escrow";
    case "depositUnpaid": return "Charges when the date is confirmed";
    default: {
      // Review round 1 (low #15): exhaustiveness guard, not a dead fallback
      // — if RowKind ever grows a new member, THIS won't compile until every
      // case above handles it too, instead of silently rendering an empty
      // label at runtime (what the old `default: return ""` did).
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

// Status chip variant per row kind (task 11, spec 4: "Status/money chips use
// the established Badge treatments"). Pure display mapping, layered on top
// of the existing rowLabel/paymentRowKind ladder: no new state, and no
// change to which kind a row resolves to. Only the two PAST DUE kinds are
// genuinely urgent (destructive); paid/forfeited are a settled success;
// everything else (refunded/waived/pending/held/unpaid) is an ordinary,
// expected in-progress or closed state, not a warning. DESIGN.md's status
// tints name exactly three colors, and "pending"/"held in escrow" is normal,
// not cautionary, so those get the neutral "secondary" treatment rather than
// reaching for warning just to use a third color.
function rowBadgeVariant(kind: PaymentRowKind): VariantProps<typeof badgeVariants>["variant"] {
  switch (kind) {
    case "paid":
    case "forfeited":
      return "success";
    case "settlementPastDue":
    case "depositPastDue":
      return "destructive";
    default:
      return "secondary";
  }
}

export function PaymentsPanel({ bookingId, uid }: { bookingId: string; uid: string }) {
  const [booking, setBooking] = useState<BookingRequestDoc | "loading" | "unavailable">("loading");
  const [openTrueUpFor, setOpenTrueUpFor] = useState<string | null>(null);
  const [showSaveCard, setShowSaveCard] = useState(false);
  const [stripeStatus, setStripeStatus] = useState<StripeStatusResult | "loading" | "error">("loading");
  const [stripeReloadKey, setStripeReloadKey] = useState(0);

  // Review round 1 (low #17) — ACCEPTED double listener: BookingThread.tsx
  // (mounted on the same page, right above this panel) already runs its own
  // onSnapshot on this exact bookings/{bookingId} doc; this is a second,
  // independent one. A page-level context (subscribe once, hand the doc down
  // to both) was considered and rejected: PaymentsPanel and BookingThread are
  // deliberately self-contained "surfaces" (same precedent as EarningsPanel
  // running its own bookings subscription alongside BookingInbox's) — one
  // extra doc listener per booking-detail page view is negligible, and
  // keeping the two components independent avoids coupling them through
  // shared parent-context wiring for a saving that doesn't matter here.
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

  // Review round 1 (medium #1, #2): mirrors recomputePaymentSummary's own
  // per-status table field-for-field — heldCents is ESCROW ONLY ("held", the
  // one deposit status meaning "the platform is currently sitting on this
  // money, unreleased"), while paidCents is broader: every status in
  // PAID_DEPOSIT_STATUSES where the curator's card was charged at all,
  // whether or not that money has since moved on. feesCents (this panel's
  // own addition — recomputePaymentSummary doesn't track it) rides along
  // with paidCents for the same set of statuses, since a forfeited/refund-
  // pending deposit's fee share was still charged to the curator.
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
    <section className="grid gap-4 border-t border-gk-border pt-6">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Payments</h2>

      {isCuratorSide && curatorProfileId && (
        <div className="rounded-gk border border-gk-border bg-gk-surface p-3.5">
          {showSaveCard ? (
            <SaveCardModal profileId={curatorProfileId}
              onSaved={() => { setShowSaveCard(false); setStripeReloadKey((k) => k + 1); }}
              onClose={() => setShowSaveCard(false)} />
          ) : stripeStatus === "loading" ? (
            <Skeleton className="h-5 w-40" />
          ) : stripeStatus === "error" ? (
            <p className="flex flex-wrap items-center gap-2 font-sora text-sm text-gk-warning">
              <IconWarning size={16} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t load your card status.
              <Button onClick={() => setStripeReloadKey((k) => k + 1)} variant="link" className="h-auto p-0">Retry</Button>
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-sora text-sm text-gk-text">
                {stripeStatus.hasCard
                  ? `Card on file: ${stripeStatus.cardBrand ?? "card"} •••• ${stripeStatus.cardLast4 ?? "----"}`
                  : "No card on file"}
              </span>
              <Button onClick={() => setShowSaveCard(true)} variant="secondary" size="sm">
                {stripeStatus.hasCard ? "Update card" : "Add a card"}
              </Button>
            </div>
          )}
        </div>
      )}

      <ul className="grid gap-2.5">
        {rows.map((row) => {
          const kind = paymentRowKind(row);
          return (
            <li key={row.id} className="grid gap-2.5 rounded-gk border border-gk-border bg-gk-surface p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-sora text-sm text-gk-text">{formatGigDateTime(row.occurrenceStartsAt)}</span>
                {/* Status/money chip (spec 4): the established Badge status
                    treatments, not a bespoke color per row.
                    Review round 1: Badge's own base class is
                    whitespace-nowrap (right, for a short status word), but
                    several rowLabel() outputs are full money sentences with
                    a formatted dollar amount folded in (e.g. a "Forfeited"
                    clause naming who got paid what), which can outrun a
                    narrow (360px) viewport as one unbroken line. whitespace-normal
                    overrides that for just this usage so a long label wraps
                    inside the chip instead of forcing horizontal overflow. */}
                <Badge variant={rowBadgeVariant(kind)} className="whitespace-normal text-right">
                  {rowLabel(kind, row, isCuratorSide)}
                </Badge>
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
                  <Button onClick={() => setOpenTrueUpFor(row.id)} variant="secondary" size="sm" className="w-fit">
                    Report actuals
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ul>

      <div className="grid gap-0.5 border-t border-gk-border pt-3">
        <p className="font-sora text-sm text-gk-text">Held in escrow: {formatCents(heldCents)}</p>
        <p className="font-sora text-sm text-gk-text">
          Total paid so far: {formatCents(paidCents)} (includes {formatCents(feesCents)} in service fees)
        </p>
      </div>
    </section>
  );
}

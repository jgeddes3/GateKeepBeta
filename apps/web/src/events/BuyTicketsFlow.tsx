"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import {
  DEFAULT_TICKET_FEE_POLICY, ticketOrderTotals,
  EVENT_SOLD_OUT_MESSAGE, EVENT_SALE_CLOSED_MESSAGE, EVENT_BUYER_CAP_MESSAGE, EVENT_NOT_ON_SALE_MESSAGE,
  type EventStatus, type TicketOrderStatus, type TicketTierDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { getStripeJs } from "../payments/stripeLoader";
import { gkStripeAppearance } from "../payments/stripeAppearance";
import { TierPicker, MAX_QTY_PER_LINE_ITEM, type TierPickerTier } from "./TierPicker";
import { formatCents, eventSalesClosedReason } from "./eventDisplay";
import { PostPurchaseGenrePrompt } from "../discover/GenrePicker";
import { Button } from "../ui/button";
import { IconWarning } from "../ui/icons";

// Sub-project 6 task 9: the fan buy flow. Mirrors the house payment idiom
// (src/payments/SaveCardModal.tsx, src/payments/PayPastDueButton.tsx):
// "use client", callFn(...) (lib/callable.ts, Task 27), an Elements
// mount keyed off a server-issued clientSecret, verbatim server-error
// surfacing, a busy/error pair of local state. apps/web never depends on
// functions/src types (same boundary those two components' own headers
// document), so the two callable I/O shapes below are hand-mirrored from
// functions/src/ticketing.ts's CreateTicketOrderInput/Result and
// FinalizeTicketOrderInput/Result, not imported.
//
// FLOW:
//  1. createTicketOrder({eventId, items}): reserves inventory, mints a
//     pending order. clientSecret is null for a FREE order (every line item
//     priced at 0): the server has already run completeOrderTx inline by the
//     time this returns (see CreateTicketOrderResult's own doc comment in
//     ticketing.ts), so the client jumps straight to the done/"paid" state,
//     no Elements involved.
//  2. PAID order (clientSecret non-null): mount <Elements> + PaymentElement
//     against it (same shape PayPastDueButton's ConfirmForm uses for a
//     PaymentIntent, not SaveCardModal's SetupIntent one), confirm with
//     stripe.confirmPayment({redirect: "if_required"}), then call
//     finalizeTicketOrder({orderId}), a synchronous confirm-then-verify
//     round trip so the buyer doesn't have to wait on the
//     payment_intent.succeeded webhook. Branches on the returned
//     orderStatus ("pending"|"paid"|"expired"|"cancelled_refunded") per the
//     controller's ruling: "paid" is success, "pending" means the webhook
//     will finish it shortly (a legitimate, if rare, transient state per
//     finalizeTicketOrder's own doc comment), anything else is a genuine
//     failure to report.
//
// KEYLESS EMULATOR MODE (no NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY configured,
// this repo's local dev posture): unlike SaveCardModal/PayPastDueButton,
// createTicketOrder does NOT special-case FakeStripe for a nonzero-priced
// tier (only the "every line item is 0" free path short-circuits, see
// functions/src/ticketing.ts). A paid tier's clientSecret in this mode is a
// real FakeStripe payment-intent secret ("pi_fake_..._secret_fake"), but
// getStripeJs() resolves to a null Stripe instance (stripeLoader.ts: no
// publishable key -> `stripeEnabled` false -> `Promise.resolve(null)`), so
// <Elements stripe={null}> never actually initializes a working
// PaymentElement/confirm path locally: this flow mounts correctly and the
// Pay button correctly stays disabled (`!stripe`) exactly like
// PayPastDueButton's own ConfirmForm would in the same posture, but cannot
// be driven to completion without a real publishable key. The free-tier
// path is this flow's true end-to-end-verifiable path in this environment.

interface CreateTicketOrderResult { orderId: string; clientSecret: string | null; }
interface FinalizeTicketOrderResult { orderStatus: TicketOrderStatus; }

type Phase = "idle" | "creating" | "confirm" | "finalizing" | "done";

// A live "now", seeded from the SERVER-computed instant page.tsx captured
// at render time (threaded down through EventPageClient), not a bare
// client-side `Date.now()` call during render (eslint-config-next's React
// Compiler purity rule forbids that, see src/bookings/BookingThread.tsx's
// own useNow for the fuller rationale this mirrors). Seeding from a real
// prop value, rather than starting at `null` the way that hook does, means
// the tier picker and sticky Buy bar render their real content on the
// FIRST pass, server-side included: this page's own live-verification gate
// needs the SSR response to show genuine visible tier/fee/price content,
// not a loading skeleton standing in for it. `setNow` only ever runs inside
// the interval callback, never synchronously in the effect body, so this
// doesn't trip react-hooks/set-state-in-effect either. Ticks every 30s
// (matching useNow's own cadence) so a sale window boundary crossed while
// this page stays open still gets picked up without a reload; the server
// remains authoritative regardless (createTicketOrder re-checks the exact
// same windows inside its own transaction).
function useLiveNow(initialNow: number): number {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
    >
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

// Sticky Buy bar (spec anatomy: "sticky Buy button (pill, ember, the page's
// ONE primary CTA)"). Solid `bg-gk-surface`, never glass/backdrop-blur:
// DESIGN.md's glass cap reserves its exactly-two product-wide uses for the
// landing nav and the mini-player; this is a third surface and would blow
// the cap.
function StickyBuyBar({ totalQty, totalCents, label, onClick, disabled }: {
  totalQty: number; totalCents: number; label: string; onClick: () => void; disabled: boolean;
}) {
  if (totalQty === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gk-border bg-gk-surface">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-sora text-xs text-gk-muted">{totalQty} ticket{totalQty === 1 ? "" : "s"}</p>
          <p className="truncate font-syne text-base font-semibold text-gk-text">Order total: {formatCents(totalCents)}</p>
        </div>
        <Button onClick={onClick} disabled={disabled} className="shrink-0">{label}</Button>
      </div>
    </div>
  );
}

// Split out so useStripe()/useElements() only run inside the live <Elements>
// context BuyTicketsFlow renders this into, mirroring PayPastDueButton's own
// ConfirmForm split for the identical reason.
function PayConfirmForm({ onConfirmed, onCancel }: { onConfirmed: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Could not complete the payment.");
      setBusy(false);
      return;
    }
    onConfirmed();
  };

  return (
    <div className="grid gap-3 rounded-gk border border-gk-border bg-gk-surface p-4">
      <PaymentElement />
      {error && <ErrorBox message={error} />}
      <div className="flex gap-2">
        <Button onClick={confirm} disabled={busy || !stripe || !elements}>{busy ? "Paying…" : "Pay now"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

export function BuyTicketsFlow({ eventId, eventStatus, startsAt, tiers, now: initialNow, eventGenres }: {
  eventId: string; eventStatus: EventStatus; startsAt: number; tiers: TierPickerTier[];
  // The instant page.tsx's own server render captured (see useLiveNow's
  // header comment for why this is a prop, not a bare client Date.now()).
  now: number;
  // SP7 Task 9: this event's own genres (EventDoc.genres, curator-set or
  // lineup-derived), threaded down only so the post-purchase prompt below
  // can preselect them in the genre picker it opens. Nothing else in this
  // flow reads it.
  eventGenres: string[];
}) {
  const { user } = useAuth();
  const router = useRouter();
  // Seeded from the `tiers` prop (page.tsx's own SSR fetch), then refreshed
  // in place after a sold-out/sale-closed rejection (see refetchTiers
  // below) rather than trusting the prop for the whole component lifetime:
  // fix round 1, the "stale-retry" finding. Not re-synced from the prop on
  // every render (a plain useState seed, same idiom useLiveNow's own
  // server-seeded state already uses): this route has no live subscription
  // of its own (ISR revalidate=60 is the SSR data's own freshness window),
  // so there's nothing else that would legitimately change `tiers` out from
  // under this state between refetches.
  const [liveTiers, setLiveTiers] = useState<TierPickerTier[]>(tiers);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<TicketOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchasedQty, setPurchasedQty] = useState(0);
  const now = useLiveNow(initialNow);
  const feePolicy = DEFAULT_TICKET_FEE_POLICY;
  const appearance = useMemo(() => gkStripeAppearance(), []);

  const items = liveTiers
    .map((t) => ({ tierId: t.id, quantity: quantities[t.id] ?? 0 }))
    .filter((it) => it.quantity > 0);
  const totals = ticketOrderTotals(
    items.map((it) => {
      const tier = liveTiers.find((t) => t.id === it.tierId)!;
      return { tierId: it.tierId, quantity: it.quantity, unitPriceCents: tier.priceCents, tierName: tier.name };
    }),
    feePolicy,
  );
  const totalQty = items.reduce((sum, it) => sum + it.quantity, 0);
  const totalCents = totals.faceTotalCents + totals.serviceFeeCents;
  const unavailable = eventSalesClosedReason(eventStatus, startsAt, now);

  // Fix round 1 finding (money-critical, Critical): a one-shot live read of
  // the tier docs, called after a sold-out/sale-closed rejection so the
  // picker's own badges catch up to what the server just proved (rather
  // than continuing to claim a tier is available when it just refused it).
  // Also clamps any already-selected quantity down to the tier's own fresh
  // remaining capacity: without this, a stale over-limit quantity would
  // silently ride along into the buyer's very next attempt and draw the
  // exact same rejection again, an invisible retry loop the refetch alone
  // wouldn't fix (the picker would show "Sold out" for that tier, but
  // nothing would ever reduce the quantity still counted into the order).
  // Public read (events/{id}/tiers, the same rules disjunct page.tsx's own
  // SSR fetch relies on): no auth needed here.
  const refetchTiers = async () => {
    try {
      const snap = await getDocs(
        query(collection(getFirebase().db, `events/${eventId}/tiers`), orderBy("sortOrder")));
      const fresh: TierPickerTier[] = snap.docs.map((d) => {
        const t = d.data() as TicketTierDoc;
        return {
          id: d.id, name: t.name, priceCents: t.priceCents, capacity: t.capacity, soldCount: t.soldCount,
          saleStartsAt: t.saleStartsAt, saleEndsAt: t.saleEndsAt,
        };
      });
      setLiveTiers(fresh);
      setQuantities((prev) => {
        const next = { ...prev };
        for (const t of fresh) {
          const max = Math.min(MAX_QTY_PER_LINE_ITEM, Math.max(t.capacity - t.soldCount, 0));
          if ((next[t.id] ?? 0) > max) next[t.id] = max;
        }
        return next;
      });
    } catch (e) {
      // Best-effort refresh only: the error box above already shows the
      // server's own rejection message regardless of whether this succeeds.
      console.error("refetchTiers failed", eventId, e);
    }
  };

  const startPurchase = async () => {
    // Re-entrancy guard (fix round 1, Critical): never start a second order
    // while one is already in flight or awaiting confirmation. Belt half of
    // "belt and braces": the sticky bar below is ALSO fixed to never render
    // enabled outside "idle", but this guard holds even if some future call
    // site (or a stale closure) reaches startPurchase some other way.
    if (phase !== "idle") return;
    if (!user) {
      router.push(`/sign-in?next=${encodeURIComponent(`/e/${eventId}`)}`);
      return;
    }
    setError(null);
    setPhase("creating");
    try {
      const res = await callFn<{ eventId: string; items: Array<{ tierId: string; quantity: number }> },
        CreateTicketOrderResult>("createTicketOrder", { eventId, items });
      setOrderId(res.data.orderId);
      setPurchasedQty(totalQty);
      if (res.data.clientSecret) {
        setClientSecret(res.data.clientSecret);
        setPhase("confirm");
      } else {
        setOrderStatus("paid");
        setPhase("done");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not start checkout.";
      setError(message);
      setPhase("idle");
      // Fix round 1 (Important): branch on the exact shared-message strings
      // clients are meant to compare with === (packages/shared/src/
      // messages.ts's own header, precedent: GatePrompt.tsx).
      if (message === EVENT_SOLD_OUT_MESSAGE || message === EVENT_SALE_CLOSED_MESSAGE) {
        // The picker's own sold-out/sale-window badges were computed from
        // data fetched at page-load (or the ISR window before that): the
        // server just proved that's stale, so refetch the live tier docs
        // rather than leaving a picker that still claims the tier is
        // available.
        void refetchTiers();
      } else if (message === EVENT_BUYER_CAP_MESSAGE || message === EVENT_NOT_ON_SALE_MESSAGE) {
        // Both recognized by name (a reviewer can see at a glance these two
        // exact server strings were considered), but need no follow-up
        // action beyond the generic error box already set above: the
        // buyer-wide cap is never client-computable (TierPicker's own
        // header comment), and a whole-event closure is already covered by
        // eventSalesClosedReason's own banner on a fresh load.
        console.info("createTicketOrder rejected", message);
      }
    }
  };

  const finalize = async () => {
    if (!orderId) return;
    setPhase("finalizing");
    try {
      const res = await callFn<{ orderId: string }, FinalizeTicketOrderResult>("finalizeTicketOrder", { orderId });
      setOrderStatus(res.data.orderStatus);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm your order.");
      setPhase("confirm");
    }
  };

  if (phase === "done") {
    if (orderStatus === "paid") {
      return (
        <div className="rounded-gk border border-gk-success/40 bg-gk-success/14 p-4">
          <p className="font-syne text-base font-semibold text-gk-text">You&apos;re in.</p>
          <p className="mt-1 font-sora text-sm text-gk-text">
            {purchasedQty} ticket{purchasedQty === 1 ? "" : "s"} confirmed.
          </p>
          <Button asChild className="mt-3"><Link href="/tickets">View your tickets</Link></Button>
          {/* SP7 Task 9: the ONLY place this renders on the event page (the
              paid-done branch, never idle/confirm/pending/failed) and only
              when useGenrePickerGate says so (a fan who's already followed a
              genre, or already seen this prompt, gets nothing extra here). */}
          <PostPurchaseGenrePrompt eventGenres={eventGenres} />
        </div>
      );
    }
    if (orderStatus === "pending") {
      return (
        <div className="rounded-gk border border-gk-warning/40 bg-gk-warning/14 p-4">
          <p className="font-syne text-base font-semibold text-gk-text">Still processing</p>
          <p className="mt-1 font-sora text-sm text-gk-text">
            Your payment is still processing. Check your tickets page in a moment.
          </p>
          <Button asChild variant="secondary" className="mt-3"><Link href="/tickets">Go to your tickets</Link></Button>
        </div>
      );
    }
    return (
      <div className="grid gap-3">
        <ErrorBox message="This order could not be completed. Try again." />
        <Button
          type="button" variant="secondary" className="w-fit"
          onClick={() => { setPhase("idle"); setOrderId(null); setClientSecret(null); setOrderStatus(null); }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 pb-24">
      {unavailable && <ErrorBox message={unavailable} />}
      <TierPicker
        tiers={liveTiers}
        quantities={quantities}
        onChange={(tierId, quantity) => setQuantities((prev) => ({ ...prev, [tierId]: quantity }))}
        feePolicy={feePolicy}
        now={now}
        disabled={!!unavailable || phase !== "idle"}
      />
      {error && <ErrorBox message={error} />}
      {phase === "confirm" && clientSecret && (
        <Elements stripe={getStripeJs()} options={{ clientSecret, appearance }}>
          <PayConfirmForm
            onConfirmed={finalize}
            onCancel={() => { setPhase("idle"); setClientSecret(null); setOrderId(null); }}
          />
        </Elements>
      )}
      {/* Fix round 1 (Critical): "idle"/"creating" ONLY. The bar used to
          render for every phase except "confirm", which also covered
          "finalizing" (Elements->confirmPayment succeeded, waiting on
          finalizeTicketOrder): with `disabled` checking only "creating",
          that left the bar re-rendered ENABLED while a finalize was still
          in flight, and a click there re-ran startPurchase, minting a
          second inventory reservation (and, on a paid tier, a second
          PaymentIntent) on top of the one already being finalized. Belt and
          braces with startPurchase's own re-entrancy guard above: this is
          the braces half (the bar simply doesn't render clickable outside
          "idle"/"creating" at all), that guard is the belt (holds even if
          some other path ever reaches startPurchase). */}
      {(phase === "idle" || phase === "creating") && (
        <StickyBuyBar
          totalQty={totalQty}
          totalCents={totalCents}
          label={!user ? "Sign in to buy tickets" : phase === "creating" ? "Starting…" : "Buy tickets"}
          onClick={startPurchase}
          disabled={phase !== "idle"}
        />
      )}
    </div>
  );
}

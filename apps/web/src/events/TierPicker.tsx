"use client";
import type { TicketFeePolicy } from "@gatekeep/shared";
import { formatTierPrice, tierAvailability, tierFeeLine, TIER_AVAILABILITY_LABEL } from "./eventDisplay";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconMinus, IconPlus } from "../ui/icons";

// Sub-project 6 task 9: the tier picker (spec anatomy: "name, price, fee
// shown as '+ $X.XX service fee', sold-out and sale-window states from
// shared messages"). A controlled component (mirrors src/bookings/
// BookingForms.tsx's OfferFields: value + onChange, the parent
// (BuyTicketsFlow) owns the quantities state and the order-total math that
// depends on it, this only renders and edits it.
//
// The per-tier quantity CAP here is display-only and never the buyer's real
// limit: `buildOrderItems` (functions/src/eventsCore.ts) hard-caps a single
// line item at 10, and remaining capacity (tier.capacity - tier.soldCount)
// is public data already on the tier doc, so both are legitimately
// computable client-side. The event-wide BUYER cap (maxTicketsPerBuyer,
// counted across every tier and every one of the buyer's past/pending
// orders) is deliberately NOT pre-computed here (the brief's own ruling):
// it depends on server-only state, so a rejection just surfaces
// EVENT_BUYER_CAP_MESSAGE verbatim instead of guessing at it.
// Exported so BuyTicketsFlow.tsx's own post-rejection quantity clamp (see
// its refetchTiers) uses this exact same cap rather than a second, driftable
// literal "10".
export const MAX_QTY_PER_LINE_ITEM = 10;

export interface TierPickerTier {
  id: string; name: string; priceCents: number; capacity: number; soldCount: number;
  saleStartsAt: number | null; saleEndsAt: number | null;
}

export function TierPicker({ tiers, quantities, onChange, feePolicy, now, disabled }: {
  tiers: TierPickerTier[];
  quantities: Record<string, number>;
  onChange: (tierId: string, quantity: number) => void;
  feePolicy: TicketFeePolicy;
  now: number;
  // Forces every tier's stepper off regardless of its own availability:
  // BuyTicketsFlow sets this once checkout starts (so quantities can't
  // change mid-purchase) and whenever the event itself is closed to
  // purchase (eventSalesClosedReason).
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3">
      {tiers.map((tier) => {
        const availability = tierAvailability(tier, now);
        const remaining = tier.capacity - tier.soldCount;
        const max = Math.min(MAX_QTY_PER_LINE_ITEM, Math.max(remaining, 0));
        const qty = quantities[tier.id] ?? 0;
        const feeLine = tierFeeLine(tier.priceCents, feePolicy);
        const canPick = availability === "on_sale" && !disabled;
        return (
          <div
            key={tier.id}
            className="flex items-center justify-between gap-4 rounded-gk border border-gk-border bg-gk-surface p-4"
          >
            <div className="min-w-0">
              <p className="truncate font-syne text-base font-semibold text-gk-text">{tier.name}</p>
              <p className="font-sora text-sm text-gk-text">
                {formatTierPrice(tier.priceCents)}
                {feeLine && <span className="text-gk-muted"> · {feeLine}</span>}
              </p>
              {availability !== "on_sale" && (
                <Badge variant="secondary" className="mt-1.5">{TIER_AVAILABILITY_LABEL[availability]}</Badge>
              )}
            </div>
            {canPick && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button" variant="secondary" size="icon"
                  aria-label={`Fewer ${tier.name} tickets`}
                  onClick={() => onChange(tier.id, Math.max(0, qty - 1))}
                  disabled={qty <= 0}
                >
                  <IconMinus size={16} aria-hidden="true" />
                </Button>
                <span className="w-5 text-center font-syne text-sm font-semibold tabular-nums text-gk-text">
                  {qty}
                </span>
                <Button
                  type="button" variant="secondary" size="icon"
                  aria-label={`More ${tier.name} tickets`}
                  onClick={() => onChange(tier.id, Math.min(max, qty + 1))}
                  disabled={qty >= max}
                >
                  <IconPlus size={16} aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { LAUNCH_TIMEZONE, ticketServiceFeeCents, type EventStatus, type TicketFeePolicy } from "@gatekeep/shared";
import { formatGigTime } from "../../app/u/[handle]/gigDisplay";

// Plain (non-"use client") display helpers for sub-project 6's public event
// page and the "Upcoming events" sections on the venue/artist pages. Same
// RSC rationale as app/u/[handle]/gigDisplay.ts's own header comment: a
// Server Component (app/e/[eventId]/page.tsx, CuratorProfile.tsx,
// MusicianProfile.tsx) that imports a value out of a "use client" module
// gets an opaque client-reference stub back instead of the real thing, so
// date/price/status formatting shared by both server and client event
// surfaces lives here, never in a client-only helper file. Imports
// formatGigTime from gigDisplay.ts (a plain-to-plain import, no client
// boundary crossed) rather than duplicating it: EventDoc's startsAt/endsAt
// are the same epoch-ms shape GigDoc's own startsAt already uses.

// cents -> a dollar string, showing cents only when they're non-zero.
// Byte-identical to src/gigs/GigForms.tsx's own formatCents (that copy is
// "use client" and cannot be imported from here, see the header note
// above); kept in sync by hand, the same tradeoff this codebase already
// accepted for formatGigDateTime/gigLocationLabel before they were
// consolidated into gigDisplay.ts.
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// A ticket tier's own display price: "Free" for a 0-priced tier (a legal
// RSVP tier, see TicketTierDoc's own comment) reads better than "$0" here,
// this is a ticket, not a gig budget figure.
export function formatTierPrice(priceCents: number): string {
  return priceCents <= 0 ? "Free" : formatCents(priceCents);
}

// Per-ticket service fee line, "+ $X.XX service fee" (the money-sentence
// convention this task's brief specifies verbatim). null for a free ticket:
// ticketServiceFeeCents already returns 0 there, and a "+ $0 service fee"
// line would be noise on the one tier type that never carries one. Preview
// only: the order-server (createTicketOrder) recomputes and stamps the real
// fee at purchase time, this never feeds a write.
export function tierFeeLine(priceCents: number, policy: TicketFeePolicy): string | null {
  const feeCents = ticketServiceFeeCents(priceCents, policy);
  return feeCents > 0 ? `+ ${formatCents(feeCents)} service fee` : null;
}

export type TierAvailability = "on_sale" | "not_yet_open" | "sale_ended" | "sold_out";

// Pure display predicate mirroring functions/src/eventsCore.ts's tierOnSale
// window check plus the capacity check createTicketOrder itself applies
// (tier.soldCount + quantity > tier.capacity): a DISPLAY-ONLY mirror for the
// tier picker's state, never load-bearing for money. The server re-checks
// both, inside its own transaction, on every purchase attempt regardless of
// what this function says.
export function tierAvailability(
  tier: { soldCount: number; capacity: number; saleStartsAt: number | null; saleEndsAt: number | null },
  now: number,
): TierAvailability {
  if (tier.soldCount >= tier.capacity) return "sold_out";
  if (tier.saleStartsAt != null && now < tier.saleStartsAt) return "not_yet_open";
  if (tier.saleEndsAt != null && now > tier.saleEndsAt) return "sale_ended";
  return "on_sale";
}

export const TIER_AVAILABILITY_LABEL: Record<Exclude<TierAvailability, "on_sale">, string> = {
  sold_out: "Sold out",
  not_yet_open: "Not yet on sale",
  sale_ended: "Sale ended",
};

// Whether the event itself is closed to purchase, at the DISPLAY layer only
// (createTicketOrder's own event-level gate, functions/src/ticketing.ts, is
// what's actually load-bearing). "draft" and "cancelled" are deliberately
// not handled here: this page's own server read (getServerFirebase(), see
// its header comment) is always anonymous, and firestore.rules' events read
// rule only exposes those two statuses to a curator-side member or admin,
// so loadEvent() already renders the not-found state before either one ever
// reaches this function.
export function eventSalesClosedReason(status: EventStatus, startsAt: number, now: number): string | null {
  if (status === "completed") return "This event has already happened.";
  if (startsAt <= now) return "Ticket sales have closed for this event.";
  return null;
}

// The hero date block's headline: a time range (start-end), en dash per the
// codebase's existing multi-part-figure convention (GigCard's own price
// range uses the same "–", never an em dash: DESIGN.md's hard rule).
export function formatEventTimeRange(startsAtMs: number, endsAtMs: number): string {
  return `${formatGigTime(startsAtMs)}–${formatGigTime(endsAtMs)}`;
}

// The hero date block's subtitle: the full weekday + date. DateBlockRow's
// own date chip already shows month/day (no weekday, no year); this adds
// exactly the two things that chip can't, without repeating what it already
// shows.
export function formatEventFullDate(startsAtMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: LAUNCH_TIMEZONE,
  }).format(new Date(startsAtMs));
}

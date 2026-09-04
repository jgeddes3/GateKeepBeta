import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { LAUNCH_TIMEZONE, ticketServiceFeeCents, type EventStatus, type TicketFeePolicy, type TicketStatus } from "@gatekeep/shared";
import { getFirebase, EMU_HOST, STORAGE_BUCKET } from "../lib/firebase";
import type { StatusTone } from "../ui";

// Sub-project 6 task 11: the RN twin of apps/web/src/events/eventDisplay.ts
// and apps/web/src/events/ticketHolderAddress.ts, folded into one module
// (mobile has no server/client component boundary forcing a split, unlike
// web's own header comment on why plain display helpers live apart from
// "use client" hooks there). Task 12 (curator tiers/scanner/attendees)
// shares this file rather than duplicating its label maps, hence its home
// under src/events/ rather than src/tickets/.
//
// Money-sentence wording below is kept BYTE-IDENTICAL to the web twin
// (formatCents/formatTierPrice/tierFeeLine/eventSalesClosedReason): the
// controller's money-sentence colon-parity rule (sp9b ruling 7) extends to
// this sub-project's own new sentences, not just the ones ported in 9B.

// cents -> a dollar string, showing cents only when they're non-zero. Same
// duplicated-by-hand tradeoff as gigs/GigForms.tsx's own formatCents (and
// its web twin's header comment): this module and GigForms.tsx serve
// different features, neither may import the other's UI-adjacent module
// just for one function.
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

// A ticket tier's own display price: "Free" for a 0-priced tier (a legal
// RSVP tier) reads better than "$0" here.
export function formatTierPrice(priceCents: number): string {
  return priceCents <= 0 ? "Free" : formatCents(priceCents);
}

// Per-ticket service fee line, "+ $X.XX service fee" (byte-identical to the
// web twin). null for a free ticket. Preview only: createTicketOrder
// recomputes and stamps the real fee server-side at purchase time.
export function tierFeeLine(priceCents: number, policy: TicketFeePolicy): string | null {
  const feeCents = ticketServiceFeeCents(priceCents, policy);
  return feeCents > 0 ? `+ ${formatCents(feeCents)} service fee` : null;
}

export type TierAvailability = "on_sale" | "not_yet_open" | "sale_ended" | "sold_out";

// Pure display predicate mirroring functions/src/eventsCore.ts's tierOnSale
// window check plus the capacity check createTicketOrder itself applies.
// DISPLAY-ONLY: the server re-checks both, inside its own transaction, on
// every purchase attempt regardless of what this function says.
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

// Whether the event itself is closed to purchase, DISPLAY layer only
// (createTicketOrder's own event-level gate in functions/src/ticketing.ts
// is what's actually load-bearing). Byte-identical wording to the web twin.
export function eventSalesClosedReason(status: EventStatus, startsAt: number, now: number): string | null {
  if (status === "completed") return "This event has already happened.";
  if (startsAt <= now) return "Ticket sales have closed for this event.";
  return null;
}

// Time-only formatter (web's twin lives in app/u/[handle]/gigDisplay.ts as
// formatGigTime, a plain-to-plain import mobile has no equivalent module
// for; duplicated here rather than reaching into gigs/GigForms.tsx's
// date+time formatGigDateTime, which formats a different shape). Wrapped in
// try/catch per GigForms.tsx's own defensive note on Hermes's
// Intl.DateTimeFormat timeZone/formatToParts support not being
// independently verified on-device in this environment.
//
// Exported (Task 12): the door scanner's duplicate-scan result ("already
// checked in at 9:14 PM") and the attendee list's checked-in label both need
// a time-only render, mirroring web's AttendeeList.tsx checkedInLabel.
export function formatGigTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  try {
    const formatted = date.toLocaleString("en-US", { timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
    const tzName = new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, timeZoneName: "short" })
      .formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
    return tzName ? `${formatted} ${tzName}` : formatted;
  } catch {
    return date.toLocaleTimeString();
  }
}

// "7:00 PM–11:00 PM PDT", en dash per DESIGN.md's multi-part-figure
// convention (never an em dash).
export function formatEventTimeRange(startsAtMs: number, endsAtMs: number): string {
  return `${formatGigTime(startsAtMs)}–${formatGigTime(endsAtMs)}`;
}

// The full weekday + date, byte-identical to the web twin's own
// formatEventFullDate.
export function formatEventFullDate(startsAtMs: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: LAUNCH_TIMEZONE,
    }).format(new Date(startsAtMs));
  } catch {
    return new Date(startsAtMs).toDateString();
  }
}

// The compact form of the date above ("Sat, Sep 5"), for one-line contexts
// where the full weekday-month-day-year string would push everything else
// off the row: the swipe deck's "Next up" lines (SP7 Task 12). Same
// defensive try/catch as its sibling, same LAUNCH_TIMEZONE pin.
export function formatEventShortDate(startsAtMs: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric", timeZone: LAUNCH_TIMEZONE,
    }).format(new Date(startsAtMs));
  } catch {
    return new Date(startsAtMs).toDateString();
  }
}

// Status -> StatusBadge tone maps (mobile's StatusTone has no "outline"/
// "secondary" the web Badge variant set carries; "neutral" stands in for
// both here, same collapsing GIG_STATUS_TONE already does for this app's
// badge set).
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft", published: "Published", completed: "Completed", cancelled: "Cancelled",
};
export const EVENT_STATUS_TONE: Record<EventStatus, StatusTone> = {
  draft: "neutral", published: "success", completed: "neutral", cancelled: "destructive",
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  valid: "Confirmed", checked_in: "Checked in", refunded: "Refunded", transferred: "Transferred",
};
export const TICKET_STATUS_TONE: Record<TicketStatus, StatusTone> = {
  valid: "success", checked_in: "neutral", refunded: "destructive", transferred: "neutral",
};

// ---------- Ticket-holder address gate ----------
// RN port of apps/web/src/events/ticketHolderAddress.ts, verbatim in logic
// (the RN client SDK's doc/getDoc calls are byte-identical to the web
// firebase/firestore ones, only the import source differs).

export interface EventPrivateAddress { address: string; geo: { lat: number; lng: number } | null }

export function mapUrl(address: EventPrivateAddress): string {
  const q = address.geo ? `${address.geo.lat},${address.geo.lng}` : address.address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// A one-shot getDoc pair, not a live onSnapshot: this only needs to answer
// "does a ticket exist right now". `"hidden"` covers both "no uid yet" and
// "signed in but no ticket for this event", indistinguishable on purpose
// (the web twin's own contract: no ticket means no address block).
export function useTicketHolderAddress(eventId: string, uid: string | null): EventPrivateAddress | "hidden" {
  const [state, setState] = useState<EventPrivateAddress | "hidden">("hidden");
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    const { db } = getFirebase();
    (async () => {
      try {
        const idx = await getDoc(doc(db, `users/${uid}/ticketIndex/${eventId}`));
        if (!idx.exists()) { if (!cancelled) setState("hidden"); return; }
        const addr = await getDoc(doc(db, `events/${eventId}/private/address`));
        if (!cancelled) setState(addr.exists() ? (addr.data() as EventPrivateAddress) : "hidden");
      } catch (e) {
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.warn("ticket-holder address read failed", eventId, e);
        if (!cancelled) setState("hidden");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, uid]);
  return uid ? state : "hidden";
}

// ---------- Poster URL ----------
// Built from the path, never resolved with getDownloadURL (sp6 audit finding
// 16, spec 6.5): storage.rules' public/{kind}/{profileId}/{fileName} match
// grants an unauthenticated read, and this REST form is what Storage serves
// for a rules-allowed object with no token. RN twin of web's posterUrl.ts;
// SP7's cards adopt the same helper. Dev builds point at the Storage emulator
// on the host lib/firebase.ts already resolved for the other emulators.
export function posterPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = __DEV__ ? `http://${EMU_HOST}:9199` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}

/**
 * SP6 events/ticketing PRIMITIVES: the pure helper layer the events and
 * ticketing callables build on. Owns the timing constants (order hold, ticket
 * transfer hold, T+1 settle delay), QR secret minting, the ticket fee policy
 * snapshot point, and the input validators / order-item builder shared by the
 * create/update callables later tasks add.
 *
 * Deliberately pure: no Firestore reads/writes, no Stripe. Every function
 * here operates only on its arguments (and, for the two "must be in the
 * future" checks, Date.now()); callers own all persistence and side effects.
 */

import { randomBytes } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import {
  DEFAULT_TICKET_FEE_POLICY, GENRES,
  type EventAct, type TicketFeePolicy, type TicketOrderItem, type TicketTierDoc,
} from "@gatekeep/shared";

// How long a pending ticket order holds its tier inventory before it expires
// unpaid (mirrors SP5's accept-saga staging window in spirit, not in code).
export const ORDER_TTL_MS = 10 * 60 * 1000;
// How long an offered ticket transfer stays open before it expires back to the sender.
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
// T+1: how long after an event ends before its ticket revenue settles to the curator.
export const EVENT_SETTLE_DELAY_MS = 24 * 60 * 60 * 1000;
// Default cap on tickets one buyer may hold for a single event, absent an
// organizer-set override on the event doc.
export const DEFAULT_MAX_TICKETS_PER_BUYER = 8;

// SP6 Task 7: the "starts within" window for the event-tomorrow reminder
// step in scheduled.ts. Exported here, rather than kept module-private in
// scheduled.ts, so Task 5's updateEvent reschedule hook can re-arm a
// reminder that was already sent, using the identical window value.
export const EVENT_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

// SP6 Task 7: the adminAlerts id for "this event's T+1 ticket settlement
// transfer is blocked because its curator has no payout-ready Stripe
// account". Deterministic per event, same discipline as paymentsCore.ts's own
// alert-id vocabulary (stuckSagaAlertId and friends), kept here rather than
// beside that vocabulary so paymentsSweep.ts's ticket-settlement step never
// has to reach into an SP5 file for an SP6-only escalation.
export function ticketSettlementBlockedAlertId(eventId: string): string {
  return `ticket-settlement:${eventId}`;
}

// SP6 Task 7 fix round 1 (money review, Critical 1d): the adminAlerts id for
// "a T+1 ticket settlement transfer was attempted but Stripe returned an
// unexpected error". Distinct from ticketSettlementBlockedAlertId above (that
// one fires before Stripe is ever called; this one fires when the call was
// made and refused), so the two conditions never collapse into one row an
// operator has to disambiguate from the detail text alone.
export function ticketSettlementFailedAlertId(eventId: string): string {
  return `ticket-settlement-failed:${eventId}`;
}

// Server-minted ticket QR payload. Possession of this string is door proof
// (see TicketDoc.qrSecret): 32 random bytes, hex-encoded, so it is both
// unguessable and a plain string a QR code can carry.
export function mintQrSecret(): string {
  return randomBytes(32).toString("hex");
}

// The ticket fee policy SNAPSHOT stamped onto every TicketOrderDoc at
// creation. Mirrors paymentsCore.ts's currentFeePolicy (functions/src/
// paymentsCore.ts:143) in shape and in rationale: a spread of shared's
// DEFAULT_TICKET_FEE_POLICY rather than a hand-rolled literal, so this stays
// the single snapshot point later fee-constant changes never touch an
// existing order through. The spread also hands back a MUTABLE copy.
// DEFAULT_TICKET_FEE_POLICY is frozen, and returning it by reference would
// let a caller's spread-free write corrupt every later snapshot on a warm
// instance.
export function currentTicketFeePolicy(): TicketFeePolicy {
  return { ...DEFAULT_TICKET_FEE_POLICY };
}

// Untrusted onCall payload shape for createEvent/updateEvent. Matches the
// defensive-runtime convention used throughout functions/src and shared/
// validation.ts (a declared param type only binds trusted callers; the
// caller's actual request body can be any JSON value at runtime).
export function validateEventInput(input: {
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[];
}): void {
  if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.trim().length > 120) {
    throw new HttpsError("invalid-argument", "Title must be 1-120 characters.");
  }
  if (typeof input.description !== "string" || input.description.length > 4000) {
    throw new HttpsError("invalid-argument", "Description must be at most 4000 characters.");
  }
  if (typeof input.startsAt !== "number" || !Number.isFinite(input.startsAt)) {
    throw new HttpsError("invalid-argument", "A valid start time is required.");
  }
  if (typeof input.endsAt !== "number" || !Number.isFinite(input.endsAt) || input.endsAt <= input.startsAt) {
    throw new HttpsError("invalid-argument", "End time must be after the start time.");
  }
  // "In the future at create" only: an already-published event's startsAt is
  // never re-validated against the clock by this helper (later tasks own
  // whatever update-time rules apply once an event has gone live).
  if (input.startsAt <= Date.now()) {
    throw new HttpsError("invalid-argument", "Start time must be in the future.");
  }
  if (!Array.isArray(input.lineup) || input.lineup.length < 1 || input.lineup.length > 20) {
    throw new HttpsError("invalid-argument", "Lineup must have 1-20 acts.");
  }
  for (const act of input.lineup) {
    if (typeof act !== "object" || act === null
        || (act.kind !== "booking" && act.kind !== "external")) {
      throw new HttpsError("invalid-argument", "Invalid lineup act.");
    }
    if (typeof act.name !== "string" || act.name.trim().length < 1 || act.name.trim().length > 80) {
      throw new HttpsError("invalid-argument", "Act names must be 1-80 characters.");
    }
  }
  if (input.maxTicketsPerBuyer !== undefined) {
    if (typeof input.maxTicketsPerBuyer !== "number" || !Number.isInteger(input.maxTicketsPerBuyer)
        || input.maxTicketsPerBuyer < 1 || input.maxTicketsPerBuyer > 20) {
      throw new HttpsError("invalid-argument", "Max tickets per buyer must be 1-20.");
    }
  }
}

// Untrusted onCall payload: optional, 1-3 distinct known genres when present.
// A curator-set list wins over the derived-from-lineup genres (see
// computeEventGenres in events.ts); this only validates the shape.
export function validateCuratorGenres(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) {
    throw new HttpsError("invalid-argument", "Pick 1-3 genres.");
  }
  const seen = new Set<string>();
  for (const g of input) {
    if (typeof g !== "string" || !(GENRES as readonly string[]).includes(g) || seen.has(g)) {
      throw new HttpsError("invalid-argument", "Unknown or repeated genre.");
    }
    seen.add(g);
  }
  return [...seen];
}

// Untrusted onCall payload shape for a tier create/update. Same defensive
// rationale as validateEventInput above.
export function validateTierInput(t: {
  name: string; priceCents: number; capacity: number;
  saleStartsAt: number | null; saleEndsAt: number | null;
}): void {
  if (typeof t.name !== "string" || t.name.trim().length < 1 || t.name.trim().length > 40) {
    throw new HttpsError("invalid-argument", "Tier name must be 1-40 characters.");
  }
  // priceCents 0 is a legal free RSVP tier (TicketTierDoc's own comment).
  if (typeof t.priceCents !== "number" || !Number.isInteger(t.priceCents)
      || t.priceCents < 0 || t.priceCents > 50_000) {
    throw new HttpsError("invalid-argument", "Price must be a whole number of cents from 0 to 50,000.");
  }
  if (typeof t.capacity !== "number" || !Number.isInteger(t.capacity)
      || t.capacity < 1 || t.capacity > 10_000) {
    throw new HttpsError("invalid-argument", "Capacity must be a whole number from 1 to 10,000.");
  }
  if (t.saleStartsAt != null && (typeof t.saleStartsAt !== "number" || !Number.isFinite(t.saleStartsAt))) {
    throw new HttpsError("invalid-argument", "Invalid sale start time.");
  }
  if (t.saleEndsAt != null && (typeof t.saleEndsAt !== "number" || !Number.isFinite(t.saleEndsAt))) {
    throw new HttpsError("invalid-argument", "Invalid sale end time.");
  }
  // Ordered only when BOTH are set: either bound alone (or neither) is a
  // legal open-ended sale window (tierOnSale below treats a null bound as "no limit").
  if (t.saleStartsAt != null && t.saleEndsAt != null && t.saleEndsAt <= t.saleStartsAt) {
    throw new HttpsError("invalid-argument", "Sale end must be after sale start.");
  }
}

// Window check only, against the caller-supplied `now` (no Date.now() here:
// this one is a pure predicate a caller may evaluate against any instant, not
// just "right now"). The tier's own status (a draft/cancelled event's tiers
// are never on sale regardless of this window) is the CALLER's business, not
// this function's, per the brief note on tierOnSale's signature.
export function tierOnSale(t: TicketTierDoc, now: number): boolean {
  if (t.saleStartsAt != null && now < t.saleStartsAt) return false;
  if (t.saleEndsAt != null && now > t.saleEndsAt) return false;
  return true;
}

// Builds the order's line items from a caller's requested (tierId, quantity)
// pairs, resolving each against the event's live tiers. Pure: capacity/sold-
// count checks and the actual inventory decrement are the caller's business
// (they need a Firestore transaction); this only shapes and validates the
// order content itself.
export function buildOrderItems(
  tiers: Map<string, TicketTierDoc>,
  req: Array<{ tierId: string; quantity: number }>,
): TicketOrderItem[] {
  const seen = new Set<string>();
  const items: TicketOrderItem[] = [];
  for (const r of req) {
    const tier = tiers.get(r.tierId);
    if (!tier) {
      throw new HttpsError("invalid-argument", `Unknown ticket tier: ${r.tierId}.`);
    }
    if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 10) {
      throw new HttpsError("invalid-argument", "Quantity must be a whole number from 1 to 10 per tier.");
    }
    if (seen.has(r.tierId)) {
      throw new HttpsError("invalid-argument", "Duplicate tier in order.");
    }
    seen.add(r.tierId);
    items.push({ tierId: r.tierId, quantity: r.quantity, unitPriceCents: tier.priceCents, tierName: tier.name });
  }
  return items;
}

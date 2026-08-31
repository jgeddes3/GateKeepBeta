import { describe, it, expect } from "vitest";
import {
  ticketServiceFeeCents, ticketOrderTotals, DEFAULT_TICKET_FEE_POLICY,
  type TicketOrderItem,
} from "../src/index.js";

describe("ticketServiceFeeCents", () => {
  it("7% + 99c, capped at 399c", () => {
    expect(ticketServiceFeeCents(1200, DEFAULT_TICKET_FEE_POLICY)).toBe(183);   // min(84+99,399)
    expect(ticketServiceFeeCents(10000, DEFAULT_TICKET_FEE_POLICY)).toBe(399);  // min(700+99,399) -> cap
    expect(ticketServiceFeeCents(100, DEFAULT_TICKET_FEE_POLICY)).toBe(106);    // min(7+99,399)
  });
  it("free tickets carry no fee", () => {
    expect(ticketServiceFeeCents(0, DEFAULT_TICKET_FEE_POLICY)).toBe(0);
  });
});

describe("ticketOrderTotals", () => {
  it("sums face value and per-unit fees across line items", () => {
    const items: TicketOrderItem[] = [
      { tierId: "t1", quantity: 2, unitPriceCents: 2000, tierName: "General" },
      { tierId: "t2", quantity: 1, unitPriceCents: 0, tierName: "RSVP" },
    ];
    expect(ticketOrderTotals(items, DEFAULT_TICKET_FEE_POLICY)).toEqual({
      faceTotalCents: 4000, serviceFeeCents: 478,
    });
  });
  it("empty items totals zero", () => {
    expect(ticketOrderTotals([], DEFAULT_TICKET_FEE_POLICY)).toEqual({
      faceTotalCents: 0, serviceFeeCents: 0,
    });
  });
});

describe("DEFAULT_TICKET_FEE_POLICY", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_TICKET_FEE_POLICY)).toBe(true);
  });
});

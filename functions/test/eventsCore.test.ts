import { describe, it, expect } from "vitest";
import {
  ORDER_TTL_MS, TRANSFER_TTL_MS, EVENT_SETTLE_DELAY_MS, DEFAULT_MAX_TICKETS_PER_BUYER,
  mintQrSecret, currentTicketFeePolicy, validateEventInput, validateTierInput,
  tierOnSale, buildOrderItems,
} from "../src/eventsCore.js";
import { DEFAULT_TICKET_FEE_POLICY, type EventAct, type TicketTierDoc } from "@gatekeep/shared";

// Pure unit tests: no Firestore/emulator interaction. Every helper here is a
// plain function over plain data, matching paymentsCore.test.ts's
// currentFeePolicy/buildPaymentDoc describe blocks (the emulator-touching
// blocks in that file are for the OTHER, Firestore-backed helpers it also
// exports, not a suite-wide requirement).

describe("constants", () => {
  it("match the brief's exact values", () => {
    expect(ORDER_TTL_MS).toBe(10 * 60 * 1000);
    expect(TRANSFER_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(EVENT_SETTLE_DELAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_TICKETS_PER_BUYER).toBe(8);
  });
});

describe("mintQrSecret", () => {
  it("returns 64 hex characters (32 bytes)", () => {
    const secret = mintQrSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two calls differ", () => {
    expect(mintQrSecret()).not.toBe(mintQrSecret());
  });
});

describe("currentTicketFeePolicy", () => {
  it("snapshots DEFAULT_TICKET_FEE_POLICY", () => {
    expect(currentTicketFeePolicy()).toEqual(DEFAULT_TICKET_FEE_POLICY);
  });

  it("returns a fresh, mutable copy each call, never the frozen default by reference", () => {
    const a = currentTicketFeePolicy();
    const b = currentTicketFeePolicy();
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
  });
});

describe("validateEventInput", () => {
  const now = Date.now();
  const goodLineup: EventAct[] = [
    { kind: "external", name: "The Openers" },
    { kind: "booking", bookingId: "bk1", musicianProfileId: "mus1", name: "Headliner" },
  ];
  function goodInput(overrides: Partial<{
    title: string; description: string; startsAt: number; endsAt: number;
    maxTicketsPerBuyer?: number; lineup: EventAct[];
  }> = {}) {
    return {
      title: "A Night of Music",
      description: "Come on out.",
      startsAt: now + 7 * 24 * 60 * 60 * 1000,
      endsAt: now + 7 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000,
      lineup: goodLineup,
      ...overrides,
    };
  }

  it("accepts a good input", () => {
    expect(() => validateEventInput(goodInput())).not.toThrow();
  });

  it("accepts a good input with maxTicketsPerBuyer set", () => {
    expect(() => validateEventInput(goodInput({ maxTicketsPerBuyer: 4 }))).not.toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => validateEventInput(goodInput({ title: "" }))).toThrow(/Title/);
  });

  it("rejects a title over 120 characters", () => {
    expect(() => validateEventInput(goodInput({ title: "x".repeat(121) }))).toThrow(/Title/);
  });

  it("rejects a description over 4000 characters", () => {
    expect(() => validateEventInput(goodInput({ description: "x".repeat(4001) }))).toThrow(/Description/);
  });

  it("rejects endsAt not after startsAt", () => {
    expect(() => validateEventInput(goodInput({ endsAt: goodInput().startsAt }))).toThrow(/End time/);
  });

  it("rejects a startsAt that is not in the future", () => {
    expect(() => validateEventInput(goodInput({ startsAt: now - 1000, endsAt: now + 1000 }))).toThrow(/future/);
  });

  it("rejects a lineup with zero acts", () => {
    expect(() => validateEventInput(goodInput({ lineup: [] }))).toThrow(/Lineup/);
  });

  it("rejects a lineup with more than 20 acts", () => {
    const lineup: EventAct[] = Array.from({ length: 21 }, (_, i) => ({ kind: "external", name: `Act ${i}` }));
    expect(() => validateEventInput(goodInput({ lineup }))).toThrow(/Lineup/);
  });

  it("rejects an act name over 80 characters", () => {
    const lineup: EventAct[] = [{ kind: "external", name: "x".repeat(81) }];
    expect(() => validateEventInput(goodInput({ lineup }))).toThrow(/Act name/);
  });

  it("rejects an act name that is empty", () => {
    const lineup: EventAct[] = [{ kind: "external", name: "" }];
    expect(() => validateEventInput(goodInput({ lineup }))).toThrow(/Act name/);
  });

  it("rejects a maxTicketsPerBuyer of 0", () => {
    expect(() => validateEventInput(goodInput({ maxTicketsPerBuyer: 0 }))).toThrow(/Max tickets/);
  });

  it("rejects a maxTicketsPerBuyer over 20", () => {
    expect(() => validateEventInput(goodInput({ maxTicketsPerBuyer: 21 }))).toThrow(/Max tickets/);
  });
});

describe("validateTierInput", () => {
  function goodTier(overrides: Partial<{
    name: string; priceCents: number; capacity: number;
    saleStartsAt: number | null; saleEndsAt: number | null;
  }> = {}) {
    return { name: "General Admission", priceCents: 2500, capacity: 100, saleStartsAt: null, saleEndsAt: null, ...overrides };
  }

  it("accepts a good tier", () => {
    expect(() => validateTierInput(goodTier())).not.toThrow();
  });

  it("accepts a free tier (priceCents 0)", () => {
    expect(() => validateTierInput(goodTier({ priceCents: 0 }))).not.toThrow();
  });

  it("accepts an ordered sale window", () => {
    const now = Date.now();
    expect(() => validateTierInput(goodTier({ saleStartsAt: now, saleEndsAt: now + 1000 }))).not.toThrow();
  });

  it("rejects a negative price", () => {
    expect(() => validateTierInput(goodTier({ priceCents: -1 }))).toThrow(/Price/);
  });

  it("rejects a price over 50000 cents", () => {
    expect(() => validateTierInput(goodTier({ priceCents: 50_001 }))).toThrow(/Price/);
  });

  it("rejects zero capacity", () => {
    expect(() => validateTierInput(goodTier({ capacity: 0 }))).toThrow(/Capacity/);
  });

  it("rejects capacity over 10000", () => {
    expect(() => validateTierInput(goodTier({ capacity: 10_001 }))).toThrow(/Capacity/);
  });

  it("rejects an inverted sale window (end before start)", () => {
    const now = Date.now();
    expect(() => validateTierInput(goodTier({ saleStartsAt: now, saleEndsAt: now - 1000 })))
      .toThrow(/Sale end/);
  });

  it("rejects an inverted sale window (end equal to start)", () => {
    const now = Date.now();
    expect(() => validateTierInput(goodTier({ saleStartsAt: now, saleEndsAt: now })))
      .toThrow(/Sale end/);
  });

  it("rejects a tier name over 40 characters", () => {
    expect(() => validateTierInput(goodTier({ name: "x".repeat(41) }))).toThrow(/Tier name/);
  });
});

describe("tierOnSale", () => {
  const now = 1_700_000_000_000;
  function tier(overrides: Partial<TicketTierDoc> = {}): TicketTierDoc {
    return {
      name: "GA", priceCents: 1000, capacity: 100, soldCount: 0,
      saleStartsAt: null, saleEndsAt: null, sortOrder: 0, ...overrides,
    };
  }

  it("is true inside the sale window", () => {
    expect(tierOnSale(tier({ saleStartsAt: now - 1000, saleEndsAt: now + 1000 }), now)).toBe(true);
  });

  it("is false before saleStartsAt", () => {
    expect(tierOnSale(tier({ saleStartsAt: now + 1000, saleEndsAt: null }), now)).toBe(false);
  });

  it("is false after saleEndsAt", () => {
    expect(tierOnSale(tier({ saleStartsAt: null, saleEndsAt: now - 1000 }), now)).toBe(false);
  });

  it("is true when both bounds are null", () => {
    expect(tierOnSale(tier({ saleStartsAt: null, saleEndsAt: null }), now)).toBe(true);
  });
});

describe("buildOrderItems", () => {
  function tiers(): Map<string, TicketTierDoc> {
    const m = new Map<string, TicketTierDoc>();
    m.set("t1", { name: "General Admission", priceCents: 2500, capacity: 100, soldCount: 0, saleStartsAt: null, saleEndsAt: null, sortOrder: 0 });
    m.set("t2", { name: "VIP", priceCents: 10000, capacity: 20, soldCount: 0, saleStartsAt: null, saleEndsAt: null, sortOrder: 1 });
    return m;
  }

  it("maps price and tierName from the tier onto each order item", () => {
    const items = buildOrderItems(tiers(), [{ tierId: "t1", quantity: 2 }, { tierId: "t2", quantity: 1 }]);
    expect(items).toEqual([
      { tierId: "t1", quantity: 2, unitPriceCents: 2500, tierName: "General Admission" },
      { tierId: "t2", quantity: 1, unitPriceCents: 10000, tierName: "VIP" },
    ]);
  });

  it("rejects an unknown tier id", () => {
    expect(() => buildOrderItems(tiers(), [{ tierId: "nope", quantity: 1 }])).toThrow(/tier/i);
  });

  it("rejects a quantity below 1", () => {
    expect(() => buildOrderItems(tiers(), [{ tierId: "t1", quantity: 0 }])).toThrow(/Quantity/);
  });

  it("rejects a quantity above 10", () => {
    expect(() => buildOrderItems(tiers(), [{ tierId: "t1", quantity: 11 }])).toThrow(/Quantity/);
  });

  it("rejects a duplicate tierId across order lines", () => {
    expect(() => buildOrderItems(tiers(), [{ tierId: "t1", quantity: 1 }, { tierId: "t1", quantity: 1 }]))
      .toThrow(/Duplicate/);
  });
});

import { describe, it, expect } from "vitest";
import { validatePayoutShares, splitCents, payeeKey, shareHeldMessage, MAX_PAYOUT_SHARES, type PayoutShare } from "../src/index.js";

const members = new Set(["a", "b", "c"]);

describe("validatePayoutShares", () => {
  it("accepts integer percents summing to 100 over current members and one band fund", () => {
    const v = validatePayoutShares([
      { payee: { kind: "member", uid: "a" }, percent: 40 },
      { payee: { kind: "member", uid: "b" }, percent: 35 },
      { payee: { kind: "profile" }, percent: 25 },
    ], members);
    expect(v.ok).toBe(true);
  });
  it("rejects a bad sum, fractions, out-of-range, duplicates, non-members, two band funds, and empty", () => {
    const m = (uid: string, percent: number): PayoutShare => ({ payee: { kind: "member", uid }, percent });
    expect(validatePayoutShares([m("a", 50), m("b", 40)], members).ok).toBe(false);
    expect(validatePayoutShares([m("a", 50.5), m("b", 49.5)], members).ok).toBe(false);
    expect(validatePayoutShares([m("a", 0), m("b", 100)], members).ok).toBe(false);
    expect(validatePayoutShares([m("a", 50), m("a", 50)], members).ok).toBe(false);
    expect(validatePayoutShares([m("zz", 100)], members).ok).toBe(false);
    expect(validatePayoutShares([{ payee: { kind: "profile" }, percent: 50 }, { payee: { kind: "profile" }, percent: 50 }], members).ok).toBe(false);
    expect(validatePayoutShares([], members).ok).toBe(false);
    expect(validatePayoutShares("nope", members).ok).toBe(false);
    expect(validatePayoutShares([{ payee: { kind: "member", uid: 5 }, percent: 100 }], members).ok).toBe(false);
  });
  it("rejects more than MAX_PAYOUT_SHARES payees, and the reason mentions the cap", () => {
    const uids = Array.from({ length: 21 }, (_, i) => `m${i}`);
    const bigMembers = new Set(uids);
    const shares = uids.map((uid, i) => ({ payee: { kind: "member" as const, uid }, percent: i === 0 ? 20 : 4 }));
    const v = validatePayoutShares(shares, bigMembers);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain(String(MAX_PAYOUT_SHARES));
  });
});

describe("splitCents", () => {
  const shares: PayoutShare[] = [
    { payee: { kind: "member", uid: "a" }, percent: 33 },
    { payee: { kind: "member", uid: "b" }, percent: 33 },
    { payee: { kind: "profile" }, percent: 34 },
  ];
  it("floors each share and gives the remainder to the largest percent", () => {
    const parts = splitCents(1000, shares);
    expect(parts.map((p) => p.amountCents)).toEqual([330, 330, 340]);
    expect(splitCents(1001, shares).map((p) => p.amountCents)).toEqual([330, 330, 341]);
    expect(splitCents(1, shares).map((p) => p.amountCents)).toEqual([0, 0, 1]);
  });
  it("ties go to the first listed share and the sum is exact", () => {
    const even: PayoutShare[] = [
      { payee: { kind: "member", uid: "a" }, percent: 50 }, { payee: { kind: "member", uid: "b" }, percent: 50 },
    ];
    expect(splitCents(101, even).map((p) => p.amountCents)).toEqual([51, 50]);
    for (const n of [0, 7, 99, 12345]) expect(splitCents(n, shares).reduce((s, p) => s + p.amountCents, 0)).toBe(n);
  });
  it("a single 100 share gets everything", () => {
    expect(splitCents(555, [{ payee: { kind: "profile" }, percent: 100 }])).toEqual([{ payee: { kind: "profile" }, amountCents: 555 }]);
  });
});

describe("payee helpers", () => {
  it("keys payees and formats the held message", () => {
    expect(payeeKey({ kind: "profile" })).toBe("profile");
    expect(payeeKey({ kind: "member", uid: "a" })).toBe("member:a");
    expect(shareHeldMessage(1250, "Night Owls")).toBe("$12.50 from Night Owls is waiting for you. Set up payouts to receive it.");
  });
});

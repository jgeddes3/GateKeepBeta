export type PayoutPayee = { kind: "member"; uid: string } | { kind: "profile" };
export interface PayoutShare { payee: PayoutPayee; percent: number }
export const MAX_PAYOUT_SHARES = 20;

// This module imports nothing (types.ts imports PayoutShare from here, not
// the other way, to avoid a cycle), so these four SP5c message strings are
// defined here and messages.ts re-exports them, keeping both import paths
// (`@gatekeep/shared`'s messages.ts surface and payoutShares.ts's own
// validator) reading the exact same constant rather than two copies of the
// same English that could drift apart.
export const SHARES_SUM_MESSAGE = "Shares must add up to 100%.";
export const SHARES_MEMBER_MESSAGE = "Every share must belong to a current member.";
export const SHARES_ADMIN_MESSAGE = "Only a profile admin can change payout shares.";
export const MEMBER_PAYOUT_SETUP_REQUIRED_MESSAGE = "Set up payouts before cashing out.";

export function payeeKey(p: PayoutPayee): string { return p.kind === "profile" ? "profile" : `member:${p.uid}`; }

type Ok = { ok: true; shares: PayoutShare[] };
type Fail = { ok: false; reason: string };

export function validatePayoutShares(raw: unknown, memberUids: ReadonlySet<string>): Ok | Fail {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PAYOUT_SHARES) return { ok: false, reason: `Shares must list 1 to ${MAX_PAYOUT_SHARES} payees.` };
  const seen = new Set<string>();
  const shares: PayoutShare[] = [];
  let sum = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: "Invalid share." };
    const { payee, percent } = entry as { payee?: unknown; percent?: unknown };
    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) return { ok: false, reason: "Each share is a whole percent from 1 to 100." };
    if (typeof payee !== "object" || payee === null) return { ok: false, reason: "Invalid share." };
    const p = payee as { kind?: unknown; uid?: unknown };
    let clean: PayoutPayee;
    if (p.kind === "profile") clean = { kind: "profile" };
    else if (p.kind === "member" && typeof p.uid === "string" && memberUids.has(p.uid)) clean = { kind: "member", uid: p.uid };
    else return { ok: false, reason: SHARES_MEMBER_MESSAGE };
    const key = payeeKey(clean);
    if (seen.has(key)) return { ok: false, reason: key === "profile" ? "Only one band fund share." : "Each member appears once." };
    seen.add(key);
    shares.push({ payee: clean, percent });
    sum += percent;
  }
  if (sum !== 100) return { ok: false, reason: SHARES_SUM_MESSAGE };
  return { ok: true, shares };
}

// Floor every share, then hand the remainder cents to the largest percent
// (first listed on a tie), so the parts always sum to the input exactly.
export function splitCents(amountCents: number, shares: PayoutShare[]): Array<{ payee: PayoutPayee; amountCents: number }> {
  const parts = shares.map((s) => ({ payee: s.payee, amountCents: Math.floor((amountCents * s.percent) / 100) }));
  const remainder = amountCents - parts.reduce((sum, p) => sum + p.amountCents, 0);
  if (remainder > 0) {
    let largest = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i].percent > shares[largest].percent) largest = i;
    parts[largest].amountCents += remainder;
  }
  return parts;
}

export function formatShareCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
export function shareHeldMessage(cents: number, profileName: string): string {
  return `${formatShareCents(cents)} from ${profileName} is waiting for you. Set up payouts to receive it.`;
}

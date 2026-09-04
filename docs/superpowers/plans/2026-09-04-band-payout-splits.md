# Sub-project 5c: Band Payout Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standing per-member payout shares on a profile, applied at settlement as per-payee Stripe transfers (with held shares for members who have not onboarded), personal Express accounts and cash-out for members, per-order sourced ticket settlement, a ledger-backed payout history, and admin-only payout controls on both clients.

**Architecture:** One backend seam, `distributeEarnings`, replaces the direct transfer in booking settlement and in the new per-order ticket settlement; with no shares it makes today's single transfer under today's key. Member accounts live on `users/{uid}/private/stripe` and are routed by Express account metadata (`uid` vs `profileId`). Held shares are deterministic `heldShares` docs released by a trigger when the member's account becomes enabled. History is a member-gated callable over the ledger. Clients gain a shares editor, a per-user Payouts surface, and admin gating.

**Tech Stack:** pnpm monorepo; `packages/shared` (TypeScript, vitest); `functions` (Firebase Functions v2, firebase-admin 12, Node 22, FakeStripe in the emulator); `apps/web` (Next.js 16, React 19); `apps/mobile` (Expo SDK 57, expo-router); `tests-rules`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-band-payout-splits-design.md` (binding).

## Global Constraints

- **No em dashes anywhere**: code, comments, copy, docs, tests, commit messages, reports. CI fails a push containing one.
- Money rules from `sp5-rulings.md`: no client-supplied amount ever reaches Stripe unvalidated; Stripe calls never inside Firestore transactions; every Stripe write carries an attempt-scoped or otherwise unique idempotency key; the 24-hour idempotency cache means a retry that must move money again needs a new key; every absorbing or stuck state raises an `adminAlerts` row.
- `sp10b-rulings.md` ruling 5: a transfer is sourced from a charge only while it fits inside what remains of that charge; otherwise unsourced with `sourced: false` in its ledger row. Ruling 6: Connect-scope events (`account.updated`, `payout.*`) verify with the Connect secret; handlers pin `event.account` to the cached account id before acting.
- Payout authority: profile admins only for profile payouts, onboarding, and shares; the account owner only for member payouts. Members read balances, shares, held amounts, and history.
- `DESIGN.md` binds visuals; the antislop skills bind copy; both clients reuse the existing Earnings panel shapes; icons only through each app's icons module.
- Shared code via `@gatekeep/shared`; `functions` imports its own modules with `.js` extensions; both clients call callables through `callFn` (`src/lib/callable.ts`).
- With no shares set, every existing sub-5 and sub-6 test must pass unchanged in meaning; the only deliberate change to an existing assertion is ticket settlement becoming per order (Task 7 names the tests it rewrites).
- Commit after every task with a conventional message and the session's attribution trailer.
- Gates before merge: `pnpm typecheck` (5/5), shared tests, web tests, `pnpm emu:test`, `pnpm emu:rules`, web lint + build, mobile lint + `expo export --no-bytecode`.
- Emulator runs: one file at a time via `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run test/<file>"` with Java on PATH (`C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin`) and `FUNCTIONS_DISCOVERY_TIMEOUT=60`; check port 8080 is free first; never start `firebase emulators:start` by hand. A full `pnpm emu:test` exceeds the tool's foreground limit; the controller runs it through the detached runner.

---

## File structure

**Shared (`packages/shared/src`)**
- `payoutShares.ts` (new): `PayoutPayee`, `PayoutShare`, `MAX_PAYOUT_SHARES`, `payeeKey`, `validatePayoutShares`, `splitCents`.
- `types.ts`: `StripeProfileDoc.shares`, `MemberStripeDoc`, `HeldShareDoc` and `HeldShareRef`, `TransferState.legs`/`heldCents`, `TicketOrderDoc.chargeId`/`chargeAmountCents`/`settledAt`/`settlementLegs`, six `LedgerKind`s, `LedgerEntry.uid`/`orderId`, four `NotificationDoc` kinds and `refKind: "payouts"`, `AdminAlertKind` `held_share_release_failed`.
- `messages.ts`: five messages. `notificationHref.ts`: the payouts branch. `index.ts`: export.

**Backend (`functions/src`)**
- `payoutShares.ts` (new): `setPayoutShares`, `loadShares`, `distributeEarnings`, `releaseHeldShares`, `onMemberStripeWritten`, `reassignShareOnRemoval`.
- `memberPayouts.ts` (new): `getMemberStripeDoc`, `emptyMemberStripe`, `syncMemberAccountFlags`, `createMemberOnboardingLink`, `getMemberPayoutStatus`, `requestMemberPayout`, member branches of the payout webhooks.
- `payoutHistory.ts` (new): `getPayoutHistory`.
- `payments.ts` (`account.updated` routing), `paymentsPayouts.ts` (payout webhook routing by uid), `paymentsSettlement.ts` (distribute), `paymentsSweep.ts` (per-order ticket settlement), `ticketing.ts` (`chargeId` at completion), `members.ts` (share reassignment), `index.ts`.

**Rules and indexes**: `firestore.rules`, `firestore.indexes.json`, `tests-rules/payoutSplits.rules.test.ts`.

**Web**: `src/payments/useProfileRole.ts`, `SharesCard.tsx`, `PayoutHistoryList.tsx`, `MemberPayoutsCard.tsx`; `EarningsPanel.tsx`; `app/dashboard/earnings/page.tsx`; `app/dashboard/page.tsx`; `app/dashboard/payouts/onboarding/{return,refresh}/page.tsx`.

**Mobile**: `src/payments/useProfileRole.ts`, `SharesCard.tsx`, `PayoutHistoryList.tsx`, `MemberPayoutsPanel.tsx`; `EarningsPanel.tsx`; `app/(fan)/payouts.tsx`; `app/(fan)/_layout.tsx`; `src/shell/AccountScreen.tsx`; `src/notifications/push.ts`.

**Docs**: `README.md`, `docs/superpowers/HANDOFF.md`.

---

### Task 1: Shared shares module and types

**Files:**
- Create: `packages/shared/src/payoutShares.ts`
- Modify: `packages/shared/src/types.ts`, `messages.ts`, `notificationHref.ts`, `index.ts`
- Test: `packages/shared/test/payoutShares.test.ts`, `packages/shared/test/notificationHref.test.ts` (append)

**Interfaces:**
- Produces (every later task imports from `@gatekeep/shared`): `PayoutPayee`, `PayoutShare`, `MAX_PAYOUT_SHARES`, `payeeKey(payee)`, `validatePayoutShares(shares, memberUids)`, `splitCents(amountCents, shares)`, `MemberStripeDoc`, `HeldShareDoc`, `HeldShareRef`, `HeldShareStatus`, the new ledger and notification kinds, `SHARES_SUM_MESSAGE`, `SHARES_MEMBER_MESSAGE`, `SHARES_ADMIN_MESSAGE`, `MEMBER_PAYOUT_SETUP_REQUIRED_MESSAGE`, `shareHeldMessage(cents, name)`.

- [ ] **Step 1: Failing tests**

Create `packages/shared/test/payoutShares.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validatePayoutShares, splitCents, payeeKey, shareHeldMessage, type PayoutShare } from "../src/index.js";

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
```

Append to `packages/shared/test/notificationHref.test.ts`:

```ts
  it("routes payout kinds to the payouts surface", () => {
    for (const kind of ["share_paid", "share_held", "share_released", "member_payout_failed"] as const) {
      expect(notificationHref(kind, null, "web", "payouts")).toBe("/dashboard#payouts");
      expect(notificationHref(kind, null, "mobile", "payouts")).toBe("/(fan)/payouts");
    }
  });
```

Run `pnpm --filter @gatekeep/shared test`: FAIL (missing exports).

- [ ] **Step 2: Types**

In `packages/shared/src/types.ts`:

`StripeProfileDoc` gains (after `instantHoldUntil`):
```ts
  // SP5c: standing payout shares; absent or null means 100% to this profile's account.
  shares?: PayoutShare[] | null;
  sharesUpdatedAt?: number | null;
```
(import the type from `./payoutShares.js` at the top; `payoutShares.ts` must not import from `types.ts` to avoid a cycle, so it defines its own types and `types.ts` imports them.)

Add after `StripeProfileDoc`:
```ts
// SP5c: a person's own Express account, users/{uid}/private/stripe. Musician half only.
export interface MemberStripeDoc {
  accountId: string | null;
  transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  onboardingStartedAt: number | null; onboardedAt: number | null;
  lastPayout?: PayoutRequestRecord | null;
  instantHoldUntil?: number | null;
  updatedAt: number;
}

export type HeldShareRef = { bookingId: string; gigId: string } | { eventId: string; orderId: string };
export type HeldShareStatus = "held" | "released" | "failed";
// heldShares/{idempotencyBase}:{uid}. A member's share of a settlement that
// could not be transferred because their account is not enabled yet.
export interface HeldShareDoc {
  profileId: string; uid: string; amountCents: number;
  purpose: "earnings" | "ticket_settlement";
  ref: HeldShareRef;
  status: HeldShareStatus;
  createdAt: number; releasedAt: number | null; transferId: string | null; error?: string;
}
```

`TransferState` gains `legs?: number | null; heldCents?: number | null;`. `TicketOrderDoc` gains:
```ts
  // SP5c: stamped when the order is completed, for per-order sourced settlement.
  chargeId?: string | null; chargeAmountCents?: number | null;
  settledAt?: number | null; settlementLegs?: number | null;
```
`LedgerKind` gains `| "share_transfer" | "share_held" | "share_released" | "member_payout_standard" | "member_payout_instant" | "member_payout_failed"`. `LedgerEntry` gains `uid?: string | null; orderId?: string | null;`. `NotificationDoc.kind` gains `"share_paid" | "share_held" | "share_released" | "member_payout_failed"` and `refKind?: "event" | "gig" | "profile" | "payouts"`. `AdminAlertKind` gains `"held_share_release_failed"` with a doc comment ("a held share could not be transferred after the member's account was enabled; retried on the member's next status sync").

- [ ] **Step 3: `packages/shared/src/payoutShares.ts`**

```ts
export type PayoutPayee = { kind: "member"; uid: string } | { kind: "profile" };
export interface PayoutShare { payee: PayoutPayee; percent: number }
export const MAX_PAYOUT_SHARES = 20;

export function payeeKey(p: PayoutPayee): string { return p.kind === "profile" ? "profile" : `member:${p.uid}`; }

type Ok = { ok: true; shares: PayoutShare[] };
type Fail = { ok: false; reason: string };

export function validatePayoutShares(raw: unknown, memberUids: ReadonlySet<string>): Ok | Fail {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PAYOUT_SHARES) return { ok: false, reason: "Shares must list 1 to 20 payees." };
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
    else return { ok: false, reason: "Every share must belong to a current member." };
    const key = payeeKey(clean);
    if (seen.has(key)) return { ok: false, reason: key === "profile" ? "Only one band fund share." : "Each member appears once." };
    seen.add(key);
    shares.push({ payee: clean, percent });
    sum += percent;
  }
  if (sum !== 100) return { ok: false, reason: "Shares must add up to 100%." };
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
```

`messages.ts` appends:
```ts
// ---------- Sub-project 5c payout splits ----------
export const SHARES_SUM_MESSAGE = "Shares must add up to 100%.";
export const SHARES_MEMBER_MESSAGE = "Every share must belong to a current member.";
export const SHARES_ADMIN_MESSAGE = "Only a profile admin can change payout shares.";
export const MEMBER_PAYOUT_SETUP_REQUIRED_MESSAGE = "Set up payouts before cashing out.";
```
`notificationHref.ts` adds before the final `return null`:
```ts
  if (kind === "share_paid" || kind === "share_held" || kind === "share_released" || kind === "member_payout_failed") {
    return platform === "web" ? "/dashboard#payouts" : "/(fan)/payouts";
  }
```
`index.ts` adds `export * from "./payoutShares.js";`.

- [ ] **Step 4: Run, typecheck, build, commit**

`pnpm --filter @gatekeep/shared test` (PASS, all prior tests too), `typecheck`, `build`.

```bash
git add packages/shared
git commit -m "feat(shared): payout shares, member stripe and held share types, ledger and notification kinds"
```

---

### Task 2: Rules and indexes

**Files:**
- Modify: `firestore.rules`, `firestore.indexes.json`
- Test: `tests-rules/payoutSplits.rules.test.ts`

- [ ] **Step 1: Failing rules test**

```ts
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, query, where } from "firebase/firestore";

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

describe("users/{uid}/private/stripe", () => {
  it("owner reads, nobody else, no client writes", async () => {
    await seed("users/bob/private/stripe", { accountId: "acct_1", transfersEnabled: true, payoutsEnabled: true, instantEligible: false, onboardingStartedAt: 1, onboardedAt: 2, updatedAt: 2 });
    await assertSucceeds(getDoc(doc(env.authenticatedContext("bob").firestore(), "users/bob/private/stripe")));
    await assertFails(getDoc(doc(env.authenticatedContext("carol").firestore(), "users/bob/private/stripe")));
    await assertFails(setDoc(doc(env.authenticatedContext("bob").firestore(), "users/bob/private/stripe"), { accountId: "x" }));
  });
});

describe("heldShares", () => {
  it("the member and the profile's members read, others cannot, no client writes", async () => {
    await seed("profiles/band/members/alice", { uid: "alice", role: "admin", label: "", joinedAt: 1 });
    await seed("heldShares/k:bob", { profileId: "band", uid: "bob", amountCents: 500, purpose: "earnings", ref: { bookingId: "b", gigId: "g" }, status: "held", createdAt: 1, releasedAt: null, transferId: null });
    await assertSucceeds(getDoc(doc(env.authenticatedContext("bob").firestore(), "heldShares/k:bob")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "heldShares/k:bob")));
    await assertSucceeds(getDocs(query(collection(env.authenticatedContext("alice").firestore(), "heldShares"), where("profileId", "==", "band"))));
    await assertSucceeds(getDocs(query(collection(env.authenticatedContext("bob").firestore(), "heldShares"), where("uid", "==", "bob"))));
    await assertFails(getDoc(doc(env.authenticatedContext("carol").firestore(), "heldShares/k:bob")));
    await assertFails(setDoc(doc(env.authenticatedContext("bob").firestore(), "heldShares/k:bob"), { status: "released" }));
  });
  it("ledger stays admin-only", async () => {
    await seed("ledger/share_transfer:tr_1", { kind: "share_transfer", amountCents: 1, uid: "bob", profileId: "band", at: 1 });
    await assertFails(getDoc(doc(env.authenticatedContext("bob").firestore(), "ledger/share_transfer:tr_1")));
  });
});
```

- [ ] **Step 2: Rules**

Inside the `users/{uid}` block, after `pushTokens`:
```
      // SP5c: the person's own Express account flags and payout memo. Owner
      // read; server-write only.
      match /private/stripe {
        allow read: if isOwner(uid);
        allow write: if false; // Cloud Functions only
      }
```
After the `follows` block:
```
    // SP5c: a member's share of a settlement that is waiting for their
    // account to be enabled. The member, the profile's members, and admin
    // read it; the distribute and release paths write it.
    match /heldShares/{heldId} {
      allow read: if isAdmin()
        || (signedIn() && request.auth.uid == resource.data.uid)
        || isMember(resource.data.profileId);
      allow write: if false; // Cloud Functions only
    }
```
(List queries on `heldShares` are provable because each filter in the tests is an equality on `uid` or `profileId`; `isMember` uses a `get`, which is allowed per document.)

- [ ] **Step 3: Indexes**

Append to `indexes`:
```json
    { "collectionGroup": "ledger", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "profileId", "order": "ASCENDING" }, { "fieldPath": "at", "order": "DESCENDING" } ] },
    { "collectionGroup": "ledger", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "uid", "order": "ASCENDING" }, { "fieldPath": "at", "order": "DESCENDING" } ] },
    { "collectionGroup": "heldShares", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "uid", "order": "ASCENDING" }, { "fieldPath": "status", "order": "ASCENDING" } ] },
    { "collectionGroup": "heldShares", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "profileId", "order": "ASCENDING" }, { "fieldPath": "status", "order": "ASCENDING" } ] }
```
Validate the JSON parses.

- [ ] **Step 4: Run and commit**

`pnpm emu:rules` (PASS, previous count plus 3).
```bash
git add firestore.rules firestore.indexes.json tests-rules/payoutSplits.rules.test.ts
git commit -m "feat: member stripe and held share rules, ledger and held share indexes"
```

---

### Task 3: `setPayoutShares` and share reassignment on removal

**Files:**
- Create: `functions/src/payoutShares.ts` (the shares half; Task 5 appends the distribute half)
- Modify: `functions/src/members.ts`, `functions/src/index.ts`
- Test: `functions/test/payoutShares.test.ts`

**Interfaces:**
- Consumes: `validatePayoutShares`, `PayoutShare` from shared; `requireAuthUid`, `requireVerifiedEmail` from `./guards.js`; `requireProfileAdmin` from `./profiles.js`; `notifyProfileMembers` from `./notifications.js`.
- Produces: `setPayoutShares({ profileId, shares: PayoutShare[] | null })`, `loadShares(profileId): Promise<PayoutShare[] | null>`, `reassignShareOnRemoval(profileId, uid, now)`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile } from "./discoverFixtures";
import type { StripeProfileDoc, NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

export async function addMember(profileId: string, prefix: string, role: "admin" | "member" = "member") {
  const u = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await adb.doc(`profiles/${profileId}/members/${u.uid}`).set({ uid: u.uid, role, label: "bass", joinedAt: Date.now() });
  return u;
}
const stripeDoc = async (profileId: string) => (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;

describe("setPayoutShares", () => {
  it("admin sets, member cannot, validation runs against live members, null clears", async () => {
    const band = await makeApprovedMusicianProfile("ps1");
    const bass = await addMember(band.profileId, "ps1b");
    const shares = [
      { payee: { kind: "member", uid: band.owner.uid }, percent: 60 },
      { payee: { kind: "member", uid: bass.uid }, percent: 30 },
      { payee: { kind: "profile" }, percent: 10 },
    ];
    await callFn("setPayoutShares", { profileId: band.profileId, shares }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toEqual(shares);
    await expect(callFn("setPayoutShares", { profileId: band.profileId, shares }, bass.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    const stranger = await signUpTestUser(`ps1s-${Date.now()}@test.com`);
    await expect(callFn("setPayoutShares", { profileId: band.profileId, shares: [{ payee: { kind: "member", uid: stranger.uid }, percent: 100 }] }, band.owner.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await callFn("setPayoutShares", { profileId: band.profileId, shares: null }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toBeNull();
  });
});

describe("removeMember with a share", () => {
  it("moves the removed member's share to the band fund and tells the admins", async () => {
    const band = await makeApprovedMusicianProfile("ps2");
    const bass = await addMember(band.profileId, "ps2b");
    await callFn("setPayoutShares", { profileId: band.profileId, shares: [
      { payee: { kind: "member", uid: band.owner.uid }, percent: 70 },
      { payee: { kind: "member", uid: bass.uid }, percent: 30 },
    ] }, band.owner.user);
    await callFn("removeMember", { profileId: band.profileId, uid: bass.uid }, band.owner.user);
    expect((await stripeDoc(band.profileId))?.shares).toEqual([
      { payee: { kind: "member", uid: band.owner.uid }, percent: 70 },
      { payee: { kind: "profile" }, percent: 30 },
    ]);
    const notes = await adb.collection(`users/${band.owner.uid}/notifications`).where("kind", "==", "system").get();
    expect(notes.docs.some((d) => (d.data() as NotificationDoc).title === "Payout shares changed")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

`functions/src/payoutShares.ts`:

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { isValidDocId, validatePayoutShares, SHARES_ADMIN_MESSAGE, type PayoutShare, type StripeProfileDoc } from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileMembers } from "./notifications.js";

export async function loadShares(db: Firestore, profileId: string): Promise<PayoutShare[] | null> {
  const snap = await db.doc(`profiles/${profileId}/private/stripe`).get();
  const shares = (snap.data() as StripeProfileDoc | undefined)?.shares;
  return shares && shares.length > 0 ? shares : null;
}

async function memberUids(db: Firestore, profileId: string): Promise<Set<string>> {
  const snap = await db.collection(`profiles/${profileId}/members`).get();
  return new Set(snap.docs.map((d) => d.id));
}

export const setPayoutShares = onCall<{ profileId: string; shares: PayoutShare[] | null }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, shares } = req.data ?? ({} as { profileId: string; shares: null });
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    const member = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
    if (!member.exists || member.data()?.role !== "admin") throw new HttpsError("permission-denied", SHARES_ADMIN_MESSAGE);
    const db = getFirestore();
    const ref = db.doc(`profiles/${profileId}/private/stripe`);
    if (shares === null) {
      await ref.set({ shares: null, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
      return { ok: true };
    }
    const v = validatePayoutShares(shares, await memberUids(db, profileId));
    if (!v.ok) throw new HttpsError("invalid-argument", v.reason);
    await ref.set({ shares: v.shares, sharesUpdatedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    return { ok: true };
  });

// removeMember calls this after its transaction: the leaving member's percent
// joins the band fund so the shares still sum to 100.
export async function reassignShareOnRemoval(db: Firestore, profileId: string, uid: string, now: number): Promise<void> {
  const shares = await loadShares(db, profileId);
  if (!shares) return;
  const leaving = shares.find((s) => s.payee.kind === "member" && s.payee.uid === uid);
  if (!leaving) return;
  const rest = shares.filter((s) => s !== leaving);
  const fund = rest.find((s) => s.payee.kind === "profile");
  const next: PayoutShare[] = fund
    ? rest.map((s) => (s === fund ? { payee: s.payee, percent: s.percent + leaving.percent } : s))
    : [...rest, { payee: { kind: "profile" }, percent: leaving.percent }];
  await db.doc(`profiles/${profileId}/private/stripe`).set({ shares: next, sharesUpdatedAt: now, updatedAt: now }, { merge: true });
  try {
    await notifyProfileMembers(profileId, {
      kind: "system", title: "Payout shares changed",
      body: `A member left, so their ${leaving.percent}% share now goes to the band fund. Review the shares if that is not what you want.`,
    });
  } catch (e) {
    console.error(`reassignShareOnRemoval: notification failed for ${profileId}`, e);
  }
}
```

(`requireProfileAdmin` is imported for parity but the explicit member read above gives the shares-specific message; keep one or the other, not both, and remove the unused import.)

In `functions/src/members.ts` `removeMember`, after the transaction and before the curator sync:
```ts
    await reassignShareOnRemoval(db, profileId, uid, Date.now())
      .catch((e) => console.error(`removeMember: share reassignment failed for ${profileId}/${uid}`, e));
```
with `import { reassignShareOnRemoval } from "./payoutShares.js";`. `notifyProfileMembers` in `notifications.ts` notifies every member; the test asserts the admin received it, which holds. Add `export { setPayoutShares } from "./payoutShares.js";` to `index.ts`.

- [ ] **Step 3: Run, commit**

Emulator single-file run of `test/payoutShares.test.ts` and `test/members.test.ts` (or whichever file covers `removeMember`, via `grep -l removeMember functions/test/*.ts`). PASS.
```bash
git add functions/src/payoutShares.ts functions/src/members.ts functions/src/index.ts functions/test/payoutShares.test.ts
git commit -m "feat(functions): payout shares callable and share reassignment on member removal"
```

---

### Task 4: Member accounts, status, payouts, and webhook routing

**Files:**
- Create: `functions/src/memberPayouts.ts`
- Modify: `functions/src/payments.ts` (`account.updated`), `functions/src/paymentsPayouts.ts` (payout webhooks), `functions/src/index.ts`
- Test: `functions/test/memberPayouts.test.ts`

**Interfaces:**
- Consumes: `getStripe`, `writeLedger`, `recordAdminAlert` from `./paymentsCore.js` and `./stripeClient.js`; `webhookHandlers`, `webhookHandlerScopes` from `./paymentsWebhook.js`; `notifyUser`; the payout messages local to `paymentsPayouts.ts` (export them from there).
- Produces: `getMemberStripeDoc(uid)`, `emptyMemberStripe(now)`, `syncMemberAccountFlags(uid, now)` (returns the doc and whether `transfersEnabled` just flipped true), `createMemberOnboardingLink()`, `getMemberPayoutStatus()`, `requestMemberPayout({ amountCents, method, requestId })`, plus `readPayoutEvent` extended with `uid`. Task 5 calls `syncMemberAccountFlags`'s flip signal to release held shares.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { callFn, signUpTestUser } from "./helpers";
import type { MemberStripeDoc, LedgerEntry } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 30_000 });

const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";
function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}
async function postWebhook(body: unknown) {
  const isConnect = typeof (body as { account?: unknown } | null)?.account === "string";
  const res = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": isConnect ? "fake:connect" : "fake" }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
export const memberStripe = async (uid: string) => (await adb.doc(`users/${uid}/private/stripe`).get()).data() as MemberStripeDoc | undefined;
export async function enableMemberAccount(uid: string) {
  const ms = await memberStripe(uid);
  await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).set({ transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  const evt = { ...fakeEvent("account.updated", { id: ms!.accountId, metadata: { uid } }), account: ms!.accountId };
  expect((await postWebhook(evt)).status).toBe(200);
}

describe("member onboarding and status", () => {
  it("creates one account per user, syncs flags through account.updated, and ignores a forged account", async () => {
    const u = await signUpTestUser(`mp1-${Date.now()}@test.com`);
    const link = await callFn<object, { url: string }>("createMemberOnboardingLink", {}, u.user);
    expect(link.url).toContain("fake.stripe/onboard/");
    const first = await memberStripe(u.uid);
    expect(first?.accountId).toMatch(/^acct/);
    await callFn("createMemberOnboardingLink", {}, u.user);
    expect((await memberStripe(u.uid))?.accountId).toBe(first!.accountId);
    const forged = { ...fakeEvent("account.updated", { id: first!.accountId, metadata: { uid: u.uid } }), account: "acct_evil" };
    expect((await postWebhook(forged)).status).toBe(200);
    expect((await memberStripe(u.uid))?.transfersEnabled).toBe(false);
    await enableMemberAccount(u.uid);
    const after = await memberStripe(u.uid);
    expect(after).toMatchObject({ transfersEnabled: true, payoutsEnabled: true, instantEligible: true });
    expect(after?.onboardedAt).not.toBeNull();
    const status = await callFn<object, { hasAccount: boolean; payoutsEnabled: boolean; heldCents: number; availableBalanceCents: number | null }>("getMemberPayoutStatus", {}, u.user);
    expect(status).toMatchObject({ hasAccount: true, payoutsEnabled: true, heldCents: 0, availableBalanceCents: 0 });
  });
});

describe("requestMemberPayout", () => {
  it("pays out the owner's balance, replays by request id, refuses before setup, and routes payout.failed to the user", async () => {
    const u = await signUpTestUser(`mp2-${Date.now()}@test.com`);
    await expect(callFn("requestMemberPayout", { amountCents: 500, method: "standard", requestId: "req-aaaaaaa1" }, u.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await callFn("createMemberOnboardingLink", {}, u.user);
    await enableMemberAccount(u.uid);
    const ms = await memberStripe(u.uid);
    await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).set({ balanceCents: 2000 }, { merge: true });
    const res = await callFn<object, { payoutId: string; replayed: boolean; netCents: number }>("requestMemberPayout", { amountCents: 1500, method: "standard", requestId: "req-aaaaaaa1" }, u.user);
    expect(res).toMatchObject({ replayed: false, netCents: 1500 });
    const again = await callFn<object, { payoutId: string; replayed: boolean }>("requestMemberPayout", { amountCents: 1500, method: "standard", requestId: "req-aaaaaaa1" }, u.user);
    expect(again).toMatchObject({ payoutId: res.payoutId, replayed: true });
    expect(((await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).get()).data()?.balanceCents)).toBe(500);
    const rows = await adb.collection("ledger").where("uid", "==", u.uid).get();
    expect(rows.docs.map((d) => (d.data() as LedgerEntry).kind)).toContain("member_payout_standard");
    const failed = { ...fakeEvent("payout.failed", { id: res.payoutId, amount: 1500, metadata: { uid: u.uid }, failure_code: "account_closed" }), account: ms!.accountId };
    expect((await postWebhook(failed)).status).toBe(200);
    const notes = await adb.collection(`users/${u.uid}/notifications`).where("kind", "==", "member_payout_failed").get();
    expect(notes.size).toBe(1);
  });
});
```

- [ ] **Step 2: Implement `functions/src/memberPayouts.ts`**

Mirror `requestPayout` exactly with these substitutions: the doc is `users/${uid}/private/stripe` (`MemberStripeDoc`), the authority check is that the caller is the owner (the doc path is the caller's uid, no admin check), the idempotency keys are `${uid}:payout:${requestId}` and `${uid}:payoutfee:${requestId}`, ledger kinds `member_payout_standard`/`member_payout_instant` with `uid` set and `profileId: null`, the fee-uncollected alert id `member_payout_fee:${uid}:${requestId}` (kind `payout_fee_uncollected`), and the memo written to the member doc. Export the four payout messages from `paymentsPayouts.ts` instead of redeclaring them. Also:

```ts
export function emptyMemberStripe(now: number): MemberStripeDoc {
  return { accountId: null, transfersEnabled: false, payoutsEnabled: false, instantEligible: false, onboardingStartedAt: null, onboardedAt: null, updatedAt: now };
}
export async function getMemberStripeDoc(uid: string): Promise<MemberStripeDoc | null> {
  const snap = await getFirestore().doc(`users/${uid}/private/stripe`).get();
  return (snap.data() as MemberStripeDoc | undefined) ?? null;
}
// Returns the doc plus whether transfersEnabled flipped false -> true in this sync.
export async function syncMemberAccountFlags(uid: string, now: number): Promise<{ doc: MemberStripeDoc | null; enabledNow: boolean }> {
  const ms = await getMemberStripeDoc(uid);
  if (!ms?.accountId) return { doc: ms, enabledNow: false };
  let state;
  try { state = await getStripe().getAccountState(ms.accountId); }
  catch (e) {
    if (e instanceof StripeAccountMissingError) {
      await getFirestore().doc(`users/${uid}/private/stripe`).set({ transfersEnabled: false, payoutsEnabled: false, instantEligible: false, updatedAt: now }, { merge: true });
      return { doc: { ...ms, transfersEnabled: false, payoutsEnabled: false, instantEligible: false }, enabledNow: false };
    }
    console.error(`syncMemberAccountFlags: failed to read Stripe account state for user ${uid}`, e);
    return { doc: ms, enabledNow: false };
  }
  const next = { transfersEnabled: state.transfersEnabled, payoutsEnabled: state.payoutsEnabled, instantEligible: state.instantEligible, onboardedAt: ms.onboardedAt ?? (state.transfersEnabled ? now : null) };
  const changed = ms.transfersEnabled !== next.transfersEnabled || ms.payoutsEnabled !== next.payoutsEnabled || ms.instantEligible !== next.instantEligible || ms.onboardedAt !== next.onboardedAt;
  if (!changed) return { doc: ms, enabledNow: false };
  await getFirestore().doc(`users/${uid}/private/stripe`).set({ ...next, updatedAt: now }, { merge: true });
  return { doc: { ...ms, ...next, updatedAt: now }, enabledNow: !ms.transfersEnabled && next.transfersEnabled };
}
```

`createMemberOnboardingLink` (no input): `requireAuthUid`, `requireVerifiedEmail`; create the account with `stripe.createExpressAccount({ uid })` when the doc has no `accountId`, claiming it in a transaction on `users/${uid}/private/stripe` (create the doc from `emptyMemberStripe` if absent, set `accountId` and `onboardingStartedAt` only when still null; if another call won, use the stored id); `APP_ORIGIN` handling copied from `createOnboardingLink`; return `{ url }` from `stripe.createOnboardingLink(accountId, `${origin}/dashboard/payouts/onboarding/return`, `${origin}/dashboard/payouts/onboarding/refresh`)`.

`getMemberPayoutStatus` (no input): sync, then balances through `readPayoutBalances` (it accepts the profile doc shape; pass a structural object `{ accountId, payoutsEnabled }` or widen its parameter type to `{ accountId: string | null; payoutsEnabled: boolean } | null`), `heldCents` = sum of `heldShares` where `uid == uid` and `status in ["held", "failed"]`; when `enabledNow`, call `releaseHeldShares(uid, now)` (Task 5 adds it; until then import a stub that returns 0 and wire it in Task 5). Return `{ hasAccount, transfersEnabled, payoutsEnabled, instantEligible, availableBalanceCents, instantAvailableBalanceCents, heldCents }`.

Webhook routing:
- `payments.ts` `account.updated`: read `metadata.uid` as well; when present (and no `profileId`), validate `isValidDocId(uid)`, require the member doc's `accountId === accountId` and `account === accountId`, then `syncMemberAccountFlags(uid, now)` and, when `enabledNow`, `releaseHeldShares(uid, now)` (stub until Task 5).
- `paymentsPayouts.ts`: `readPayoutEvent` also returns `uid` from `metadata.uid`; add `eventAccountMatchesUser(account, uid)`; in `payout.paid` and `payout.failed`, when `uid` is present route to the member path: pin the account, ledger `member_payout_failed` with `uid`, `notifyUser(uid, { kind: "member_payout_failed", refKind: "payouts", title: "Payout failed", body: <same body as the profile message> })`.

Exports in `index.ts`: `export { createMemberOnboardingLink, getMemberPayoutStatus, requestMemberPayout } from "./memberPayouts.js";`.

- [ ] **Step 3: Run, commit**

Emulator runs: `test/memberPayouts.test.ts`, `test/payments.test.ts`, `test/paymentsPayouts.test.ts` (or the file that covers `requestPayout`; `grep -l requestPayout functions/test/*.ts`). PASS.
```bash
git add functions/src/memberPayouts.ts functions/src/payments.ts functions/src/paymentsPayouts.ts functions/src/index.ts functions/test/memberPayouts.test.ts
git commit -m "feat(functions): member Express accounts, status, payouts, and webhook routing by uid"
```

---

### Task 5: `distributeEarnings`, held shares, and release

**Files:**
- Modify: `functions/src/payoutShares.ts` (append), `functions/src/memberPayouts.ts` (wire release), `functions/src/payments.ts` (wire release), `functions/src/index.ts`
- Test: `functions/test/distribute.test.ts`

**Interfaces:**
- Consumes: Task 3's `loadShares`; Task 4's `getMemberStripeDoc`, `syncMemberAccountFlags`; `getStripe`, `writeLedger`, `recordAdminAlert`, `notifyUser`.
- Produces: `distributeEarnings(input: DistributeInput): Promise<DistributeResult>`, `releaseHeldShares(uid, now): Promise<number>`, trigger `onMemberStripeWritten`. Tasks 6 and 7 call `distributeEarnings`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedMusicianProfile } from "./discoverFixtures";
import { addMember } from "./payoutShares.test";
import { enableMemberAccount, memberStripe } from "./memberPayouts.test";
import { distributeEarnings } from "../src/payoutShares.js";
import type { HeldShareDoc, LedgerEntry, NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

const fakeBalance = async (accountId: string) => ((await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data()?.balanceCents as number | undefined) ?? 0;

describe("distributeEarnings", () => {
  it("pays enabled members, holds the rest, is idempotent per base, and releases on enable", async () => {
    const band = await makeApprovedMusicianProfile("di1");
    const bass = await addMember(band.profileId, "di1b");
    const drums = await addMember(band.profileId, "di1d");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    await enableMemberAccount(bass.uid);
    await callFn("setPayoutShares", { profileId: band.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 50 },
      { payee: { kind: "member", uid: drums.uid }, percent: 30 },
      { payee: { kind: "profile" }, percent: 20 },
    ] }, band.owner.user);
    const sp = (await adb.doc(`profiles/${band.profileId}/private/stripe`).get()).data()!;
    const base = `test:di1:${Date.now()}`;
    const input = {
      profileId: band.profileId, amountCents: 1001, source: null, purpose: "earnings" as const,
      ref: { bookingId: "b1", gigId: "g1" }, idempotencyBase: base, meta: { purpose: "earnings" }, profileAccountId: sp.accountId as string, now: Date.now(),
    };
    const r1 = await distributeEarnings(input);
    expect(r1.legs.map((l) => [l.payee.kind, l.amountCents, l.outcome])).toEqual([
      ["member", 501, "transferred"], ["member", 300, "held"], ["profile", 200, "transferred"],
    ]);
    const bassAcct = (await memberStripe(bass.uid))!.accountId!;
    expect(await fakeBalance(bassAcct)).toBe(501);
    expect(await fakeBalance(sp.accountId as string)).toBe(200);
    const held = (await adb.doc(`heldShares/${base}:${drums.uid}`).get()).data() as HeldShareDoc;
    expect(held).toMatchObject({ profileId: band.profileId, uid: drums.uid, amountCents: 300, status: "held" });
    const r2 = await distributeEarnings(input);
    expect(r2.legs).toEqual(r1.legs);
    expect(await fakeBalance(bassAcct)).toBe(501);
    const paidNote = await adb.collection(`users/${bass.uid}/notifications`).where("kind", "==", "share_paid").get();
    expect(paidNote.size).toBe(1);
    const heldNote = await adb.collection(`users/${drums.uid}/notifications`).where("kind", "==", "share_held").get();
    expect(heldNote.size).toBe(1);
    expect((heldNote.docs[0].data() as NotificationDoc).body).toContain("$3.00");

    await callFn("createMemberOnboardingLink", {}, drums.user);
    await enableMemberAccount(drums.uid);
    const drumsAcct = (await memberStripe(drums.uid))!.accountId!;
    const until = Date.now() + 15_000;
    let released: HeldShareDoc | undefined;
    for (;;) {
      released = (await adb.doc(`heldShares/${base}:${drums.uid}`).get()).data() as HeldShareDoc;
      if (released.status === "released" || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(released!.status).toBe("released");
    expect(await fakeBalance(drumsAcct)).toBe(300);
    const rows = await adb.collection("ledger").where("uid", "==", drums.uid).get();
    expect(rows.docs.map((d) => (d.data() as LedgerEntry).kind).sort()).toEqual(["share_held", "share_released"]);
  });

  it("with no shares makes a single transfer under the base key", async () => {
    const solo = await makeApprovedMusicianProfile("di2");
    const sp = (await adb.doc(`profiles/${solo.profileId}/private/stripe`).get()).data()!;
    const r = await distributeEarnings({ profileId: solo.profileId, amountCents: 700, source: null, purpose: "earnings", ref: { bookingId: "b", gigId: "g" }, idempotencyBase: `test:di2:${Date.now()}`, meta: {}, profileAccountId: sp.accountId as string, now: Date.now() });
    expect(r.legs).toHaveLength(1);
    expect(r.transferId).toMatch(/^tr/);
    expect(await fakeBalance(sp.accountId as string)).toBe(700);
  });
});
```

(`makeApprovedMusicianProfile` does not create a Stripe account; call `callFn("createOnboardingLink", { profileId }, owner.user)` in the test before reading `sp.accountId`, and flip its fake flags the way `makeMoneyReady` does.)

- [ ] **Step 2: Append to `functions/src/payoutShares.ts`**

```ts
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { splitCents, payeeKey, shareHeldMessage, formatShareCents, type HeldShareDoc, type HeldShareRef, type PayoutPayee, type MemberStripeDoc, type ProfileDoc } from "@gatekeep/shared";
import { getStripe } from "./stripeClient.js";
import { writeLedger, recordAdminAlert } from "./paymentsCore.js";
import { notifyUser } from "./notifications.js";
import { getMemberStripeDoc } from "./memberPayouts.js";

export interface DistributeInput {
  profileId: string; amountCents: number;
  source: { chargeId: string; remainingCents: number } | null;
  purpose: "earnings" | "ticket_settlement";
  ref: HeldShareRef;
  idempotencyBase: string;
  meta: Record<string, string>;
  profileAccountId: string;
  now: number;
}
export interface DistributeLeg { payee: PayoutPayee; amountCents: number; outcome: "transferred" | "held"; transferId: string | null; sourced: boolean }
export interface DistributeResult { legs: DistributeLeg[]; transferId: string | null; sourcedAny: boolean; heldCents: number }

function refFields(ref: HeldShareRef) {
  return "bookingId" in ref
    ? { bookingId: ref.bookingId, gigId: ref.gigId, eventId: null, orderId: null }
    : { bookingId: null, gigId: null, eventId: ref.eventId, orderId: ref.orderId };
}

export async function distributeEarnings(input: DistributeInput): Promise<DistributeResult> {
  const db = getFirestore();
  const stripe = getStripe();
  const shares = await loadShares(db, input.profileId);
  const fits = (cents: number, remaining: number) => input.source !== null && cents <= remaining;
  if (!shares) {
    const sourced = fits(input.amountCents, input.source?.remainingCents ?? 0);
    const t = await stripe.transferToAccount({
      accountId: input.profileAccountId, amountCents: input.amountCents, idempotencyKey: input.idempotencyBase, meta: input.meta,
      ...(sourced ? { sourceChargeId: input.source!.chargeId } : {}),
    });
    return { legs: [{ payee: { kind: "profile" }, amountCents: input.amountCents, outcome: "transferred", transferId: t.id, sourced }], transferId: t.id, sourcedAny: sourced, heldCents: 0 };
  }
  const profileName = ((await db.doc(`profiles/${input.profileId}`).get()).data() as ProfileDoc | undefined)?.name ?? "your band";
  let remaining = input.source?.remainingCents ?? 0;
  const legs: DistributeLeg[] = [];
  let heldCents = 0;
  for (const part of splitCents(input.amountCents, shares)) {
    if (part.amountCents <= 0) continue;
    const key = `${input.idempotencyBase}:share:${payeeKey(part.payee)}`;
    let accountId: string | null = null;
    if (part.payee.kind === "profile") accountId = input.profileAccountId;
    else {
      const ms: MemberStripeDoc | null = await getMemberStripeDoc(part.payee.uid);
      accountId = ms?.accountId && ms.transfersEnabled ? ms.accountId : null;
    }
    if (!accountId) {
      const uid = (part.payee as { uid: string }).uid;
      const heldRef = db.doc(`heldShares/${input.idempotencyBase}:${uid}`);
      const held: HeldShareDoc = { profileId: input.profileId, uid, amountCents: part.amountCents, purpose: input.purpose, ref: input.ref, status: "held", createdAt: input.now, releasedAt: null, transferId: null };
      try { await heldRef.create(held); }
      catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
      await writeLedger({ kind: "share_held", amountCents: part.amountCents, profileId: input.profileId, uid, stripeId: null, ...refFields(input.ref), detail: `share held for ${uid} until their payouts are set up`, at: input.now })
        .catch((e) => console.error(`distributeEarnings: share_held ledger row failed for ${key}`, e));
      await notifyUser(uid, { kind: "share_held", refKind: "payouts", title: "Money is waiting for you", body: shareHeldMessage(part.amountCents, profileName) }, `share_held:${key}`)
        .catch((e) => console.error(`distributeEarnings: share_held notification failed for ${key}`, e));
      legs.push({ payee: part.payee, amountCents: part.amountCents, outcome: "held", transferId: null, sourced: false });
      heldCents += part.amountCents;
      continue;
    }
    const sourced = fits(part.amountCents, remaining);
    const t = await stripe.transferToAccount({
      accountId, amountCents: part.amountCents, idempotencyKey: key, meta: { ...input.meta, payee: payeeKey(part.payee) },
      ...(sourced ? { sourceChargeId: input.source!.chargeId } : {}),
    });
    if (sourced) remaining -= part.amountCents;
    const uid = part.payee.kind === "member" ? part.payee.uid : null;
    await writeLedger({ kind: "share_transfer", amountCents: part.amountCents, profileId: input.profileId, uid, stripeId: t.id, sourced, ...refFields(input.ref), detail: `${payeeKey(part.payee)} share of ${input.purpose}${sourced ? ", sourced from the charge" : ", drawn on the platform balance"}`, at: input.now })
      .catch((e) => console.error(`distributeEarnings: share_transfer ledger row failed for ${key}`, e));
    if (uid) {
      await notifyUser(uid, { kind: "share_paid", refKind: "payouts", title: "You were paid", body: `${formatShareCents(part.amountCents)} from ${profileName}.` }, `share_paid:${key}`)
        .catch((e) => console.error(`distributeEarnings: share_paid notification failed for ${key}`, e));
    }
    legs.push({ payee: part.payee, amountCents: part.amountCents, outcome: "transferred", transferId: t.id, sourced });
  }
  return { legs, transferId: legs.find((l) => l.transferId)?.transferId ?? null, sourcedAny: legs.some((l) => l.sourced), heldCents };
}

// Transfers every held (or previously failed) share of a user once their
// account can receive transfers. Unsourced by then: the charge is long gone.
export async function releaseHeldShares(uid: string, now: number): Promise<number> {
  const db = getFirestore();
  const ms = await getMemberStripeDoc(uid);
  if (!ms?.accountId || !ms.transfersEnabled) return 0;
  const snap = await db.collection("heldShares").where("uid", "==", uid).where("status", "in", ["held", "failed"]).get();
  let releasedCents = 0;
  for (const d of snap.docs) {
    const held = d.data() as HeldShareDoc;
    try {
      const t = await getStripe().transferToAccount({ accountId: ms.accountId, amountCents: held.amountCents, idempotencyKey: `held:${d.id}`, meta: { purpose: "held_share", heldId: d.id, profileId: held.profileId, uid } });
      await d.ref.update({ status: "released", releasedAt: now, transferId: t.id, error: FieldValue.delete() });
      await writeLedger({ kind: "share_released", amountCents: held.amountCents, profileId: held.profileId, uid, stripeId: t.id, sourced: false, ...refFields(held.ref), detail: "held share released after payout setup", at: now })
        .catch((e) => console.error(`releaseHeldShares: ledger row failed for ${d.id}`, e));
      releasedCents += held.amountCents;
    } catch (e) {
      await d.ref.update({ status: "failed", error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
      const shouldLog = await recordAdminAlert({ alertId: `held_share:${d.id}`, kind: "held_share_release_failed", detail: `held share ${d.id} (${held.amountCents}c for ${uid}) could not be transferred: ${e instanceof Error ? e.message : String(e)}; retried on the member's next status sync`, bookingId: null, gigId: null, now });
      if (shouldLog) console.error(`releaseHeldShares: ${d.id} failed`, e);
    }
  }
  if (releasedCents > 0) {
    await notifyUser(uid, { kind: "share_released", refKind: "payouts", title: "Held money released", body: `${formatShareCents(releasedCents)} that was waiting for you is now in your balance.` }, `share_released:${uid}:${now}`)
      .catch((e) => console.error(`releaseHeldShares: notification failed for ${uid}`, e));
  }
  return releasedCents;
}

export const onMemberStripeWritten = onDocumentWritten("users/{uid}/private/stripe", async (event) => {
  const uid = event.params.uid;
  try {
    const before = event.data?.before.data() as MemberStripeDoc | undefined;
    const after = event.data?.after.data() as MemberStripeDoc | undefined;
    if (after?.transfersEnabled === true && before?.transfersEnabled !== true) await releaseHeldShares(uid, Date.now());
  } catch (e) {
    console.error("releaseHeldShares: trigger failed", uid, e);
  }
});
```

(`FieldValue` from `firebase-admin/firestore`.) Wire `releaseHeldShares` into Task 4's two stub call sites (`getMemberPayoutStatus` when `enabledNow`, the `account.updated` member branch); the trigger also fires from the sync's own write, and the `held:${docId}` key plus the status check make the double path idempotent. Export `onMemberStripeWritten` from `index.ts`.

- [ ] **Step 3: Run, commit**

Emulator runs: `test/distribute.test.ts`, `test/memberPayouts.test.ts`. PASS. If importing `payoutShares.test`/`memberPayouts.test` for their helpers re-runs those suites, move `addMember`, `enableMemberAccount`, and `memberStripe` into `functions/test/discoverFixtures.ts` (with `postWebhook`/`fakeEvent` moved to `helpers.ts`) and import from there in all three files.
```bash
git add functions/src/payoutShares.ts functions/src/memberPayouts.ts functions/src/payments.ts functions/src/index.ts functions/test
git commit -m "feat(functions): distributeEarnings with held shares and release on account enable"
```

---

### Task 6: Booking settlement through `distributeEarnings`

**Files:**
- Modify: `functions/src/paymentsSettlement.ts` (the transfer block in `finalizeSettlementSuccess`, lines ~700-728 and 787-838)
- Test: `functions/test/paymentsSettlementSplits.test.ts`

**Interfaces:**
- Consumes: `distributeEarnings` (Task 5); the existing `sourceCandidate`, `math`, `musicianStripe`, `recordRacedSettlement`, `setSelfDealInstantHold`.
- Produces: `PaymentDoc.transfer.legs` and `transfer.heldCents` populated; the `earnings_transfer` summary row's `sourced` reflects whether any leg was sourced.

- [ ] **Step 1: Failing test**

Reuse `paymentsSettlement.test.ts`'s fixtures (`makeEndedBooking`, `scheduleSettlement`, `chargeSettlement`, `getPayment`, `ledgerRows`, `fakeObject`, `BASE_CENTS`): copy the small helper block into the new file (or export them from the existing file if that does not re-run its suites; the report must say which).

```ts
describe("booking settlement with shares", () => {
  it("splits a sourced settlement into per-member transfers, records legs, and holds an unonboarded member", async () => {
    const b = await makeEndedBooking("spl1");
    const bass = await addMember(b.musician.profileId, "spl1b");
    const drums = await addMember(b.musician.profileId, "spl1d");
    await callFn("createMemberOnboardingLink", {}, bass.user);
    await enableMemberAccount(bass.uid);
    await callFn("setPayoutShares", { profileId: b.musician.profileId, shares: [
      { payee: { kind: "member", uid: bass.uid }, percent: 45 },
      { payee: { kind: "member", uid: drums.uid }, percent: 45 },
      { payee: { kind: "profile" }, percent: 10 },
    ] }, b.musician.owner.user);
    await scheduleSettlement(b.bookingId, b.gigId);
    expect(await chargeSettlement({ bookingId: b.bookingId, gigId: b.gigId, now: Date.now() })).toEqual({ outcome: "charged", transferred: true });
    const paid = (await getPayment(b.bookingId, b.gigId))!;
    expect(paid.transfer.status).toBe("transferred");
    expect(paid.transfer.legs).toBe(3);
    expect(paid.transfer.heldCents).toBeGreaterThan(0);
    const rows = await ledgerRows(b.bookingId);
    const legs = rows.filter((r) => r.kind === "share_transfer");
    expect(legs).toHaveLength(2);
    expect(legs.every((r) => r.sourced === true)).toBe(true);
    expect(rows.find((r) => r.kind === "share_held")?.uid).toBe(drums.uid);
    expect(rows.find((r) => r.kind === "earnings_transfer")?.sourced).toBe(true);
    const bassRow = legs.find((r) => r.uid === bass.uid)!;
    expect(await fakeObject(bassRow.stripeId!).then((t) => t?.sourceChargeId)).toBe(paid.settlement.intentId ? (await fakeObject(paid.settlement.intentId))?.chargeId : undefined);
    const total = legs.reduce((s, r) => s + r.amountCents, 0) + (rows.find((r) => r.kind === "share_held")?.amountCents ?? 0);
    expect(total).toBe(paid.transfer.amountCents);
  });
});
```

- [ ] **Step 2: Implement**

Replace the `const transfer = math.earnings > 0 ? await getStripe().transferToAccount({...}) : null;` block with:

```ts
  const dist = math.earnings > 0
    ? await distributeEarnings({
      profileId: p.musicianProfileId, amountCents: math.earnings,
      source: sourceCandidate ? { chargeId: sourceCandidate.id, remainingCents: sourceCandidate.amountCents } : null,
      purpose: "earnings", ref: { bookingId, gigId },
      idempotencyBase: `${bookingId}:${gigId}:earn:${p.settlement.attempts}`,
      meta: { bookingId, gigId, purpose: "earnings" },
      profileAccountId: musicianStripe!.accountId!, now,
    })
    : null;
  const transfer = dist ? { id: dist.transferId ?? `held:${bookingId}:${gigId}:${p.settlement.attempts}` } : null;
  const sourceChargeId = dist?.sourcedAny ? sourceCandidate!.id : null;
```

(Delete the old `sourceChargeId` line; keep `sourceCandidate`.) In the `updates` block add `updates["transfer.legs"] = dist!.legs.length; updates["transfer.heldCents"] = dist!.heldCents;` inside `if (transfer)`. The `earnings_transfer` summary row keeps `stripeId: transfer.id` (a `held:` pseudo id falls through `writeLedger`'s safe-id check to a random doc id, which is acceptable for an all-held settlement) and `sourced: sourceChargeId != null`. Everything else in the function is unchanged.

- [ ] **Step 3: Run the new file and the existing settlement suites**

Emulator runs: `test/paymentsSettlementSplits.test.ts`, `test/paymentsSettlement.test.ts`, and `test/paymentsSweep.test.ts` (or `grep -l chargeSettlement functions/test/*.ts`). With no shares set, every existing assertion must pass unchanged. PASS.
```bash
git add functions/src/paymentsSettlement.ts functions/test/paymentsSettlementSplits.test.ts
git commit -m "feat(functions): booking settlement distributes earnings by payout shares"
```

---

### Task 7: Per-order ticket settlement

**Files:**
- Modify: `functions/src/ticketing.ts` (`completeOrderTx`), `functions/src/paymentsSweep.ts` (`settleOneEvent`)
- Test: `functions/test/eventsSettlement.test.ts` (rewrite the per-event assertions), `functions/test/eventsSettlementOrders.test.ts` (new)

**Interfaces:**
- Consumes: `distributeEarnings`; `getStripe().retrieveIntent`; the existing claim helpers and alerts.
- Produces: `TicketOrderDoc.chargeId`, `chargeAmountCents`, `settledAt`, `settlementLegs`; one `ticket_settlement` ledger row per order carrying `orderId`; `PaymentsSweepReport.ticketOrdersSettled`.

- [ ] **Step 1: Failing test**

`functions/test/eventsSettlementOrders.test.ts`, reusing `eventsSettlement.test.ts`'s helpers (`makeDraftEvent`, `addTiersAndPublish`, `tierIdByName`, `makeBuyer`, `payOrder`, `pushEventPastSettleWindow`, `runPaymentsSweep`, `ledgerRowsForEvent`, `adb`), moved into `discoverFixtures.ts` or a new `functions/test/ticketFixtures.ts` if not already exported:

```ts
describe("per-order ticket settlement", () => {
  it("settles each paid order with its own sourced transfer, skips refunds and free orders, resumes after a failed order", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ord1");
    await makeCuratorPayoutReady(profileId, owner.user);   // createOnboardingLink + fake flags, like makeMoneyReady's musician half
    await addTiersAndPublish(profileId, eventId, owner.user, [
      { name: "GA", priceCents: 2000, capacity: 50, saleStartsAt: null, saleEndsAt: null },
      { name: "Free", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null },
    ]);
    const ga = await tierIdByName(eventId, "GA"); const free = await tierIdByName(eventId, "Free");
    const a = await makeBuyer("ord1a"); const b = await makeBuyer("ord1b"); const c = await makeBuyer("ord1c");
    const orderA = await payOrder(eventId, ga, 2, a.user);
    const orderB = await payOrder(eventId, ga, 1, b.user);
    const orderF = await payOrder(eventId, free, 1, c.user);
    expect((await adb.doc(`orders/${orderA}`).get()).data()?.chargeId).toMatch(/^ch/);
    // Break order B's charge so its transfer refuses, then settle.
    const realCharge = (await adb.doc(`orders/${orderB}`).get()).data()!.chargeId as string;
    await adb.doc(`orders/${orderB}`).update({ chargeId: "ch_missing" });
    await pushEventPastSettleWindow(eventId);
    await runPaymentsSweep(Date.now());
    let oa = (await adb.doc(`orders/${orderA}`).get()).data()!;
    expect(oa.settledAt).toBeTypeOf("number");
    expect((await adb.doc(`orders/${orderB}`).get()).data()!.settledAt).toBeUndefined();
    expect((await adb.doc(`events/${eventId}`).get()).data()!.status).toBe("published");
    await adb.doc(`orders/${orderB}`).update({ chargeId: realCharge });
    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: FieldValue.delete() });
    await runPaymentsSweep(Date.now());
    const ev = (await adb.doc(`events/${eventId}`).get()).data()!;
    expect(ev.status).toBe("completed");
    const rows = await ledgerRowsForEvent(eventId, "ticket_settlement");
    expect(rows.map((r) => r.orderId).sort()).toEqual([orderA, orderB].sort());
    expect(rows.every((r) => r.sourced === true)).toBe(true);
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(6000);
    expect((await adb.doc(`orders/${orderF}`).get()).data()!.settlementLegs).toBe(0);
    oa = (await adb.doc(`orders/${orderA}`).get()).data()!;
    expect(oa.settlementLegs).toBe(1);
  });
});
```

Also update `eventsSettlement.test.ts`'s "settles the face value of the non-refunded tickets" test: it now expects one `ticket_settlement` row per paid order whose amounts sum to the face value, and the settlement idempotency key per order (`ticket_settlement:${eventId}:${orderId}`) where it asserted the per-event key. Keep every other assertion.

- [ ] **Step 2: Implement**

`ticketing.ts` `completeOrderTx`: after confirming the order is `pending` with a `paymentIntentId`, before or inside the transaction's write, resolve `const intent = await getStripe().retrieveIntent(order.paymentIntentId)` (outside the transaction, Stripe calls never inside) and include `chargeId: intent?.chargeId ?? null, chargeAmountCents: intent?.amountCents ?? null` in the `paid` update. (If `completeOrderTx` currently takes no Stripe client, add the call before the transaction and pass the values in.)

`paymentsSweep.ts` `settleOneEvent`, replacing everything from `const ordersSnap = ...` through the `ticket_settlement` ledger write:

```ts
  const ordersSnap = await db.collection("orders").where("eventId", "==", doc.id).where("status", "==", "paid").get();
  const pending = ordersSnap.docs.filter((o) => (o.data() as TicketOrderDoc).settledAt == null);
  const owedCents = pending.reduce((s, o) => { const od = o.data() as TicketOrderDoc; return s + Math.max(0, od.faceTotalCents - od.refundedFaceCents); }, 0);

  if (owedCents > 0) {
    const curatorStripe = await getStripeProfileDoc(event.curatorProfileId);
    if (!curatorStripe?.accountId || curatorStripe.transfersEnabled !== true) {
      // unchanged: the blocked alert, the "finish payout setup" notification, report.ticketSettlementsBlocked++, return
    }
    const { claim, claimedAt } = await claimSettlementStart(db, doc.ref, now);
    if (claim === "not_published") return;

    for (const orderDoc of pending) {
      const order = orderDoc.data() as TicketOrderDoc;
      const amount = Math.max(0, order.faceTotalCents - order.refundedFaceCents);
      if (amount === 0) { await orderDoc.ref.update({ settledAt: now, settlementLegs: 0 }); continue; }
      let chargeId = order.chargeId ?? null; let chargeAmountCents = order.chargeAmountCents ?? null;
      if (!chargeId && order.paymentIntentId) {
        const intent = await getStripe().retrieveIntent(order.paymentIntentId).catch(() => null);
        chargeId = intent?.chargeId ?? null; chargeAmountCents = intent?.amountCents ?? null;
        if (chargeId) await orderDoc.ref.update({ chargeId, chargeAmountCents }).catch(() => undefined);
      }
      try {
        const dist = await distributeEarnings({
          profileId: event.curatorProfileId, amountCents: amount,
          source: chargeId && chargeAmountCents != null ? { chargeId, remainingCents: chargeAmountCents - order.refundedCents } : null,
          purpose: "ticket_settlement", ref: { eventId: doc.id, orderId: orderDoc.id },
          idempotencyBase: `ticket_settlement:${doc.id}:${orderDoc.id}`,
          meta: { purpose: "ticket_settlement", eventId: doc.id, orderId: orderDoc.id },
          profileAccountId: curatorStripe.accountId, now,
        });
        await orderDoc.ref.update({ settledAt: now, settlementLegs: dist.legs.length });
        await writeLedger({
          kind: "ticket_settlement", amountCents: amount, bookingId: null, gigId: null,
          profileId: event.curatorProfileId, stripeId: dist.transferId, sourced: dist.sourcedAny,
          detail: `ticket settlement (T+1) for "${event.title}", order ${orderDoc.id}`,
          eventId: doc.id, orderId: orderDoc.id, buyerUid: order.buyerUid,
        }).catch((e) => console.error(`paymentsSweep: ticket_settlement ledger row failed for order ${orderDoc.id}`, e));
        report.ticketOrdersSettled++;
      } catch (e) {
        // unchanged shape: release the claim on a definite refusal, ticket_settlement_failed alert naming the order, bumpError, return
      }
    }
    if (claim === "claimed") await doc.ref.update({ settlementStartedAt: now, updatedAt: now });
    report.ticketSettlementsTransferred++;
  } else {
    for (const orderDoc of pending) await orderDoc.ref.update({ settledAt: now, settlementLegs: 0 });
  }
  // unchanged: the completion transaction
```

`PaymentsSweepReport` gains `ticketOrdersSettled: 0`. The all-free case still completes the event with no ledger row. Note: the old `ticket_settlement:${eventId}` key is never reused, so an event settled before this change (`settlementStartedAt` set) is skipped by the claim as before.

- [ ] **Step 3: Run, commit**

Emulator runs: `test/eventsSettlementOrders.test.ts`, `test/eventsSettlement.test.ts`, `test/ticketing.test.ts` (or `grep -l finalizeTicketOrder functions/test/*.ts`). PASS.
```bash
git add functions/src/ticketing.ts functions/src/paymentsSweep.ts functions/test
git commit -m "feat(functions): per-order sourced ticket settlement through distributeEarnings"
```

---

### Task 8: `getPayoutHistory`

**Files:**
- Create: `functions/src/payoutHistory.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/payoutHistory.test.ts`

**Interfaces:**
- Produces: `getPayoutHistory({ scope: { kind: "profile"; profileId } | { kind: "user" }, cursor?: string | null })` returning `{ rows: HistoryRow[]; nextCursor: string | null }`, `HistoryRow = { id, kind, amountCents, at, detail, sourced: boolean | null, uid: string | null, label: string | null, ref: { bookingId?, gigId?, eventId?, orderId? } }`. Add `HistoryRow` and `PayoutHistoryScope` to shared `types.ts` (both clients render them).

- [ ] **Step 1: Failing test**

```ts
describe("getPayoutHistory", () => {
  it("members page a profile's rows newest first, owners page their own, strangers are refused", async () => {
    const band = await makeApprovedMusicianProfile("ph1");
    const bass = await addMember(band.profileId, "ph1b");
    const at = Date.now();
    for (let i = 0; i < 25; i++) {
      await adb.collection("ledger").add({ kind: i % 2 ? "share_transfer" : "earnings_transfer", amountCents: 100 + i, bookingId: "b", gigId: "g", profileId: band.profileId, uid: i % 2 ? bass.uid : null, stripeId: `tr_ph1_${i}`, detail: "t", at: at - i * 1000 });
    }
    const page1 = await callFn<object, { rows: Array<{ amountCents: number; label: string | null }>; nextCursor: string | null }>("getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId } }, bass.user);
    expect(page1.rows).toHaveLength(20);
    expect(page1.rows[0].amountCents).toBe(100);
    expect(page1.rows[1].label).toBe("bass");
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await callFn<object, { rows: unknown[]; nextCursor: string | null }>("getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId }, cursor: page1.nextCursor }, bass.user);
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    const mine = await callFn<object, { rows: Array<{ uid: string | null }> }>("getPayoutHistory", { scope: { kind: "user" } }, bass.user);
    expect(mine.rows.every((r) => r.uid === bass.uid)).toBe(true);
    const stranger = await signUpTestUser(`ph1s-${Date.now()}@test.com`);
    await expect(callFn("getPayoutHistory", { scope: { kind: "profile", profileId: band.profileId } }, stranger.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});
```

- [ ] **Step 2: Implement**

```ts
const PAGE = 20;
export const getPayoutHistory = onCall<{ scope: PayoutHistoryScope; cursor?: string | null }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  const scope = req.data?.scope;
  const db = getFirestore();
  let q: FirebaseFirestore.Query;
  if (scope?.kind === "profile") {
    if (!isValidDocId(scope.profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    await requireProfileMember(scope.profileId, uid);
    q = db.collection("ledger").where("profileId", "==", scope.profileId);
  } else if (scope?.kind === "user") {
    q = db.collection("ledger").where("uid", "==", uid);
  } else throw new HttpsError("invalid-argument", "Unknown history scope.");
  q = q.orderBy("at", "desc").orderBy("__name__", "desc").limit(PAGE + 1);
  const cursor = req.data?.cursor;
  if (cursor) {
    const [atRaw, id] = cursor.split(":");
    const at = Number(atRaw);
    if (!Number.isFinite(at) || !isValidDocId(id)) throw new HttpsError("invalid-argument", "Invalid cursor.");
    q = q.startAfter(at, id);
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, PAGE);
  const labels = new Map<string, string>();
  if (scope.kind === "profile") {
    const members = await db.collection(`profiles/${scope.profileId}/members`).get();
    for (const m of members.docs) labels.set(m.id, (m.data().label as string) || "member");
  }
  const rows: HistoryRow[] = docs.map((d) => {
    const e = d.data() as LedgerEntry;
    return { id: d.id, kind: e.kind, amountCents: e.amountCents, at: e.at, detail: e.detail, sourced: e.sourced ?? null, uid: e.uid ?? null, label: e.uid ? (labels.get(e.uid) ?? null) : null,
      ref: { bookingId: e.bookingId ?? undefined, gigId: e.gigId ?? undefined, eventId: e.eventId ?? undefined, orderId: e.orderId ?? undefined } };
  });
  const last = docs[docs.length - 1];
  return { rows, nextCursor: snap.docs.length > PAGE && last ? `${(last.data() as LedgerEntry).at}:${last.id}` : null };
});
```

The composite indexes from Task 2 serve `(profileId, at desc)` and `(uid, at desc)`; the added `__name__` order is implicit in Firestore composites. Export from `index.ts`.

- [ ] **Step 3: Run, commit**

```bash
git add functions/src/payoutHistory.ts functions/src/index.ts functions/test/payoutHistory.test.ts packages/shared/src/types.ts
git commit -m "feat(functions): ledger-backed payout history callable"
```

---

## Client tasks

UI tasks are contracts plus load-bearing snippets. Reuse each platform's existing Earnings panel shapes and primitives; copy is short and concrete; every list has loading, empty, and error states in the existing style.

### Task 9: Web Earnings panel: role gating, shares, history

**Files:**
- Create: `apps/web/src/payments/useProfileRole.ts`, `SharesCard.tsx`, `PayoutHistoryList.tsx`
- Modify: `apps/web/src/payments/EarningsPanel.tsx`, `apps/web/app/dashboard/earnings/page.tsx`

**Interfaces:**
- Consumes: `setPayoutShares`, `getPayoutHistory` (through `callFn`), `HistoryRow`, `PayoutShare`, `validatePayoutShares`, `HeldShareDoc`; the member doc self-read (`profiles/{id}/members/{uid}` is readable by its own uid under the existing rules).
- Produces: `useProfileRole(profileId, uid): "admin" | "member" | "none" | "loading"`, `SharesCard({ profileId, isAdmin })`, `PayoutHistoryList({ scope })`.

- [ ] **Step 1: Role hook**

`useProfileRole` reads `profiles/{profileId}/members/{uid}` once with `getDoc` and returns the doc's `role`, `"none"` when absent or denied, `"loading"` first. The same shape as `useRole` in `src/bookings/BookingThread.tsx` but reading `.data()?.role`.

- [ ] **Step 2: Shares card**

`SharesCard({ profileId, isAdmin })`: subscribes to `profiles/{profileId}/members` (list, member-readable) for the rows and to `profiles/{profileId}/private/stripe` for `shares`; subscribes to `heldShares` where `profileId ==` and `status in ["held","failed"]` for the per-member "Held: $X" line. Renders one row per member: label (or "Member" when blank), a `Card`-styled percent `Input` (admins) or plain text (members), plus a "Band fund" row, a live "Total: N%" line turning `text-gk-destructive` when not 100, and for admins a Save `Button` (disabled unless the total is 100 and something changed) that runs `validatePayoutShares` against the member uids and calls `setPayoutShares`; a "Clear shares" secondary action sends `null`. A member without `transfersEnabled` shows "Not set up for payouts yet" under their row (read `users/{uid}/private/stripe`? not readable by others: instead the card reads nothing per member and relies on the held line, which is what the spec's UI promises; drop the "not set up" line and say so in the report). Empty state for admins: "No shares set. Everything goes to this profile's account."

- [ ] **Step 3: History list**

`PayoutHistoryList({ scope })`: calls `getPayoutHistory` with the scope, renders rows newest first with `formatCents`, the kind as a short label (Settlement, Share paid, Share held, Share released, Payout, Instant payout, Payout failed, Ticket settlement, Fee), the member label when present, and nests `share_*` rows under the settlement row that shares their `ref` when both are on the page (a simple grouping by `ref` key); "Show more" fetches the next cursor. Error row and empty state ("No payouts yet.").

- [ ] **Step 4: Wire the panel and the page**

`EarningsPanel`: call `useProfileRole`; render the onboarding button, amount input, and cash-out buttons only when `role === "admin"` (members see the balance and, when not admin, a muted line "Only profile admins can cash out."); mount `SharesCard` (only for musician profiles: the panel gains a `type` prop from the page) between the balance block and "Pending settlements"; replace `HistoryList`'s derived rows with `PayoutHistoryList({ scope: { kind: "profile", profileId } })` (keep "Pending settlements" as is). `app/dashboard/earnings/page.tsx`: list profiles of type `musician` or `curator` (the heading copy becomes "Earnings & payouts" unchanged; the empty state stays), passing `type`.

- [ ] **Step 5: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint` (0 errors, no new warnings), `build`.
```bash
git add apps/web/src/payments apps/web/app/dashboard/earnings/page.tsx
git commit -m "feat(web): payout shares editor, ledger history, and admin-only payout controls"
```

---

### Task 10: Web member payouts card and onboarding pages

**Files:**
- Create: `apps/web/src/payments/MemberPayoutsCard.tsx`, `apps/web/app/dashboard/payouts/onboarding/return/page.tsx`, `apps/web/app/dashboard/payouts/onboarding/refresh/page.tsx`
- Modify: `apps/web/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `createMemberOnboardingLink`, `getMemberPayoutStatus`, `requestMemberPayout`, `PayoutHistoryList` (Task 9), the payout messages.

- [ ] **Step 1: Card**

`MemberPayoutsCard` (`id="payouts"` on its section so `/dashboard#payouts` lands on it): loads `getMemberPayoutStatus`; states: no account -> "Set up payouts" `Button` (calls `createMemberOnboardingLink` and `window.location.assign(url)`; no sessionStorage bridge is needed since the return page has no id to recover); account but not `payoutsEnabled` -> "Verifying your account" with a Retry that reloads status; enabled -> available and instant balances, the amount `Input`, Standard and Instant buttons mirroring `EarningsPanel`'s request-id minting and fee preview, calling `requestMemberPayout`; a "Waiting for you: $X" line when `heldCents > 0` with the copy "It moves to your balance as soon as your account is verified."; then `PayoutHistoryList({ scope: { kind: "user" } })`. Heading "Your payouts", one line of copy "Money bands pay you lands here."

- [ ] **Step 2: Pages**

`return/page.tsx`: calls `getMemberPayoutStatus` and renders "Payouts enabled" / "Still verifying" / error with a "Back to dashboard" link (mirror the profile return page without the profileId bridge). `refresh/page.tsx`: calls `createMemberOnboardingLink` and assigns the URL.

- [ ] **Step 3: Dashboard**

Mount `<MemberPayoutsCard uid={user.uid} />` above the "Your profiles" section. The notification row already routes `payouts` kinds through `notificationHref` (Task 1).

- [ ] **Step 4: Verify and commit**

Typecheck, lint, build; the two new routes appear in the build's route table.
```bash
git add apps/web/src/payments/MemberPayoutsCard.tsx apps/web/app/dashboard
git commit -m "feat(web): member payouts card and onboarding return pages"
```

---

### Task 11: Mobile Earnings panel: role gating, shares, history

**Files:**
- Create: `apps/mobile/src/payments/useProfileRole.ts`, `SharesCard.tsx`, `PayoutHistoryList.tsx`
- Modify: `apps/mobile/src/payments/EarningsPanel.tsx`, `apps/mobile/app/(musician)/dashboard.tsx`

Same contracts as Task 9 on the mobile primitives: `Card`, `Input` (`keyboardType="number-pad"`) per member row, `Text` totals, `Button` Save and Clear, `Callout tone="warning"` when the total is not 100; history rows as `Text` lines with a "Show more" `Button`; `useProfileRole` via `getDoc`. The dashboard passes the active profile's `type` so the shares card shows only for musician profiles. Non-admin members see "Only profile admins can cash out." instead of the controls (this replaces the sub-5b "no client-side gating" posture; update the panel's header comment item 4 accordingly).

Verify: `pnpm --filter @gatekeep/mobile typecheck`, `lint` (0 errors, 3 pre-existing warnings), `expo export --no-bytecode --platform ios`.
```bash
git add apps/mobile/src/payments apps/mobile/app/(musician)/dashboard.tsx
git commit -m "feat(mobile): payout shares editor, ledger history, and admin-only payout controls"
```

---

### Task 12: Mobile Payouts screen, Account row, push routing

**Files:**
- Create: `apps/mobile/src/payments/MemberPayoutsPanel.tsx`, `apps/mobile/app/(fan)/payouts.tsx`
- Modify: `apps/mobile/app/(fan)/_layout.tsx`, `apps/mobile/src/shell/AccountScreen.tsx`, `apps/mobile/src/notifications/push.ts`

`MemberPayoutsPanel`: the mobile twin of `MemberPayoutsCard`, with onboarding through `WebBrowser.openBrowserAsync` and the `AppState` foreground resync copied from `EarningsPanel` (tripwire 2), `mintRequestId` for request ids, and `PayoutHistoryList({ scope: { kind: "user" } })`. `app/(fan)/payouts.tsx` renders `PageBackground` plus the panel; register it in `(fan)/_layout.tsx` as `<Tabs.Screen name="payouts" options={{ title: "Payouts", href: null }} />`; `AccountScreen` gains a "Payouts" row after "Saved searches" pushing `/(fan)/payouts`. `push.ts` widens the `refKind` narrowing to include `"payouts"`. `NotificationsList` needs no change (it passes `refKind` through).

Verify: typecheck, lint, `expo export --no-bytecode` (new route).
```bash
git add apps/mobile/src/payments/MemberPayoutsPanel.tsx apps/mobile/app/(fan) apps/mobile/src/shell/AccountScreen.tsx apps/mobile/src/notifications/push.ts
git commit -m "feat(mobile): member payouts screen, account row, payout push routing"
```

---

### Task 13: README, HANDOFF, gate counts

**Files:**
- Modify: `README.md`, `docs/superpowers/HANDOFF.md`

- README: a "Sub-project 5c launch checklist (payout splits)" after the sub-8 one (deploy the four composites; confirm the Connect endpoint delivers `account.updated` and `payout.*` for user accounts; `APP_ORIGIN` covers `/dashboard/payouts/onboarding/*`; the real Stripe test-mode smoke: onboard a member, set shares, settle a booking and a ticketed event, watch legs and a held release, cash out as the member) and a "Sub-project 5c smoke checklist" (both platforms: shares editor as admin and as member, held line, member Payouts surface end to end, history paging, per-order ticket settlement rows in the curator's history, notification taps). In "Sub-project 5 launch checklist" mark the platform-float item resolved by per-order sourced transfers.
- HANDOFF: item "5c. Band payout splits (`sp5c-rulings.md`): ..." after item 8 in the merged list; retire the "**5c Band payout splits**" roadmap bullet; row 51 of the follow-ups table becomes "Closed by 5c (per-order sourced ticket settlement)"; new rows for the Connect endpoint confirmation, `APP_ORIGIN` paths, the four indexes, and the test-mode smoke; the standing tripwires gain item 7: "`distributeEarnings` is the only way earnings reach a profile; a new settlement path must call it, never `transferToAccount` directly"; update the gates line with measured counts.
- Run every gate (the full emulator suite through the detached runner) and record the counts.

```bash
git add README.md docs/superpowers/HANDOFF.md
git commit -m "docs: sub-project 5c launch and smoke checklists, handoff update"
```

---

## Self-review

**Spec coverage.** Section 3 surfaces: Tasks 9 to 12. Section 4 data model: Task 1 (types), Task 2 (rules, indexes), Task 5 (held docs), Task 7 (order fields). Section 5 backend: Task 3 (shares callable, removal hook), Task 4 (member accounts, status, payouts, webhook routing), Task 5 (distribute, held, release), Task 6 (booking settlement), Task 7 (per-order ticket settlement), Task 8 (history). Section 6 messages: Task 1. Section 7 tests: named per task. Section 9 owner-owed: Task 13.

**Placeholder scan.** Task 4 mirrors `requestPayout` by reference to its verbatim body with named substitutions rather than repeating 160 lines; the implementer has the source file. Task 7 marks two "unchanged" blocks that the implementer keeps from the existing function. No TBDs.

**Type consistency.** `DistributeInput.ref: HeldShareRef` matches `HeldShareDoc.ref`; `distributeEarnings` returns `transferId` (nullable) which Task 6 turns into a `held:` pseudo id and Task 7 writes as `stripeId`; `syncMemberAccountFlags` returns `{ doc, enabledNow }` consumed in Task 4's status and webhook paths and Task 5's wiring; `HistoryRow` is defined in shared in Task 8 and consumed by Tasks 9 to 12; `refKind: "payouts"` is set in Task 1 and read by `push.ts` in Task 12.

**Sequencing for the controller.** Tasks 1 to 8 sequential (each builds on the last); Tasks 9 and 10 (web) and 11 and 12 (mobile) are independent of each other; Task 13 last. Pre-flight: re-check `functions/test` helper exports (`postWebhook`, `fakeEvent` are local to `payments.test.ts` today; Task 4's test carries its own copies, Task 5 may centralise them).

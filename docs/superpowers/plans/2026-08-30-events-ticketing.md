# Sub-project 6: Events & Ticketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public event pages built from booked gigs (or standalone), multi-tier fan ticketing with a fan-paid service charge on the SP5 Stripe rails, escrowed payouts T+1 after the event, QR door check-in, and capped in-app transfers.

**Architecture:** New `events`/`ticketing` function modules beside the SP5 payment modules, sharing `stripeClient` (FakeStripe keyless in emulator), the `stripeEvents` webhook claim machine (new `purpose: "tickets"`), the ledger, and the notification inbox. Inventory truth is a transactional `soldCount <= capacity` check on tier docs; tickets live under `users/{uid}/tickets` with a server-minted `qrSecret` as door proof. Web ships a public SSR event page + curator management; mobile ships the fan Tickets tab, buy via the 5b PaymentSheet seam, and a curator scanner.

**Tech Stack:** Firebase (Firestore, Functions node 20, emulator suite), Stripe platform charges, Next.js 16 (App Router, RSC discipline), Expo SDK 57 + expo-camera + react-native-qrcode-svg, `qrcode` on web, packages/shared money math.

**Spec:** `docs/superpowers/specs/2026-08-30-events-ticketing-design.md` (the binding authority; conflicts resolve against it)

## Global Constraints

- **No em dashes anywhere**: code, comments, copy, docs, commit messages. Use commas, colons, periods.
- `DESIGN.md` (repo root) is binding on every surface; antislop + antislop-ui + antislop-copywriting skills bind UI/copy. Icons: Phosphor duotone ONLY via `apps/web/src/ui/icons.tsx` / `apps/mobile/src/ui/icons.tsx`. No lucide, no Inter/Geist/Space Grotesk.
- **Zero behavior change to SP5 booking money paths.** All ticket code is additive. Never edit existing handlers, fee constants, or `DEFAULT_FEE_POLICY`.
- Ticket service fee, per ticket: `min(round(priceCents * 0.07) + 99, 399)`; `priceCents === 0` charges no fee. Fan pays it on top of face value.
- Curator payout = 100% of face value of paid, non-refunded tickets, transferred T+1 after `endsAt`.
- Firestore stays default-deny; every shipped client query must be rules-provable with equality pins (SP4 rulings doc, ruling 17).
- All money writes are server-only. Clients never write `events` (beyond nothing at all: event CRUD is callable-only), `tiers`, `orders`, `tickets`, `attendees`, `transfers`.
- User-facing status/error strings that clients branch on live in `packages/shared/src/messages.ts` and are compared with `===`.
- Web RSC boundary rule: server files never import VALUES from `"use client"` modules. Verify every new/changed web route with a live page load, not just build.
- Gates at the end (and per task where named): `pnpm typecheck` 5/5, shared tests (153 + new), `pnpm emu:test` (578 + new, single blocking call, needs Java on PATH + `FUNCTIONS_DISCOVERY_TIMEOUT=60`), `pnpm emu:rules` (77 + new), web lint 0 + `pnpm --filter @gatekeep/web build`, mobile lint 0, `pnpm --filter @gatekeep/mobile exec expo export --platform ios` bundles.
- Run tests from repo root. Emulator tests: `pnpm emu:test` runs everything; during development target one file with `pnpm emu:exec -- vitest run functions/test/<file> --root functions` if that script exists, otherwise run the full suite.

---

## File map (who owns what)

- `packages/shared/src/types.ts` (extend), `money.ts` (extend), `messages.ts` (extend), `storagePaths.ts` (extend): types, ticket fee math, shared strings, poster path. Task 1.
- `firestore.rules` + `tests-rules/events.rules.test.ts`: new collection rules. Task 2.
- `functions/src/eventsCore.ts` (new): pure helpers (validation, lineup normalization, order math, qrSecret). Task 3.
- `functions/src/events.ts` (new): event/tier lifecycle callables. Task 4.
- `functions/src/ticketing.ts` (new): checkout, finalize, expiry sweep, check-in, transfers, refunds. Tasks 5, 6, 8.
- `functions/src/paymentsWebhook.ts` (extend registry only), `functions/src/paymentsSweep.ts` (extend), `functions/src/scheduled.ts` (extend): webhook purpose, settlement, reminders. Tasks 5, 7.
- `functions/src/index.ts`: export new callables as they appear.
- `apps/web/app/e/[eventId]/*`, `apps/web/src/events/*`: public event page + buy flow. Task 9.
- `apps/web/app/dashboard/*` events management + `apps/web/app/tickets/*` fan tickets. Task 10.
- `apps/mobile/app/event/[eventId].tsx`, `(fan)/tickets.tsx`, `src/tickets/*`: fan surfaces. Task 11.
- `apps/mobile/app/(curator)/events/*`, `src/events/*`: curator tiers/scanner/attendees. Task 12.
- `README.md`, `docs/superpowers/HANDOFF.md`: smoke checklist + status. Task 13.

---

### Task 1: Shared foundations (types, fee math, messages, poster path)

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/money.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/storagePaths.ts`, `packages/shared/src/index.ts` (re-exports if the barrel lists names explicitly)
- Test: `packages/shared/test/ticketMoney.test.ts` (new; put beside existing shared tests, match their runner setup)

**Interfaces (Produces, used by every later task):**

```ts
// types.ts additions
export type EventStatus = "draft" | "published" | "completed" | "cancelled";
export type EventAct =
  | { kind: "booking"; bookingId: string; musicianProfileId: string; name: string }
  | { kind: "external"; name: string };
export interface EventDoc {
  curatorProfileId: string; title: string; description: string;
  location: GigLocationPublic;          // reuse SP3's public-precision location type; find its exact name in types.ts and use that
  startsAt: number; endsAt: number;
  posterPath: string | null;            // a processed photo path belonging to the curator profile
  status: EventStatus;
  maxTicketsPerBuyer: number;           // default 8
  lineup: EventAct[];
  gigId: string | null;                 // set when promoted from a filled gig
  createdAt: number; updatedAt: number;
  cancelledAt?: number; completedAt?: number;
}
export interface TicketTierDoc {
  name: string; priceCents: number;     // 0 = free RSVP
  capacity: number; soldCount: number;  // server-maintained
  saleStartsAt: number | null; saleEndsAt: number | null;
  sortOrder: number;
}
export interface TicketFeePolicy { ticketFeePct: number; ticketFeeFixedCents: number; ticketFeeCapCents: number; }
export type TicketOrderStatus = "pending" | "paid" | "expired" | "cancelled_refunded";
export interface TicketOrderItem { tierId: string; quantity: number; unitPriceCents: number; tierName: string; }
export interface TicketOrderDoc {
  buyerUid: string; eventId: string; curatorProfileId: string;
  items: TicketOrderItem[];
  faceTotalCents: number; serviceFeeCents: number;
  feePolicy: TicketFeePolicy;
  paymentIntentId: string | null;       // null for free orders
  status: TicketOrderStatus;
  refundedTicketIds: string[]; refundedCents: number;
  createdAt: number; expiresAt: number; paidAt?: number;
}
export type TicketStatus = "valid" | "checked_in" | "refunded" | "transferred";
export interface TicketDoc {
  eventId: string; tierId: string; tierName: string; orderId: string;
  curatorProfileId: string;
  qrSecret: string;                     // server-minted, owner-readable, possession = door proof
  status: TicketStatus;
  createdAt: number; checkedInAt?: number; transferredTo?: string;
}
export interface AttendeeDoc {         // events/{eventId}/attendees/{ticketId}, server-written projection
  ownerUid: string; ownerName: string; tierId: string; tierName: string;
  status: TicketStatus; checkedInAt?: number;
}
export type TicketTransferStatus = "offered" | "accepted" | "declined" | "expired";
export interface TicketTransferDoc {
  ticketId: string; eventId: string; fromUid: string; toUid: string;
  status: TicketTransferStatus; createdAt: number; expiresAt: number; resolvedAt?: number;
}
```

```ts
// money.ts additions
export const DEFAULT_TICKET_FEE_POLICY: TicketFeePolicy = Object.freeze({
  ticketFeePct: 7, ticketFeeFixedCents: 99, ticketFeeCapCents: 399,
});
/** Per-ticket service fee. Free tickets carry no fee. */
export function ticketServiceFeeCents(unitPriceCents: number, policy: TicketFeePolicy): number {
  if (unitPriceCents <= 0) return 0;
  const pct = Math.round(unitPriceCents * policy.ticketFeePct / 100);
  return Math.min(pct + policy.ticketFeeFixedCents, policy.ticketFeeCapCents);
}
/** Order totals from line items. quantity >= 1 per item, validated upstream. */
export function ticketOrderTotals(items: TicketOrderItem[], policy: TicketFeePolicy): { faceTotalCents: number; serviceFeeCents: number } {
  let face = 0, fee = 0;
  for (const it of items) { face += it.unitPriceCents * it.quantity; fee += ticketServiceFeeCents(it.unitPriceCents, policy) * it.quantity; }
  return { faceTotalCents: face, serviceFeeCents: fee };
}
```

```ts
// messages.ts additions (exact strings; clients === on these)
export const EVENT_SOLD_OUT_MESSAGE = "This tier is sold out.";
export const EVENT_SALE_CLOSED_MESSAGE = "Ticket sales for this tier are closed.";
export const EVENT_BUYER_CAP_MESSAGE = "You have reached the ticket limit for this event.";
export const EVENT_NOT_ON_SALE_MESSAGE = "This event is not on sale.";
export const TICKET_ALREADY_CHECKED_IN_MESSAGE = "Ticket already checked in.";
export const TICKET_NOT_VALID_MESSAGE = "This ticket is not valid for entry.";
export const TRANSFER_OFFER_SENT_MESSAGE = "If that account exists, the ticket offer is on its way.";
```

```ts
// storagePaths.ts: extend PhotoKind
export type PhotoKind = "avatar" | "cover" | "gallery" | "poster";
```

**Steps:**

- [ ] **Step 1:** Write failing tests in `packages/shared/test/ticketMoney.test.ts` (copy the runner/import style of an existing shared test file). Cases: fee for 1200c = `min(84+99,399)` = 183; fee for 10000c = `min(700+99,399)` = 399 (cap); fee for 0c = 0; fee for 100c = `min(7+99,399)` = 106; `ticketOrderTotals` with `[{2000c x2},{0c x1}]` = face 4000, fee `2*min(140+99,399)=478`; empty items = 0/0.
- [ ] **Step 2:** Run shared tests, verify the new file fails (functions undefined).
- [ ] **Step 3:** Add the types, money functions, messages, and PhotoKind exactly as above. Check `grep -n "avatar" packages/shared/src/storagePaths.ts` consumers: if `stagingPhotoPath`/`publicPhotoPath` validate kind via the union only, nothing else changes.
- [ ] **Step 4:** Run shared tests: all pass (153 + new). Run `pnpm typecheck`: the PhotoKind widening must not break `media.ts` (its kind dispatch already resizes non-avatar kinds to 1600 bounded; if it switches exhaustively on kind, add a `poster` branch identical to `gallery`).
- [ ] **Step 5:** Commit: `feat(shared): event and ticketing types, ticket fee math, message constants`

### Task 2: Firestore rules for the six new collections

**Files:**
- Modify: `firestore.rules`
- Test: `tests-rules/events.rules.test.ts` (new, mirror the harness in `tests-rules/payments.rules.test.ts`)

**Interfaces:**
- Consumes: collection shapes from Task 1.
- Produces: the rules contract every client query in Tasks 9-12 must be provable against.

Rules to add (adapt helper names like `isProfileMember(profileId)` / `isAdmin()` to the ones the file already defines; read the file first):

```
match /events/{eventId} {
  allow read: if resource.data.status == "published"
    || resource.data.status == "completed"
    || isProfileMember(resource.data.curatorProfileId) || isAdmin();
  allow write: if false;   // callable-only
  match /tiers/{tierId} {
    allow read: if get(/databases/$(database)/documents/events/$(eventId)).data.status in ["published", "completed"]
      || isProfileMember(get(/databases/$(database)/documents/events/$(eventId)).data.curatorProfileId) || isAdmin();
    allow write: if false;
  }
  match /private/address {
    allow read: if isAdmin()
      || isProfileMember(get(/databases/$(database)/documents/events/$(eventId)).data.curatorProfileId)
      || (request.auth != null
          && exists(/databases/$(database)/documents/users/$(request.auth.uid)/ticketIndex/$(eventId)));
    allow write: if false;
  }
  match /attendees/{ticketId} {
    allow read: if isProfileMember(get(/databases/$(database)/documents/events/$(eventId)).data.curatorProfileId) || isAdmin();
    allow write: if false;
  }
}
match /orders/{orderId} {
  allow read: if request.auth != null
    && (resource.data.buyerUid == request.auth.uid || isProfileMember(resource.data.curatorProfileId) || isAdmin());
  allow write: if false;
}
match /users/{uid}/tickets/{ticketId} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false;
}
match /users/{uid}/ticketIndex/{eventId} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false;
}
match /transfers/{transferId} {
  allow read: if request.auth != null
    && (resource.data.fromUid == request.auth.uid || resource.data.toUid == request.auth.uid || isAdmin());
  allow write: if false;
}
```

Design note baked into the rules: the address gate cannot query "any valid ticket for this event" (rules cannot run queries), so the server maintains `users/{uid}/ticketIndex/{eventId}` = `{ count: number }`, written by the same server mutations that mint/refund/transfer tickets. `exists()` on that doc is the valid-ticket proof. The index doc is deleted when its count reaches 0 (Tasks 5, 6, 8 keep it accurate). This is also what makes the per-buyer held-count cap O(1) to check.

**Steps:**

- [ ] **Step 1:** Write failing rules tests covering the matrix: anon reads published event = allow; anon reads draft = deny; curator member reads own draft = allow; anon reads tiers of published = allow; stranger reads private/address = deny; ticket-holder (seed `users/u/ticketIndex/{eventId}` via admin SDK) reads private/address = allow; curator member reads private/address = allow; buyer reads own order = allow; stranger reads order = deny; owner reads own ticket = allow; other reads = deny; transfer visible to both parties only; every client `create/update/delete` on all six = deny (including curator members: callable-only).
- [ ] **Step 2:** `pnpm emu:rules`: new file fails (rules missing).
- [ ] **Step 3:** Add the rules blocks, adapted to the file's existing helpers.
- [ ] **Step 4:** `pnpm emu:rules`: 77 + new all pass.
- [ ] **Step 5:** Commit: `feat(rules): events, tiers, orders, tickets, attendees, transfers, address gate via ticketIndex`

### Task 3: eventsCore pure helpers

**Files:**
- Create: `functions/src/eventsCore.ts`
- Test: `functions/test/eventsCore.test.ts` (pure unit tests, no emulator dependencies beyond what helpers.ts always wires)

**Interfaces (Produces):**

```ts
export const ORDER_TTL_MS = 10 * 60 * 1000;
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
export const EVENT_SETTLE_DELAY_MS = 24 * 60 * 60 * 1000;      // T+1
export const DEFAULT_MAX_TICKETS_PER_BUYER = 8;
export function mintQrSecret(): string;                          // 32 bytes crypto.randomBytes, hex
export function currentTicketFeePolicy(): TicketFeePolicy;       // returns DEFAULT_TICKET_FEE_POLICY (snapshot point, mirrors currentFeePolicy in paymentsCore.ts:143)
export function validateEventInput(input: { title: string; description: string; startsAt: number; endsAt: number; maxTicketsPerBuyer?: number; lineup: EventAct[] }): void;
  // throws HttpsError("invalid-argument"): title 1..120 chars, description 0..4000,
  // endsAt > startsAt, startsAt in the future at create, 1..20 lineup acts,
  // act names 1..80 chars, maxTicketsPerBuyer 1..20
export function validateTierInput(t: { name: string; priceCents: number; capacity: number; saleStartsAt: number | null; saleEndsAt: number | null }): void;
  // name 1..40, priceCents 0..50000 integer, capacity 1..10000 integer, window ordered when both set
export function tierOnSale(t: TicketTierDoc, now: number): boolean;   // window check only (caller checks event status)
export function buildOrderItems(tiers: Map<string, TicketTierDoc>, req: Array<{ tierId: string; quantity: number }>): TicketOrderItem[];
  // throws invalid-argument on unknown tier, quantity < 1 or > 10, duplicate tierIds
```

**Steps:**

- [ ] **Step 1:** Write failing unit tests: mintQrSecret returns 64 hex chars, two calls differ; validateEventInput accepts a good input and rejects each bad field (7 cases); validateTierInput rejects negative price, zero capacity, inverted window; tierOnSale true inside window / false before saleStartsAt / false after saleEndsAt / true when both null; buildOrderItems maps price + tierName and rejects unknown tier and duplicates.
- [ ] **Step 2:** Run, verify failure. **Step 3:** Implement. **Step 4:** Run, verify pass + typecheck.
- [ ] **Step 5:** Commit: `feat(functions): eventsCore pure helpers`

### Task 4: Event and tier lifecycle callables

**Files:**
- Create: `functions/src/events.ts`
- Modify: `functions/src/index.ts` (export), `functions/src/media.ts` only if its kind switch needs the `poster` branch (Task 1 may have done it), `storage.rules` staging path for kind `poster` if the rule enumerates kinds (read it; mirror `gallery`)
- Test: `functions/test/events.test.ts`

**Interfaces (Produces callables, all `onCall`, all `requireVerifiedEmail` + `requireProfileMember(curatorProfileId, uid)` + `requireApprovedCuratorProfile`):**

```ts
export const createEvent    // input: { curatorProfileId, source: { kind: "standalone", location: <SP3 public location input> } | { kind: "gig", gigId } , title, description, startsAt, endsAt, maxTicketsPerBuyer?, lineup, posterPath? }
                            // gig source: verify gig belongs to curator, status "filled", copy the gig's public-precision location + private address into events/{id}/private/address; standalone: geocode/copy like gigs.ts createGig does, exact address into private/address
                            // posterPath: when set, must be a publicPhotoPath belonging to this curatorProfileId (string-prefix check)
                            // returns { eventId }; status "draft"
export const updateEvent    // draft or published; re-validates; cannot change curatorProfileId/gigId; published events cannot move startsAt earlier than now
export const setEventTiers  // input: { curatorProfileId, eventId, tiers: Array<{ tierId?: string, ...TierInput }> } ; upserts named tiers, deletes omitted ones ONLY while draft; after publish, deletes and capacity decreases below soldCount are rejected (capacity increases + new tiers allowed)
export const publishEvent   // draft -> published; requires >= 1 tier; requires the curator profile chargeable-side Stripe onboarding NOT required (tickets collect on the platform, so publish requires nothing from Stripe; do NOT gate on requireCuratorChargeable)
export const cancelEventShell // NOT exported. Task 6 ships the real cancelEvent with refunds; this task only writes the status-flip helper cancelEventCore(eventId, now) in events.ts used there.
```

Notification: on publish, none (fans discover via links in v1). Poster processing rides the existing photo pipeline: curator uploads via the existing staging flow with kind `poster` against their PROFILE (unchanged machinery), then passes the resulting processed path as `posterPath`.

**Steps:**

- [ ] **Step 1:** Write failing emulator tests: create standalone draft (assert doc shape + private address doc); create from filled gig (seed via existing booking helpers in `helpers.ts`: makeMoneyReady exists for money paths, and gig fixtures exist in `gigs.test.ts`; reuse those factory helpers) asserts location + gigId copied; non-member denied; unapproved curator denied; setEventTiers upsert + draft delete + post-publish delete rejected + capacity-below-soldCount rejected (seed soldCount via admin SDK); publish with no tiers rejected; publish flips status; updateEvent on cancelled rejected.
- [ ] **Step 2:** Run new test file, verify failure. **Step 3:** Implement `events.ts` + index exports (+ media/storage poster branch if needed). **Step 4:** Run: new tests + full `pnpm emu:test` stays green. **Step 5:** Commit: `feat(functions): event and tier lifecycle callables`

### Task 5: Checkout engine (order transaction, PaymentIntent, finalize, expiry sweep)

**Files:**
- Create: `functions/src/ticketing.ts`
- Modify: `functions/src/paymentsWebhook.ts` (ONLY a registration line + import), `functions/src/paymentsSweep.ts` (add expiry step) or `scheduled.ts` if sweeps live there for non-payment work (read both; put ticket-order expiry in `paymentsSweep.ts` beside its sibling steps), `functions/src/index.ts`
- Test: `functions/test/ticketing.test.ts`

**Interfaces (Produces):**

```ts
export const createTicketOrder  // onCall<{ eventId, items: Array<{tierId, quantity}> }>
// 1. requireAuthUid + requireVerifiedEmail. Load event: must be "published", startsAt > now.
// 2. Transaction: read tiers + users/{uid}/ticketIndex/{eventId} + buyer's pending orders count guard:
//    - buildOrderItems; each tier tierOnSale() else EVENT_SALE_CLOSED_MESSAGE (failed-precondition)
//    - soldCount + qty <= capacity per tier else EVENT_SOLD_OUT_MESSAGE
//    - heldCount(ticketIndex.count ?? 0) + total qty <= event.maxTicketsPerBuyer else EVENT_BUYER_CAP_MESSAGE
//    - increment each tier soldCount by qty; write orders/{id} status "pending", expiresAt = now + ORDER_TTL_MS,
//      feePolicy = currentTicketFeePolicy(), totals from ticketOrderTotals
// 3. If faceTotal + fee === 0 (all free tiers): complete inline via completeOrderTx (below), return { orderId, clientSecret: null }
// 4. Else getStripe().paymentIntents.create({ amount: face + fee, currency: "usd",
//      metadata: { purpose: "tickets", orderId } }, { idempotencyKey: `tickets:${orderId}` });
//    stamp paymentIntentId on the order; return { orderId, clientSecret }
export const finalizeTicketOrder // onCall<{ orderId }> sync path: buyer only; retrieve PI; if succeeded -> completeOrderTx; returns shared-message status string
export async function completeOrderTx(orderId: string): Promise<void>
// Transaction, idempotent: only proceeds from status "pending" (a "paid" order returns silently).
// Sets status "paid" + paidAt; for each item quantity mints users/{buyerUid}/tickets/{id}
// { qrSecret: mintQrSecret(), status: "valid", tierName, curatorProfileId, ... },
// writes events/{eventId}/attendees/{ticketId} projection (ownerName from users/{uid}.displayName),
// increments users/{uid}/ticketIndex/{eventId}.count by total qty (create if missing),
// writeLedger({ kind: `ticket_sale:${orderId}`, ... amounts, eventId, buyerUid }),
// notifyUser(buyerUid, purchase confirmation linking the event).
```

Webhook registration in `paymentsWebhook.ts` (the registry is `paymentIntentSucceededHandlers` at `functions/src/paymentsWebhook.ts:74`; purposes are snake_case):

```ts
import { completeOrderTicketsHandler } from "./ticketing.js";
paymentIntentSucceededHandlers["tickets"] = completeOrderTicketsHandler;
// handler reads metadata.orderId, calls completeOrderTx(orderId). Reject (log + return) if metadata.orderId missing.
// Platform-account only: the dispatcher already refuses connected-account events before purpose dispatch.
```

Expiry sweep step (in `paymentsSweep.ts`, following its existing step structure): query `orders` where `status == "pending"` and `expiresAt < now`; for each, transaction: re-check still pending, set `expired`, decrement each item tier's `soldCount` by its quantity. If a PaymentIntent exists, cancel it via `getStripe().paymentIntents.cancel(id)` inside a try/catch (an intent that already succeeded will throw; the catch logs and leaves the order for the webhook/finalize path, which flips it to paid: money always wins over expiry).

**Steps:**

- [ ] **Step 1:** Failing tests: happy path paid (create order, confirm PI via the FakeStripe test hooks used in `payments.test.ts`, finalize, assert order paid + N tickets + attendees + ticketIndex count + ledger entry); free RSVP completes inline with clientSecret null and no PI; sold-out rejects with `EVENT_SOLD_OUT_MESSAGE`; over-cap rejects (`EVENT_BUYER_CAP_MESSAGE`) counting HELD tickets; sale-window closed rejects; double finalize mints no duplicate tickets (idempotent); expiry sweep releases inventory and cancels the PI; webhook path (simulate the event like `paymentsWebhook.test.ts` does) completes a pending order exactly once.
- [ ] **Step 2:** Run, fail. **Step 3:** Implement. **Step 4:** Full `pnpm emu:test` green. **Step 5:** Commit: `feat(functions): ticket checkout, finalize, webhook purpose, expiry sweep`

### Task 6: Cancellation and refunds

**Files:**
- Modify: `functions/src/events.ts` (real `cancelEvent`), `functions/src/ticketing.ts` (`refundTicket`), `functions/src/index.ts`
- Test: `functions/test/ticketingRefunds.test.ts`

**Interfaces:**

```ts
export const cancelEvent  // onCall<{ curatorProfileId, eventId, reason?: string }> curator members
// Flip published -> cancelled immediately (halts sales: createTicketOrder checks status).
// Then for every order status "paid": stripe.refunds.create({ payment_intent, amount: full remaining }) with
// idempotencyKey `ticket_cancel_refund:${orderId}`; set order "cancelled_refunded"; set each of its
// non-refunded/non-transferred tickets "refunded"; decrement/delete ticketIndex; update attendees;
// writeLedger kind `ticket_cancel_refund:${orderId}`; notifyUser each buyer (event cancelled, money returned).
// Free orders: same doc updates, no Stripe call. Draft events cancel with no money loop.
// Batched loop, not one transaction: each order refunds in its own transaction so one failure cannot
// wedge the rest; failures recordAdminAlert (paymentsCore.ts:842 pattern) and the sweep retries
// cancelled events with remaining paid orders (add that sweep step here).
export const refundTicket // onCall<{ curatorProfileId, eventId, ticketId }> curator members, event not cancelled
// Transaction: ticket must be "valid" or "checked_in"; compute per-ticket refund = unitPriceCents +
// ticketServiceFeeCents(unitPrice, order.feePolicy); partial refund on the order's PI
// (idempotencyKey `ticket_grace_refund:${ticketId}`); ticket -> "refunded"; order.refundedTicketIds += id,
// refundedCents += amount (order stays "paid"); tier soldCount -1 (inventory re-release);
// ticketIndex decrement; attendee update; ledger `ticket_grace_refund:${ticketId}`; notify the owner.
// The ticket OWNER (who may differ from buyer after transfer) keys ticketIndex/notification; money returns to the ORDER's buyer.
```

**Steps:**

- [ ] **Step 1:** Failing tests: cancel refunds 2 paid orders + 1 free order fully (assert refund amounts face+fee via FakeStripe refund records, statuses, ticketIndex removed, ledger, notifications); cancel is idempotent (second call refunds nothing new); grace refund returns face+fee for that ticket only, re-releases 1 seat (soldCount decremented, a new buyer can purchase it), order stays paid with refundedTicketIds; grace refund of a transferred-away ticket targets the current owner's index; refundTicket on cancelled event rejected.
- [ ] **Step 2-4:** Fail, implement, full emu suite green. **Step 5:** Commit: `feat(functions): event cancellation auto-refunds and curator grace refunds`

### Task 7: Post-event settlement and reminders

**Files:**
- Modify: `functions/src/paymentsSweep.ts` (settlement step), `functions/src/scheduled.ts` (reminder in dailySweep), `functions/src/eventsCore.ts` (alert id helpers)
- Test: `functions/test/eventsSettlement.test.ts`

**Interfaces:**

- Sweep step: query events `status == "published"` with `endsAt < now - EVENT_SETTLE_DELAY_MS`. Per event, one transaction: sum face value of tickets with status `valid` or `checked_in` across its paid orders (equivalently: paid orders' faceTotal minus refunded face; compute from order docs: `faceTotalCents - refundedFaceCents` where refunded face = sum of refunded tickets' unit prices, derivable from refundedTicketIds + items; store `refundedFaceCents` on the order in Task 6 to make this a field read, not a join). If sum > 0: `getStripe().transfers.create({ amount, destination: curator accountId from getStripeProfileDoc (paymentsCore.ts:45), metadata: { purpose: "ticket_settlement", eventId } }, { idempotencyKey: `ticket_settlement:${eventId}` })`. Set event `completed` + `completedAt`; ledger `ticket_settlement:${eventId}`. Curator with no Stripe account: recordAdminAlert `ticketSettlementBlockedAlertId(eventId)` and leave `published` for retry (the curator gets a notification to onboard).
- Reminder: in the daily sweep, events `published` with `startsAt` within the next 24h and `reminderSentAt` unset: notifyUser every ticketIndex holder (query collectionGroup `ticketIndex` where `__name__` docId == eventId is not queryable; instead read the event's attendees projection for distinct ownerUids), stamp `reminderSentAt`.
- NOTE (Task 6 dependency): add `refundedFaceCents: number` to `TicketOrderDoc` in Task 1's types and maintain it in Task 6's refund writes. It is listed here so the settlement read is one field.

**Steps:**

- [ ] **Step 1:** Failing tests: event past T+1 with 3 paid tickets and 1 grace-refunded settles face-of-2 (assert FakeStripe transfer amount + event completed + ledger); event with only free RSVPs completes with no transfer; not-yet-T+1 untouched; curator without Stripe leaves published + adminAlert; settlement idempotent on sweep re-run; reminder notifies each distinct owner once and stamps `reminderSentAt`.
- [ ] **Step 2-4:** Fail, implement, full suite green. **Step 5:** Commit: `feat(functions): post-event ticket settlement and event reminders`

### Task 8: Check-in and transfers

**Files:**
- Modify: `functions/src/ticketing.ts`, `functions/src/index.ts`
- Test: `functions/test/ticketingDoor.test.ts`

**Interfaces:**

```ts
export const checkInTicket   // onCall<{ curatorProfileId, eventId, ticketId, qrSecret?: string, override?: boolean }>
// curator members of the event's curatorProfileId only. Load attendee -> ownerUid -> ticket doc.
// qrSecret path (scanner): must === ticket.qrSecret else TICKET_NOT_VALID_MESSAGE.
// override path (list fallback): override: true skips the secret (curator tapped the list).
// Transaction: "valid" -> "checked_in" + checkedInAt + attendee mirror; returns { ownerName, tierName, checkedInAt }.
// "checked_in" already: failed-precondition TICKET_ALREADY_CHECKED_IN_MESSAGE with original checkedInAt in details.
// "refunded"/"transferred": TICKET_NOT_VALID_MESSAGE.
export const offerTransfer   // onCall<{ ticketId, target: string }>  owner; ticket "valid"; event "published"; startsAt > now
// Resolve target: "@handle" -> handles/{handle} -> profile members is WRONG (profiles are groups);
// handle targeting resolves via users displayNameLower? NO. v1 target = email only, resolved via
// admin auth.getUserByEmail server-side (emails are not public; enumeration hidden below).
// Always return { message: TRANSFER_OFFER_SENT_MESSAGE }. When the account exists and is not the sender:
// re-check recipient held-cap (ticketIndex + pending incoming offers for this event <= maxTicketsPerBuyer),
// create transfers/{id} status "offered" expiresAt now+TRANSFER_TTL_MS, notifyUser(toUid).
// A ticket with an open offer cannot get a second offer (failed-precondition to the SENDER only, since that leaks nothing about the target).
export const respondToTransfer // onCall<{ transferId, accept: boolean }> toUid only, status "offered", not expired
// accept: transaction re-checks ticket still "valid" + recipient cap; mints new ticket under toUid with
// fresh mintQrSecret() + attendee projection replacement (delete old attendee doc, write new one keyed by
// the NEW ticketId) + ticketIndex: from -1 (delete at 0), to +1; old ticket -> "transferred" + transferredTo;
// transfer -> "accepted". decline: transfer -> "declined". Notifications both ways.
// Transfer expiry: add a sweep step flipping expired offers -> "expired" (no doc changes to the ticket).
```

Spec deviation, recorded: the spec says transfers target "@handle or email". `@handle` resolves to a group profile, not a person, so handle targeting is ambiguous by construction. v1 targets email only. Carry this into the rulings doc.

**Steps:**

- [ ] **Step 1:** Failing tests: scan happy path; duplicate scan returns already-checked-in with original time; wrong qrSecret rejected; list override works without secret; non-member curator denied; transfer full lifecycle (offer -> notify -> accept -> new ticket valid under recipient with DIFFERENT qrSecret, old ticket transferred and scan of old secret rejected, indices moved); decline returns untouched; expiry sweep expires; cap blocks accept when recipient full (laundering test: recipient at cap via purchases cannot accept); offer to nonexistent email returns TRANSFER_OFFER_SENT_MESSAGE and creates nothing; self-transfer rejected.
- [ ] **Step 2-4:** Fail, implement, full suite green (`pnpm emu:test` 578 + all new). **Step 5:** Commit: `feat(functions): QR check-in and capped in-app ticket transfers`

### Task 9: Web public event page and buy flow

**Files:**
- Create: `apps/web/app/e/[eventId]/page.tsx` (server), `apps/web/app/e/[eventId]/EventPageClient.tsx` (client), `apps/web/src/events/TierPicker.tsx`, `apps/web/src/events/BuyTicketsFlow.tsx`, `apps/web/src/events/eventDisplay.ts` (plain module: date/price/status label maps, NO "use client")
- Modify: `apps/web/app/u/[handle]/CuratorProfile.tsx` and `MusicianProfile.tsx` (Upcoming Events sections go live), plus whatever server page assembles them
- Test: web lint + build + live page loads (no unit runner on web; the RSC rule makes live loads the gate)

**Interfaces:**
- Consumes: rules from Task 2 (public reads: event published, tiers), callables `createTicketOrder`/`finalizeTicketOrder`, shared messages, Elements setup from the existing SP5 web payment components (find the existing PaymentElement usage in the booking pay surfaces and reuse its stripe.js loader + `stripeAppearance.ts`).
- Produces: route `/e/[eventId]` linked by Task 10's dashboard and the profile pages.

Anatomy (DESIGN.md binding; mirror the mock language of the 9A gig card):
- SSR event page: poster (or branded `PhotoPlaceholder` treatment: surface-to-border gradient + a Phosphor duotone glyph), Syne title, DateBlock-style date, venue card (name, public-precision location, link to `/u/[handle]`), lineup rows (booking acts link to artist pages, external acts plain text), tier picker (name, price, fee shown as "+ $X.XX service fee" per the money-sentence colon conventions, sold-out and sale-window states from shared messages), sticky Buy button (pill, ember, the page's ONE primary CTA).
- Buy flow: quantity stepper per tier (cap hints from `EVENT_BUYER_CAP_MESSAGE` on rejection, do not pre-compute), signed-out users get a sign-in redirect that returns to the event, PaymentElement sheet for paid orders, instant completion for free RSVPs, success state links to the tickets page (Task 10).
- Ticket-holder extras on the same page: when signed in and `users/{uid}/ticketIndex/{eventId}` exists, show the exact address block (read `events/{id}/private/address`).
- Upcoming Events sections: query events where `curatorProfileId == X && status == "published"` ordered by startsAt (curator page); the musician page lists published events whose lineup contains the musician: store a server-maintained `lineupMusicianProfileIds: string[]` array on the event doc (add to Task 1 types; events.ts maintains it) and query with `array-contains` + `status == "published"` equality pin. Both queries are provable under Task 2's rules (published-only read).

**Steps:**

- [ ] **Step 1:** Build `eventDisplay.ts` + components + page with the anatomy above; wire callables; add the two profile-page sections (hidden while empty, per the SP3 contract).
- [ ] **Step 2:** `pnpm --filter @gatekeep/web lint` 0, `pnpm typecheck`, `pnpm --filter @gatekeep/web build`.
- [ ] **Step 3:** Live verification against the emulator (REQUIRED, RSC rule): seed accounts + create/publish an event via a callable script or the Task 10 UI if already merged; load `/e/[eventId]` signed out (page renders, address hidden), and confirm a free RSVP end to end as test-fan.
- [ ] **Step 4:** Commit: `feat(web): public event page, buy flow, live upcoming-events sections`

### Task 10: Web curator events management and fan tickets

**Files:**
- Create: `apps/web/app/dashboard/events/page.tsx` + `EventsManager.tsx` + `EventEditor.tsx` + `AttendeeList.tsx` (client components under `apps/web/src/events/` where shared), `apps/web/app/tickets/page.tsx` + `TicketsClient.tsx` + `TicketQr.tsx`
- Modify: dashboard nav (add Events entry beside the existing booking/payment entries), package.json (web): add `qrcode` (QR svg/canvas rendering, no external fetch)
- Test: lint + build + live loads

**Interfaces:**
- Consumes: every callable from Tasks 4-6 + 8, rules-provable queries: curator events (member read: `curatorProfileId == X` equality pin, any status), buyer orders (`buyerUid == uid`), own tickets subcollection, attendees subcollection.
- Produces: the surfaces the owner smoke-tests.

Anatomy:
- EventsManager: list (poster thumb, title, date, status StatusBadge tone map: draft neutral, published success, completed neutral, cancelled destructive), per-tier sold/capacity bars, create standalone + "promote a filled gig" (picker over the curator's filled gigs without an event), publish + cancel (cancel = destructive confirm panel spelling out auto-refunds).
- EventEditor: fields per validateEventInput, tier rows (add/remove while draft, capacity-raise only after publish, exactly as the callables enforce; surface rejections via shared messages).
- AttendeeList: live onSnapshot table (name, tier, status, checked-in time), search filter client-side, per-row grace-refund button (destructive confirm, calls refundTicket).
- Fan `/tickets`: upcoming/past split on event startsAt, each ticket card shows event, tier, status chip, QR (rendered with `qrcode` from `{ticketId, eventId, qrSecret}` JSON), exact address when the event carries one, and (spec Section: transfers are mobile-led, but web parity is cheap) transfer offer/accept goes MOBILE-ONLY in v1: web shows a "manage transfers in the app" hint. Record as a plan ruling.

**Steps:**

- [ ] **Step 1:** Implement, wiring every callable; keep money sentences byte-consistent with mobile twins where they exist (colon conventions per sp9a ruling 8).
- [ ] **Step 2:** Lint 0, typecheck, build. **Step 3:** Live: as test-curator create + publish an event with 2 tiers, buy as test-fan (free tier), see the attendee appear live, grace-refund it, verify the notification lands in the fan inbox.
- [ ] **Step 4:** Commit: `feat(web): curator events management, attendee list, fan tickets page`

### Task 11: Mobile fan surfaces

**Files:**
- Create: `apps/mobile/app/event/[eventId].tsx`, `apps/mobile/src/tickets/TicketList.tsx`, `TicketDetail.tsx` (full-screen QR), `TransferSheet.tsx`, `src/events/eventDisplay.ts` (shared label maps for both mobile tasks)
- Modify: `apps/mobile/app/(fan)/tickets.tsx` (real screen), `apps/mobile/app/(fan)/index.tsx` (upcoming events list for ticket-holders), `apps/mobile/app/_layout.tsx` (Stack.Screen for `event/[eventId]` with themed header, following the `artist/[handle]` entry), `apps/mobile/package.json` (`react-native-qrcode-svg`)
- Test: mobile lint + typecheck + `expo export --platform ios` bundles

**Interfaces:**
- Consumes: 5b PaymentSheet seam `runPaymentSheet(clientSecret, appearance?)` (`apps/mobile/src/payments/stripe.ts:79`) with the token-based appearance from the 9B sheet appearance helper; callables createTicketOrder/finalizeTicketOrder/offerTransfer/respondToTransfer; ticketIndex reads for the address gate.
- Produces: event route linked from tickets, notifications, and (later, sub-7) discovery.

Anatomy per DESIGN.md tokens/primitives (Text/Button/Card/Chip/Sheet/Skeleton from `src/ui`): event screen mirrors Task 9's anatomy on the RN primitives (PhotoPlaceholder cover, tier picker as Cards with radio selection, one ember Buy button); paid flow: createTicketOrder then runPaymentSheet then finalizeTicketOrder, branching on shared messages with `===`; tickets tab: upcoming/past sections, ticket cards open TicketDetail with max-brightness QR (react-native-qrcode-svg, static dark-theme colors so it scans in both themes), address block, transfer button opening TransferSheet (email input, always shows TRANSFER_OFFER_SENT_MESSAGE); incoming transfer offers render at the top of the Tickets tab with accept/decline.

**Steps:**

- [ ] **Step 1:** Implement screens + package add (`pnpm --filter @gatekeep/mobile add react-native-qrcode-svg`, pure JS, no native rebuild needed for it).
- [ ] **Step 2:** `pnpm --filter @gatekeep/mobile lint` 0, `pnpm typecheck`, `pnpm --filter @gatekeep/mobile exec expo export --platform ios -- --no-bytecode` bundles (local hermesc quirk: plain export works for export; use the flag only if hermesc is blocked).
- [ ] **Step 3:** Commit: `feat(mobile): fan event screen, ticket wallet with QR, transfers`

### Task 12: Mobile curator surfaces (tiers, scanner, attendees)

**Files:**
- Create: `apps/mobile/src/events/TierEditor.tsx`, `ScannerScreen.tsx`, `AttendeeListScreen.tsx`, `apps/mobile/app/(curator)/events/[gigId]` siblings: new routes `apps/mobile/app/(curator)/events/event/[eventId].tsx` + `scan/[eventId].tsx` (check the existing `(curator)/events/` router layout first and follow its structure)
- Modify: `apps/mobile/app/(curator)/events/index.tsx` (events list gains ticketed-event rows + create/promote entry points), `apps/mobile/package.json` (`expo-camera`), `apps/mobile/app.json` if camera permission strings are required (iOS `NSCameraUsageDescription`: "GateKeep scans ticket QR codes at the door.")
- Test: mobile lint + typecheck + expo export

**Interfaces:**
- Consumes: Tasks 4-6, 8 callables; attendees onSnapshot; `expo-camera` barcode scanning (native dep: joins the pending EAS dev build; emulator/export still bundles).

Anatomy: event management screen (status, tiers editor per callable constraints, publish/cancel with destructive confirm, per-tier sold/capacity, sales total); ScannerScreen: camera viewfinder with a scrim frame, on QR decode call checkInTicket with the qrSecret, full-screen result states (success: name + tier on a success tone; duplicate: destructive tone with original check-in time; invalid: destructive), auto-ready for the next scan after 1.5s; AttendeeList tab beside the scanner: searchable, tap row -> confirm sheet -> checkInTicket with `override: true`; refund per row like web.

**Steps:**

- [ ] **Step 1:** Implement + `pnpm --filter @gatekeep/mobile add expo-camera`.
- [ ] **Step 2:** Lint 0, typecheck, expo export bundles.
- [ ] **Step 3:** Commit: `feat(mobile): curator ticketed-event management, door scanner, attendee check-in`

### Task 13: Docs, smoke checklist, final gates

**Files:**
- Modify: `README.md` (sub-6 smoke checklist section + operator notes: no new secrets; expo-camera joins the EAS build; TTL policy note UNCHANGED), `docs/superpowers/HANDOFF.md` (status: 6 merged, 7 next; new gate counts), memory is NOT this task's job (the controller owns memory).

**Steps:**

- [ ] **Step 1:** Write the sub-6 owner smoke checklist (web: create/publish/buy/refund/cancel/address-reveal both themes; mobile: buy via PaymentSheet, QR wallet, transfer between two test accounts, scanner on the new EAS build).
- [ ] **Step 2:** Run EVERY gate from Global Constraints; record exact new counts in the commit message.
- [ ] **Step 3:** Commit: `docs: sub-project 6 smoke checklist and handoff update`

## Self-review (done inline)

- Spec coverage: decisions 1-8 map to Tasks 4 (source union, poster), 1+4 (tiers), 1+5 (fee), 7 (payout), 6 (refunds), 8+12 (check-in), 9+11 (account-required buy), 5+8 (cap + transfers). Address promise: Tasks 2+9+11. Foundation tickets slot: Task 1. Notifications: 5, 6, 7, 8. YAGNI list untouched by any task.
- Two deliberate spec deviations, both recorded for the rulings doc: transfers target email only (handles are group profiles, ruling in Task 8); web transfers deferred to mobile-only (Task 10).
- `refundedFaceCents` is defined in Task 7's note but must be born in Task 1: ADD `refundedFaceCents: number` to `TicketOrderDoc` (Task 1) and maintain it in Task 6. Task 1 implementer: include it.
- Type-consistency pass: callable names, message constants, and doc field names are used identically across tasks 5-12.

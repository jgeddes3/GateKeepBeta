# GateKeep Sub-project 5c: Band Payout Splits (design)

Status: approved in brainstorm on 2026-09-04. This document is the binding authority for
sub-project 5c; the implementation plan argues from it. It contains no em dashes, and neither
may anything built from it (code, comments, copy, docs, commit messages).

Binding context: `DESIGN.md` (repo root) for every visual decision, the antislop skills for UI
and copy, `docs/superpowers/sp5-rulings.md` (Stripe Connect escrow, payouts, idempotency,
sagas), `sp5b-rulings.md` (mobile onboarding through the in-app browser), `sp6-rulings.md`
(ticket settlement), and `sp10b-rulings.md` rulings 5 and 6 (the `source_transaction` cap and
the two webhook scopes). HANDOFF's standing tripwires 2, 3, 5, and 6 all bind this work.

## 1. Goal

Let a band pay its members. Today every profile has one Stripe Express account, every
settlement transfers the whole earning to it, and only a profile admin can cash it out. After
5c a profile admin sets standing shares, every settlement is split into per-member transfers
at the moment it happens, each member cashes out their own account, ticket settlement moves to
one sourced transfer per paid order (closing HANDOFF row 51's platform-float question), and
both clients show a real payout history with admin-only controls.

## 2. Owner decisions (from the brainstorm)

1. **Split model**: standing shares per profile (integer percents summing to 100), applied to
   every settlement after they are set. No per-payout amounts.
2. **Unonboarded members**: their share waits, labelled as held for them, and goes out when
   they finish onboarding. Nothing blocks the other members.
3. **Scope beyond the split**: per-order ticket settlement transfers, payout history, and
   admin-only payout controls on both platforms. Per-musician ticket revenue splits stay
   deferred.
4. **Split point**: at settlement, as per-payee transfers from the platform. Never a reversal
   from the band's account.
5. **Member accounts**: one Express account per person, on the user, onboarded from Account.

## 3. Surfaces

### Both platforms, per profile (the Earnings panel)

- **Shares card** (musician profiles only in the editor; the model is generic, see section 4).
  Admins see one row per current member (label, percent input) plus a "Band fund" row, a live
  sum, and Save. Members see the same rows read-only. Each member row shows a "Held: $X" line
  when the profile holds unreleased shares for that member, and "Not set up for payouts yet"
  when the member has no enabled account.
- **History**: the panel's settlement history is served by `getPayoutHistory` (section 5)
  instead of the client-side scan of payment docs: one row per ledger entry for the profile,
  with split legs nested under their settlement, "Show more" paging. The "Pending settlements"
  list stays as it is.
- **Controls**: "Set up payouts", the cash-out amount and buttons, and the shares editor render
  only for profile admins (client gate on top of the unchanged server gates). Members see the
  balance, held totals, shares, and history.
- **Curator profiles** join the web Earnings page (today it lists musician profiles only), so
  ticket settlements and cash-out are visible to the curator side the same way.

### Both platforms, per user (Payouts)

- Web: a "Your payouts" card on `/dashboard` above "Your profiles". Mobile: an Account row
  "Payouts" pushing a hidden-tab screen `app/(fan)/payouts.tsx`, the sub-8 saved-searches
  shape. The card shows one of: "Set up payouts" (starts member onboarding; web returns to
  `/dashboard/payouts/onboarding/return` and `.../refresh`, mobile opens the in-app browser and
  resyncs on foreground exactly as the profile flow does), "Verifying" (started, not enabled),
  or the enabled state: available balance, instant balance, amount, Standard / Instant buttons
  (same copy and fee rules as profile payouts), a "Waiting for you: $X" line when held shares
  exist, and the user's history (share transfers, releases, payouts) with paging.
- **Notification taps**: `share_paid`, `share_held`, and `share_released` open the Payouts
  surface (web `/dashboard#payouts`, mobile `/(fan)/payouts`); `member_payout_failed` too.

## 4. Data model

### Shares (on the existing profile Stripe doc)

```ts
export type PayoutPayee = { kind: "member"; uid: string } | { kind: "profile" };
export interface PayoutShare { payee: PayoutPayee; percent: number }   // integer 1..100
// StripeProfileDoc gains:
//   shares?: PayoutShare[] | null;   // absent or null = 100% to the profile (today's behaviour)
//   sharesUpdatedAt?: number | null;
```

Validation (shared `validatePayoutShares(shares, memberUids)`): 1 to 20 entries, integer
percents 1 to 100 summing to exactly 100, every member payee a current member uid with no
duplicates, at most one profile payee. Solo profiles and curators may set shares too; the
model is generic and the editor only appears on musician profiles.

### Member accounts

`users/{uid}/private/stripe`:

```ts
export interface MemberStripeDoc {
  accountId: string | null;
  transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  onboardingStartedAt: number | null; onboardedAt: number | null;
  lastPayout?: PayoutRequestRecord | null;
  instantHoldUntil?: number | null;
  updatedAt: number;
}
```

Rules: owner-read, server-write. The Express account's metadata carries `{ uid }` (profile
accounts carry `{ profileId }`), which is how the Connect webhook routes `account.updated`,
`payout.paid`, and `payout.failed` to the right doc.

### Held shares

`heldShares/{idempotencyBase}:{uid}` (deterministic id, so a settlement re-run is idempotent):

```ts
export interface HeldShareDoc {
  profileId: string; uid: string; amountCents: number;
  purpose: "earnings" | "ticket_settlement";
  ref: { bookingId: string; gigId: string } | { eventId: string; orderId: string };
  status: "held" | "released" | "failed";
  createdAt: number; releasedAt: number | null; transferId: string | null; error?: string;
}
```

Rules: read when `isOwner(uid)` or `isMember(profileId)` or admin; server-write.

### Ticket orders (additive)

`TicketOrderDoc` gains `chargeId?: string | null` (stamped when the order is finalized from the
payment intent's latest charge; null for free orders), `settledAt?: number | null`, and
`settlementLegs?: number | null` (how many transfers or holds the order produced).

### Ledger (additive)

`LedgerKind` gains `share_transfer`, `share_held`, `share_released`, `member_payout_standard`,
`member_payout_instant`, `member_payout_failed`. `LedgerEntry` gains `uid?: string | null` and
`orderId?: string | null`. Two composite indexes serve history: `ledger (profileId asc, at desc)`
and `ledger (uid asc, at desc)`. Rules on `ledger` stay admin-only; clients read history only
through the callable.

### Notifications

`NotificationDoc.kind` gains `share_paid`, `share_held`, `share_released`,
`member_payout_failed`; `refKind` gains `"payouts"` (no id needed). `notificationHref` routes
those four to the Payouts surface per platform.

## 5. Backend (`functions/src`)

### Shares (`payoutShares.ts`)

- `setPayoutShares({ profileId, shares })`: admin only; validates against the live members
  list; writes `shares` and `sharesUpdatedAt`; `shares: null` clears.
- `splitCents(amountCents, shares)` (shared, pure): floor each share, remainder cents to the
  largest percent (ties: first in list); the sum equals the input exactly.
- `distributeEarnings(db, stripe, input)` is the single seam every settlement uses:

```ts
interface DistributeInput {
  profileId: string; amountCents: number;
  source: { chargeId: string; remainingCents: number } | null;   // null = unsourced
  purpose: "earnings" | "ticket_settlement";
  ref: HeldShareDoc["ref"];
  idempotencyBase: string;          // e.g. `${bookingId}:${gigId}:earn:${attempt}` or `ticket_settlement:${eventId}:${orderId}`
  meta: Record<string, string>;
}
interface DistributeLeg { payee: PayoutPayee; amountCents: number; outcome: "transferred" | "held"; transferId: string | null; sourced: boolean }
```

  With no shares it makes one transfer to the profile under `idempotencyBase` itself, exactly
  today's call (so existing keys and tests keep their meaning). With shares it computes the
  legs with `splitCents`, then per leg: a profile payee transfers to the profile's account
  under `${idempotencyBase}:share:profile`; a member payee whose `MemberStripeDoc` has
  `transfersEnabled` transfers to their account under `${idempotencyBase}:share:${uid}`;
  otherwise it writes the held doc. Each transfer is sourced from `source.chargeId` only while
  the leg fits inside `source.remainingCents` (the cap rule per transfer, decremented as legs
  are sourced), else unsourced with `sourced: false` in its ledger row. Every leg writes one
  ledger row (`share_transfer` or `share_held`, with `profileId`, `uid`, `bookingId`/`gigId`
  or `eventId`/`orderId`). Legs run sequentially; a failure after some legs throws, the caller
  retries on the next attempt, and the per-leg keys and deterministic held ids make the retry
  safe. A `share_paid` notification goes to each transferred member ("You were paid $X by
  <profile name>"), `share_held` to each held member ("$X is waiting for you. Set up payouts to
  receive it.").
- `releaseHeldShares(uid)`: runs from the `users/{uid}/private/stripe` write trigger when
  `transfersEnabled` flips to true (and from `getMemberPayoutStatus` after a sync, as a
  belt-and-braces path): for every `held` doc of that uid, an unsourced transfer under
  `held:${docId}`, status `released`, ledger `share_released`, one `share_released`
  notification summarising the total. A transfer failure marks `failed` with the error and an
  `adminAlerts` row of kind `held_share_release_failed`; the next sync retries `failed` docs.
- `removeMember` (existing): after its transaction, if the removed uid holds a share, the share
  moves to the band fund (creating the profile entry if absent) and the admins get a `system`
  notification saying so. Held shares for that uid are unaffected (they are already theirs).

### Booking settlement (`paymentsSettlement.ts`)

`finalizeSettlementSuccess` replaces its direct `transferToAccount` with `distributeEarnings`
(`purpose: "earnings"`, `source` from the existing `sourceCandidate` with
`remainingCents = sourceCandidate.amountCents`, `idempotencyBase = ${bookingId}:${gigId}:earn:${attempts}`).
The payment doc's `transfer.*` fields keep their meaning for the profile leg (or the whole
amount with no shares); with shares, `transfer.id` records the first transferred leg and a new
`transfer.legs` count records the fan-out. The `earnings_transfer` ledger row stays as the
settlement's summary row.

### Ticket settlement per order (`paymentsSweep.ts`, `ticketing.ts`)

- `finalizeTicketOrder` stamps `chargeId` on the order from the intent's latest charge (the
  FakeStripe intent object already carries one).
- The T+1 sweep keeps the event query and the `settlementClaimedAt` CAS. Inside the claim it
  reads paid orders and settles each order that has no `settledAt`: amount = `faceTotalCents -
  refundedFaceCents` (skip zero), `chargeId` from the order or, when absent, from
  `retrieveIntent(paymentIntentId)` (stored back), `remainingCents = chargeAmountCents -
  refundedCents`, then `distributeEarnings(curatorProfileId, amount, source, "ticket_settlement",
  { eventId, orderId }, `ticket_settlement:${eventId}:${orderId}`)`; on success it stamps
  `settledAt` and `settlementLegs` on the order and writes the `ticket_settlement` summary row
  with `orderId`. When every paid order is settled it stamps `settlementStartedAt` (kept, now
  meaning "settlement complete") and completes the event as today. A failure mid-way releases
  the claim; the next sweep resumes at the first unsettled order. Free orders and orders with
  nothing left after refunds are marked `settledAt` with zero legs. HANDOFF row 51 closes.

### Member accounts and payouts (`memberPayouts.ts`, `payments.ts`)

- `createMemberOnboardingLink()`: creates the user's Express account (metadata `{ uid }`) if
  absent, returns the onboarding link with the user return and refresh URLs.
- `getMemberPayoutStatus()`: syncs flags from Stripe, releases held shares if newly enabled,
  returns the same shape as `getStripeStatus` minus the card fields, plus `heldCents`.
- `requestMemberPayout({ amountCents, method, requestId })`: the profile payout flow keyed by
  uid (owner check instead of admin check, `MemberStripeDoc.lastPayout` memo, key
  `${uid}:payout:${requestId}`, ledger kinds `member_payout_*`, the same $10 instant minimum,
  instant fee, and self-deal hold rules).
- Webhooks: `account.updated` routes by metadata (`profileId` or `uid`); `payout.paid` and
  `payout.failed` pin the event account to the doc the metadata names (profile or user) and
  write the matching ledger kinds; a failed member payout notifies the user with
  `member_payout_failed`.

### History (`payoutHistory.ts`)

`getPayoutHistory({ scope: { kind: "profile", profileId } | { kind: "user" }, cursor?: string })`:
profile scope requires membership; user scope is the caller. Queries `ledger` by `profileId`
or `uid` ordered by `at desc`, 20 per page, cursor = last `at` plus id. Returns
`{ rows: HistoryRow[], nextCursor: string | null }` where `HistoryRow` is `{ id, kind,
amountCents, at, detail, sourced, ref }` (no Stripe ids). Rows of kind `share_transfer`,
`share_held`, and `share_released` carry the member's display label so the profile view can
nest them under their settlement by `ref`.

### Rules and indexes

`users/{uid}/private/stripe` owner-read; `heldShares` as above; `ledger` unchanged
(admin-only); two `ledger` composites; `heldShares (uid asc, status asc)` and
`heldShares (profileId asc, status asc)` composites for the release path and the shares card.

## 6. Messages (shared)

- `SHARES_SUM_MESSAGE = "Shares must add up to 100%."`
- `SHARES_MEMBER_MESSAGE = "Every share must belong to a current member."`
- `SHARES_ADMIN_MESSAGE = "Only a profile admin can change payout shares."`
- `MEMBER_PAYOUT_SETUP_REQUIRED_MESSAGE = "Set up payouts before cashing out."`
- `SHARE_HELD_MESSAGE = (cents, name) => "$X from <name> is waiting for you. Set up payouts to receive it."` (money sentence rules from `sp9b-rulings.md`).

## 7. Testing

- Shared: `validatePayoutShares` (sum, bounds, duplicates, membership, one profile entry) and
  `splitCents` (remainder placement, exact sum, single share, twenty shares).
- Emulator (FakeStripe): booking settlement with shares (sourced legs, band fund, remainder,
  ledger rows, `transfer.legs`), a held leg then release on the member's `account.updated`
  (the fake account flipped through the real webhook path, plus the status-call path),
  crash resume (fail the second leg once, re-run the attempt, no double transfer), no-shares
  profiles unchanged (existing sub-5 and sub-6 suites stay green), `setPayoutShares` gates and
  validation against live members, `removeMember` moving a share to the band fund, per-order
  ticket settlement (each paid order sourced from its own charge, refunds excluded, free orders
  marked, partial failure resumes at the first unsettled order, the event completes only when
  every order is settled), member onboarding and payouts (key replay, instant minimum, fee,
  `payout.failed` routing to the user), `getPayoutHistory` paging and scoping.
- Rules: `users/{uid}/private/stripe` owner-only, `heldShares` owner or member, ledger still
  admin-only.
- Clients: typecheck, lint, build, export; admin-only controls asserted by reading the code
  paths (no UI tests).

## 8. Out of scope (deliberate)

Per-musician ticket revenue splits; fractional percents; a history of share versions;
recovering already-distributed shares when a settlement is later refunded or disputed (the
existing clawback and dispute paths recover from the profile's account and the platform
balance; a member's transferred share stays theirs); instant-payout fee sharing; curator-side
share editors; email statements.

## 9. Owner-owed after merge

- The Connect webhook endpoint must deliver `account.updated`, `payout.paid`, and
  `payout.failed` for user-owned accounts too (same endpoint, no new subscription needed;
  confirm in the Stripe dashboard).
- `APP_ORIGIN` covers the two new member onboarding return paths.
- Deploy the four new composite indexes.
- Real Stripe test-mode smoke (keys are in place): onboard a member account, set shares on a
  band, settle a booking and a ticketed event, watch the split legs and a held share release,
  cash out as the member.
- A new EAS build is not needed (no native changes).

# GateKeep Sub-project 5c (Band payout splits) - Rulings & Handoff

Durable record from sub-project 5c, executed subagent-driven with per-task reviews (spec compliance
then code quality), scoped re-reviews of every fix round, and a whole-branch final review on the
most capable model followed by one fix wave, merged to `main` on 2026-09-04. Mirrors the earlier
rulings docs. This document, like all sub-5c output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-09-04-band-payout-splits-design.md` (binding authority)
Plan: `docs/superpowers/plans/2026-09-04-band-payout-splits.md` (13 tasks)
Gates at merge: see the gates line in `docs/superpowers/HANDOFF.md` (measured on the final tree).

## What shipped

- **Standing shares** (`functions/src/payoutShares.ts`, shared `payoutShares.ts`): admins of a
  musician profile set `PayoutShare[]` (integer percents summing to 100, up to
  `MAX_PAYOUT_SHARES`, payees are current members or the profile itself) on
  `profiles/{id}/private/stripe.shares` through `setPayoutShares`; `removeMember` and the
  account-deletion cascade move a departing member's share to the band fund
  (`reassignShareOnRemoval`) and tell the admins.
- **Split at settlement** (`distributeEarnings`): the ONLY way earnings reach a profile. Booking
  settlement (`finalizeSettlementSuccess`) and per-order ticket settlement (`settleOneEvent`) call
  it with an `idempotencyBase`; it freezes the leg plan in `distributions/{base}`, transfers each
  leg under `{base}:share:{payee}` (the bare base when the profile has no shares, so every
  pre-5c key is unchanged), sources legs from the charge while they fit, holds a member's leg in
  `heldShares/{base}:{uid}` when that member cannot receive transfers, and returns
  `{ legs, transferId, sourcedAny, heldCents, profileCents }`.
- **Member accounts and payouts** (`functions/src/memberPayouts.ts`): one Express account per user
  on `users/{uid}/private/stripe` (`createMemberOnboardingLink`, `getMemberPayoutStatus`,
  `requestMemberPayout`), webhook routing by `metadata.uid` with the Connect `account` header
  check, `payout.failed` to the user as `member_payout_failed`.
- **Held shares and release** (`releaseHeldShares`, trigger `onMemberStripeWritten`): a member's
  held money moves once their account can receive transfers; per-doc transactional claim, 24-hour
  replay window, `failed` docs retried on every enabled status sync, `voided` on clawback, lost
  dispute, or restore.
- **Per-order ticket settlement**: each paid order carries `chargeId`/`chargeAmountCents` from
  completion, settles under `ticket_settlement:{eventId}:{orderId}` sourced from its own charge,
  and is stamped `settledAt`/`settlementLegs`/`settlementProfileCents`; the event completes only
  when no paid order is pending; a legacy per-event row marks an event settled under the old key.
- **History** (`getPayoutHistory`): ledger-backed paging (20 a page, cursor `at:id`) for a
  profile (members) or the caller's own rows.
- **Clients**: web and mobile Earnings panels gained admin-only payout controls, a shares editor
  (musician profiles), a ledger history list with share rows nested under their settlement; a
  member "Your payouts" surface (`/dashboard#payouts`, `/(fan)/payouts`) with onboarding, balances,
  held money, standard and instant cash-out, and history; notification kinds `share_paid`,
  `share_held`, `share_released`, `member_payout_failed` route there.

## Load-bearing rulings (read before touching the named area)

1. **`distributeEarnings` is the only transfer path for earnings.** A new settlement path calls
   it; never `transferToAccount` directly. Its plan is frozen per `idempotencyBase` in
   `distributions/{base}` (server-only, default-deny rules, no TTL) so a share change between a
   partial distribution and its retry cannot pay twice; the `shared` flag on the plan tells a
   no-shares plan (bare base key) from a 100 percent profile share (`base:share:profile`).
2. **Member shares stay theirs.** Clawback (`clawbackSettledOccurrence`), lost-dispute reversal
   (both the booking and the ticket branch), and restore recover only the profile's own leg
   (`transfer.profileCents`, `order.settlementProfileCents`) and void that base's held shares
   (`share_voided` ledger rows); a member's transferred share is never reversed (spec section 8).
3. **A partial distribution never reopens cancel.** `DistributePartialError` (thrown once any leg
   has moved) is treated as a non-definite failure: the ticket settlement claim stands, and
   `settlementStartedAt` is stamped after the FIRST successful order transfer of a pass so
   `cancelEventCore` refuses once any money moved. A later pass walks the pending orders.
4. **Release is claim-then-transfer.** `releaseHeldShares` claims each doc in a transaction
   (`releaseClaimedAt`, stale after 10 minutes) before the Stripe call under `held:{docId}`, so
   the trigger and the sync hook cannot double-transfer (FakeStripe has no mutual exclusion; real
   Stripe would 409 the second call). Past `IDEMPOTENCY_WINDOW_MS` a doc is replayed only when its
   recorded error was a definite refusal; otherwise `held_share_release_failed` names it for an
   operator. `getStripe()` runs before the loop so a configuration failure never consumes a claim.
5. **Triggers bind the Stripe secret explicitly.** `onMemberStripeWritten` declares
   `secrets: [stripeSecretKey]`; the emulator cannot show a missing binding (FakeStripe is selected
   whenever the Firestore emulator host is set), and `stripeSecrets.test.ts` walks only
   onCall/onRequest/onSchedule exports, so every new Stripe-touching trigger must be checked by
   hand.
6. **Ledger ids are `${kind}:${stripeId}` and may be synthetic.** `held:{...}` pseudo ids and held
   doc ids are legal `stripeId` values (colons are safe) and keep `writeLedger`'s dedupe;
   `getPayoutHistory` cursors split at the FIRST colon and never use `isValidDocId` on a ledger id.
7. **Webhook forgery posture.** `account.updated`, `payout.paid`, and `payout.failed` on the member
   path require the event's `account` to equal the member doc's cached `accountId`; a forged
   `metadata.uid` cannot update another user's doc.
8. **Self-deal holds reach members.** A self-deal booking settlement stamps `instantHoldUntil` on
   every member account that received a leg; `requestMemberPayout` refuses instant payouts under
   it.
9. **Sourcing is frozen per order.** The charge lookup runs once (`chargeId === undefined`); a
   failed lookup leaves the fields unset at completion and the sweep stamps `null` before the
   first transfer, so every replay of `ticket_settlement:{eventId}:{orderId}` carries the same
   params.
10. **Legacy events.** An event settled under the old per-event key (still `published`,
    `settlementStartedAt` set, no order stamped) is recognised by its ledger row with no `orderId`
    field: its orders are stamped without a second transfer, and a lost dispute on such an order
    refuses with an alert instead of reducing the basis.
11. **Copy and gating.** Non-admin members see the balance and "Only profile admins can cash out.";
    the "Not set up for payouts yet" per-member line was dropped (other users' Stripe docs are not
    readable); the held line renders whenever `heldCents > 0` in any state. The spec's held-line
    copy ("as soon as your account is verified") is imprecise in the enabled-plus-failed-release
    case; the next status sync retries. Mobile shows the not-100 total inside a warning `Callout`
    (its brief), web as a destructive-coloured line (its brief).

## Deferred (recorded, not fixed)

- `finalizeTicketOrder` reads the intent twice (status, then `completeOrderTx`); one read would do.
- Two overlapping sweep passes can both inherit a fresh claim and walk the same pending orders
  (pre-existing shape; safe against real Stripe's 409, unsafe only against FakeStripe).
- A lost dispute on a still-pending order under a stale claim changes the amount replayed under
  the per-order key (pre-existing at event scope, now narrowed to one order).
- History grouping keys parents by ref, so a restore re-run's second `earnings_transfer` row
  collapses onto one parent.
- A saved share whose payee is beyond the first `MAX_PAYOUT_SHARES - 1` members has no editor row.
- `getPayoutHistory` does not require a verified email (read-only, brief-mandated).
- No emulator case covers a lost dispute against a partial-distribution settlement with held
  shares (the void-before-lookup ordering in `reverseForLostDispute` is verified by code trace).
- `eventsSettlement.test.ts` exercises only the unsourced path (its fixture leaves the fake intent
  without a charge; `eventsSettlementOrders.test.ts` and the disputes suite cover sourcing).

## Execution lessons (SDD)

- The per-task reviews caught cross-file seams the plan missed (clawback and dispute paths
  treating `transfer.id` as a whole-amount transfer; the per-event dispute predicate; the legacy
  double-pay), and the whole-branch review caught what only the production runtime would show
  (the unbound trigger secret) plus lifecycle gaps (failed releases never retried, held shares
  surviving clawbacks, deletion skipping reassignment). Budget one fix wave; this one took four
  commits.
- FakeStripe caches definite refusals under key plus fingerprint like real Stripe (24 hours);
  failure tests use the `failTransferAccountIds` knob rather than corrupting data under a static
  key.
- A module cycle through the webhook registry (`paymentsWebhook -> paymentsDisputes -> ...`) shows
  up as a TDZ on `webhookHandlers`; `node -e "import('./dist/index.js')"` catches it in a second.
- Never pipe the Firebase CLI to `head`: EPIPE kills the CLI and orphans the Firestore emulator on
  port 8080 with no shutdown endpoint.

## Owner-owed after merge

- Confirm the Connect webhook endpoint delivers `account.updated`, `payout.paid`, and
  `payout.failed` for user-owned accounts (same endpoint, no new subscription).
- `APP_ORIGIN` covers `/dashboard/payouts/onboarding/return` and `/refresh`.
- Deploy the four new composite indexes (`heldShares` by uid and status, by profileId and status;
  `ledger` by profileId and at, by uid and at).
- Real Stripe test-mode smoke: onboard a member, set shares on a band, settle a booking and a
  ticketed event, watch the split legs and a held release, cash out as the member (standard and
  instant), report a no-show and confirm only the band's leg reverses.
- Enable the Secret Manager API for the dev project if the geocoder secret warnings in the
  emulator log matter for a deploy (pre-existing, unrelated to 5c).
- No new EAS build (no native changes).

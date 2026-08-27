# Sub-project 5: Payments — Design Spec

Date: 2026-08-27. Builds on SP4 (`docs/superpowers/sp4-rulings.md` is the binding handoff; the
booking/deposit/settlement machinery referenced here shipped in merge `dcfe5cc`). Stripe **test
mode** throughout — live mode waits for the business entity and is a secrets swap + Connect
activation, never a code change.

## 1. Product decisions (all user-ruled during brainstorming)

- **Architecture: full marketplace via Stripe Connect Express** ("separate charges & transfers").
  The platform account is the escrow; each musician profile gets an Express connected account.
  Money lands in platform escrow first because a deposit's fate (apply / refund / forfeit) is
  unknown at charge time.
- **Fees** (snapshotted per booking, see `feePolicy`):
  - Curator service fee: **+11%** on top of every charge (deposit and settlement each carry
    their proportional share).
  - Musician commission: **−2%** off everything transferred as earnings.
  - Instant cash-out: **−4%** of the payout amount (minimum $1). Standard payout is free,
    1–3 business days. (Stripe's instant-payout cost to us is ~1.5% — confirm current rate at
    implementation.)
  - Late fee: one-time **10%** of the outstanding settlement, added when it goes delinquent;
    split **7% to the musician / 3% to the platform**.
- **Charge timing**: 35% deposit charged at accept (SP4's design), remainder **65% + fee**
  auto-charged off-session at settlement (T+3 days after each occurrence). Full-escrow and
  manual-invoice models were rejected.
- **selfDeal bookings settle normally, fees fully apply** (ruling 11 discharged): paying real
  fees to move your own money removes any farming incentive.
- **Forfeited deposits: musician receives 100% of the deposit base** (no 2% commission on
  forfeits); the platform keeps the curator's 11% fee share on that charge either way.
- **Refunds always include the curator's fee share** (early cancel, musician cancel, admin
  unwind, expiry). We eat Stripe's processing cost.
- **Onboarding gates**: a musician must be payout-ready before applying to a gig or having a
  booking accepted; a curator must have a saved card before sending an offer or accepting an
  application.
- **Platforms**: web-first. Mobile ships read-only payment status + an Earnings summary card
  linking to web; native payment sheets are **sub-5b** (immediately after SP5; requires a new
  EAS dev build for `@stripe/stripe-react-native`).
- **Flash-booking grace period**: within **1 hour of accept** (capped at gig start), either side
  may back out penalty-free — curator cancel refunds the deposit in full; musician cancel earns
  no "No show" mark. Outside the grace hour, SP4's windows apply unchanged and are measured
  against **gig start** (a booking accepted inside 72h/24h of start begins life inside those
  windows — the accept UI shows a "final once accepted" notice, softened by the grace hour).
- **Currency**: USD only.

### Worked example ($1,000 gig)

Curator all-in $1,110. At accept: $388.50 charged ($350 deposit + $38.50 fee share). At T+3 after
the gig: $721.50 ($650 + $71.50). Musician receives $980 (98%). Platform keeps $130 ($110 fee +
$20 commission). If the settlement goes delinquent: +$72.15 late fee → $50.51 extra to the
musician (7/10, floor), remainder to the platform.

**Money math rules**: integer cents everywhere; fees charged to the curator round **up**
(`Math.ceil`); shares paid out round **down** (`Math.floor`); remainders go to the platform.
Base amounts come from SP4's `computeExpectedTotalCents` — the single money path.

## 2. Data model

All writes server-side (callables/triggers/sweeps). Default-deny rules posture unchanged. Money
data has **zero public tier**.

### `bookings/{bookingId}/payments/{gigId}` — per-occurrence money truth

One doc per occurrence (single bookings have exactly one, keyed by their gigId). Created at
accept for materialized future occurrences; created by the materializer at birth for later ones.

```
{
  bookingId, gigId, occurrenceDate,            // denormalized for queries
  curatorProfileId, musicianProfileId, selfDeal,
  baseCents,                                    // this occurrence's expected total (frozen terms)
  deposit: {
    sliceCents, feeShareCents,                  // 35% base + its 11% share
    intentId,                                   // PaymentIntent (shared for accept-batch, own for births)
    status: "unpaid" | "held" | "applied" | "refunded" | "forfeited",
    chargedAt, resolvedAt,
    forfeitTransferId?                          // when forfeited → musician
  },
  settlement: {
    status: "not_due" | "pending" | "past_due" | "paid" | "waived",
    settleAfter,                                // completion + 3 days
    computedCents?, feeShareCents?,             // final − deposit, + its fee share
    trueUp?: { extraMinutes?, extraSongs?, reportedAt },
    intentId?, attempts, nextRetryAt?,
    lateFeeCents?, lateFeeMusicianCents?        // set at delinquency
  },
  transfer: {                                   // musician's 98% (+ late-fee share)
    status: "none" | "pending" | "transferred" | "reversed",
    id?, amountCents?, transferredAt?
  },
  updatedAt
}
```

`waived` covers not-performed outcomes (taken-down occurrence, in-window no-show report, per-date
cancellation): no settlement charge, deposit resolves per the cancellation rules.

### Booking doc additions (`bookings/{bookingId}`)

- `feePolicy: { curatorFeePct: 11, musicianFeePct: 2, instantFeePct: 4, lateFeePct: 10,
  lateFeeMusicianPct: 7 }` — snapshotted at accept next to SP4's `deposit.policy`; later
  fee-constant changes never touch accepted bookings.
- `paymentSummary: { state: "current" | "past_due" | "delinquent", heldCents, paidCents,
  transferredCents }` — aggregate maintained server-side for list UIs.

### `profiles/{profileId}/private/stripe` — per-profile Stripe identity

Members + admins read (exactly the `private/booking` rules shape); server-only writes.

```
{
  customerId?,                                  // curator side: Stripe Customer
  defaultPaymentMethodId?, cardBrand?, cardLast4?,
  accountId?,                                   // musician side: Express account
  transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
  onboardingStartedAt?, onboardedAt?,
  delinquent: false, delinquentSince?           // curator gate flag
}
```

One profile can hold both halves (curator that also performs). Cached account flags are kept
fresh by the `account.updated` webhook; gates read the cache, never call Stripe inline.

### Infra collections (admin read, server write)

- `stripeEvents/{eventId}` — webhook idempotency: `{ type, processedAt, bookingId?, gigId? }`,
  transactionally create-if-absent before processing.
- `ledger/{entryId}` — append-only audit: one row per money event
  (`deposit_charged`, `settlement_charged`, `refund`, `forfeit_transfer`, `earnings_transfer`,
  `late_fee`, `payout_standard`, `payout_instant`, `transfer_reversal`), with cents, actor,
  bookingId/gigId, Stripe object IDs.

### Shared package

Fee constants + `FeePolicy`/`PaymentDoc`/`StripeAccountDoc`/`LedgerEntry` types + pure functions:
`computeFeeShareCents`, `computeSettlementCents` (true-up aware), `computeLateFeeSplit`,
`computeInstantFeeCents`, `computePayoutBreakdown` — all unit-tested like
`computeExpectedTotalCents`.

## 3. The uniform charge path

Curators save a card **before** they can send an offer or accept an application
(`createSetupIntent` → Stripe Elements → off-session mandate on their Customer). Musicians must
be payout-ready **before** applying and are re-checked at accept.

Because of the gates, `acceptBooking` always charges **server-side, off-session** — no two-phase
"awaiting payment" booking state ever exists. Turn order guarantees the charged amount is the
curator's own last thread entry.

**Accept saga** (Stripe calls never inside Firestore transactions):

1. Transaction: validate everything SP4 validates + both gates + curator not delinquent; write
   payment docs (`deposit.status: "unpaid"`) for all materialized future occurrences; stamp
   `feePolicy`; do NOT yet flip booking status.
2. Create + confirm one off-session PaymentIntent for the deposit sum (idempotency key
   `{bookingId}:accept:deposit`).
3. On success — transaction: re-check state, flip to confirmed (all SP4 side effects), mark
   deposits `held`, write ledger.
4. On decline — mark payment docs failed/cleanup, return card-declined error; booking stays in
   negotiation. On crash between 2 and 3 — the reconciliation sweep finds the succeeded intent
   by idempotency key and completes step 3.

Occurrence births (rolling-window materializer) write their payment doc as `deposit: "unpaid"`;
the hourly payments sweep charges them (per-birth intent, key `{bookingId}:{gigId}:deposit`).
Keeps Stripe out of the materializer's staged batch path — one declined card can't block a
series (SP4 isolation philosophy). Birth-deposit declines follow the same dunning track as
settlements.

## 4. Settlement lifecycle

**T+0** — daily sweep completes the occurrence (SP4 step): payment doc → `settlement.pending`,
`settleAfter = completion + 3 days`.

**Window (3 days)** — two things can intervene:

- `confirmOccurrenceActuals` (curator-only, **increase-only**: extra minutes for perHour
  overtime, extra songs for perSong true-up; perSet is flat). Increases benefit the musician,
  so no dispute flow. Decreases don't exist — that's admin territory.
- A no-show report (SP4 `reportNoShow`) → `settlement.waived`, deposit **refunded** to curator,
  mark applies per SP4. Nothing charges, nothing transfers.

**T+3** — hourly payments sweep: compute final from frozen `acceptedTerms` + true-up, charge
`final − deposit` + fee share (key `{bookingId}:{gigId}:settle`), and on success immediately
transfer the musician's 98% of final (deposit → `applied`, key `{bookingId}:{gigId}:earn`).
Defensive rule: if computed final < deposit held (unreachable with increase-only true-ups,
barring not-performed paths), refund the difference instead of charging.

**Dunning** — decline → retries at +1d, +3d, +5d → `past_due` surfaced in UI from first failure;
after the final retry fails: `delinquent` — `paymentSummary.state` and `private/stripe.delinquent`
flip, the **late fee** (10%, 7/3 split) is added to the amount due, and the curator profile is
blocked from `sendOffer` and accepting applications platform-wide. `payPastDue` (fresh card
allowed, on-session) clears the oldest outstanding first; on success the musician transfer
includes their late-fee share, and when nothing remains outstanding the delinquent flag clears.

**No-show reported after transfer** (rare — window catches gig-time knowledge; SP4 allows 14
days): admin-mediated clawback — Stripe transfer reversal + curator refund; `removeReliabilityMark`'s
restore path re-runs the settlement (re-charge + re-transfer). Express accounts enable
`debit_negative_balances`.

## 5. Cancellation money map (SP4 windows unchanged, strict-<, vs gig start)

| Event | Deposit | Fee share on it | Marks |
|---|---|---|---|
| Grace hour (either side, ≤1h post-accept, capped at gig start) | Refunded | Refunded | None |
| Curator cancels ≥72h before start | Refunded | Refunded | — |
| Curator cancels <72h | **Forfeited: 100% of deposit base transferred to musician** | Platform keeps | — |
| Musician cancels (any time) | Refunded to curator | Refunded | <24h → No-show mark (SP4) |
| Admin unwind / moderation / expiry (`expired` + non-null deposit) | Refunded | Refunded | None (SP4 ruling 9) |
| Per-date cancels on runs | Same rules per occurrence, against that occurrence's payment doc | | |

Refunds are Stripe refunds on the original intent (partial by amount when an accept-batch intent
covers several occurrences). Forfeit transfers use key `{bookingId}:{gigId}:forfeit`. Moderation
code is untouched — the payments sweep detects `expired` + held deposit and refunds.

## 6. Payouts

Connected accounts use a **manual payout schedule**; settled earnings sit in the musician's
Stripe balance (Stripe is the balance ledger — no shadow balance doc). The Earnings page reads
balance via callable.

- `requestPayout({ profileId, amountCents, method })`:
  - `standard` — free, Stripe pays out in 1–3 business days.
  - `instant` — requires `instantEligible` (debit card on file); we deduct **4% (min $1)** by
    paying out `amount − fee` and moving the fee to the platform via an account debit transfer.
  - Both append ledger rows; payout webhooks (`payout.paid` / `payout.failed`) update history.
- First payout on a brand-new account can be held up to ~7 days by Stripe (one-time) — surfaced
  in UI copy.
- Onboarding: `createOnboardingLink` returns a Stripe-hosted Express onboarding URL with
  return/refresh routes under `/dashboard/earnings`; `account.updated` keeps the cached gate
  flags fresh.

## 7. Functions surface

New (`functions/src/payments*.ts`, split by responsibility: `paymentsStripe.ts` client wrapper +
DI, `payments.ts` callables, `paymentsWebhook.ts`, `paymentsSweep.ts`):

- Callables: `createSetupIntent`, `createOnboardingLink`, `getStripeStatus` (own-profile gates +
  balance), `requestPayout`, `payPastDue`, `confirmOccurrenceActuals`. Payment docs are read directly
  by clients (rules permit booking sides) — no read callable.
- Webhook: single HTTPS endpoint, raw-body signature verification
  (`stripe.webhooks.constructEvent`), `stripeEvents` idempotency, handlers for
  `payment_intent.succeeded/payment_failed`, `account.updated`, `payout.paid/failed`,
  `transfer.reversed`. Tolerates replay and out-of-order delivery.
- Scheduler: `paymentsSweep` **hourly** — unpaid birth deposits, due settlements (T+3), dunning
  retries, delinquency flips + late fees, `expired`-with-held-deposit refunds, and
  crash-reconciliation (query Stripe by idempotency key for docs stuck mid-saga).
- Modified: `acceptBooking` (saga + gates), `sendOffer` (card + delinquency gate), `applyToGig`
  (payout-ready gate), cancel/per-date-cancel callables (refund/forfeit wiring), `reportNoShow`
  (settlement waive/clawback hooks), `removeReliabilityMark` (settlement re-run), materializer
  (payment-doc births), daily sweep (settlement scheduling on completion).
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` via `defineSecret()` (geocoder pattern);
  emulators run the fake client unless the secret is present.

**Client-supplied amounts never exist** — callables take IDs (+ true-up quantities); every cent
is computed server-side from frozen terms + `feePolicy`.

## 8. Web UI (Next.js)

- **Musician — `/dashboard/earnings`**: available balance, two cash-out buttons (instant with
  fee in dollars, standard free), pending settlements with payout dates, history (payouts,
  earnings, forfeits-received incl. "100%" framing), onboarding entry + return/refresh pages,
  payout-readiness banner.
- **Curator — booking detail Payments panel**: card on file (update via Elements modal),
  per-occurrence rows (deposit held / settles-on date + report-actuals link / past-due +
  pay-now / future birth pending), totals incl. fees, delinquency warning bar.
- **Gate prompts inline**: save-card modal before first offer/accept; "finish payout setup"
  interstitial for musicians before apply/accept.
- **Accept flow**: fee breakdown + deposit amount shown before confirming; "final once
  accepted" notice when start <72h (with grace-hour copy).
- Stripe.js/Elements only on web this sub-project.

## 9. Mobile (read-only this sub-project)

Payment status chips on booking detail + occurrence rows (driven by `payments` docs the rules
already let booking sides read), an Earnings summary card (balance + pending via
`getStripeStatus`) linking to web for actions, and gate messaging pointing to web. No native
Stripe module until sub-5b.

## 10. Security & testing

- **Rules**: `payments` subcollection readable by the two sides' members + admins (recursive
  proof mirrors the booking doc), server-write only; `private/stripe` mirrors `private/booking`;
  `stripeEvents`/`ledger` admin-read only. Rules tests prove the full matrix (both sides, other
  member, non-member, admin, unauth).
- **Webhook** is the codebase's only non-callable HTTPS entry — signature + idempotency +
  App-Check-exempt by nature; gets dedicated security-gate attention.
- **Sagas**: Stripe outside transactions; compare-and-set state advancement; idempotency keys
  `{bookingId}:{gigId}:{purpose}` on every Stripe mutation; hourly reconciliation for stuck docs.
- **Tests**: shared math unit tests (fees, splits, true-ups, rounding edges, overflow); emulator
  functions tests against an injected fake Stripe client (decline-at-accept, decline-at-settle →
  dunning → late fee, webhook replay, out-of-order events, crash between charge and record,
  birth-deposit decline, grace-hour paths, forfeit/refund paths, selfDeal fees, clawback);
  rules suite for new collections; manual smoke script against real test mode (test cards incl.
  a decline-after-save card and instant-payout simulation).

## 11. Scope boundaries

**Not in SP5**: mobile payment sheets (sub-5b), dispute/chargeback flows beyond Stripe dashboard
defaults, tax forms/1099s, statements/exports, multi-currency, live-mode activation, platform
payout accounting/reporting. **Carried forward untouched**: `resumeSeries` tripwire (sp3 ruling
19). **Picked up from SP4's deferred list**: `inviteMember` gains `isValidDocId(profileId)`;
`respondToInvite` gains inviteId shape validation.

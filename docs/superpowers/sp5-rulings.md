# GateKeep Sub-project 5 (Payments), Rulings & Handoff

Durable record from sub-project 5, executed subagent-driven with two-stage reviews on
`worktree .worktrees/sp5-payments` and merged to `main` on 2026-08-28 (merge `160bed5`). Travels
with the repo so any device/session can plan later sub-projects without this machine's context.
Mirrors `sp2-`/`sp3-`/`sp4-rulings.md`.

Spec: `docs/superpowers/specs/2026-08-27-payments-design.md`
Plan (as-built, every review round folded into per-task blocks + as-built contract blocks):
`docs/superpowers/plans/2026-08-27-payments.md`
Prior records: `docs/superpowers/sp2-`/`sp3-`/`sp4-rulings.md` (SP5 annotated sp4's resolved items in place).

## Architecture as shipped

Stripe Connect Express, **separate charges & transfers**: every charge lands in the platform
account (escrow); transfers to musicians' Express accounts happen only at resolution. One narrow
`StripeLike` interface (`functions/src/stripeClient.ts`) with a Firestore-backed `FakeStripe`
double (honours idempotency-key replay + failure caching + fingerprint mismatch) and a `RealStripe`
adapter. **The entire 578-test emulator suite runs keyless**, `getStripe()` selects the fake under
`FUNCTIONS_EMULATOR`/`FIRESTORE_EMULATOR_HOST`, a real key otherwise, and **throws** if neither
(fail-closed: a keyless prod deploy refuses money ops loudly, never fakes them). Live keys are a
config swap, no code change.

Money truth per occurrence: `bookings/{bookingId}/payments/{gigId}` (`PaymentDoc`), server-written
only, readable by both booking sides' members + admins. Booking gains `feePolicy` + `paymentSummary`
snapshots at accept. `profiles/{id}/private/stripe` holds each profile's Stripe identity + cached
gate flags. `stripeEvents` (webhook idempotency), `ledger` (append-only audit, deterministic
`{kind}:{stripeId}` ids), `adminAlerts` (durable operator escalations), all admin-read/server-write.

Module split: `stripeClient` → `paymentsCore` (primitives: gates, buildPaymentDoc, ledger, summary,
resolveDepositPending, alerts, clearDelinquencyIfSettled) → `paymentsSettlement` (settlementMath,
chargeSettlement, finalizeSettlementSuccess, recordSettlementFailure, clawback, restore) →
`paymentsSweep` (hourly reconciler). `paymentsPayouts`, `payments` (identity + payPastDue +
confirmOccurrenceActuals + releaseStuckSaga), `paymentsWebhook` (the sole non-callable HTTPS entry).

## Product decisions (owner-ruled; binding)

1. **Fees**: curator **+11%** service fee per charge; musician **−2%** commission on earnings;
   instant cash-out **−4%** (min $1); late fee **10%** of the outstanding, split **7 pts musician /
   3 pts platform**. Snapshotted per booking in `feePolicy` at accept, later constant changes never
   touch an accepted booking. Rounding law: curator fees round **up**, payout shares round **down**,
   remainder to the platform.
2. **Charge timing**: 35% deposit at accept (card saved, off-session), remaining 65% + fee
   auto-charged per occurrence at settlement (**T+3 after gig END**).
3. **Forfeited deposit → musician gets 100% of the base** (no commission on forfeits); platform
   keeps the curator's fee share on that charge.
4. **Refunds always include the curator's fee share** (early cancel, musician cancel, admin unwind,
   expiry). Platform eats Stripe processing cost.
5. **selfDeal bookings settle with full fees** (ruling 11 discharged), AND (SP5 security ruling)
   their forfeit/earnings-funded balance carries a **3-day instant-payout hold**
   (`instantHoldUntil`, `SELF_DEAL_HOLD_MS`): standard payout only until the card settles. Kills the
   fast card→cash self-deal conversion; legit venue-owner-performs case still works.
6. **Onboarding gates**: musician must be payout-ready (`transfersEnabled`) to apply/be-accepted;
   curator must have a saved card + not delinquent to offer/accept.
7. **Payout authority = profile ADMINS only** (SP5 security ruling H2): `createOnboardingLink` +
   `requestPayout` are `requireProfileAdmin` (onboarding sets the payout bank destination; payout
   drains the balance, gated like `removeMember`/`transferAdmin`). Members keep read-only status.
   `getStripeStatus`/`createSetupIntent`/`payPastDue`/`confirmOccurrenceActuals` stay member/side-gated
   (own-card / booking-side actions, not payout).
8. **Instant payout minimum $10** (`INSTANT_PAYOUT_MIN_CENTS`, security ruling M4), stops
   fee-burn; standard payout unaffected (≥ $1).
9. **1-hour post-accept grace**, both sides (`CANCEL_GRACE_MS`): a flash booking accepted already
   inside the 72h/24h windows can be undone penalty-free within 1h of accept (capped at gig start).
10. **Web-first**: mobile is read-only this SP (status chips + earnings card). Native payment sheets
    are **sub-5b**.

## Load-bearing engineering rulings (from reviews)

- **No client-supplied amount ever reaches Stripe**, every cent is server-derived from frozen
  `acceptedTerms` + `feePolicy`; callables take ids (+ validated bounded true-up quantities).
- **Stripe calls never inside Firestore transactions.** Saga order: transactional validate/stage →
  Stripe call → transactional record. Crash windows closed by **attempt-scoped idempotency keys**
  (`{bookingId}:{gigId}:{purpose}:{attempt}`) + the hourly sweep's reconciliation. `chargeOffSession`
  THROWS on any non-success (`StripeCardDeclinedError` w/ code, `StripePaymentPendingError` w/
  intentId); returns `{id, chargeId}`.
- **24h idempotency-key expiry is a real hazard.** A retry past 24h mints a *second* real
  charge/transfer. Every re-issue point guards it: persist-before-charge counters, a
  `chargingSince`/pending-intent terminator that refuses + escalates rather than re-deriving a stale
  key. The accept saga, birth deposits, settlement (sync AND webhook paths, the last double-pay
  window, closed by security M2), payouts all respect it.
- **The webhook** verifies the signature and FAILS CLOSED on an empty secret (security H3); records
  events exactly-once via a re-claimable `stripeEvents` claim machine (a failed handler stamps
  `failedAt` for immediate re-claim; stale in-flight claims re-claim after `STALE_CLAIM_MS`);
  dispatches on `metadata.purpose`; refuses any `payment_intent.succeeded` bearing a connected-account
  `event.account` (security M1, a connected account can't forge a platform finalization); pins
  account/payout events to the cached `accountId`; uses `hasOwnProperty` dispatch guards.
- **`unpaid` is a debt-query answer, not a resting state** (`DepositStatus` state map, `types.ts`):
  no path may leave a doc `unpaid` once its obligation is discharged. Absorbed deposits (a settlement
  charging the full base because the deposit was never credited) resolve to `refunded`.
- **Never filter payment-doc sweeps by parent booking status**, a cancelled/expired booking's
  past-start held doc legitimately settles later (the musician performed). Gig-linkage
  (`gig.bookingId == X && status == "filled"`) is the only defense.
- **Durable escalation over silent logging**: every absorbing/stuck state raises an `adminAlerts`
  row (throttled hourly console). `releaseStuckSaga` (admin) is the manual unwedge for a stranded
  accept saga; `payPastDue` is the curator's self-serve exit from delinquency (settlement OR
  exhausted-deposit modes).
- **Reliability/clawback loop can't be farmed**: report→clawback→admin-restore→re-report is refused
  (once-per-booking mark guard, in-transaction, ignores `removedByAdmin`); restore re-run bumps
  `attempts` for fresh keys and leaves the deposit refunded so it re-charges the full base.
- Payment-status display logic (`paymentRowKind`, `PAID_DEPOSIT_STATUSES`, `DEPOSIT_EXHAUSTED_ATTEMPTS`)
  and user-facing message constants live once in `packages/shared` (`paymentDisplay.ts`,
  `messages.ts`), web + mobile + functions import them; labels stay per-platform.

## Audits at merge

Whole-branch **security audit**: FAIL → remediated → **PASS** (3 HIGH: missing `secrets`
declarations, fail-open webhook, connected-account confusion; + 4 MEDIUM incl. the last double-pay
window and silent absorbing states; + lows). Whole-branch **rules audit**: **SECURE 21/21**
access-meaningful mutations caught, full client-query provability matrix passes, purely additive
(no pre-existing rule weakened). Final review: **READY TO MERGE**, back-compat with pre-SP5 data
verified (optional fields + `?? default`, no backfill).

Gate counts at merge (all green): `pnpm typecheck` 5/5 · shared 149 · `pnpm emu:test` **578** ·
`pnpm emu:rules` **77** · web lint 0 · web build · mobile lint 0 · `npx expo export --platform ios`.

## LAUNCH CHECKLIST (operator go-live, from README's SP5 section)

1. Register the deployed `stripeWebhook` endpoint in the Stripe dashboard; subscribe to
   `payment_intent.succeeded` + `.payment_failed`, `transfer.reversed`, `account.updated`,
   `payout.paid` + `.failed`; store the signing secret via
   `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET` (the endpoint fails closed until set).
2. Enable a Firestore **TTL policy on `stripeEvents.expireAt`** (the field is stamped; only the
   policy deletes, else unbounded growth).
3. Set `STRIPE_SECRET_KEY` secret + `APP_ORIGIN` on the functions deploy; set
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and **rebuild web** (baked at build time, not runtime).
4. Confirm the **7 new composite indexes** build "Enabled" on the real project (1 `bookings` +
   6 `payments` collection-group; the emulator does not enforce them, a missing one makes the sweep
   throw).
5. **Re-verify `RealStripe.debitConnectedAccount`** (legacy `charges.create({source})` form) against
   current Stripe Connect docs before live, exercised only against FakeStripe today.
6. Re-verify the **4% instant-payout fee** against Stripe's current instant-payout cost before live.
7. Activate Stripe Connect (Express) + swap in the live-mode secret (no code change).
8. Confirm the hourly `paymentsSweep` Cloud Scheduler job provisioned; monitor `adminAlerts`.
9. Do **NOT** App-Check-enforce over `stripeWebhook` (protected by signature + idempotency).
10. Run the README's **manual real-test-mode smoke walkthrough** (the one thing the emulator can't
    prove: real card 4242, decline-after-save 4000…0341, onboarding, 3DS 4000…3155, instant payout).

Still carried from prior SPs (launch blockers not SP5's to fix): the `staging/` 24h GCS lifecycle
rule (SP2), native App Check (business accounts), EAS production build.

## Deferred / follow-ups

- **sub-5b**: mobile native payment sheets (`@stripe/stripe-react-native`; needs a new EAS dev
  build). Backend is done; sub-5b is UI wiring only.
- **sub-5c** (owner request): **admin-initiated member payout splits**, distribute a profile's
  balance among band members. Needs its own brainstorm→spec→plan: multiple connected accounts per
  profile + a split-specification surface. Marker at `paymentsPayouts.ts` requestPayout.
- **`resumeSeries` tripwire, STILL OPEN** (carried unchanged from sp3-rulings ruling 19 through SP4
  and SP5): pause remains one-way. The approval-gate + `pausedBy` requirements bind whoever adds it.
- SP4 scale follow-ups still open (README records them): materializer birth-decision race, sweep
  step-6 `db.getAll` batching, `functions/test` helper duplication, BookingInbox pagination.
- `PAID_DEPOSIT_STATUSES`/`paymentRowKind` now single-sourced in shared, but a `getStripeStatus` TTL
  cache (M7) and a `revokeAdmin`/`checkRevoked` path (L9) were noted, not built.
- **sub-6 (events)**: build on completed bookings; SP4's Shows contract is discharged. **sub-8
  (search)**: both directories still placeholder-grade (SP4 handoff).

## Environment (fresh clone, any machine)

Same as sp2/3/4-rulings: corepack pnpm shim, Temurin JRE on PATH for emulators,
`FUNCTIONS_DISCOVERY_TIMEOUT=60` on Windows, `next typegen` in apps/web after clone. PS 5.1 corrupts
UTF-8 on `Get-Content`/`Set-Content` pipelines, edit docs with byte-safe tools only. The emulator
suite auto-backgrounds past the 600s tool cap on this machine; run it as a single blocking foreground
call and wait, never fire-and-forget. Stripe keys never in the repo: `functions/.env`
`STRIPE_SECRET_KEY` for local real-mode, `apps/web/.env.local` `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
(both gitignored); emulator needs neither.

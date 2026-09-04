# GateKeep Sub-project 10 (Hardening, branches A and B) - Rulings & Handoff

Durable record from sub-project 10, executed on two branches (A: the mechanical sweep, Node 22,
index overrides, CI, merged 2026-09-02 at `ee433d4`; B: the hardening proper), subagent-driven
with per-task reviews, a whole-branch security audit, a rules audit on the changed blocks, and a
merge to `main`. Mirrors the sp2 to sp9b rulings docs. This document, like all sub-10 output,
contains no em dashes, and CI now refuses one anywhere in the repo.

Spec: `docs/superpowers/specs/2026-09-02-hardening-design.md` (binding authority)
Plans: `docs/superpowers/plans/2026-09-02-hardening-sweep.md` (branch A, 5 tasks) and
`docs/superpowers/plans/2026-09-02-hardening.md` (branch B, 36 tasks, 0 to 35)
Gates at merge: filled in by Task 35 Step 7.

## What shipped

No fan-facing feature. Every item traces to the 2026-09-01 audit (`docs/superpowers/audit-2026-09-01.md`).

- **Branch A**: em-dash sweep (zero U+2014 across apps, functions, packages, tests-rules,
  scripts, docs, README, DESIGN.md, rules), Node 22 (`engines`, `firebase.json`, `.nvmrc`), the
  `tickets.orderId` and `members.uid` override shapes repaired and the unused
  `gigs (bookedMusicianProfileId, startsAt)` composite deleted, `.gitignore` additions, CI with
  the em-dash grep as its last step, dependabot.
- **Money** (`functions/src`): transfer sourcing only when the earnings fit the source charge
  (`sourced: false` otherwise); `STRIPE_CONNECT_WEBHOOK_SECRET` and scope-checked dual
  verification; `charge.dispute.created`, `charge.dispute.closed`, `charge.refunded` handlers
  with `disputes/{disputeId}`; the settlement webhook race closed by a 15-minute owner window;
  captured pending orders completed and stuck ones alerted; `settlementClaimedAt` before the
  ticket transfer.
- **Lifecycle**: events follow the profile (unpublish cancels and refunds future published
  events, drafts flip to cancelled, failures retry via `eventCascadeRetries` and dailySweep step
  9); admin `takedownEvent`; deletion refusals with named blockers on `deleteProfile` and
  `deleteAccount`; `onUserDeleted` calling `cascadeDeleteUser`; push-token rules split and
  pruning; the small lifecycle leftovers of spec 5.6.
- **Product fix-nows**: fail-closed geocoder; browse projections seeded and preserved; the
  booking visibility toggle; the verify-email banner and `EMAIL_NOT_VERIFIED_MESSAGE` retry;
  poster upload via `posterUploads/{uid}/uploads/{nonce}`; `notificationHref` and the mobile notification
  handler; scanner offline panel, launch-zone reminder copy, `undoCheckIn`, the 12-hour check-in
  window; `cancelTicketOrder`, the 5-minute `ticketOrderExpiry`, the sales-final line,
  `receipt_email`, the gig re-promotion refusal, the pending-orders cap; the booking clarity set
  (`fillMode`, run notices, party links, reliability line, reopened-date bookings, past-start
  guards, counter cap reason, offer-expiry notice, grace warnings, step 6 skip); series auto-end,
  propagation skip, inclusive end date, "(UTC)" summaries; env-driven Firebase config,
  project-aware seed scripts, scheduler `retryCount`, `timeZone`, webhook `timeoutSeconds`.

## Load-bearing rulings

1. **Unpublish policy** (owner decision 3). Rejecting an approved curator cancels and refunds
   every future `published` event automatically, full refund including the fan-paid fee, holders
   notified with the existing cancellation notification and the reason "The organizer's account
   is no longer active"; `draft` events flip to `cancelled`; completed and already cancelled
   events are untouched. Each event is its own try/catch; a failure lands in
   `eventCascadeRetries/{eventId}` and dailySweep step 9 drains it. `createTicketOrder` and
   `settleOneEvent` also require the curator profile to be `approved`, closing the ISR window and
   any path the cascade misses. The public events read rule is unchanged.
2. **Dispute policy** (owner decision 4). Record, alert, and gate on open: ledger
   `dispute_opened:{disputeId}`, alert kind `dispute_opened`, `declareCuratorDelinquent` plus a
   member notification for a curator charge, `disputeId` and `disputeStatus: "open"` on a ticket
   order. On a lost dispute reverse the matching transfer (earnings or forfeit, idempotency key
   `dispute_reverse:{disputeId}`; for a ticket order, a partial reversal of the event's
   settlement transfer or a reduction of the pending basis); alert `dispute_reversal_failed` when
   the reversal throws or no transfer exists. On a won dispute clear the gate
   (`clearDelinquencyIfSettled`). Evidence submission stays manual in Stripe. A dashboard refund
   the ledger does not know is `external_refund:{refundId}` plus an alert.
3. **Deletion policy** (owner decision 5). `deleteProfile` refuses, in this order, with
   `DELETE_PROFILE_BALANCE_MESSAGE` (live Stripe balance non-zero),
   `DELETE_PROFILE_DELINQUENT_MESSAGE`, `DELETE_PROFILE_PAYMENTS_MESSAGE` (a payment doc naming
   the profile on either side with a deposit in `held`, `refund_pending`, `forfeit_pending`, or
   attempted `unpaid`, or a settlement in `pending` or `past_due`), and
   `DELETE_PROFILE_EVENTS_MESSAGE` (a `published` event, or a paid order with no
   `settlementStartedAt`). `deleteAccount` refuses with `DELETE_ACCOUNT_TICKETS_MESSAGE` (a
   `valid` or `checked_in` ticket to an event whose `endsAt` is in the future),
   `DELETE_ACCOUNT_TRANSFERS_MESSAGE` (an `offered` transfer on either side), or
   `DELETE_ACCOUNT_ORDERS_MESSAGE` (a `pending` order). Nothing is unwound automatically by
   deletion. The allowed path writes the Stripe customer and account ids into the audit entry
   (`profile_deleted_stripe_ids`) before `recursiveDelete`; account deletion writes
   `account_deleted`. Both clients render the refusal inline, never a bare alert.
4. **Em-dash sweep policy** (owner decision 6). One mechanical sweep of the whole repo, replacement
   chosen by context (colon, comma, period, parentheses), test assertions and README quotes
   updated to match, `apps/web/AGENTS.md` gitignored instead of edited, DESIGN.md's statement of
   the rule names the character instead of printing it. Enforced afterwards by CI's last step
   (`git grep -I` for U+2014 over the swept paths). En dashes in ranges and middots stay.
5. **`source_transaction` cap** (spec 4.1). A transfer is sourced from a charge only when
   `math.earnings <= sourceChargeAmountCents` (`math.chargeTotal` for a settlement,
   `deposit.chargeAmountCents` for a deposit; legacy docs without the field fall back to
   unsourced). An unsourced transfer records `sourced: false`. The forfeit transfer is always
   within the deposit charge and stays sourced. `FakeStripe.transferToAccount` refuses a sourced
   transfer whose amount plus every earlier sourced transfer against the same charge exceeds the
   charge amount, with the same error shape as a live `balance_insufficient`. The standard $1,000
   settlement is therefore unsourced and pays $980.
6. **Two webhook scopes** (spec 4.2). `constructWebhookEvent` verifies against
   `STRIPE_WEBHOOK_SECRET`, then `STRIPE_CONNECT_WEBHOOK_SECRET`, and returns which secret
   verified. An event verified by the platform secret that carries `account` is refused (the SP5
   M1 guard); an event verified by the Connect secret without `account` is refused. Either secret
   missing outside the emulator is a 500 (fail-closed). Endpoint A ("Your account") carries the
   payment-intent, transfer, dispute, and refund events; endpoint B ("Connected accounts")
   carries `account.updated` and `payout.*`.

## Execution rulings

Numbering continues from 7. Each entry condenses one "Ruling:" line recorded during execution in
`.superpowers/sdd/2026-09-02-hardening/progress.md` (this worktree, gitignored).

7. Task 0: skipped a baseline gate re-run, reusing SP7's merge-time numbers (5/5, 167, 735, 114)
   since the tree was identical to what SP7 verified at merge.
8. Task 1: adopted Task 9's four `ALERT_KIND_LABEL` strings to resolve a copy collision; Task 9
   Step 6 became verify-present rather than re-authoring them.
9. Task 4: every registered webhook handler declares its scope (platform or connect) and the
   dispatcher refuses a delivery whose verified scope does not match the handler's; also fixed
   two stale comments in `paymentsWebhook.ts` and `stripeClient.ts`.
10. Task 7: "typecheck 5/5" means pnpm's "5 of 6 workspace projects" with all four typecheck
    scripts passing; `tests-rules` has none, and that is pre-existing.
11. Task 8: `completeOrderTx` failures on the reconcile path now raise a `ticket_order_stuck`
    alert with a "completion failed" detail, in addition to bumping the error counter.
12. Task 9: accepted all four review findings; the dispute transaction treats a fresh
    `settlementClaimedAt` as settlement-in-progress with a non-null reason so
    `dispute_reversal_failed` fires, plus a definite-refusal allowlist and a conditional
    transactional claim release.
13. Task 9/10: the curator-status gate runs after the fresh read and before
    `claimSettlementStart`, so a withheld event never takes a claim.
14. Task 10: fix round 1 closed the poisoned-retry and cascade-listing-failure gaps via a new
    `event_cascade_stuck` alert kind, a merge-and-increment retry doc, and `timeoutSeconds: 540`
    on `reviewProfile`.
15. Task 11: the live `/admin` load is not runnable by a subagent (no signed-in admin session);
    lint and build stand in, and the Events block joins the owner smoke list; `takedownEvent`
    joins the `stripeSecrets` allowlist.
16. Task 12/13: live-load steps follow the Task 11 lint-and-build substitution; `deleteProfile`
    joins the `stripeSecrets` allowlist via `getBalances`.
17. Task 12: after the opus reviewer failed repeatedly on API overload, a sonnet reviewer covered
    this money-path task, with the final whole-branch opus review covering it again.
18. Task 15: the expo export gate runs with `--no-bytecode` on this machine (hermesc is
    App-Control-blocked); the on-device signal stays owner-owed.
19. Task 16: gate thresholds are strictly above 808 (`emu:test`) and 114 (`emu:rules`), not the
    plan's stale 704/103; its `review.ts` insertion goes before the batch commit in the reject
    branch, anchored by code since Task 10 reshaped it.
20. Task 20: kept the `EVENT_REMINDER_WINDOW_MS` import from `eventsCore.ts` (SP7 moved it there)
    rather than redeclaring it locally as the brief said.
21. Task 21: the `runTicketOrderExpiry` extraction preserves Task 8's deferred branch and Task 9's
    controller addition; `cancelTicketOrder` and `ticketOrderExpiry` join the `stripeSecrets`
    allowlist.
22. Task 24: kept all three webhook secrets (not the brief's two); the seed-script check runs
    under one-shot `firebase emulators:exec`, never a persistent `pnpm emu`; `.env.example` files
    stay tracked.
23. Task 25: the signed-in browser repro is not runnable here; the guard is proven by reading,
    typecheck, lint, build, and expo export, extending Task 18's existing null-preferences
    tolerance rather than duplicating it.
24. Task 27: live checks are owner-owed; the codemod grep gate plus typecheck, lints, build, and
    export are the proof (opus reviewer for 56+ files).
25. Task 29: `notifyUser` was missing the `data: { kind, refId }` payload the brief assumed
    existed; Task 29 added it with a unit assertion and ran the full `emu:test` gate, preserving
    SP7's mobile inbox branches and Task 15's `unregisterPush`/`registeredToken`.
26. Task 28: live checks are owner-owed; the `getDownloadURL` grep gate plus typecheck, lints,
    build, and export are the proof; `STORAGE_BUCKET` now derives from Task 24's pick-based
    Firebase config.
27. Task 28 fix round 1: the controller read the seven-line single-file diff directly instead of
    a scoped re-review; the finding closed exactly, with no `"use client"` directive in either
    module.
28. Rules audit: the `firebase-security-rules-auditor` skill does not exist on this machine, so
    Task 35 Step 5 substitutes a general-purpose opus reviewer with an explicit rules-audit brief
    over the branch diff, cross-checked against `tests-rules`.
29. Task 31: also fixed Task 21's deferred minor, the stale `TicketOrderStatus` union comment in
    `apps/web/src/events/BuyTicketsFlow.tsx`.
30. Task 32: live checks are owner-owed; gates are typecheck, both lints, web build, and expo
    export (opus reviewer for 20 files).
31. Task 33: proceeded by code anchors after README drifted about 20 lines; the monorepo map and
    design-docs table list SP7's files, the branch B plan cell names
    `2026-09-02-hardening.md`, and the rulings-doc cell reads `sp10b-rulings.md`.
32. Task 35 audits: compare against merge base `d707495`, not `origin/main` (main has one docs
    commit since); the audit briefs' rulings-doc reference is `docs/superpowers/sp10b-rulings.md`.
33. Task 33: the SP8 spec and plan exist only on `origin/main`, not this worktree, so Task 33
    omits its rows; Task 35 adds the two SP8 rows to the README design-docs table and the
    HANDOFF roadmap after merging main.
34. Task 34: the HANDOFF roadmap drops the brief's "7 Fan discovery (in flight)" row (SP7 is
    merged) and leads with 8 Search (owner decision 2026-09-03: subagent-driven in a fresh
    worktree from main once 10B lands, re-running its plan's pre-flight scan first), then 5c band
    payout splits, then Messaging.

### Accepted gaps

- Paused or ended runs keep their `fillMode` stamp so run copy can show on a date that will book
  singly (reopened dates are fixed).
- `unregisterPush` is a no-op for a session that never registered; server pruning is the backstop.
- The ticket settlement claim ages out after 24h, so a stamp write that keeps failing reopens
  cancel on a paid settlement.
- The gig-promotion and pending-cap guards are non-transactional.
- A series paused across its endDate and resumed after it ends does not materialize the skipped
  dates.
- The callable retry currently retries once even for a still-unverified user (closed in the final
  fix wave if it lands).

## Accepted exceptions and deferred (conscious, not oversights)

- Everything in spec section 10: the SP7, SP8, and 5c assignments, the launch checklist's
  console and dashboard work, App Check enforcement, security headers, backups, the accessibility
  and state-coverage findings, messaging, admin tooling beyond the Events block, email delivery
  beyond Stripe receipts, `firebase-admin` 13, ledger rows L62 to L80.

## Audits at merge

Filled in by Task 35 Step 5 and Step 6 (security audit verdict and fix wave, rules audit verdict).

## Owner smoke (the hard pre-launch gate for sub-10)

The consolidated table in `docs/superpowers/HANDOFF.md`, rows 48 to 59: both Stripe endpoints,
the simulated dispute, the new EAS dev build and the smoke additions, the new index and the
repaired overrides, the platform float decision.

## Environment notes

Windows, `corepack pnpm`, Node 22 (`.nvmrc`). Emulator suites need the Java PATH prepend and
`FUNCTIONS_DISCOVERY_TIMEOUT=60`. `pnpm emu:test` is one blocking foreground call of about ten
minutes with a 600000 ms timeout. PowerShell 5.1 corrupts UTF-8 pipelines: docs edits and the
em-dash census run in Git Bash.

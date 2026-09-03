# Audit: sub-projects 5 and 5b (Payments), GateKeep

Date: 2026-09-01. Read-only audit of the Stripe Connect escrow backend, the web and mobile payment surfaces, rules, indexes, tests and docs. Every finding below was verified against code, not docs. Line numbers refer to the files as of merge 4dab485 on main.

Scope read in full: functions/src/{stripeClient,paymentsCore,paymentsSettlement,paymentsSweep,paymentsPayouts,payments,paymentsWebhook}.ts, the accept saga in bookings.ts (700-1520), index.ts, profiles.ts, account.ts, the moderation unwind in bookingLifecycle.ts, the birth staging in scheduled.ts, the payments blocks of firestore.rules, firestore.indexes.json, packages/shared/src/{money,feePreviews,paymentDisplay,messages}.ts and the SP5 part of types.ts, all 11 web payments files plus app/dashboard/earnings/**, all 8 mobile payments files plus app/_layout.tsx, the test inventories of every payments test file, tests-rules/payments.rules.test.ts, and the README / spec / rulings sections named in the brief.

Legend for owner: fix-now (small, do before the next merge), launch-checklist (operator or config step before live mode), SP7, SP8, 5c.

---

## A. Findings

### 1. [Critical, pending live-mode verification] bug: earnings transfers are sourced from a charge smaller than the transfer

Evidence: functions/src/paymentsSettlement.ts:701-719 (sourceChargeId = the settlement charge, or the deposit charge for a zero-charge settlement), functions/src/stripeClient.ts:858-866 (RealStripe.transferToAccount forwards it as source_transaction), functions/src/paymentsCore.ts:474-486 (forfeit transfer, same mechanism, amount <= charge so unaffected).

Defect: the musician's earnings transfer (98% of the FULL base) is created with source_transaction set to the settlement charge, which is only 65% of the base plus its fee share; a zero-charge settlement uses the deposit charge (35% plus fee). Stripe caps a source_transaction transfer at the source charge's amount (the same rule that lets several transfers share one charge only up to its total). FakeStripe does not model that cap (stripeClient.ts:557-576 only sums a balance), so the entire emulator suite passes.

Failure scenario: $1,000 gig in live mode. T+3: the curator is charged $721.50 (intent recorded only on the terminal write), then transferToAccount for $980 sourced from that $721.50 charge is refused by Stripe. The throw escapes finalizeSettlementSuccess and chargeSettlement (neither catches a non-precondition error), the sweep counts an error, the doc keeps settlement.chargingSince set with no intentId. Every hourly run re-derives the same settle:{attempts} key, replays the charge (no double charge inside 24h) and fails the transfer again; after 24h the stale-claim terminator (paymentsSettlement.ts:1032-1048) refuses forever and raises settlement_pending_stuck. Net: every ordinary settlement in live mode charges the curator and never pays the musician automatically. The manual smoke walkthrough step 6 (README 812-819) is the exact step that would surface it.

Action: verify the cap against current Stripe Connect docs alongside the debitConnectedAccount re-check the README already owes. If confirmed: only pass sourceChargeId when math.earnings <= the source charge amount (the forfeit path already satisfies this), otherwise transfer from the platform balance (the deposit charge is days old and available by T+3; the settlement charge is the only fresh one) or split into two transfers. Add a FakeStripe check that a source_transaction transfer cannot exceed the source intent's amountCents so the suite would have caught it. Owner: fix-now, and add to the launch checklist as a must-pass smoke item.

### 2. [High] missing-feature / security: no chargeback or dispute handling at all

Evidence: functions/src/paymentsWebhook.ts:19-34 (registered types), 246-247 (unknown types are recorded and 200'd); no handler for charge.dispute.created, charge.dispute.closed, charge.dispute.funds_withdrawn, charge.refunded, payment_intent.canceled, account.application.deauthorized or capability.updated (grep of functions/src for "dispute" finds only a ticketing comment). stripeClient.ts:755 enables debit_negative_balances but nothing ever uses it for a dispute.

What happens on a chargeback today: Stripe debits the platform balance for the disputed amount plus the dispute fee; the event lands as a stripeEvents doc with processed:true and nothing else. No ledger row, no adminAlerts row, no notification, the payment doc stays paid, the musician keeps the transfer (or the forfeit), the curator profile is not flagged delinquent and can keep booking, and the platform absorbs the loss silently. A curator who disputes a forfeited deposit or a delinquent settlement they were charged for via payPastDue wins by default because nobody submits evidence (the ledger and the booking thread are the evidence and nobody is told to look).

Action (minimum for launch): a charge.dispute.created handler that writes a ledger row (kind dispute_opened, keyed on the dispute id), raises an adminAlert (new kind), flags the curator profile delinquent (declareCuratorDelinquent already exists and is idempotent) and notifies the curator; a charge.dispute.closed handler that records the outcome and, on loss, reverses the earnings transfer via reverseTransfer (debit_negative_balances makes it collectible). Enable Stripe Radar rules and review the marketplace dispute liability setting in Connect. Owner: launch-checklist for the Radar and liability settings, SP7 for the handlers (it touches the same webhook registry SP7 does not otherwise need, so it can also be a standalone fix).

### 3. [High] bug / launch-checklist: one signing secret cannot cover both the platform and the Connect webhook endpoint

Evidence: functions/src/stripeClient.ts:913-917 (a single STRIPE_WEBHOOK_SECRET is used for every delivery), functions/src/paymentsWebhook.ts:170, 180-193 (one endpoint, a failed signature is a 400), README 659-671 (register "the" endpoint and subscribe it to both payment_intent.* and account.updated / payout.*), functions/src/paymentsPayouts.ts:361-372 and payments.ts:332-343 (the M1 guard positively requires event.account, which only a Connect endpoint delivery carries).

Defect: in the Stripe dashboard an endpoint listens either to events on your account or to events on Connected accounts; the two are separate endpoint objects with separate signing secrets. payment_intent.succeeded and transfer.reversed are platform events; account.updated, payout.paid and payout.failed are connected-account events. With one secret, whichever endpoint is registered second fails signature verification on every delivery (a flat 400), Stripe retries for days and then disables it.

Failure scenario: the operator follows the README, registers one platform endpoint, subscribes it to all six types. account.updated and payout.* are simply never delivered to a platform endpoint. Cached gate flags then only refresh when someone calls getStripeStatus (mitigated by the live re-sync in syncStripeAccountFlags), but payout.failed is never processed: a bounced bank payout silently returns to the balance with no ledger row and no notification (the exact case paymentsPayouts.ts:395-403 says nothing else would tell the musician about).

Action: accept a second secret (STRIPE_CONNECT_WEBHOOK_SECRET) and try both in constructWebhookEvent (the event's account field cannot be read before verification, so try-both is the practical shape); declare it in the webhook's secrets list; add the second endpoint to the README launch checklist and to the stripeSecrets tripwire. Owner: fix-now plus launch-checklist.

### 4. [High] bug: deleteProfile has no money gate and destroys the profile's Stripe identity

Evidence: functions/src/profiles.ts:229-251 (only the draft/rejected status gate), 285-288 (recursiveDelete of every gig), 297 (unwindBookingsForModeration, which expires bookings and, per bookingLifecycle.ts:1249-1375, touches no money), 327 (recursiveDelete of the profile removes profiles/{id}/private/stripe). Nothing reads private/stripe first; nothing calls Stripe (no customers.del, accounts.reject, balance check).

What happens today, by asset:
- Connected account with a balance: the Express account and its funds survive in Stripe, but accountId is gone, so no in-app payout is ever possible; only an operator using the Stripe dashboard can pay it out. No alert is raised.
- Pending or past-due settlement where this profile is the musician: chargeSettlement charges the curator's card first (paymentsSettlement.ts:1176-1188), then finalizeSettlementSuccess finds no musician account, records the intent and leaves the doc pending (661-699). The curator is charged for a date whose payee no longer exists; the next run raises settlement_pending_stuck and an operator refunds by hand. Also deleteProfile deleted the gig doc, so the gig_missing branch (1057-1078) fires for any of this profile's own past dates still settling.
- forfeit_pending deposit owed to this musician: resolveDepositPending leaves it pending forever (paymentsCore.ts:455-473); after 24h it becomes a stale_pending_deposit alert.
- Curator profile with held deposits: step 7 refunds future dates (it refunds by intentId, which lives on the payment doc, so this works); a PAST date's settlement can never charge (no customerId), so the musician who performed is never paid and settlement_pending_stuck (no_customer) fires every run.
- Curator past-due debt: uncollectable, and the delinquent flag dies with the doc.
- Saved card / Stripe Customer, Express account: orphaned in Stripe with the cardholder's PII; the profile's users can no longer see or remove them.
- lastPayout memo: lost (the balance check still prevents a double payout).

Action: a fail-closed money gate at the top of deleteProfile: refuse while private/stripe has an accountId whose Stripe balance is non-zero, while the profile is delinquent, or while any payments doc naming the profile on either side is non-terminal (deposit in unpaid-with-attempts / held / applied-with-settlement-not-paid / *_pending, or settlement in pending / past_due). Then, on the allowed path, call customers.del (detaches the card) and accounts.reject or leave the Express account with a ledger note; write an audit row. Note deleteAccount is safe by construction (the sole-admin block at account.ts:18-33 means it never reaches a profile). Owner: fix-now for the gate (small, one read plus one collection-group query per side; the (curatorProfileId, settlement.status) index exists, the musician side needs a matching one), SP7 for the Stripe-side cleanup.

### 5. [Medium] bug: the settlement webhook races its own synchronous finalize and raises a false settlement_raced alert

Evidence: functions/src/paymentsSettlement.ts:1676-1712 (webhook handler passes no baseline), 617-657 (M2 block: when chargingSince is set and fresh, "proceed, terminalBaseline stays undefined"), 659-719 (the webhook path then transfers on the same earn:{attempts} key the sync path is using), 784-807 (whichever terminal write lands second fails its precondition and calls recordRacedSettlement with transfer set), 478-488 (the alert text says money moved in both directions and "unwinding needs a transfer reversal, not a refund").

Defect: in live mode Stripe delivers payment_intent.succeeded within roughly a second, often before the synchronous chargeSettlement path has finished its transferToAccount round trip and terminal write. At that moment settlement.intentId is still null (it is only written by the terminal write) and chargingSince is fresh, so the webhook's finalize proceeds all the way to the transfer. Inside 24h the key replays (or Stripe returns idempotency_key_in_use for a concurrent call, which 500s the webhook and is harmless), so no double payout occurs, but the second terminal write is refused and recordRacedSettlement writes a settlement_raced alert whose instruction (reverse the transfer) is wrong: the doc is correctly paid.

Sibling: the deposit purpose handler (functions/src/bookings.ts:1442-1446) logs "unconsumed charge, needs reconciliation" at error level on every ordinary synchronous accept whose webhook beats transaction B, because the sync path never sets depositChargeIntentId. No alert, but a false error line per accept.

Failure scenario: first week live, a few settlements per day produce settlement_raced tickets telling the operator to reverse a legitimate transfer.

Action: in settlementIntentSucceeded, treat "intentId is null and chargingSince is set and younger than a short in-flight window (say 15 minutes)" as "a synchronous finalize owns this doc": throw so the claim machine marks failedAt and Stripe redelivers, by which time the doc is paid and the replay is the already_paid no-op. For the deposit handler, downgrade the mismatch log to info when depositChargeIntentId is null (the sync path never records one). Add an emulator test that posts the webhook while a fake chargingSince claim is fresh. Owner: fix-now.

### 6. [Medium] ops: six sweep paths still say "needs admin attention" on the console only

Evidence, functions/src/paymentsSweep.ts: 368-376 (staged saga with no depositChargeAttempt), 386-394 (held deposits under an open booking), 405-411 (staged saga, curator has no customer), 497-502 (post-commit unexpected state), 786-792 (birth deposit, curator has no customer), 829-835 (birth charge landed on a doc that moved to a non-pending state: "charge recorded in the ledger only; needs admin attention"), 854-859 (birth intent left processing: alert only arrives one run later via 711-733).

Defect: sp5-rulings' "durable escalation over silent logging" rule is not applied to these; each is a bumpError counter plus a console line, and the report counters are not persisted anywhere (runPaymentsSweep returns the report and the scheduled wrapper discards it, paymentsSweep.ts:1631-1634). 829-835 is the worst: a real charge with no doc state and no ticket.

Action: route each through recordAdminAlert with an existing or new kind (stuck-saga id for the first four, depositRacedAlertId for 829-835, settlementPendingAlertId-style for no-customer). Consider persisting the sweep report to a sweepRuns collection so an operator can see error counters. Alert throttling itself is correct (recordAdminAlert throttles the log to one per UTC day or on kind change, and always updates the row). Owner: SP7.

### 7. [Medium] stale comments and a missed automatic unwind: StripeLike.cancelIntent exists now

Evidence: functions/src/stripeClient.ts:180-181 and 848-851 (cancelIntent added in SP6), functions/src/paymentsSettlement.ts:977-982 ("THE PROPER FIX IS StripeLike.cancelIntent (future) ... StripeLike has no cancel surface yet, so the implemented behavior is REFUSE + ESCALATE"), functions/src/paymentsCore.ts:409-412 ("needs the same future StripeLike.cancelIntent"), functions/src/paymentsSweep.ts:711-733 (a birth deposit carrying any intent, including a merely unconfirmed pay-now intent, raises deposit_pending_stuck with "resolve the intent in Stripe" even though isUnconfirmedPayDueDeposit at paymentsCore.ts:644-648 can tell the two apart).

Failure scenario: a curator opens Pay now, closes the browser. One hour later the sweep flags the profile delinquent (correct) and opens a settlement_pending_stuck ticket asking an operator to cancel a PaymentIntent by hand in the dashboard and then edit settlement.intentId in Firestore, every hour until someone does. Same for the deposit shape.

Action: in the abandonedPayDue branch and in step 3's unconfirmed-pay-due case, call cancelIntent, clear settlement.intentId / deposit.intentId (leave payDueIntentId), and hand the date back to the dunning ladder; treat a cancelIntent throw as "may have succeeded" and escalate as today. Update both stale comments either way. Owner: SP7.

### 8. [Medium] missing-feature: operator actions the alerts prescribe are never reflected back

Evidence: alert texts at functions/src/paymentsSettlement.ts:986-990 ("cancel the intent in Stripe, then clear settlement.intentId"), 1037-1040 ("either refund it and clear settlement.chargingSince, or record its intent id"), 836-839 ("Resolve that intent in Stripe ... then clear deposit.intentId"); no payment_intent.canceled or charge.refunded handler (paymentsWebhook.ts:19-34).

Defect: every recovery ends with an operator editing money fields in the Firestore console by hand, which is exactly the class of write the rules forbid clients from doing, with no audit row and no validation. A dashboard refund leaves the payment doc paid and the ledger silent, so the ledger disagrees with Stripe from then on.

Action: payment_intent.canceled handler keyed by metadata.purpose that clears the matching intentId and re-arms nextRetryAt; charge.refunded handler that writes a ledger refund row (deterministic id off the refund id) and raises an alert when the doc still reads paid; an admin callable (like releaseStuckSaga) for the two field-clears so they are audited. Owner: SP7.

### 9. [Medium] spec-drift / docs: payout authority

Evidence: README 343-344 ("Any member of a profile can trigger its payouts") and 702-707 ("Product decision recorded: ANY member ... requestPayout calls requireProfileMember"); code: functions/src/paymentsPayouts.ts:194-199 and payments.ts:187-192 both call requireProfileAdmin; tests pin it at functions/test/payments.test.ts:144 and paymentsPayouts.test.ts:520-536; sp5-rulings ruling 7 matches the code.

Which is true: the code. requestPayout and createOnboardingLink are profile-admin only; getStripeStatus, createSetupIntent, refreshPaymentMethod stay member-level; payPastDue and confirmOccurrenceActuals are booking-side gated. The README's two paragraphs are stale from before security ruling H2.

Related UX: neither client gates the payout buttons by role (sp5b ruling 6; web EarningsPanel.tsx:315 and 359-368 render for any member, mobile EarningsPanel.tsx:330 and 365-368 likewise), so a non-admin band member sees a live Set up payouts / Standard / Instant button that always fails with "Only profile admins can do that." Mobile's ProfileContext carries no role.

Action: delete the two README paragraphs and state the admin rule there; SP7 or 5c should carry the member role into both clients and render the buttons disabled with the reason. Owner: fix-now (docs), 5c (UI role).

### 10. [Medium] docs: three more README statements contradict code

- README 408 says an unset STRIPE_WEBHOOK_SECRET makes "signature verification run against an empty secret and every real Stripe delivery is rejected". Code fails closed: stripeClient.ts:913-916 throws StripeWebhookSecretMissingError and paymentsWebhook.ts:187-191 answers 500 "webhook misconfigured" (security H3). The 500 is deliberate so Stripe keeps retrying until the secret is set; the README describes the pre-H3 behavior.
- README 306 and 342 describe instant cash-out as "4%, min $1" only; the $10 instant minimum (types.ts:458, paymentsPayouts.ts:213-215, ruling 8 / M4) is missing from both the fee table and the payouts paragraph.
- README 333 says settlement retries at "+1d, +2d, +2d" (matches SETTLEMENT_RETRY_OFFSETS_MS, types.ts:474-475); spec 2026-08-27 section 4 says "+1d, +3d, +5d". These are the same schedule stated as offsets vs cumulative days, but a reader comparing the two documents will think they disagree. Say "days 1, 3 and 5 after the first decline" in both.
- spec section 7 names the client module paymentsStripe.ts (built as stripeClient.ts) and section 2 gives stripeEvents the shape {type, processedAt, bookingId?, gigId?} (built without bookingId/gigId, with receivedAt / processed / failedAt / attempts / expireAt). Cosmetic.

Owner: fix-now (docs).

### 11. [Medium] ux / bug: the balance is hidden until payouts_enabled, but transfers land as soon as transfers is active

Evidence: functions/src/paymentsPayouts.ts:119-125 (readPayoutBalances returns 0/0 unless payoutsEnabled === true), functions/src/paymentsCore.ts:127-133 (the booking gate only requires transfersEnabled), web EarningsPanel.tsx:312 and mobile EarningsPanel.tsx:327 (the "Set up payouts" branch shows whenever payoutsEnabled is false).

Failure scenario: an Express account whose transfers capability is active but whose payouts are still pending verification (a missing bank account, an ID check) is bookable and receives real transfers; the Earnings page shows the onboarding prompt and, if it showed a number at all, would show $0.00. The musician sees "You've been paid" notifications and no balance. The StripeStatusResult contract says 0 means "asked, nothing there", which is false here.

Action: read the balance whenever accountId exists; show the balance and a separate "payouts not enabled yet: finish verification" notice; keep the cash-out buttons disabled until payoutsEnabled. Owner: SP7.

### 12. [Medium] missing-feature: no receipts, statement descriptors, customer identity or curator charge notifications

Evidence: functions/src/stripeClient.ts:683-686 (customers.create with metadata only: no email, no name), 791-799 / 816-843 (PaymentIntents carry no description, statement_descriptor_suffix or receipt_email), functions/src/paymentsSettlement.ts:860-865 (the successful settlement notifies the musician only; the curator gets no "you were charged $X" message on the sync path; the curator is only told about failures), functions/src/paymentsSweep.ts:837 (birth deposit charge: no curator notification on success), ledger is admin-read only (firestore.rules:226).

What exists: the curator sees per-occurrence rows and a running total in PaymentsPanel; the musician sees transfers and forfeits in EarningsPanel history; Stripe's own email receipts are off because no receipt_email is set and Customers have no email; the Express dashboard would show the musician their payouts but nothing links to it (see finding 15). Tax: 1099 delivery is a Stripe Connect setting for Express accounts (platform enables tax form delivery per year); nothing in code is needed but the launch checklist should list it, and the platform's own revenue reporting (fees, late fees, instant fees) exists only as ledger rows with no export.

Action for launch: set receipt_email (or store the curator's billing email on the Customer) and statement_descriptor_suffix per charge (deposit vs settlement plus a short gig label) so a card statement line is recognizable and disputes drop; add a curator notification on each successful charge with the amount; add a member-readable statement projection or CSV export in SP7/SP8. Owner: SP7 plus launch-checklist (1099 delivery setting).

### 13. [Medium] ux: a fresh card used in Pay now never becomes the default, so the next off-session charge re-declines

Evidence: functions/src/stripeClient.ts:816-835 (setup_future_usage attaches the card but, as the comment says, "does NOT re-point the customer's default"), 791-793 (chargeOffSession always charges the default), functions/src/payments.ts:139-160 (only the save-card flow with a setupIntentId repoints the default), web PayPastDueButton.tsx:130 and mobile PayPastDueButton.tsx:88 (the done copy says nothing about the card on file).

Failure scenario: card A on file dies; the settlement duns to delinquency; the curator pays with card B via Pay now; the next birth deposit or settlement charges card A again and the ladder restarts. The curator is told to "update your payment method" only after another four declines.

Action: after a successful pay-now confirm (the paydue webhook receives the PaymentIntent's payment_method), offer or apply "use this card for future charges"; or at least have PayPastDueButton's done state link to Update card. Owner: SP7.

### 14. [Medium] security: the self-deal hold blocks only the instant rail; standard payout is a two-business-day card-to-cash path with no dispute coverage

Evidence: functions/src/paymentsPayouts.ts:216-223 (hold checked for method === instant only), packages/shared/src/types.ts:466-473 (SELF_DEAL_HOLD_MS rationale: "standard payout only sends once the funds settle"), functions/src/paymentsCore.ts:50-62 (hold stamped on selfDeal forfeits and earnings only).

Why the acceptance looks incomplete: with a manual payout schedule, a standard payout of available funds arrives in one to three business days; card funds become available to a US platform on a two-day schedule, and a transfer with source_transaction becomes available when its charge does. So a self-dealer with a stolen card can accept, wait for T+3, standard-cash-out and have the money in a bank account roughly a week after the gig, while the cardholder has up to 120 days to dispute and finding 2 means nobody reacts when they do. The 3-day instant hold delays the fast rail by three days but does not change the outcome. The 13% of fees paid is the only cost.

Action: apply the hold to both methods for self-deal funds and size it in weeks, not days, or route self-deal settlements through a manual review alert; turn on Radar rules for high-risk cards on the platform account; finding 2's dispute handler is the real backstop. Owner: launch-checklist (Radar) plus SP7 (hold scope), and note this ruling is an owner decision to revisit rather than a bug.

### 15. [Medium] missing-feature: no in-app payout history and no Express dashboard link

Evidence: spec section 6 says payout webhooks "update history"; functions/src/paymentsPayouts.ts:374-393 (payout.paid is a logged no-op by design), web EarningsPanel.tsx:141-179 and mobile EarningsPanel.tsx:142-162 (History lists transfers and forfeits, never payouts), no call to accounts.createLoginLink anywhere in stripeClient.ts.

Failure scenario: a musician cashes out $500 standard on Monday; on Wednesday the bank bounces it; payout.failed (if delivered, see finding 3) writes an admin-only ledger row and a notification. The Earnings page shows the balance back up with no line explaining why, no list of payouts, and no way to reach the Stripe Express dashboard where the failed payout and the bank details live.

Action: an Express dashboard login-link callable (admin-gated like onboarding) and a member-readable payouts projection (write PayoutRequestRecord rows to profiles/{id}/private/payouts/{requestId} instead of the single lastPayout slot, which 5c needs anyway). Owner: SP7 (link), 5c (projection).

### 16. [Medium] spec-drift: the deposit slice is priced from the live DEPOSIT_PERCENT, not the booking's frozen deposit.policy

Evidence: packages/shared/src/validation.ts:374-376 (computeDepositCents uses DEPOSIT_PERCENT), functions/src/paymentsCore.ts:168 (buildPaymentDoc calls it), functions/src/scheduled.ts:488-498 (birth docs are built the same way, months after accept), packages/shared/src/types.ts:547 (DepositState.sliceCents is documented as "the accepted booking's frozen snapshot, never a live constant"), functions/src/bookings.ts:648 (the booking snapshot deposit.policy.percent is written but never read by the money path).

Failure scenario: DEPOSIT_PERCENT changes from 35 to 40. A whole-run booking accepted at 35% births its next occurrence at 40%; its own deposit.policy says 35; the curator's accept-time preview (feePreviews.ts:20-24, also live) said 35. The fee-policy discipline (money.ts:110-128) was applied to every fee but not to the deposit percent.

Action: pass booking.deposit.policy.percent into buildPaymentDoc (and computeDepositCents) and correct the types.ts comment. Owner: SP7 (or bundle into 5c, which will touch buildPaymentDoc).

### 17. [Low] bug: birth-deposit charges have no stale-claim terminator

Evidence: functions/src/paymentsSweep.ts:765-811 (persist depositAttempts, charge on deposit:{attempts}, write held) versus paymentsSettlement.ts:1015-1048 (settlement's chargingSince plus 24h refusal). A retry rung writes nothing before the charge (the counter was persisted at the previous decline).

Failure scenario: the charge succeeds and the held write fails; every hourly run replays the same key inside 24h and completes (fine). If the sweep is down for more than 24h, or crashes at the same point on every run for 24h, the next run re-derives deposit:{attempts} past the window and Stripe treats it as a new charge. Bounded and unlikely, but it is the one re-issue point not covered by the sweep's own rule 2.

Action: stamp deposit.chargingSince before the charge and refuse past IDEMPOTENCY_WINDOW_MS like the settlement path, or document the acceptance next to rule 2. Owner: SP8.

### 18. [Low] ux / copy: em dashes in user-visible payment strings (project rule)

packages/shared/src/messages.ts (client-keyed, rendered verbatim on both platforms): lines 33, 41, 47, 51, 56, 62, 74, 79, 86, 88, 90, 92, 94, 96, 108, 117, 121 (17 strings: CURATOR_DELINQUENT, BOOKING_NOT_CONFIRMABLE, CARD_DECLINED, DEPOSIT_PROCESSING, DEPOSIT_RECONCILING, ACCEPT_ABORTED_REFUNDED, PAYOUT_INSTANT_MIN, PAYOUT_INSTANT_HELD, all six PAY_PAST_DUE_*, trueUpOverCapMessage, TRUE_UP_PAYMENT_STARTED, TRUE_UP_CHARGE_IN_FLIGHT).

functions/src, thrown or notified to users: payments.ts:136, 155, 567, 570, 573, 782; paymentsPayouts.ts:448; paymentsSettlement.ts:329, 414, 864; paymentsSweep.ts:692, 925; bookingLifecycle.ts:34 and 1365 (outside SP5 but on the money path); account.ts:58-76.

Client files have zero (web and mobile payments surfaces are clean). Because clients compare several of these with ===, change the shared constant once and every consumer follows; a colon or a period is the house replacement. Owner: fix-now.

### 19. [Low] test-gap

- The M1 connected-account guard on payment_intent.succeeded (paymentsWebhook.ts:97-101) has no test; account.updated (payments.test.ts:276) and payout.* (paymentsPayouts.test.ts:357) do. Add one that posts a "deposit" purpose intent with account set and asserts the booking stays staged.
- feePreviews.test.ts uses evenly dividing numbers only (deferred item confirmed open); add a fractional composition (say $333.33 base) for depositChargePreviewCents and trueUpDeltaPreviewCents.
- No test for the sync-versus-webhook settlement race (finding 5): FakeStripe can reproduce it by posting the settlement webhook between the claim write and the terminal write.
- FakeStripe does not model the source_transaction cap (finding 1); adding it turns a live-only failure into an emulator failure.
- No test that deleteProfile is refused while money is outstanding (finding 4), because there is no such refusal yet.
- The payments rules test covers the matrix well (payments.rules.test.ts:90-381); no gap found there.

Owner: SP7 alongside the fixes.

### 20. [Low] ux / a11y

- Web SaveCardModal.tsx:74-108 is a Card, not a dialog: no role="dialog", no aria-modal, no focus trap, the title at line 77 is a p not a heading, and Escape does nothing. The PayPastDueButton confirm form (PayPastDueButton.tsx:132-137) has the same shape. Both are inline in the panel, so the fix is either to make them true dialogs or to label them as regions with a heading.
- Web TrueUpForm.tsx:111-115 uses the static id "true-up-extra"; EarningsPanel already uses useId for the same reason (EarningsPanel.tsx:186). Mobile TrueUpForm has a proper accessibilityLabel.
- Web EarningsPanel.tsx:362-368 puts the reason for a disabled Instant button in a title attribute, which most browsers do not show for a disabled control and which keyboard and screen-reader users never reach; mobile renders the hint as visible text (EarningsPanel.tsx:370), which is the better pattern.
- Mobile Callout error boxes (PayPastDueButton.tsx:92, SaveCardSheet.tsx:68, TrueUpForm.tsx:113, EarningsPanel.tsx:372) carry no accessibilityRole="alert" or accessibilityLiveRegion, while every web counterpart has role="alert".
- Mobile sheets: the Android in-app-browser asymmetry (sp5b ruling 4) is handled correctly at EarningsPanel.tsx:239-274 (opened keeps the flag armed, AppState active re-polls). The 3-day and 7-day hold copy: "Your first payout may be held for about 7 days" (web 325, mobile 336) is right; there is no copy anywhere that says self-deal funds are held for three days (PAYOUT_INSTANT_HELD_MESSAGE says "temporarily"), see finding 21.
- Loading / empty / error states exist on every surface (skeletons on web, Text muted on mobile, retry links on both). Keyless mode is consistent (stripeLoader.ts:9-10, stripe.ts:13-14, _layout.tsx:26-37) and no secret key appears in either app.

Owner: SP7.

### 21. [Low] ux: instantHoldUntil is not in StripeStatusResult

Evidence: packages/shared/src/paymentDisplay.ts:94-102, functions/src/payments.ts:293-300 (the status omits the hold), web EarningsPanel.tsx:362-368 and mobile EarningsPanel.tsx:198-203 (Instant is enabled during a hold; the press fails with PAYOUT_INSTANT_HELD_MESSAGE after the round trip). Add instantHoldUntil to the result and disable Instant with a dated hint. Owner: SP7.

### 22. [Low] deferred items confirmed still open

getStripeStatus TTL cache (M7): not built; every Earnings load costs two Stripe reads (accounts.retrieve plus balance.retrieve) and mobile re-polls on every foreground while onboarding is armed. revokeAdmin / checkRevoked (L9): no such symbol exists in functions/src or packages/shared. See table B4. Owner: SP8.

### 23. [Low] accepted hazard worth restating for 5c: the single-slot payout memo

Evidence: functions/src/paymentsPayouts.ts:225-239, packages/shared/src/types.ts:676-679. A retry of an OLDER requestId (a mobile request that was queued offline and replayed after a newer payout overwrote lastPayout) is protected only by the balance check; if new earnings landed in between, it pays a second time. Accepted at v1 because retries happen within seconds; 5c multiplies payouts per request and should move to a per-requestId record (see finding 15). Owner: 5c.

### 24. [Low] docs: sp5-rulings and README describe FakeStripe as covering "every saga"; two live-only Stripe behaviors are unmodeled

The source_transaction cap (finding 1) and the Connect endpoint split (finding 3) are both invisible in the emulator. Add both to the "things the emulator cannot prove" list next to the debitConnectedAccount and instant-fee re-checks. Owner: fix-now (docs).

---

## B. Status tables

### B1. Check 1: secrets declarations

Every exported handler that can reach getStripe() declares secrets: [stripeSecretKey]; the webhook also declares stripeWebhookSecret. The tripwire test (functions/test/stripeSecrets.test.ts:35-54, 107-115) pins the set exactly. No callable reaches getStripe() without the declaration.

| Handler | File:line | Reaches getStripe() via | Declares stripeSecretKey |
|---|---|---|---|
| acceptBooking | bookings.ts:1169 | chargeOffSession, refund | yes |
| createSetupIntent | payments.ts:84 | createCustomer, createSetupIntent | yes |
| refreshPaymentMethod | payments.ts:122 | getSetupIntentPaymentMethod, setDefaultPaymentMethod | yes |
| createOnboardingLink | payments.ts:182 | createExpressAccount, createOnboardingLink | yes |
| getStripeStatus | payments.ts:281 | getAccountState, getBalances | yes |
| payPastDue | payments.ts:907 | createOnSessionIntent | yes |
| requestPayout | paymentsPayouts.ts:177 | getBalances, createPayout, debitConnectedAccount | yes |
| cancelBooking | bookingLifecycle.ts:457 | resolveDepositPending | yes |
| cancelOccurrence | bookingLifecycle.ts:491 | resolveDepositPending | yes |
| reportNoShow | bookingLifecycle.ts:660 | resolveDepositPending, clawbackSettledOccurrence | yes |
| pauseSeries, endSeries | gigSeries.ts:321, 407 | executeCancellation, resolveDepositPending | yes |
| stripeWebhook | paymentsWebhook.ts:170 | constructWebhookEvent plus every finalizer | yes, plus stripeWebhookSecret |
| paymentsSweep | paymentsSweep.ts:1632 | steps 1, 2, 3, 5, 6, 7 plus SP6 steps | yes |
| createTicketOrder, finalizeTicketOrder, refundTicket | ticketing.ts:59, 187, 682 | SP6 | yes |
| cancelEvent | events.ts:495 | SP6 | yes |

Handlers verified NOT to reach Stripe and correctly undeclared: confirmOccurrenceActuals (payments.ts:527, transaction write only), releaseStuckSaga (payments.ts:391, Firestore only), removeReliabilityMark (bookingLifecycle.ts:1049, reopenSettlementForRestore is Firestore only), cancelGig / takedownGig (gigs.ts:346, 408, unwind only), reviewProfile (review.ts:22, unwind only), deleteProfile (profiles.ts:229, no Stripe at all, which is finding 4), dailySweep (scheduled.ts:965, buildPaymentDoc only), offerGig, deleteAccount.

Gap: with finding 3, the webhook will need a second secret declared; extend the tripwire when it lands.

### B2. Check 4: sweep query index coverage

| Query | Where | Needs | In firestore.indexes.json |
|---|---|---|---|
| bookings: depositChargePending == true, orderBy documentId | paymentsSweep.ts:525-526 | single-field only | n/a (auto) |
| payments cg: deposit.status == X, orderBy occurrenceStartsAt | 556-557 | (deposit.status, occurrenceStartsAt) CG | yes, 132-136 |
| payments cg: deposit.status == unpaid, occurrenceStartsAt > now | 876-879 | same | yes |
| payments cg: settlement.status == not_due, occurrenceStartsAt <= now | 997-1000 | (settlement.status, occurrenceStartsAt) CG | yes, 137-141 |
| payments cg: settlement.status == pending, settleAfter <= now | 1032-1035 | (settlement.status, settlement.settleAfter) CG | yes, 142-146 |
| payments cg: settlement.status == past_due, nextRetryAt <= now | 1032-1035 | (settlement.status, settlement.nextRetryAt) CG | yes, 147-151 |
| bookings: status == expired, resolvedAt >= X, orderBy resolvedAt | 1169-1172 | (status, resolvedAt) | yes, 127-131 |
| payments cg: curatorProfileId ==, settlement.status == | paymentsCore.ts:716-719 | (curatorProfileId, settlement.status) CG | yes, 152-156 |
| payments cg: curatorProfileId ==, deposit.status ==, depositAttempts >= | 723-727 | (curatorProfileId, deposit.status, deposit.depositAttempts) CG | yes, 157-162 |
| client bookings: curatorProfileId ==, paymentSummary.state == (no orderBy) | delinquentBookings.ts:15-16 | equality-only, index merge | n/a |
| client bookings: musicianProfileId ==, orderBy updatedAt desc | EarningsPanel usePaymentRows | (musicianProfileId, updatedAt DESC) | yes, 117-121 |

All seven SP5 composites the checklist names are present; nothing missing. Pagination: every unbounded sweep query goes through paginate with PAGE_SIZE 200 and each per-doc body does a fresh read before acting (paymentsSweep.ts:313, 704, 1223). Escalation coverage is in finding 6.

### B3. Check 5: docs versus code drift

| Claim | Where | Code | Verdict |
|---|---|---|---|
| Any member can trigger payouts | README 343-344, 702-707 | requireProfileAdmin at paymentsPayouts.ts:199, payments.ts:192 | README wrong; rulings ruling 7 right |
| Unset webhook secret: verification against empty string, deliveries rejected | README 408 | fail-closed 500 (stripeClient.ts:913-916, paymentsWebhook.ts:187-191) | README stale (pre-H3) |
| Instant cash-out "4%, min $1" | README 306, 342 | also $10 minimum payout (types.ts:458) | README incomplete |
| Retry ladder +1d, +2d, +2d | README 333 | matches types.ts:474-475 | ok; spec section 4 says +1d/+3d/+5d (cumulative form) |
| Client wrapper paymentsStripe.ts | spec section 7 | stripeClient.ts | cosmetic |
| stripeEvents shape includes bookingId/gigId | spec section 2 | receivedAt/processed/failedAt/attempts/expireAt | cosmetic |
| DepositState.sliceCents is the frozen policy percent | types.ts:547 | live DEPOSIT_PERCENT (validation.ts:374) | comment wrong, finding 16 |
| cancelIntent is a future surface | paymentsSettlement.ts:977-982, paymentsCore.ts:409-412 | exists since SP6 | comments stale, finding 7 |
| Subscribe one endpoint to platform and connected-account events | README 659-663, sp5-rulings checklist item 1 | one secret in code | both docs and code incomplete, finding 3 |
| Emulator suite exercises "every saga" | README 448-457, sp5-rulings | source_transaction cap and endpoint split unmodeled | finding 24 |
| Webhook handles payout events to "update history" | spec section 6 | payout.paid no-op, no payout history surface | finding 15 |
| API version pin 2025-08-27.basil | stripeClient.ts:666 | stripe 18.5.0 LatestApiVersion is 2025-08-27.basil | consistent |

### B4. Check 6: deferred items status

| Item | Source | Status in code | Evidence |
|---|---|---|---|
| getStripeStatus TTL cache (M7) | sp5-rulings | not built | payments.ts:246-268 calls Stripe on every call |
| revokeAdmin / checkRevoked (L9) | sp5-rulings | not built | no symbol in functions/src or shared |
| TrueUpForm accepts "3.5" by rounding | sp5b | still present on both | web TrueUpForm.tsx:61 Math.round; mobile TrueUpForm.tsx:50 Math.round |
| runSheet "Canceled" literal | sp5b | unchanged, SDK still 0.64.0 | stripe.ts:73; apps/mobile/package.json pins 0.64.0 |
| feePreviews fractional test | sp5b | not added | packages/shared/test/feePreviews.test.ts uses 100_000 / 25_000 / 10_000 only |
| Mobile grace flash warning port | sp5b | not ported | startsSoonFlash exists only in apps/web/src/bookings/BookingThread.tsx:404, 633-640; no mobile counterpart |
| "Opening Stripe..." polish | sp5b | unchanged | mobile EarningsPanel.tsx:330 |
| resumeSeries tripwire | sp3 via sp5 | still open (not re-verified here) | n/a |
| Sweep step-6 getAll batching, BookingInbox pagination | sp4 via sp5 | not re-verified here | n/a |

### B5. Checks 2 and 3 in brief (verified correct unless listed above)

Money invariants: no client-supplied amount reaches Stripe (requestPayout's amountCents is checked against the live Stripe balance and never priced from; true-up extras are bounded integers). Integer cents and the rounding law hold in money.ts with overflow guards at 2^45 (assertCents, requestPayout MAX_CENTS). Fee snapshots hold for every fee (currentFeePolicy at accept, resolveFeePolicy at settlement, birth docs use booking.feePolicy) but not for the deposit percent (finding 16). T+3 is measured from gig end (settleAfter = gigEnd + SETTLEMENT_DELAY_MS). Dunning is days 1, 3, 5 then delinquency with the late fee computed once on due + fee share and split floor 7/10 to the musician. Forfeits move 100% of the slice and keep the fee share. Every refund path includes the fee share (deposit refund, accept abort, clawback with late fee). Self-deal hold is stamped on both transfer sites (see finding 14 on its reach). Instant minimum $10 and fee-swallows-amount guard are enforced server-side and mirrored client-side. Idempotency keys are attempt-scoped everywhere a decline can be cached (accept, birth, settle, earn, paydue, paydue_deposit); the single-use keys (refund, forfeit, settle-down, clawback*) are guarded by the 24h stale checks in sweep steps 1 and 2 and by the once-per-booking no-show mark guard. No Stripe call runs inside a Firestore transaction (verified in every module; claimStripeId creates then claims).

Webhook: signature verified, fail-closed on an empty secret, claim machine with failedAt immediate re-claim and STALE_CLAIM_MS re-claim, hasOwnProperty dispatch, doc-id validation on event.id, connected-account guard on payment_intent.succeeded, account pinning on account.updated and payout.*. Handled types: payment_intent.succeeded (purposes deposit, settlement, paydue, paydue_deposit, tickets), payment_intent.payment_failed (no-op), account.updated, payout.paid, payout.failed, transfer.reversed. Unhandled but material: charge.dispute.* (finding 2), charge.refunded and payment_intent.canceled (finding 8), account.application.deauthorized (Express accounts cannot deauthorize; low), capability.updated (covered by account.updated), transfer.failed does not exist as a Stripe event (transfers fail synchronously, which is why finding 1 surfaces as a throw). A platform-level payout.failed (the platform's own bank payout) is recorded with profileId null (paymentsPayouts.ts:436-443), which is correct.

---

## C. What SP7, SP8 and 5c must know from this area

For SP7 (fan discovery) and any sub-project that ships before live mode:
1. Do not deploy live on the current transfer sourcing (finding 1) or a single webhook secret (finding 3); both are invisible to the emulator suite. The README's manual smoke walkthrough step 6 and step 5 are where they show.
2. There is no dispute path. Any new money surface (ticket sales already went live in SP6 on the same rails) inherits finding 2: a chargeback on a ticket order is equally silent.
3. deleteProfile (and reviewProfile's reject-from-approved) is not money-aware (finding 4). Discovery features that surface profiles must not assume a profile's Stripe identity outlives the profile.
4. The webhook claim machine is exactly-once per event id, but handlers must be idempotent against arriving BEFORE the synchronous path finishes (finding 5). Any new purpose registered in paymentIntentSucceededHandlers must handle "the callable that minted this intent is still running".
5. Every user-facing string clients branch on lives in packages/shared/src/messages.ts and is compared with ===; change it there once (finding 18 lists the em-dash ones).
6. Client rule: the earnings page is per-booking reads (rules forbid a member collectionGroup on payments, payments.rules.test.ts:144); a discovery surface must never try a cross-booking payments query as a member.
7. getStripeStatus costs two Stripe reads per call (finding 22); do not put it on a hot path.

For SP8 (search) and general hygiene: findings 6 (persist the sweep report, escalate the six console-only paths), 17 (deposit stale-claim terminator), 22 (TTL cache), and the test gaps in 19. The sweep runs all eleven steps sequentially inside one 540s invocation; SP8 should not add work to it without measuring.

For 5c (band payout splits), constraints this design imposes:
1. Identity is one connected account per profile: StripeProfileDoc.accountId is a single string (types.ts:695), claimStripeId keeps the first id forever (payments.ts:64-77), and the webhook pinning helpers (eventAccountMatchesProfile, account.updated) map one account to one profile. Splits need a per-member account map (profiles/{id}/private/payoutMembers/{uid} with its own accountId, flags, hold and memo) and an account-to-(profile, member) lookup for the payout webhooks.
2. Connect cannot transfer between two connected accounts. A split must be executed by the platform at transfer time (N transfers from the platform balance per settlement, each with its own attempt-scoped key such as {bookingId}:{gigId}:earn:{attempts}:{memberUid}) or by account-debiting the profile account and re-transferring (the legacy charges.create({source}) path the README already flags as unverified). Splitting at settlement time is the cleaner design and it interacts with finding 1: N source_transaction transfers must sum to no more than the source charge, so the fix chosen for finding 1 decides 5c's transfer sourcing.
3. Split specification must be a snapshot on the booking at accept, exactly like feePolicy (money.ts:110-128), or a member added mid-run changes who gets paid for dates already accepted. Rounding: shares floor per member, remainder to one designated member (not the platform), and the sum must equal computeEarningsCents to the cent (extend the reconstitution invariant tests in money.test.ts:37, 59).
4. Ledger shape: LedgerEntry has profileId only (types.ts:886-896); add memberUid (nullable) and key split rows off each transfer id. recomputePaymentSummary.transferredCents sums transfer.amountCents (paymentsCore.ts:332); TransferState is a single {id, amountCents} and must become a list or a parent-plus-children shape.
5. Payout authority: requestPayout and createOnboardingLink are profile-admin only (finding 9); a member's own connected account onboarding is a member action on their own account, so 5c needs a third permission tier (member-onboards-self, admin-configures-split) and both clients need the member role they do not currently carry.
6. The lastPayout memo is a single slot (finding 23); N payouts per request need per-requestId records, which also gives finding 15 its payout history.
7. Self-deal hold (instantHoldUntil) and delinquency are profile-scoped flags on private/stripe; with per-member accounts the hold must follow the money to each member account.
8. Clawback (clawbackSettledOccurrence) reverses one transfer id; with N transfers it must reverse N, each on its own key, and the clawback_failed alert must report per-leg status per member.
9. payout.failed pins on the profile's cached accountId (paymentsPayouts.ts:369-372); with member accounts it must pin on the member's.
10. Rules: private/stripe is readable by every member (firestore.rules:100-105); per-member payout docs should be readable by that member and admins only.

The marker for all of this is the FUTURE (sub-5c) comment at functions/src/paymentsPayouts.ts:198.

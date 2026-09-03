# GateKeep Sub-project 10: Hardening (design)

Status: approved in brainstorm on 2026-09-02. This document is the binding authority for
sub-project 10; the implementation plan argues from it. It contains no em dashes, and neither
may anything built from it (code, comments, copy, docs, commit messages).

Source of every item: the whole-project audit of 2026-09-01
(`docs/superpowers/audit-2026-09-01.md` and the detail reports under `docs/superpowers/audit/`
and `anti-slop/audit-001-2026-09-01.md`). Finding references below use the audit's short form:
`sp5 #1` is finding 1 of the SP5 report, `rules F3` is finding F3 of the rules report,
`cross #4` is finding 4 of the cross-cutting report, `design #1` is the antislop report.

Binding context: `DESIGN.md` and the antislop skills for any client change, `sp5-rulings.md`
for money, `sp6-rulings.md` for events and tickets, `sp4-rulings.md` for bookings. Sub-project 7
(fan discovery, spec `2026-09-02-fan-discovery-design.md`) is being built concurrently; this
sub-project merges first and SP7 rebases onto it.

## 1. Goal

Close the money, lifecycle, and copy defects the audit found before any live traffic, on a base
SP7 can rebase onto cheaply. Two branches: a same-day mechanical sweep (A) and the hardening
proper (B). Nothing here adds a fan-facing feature; everything here makes the existing ones safe
to launch.

## 2. Owner decisions (from the brainstorm)

1. **Scope tier**: the audit's 19 blockers plus its fix-now batch (section 3.6 of the audit).
   Accessibility and state-coverage work (error callbacks, tap targets, labels, forms) is out and
   becomes a follow-on if wanted.
2. **Ordering**: hardening first, SP7 rebases. SP7 has a spec and no code, so the rebase is
   free. Branch B never rewrites the functions SP7 hooks into (`publishEvent`, `updateEvent`,
   `setEventTiers`, `reviewTrack`); it adds callables and cascade calls beside them.
3. **Unpublish policy**: rejecting an approved curator cancels and refunds every future
   published event automatically, full refund including the fan-paid fee, holders notified.
4. **Dispute policy**: record, alert, and gate on open; on a lost dispute reverse the matching
   transfer; on a won dispute clear the gate. Evidence submission stays manual in Stripe.
5. **Deletion policy**: `deleteAccount` and `deleteProfile` refuse with a named blocker while
   tickets, transfers, orders, balances, debts, or unsettled events are outstanding. Nothing
   is unwound automatically by deletion.
6. **Em dashes**: one mechanical sweep of the whole repo, enforced afterwards by CI.
7. **Name**: sub-project 10, "Hardening". Branches `worktree-sp10-sweep` (A) and
   `worktree-sp10-hardening` (B). Rulings doc `docs/superpowers/sp10-rulings.md`.

## 3. Branch A: the sweep (merges the same day it opens)

Behavior-free by construction; the gate is "every count identical".

1. **Em-dash sweep.** A throwaway script (not committed) rewrites every U+2014 in the repo
   outside `node_modules`, `dist`, `.next`, `.expo`, lockfiles, and `.claude/`, choosing the
   replacement by context: a colon when the dash introduces a clause that explains the one
   before it, a comma mid-sentence, a period between two complete sentences, parentheses where
   the dashes bracket an aside. The script prints every replacement with file and line for
   review before writing. Test assertions that compare shipped strings (about 30 in
   `functions/test` and `packages/shared/test`) and the README quotes of those strings are
   updated to match. `apps/web/AGENTS.md` is Next-generated and gets gitignored instead of
   edited. The census after the sweep is zero across `apps/**`, `functions/**`,
   `packages/**`, `tests-rules/**`, `scripts/**`, `docs/**`, `README.md`, `DESIGN.md`,
   `HANDOFF.md`, and every rules file. The one carve-out is DESIGN.md's own statement of the
   rule, which names the character by its Unicode name instead of printing it.
2. **Node 22.** `functions/package.json` `engines.node` to `22`, `firebase.json` runtime to
   `nodejs22`, an `.nvmrc` with `22` at the repo root, root `engines.node` to `>=22`. The
   emulator suite is run once under Node 22 locally (nvm or a portable install) before merge so
   the runtime the tests prove is the runtime that deploys. `firebase-admin` stays at 12 (a 13
   bump is a separate change).
3. **Index overrides.** In `firestore.indexes.json` the `tickets`/`orderId` and
   `members`/`uid` field overrides gain `{ queryScope: COLLECTION, order: ASCENDING }` and the
   `DESCENDING` twin, matching the `tracks`/`status` shape, so collection-scoped equality
   queries on those fields keep their single-field index. The unused
   `gigs (bookedMusicianProfileId, startsAt)` composite is deleted.
4. **`.gitignore`.** Adds `.claude/settings.local.json`, `.claude/worktrees/`, and
   `apps/web/AGENTS.md`.
5. **CI.** `.github/workflows/ci.yml` on every push and pull request: checkout, pnpm via
   corepack, Node 22, Temurin 21, `pnpm install`, `next typegen`, then `pnpm typecheck`,
   `pnpm --filter @gatekeep/shared test`, `pnpm emu:rules`, `pnpm emu:test` (with
   `FUNCTIONS_DISCOVERY_TIMEOUT=60`), web lint and build, mobile lint, and a final step that
   fails when `git grep -I` finds U+2014 in the paths listed in item 1. A `dependabot.yml`
   covers the root, `functions`, `apps/web`, and `apps/mobile` with weekly npm updates.
6. **Gate**: typecheck 5/5, shared 158, `emu:test` 704, `emu:rules` 103, lints 0 errors, web
   build. Counts must be identical to main.

## 4. Branch B: money correctness (`functions/src`, FakeStripe models each live rule)

1. **Transfer sourcing (sp5 #1).** In `finalizeSettlementSuccess` the transfer is sourced from
   a charge only when `math.earnings <= sourceChargeAmountCents`. The settlement charge amount
   is `math.chargeTotal`; the deposit charge amount is `deposit.chargeAmountCents`, a new field
   written wherever a deposit charge is recorded (accept saga, birth deposits, pay-past-due
   deposit). Legacy docs without it fall back to the unsourced transfer. An unsourced transfer
   records `sourced: false` in its ledger row. The forfeit transfer (`resolveDepositPending`)
   is always within the deposit charge and stays sourced. `FakeStripe.transferToAccount`
   refuses a sourced transfer whose amount, plus every earlier sourced transfer against the
   same charge, exceeds the charge amount, throwing the same error shape a live
   `balance_insufficient` failure produces. Tests: the standard $1,000 settlement is not
   sourced and pays $980; a forfeit and a zero-charge settlement are sourced; two transfers
   against one charge are refused past its total.
2. **Two webhook secrets (sp5 #3).** New `STRIPE_CONNECT_WEBHOOK_SECRET` via `defineSecret`,
   declared on `stripeWebhook`, added to `stripeSecrets.test.ts`. `constructWebhookEvent`
   verifies against the platform secret, then the Connect secret. The secret that verified is
   returned with the event; an event verified by the platform secret that carries `account`
   is refused (the existing M1 guard), and an event verified by the Connect secret without
   `account` is refused. Either secret missing outside the emulator is a 500 (fail-closed,
   unchanged). README go-live lists two endpoints, "Your account" and "Connected accounts",
   with the six event types split between them per Stripe's Connect webhook scopes.
3. **Disputes (sp5 #2).** Handlers in `paymentsWebhook.ts` for `charge.dispute.created`,
   `charge.dispute.closed`, and `charge.refunded`, each resolving the charge to its
   PaymentIntent and then to a payment doc (`metadata.purpose` deposit, settlement, paydue,
   paydue_deposit) or a ticket order (`purpose` tickets):
   - `created`: ledger `dispute_opened:{disputeId}` (kind `dispute_opened`, amount, fee,
     reason); `recordAdminAlert` kind `dispute_opened`; for a curator charge, the existing
     idempotent `declareCuratorDelinquent` plus a `notifyProfileMembers` "A payment was
     disputed"; for a ticket order, `disputeId` and `disputeStatus: "open"` stamped on the
     order. `DisputeRecord` (`disputes/{disputeId}`, admin-read) holds the resolution state so
     `closed` can find what `created` decided.
   - `closed`, status `lost`: ledger `dispute_lost:{disputeId}`; reverse the earnings transfer
     (settlement) or forfeit transfer (deposit) via `reverseTransfer`, idempotency key
     `dispute_reverse:{disputeId}`; for a ticket order, a partial reversal of the event's
     `ticket_settlement` transfer for that order's face value when the event has settled, or a
     reduction of the pending settlement basis (`refundedFaceCents`) when it has not; alert
     kind `dispute_reversal_failed` when the reversal throws or no transfer exists.
   - `closed`, status `won`: ledger `dispute_won:{disputeId}`; `clearDelinquencyIfSettled`.
   - `charge.refunded` whose refund id is unknown to the ledger (a dashboard refund): ledger
     `external_refund:{refundId}` and alert `external_refund` when the payment doc or order
     still reads paid.
   - `AdminAlerts` in `/admin` renders the three new kinds (display only, no action).
4. **Settlement webhook race (sp5 #5).** In `settlementIntentSucceeded`, when
   `settlement.intentId` is null and `settlement.chargingSince` is younger than 15 minutes,
   throw so the claim machine stamps `failedAt` and Stripe redelivers; the replay lands on a
   paid doc and is the existing no-op. The deposit purpose handler logs the equivalent
   "sync path owns this intent" case at info. Test posts the settlement webhook between the
   claim write and the terminal write and asserts no `settlement_raced` alert.
5. **Captured order reconciliation (sp6 #5).** The order-expiry step's deferred branch calls
   `completeOrderTx` when `retrieveIntentStatus` returns `succeeded`; a pending order whose
   intent is neither `canceled` nor `succeeded` and is older than two hours raises alert kind
   `ticket_order_stuck`. Test: expire an order whose fake intent succeeded and assert the
   ticket is minted and the buyer notified.
6. **Ticket settlement wedge (sp6 #14).** `settleOneEvent` stamps `settlementClaimedAt`
   before the transfer (24h stale window, same idiom as `chargingSince`) and
   `settlementStartedAt` only after the transfer succeeds. `cancelEventCore` refuses on
   `settlementStartedAt` as today and on a fresh `settlementClaimedAt`; a stale claim is
   re-claimable. A thrown transfer therefore retries hourly and keeps cancel possible. The
   platform-float decision stays on the launch checklist.

## 5. Branch B: lifecycle

1. **Events follow the profile (sp1 #1, sp3 #1, cross #1).** `reviewProfile`
   reject-from-approved (and therefore the admin Unpublish path) gains an events step after
   the series step: every event of the profile with `status == "published"` and a future
   `startsAt` runs `cancelEventCore` then `refundOrdersForCancelledEvent` with the reason
   "The organizer's account is no longer active", holders receive the existing cancellation
   notification, and `draft` events flip to `cancelled`. Completed and already cancelled
   events are untouched. Each event is its own try/catch; a failure writes
   `eventCascadeRetries/{eventId}` (server-only, mirrors `curatorAccessRetries`) and a new
   daily-sweep step 9 drains it. `createTicketOrder` and `settleOneEvent` also require the
   curator profile to be `approved` (one `get`, cached per invocation), which closes the ISR
   window and any path the cascade misses. The public events read rule is unchanged.
2. **Admin `takedownEvent({ eventId, reason })`.** `requireAdmin`; cancels and refunds one
   event regardless of curator status via the same two helpers; writes an audit entry
   (`event_taken_down`) and notifies the curator profile. Admin UI: an "Events" block in the
   Takedowns panel with lookup by event id or curator handle, read-only counts (tiers, paid
   orders, valid tickets, refunded), and a Cancel-and-refund control using `ReasonCard`.
3. **Deletion refusals (sp1 #2, #10; sp5 #4; cross #2, #23).** `deleteProfile` adds a money
   gate before the status gate, evaluated in this order and each with its own message
   constant in `packages/shared/src/messages.ts`: `DELETE_PROFILE_BALANCE_MESSAGE` (Stripe
   balance non-zero, read live), `DELETE_PROFILE_DELINQUENT_MESSAGE`,
   `DELETE_PROFILE_PAYMENTS_MESSAGE` (any `payments` doc naming the profile on either side
   with `deposit.status` in `held`, `refund_pending`, `forfeit_pending`, or `unpaid` with
   attempts, or `settlement.status` in `pending`, `past_due`), `DELETE_PROFILE_EVENTS_MESSAGE`
   (any event `published`, or with a paid order and no `settlementStartedAt`). The musician
   side of the payments query needs a new collection-group composite
   `payments (musicianProfileId, settlement.status)`. The allowed path writes the Stripe
   customer and account ids into the audit entry before `recursiveDelete`. `deleteAccount`
   refuses with `DELETE_ACCOUNT_TICKETS_MESSAGE` (a `valid` or `checked_in` ticket to an event
   whose `endsAt` is in the future), `DELETE_ACCOUNT_TRANSFERS_MESSAGE` (an `offered` transfer
   on either side), or `DELETE_ACCOUNT_ORDERS_MESSAGE` (a `pending` order), and on success
   writes an `account_deleted` audit entry. Both clients render the refusal inline (web
   `dashboard/page.tsx` delete card, mobile `AccountScreen`) instead of a bare alert.
4. **Auth `onDelete` (cross #3).** `cascadeDeleteUser(uid)` is extracted from `deleteAccount`
   (memberships, curatorAccess and its recompute, the `users/{uid}` tree, pending invites
   naming the uid revoked, offered transfers naming the uid voided with inventory untouched)
   and called by the callable and by a new `onUserDeleted` v1 auth trigger, which logs the
   sole-admin case instead of refusing.
5. **Push tokens (sp1 #6, rules F3, cross #10).** Rule split: `allow create, update` with the
   token-id regex bounded to 200 characters, `keys().hasOnly(['createdAt'])`, and
   `createdAt is int`; `allow delete: if isOwner(uid)`. Mobile deletes
   `users/{uid}/pushTokens/{token}` before `signOut`. `notifyUser` orders the token query by
   `createdAt` descending and deletes any token Expo's response marks `DeviceNotRegistered`.
   Rules tests: owner delete allowed, stranger delete denied, over-long id denied, non-int
   `createdAt` denied. `notifications.read` gains `is bool`; `users.displayName` update
   requires the key present with size 1 to 80.
6. **Small lifecycle leftovers.** `deleteProfile` batch-revokes `pending` invites for the
   profile; `submitProfileForReview` gains `requireVerifiedEmail` and `isValidDocId`; the
   draft cap check moves inside the create transaction; the resubmit cooldown reads and writes
   `users/{uid}.lastProfileRejectedAt` (server-only field) so delete-and-recreate cannot
   bypass it; `inviteMember` trims and lowercases the email and refuses a duplicate pending
   invite or an existing member with the uniform response; `invites` gains an admin read
   disjunct.

## 6. Branch B: product fix-nows

1. **Geocoder (sp3 #2, #3).** `getGeocoder` throws `failed-precondition` outside the emulator
   when `GEOCODER_PROVIDER` is not `google`, and logs the active provider at module load.
   `parseGoogleResponse` returns null for a city-less result (callers already handle null);
   `GoogleGeocoder.geocode` uses a 10 second `AbortSignal.timeout`. Tests for all three.
2. **Find musicians (sp4 #1, #20).** Both `MusicianBrowse` grids read
   `booking.preferences?.availabilityPattern` and `booking.rates ?? nullRates`;
   `recomputeReliability` seeds `{ rates: nulls, preferences: null }` when creating the
   projection; `rebuildBookingProjections` merge-sets and preserves `reliability` instead of
   deleting the doc. Functions test: complete a booking for a musician with no booking info
   and assert the projection shape.
3. **Booking visibility toggle (sp2 #2).** Both portfolio editors add four controls to the
   booking form: each rate structure "Visible to curators" or "Private", preferences "Public"
   or "Curators only", saved through the existing `visibility` field of `updateBookingInfo`.
   The "SP4 Task 1 stopgap" comments and `DEFAULT_BOOKING_VISIBILITY` hardcoding are removed.
4. **Verification email (sp1 #5, #20).** A shared `VerifyEmailBanner` on both clients, shown
   whenever `user.emailVerified` is false: Resend (60 second client cooldown) and "I've
   verified" (`reload()` then `getIdToken(true)`). The callable wrappers on both clients
   retry once after a forced token refresh when a `failed-precondition` message equals
   `EMAIL_NOT_VERIFIED_MESSAGE` (new shared constant used by `requireVerifiedEmail`). Admin
   gate and dashboard use `getIdTokenResult(true)`.
5. **Poster path (sp6 #16, inheritance L18).** `processPhoto` for kind `poster` writes
   `posterUploads/{uid}/{nonce}` with `{ path, createdAt }` (rules: owner read, no client
   write; the existing abandoned-upload reaper, dailySweep step 3, also deletes these docs
   once older than 24h). `EventEditor` (web) and the mobile
   event management screen add a poster picker that uploads to staging with the poster kind,
   watches the doc, then saves `posterPath` through `updateEvent`. Event pages on both
   platforms render it and `/e/[eventId]` uses it as the OG image. Public poster URLs are
   built from the path (no `getDownloadURL`), the pattern SP7 adopts for its cards.
6. **Ticket notification links (sp6 #10, sp4 #5, inheritance L15, L16).** A shared
   `notificationHref(kind, refId)` in `packages/shared` consumed by both inbox renderers:
   `booking` as today, `ticket` to `/tickets` (web) and `/(fan)/tickets` (mobile). Mobile
   `TicketDetail` gains an "Event details" link to `/event/[eventId]`. `notifyUser` adds
   `data: { kind, refId }` to the Expo message; `app/_layout.tsx` adds
   `setNotificationHandler` (show alerts in the foreground), an Android channel, a response
   listener plus the cold-start `getLastNotificationResponseAsync` read, routing through the
   same href map. SP7 extends the map with its kinds.
7. **Door and reminder (sp6 #3, #4, #12).** `ScannerScreen` branches on `FunctionsError.code`:
   `failed-precondition`, `not-found`, and `permission-denied` are ticket verdicts; every
   other error (and a non-`FunctionsError`) renders a neutral "Couldn't reach GateKeep. Try
   again." panel that stays until tapped and re-arms the scan lock. Success auto-clears after
   1.5 s; duplicate and invalid stay until tapped. The event reminder formats with
   `Intl.DateTimeFormat` in `LAUNCH_TIMEZONE` and titles "Tonight" or "Tomorrow" from the
   launch-zone calendar day; a test pins the rendered body. New `undoCheckIn({ eventId,
   ticketId })` (curator member, `checked_in` to `valid`, clears `checkedInAt` on both docs)
   with an Undo control on the attendee list; `checkInTicket` refuses more than 12 hours before
   `startsAt` with `CHECK_IN_TOO_EARLY_MESSAGE`.
8. **Order holds and checkout (sp6 #2, #7, #15, inheritance L23, L24).**
   `cancelTicketOrder({ orderId })` for the buyer: pending orders only, cancels the intent
   when one exists, releases inventory and the buyer-cap count through the existing release
   transaction, status `cancelled`. Web Cancel and the mobile sheet's cancelled outcome call
   it. A new `ticketOrderExpiry` scheduler (`every 5 minutes`, `retryCount: 3`) runs the
   expiry step alone; the hourly sweep keeps it as backstop. Checkout on both platforms shows
   "All sales are final unless the event is cancelled or the organizer refunds you. Service
   fee included in the total." above Pay, and ticket PaymentIntents carry `receipt_email` (the
   buyer's verified email) so Stripe emails a receipt in live mode. `createEvent` refuses a
   second promotion of the same `gigId` with `GIG_ALREADY_PROMOTED_MESSAGE`. A per-uid cap of
   three concurrent pending orders across events (`PENDING_ORDERS_CAP_MESSAGE`).
9. **Booking clarity (sp4 #2, #3, #4, #6, #7, #8, #14, #16, #23, #24).** The materializer
   and `createGig` stamp `fillMode` on occurrence docs (`whole_run`, `per_occurrence`, or
   null); browse cards and gig detail on both platforms show "Books as a run" from that field;
   both threads show a run notice with the count of currently open occurrences (public query
   on `gigs (seriesId, status)`) above the respond block for both sides, and the deposit
   honesty line gains a run variant. Inbox rows and thread headers render the other party's
   name with a link (`/@handle` web, `/artist/[handle]` mobile) and, curator side, the
   reliability line; the curator's gig page shows the booked act and links to the booking.
   The whole-run accept preview queries the open dates and renders "N dates, $X due now". A
   date reopened by `cancelOccurrence` on a booked run creates a single-occurrence booking
   (`seriesId: null`) when applied to. `applyToGig`, `offerGig`, and both browse queries
   require `startsAt > now`. Counter is disabled at the 50-entry cap with a visible reason.
   Curators are notified when their own offer expires. Both mobile grace warnings (accept
   flash and `CancelDialog` in-grace notice) are ported. Sweep step 6 skips a booking with
   `depositChargePending`.
10. **Series (sp3 #5, #10, #11).** Daily-sweep step 1 flips a series whose `endDate` has
    passed to `ended` in the same batch as its watermark; `updateSeries` propagation skips
    `taken_down` and `cancelled` occurrences; the end date is inclusive of that calendar day
    (both forms submit end-of-day in `LAUNCH_TIMEZONE`, the materializer comment is corrected,
    a test pins an occurrence landing on the end date); series summaries on both platforms
    append "(UTC)" to the recurrence time.
11. **Config and ops (cross #7, #17, #27, sp2 #9).** Web and mobile Firebase config read
    `NEXT_PUBLIC_FIREBASE_*` and `EXPO_PUBLIC_FIREBASE_*` (apiKey, authDomain, projectId,
    storageBucket, messagingSenderId, appId) with the current dev values as defaults;
    `functions/src/storage.ts` keeps its `STORAGE_BUCKET` override; `.env.example` in
    `apps/web` and `apps/mobile` document the sets. `scripts/seed-admin.ts` and
    `seed-test-accounts.ts` take the project id from `GCLOUD_PROJECT`, the credentials file,
    or an argument, and print it before writing. `dailySweep` and `paymentsSweep` gain
    `retryCount: 3`; `dailySweep` gains `timeZone: LAUNCH_TIMEZONE` (its 09:00 slot then means
    launch-metro morning); `stripeWebhook` gains `timeoutSeconds: 120`.

## 7. Data model changes (additive)

- `DepositState.chargeAmountCents?: number` (payment docs).
- `LedgerEntry.sourced?: boolean`; new ledger kinds `dispute_opened`, `dispute_lost`,
  `dispute_won`, `external_refund`.
- `disputes/{disputeId}`: `{ chargeId, intentId, purpose, bookingId?, gigId?, orderId?,
  amountCents, status: "open" | "won" | "lost", reversalTransferId?, openedAt, closedAt? }`,
  admin read, server write.
- `TicketOrderDoc.disputeId?`, `disputeStatus?`.
- `EventDoc.settlementClaimedAt?: number`.
- `GigDoc.fillMode?: "whole_run" | "per_occurrence" | null`.
- `UserDoc.lastProfileRejectedAt?: number` (server-only; not in the owner-updatable key set).
- `posterUploads/{uid}/{nonce}`: `{ path, createdAt }`, owner read.
- `eventCascadeRetries/{eventId}`: server-only.
- `AdminAlertDoc.kind` gains `dispute_opened`, `dispute_reversal_failed`, `external_refund`,
  `ticket_order_stuck`.
- `AuditLogDoc.action` gains `event_taken_down`, `account_deleted`, `profile_deleted_stripe_ids`.
- New message constants (`packages/shared/src/messages.ts`): `EMAIL_NOT_VERIFIED_MESSAGE`,
  the four `DELETE_PROFILE_*` and three `DELETE_ACCOUNT_*` constants, `CHECK_IN_TOO_EARLY_MESSAGE`,
  `GIG_ALREADY_PROMOTED_MESSAGE`, `PENDING_ORDERS_CAP_MESSAGE`, `THREAD_FULL_MESSAGE`.
- New secret: `STRIPE_CONNECT_WEBHOOK_SECRET`.
- New indexes: `payments (musicianProfileId, settlement.status)` collection group (the
  curator-side twin already exists); the events cascade and deletion gate queries are served
  by the existing `events (curatorProfileId, status, startsAt)` and `orders (eventId, status)`
  composites; the two override repairs land in branch A.
- New scheduled functions: `ticketOrderExpiry` (every 5 minutes). New triggers:
  `onUserDeleted`. New callables: `takedownEvent`, `cancelTicketOrder`, `undoCheckIn`.
- Rules: `pushTokens` split; `notifications.read is bool`; `users.displayName` non-empty;
  `invites` admin read; `posterUploads`, `disputes`, `eventCascadeRetries` blocks.

## 8. Docs (last tasks on branch B)

- **README**: intro rewritten as one paragraph per sub-project through 10; monorepo map
  regenerated from `git ls-files`; design-docs table through 10 with rulings pointers; payout
  authority corrected to admin-only in both places; `dailySweep` documented as nine steps and
  `paymentsSweep` as eleven with the "dailySweep step N / paymentsSweep step N" convention;
  env table gains `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `FIREBASE_EMULATORS`, `STORAGE_BUCKET`,
  `WEB_PORT`, `GOOGLE_APPLICATION_CREDENTIALS`, both Firebase config sets, and
  `STRIPE_CONNECT_WEBHOOK_SECRET`; a scripts section; an "Events and ticketing (sub-project 6)"
  concept section; the webhook-secret behavior corrected to fail-closed; the $10 instant
  minimum added; the stale EAS-init, invite-guard, and lint-scaffold lines fixed; the Stripe
  go-live checklist gains the second endpoint, Radar and dispute-liability settings, the
  platform-float decision, the dispute test card, and the 1099 delivery setting.
- **HANDOFF**: sub-project list gains 10 (SP7 adds itself at its merge); the owner-owed
  section is replaced by the consolidated launch table from the docs audit (section B) plus
  the new go-live items above, `STORAGE_BUCKET`, scheduler and `adminAlerts` alert policies,
  PITR and a daily export, security headers, and the microphone and `iosUrlScheme` items; a
  roadmap block (7 fan discovery in flight, 8 search, 5c splits, messaging unscheduled); a
  standing-tripwires list (`resumeSeries` needs `pausedBy` and an approval gate, Android
  `openBrowserAsync` resolves at open, the 24h idempotency-key hazard, the RSC boundary rule,
  the `source_transaction` cap, the two Stripe webhook scopes); a dated line "no em dash rule
  enforced repo-wide by CI since sub-project 10 (2026-09)".
- **Rulings docs**: foundation, sp2, and sp3 resolved items annotated in place;
  `sp10-rulings.md` written at merge in the house shape.
- **Plans**: a two-line banner at the top of each plan: historical execution record; code
  and the rulings doc win.

## 9. Testing

- **`emu:test`** (new cases, each named for its item): sourcing decision for the three cases
  and the cumulative cap; dual-secret verification including the two cross-scope refusals;
  each dispute event for a deposit, a settlement, a pay-past-due, and a ticket order,
  including reversal failure; the settlement webhook race; captured-order completion and the
  stuck alert; the settlement claim and wedge recovery; the events cascade with refunds,
  drafts, completed events, and a poisoned event landing in `eventCascadeRetries`;
  `takedownEvent`; every deletion refusal reason and the audit entry; `onUserDeleted`; token
  pruning on `DeviceNotRegistered`; geocoder fail-closed, no-city null, timeout; projection
  seeding and preservation; poster doc write and sweep; `cancelTicketOrder`, the 5-minute
  expiry job, the pending-orders cap; `undoCheckIn` and the early check-in refusal; the
  reminder string; series auto-end, propagation skip, inclusive end date; the reopened-date
  single booking; past-start guards; step 6 skip; offer-expiry curator notification.
- **`emu:rules`**: push-token matrix; `notifications.read` type; `displayName` non-empty;
  `invites` admin read; `posterUploads`, `disputes`, `eventCascadeRetries`; a `bookings`
  list-provability matrix for every shipped query shape; the five `events` SSR query shapes.
- **Shared**: every new message constant exported and em-dash free (a test scans the
  exported `*_MESSAGE` values for U+2014); `notificationHref` map.
- **Web**: lint, build, live loads of `/@handle`, `/@handle/shows`, `/e/[eventId]`, `/admin`,
  `/dashboard` (RSC discipline). **Mobile**: lint and `expo export`.
- **Gates**: typecheck 5/5; shared, `emu:test`, and `emu:rules` counts strictly above 158,
  704, 103; lints 0 errors; web build. Whole-branch security audit (the SP5 checklist plus the
  dispute, cascade, and deletion paths) before merge; rules audit re-run on the changed blocks.

## 10. Out of scope (deliberate)

Everything assigned by the audit to SP7 (feeds, follows, posters on cards, notification kinds,
fan onboarding, share links), SP8 (search, sitemap, handle redirects, reserved handles,
rate-limit helper), 5c (per-order ticket settlement transfers, payout history, member roles on
payout buttons), and the launch checklist (console and Stripe dashboard work, App Check
enforcement, security headers, backups). The accessibility and state-coverage findings
(antislop #10 to #29). Messaging. Admin tooling beyond the Events block. Email delivery beyond
Stripe receipts. `firebase-admin` 13. The hardening ledger rows L62 to L80.

## 11. Owner-owed after merge

- Register the second Stripe webhook endpoint ("Connected accounts" scope) and set
  `STRIPE_CONNECT_WEBHOOK_SECRET`; re-run the README test-mode walkthrough with both endpoints.
- Simulate a dispute with Stripe's `4000 0000 0000 0259` card on a deposit and on a ticket
  order; confirm the alert, the delinquency flag, and the reversal on a lost outcome.
- New EAS dev build (notification handler and poster picker changed native config), then the
  unchanged 9A, 9B, and SP6 smoke lists plus: scanner offline panel, reminder copy, verify
  banner, deletion refusals, poster upload.
- Deploy and confirm the new composite indexes and the repaired field overrides show Enabled.
- Decide the platform float for ticket settlement (launch checklist).

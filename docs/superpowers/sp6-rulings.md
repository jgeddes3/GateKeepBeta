# GateKeep Sub-project 6 (Events & Ticketing) - Rulings & Handoff

Durable record from sub-project 6, executed subagent-driven with per-task reviews (spec compliance
then code quality), scoped re-reviews of every fix round, and a whole-branch final review on the
most capable model, merged to `main` on 2026-08-31. Mirrors the sp2-sp5b/sp9a/sp9b rulings docs.
This document, like all sub-6 output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-08-30-events-ticketing-design.md` (binding authority)
Plan: `docs/superpowers/plans/2026-08-30-events-ticketing.md` (13 tasks)
Gates at merge: typecheck 5/5, shared 158, `emu:test` 704, `emu:rules` 103, web lint 0 + build,
mobile lint 0 new + `expo export` bundles. The 704 includes SP5's original 578 unchanged: every
touch to `paymentsWebhook.ts`, `paymentsSweep.ts`, `stripeClient.ts`, and the shared package was
verified additive by review, twice (per-task and whole-branch).

## What shipped

Public events built from filled bookings or standalone, multi-tier fan ticketing on the SP5 Stripe
rails, escrowed payouts, QR door check-in, and capped in-app transfers:

- **Backend** (`functions/src/eventsCore.ts`, `events.ts`, `ticketing.ts`, plus additive sweep
  steps 8-11 and webhook purpose `"tickets"`): event/tier lifecycle callables, transactional
  checkout with inventory + buyer-cap enforcement, finalize/webhook exactly-once completion,
  order-expiry sweep, cancellation auto-refunds, per-ticket grace refunds, T+1 post-event
  settlement, event reminders, check-in, email-targeted transfers with anti-enumeration.
- **Rules**: six new collections plus `users/{uid}/ticketIndex/{eventId}` (the valid-ticket proof
  the address gate and buyer cap read); every client write denied; list queries regression-pinned.
- **Web**: public SSR event page `/e/[eventId]` with the buy flow (Elements), live Upcoming Events
  sections on venue and artist pages, curator events management (tiers, publish, cancel, attendee
  list with grace refunds), fan `/tickets` wallet with client-rendered QR.
- **Mobile**: fan event screen + PaymentSheet buy, Tickets tab (QR wallet, address reveal,
  transfers, incoming offers), fan Home upcoming list, curator management + expo-camera door
  scanner + attendee check-in. All per DESIGN.md on the 9B primitives; money sentences byte-match
  their web twins.

## Load-bearing rulings

1. **Ticket fee** is fan-paid on top: per ticket `min(round(price * 7%) + 99c, 399c)`, zero on
   free tickets, snapshotted per order via `TicketFeePolicy` (tuning never rewrites history).
   Curator settlement is 100% of face value, `faceTotalCents - refundedFaceCents` summed over paid
   orders, transferred T+1 after `endsAt` under idempotency key `ticket_settlement:{eventId}`.
2. **Grace refunds close at `endsAt`** (`TICKET_REFUND_WINDOW_CLOSED_MESSAGE`). This freezes the
   settlement basis a full day before any transfer, which is what makes the static settlement
   idempotency key safe against amount drift. Post-show disputes are manual. Deviates from the
   spec's unbounded grace wording in favor of its pre-show intent.
3. **`settlementStartedAt` is a transactional CAS stamped immediately before the Stripe transfer**;
   `cancelEventCore` refuses any event carrying it. Closes the transfer-then-cancel double-spend
   window. A cancel between `endsAt` and settlement start stays legal (show never happened).
4. **The buyer cap counts held tickets PLUS the buyer's other pending orders** at create time
   (stricter than the spec's literal "held" wording, per the owner's anti-scalping intent), and
   transfer offers/accepts re-check the recipient's cap so transfers cannot launder it.
5. **Transfers target email only.** The spec's "@handle" idea resolves to group profiles, not
   people. `offerTransfer` always returns `TRANSFER_OFFER_SENT_MESSAGE` (no account enumeration);
   the open-offer rejection is thrown to the sender before target resolution. Web is view-only for
   transfers in v1 (a "manage in the app" hint); mobile owns the flow. A cap-blocked accept parks
   the offer until decline or 24h TTL expiry (by design; the recipient can decline to release).
6. **`refundTicket` voids open transfer offers in a pre-phase transaction before the Stripe call**,
   and its apply transaction converges on the CURRENT owner's live ticket if a transfer accept
   raced in anyway (owner-keyed teardown, money to the order's buyer); an unteardownable live
   ticket raises an adminAlert and throws. Never a silent ok when Stripe money moved.
7. **Event cancellation resolves tickets by collection-group `tickets.orderId`** (CG index), so
   transferred tickets are torn down for their current owner while refunds go to the order's
   buyer. Money truth: `refundedTicketIds`/`refundedCents`/`refundedFaceCents` on the order.
8. **The QR is possession of a server-minted secret**: payload `{ticketId, eventId, qrSecret}`,
   compared `===` against the live ticket doc; transfers mint a fresh secret so old QRs die at the
   scanner. `checkInTicket` resolves attendee -> owner -> ticket, requires curator membership of
   the EVENT's profile, and `override: true` (strict boolean) is the name-list fallback.
9. **Booking lineup acts are verified server-side** (`verifyLineupBookingActs`): the booking must
   exist, belong to the calling curator, match the musician, and be `confirmed`. A curator cannot
   fabricate an association on a musician's public page. `lineupMusicianProfileIds` (server-derived)
   powers the musician-page upcoming query.
10. **Events past their start cannot be edited** (`validateEventInput` requires future `startsAt`
    at create; update keeps ordering constraints), which quietly guarantees the refund freeze and
    settlement basis are immutable. `updateEvent` cannot change location (mirrors updateGig).
11. **Completed events stay publicly readable** (spec text said published-only): past ticket
    surfaces and past event pages need it; the plan's approved rules template included it.
12. **The settlement ledger doc id is `ticket_settlement:{transferId}`** per `writeLedger`
    convention, not `:{eventId}` as the plan prose said; dedup holds via the idempotent transfer id.
13. **finalizeTicketOrder returns `{ orderStatus }`** (the enum); clients branch on it and compare
    the shared gate messages with `===` on both platforms (sold-out and sale-closed trigger a live
    tier refetch).

## Accepted exceptions and deferred (conscious, not oversights)

- **Poster upload is not wired end to end**: the media pipeline accepts kind `"poster"` (regex,
  cast, storage rules) but `processPhoto` is a background trigger that never surfaces the processed
  path to the client. Events render a branded placeholder; `posterPath` is validated server-side
  when present. Follow-up needs a small functions change (watchable doc field or callable).
- Gig re-promotion is blocked client-side only (no server gigId-uniqueness check); duplicate would
  be a cancellable curator-own-data event.
- `/tickets` unpaginated; duplicate fan tab listeners; abandoned pending orders hold inventory up
  to ~70 min (10-min TTL + hourly sweep) with no buyer-side cancel; grace-vs-cancel races can delay
  a buyer remainder up to ~24h behind Stripe's idempotency cache (self-healing, adminAlerted);
  two-hop transfer chains under a raced refund escalate (alert + throw) rather than auto-resolve;
  a rescheduled published event does not re-notify holders or re-arm its reminder.
- Cancelled-ticket card copy is neutral ("refunded to the original purchaser") because a transfer
  recipient paid nothing.
- En dashes in time/price ranges are web-parity glyphs, kept. No em dashes anywhere.

## Owner smoke (the hard pre-launch gate for sub-6)

The full checklist is in `README.md` ("Sub-project 6 launch checklist" + "smoke checklist").
Highest priority, impossible to verify on this machine:
1. **Paid ticket end to end with real Stripe TEST keys**: one web Elements purchase, one mobile
   PaymentSheet purchase (the keyless emulator proves only up to the payment sheet mount).
2. **A new EAS dev build** (expo-camera and react-native-qrcode-svg joined the native deps), then
   the DOOR SCANNER on a real camera: scan, duplicate scan shows the original check-in time,
   permanently-denied camera opens Settings.
3. Two-account transfer, attendee tap check-in, both themes on both platforms.
4. After first deploy: confirm the 11 new composite indexes + the `tickets.orderId` collection
   group override finish building in the Firebase console before real traffic.

## Environment notes

Windows, `corepack pnpm`. Emulator suites need the Java PATH prepend and
`FUNCTIONS_DISCOVERY_TIMEOUT=60` (see the user memory / HANDOFF). `pnpm emu:test` is one blocking
~9 minute call. Subagent lesson recorded for future controllers: implementers that background a
test run and stop to wait stall forever; test runs must be foreground with a 600000ms timeout.

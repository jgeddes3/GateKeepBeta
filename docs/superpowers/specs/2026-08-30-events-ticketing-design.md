# Sub-project 6: Events & Ticketing - Design Spec

Date: 2026-08-30. Status: approved in brainstorm, awaiting owner spec review.
Builds on: SP3 (gigs, geodata, address privacy), SP4 (bookings, filled gigs, Shows),
SP5/5b (Stripe rails, FakeStripe, PaymentSheet), 9A/9B (DESIGN.md is binding on every surface).

## Purpose

Open GateKeep to fans: curators publish public event pages built from their booked gigs (or
standalone), fans buy tickets with the platform's service charge as the second revenue stream,
and the door runs on QR check-in. Discharges two standing contracts: SP3's "ticket-holders get
the exact address" and the foundation's "tickets attach to the user doc".

## Decisions (owner-ruled in brainstorm)

1. **Event source: bookings + standalone.** A curator can promote any filled gig into an event
   in one tap (pre-filled from gig + booking), or create a standalone event with a free-text
   lineup for acts booked off-platform.
2. **Tickets: paid + free, multi-tier.** Named tiers per event (GA, VIP, early bird), each with
   its own price, capacity, and optional sale window. `priceCents: 0` = free RSVP tier.
3. **Service charge: fan pays, on top.** 7% + $0.99 per ticket, capped at $3.99 per ticket.
   Snapshotted per order via the SP5 feePolicy pattern; tuning later never rewrites history.
4. **Payout: held until after the event.** Sales collect on the platform account; a sweep
   transfers the curator's share (100% of face value) T+1 after `endsAt`. Same machinery
   pattern as SP5's T+3 settlement.
5. **Refunds: cancel-only + curator grace.** Event cancellation refunds every paid order in
   full (service fee included) automatically from held funds. A curator can refund any single
   ticket from the attendee list; that re-releases its inventory. No fan self-serve refunds.
6. **Check-in: QR + name-list fallback.** Signed QR per ticket, curator scanner screen in the
   mobile app, searchable attendee list as fallback.
7. **Buyers need accounts.** No guest checkout. Public event pages are shareable web links;
   the Buy button requires sign-in (Google/Apple make this fast).
8. **Multi-qty + in-app transfer, capped.** Up to the per-event cap per buyer (curator-set,
   default 8, counts tickets HELD: purchases plus received transfers, so transfers cannot
   launder the cap). Transfers are in-app only, recipient must hold a GateKeep account.

## Architecture

Checkout reuses the SP5 rails: a callable creates the PaymentIntent (platform charge, new
`metadata.purpose: "tickets"`), the existing webhook claim machine finalizes, Elements on web
and the 5b PaymentSheet on mobile, FakeStripe keeps the whole flow keyless in the emulator.
No Stripe hosted Checkout pages (breaks native sheets, no FakeStripe parity, second webhook
dialect).

New functions module split mirrors SP5: `eventsCore` (pure helpers: fee math lives in
`packages/shared`, inventory transaction builders, ticket/QR signing), `events` (curator CRUD +
publish/cancel callables), `ticketing` (checkout, expiry sweep, check-in, transfer, refund
callables), plus webhook dispatcher additions and the post-event settlement sweep.

## Data model

- `events/{eventId}`: `curatorProfileId`, `title`, `description`, location snapshot at public
  precision (from the gig or entered for standalone), `startsAt`, `endsAt`, `posterPath`,
  `status: "draft" | "published" | "completed" | "cancelled"`, `maxTicketsPerBuyer` (default 8),
  `lineup: Act[]` where `Act` is `{kind:"booking", bookingId, musicianProfileId, name}` or
  `{kind:"external", name}`. `gigId` nullable linkage for promoted gigs.
- `events/{eventId}/private/address`: exact address doc for precision-limited events;
  readable only by curator members, admins, and holders of a valid/checked-in ticket.
- `events/{eventId}/tiers/{tierId}`: `name`, `priceCents` (>= 0), `capacity`, `soldCount`
  (server-maintained), `saleStartsAt`/`saleEndsAt` nullable, `sortOrder`.
- `orders/{orderId}`: `buyerUid`, `eventId`, `curatorProfileId`, line items
  `[{tierId, quantity, unitPriceCents}]`, `faceTotalCents`, `serviceFeeCents`,
  `feePolicy` snapshot, `paymentIntentId`, `status: "pending" | "paid" | "expired" |
  "cancelled_refunded"`, `refundedTicketIds` + `refundedCents` (grace refunds; the order stays
  `paid`), `createdAt`, `expiresAt`. Only event cancellation moves a whole order to
  `cancelled_refunded`.
- `users/{uid}/tickets/{ticketId}`: `eventId`, `tierId`, `orderId`, `qrSecret` (server-minted),
  `status: "valid" | "checked_in" | "refunded" | "transferred"`, `checkedInAt` nullable,
  `transferredTo` nullable. One doc per admitted person.
- `events/{eventId}/attendees/{ticketId}`: server-written projection (owner display name, tier,
  status) powering the curator attendee list without opening `users/*` reads.
- `transfers/{transferId}`: `ticketId`, `fromUid`, `toUid`, `eventId`,
  `status: "offered" | "accepted" | "declined" | "expired"`, `expiresAt` (24h).

Inventory truth is `soldCount <= capacity`, enforced inside the order-creation transaction.
Pending orders reserve inventory; the expiry sweep (10-minute TTL) flips `pending` orders that
never paid to `expired` and decrements `soldCount`.

## Money flow

1. `createTicketOrder` callable: validates sale window, per-buyer cap (held count + requested),
   and inventory in one transaction; writes the `pending` order; creates the PaymentIntent for
   `faceTotal + serviceFee` with `purpose:"tickets"`; returns client secret.
2. Client confirms via Elements / PaymentSheet. Webhook (or sync path) marks the order `paid`
   and mints ticket docs + attendee projections. Exactly-once via the `stripeEvents` claim
   machine. Free-tier orders skip Stripe: the callable completes them directly.
3. Post-event settlement sweep (extends the SP5 hourly sweep): events with
   `status:"published"` and `endsAt` older than T+1 get `status:"completed"` and one transfer
   of the face-value sum of paid, non-refunded tickets to the curator's connected account.
   Ledger entries use the SP5 deterministic-id pattern.
4. `cancelEvent` callable (curator members): flips status, halts sales, refunds every paid
   order in full (face + fee) from held platform funds, marks tickets `refunded`, notifies
   holders via the SP1 notification inbox. `refundTicket` (curator grace) refunds one ticket's
   face + its fee share, re-releases inventory, updates the order.
5. Fees live in `packages/shared` money math with unit tests: `ticketServiceFeeCents(unitPrice,
   qty)` = per-ticket `min(round(price * 0.07) + 99, 399)`, summed; free tickets carry zero fee.

## Check-in

- QR payload: `{ticketId, eventId, qrSecret}`. `qrSecret` is a server-minted random token
  stored on the ticket doc (owner-readable), so the QR renders locally in the fan app/web with
  no network needed; possession of the secret is the proof, and a transfer mints a new one.
- `checkInTicket` callable (curator members of the event's profile only): matches `qrSecret`
  against the live ticket doc,
  transactionally flips `valid -> checked_in` + stamps `checkedInAt`, returns name + tier.
  Duplicate scan returns an already-checked-in response with the original time; the scanner
  screen renders it loudly.
- Scanner screen (mobile, expo-camera; native dep joins the pending EAS build) with a second
  tab: live attendee list (onSnapshot), searchable, tap-to-check-in fallback.
- Scans require connectivity (accepted for the launch metro; offline queue is a later item).

## Transfers

`offerTransfer` (holder, ticket `valid`, event not started): targets an @handle or email,
resolved server-side; the callable returns the same acknowledgment whether or not the target
exists (no account enumeration; emails are never publicly readable per foundation rules), and
the transfer doc + notification are created only when it does. `acceptTransfer` re-checks the
recipient's held-count cap, mints a fresh ticket doc (new `qrSecret`) under the recipient,
flips the old ticket to `transferred`, updates the attendee projection. Decline or 24h expiry
returns the ticket untouched. Old QR dies because check-in reads the live ticket doc.

## Surfaces (all per DESIGN.md; no later restyle pass)

Web:
- `/e/[eventId]`: public SSR event page. Poster, date block, lineup (booking acts link to
  `/u/[handle]`), venue card, tier picker, buy flow (Elements), sold-out and sale-window
  states. Address at public precision; exact address appears for valid ticket holders.
- Venue and artist pages: "Upcoming Events" sections go live (published events only).
- Curator dashboard: Events management (create standalone, promote filled gig, edit draft,
  publish, cancel with confirmation, per-tier sales stats, attendee list with refund button).
- Fan account: "Your tickets" page (upcoming/past, QR display, address reveal).

Mobile:
- Fan Tickets tab becomes real: upcoming/past tickets, full-screen QR, venue address, transfer
  send/accept. Fan Home lists their upcoming events.
- Curator events screens gain: tiers editor, publish/cancel, sales stats, scanner + attendee
  list, refunds.
- Buy flow uses the 5b PaymentSheet seam.

## Security rules

Default-deny discipline continues. `events` public-read only when `published` (draft/cancelled
readable by curator members + admins); `tiers` public-read with parent published; `orders`
readable by buyer + curator members + admins, never client-writable; `users/{uid}/tickets`
readable by owner (and server-written only); `attendees` readable by curator members + admins;
`private/address` readable by curator members, admins, and requesters holding a valid or
checked-in ticket for that event (exists() check on the requester's ticket); `transfers`
readable by the two parties. All queries follow SP4 ruling 17 provability (equality pins).
Money writes are server-only without exception.

## Notifications

Reuses the SP1 inbox + push: purchase confirmation, event cancelled (with refund note),
transfer offered/accepted, event-tomorrow reminder (extends the existing scheduler). No email
in v1: the Tickets tab is the receipt.

## Explicitly out (YAGNI)

Guest checkout; fan self-serve refunds; seat maps; promo/discount codes; ticket emails/PDFs;
offline scan queue; scalper resale marketplace; per-musician ticket revenue splits (tickets are
curator revenue; musicians are paid via bookings; splits stay in deferred 5c territory);
event discovery feeds and search (sub-7/sub-8: this sub-project links events only from venue
pages, artist pages, and shareable URLs).

## Gates

Existing counts must hold (typecheck 5/5, shared 153+new, emu:rules 77+new, emu:test 578+new,
web lint/build, mobile lint). New emulator suites cover: order transaction + cap + inventory +
expiry; paid finalize exactly-once; free RSVP; settlement sweep; cancel-refund; grace refund;
check-in + duplicate; transfer lifecycle + cap laundering; rules matrix for every new
collection. Copy obeys the no-em-dash rule and the antislop skills.

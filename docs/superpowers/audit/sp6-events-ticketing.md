# SP6 Events and Ticketing: read-only audit (2026-09-01)

Scope: every file listed in the brief was read in full (backend, rules, indexes, shared, web, mobile, tests, seed script). Findings are verified against code, not docs. Accepted exceptions from `sp6-rulings.md` are only re-raised where the acceptance looks wrong for a fan-facing launch. No repo file was modified.

Severity key: Critical = a fan or curator cannot do the core thing, or money is at risk with no signal. High = fan-visible failure in a normal path, or a money/door hazard. Medium = real gap with a workaround or narrow trigger. Low = polish, hygiene, test coverage.

Owner key: fix-now = small, self-contained, worth landing before device smoke; SP7 = fan discovery owns it; SP8 = search/SEO owns it; 5c = the payments follow-up bucket; launch-checklist = an owner decision or console step, not code.

---

## A. Numbered findings

### 1. Mobile fans cannot reach any event they have not already bought

- Severity: Critical. Category: missing-feature. Owner: SP7.
- Evidence: `apps/mobile/app/(fan)/index.tsx:96-102` (Discover tab is a "coming soon" placeholder; the only list is "Your upcoming shows", derived from tickets already held), `apps/mobile/app/(fan)/search.tsx:15` ("Find artists and venues, coming soon"), `apps/mobile/app/artist/[handle].tsx:345-354` (artist page renders gig-based "Shows" rows only, no event rows and no link to `/event/[eventId]`), `apps/mobile/app` directory listing (no venue route at all), `apps/mobile/app.json:8` (custom scheme only, no `associatedDomains` or Android `intentFilters`), `apps/mobile/app/_layout.tsx:82-85` (comment: the event screen is pushed "from Home's upcoming list, the Tickets tab, and (later, sub-7) discovery").
- Defect: the entire mobile buy flow at `apps/mobile/app/event/[eventId].tsx` has no production entry point for a first purchase.
- Failure scenario: a fan installs the app from the store, signs up, and finds two "coming soon" tabs and an empty Tickets tab. A shared `https://.../e/{id}` link opens the web page in the phone browser, never the app. Their first ticket can only be bought on web.
- Recommended action: SP7 must ship at least one of: an event feed on Discover, a venue/artist page with an "Upcoming events" section on mobile, and universal links (`associatedDomains` + `intentFilters`) so `/e/{id}` opens the app. The `(status, startsAt)` composite index and the `status == 'published'` rules disjunct already make a public feed query provable today (see section D).

### 2. An abandoned pending order blocks the same fan from the seats they just held

- Severity: High. Category: ux (accepted exception re-raised). Owner: fix-now.
- Evidence: `functions/src/ticketing.ts:105-153` (inventory and cap reserved in the transaction before Stripe is called), `functions/src/ticketing.ts:99-100,128-133` (the cap counts the buyer's own pending orders), `functions/src/eventsCore.ts:22` (`ORDER_TTL_MS` 10 min), `functions/src/paymentsSweep.ts:1279-1282,1632` (expiry only runs inside the hourly sweep, so the real hold is 10 to 70 min), `apps/web/src/events/BuyTicketsFlow.tsx:364` (Cancel just resets local state), `apps/mobile/app/event/[eventId].tsx:324-328` (sheet dismissal calls `resetPurchase`, "the abandoned pending order simply expires via the TTL sweep").
- Defect: no buyer-side cancel exists, and nothing on the client resumes an existing pending order, so a dismissed sheet or a browser Cancel leaves a hold the fan cannot release.
- Failure scenario: two seats left. Fan taps Buy for 2, the PaymentSheet opens, they swipe it away to check the date, tap Buy again: `EVENT_SOLD_OUT_MESSAGE`. The tier reads "Sold out" to them for up to 70 minutes because of their own hold. Same shape with the cap: a fan buying 5 for friends who cancels once cannot retry 5 (5 pending + 5 new > 8).
- Recommended action: add a buyer-owned `cancelTicketOrder(orderId)` callable (pending only: `cancelIntent` then the same release transaction `cancelPendingOrderForCancelledEvent` already has at `ticketing.ts:556-564`), and call it from web Cancel and mobile `outcome.cancelled`. Separately, move step 8 (order expiry) onto a 5-minute schedule so a crashed client's hold is ~15 min, not ~70. The rulings accepted this as "no buyer-side cancel"; for near-capacity shows it is a support-ticket generator and should not ship as is.

### 3. Door scanner shows "Not valid" for a network or server failure, and auto-dismisses in 1.5 s

- Severity: High. Category: bug. Owner: fix-now.
- Evidence: `apps/mobile/src/events/ScannerScreen.tsx:152-165` (every non-duplicate rejection, including `FunctionsError` codes `unavailable`, `deadline-exceeded`, `internal`, and a plain fetch failure, becomes `{ kind: "invalid", message }` rendered as the red "Not valid" panel), `ScannerScreen.tsx:126-133` (all results, invalid included, clear after 1500 ms).
- Defect: transport failures and ticket rejections share one destructive panel; the door has no "could not reach the server, try again" state and no offline indicator.
- Failure scenario: venue Wi-Fi drops for ten seconds. A paying fan's valid QR shows a red "Not valid" with a raw error string; the staffer reads "Not valid", the fan is turned away or argues, and the panel is gone before anyone reads the detail.
- Recommended action: branch on `e instanceof FunctionsError` and its `code`: only `failed-precondition`/`not-found`/`permission-denied` are ticket verdicts; everything else renders a neutral "Couldn't reach GateKeep. Try again." panel that does not auto-dismiss and re-arms the scan lock on tap. Keep the 1.5 s auto-clear for success only; let duplicate and invalid stay until tapped.

### 4. Event reminder renders the show time in UTC and calls same-day events "tomorrow"

- Severity: High. Category: bug. Owner: fix-now.
- Evidence: `functions/src/scheduled.ts:34-41` (`formatEventReminderDate` uses `getUTC*` and appends "UTC"), `scheduled.ts:928-931` (title "Event tomorrow", body `"<title>" starts <date> at <h:mm> UTC`), `scheduled.ts:912-916` (window is "starts within the next 24 h" evaluated at the 09:00 UTC daily run, `scheduled.ts:966`), while every client renders in `LAUNCH_TIMEZONE` (`apps/web/src/events/eventDisplay.ts:93-97`, `apps/mobile/src/events/eventDisplay.ts:86-114`, `packages/shared/src/types.ts:316`).
- Defect: the one push notification a fan gets before a show disagrees with every screen in the product on both the time and, for evening shows, the calendar date.
- Failure scenario: an 8:00 PM ET Friday show. At 5:00 AM ET Friday the fan receives "Event tomorrow: 'X' starts September 6, 2026 at 12:00 AM UTC." The show is today, at 8 PM, on September 5.
- Recommended action: format with `Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, ... })` (Node 20 ships full ICU; the "avoid a dash" worry in the comment does not apply to this format), and derive the title from the launch-zone calendar day ("Tonight" / "Tomorrow"). Add a test that pins the rendered string (none exists; the settlement test only counts recipients).

### 5. A captured payment whose order never completes has no reconciliation and no alert

- Severity: High. Category: bug (money). Owner: fix-now.
- Evidence: `functions/src/paymentsSweep.ts:1239-1251` (when `cancelIntent` throws and `retrieveIntentStatus` returns anything but `canceled`, the order is left pending, `ticketOrdersExpiryDeferred++`, and the function returns: no `completeOrderTx`, no `recordAdminAlert`), `functions/src/ticketing.ts:222-286` (`completeOrderTx` is idempotent and safe to call from here), `ticketing.ts:186-214` (finalize only runs if the buyer's client calls back).
- Defect: the sweep observes `status === "succeeded"` (money moved) and does nothing with that knowledge every hour, forever.
- Failure scenario: fan pays on mobile, the app is killed before `finalizeTicketOrder`, and the `payment_intent.succeeded` webhook delivery fails past Stripe's retry window (or the endpoint was misconfigured for a day). The fan has been charged, holds no ticket, the attendee list does not show them, and no operator surface ever mentions the order; only a counter in a log line moves.
- Recommended action: in the deferred branch, if `status === "succeeded"` call `completeOrderTx(doc.id)` (same idempotent transaction the webhook uses) and count it; for any other non-canceled status older than, say, 2 hours, `recordAdminAlert` with a new kind so a human sees it. The existing "money always wins" test only proves finalize completes it later; add a test that the sweep itself converges.

### 6. Transfer anti-enumeration is defeated by observable state

- Severity: Medium. Category: security. Owner: fix-now.
- Evidence: `functions/src/ticketing.ts:1083-1089` (a second `offerTransfer` on the same ticket throws `DUPLICATE_TRANSFER_OFFER_MESSAGE` only if an offer doc exists), `ticketing.ts:1092-1099,1125-1130` (the offer doc is created only when the email resolves to an account and is under cap; an unknown email creates nothing), `firestore.rules:320-326` (the sender may read `transfers where fromUid == me`), `functions/test/ticketingDoor.test.ts:435` (pins "creates nothing" for an unknown email).
- Defect: the callable's response is uniform, but the side effects are not: "does a transfer doc now exist" (readable by the sender) and "does a second offer throw duplicate" both answer "does this email have a GateKeep account".
- Failure scenario: a user with one ticket offers it to `target@x.com`, then immediately offers it again: a duplicate error means the account exists; "sent" means it does not. Or they just query their own outgoing transfers. One probe per ticket per 24 h (or per decline), which is enough for a targeted check.
- Recommended action: always create the transfer doc. For an unresolved or cap-blocked target store `toUid: null` (plus a hashed target for audit) with the same `offered` status and TTL; the recipient listener (`toUid == uid`) never sees it, the duplicate check behaves identically either way, the sweep expires it, and the sender's view is uniform. Also mention the timing difference (the unknown-email path returns before any Firestore reads) in the same fix.

### 7. Checkout shows no refund policy, no terms line, and sends no receipt

- Severity: Medium. Category: ux / launch. Owner: fix-now (copy and `receipt_email`), launch-checklist (legal review).
- Evidence: `apps/web/src/events/BuyTicketsFlow.tsx:114-129,153-162` (sticky bar and Pay form carry only the total and Pay/Cancel), `apps/mobile/app/event/[eventId].tsx:523-534` (same), `apps/web/app/terms/page.tsx:22` (the only ticket sentence on the terms page is "Fans discover shows and buy tickets where ticketing is available"), `functions/src/stripeClient.ts:837-842` (`createIntent` sets no `receipt_email`), spec "Notifications" section ("No email in v1: the Tickets tab is the receipt").
- Defect: a fan pays real money without being told that there are no self-serve refunds, that only cancellation or an organizer refund returns money, or that the service fee is what it is; and they get nothing in their inbox afterwards.
- Failure scenario: a fan buys, cannot attend, looks for "request refund", finds nothing, disputes the charge with their card issuer. The platform eats the chargeback plus fee (see finding 14).
- Recommended action: one sentence above Pay on both platforms ("All sales are final unless the event is cancelled or the organizer refunds you. Service fee included in the total."), a terms-page ticketing section, and pass the buyer's verified email as `receipt_email` on the ticket PaymentIntent (Stripe emails a receipt in live mode with zero infra; the `createIntent` signature change is additive).

### 8. A sender cannot cancel an outgoing transfer offer and cannot see it

- Severity: Medium. Category: missing-feature. Owner: SP7 (or fix-now if ticketing gets a patch round).
- Evidence: `functions/src/ticketing.ts:1157-1259` (`respondToTransfer` is recipient-only; no sender cancel exists in `index.ts:29-32`), `apps/mobile/src/tickets/TicketList.tsx:116-135` (only `toUid == me` is listened to; no outgoing list), `apps/mobile/src/tickets/TicketDetail.tsx:47,105-111` (a ticket with an open offer still shows the QR and a "Transfer this ticket" button that will throw duplicate).
- Defect: a mistyped email that happens to belong to a real user hands them a 24 h option on the ticket, and the sender's only recourse is to hope they decline.
- Failure scenario: fan sends to `jon@x.com` meaning `john@x.com`. Jon accepts. The ticket is gone; the sender's QR is dead; support cannot reverse it (no admin tool either).
- Recommended action: `cancelTransfer(transferId)` for `fromUid`, an "Offer pending to ... until <time>" line on `TicketDetail` (the sender can read the doc already), and hide the Transfer button while an offer is open.

### 9. Transfer sheet promises a notification the recipient may never get

- Severity: Medium. Category: ux (copy). Owner: fix-now.
- Evidence: `apps/mobile/src/tickets/TransferSheet.tsx:58-60` ("They'll get a notification to accept it."), `functions/src/ticketing.ts:1092-1099` (unknown email: no doc, no notification, and no email sending exists anywhere in `functions/src`; verified: `notifications.ts` writes the inbox and Expo push only).
- Defect: the sender is told the friend will be notified; a friend without an account under that exact email receives nothing, and no invitation path exists.
- Failure scenario: fan transfers to a friend who has never installed GateKeep, tells them "check your phone", nothing arrives, the offer expires silently after 24 h.
- Recommended action: copy: "They need a GateKeep account under this exact email. If they have one, they'll get a notification to accept within 24 hours." Longer term (SP7): email invites, or a claim link.

### 10. Ticket notifications do not deep-link on either client

- Severity: Medium. Category: ux. Owner: fix-now.
- Evidence: `apps/web/app/dashboard/page.tsx:194` (`href` only for `kind === "booking"`), `apps/mobile/src/shell/NotificationsList.tsx:37-38` (same), `functions/src/ticketing.ts:282-285,1132-1135,1245-1248` (every ticket notification sets `kind: "ticket", refId: eventId`), `apps/mobile/src/notifications/push.ts` (registers tokens only; no `addNotificationResponseReceivedListener`, so a push tap never navigates for any kind, pre-existing).
- Defect: "You've been offered a ticket", "Tickets confirmed", "Event tomorrow", and "Event cancelled" are dead rows.
- Failure scenario: recipient taps the offer notification, lands on the inbox, and has to know to open the Tickets tab where "Incoming offers" lives.
- Recommended action: map `kind === "ticket"` to `/tickets` on web and `/(fan)/tickets` on mobile (a transfer offer and a purchase both live there); for a cancelled event the same target is right. Push tap handling is a separate, pre-existing gap worth a line in the launch checklist.

### 11. Cancelled events vanish for the fans who held tickets to them

- Severity: Medium. Category: ux / spec-drift. Owner: fix-now.
- Evidence: `firestore.rules:258-259` (public read is `published` or `completed` only), `apps/web/app/tickets/TicketsClient.tsx:116-133` and `apps/mobile/src/tickets/TicketList.tsx:205-222` (the "Cancelled" card renders `tierName` only; the ticket doc carries no event title), `functions/src/ticketing.ts:494-497` (cancellation notification `refId` is the eventId), `apps/web/app/e/[eventId]/page.tsx:124-125` (permission-denied renders not-found: "No event at that link").
- Defect: after a cancel, the fan's wallet shows a card that cannot name the show, and the notification's event links to a 404.
- Failure scenario: a fan holding tickets to two shows gets "Event cancelled" and sees a "Cancelled: VIP" card with no title; they cannot tell which show it was without the notification body.
- Recommended action: either add `cancelled` to the public-read disjunct (the doc holds nothing sensitive that `published` did not already expose, and a public "This event was cancelled" page is what a shared link should show), or snapshot `eventTitle` onto `TicketDoc` at mint (`ticketing.ts:243-246`) and transfer (`ticketing.ts:1212-1216`). The first is one rules line plus a `not-found` branch; ruling 11 already widened `completed` for the same reason.

### 12. Check-in has no undo and no time gate

- Severity: Medium. Category: missing-feature. Owner: fix-now.
- Evidence: `functions/src/ticketing.ts:998-1003` ("no time-of-day gate here at all"), `ticketing.ts:1025-1033` (`checked_in` is terminal), `apps/mobile/src/events/AttendeeListScreen.tsx:59-109` (tap any row, confirm, done), `functions/src/index.ts:29-32` (no undo callable).
- Defect: a wrong tap on the name list permanently marks someone in, days before the show if the curator is browsing the list early.
- Failure scenario: two attendees named "Sam"; the staffer taps the wrong one. The real Sam's QR now reads "Already checked in at 7:02 PM" at the door, and the only fix is to wave them through outside the system.
- Recommended action: `undoCheckIn` (curator member, `checked_in -> valid`, clears `checkedInAt` on both docs), and refuse check-in more than N hours before `startsAt` (a constant in `eventsCore.ts`). Both are small and test-shaped like `checkInTicket`.

### 13. Curators cannot see whether ticket revenue settled

- Severity: Medium. Category: missing-feature. Owner: 5c.
- Evidence: `firestore.rules:226` (ledger is admin-only), `apps/web/app/dashboard/earnings` and `apps/mobile/src/payments` (no reference to `ticket` or `ticket_settlement`; verified by grep), `apps/mobile/src/events/TierEditor.tsx:225-235` ("Total sold" = `soldCount * priceCents`, which includes unpaid pending holds and no fees), `functions/src/paymentsSweep.ts:1428-1456` (blocked settlement produces an admin alert and a daily nudge notification only).
- Defect: the only curator-visible signal for "your money moved" is the Stripe transfer landing in their Express balance; "blocked because you have no payout account" is a notification, not a state on the event.
- Failure scenario: the show ends, T+1 passes, the curator checks Events and sees "Completed" with "Total sold: $1,250" and no idea whether, when, or how much was paid out (net of refunds it may be less).
- Recommended action: expose `settlementStartedAt`, `completedAt`, and a computed net (sum over paid orders of `faceTotalCents - refundedFaceCents`, readable by curator members via the orders rule) on the event management screen; add a ticket row to the earnings page when 5c touches payouts.

### 14. T+1 settlement draws on the platform's AVAILABLE balance and wedges on failure

- Severity: Medium. Category: bug (ops). Owner: launch-checklist + 5c.
- Evidence: `functions/src/stripeClient.ts:858-866` (`transfers.create` with `source_transaction` only when `sourceChargeId` is given), `functions/src/paymentsSweep.ts:1461-1467` (ticket settlement passes no `sourceChargeId`; one transfer per event sums many charges), `paymentsSweep.ts:1458-1459,1468-1488` (`settlementStartedAt` is stamped before the call; a thrown transfer leaves it set, so `cancelEventCore` at `events.ts:468-471` refuses forever and every hourly pass replays the same idempotency key).
- Defect: card charges take about two business days to become available; an event whose sales cluster in the final 48 hours can owe more at T+1 than the platform has available, and Stripe answers `balance_insufficient`. Stripe caches the failed result under the same idempotency key for up to 24 h, so the hourly retry replays the failure.
- Failure scenario: a Saturday show sells 200 tickets on Friday and Saturday; Sunday's sweep fails, alerts, and the event is wedged (cannot be cancelled, cannot settle) until Monday or Tuesday; the curator gets no explanation.
- Recommended action: launch-checklist: decide on a platform float, or (5c) switch ticket settlement to one transfer per paid order with `source_transaction: latest_charge` (draws on pending funds; `TicketOrderDoc` would need `chargeId` stamped at completion). Also: a `balance_insufficient` failure should not set `settlementStartedAt` permanently; consider stamping it only after a successful transfer or storing the failure so cancel is allowed again. FakeStripe models no balance, so no emulator test can catch this; note it in `sp5-rulings`' Stripe go-live section.

### 15. Free inventory holds are a scalper and griefing vector

- Severity: Medium. Category: security. Owner: SP7 / launch-checklist.
- Evidence: `functions/src/ticketing.ts:58-172` (any verified account can open a pending order up to `maxTicketsPerBuyer` per event with no payment method attached and no rate limit), `eventsCore.ts:22`, `paymentsSweep.ts:1632` (10 to 70 min hold, then repeatable).
- Defect: holding seats costs nothing and never fails.
- Failure scenario: a script with a handful of verified accounts re-creates 8-ticket pending orders for a hot show every hour; the tier reads "Sold out" to real fans for the entire sale window while nobody pays.
- Recommended action: the shorter expiry in finding 2 reduces the window; add a per-uid limit on concurrent pending orders across events and an `adminAlert` when one account cycles holds; longer term (SP8/later), require a payment method on file before reserving more than a small quantity.

### 16. Poster upload not wired: no images anywhere, no OG preview

- Severity: Medium. Category: missing-feature (accepted exception, assessed). Owner: SP7.
- Evidence: `functions/src/media.ts:360-368` (processed poster path is never written anywhere a client can read), `apps/web/app/e/[eventId]/page.tsx:143` (OG image only when `posterUrl`), `apps/web/src/events/EventEditor.tsx:476-486` (no poster field on either form).
- Assessment: not launch-blocking for ticketing mechanics. It IS blocking for SP7: a discovery feed of text-only cards and share links with no preview image will underperform on day one. Recommend SP7 owns the small functions change (write `public/photos/.../poster-{nonce}.jpg` to a `posterUploads/{uid}/{nonce}` doc the client watches, or a callable that returns the processed path) before building cards.

### 17. Exact sales counts are public

- Severity: Low. Category: security (privacy). Owner: SP7.
- Evidence: `firestore.rules:262-268` (tiers are public-read for published and completed events), `packages/shared/src/types.ts:937-942` (`soldCount`, `capacity` on the tier doc), `apps/web/app/e/[eventId]/page.tsx:104-110` (both are shipped to the browser).
- Defect: anyone, including competitors and the press, can read a venue's exact ticket sales per tier, forever (completed events included).
- Recommended action: SP7 will want sold-out and "selling fast" signals; consider a server-maintained public projection (remaining bucket or a boolean) and moving raw counts to a member-only read. Not urgent for launch metro scale.

### 18. Web fan landing and empty states point at musician surfaces

- Severity: Medium. Category: ux. Owner: SP7.
- Evidence: `apps/web/app/sign-in/SignInForm.tsx:77` (`redirectTo = next ?? "/dashboard"`), `apps/web/app/dashboard/page.tsx:86-92` ("No profiles yet" with "Create a profile"), `apps/web/app/tickets/TicketsClient.tsx:224` ("Browse what's playing" links to `/gigs`), `apps/web/app/e/[eventId]/not-found.tsx:19` ("Browse gigs"), `apps/web/src/components/GigCard.tsx:31-35` (`/gigs` cards show budget ranges and are the musician job board).
- Defect: a fan who signs in from the header (no `next`) lands on a page that asks them to create a musician or curator profile; a fan with no tickets is sent to a page of gig budgets.
- Recommended action: SP7 gives fans a home (`/events` feed) and makes `/dashboard` route profile-less accounts there; until then, point both empty states at `/tickets` or a venue page rather than `/gigs`.

### 19. Rescheduling a published event re-notifies nobody and never re-arms the reminder

- Severity: Medium. Category: missing-feature (accepted exception, partially re-raised). Owner: fix-now (one line) + SP7 (notification).
- Evidence: `functions/src/events.ts:300-306` (`updateEvent` writes `startsAt` with no diff against the prior value), `scheduled.ts:921` (`reminderSentAt` gates the reminder forever once set).
- Defect: a fan who bought for Friday 8 PM gets no message when it moves to Saturday, and if the reminder had already fired for the old date, none fires for the new one.
- Recommended action: in `updateEvent`, when `startsAt` changes on a published event, clear `reminderSentAt` (trivial) and notify current attendee owners (same recipient derivation as the reminder step). The accepted exception is fine for a draft; for a published event with sold tickets it is a fan-facing miss.

### 20. Event model and pages lack what a fan expects from an event page

- Severity: Medium. Category: missing-feature. Owner: SP7.
- Evidence: `packages/shared/src/types.ts:904-936` (no `doorsAt`, no age restriction, no genre/tags, no `city` beyond `location.city`), `apps/web/app/e/[eventId]/EventPageClient.tsx` and `apps/mobile/app/event/[eventId].tsx` (no share button, no add-to-calendar, no "get directions" until a ticket is held, no "from $X" summary), `apps/web/app/e/[eventId]/page.tsx:131-146` (no JSON-LD `Event` schema, no `siteName`).
- Defect: the page is a competent ticket picker but not a shareable, indexable event listing.
- Recommended action: SP7 adds `doorsAt`, `ageRestriction` ("all_ages" | "18" | "21"), tags, and a share sheet (Web Share API / RN `Share`) plus `.ics`; SP8 adds JSON-LD and a sitemap for `/e/*`.

### 21. Door list names default to the email local part

- Severity: Low. Category: ux (privacy). Owner: SP7.
- Evidence: `functions/src/authTriggers.ts:8` (`displayName = user.displayName ?? user.email?.split("@")[0]`), `functions/src/ticketing.ts:235,248-251` (`ownerName` snapshot at mint; "Guest" only if the field is missing), `firestore.rules:288-293` (attendees readable by every curator member).
- Defect: a fan who signed up by email and never set a name appears to venue staff as `john.doe94`, which is most of their email; the snapshot also never updates after a name change.
- Recommended action: SP7's fan onboarding should ask for the name that goes on the ticket at first purchase; consider re-reading `displayName` at check-in time rather than trusting the mint-time snapshot.

### 22. Curator date inputs are interpreted in the device zone, displayed in the launch zone

- Severity: Low. Category: bug. Owner: launch-checklist.
- Evidence: `apps/web/src/events/EventEditor.tsx:76-85` (`datetime-local` parsed with `new Date(value)`, device zone), `EventEditor.tsx:267-271` (tier sale windows, same), `apps/web/src/events/eventDisplay.ts:93-97` (rendered in `LAUNCH_TIMEZONE`).
- Defect: a curator on a laptop set to another zone (or travelling) enters 8:00 PM and the page shows a different wall time. Pre-existing pattern from gigs, now fan-facing through tickets and reminders.
- Recommended action: record in the launch checklist beside the existing `LAUNCH_TIMEZONE` item; fix by formatting the input value with the launch zone offset.

### 23. Small a11y and copy items

- Severity: Low. Category: ux. Owner: fix-now.
- Evidence: `apps/mobile/src/tickets/TicketDetail.tsx:68` (`QRCode` has no `accessibilityLabel`; web's canvas at `apps/web/app/tickets/TicketQr.tsx:56` does), `apps/mobile/app/event/[eventId].tsx:533` and `apps/web/src/events/BuyTicketsFlow.tsx:384` ("Buy tickets" and "Order total: $0" for a free RSVP tier), `apps/mobile/src/events/ScannerScreen.tsx:126-133` (see finding 3 on auto-dismiss), `apps/web/src/events/AttendeeList.tsx:61` (`window.confirm` for a money action; the SP2 follow-ups already flag this pattern).
- Recommended action: wrap the mobile QR in a `View` with `accessibilityLabel="Ticket QR code"`; label the CTA "RSVP" and hide the $0 total when every selected tier is free.

### 24. SEO surface for events is minimal

- Severity: Low. Category: missing-feature. Owner: SP8.
- Evidence: `apps/web/app/e/[eventId]/page.tsx:131-146` (title, description, canonical, OG without image), `apps/web/app/layout.tsx:54-62` (`metadataBase` only when the site URL env is set, so OG `url` and `canonical` are relative until then), no `sitemap.ts` for `/e` (the SP2 follow-ups note the same for `/u`).
- Recommended action: SP8: JSON-LD `Event` with `offers` (price, availability), a sitemap of published events, and the poster as OG image once finding 16 lands; launch-checklist: set the site URL env before launch.

### 25. Curator content editing is web-only and standalone events cannot link acts to artists

- Severity: Low. Category: missing-feature. Owner: SP7.
- Evidence: `apps/mobile/app/(curator)/events/event/[eventId].tsx:20-28` (title/description/dates/lineup editing "stays web-edit-only for now"), `apps/web/src/events/EventEditor.tsx:32-42` (the lineup editor adds `external` acts only; a `booking` act only ever arrives via "promote a filled gig"), `functions/src/events.ts:127-156` (a booking act must be a confirmed booking, so hand-linking to an artist without a booking is impossible by design).
- Implication for SP7: the artist page's "Upcoming events" (`apps/web/app/u/[handle]/page.tsx:249-269`) only ever populates through promoted gigs. Most standalone events will never surface on any artist page. SP7 should decide whether a curator may tag an artist profile without a booking (a claim the artist can accept), because artist-driven discovery depends on it.

### 26. Test gaps worth closing

- Severity: Low. Category: test-gap. Owner: fix-now.
- Not covered (verified against the `it(` titles in `functions/test/*.test.ts` and `tests-rules/events.rules.test.ts`):
  - `createTicketOrder` when `createIntent` throws after the reservation commits (order left pending with `paymentIntentId: null`, sweep must release it: `ticketing.ts:165-171`, `paymentsSweep.ts:1227,1257-1269`).
  - The sweep's deferred branch when the intent already succeeded (finding 5).
  - `finalizeTicketOrder` returning `pending` for a non-succeeded intent (`ticketing.ts:208-213`).
  - `updateEvent` on a published event (date change, `maxTicketsPerBuyer` change, lineup change after sales).
  - `refundTicket` on a free ticket (`amountCents === 0` skips Stripe: `ticketing.ts:766`).
  - `settleOneEvent`'s Stripe-throws path (`ticket_settlement_failed` alert and the wedge: `paymentsSweep.ts:1468-1488`).
  - Reminder body/date formatting (finding 4).
  - Rules: no list-provability pins for the three shipped `events` queries (`curatorProfileId == X` member list, `status == published` + `curatorProfileId`, `lineupMusicianProfileIds array-contains` + `status == published`) nor for the `events/{id}/tiers` list an anonymous reader runs; every other SP6 collection has one (`tests-rules/events.rules.test.ts:308,426`).
  - Multi-line-item orders (two tiers in one `createTicketOrder`) through refund and cancel.

### 27. Edit lock after start gives a misleading error

- Severity: Low. Category: ux. Owner: fix-now.
- Evidence: `functions/src/eventsCore.ts:94-96` (any `updateEvent` after `startsAt` fails with "Start time must be in the future." because the form resends the stored `startsAt`), `apps/web/src/events/EventEditor.tsx:568,590-595` (the form still renders as editable for a started published event).
- Recommended action: gate the edit form client-side on `startsAt > now` with a "This event has started and can no longer be edited" line (the same copy the completed state uses), or split `validateEventInput`'s future check out of the update path for unchanged dates.

### 28. Money notes for the go-live checklist (no code defect)

- Severity: Low. Category: docs. Owner: launch-checklist.
- Cancellation refunds return the fan's service fee from platform funds and Stripe keeps its processing fee on every refunded charge (`ticketing.ts:398-404`); a large cancel costs the platform roughly 3% of gross plus 30c per order. Post-settlement chargebacks land on the platform: nothing reverses a `ticket_settlement` transfer (`transfer.reversed` handling exists only for booking earnings). Both are by spec; they belong in `sp5-rulings`' go-live section so the float decision in finding 14 is made with them in view.

### 29. Verified for the record (no finding)

- Checkout saga: inventory and cap are one transaction (`ticketing.ts:105-153`); price and fee are snapshotted per order (`ticketing.ts:140-151`); free orders complete inline and never touch Stripe (`ticketing.ts:160-163`); `finalizeTicketOrder` verifies with Stripe, never trusts the client (`ticketing.ts:208-213`); webhook and finalize converge on one idempotent transaction (`ticketing.ts:222-264`); double-submit is guarded on both clients (`BuyTicketsFlow.tsx:253,380-388`, `event/[eventId].tsx:335,531`); every Stripe call carries a deterministic idempotency key (`tickets:{orderId}`, `ticket_cancel_refund:{orderId}`, `ticket_grace_refund:{ticketId}`, `ticket_settlement:{eventId}`), and none runs inside a Firestore transaction.
- Money truth: ticket charges land on the platform account; curator receives 100% of face value T+1 via one transfer per event; cancel refunds `face + fee - already refunded` per order; grace refunds `unitPrice + fee` per ticket and re-release inventory; transfers move no money and refunds always go to the order's buyer; `settlementStartedAt` CAS closes the cancel-vs-settle double spend.
- QR and door: 32 random bytes hex (`eventsCore.ts:54-56`); rotated on transfer with the old attendee doc deleted so an old QR resolves to nothing (`ticketing.ts:1222-1227`); secret compared before status so a wrong secret cannot fish for "already used" (`ticketing.ts:1022-1033`); `override` is strict boolean (`ticketing.ts:1017-1024`); the scanner decode race is closed with a ref lock (`ScannerScreen.tsx:120,139-141`); duplicate scan carries the original time in `details`.
- Rules: every SP6 collection is server-write only; `qrSecret` is owner-read only (admin cannot read tickets); attendees expose `ownerName`/`ownerUid` to curator members only; orders expose buyer and amounts to the buyer, the curator side, and admin; the address gate is `exists(users/{me}/ticketIndex/{eventId})`, which the server deletes at zero so a refunded ticket loses the address; all shipped client list queries are provable (buyer/from/to uid pins, `curatorProfileId` member pin, `status == published` equality, path-pinned subcollections).
- Em dashes: none in any SP6-authored file in scope (byte-safe sweep). The three in `paymentsSweep.ts:1580-1629` and the one in `scheduled.ts:45` are pre-existing SP3/SP5 comments outside the SP6 steps.

---

## B. Accepted exceptions (sp6-rulings): status and assessment

| Exception | Where it bites | Launch-blocking for fans? | Assessment | Owner |
|---|---|---|---|---|
| Poster upload not wired | Every event card and page text-only; no OG image | No for ticketing; yes for a discovery feed | Ship SP7 with the small functions change first (finding 16) | SP7 |
| Gig re-promotion client-only | Two events for one gig, both on the venue and artist pages | No | Curator-own mess, cancellable; add a server uniqueness check when convenient | SP7 (low) |
| `/tickets` unpaginated | A fan with hundreds of tickets | No | Fine for launch metro scale | SP8 (later) |
| Duplicate fan tab listeners | Home and Tickets both subscribe to `users/{uid}/tickets` | No | Cost only; consolidate into a provider when Discover lands | SP7 |
| Pending orders hold inventory ~70 min, no buyer cancel | Fan dismisses the sheet, cannot rebuy the last seats; griefing (findings 2, 15) | Yes, for near-capacity shows | Acceptance is wrong for a fan-facing launch: add `cancelTicketOrder` and a faster expiry schedule | fix-now |
| Grace-vs-cancel remainder delayed up to ~24 h | Buyer gets the last slice of a refund a day late | No | Self-healing and alerted; fine | none |
| Two-hop transfer chains under a raced refund escalate | Alert plus throw, manual reconciliation | No | Correct posture (never silent with money moved) | none |
| Rescheduled event does not re-notify or re-arm the reminder | Fans holding tickets learn nothing; no reminder for the new date | Borderline | Clear `reminderSentAt` now (one line); notify holders in SP7 (finding 19) | fix-now + SP7 |
| Cancelled-ticket copy neutral | "refunded to the original purchaser" | No | Correct; the real gap is the missing title (finding 11) | fix-now |
| En dashes in ranges | Time and price ranges | No | Parity glyph, keep | none |

---

## C. Fan experience today, per platform

### Web

- Finding an event: only three routes lead to `/e/[eventId]`: the venue page's "Upcoming events" (`apps/web/app/u/[handle]/CuratorProfile.tsx:317-326`, query at `page.tsx:277-293`), the artist page's "Upcoming events" (`MusicianProfile.tsx:206-218`, query at `page.tsx:249-269`, populated only by promoted-gig lineups per finding 25), and a shared link. There is no events index route (the `apps/web/app` tree is `admin dashboard design e gigs join privacy sign-in terms tickets u`), no feed on the landing page, and no search. A fan must already know a venue or artist handle.
- Signing in: `/sign-in` supports email+password create/sign in with verification email, Google, and Apple (`SignInForm.tsx:6-7,85-86,99`). The Buy button on an event page redirects to `/sign-in?next=/e/{id}` and returns there (`BuyTicketsFlow.tsx:255`, `sign-in/page.tsx:11-19`). Email accounts must verify before `createTicketOrder` succeeds (`guards.ts:13-17`); the error surfaces verbatim in the buy flow with no resend affordance on that page.
- After sign-in without `next`: `/dashboard`, which for a profile-less account shows "No profiles yet / Create a profile" (finding 18). The shell nav does include "Tickets" for every context (`AppShell.tsx:101-122`), so `/tickets` is one click away once inside the shell.
- Buying: multi-tier quantity cart, per-tier fee line, sticky "Buy tickets" with order total, Elements PaymentElement inline, "You're in" with a link to `/tickets`. Free tiers complete without Stripe. Sold-out and sale-window badges are display-only and refetched after a server rejection.
- Wallet: `/tickets` is signed-in only, live-updating, sections Upcoming / Past / Cancelled, QR inline per live ticket, address block only for ticket holders, "manage transfers in the GateKeep app" hint. No transfer send or accept on web.
- Empty states: "Browse what's playing" and the event 404's "Browse gigs" both go to `/gigs`, the musician job board with budget ranges (finding 18).
- Notifications: inbox rows on `/dashboard`, no link for ticket kinds (finding 10). No email of any kind.

### Mobile

- Entry: the root redirects to the `(fan)` tab group for every account (`app/index.tsx:3`); tabs are Discover, Tickets, Search, Account (`(fan)/_layout.tsx`). Sign-in supports email+password, Google, and Apple (`(auth)/sign-in.tsx`); sign-up sends a verification email (`(auth)/sign-up.tsx:19`).
- Discover (`(fan)/index.tsx`): "Your upcoming shows" (only events the fan already holds a live ticket for) above a "Discover shows / Live music near you, coming soon" placeholder. Search (`(fan)/search.tsx`): "Find artists and venues, coming soon."
- Finding an event: there is no path (finding 1). No venue page exists on mobile; the artist page (`app/artist/[handle].tsx`) lists gig-based Shows with no event link; the event screen (`app/event/[eventId].tsx`) is reachable only from Home/Tickets rows, which require a ticket already, or from a `gatekeep://event/{id}` custom-scheme URL that nothing in the product generates. Web `/e/` links open in the browser (no universal links).
- Buying (once on the screen): single-tier radio cards, quantity stepper, order total, native PaymentSheet, "You're in" with a button to the Tickets tab. Keyless dev builds stop at the sheet.
- Wallet (`src/tickets/TicketList.tsx`): "Incoming offers" with Accept/Decline, Upcoming / Past / Cancelled rows, a detail sheet with a full-size QR, address for holders, and "Transfer this ticket" by email (mobile-only, 24 h, no outgoing view, no sender cancel).
- Notifications: inbox list with no link for ticket kinds; push taps do not navigate (finding 10).

### Curator side, for completeness

- Create standalone or promote a filled gig, tiers, publish, cancel with a reason, attendee list with refunds on both platforms; content editing web-only; door scanner and tap-to-check-in mobile-only; no settlement state anywhere (finding 13).

---

## D. What SP7 (fan discovery) and SP8 (search) must know from this area

### Data and rules you can build on today

- `events` public read is `status in ['published', 'completed']` plus members and admin (`firestore.rules:254-260`). A feed query `where('status','==','published').orderBy('startsAt')` is rules-provable and already has its composite index (`firestore.indexes.json:189-193`). A per-venue feed (`curatorProfileId` + `status` + `startsAt`) and a per-artist feed (`lineupMusicianProfileIds array-contains` + `status` + `startsAt`) are also indexed (`:194-205`).
- `events/{id}/tiers` are public-read whenever the parent is published or completed; `soldCount`/`capacity`/`priceCents` are all client-readable, so "from $X", "sold out", and "selling fast" can be computed client-side today (but see finding 17 on exposing raw counts, and note ISR caches the SSR copy for 60 s at `apps/web/app/e/[eventId]/page.tsx:17`).
- `EventDoc.location` is `GigPublicLocation` (`types.ts:249-254`): `city` always, `neighborhood` and coarsened `geo` for non-public addresses, exact `address` and `venueName` only when `addressVisibility == 'public'`. Geo queries need a geohash field SP7 must add server-side (only `createEvent`/`updateEvent` write events, `events.ts:185-308`; `updateEvent` cannot change location).
- Event identity for cards: `title`, `description`, `startsAt`, `endsAt`, `lineup[].name`, `curatorProfileId` (join to `profiles` for name/handle, public when approved), `posterPath` (always null until finding 16 lands). No `doorsAt`, no age restriction, no tags, no denormalized price, no `city`-level filter beyond `location.city`.
- The ticket-holder proof is `users/{uid}/ticketIndex/{eventId}` (owner-read only, server-maintained, deleted at zero). Discovery surfaces that want "you're going" badges can `getDoc` it per event; there is no "all events I hold tickets to" index other than listing `users/{uid}/tickets` (what Home already does).
- Notification kind `"ticket"` with `refId = eventId` exists for purchase, cancel, refund, offer, accept, decline, reminder (`ticketing.ts`, `scheduled.ts:931`). Nothing routes on it yet (finding 10).

### Gaps SP7 must own or route

1. The mobile entry problem (finding 1): feed, venue page, artist upcoming events, universal links.
2. Posters (finding 16) before any card grid ships.
3. Fan onboarding: a name that goes on the ticket (finding 21), a fan landing on web (finding 18), and a resend-verification affordance where `requireVerifiedEmail` bites the buy flow.
4. Artist linkage for standalone events (finding 25): decide whether curators can tag artists without a booking; otherwise artist-page discovery only sees promoted gigs.
5. Share and calendar (finding 20), cancelled-event pages (finding 11), ticket notification deep links (finding 10).
6. Product decisions that affect feed copy: sales stop at `startsAt` (`ticketing.ts:83-85`) so there are no door sales through the app; transfers close at `startsAt` too; a tier can be "not yet on sale" with a future window.

### What SP8 (search) must know

- No text index exists on events: `title`, `description`, and `lineup[].name` are raw strings with no lowercased or tokenized companions (users have `displayNameLower`; events do not). Adding `titleLower`/`searchTerms` is a server-side change in `createEvent`/`updateEvent` only.
- Handles resolve to profiles, not people (`handles/{handle}` is `get`-only, never listable: `firestore.rules:358`), so an "@handle" search must go through profiles, and profile listing rules are `approved` or member.
- SEO for `/e/*` is title/description/canonical only (finding 24); `metadataBase` depends on an env var; no sitemap; no JSON-LD. Completed events stay indexable forever (ruling 11), which is good for artist history and bad without a "this event has happened" signal in metadata.
- Public `soldCount` (finding 17) makes "popular" ranking trivial but leaks business data; decide the projection before ranking on it.

---

## E. Suggested order of operations before the SP7 brainstorm

1. fix-now cluster (small, test-shaped, all in files SP6 already owns): findings 2 (cancel callable + 5-minute expiry), 3 (scanner transport errors), 4 (reminder timezone), 5 (sweep completes captured orders), 6 (uniform transfer docs), 7 (checkout copy + `receipt_email`), 9, 10, 11, 12, 19 (one line), 23, 27, 26 (tests).
2. launch-checklist entries: findings 14 (platform float or per-order transfers), 22, 24 (site URL), 28.
3. SP7 inputs: section C and D verbatim, plus findings 1, 8, 15, 16, 17, 18, 20, 21, 25.
4. 5c: findings 13 and 14's per-order `source_transaction` variant.

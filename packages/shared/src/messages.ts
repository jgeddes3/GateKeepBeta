// SP5 payments — USER-FACING error/gate copy the WEB CLIENT needs to key on
// (pattern-match an exact HttpsError message to branch UI behavior, or mirror
// server-side copy client-side so the two can never drift — e.g. a disabled
// button's tooltip). Moved here (review round 1, fix-round before Task 15)
// from their original homes in functions/src so `apps/web` can import the
// exact same strings instead of hand-copying them.
//
// Every constant below is RE-EXPORTED from its original functions/src module
// (paymentsCore.ts / payments.ts / paymentsPayouts.ts) so every existing
// in-repo import — those files' own local usages, bookings.ts, gigSeries.ts,
// and the functions/test/* suite — keeps working unchanged; this file is the
// single source of truth for the STRING, not a copy of it.
//
// NOT everything named `*_MESSAGE` in functions/src lives here — only what a
// planned or existing client interaction keys on. Left in functions/src (see
// the SP5 Task 14 fix-round report for the full accounting): admin-only
// operator copy (releaseStuckSaga's SAGA_* messages — "internal/admin-only
// ones stay put"), payout errors the Earnings page only ever displays
// verbatim (PAYOUT_SETUP_REQUIRED_MESSAGE / PAYOUT_OVER_BALANCE_MESSAGE /
// PAYOUT_AMOUNT_TOO_SMALL_MESSAGE / PAYOUT_REQUEST_ID_REUSED_MESSAGE),
// BOOKING_LOCKED_BY_DEPOSIT_MESSAGE (payments-related but not yet keyed on by
// any client branch), and messages entirely outside SP5 payments
// (bookingLifecycle.ts's cancellation messages, gigs.ts's geocode-failure
// message).

// ---------- Task 5 booking gates (originally paymentsCore.ts) ----------
// The web UI keys its two inline prompts off these exact strings (Task 15:
// catch CURATOR_CARD_REQUIRED_MESSAGE -> open SaveCardModal inline; catch
// MUSICIAN_PAYOUTS_REQUIRED_MESSAGE -> "Finish payout setup" panel linking to
// /dashboard/earnings; catch the delinquency message -> link to the past-due
// booking).
export const CURATOR_CARD_REQUIRED_MESSAGE = "Save a payment card before sending offers or booking musicians.";
export const CURATOR_DELINQUENT_MESSAGE = "This profile has an overdue payment — settle it before booking again.";
export const MUSICIAN_PAYOUTS_REQUIRED_MESSAGE = "Finish payout setup before applying to or accepting bookings.";
// acceptBooking can be called by EITHER side (either direction lands the
// deposit charge on the curator's card), so a musician-side caller who trips
// the curator gate must never see the curator-authored messages above; both
// curator-gate failure kinds collapse to this one neutral message for a
// musician-side caller instead.
export const BOOKING_NOT_CONFIRMABLE_MESSAGE =
  "This booking can't be confirmed right now — the other side needs to update its payment details.";

// ---------- Task 6 accept-saga outcomes (originally paymentsCore.ts) -------
// DECLINED: definite failure — the staged payment docs are deleted and the
// booking is left `open`, so a retry (after fixing the card) is a clean,
// fresh attempt.
export const CARD_DECLINED_MESSAGE = "Your card was declined — update your payment method and try again.";
// PROCESSING: NOT a failure — the PaymentIntent exists and is still settling;
// the payment_intent.succeeded webhook completes the accept out-of-band.
export const DEPOSIT_PROCESSING_MESSAGE =
  "Your payment is processing — the booking will confirm automatically once it completes.";
// The narrow crash window: depositChargePending is set but no intent id was
// ever recorded. Whether money moved is UNKNOWN here, so accept refuses
// rather than re-staging + re-charging; the hourly sweep reconciles it.
export const DEPOSIT_RECONCILING_MESSAGE =
  "This booking's payment is still being processed — try again in a few minutes.";
// The charge landed but the accept could not be committed (the gig/series
// moved underneath it), and the refund SUCCEEDED. Told to the caller in place
// of the raw abort reason so they aren't left wondering whether they were
// charged for a booking that never happened.
export const ACCEPT_ABORTED_REFUNDED_MESSAGE =
  "The booking could not be confirmed — your deposit charge has been refunded.";

// ---------- Task 13 payouts (originally paymentsPayouts.ts) ----------------
// The Earnings page's Instant button re-derives its own disabled state
// client-side (an eligibility flag off getStripeStatus) and shows this SAME
// string as the button's tooltip — the two must never drift apart.
export const PAYOUT_INSTANT_INELIGIBLE_MESSAGE =
  "Instant payouts need an eligible debit card on your Stripe account.";

// ---------- Task 11 payPastDue (originally payments.ts) --------------------
// Five different situations with five different fixes — Task 15's
// PayPastDueButton keys UI off the specific one that fired rather than a
// generic error banner.
export const PAY_PAST_DUE_NOT_OVERDUE_MESSAGE =
  "There's nothing overdue on this date — it's already settled, or its payment hasn't been attempted yet.";
export const PAY_PAST_DUE_NOTHING_OWED_MESSAGE =
  "This date's balance is already covered — nothing left to pay.";
export const PAY_PAST_DUE_NO_CUSTOMER_MESSAGE =
  "This profile has no payment account yet — save a card first, then try again.";
export const PAY_PAST_DUE_PAYMENT_IN_FLIGHT_MESSAGE =
  "A payment for this date is already being processed — check back in a few minutes.";
export const PAY_PAST_DUE_RACED_MESSAGE =
  "This booking changed while we were setting up the payment — try again.";
export const PAY_PAST_DUE_DATE_CANCELLED_MESSAGE =
  "That date was just cancelled — the charge will be reconciled.";

// ---------- Task 10 true-ups (originally payments.ts) -----------------------
// TrueUpForm's client-side validation hint mirrors these so a curator sees
// the same wording live (before the round trip) as confirmOccurrenceActuals
// would throw.
export const TRUE_UP_SHAPE_MESSAGE =
  "Report extra minutes and/or extra songs as positive whole numbers.";
// The caps bound the settlement base (spec §4), so the limit is part of the
// message: a curator who over-reports needs the number, not a restatement of
// the rule they just broke.
export const trueUpOverCapMessage = (unit: "minutes" | "songs", limit: number): string =>
  `Report at most ${limit} extra ${unit} for one date — contact support if a date really ran longer than that.`;
// The settlement window closed for good: this date is paid, waived, or has
// not been performed yet. Nothing the curator does re-opens it.
export const TRUE_UP_WINDOW_CLOSED_MESSAGE =
  "Actuals can only be reported during the settlement window for a date that's already been played.";
// A charge EXISTS for this date (one left processing, or one that succeeded
// against a doc a racer moved). Reporting more now would settle the doc for
// an amount that was never charged.
export const TRUE_UP_PAYMENT_STARTED_MESSAGE =
  "A payment for this date has already started — actuals can no longer be changed.";
// A charge is IN FLIGHT this second. Unlike the two above this one is
// genuinely transient, so the copy invites a retry.
export const TRUE_UP_CHARGE_IN_FLIGHT_MESSAGE =
  "This date is being charged right now — try reporting actuals again in a few minutes.";

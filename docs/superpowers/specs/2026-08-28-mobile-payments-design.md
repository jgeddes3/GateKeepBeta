# Sub-project 5b — Mobile Native Payments (design)

Date: 2026-08-28. Owner-approved scope: **full parity** — after 5b, a musician or curator never
needs the web for any payment action. Wallets (Apple Pay + Google Pay) **included** from day one,
degrading gracefully to card-only if wallet provisioning isn't finished. Backend is **unchanged**:
every flow below wires an existing SP5 callable (`docs/superpowers/sp5-rulings.md` is the
authority on their contracts). Follow-up UI work beyond payments is a separate effort, not 5b.

## 1. Approach

Native `@stripe/stripe-react-native` **PaymentSheet** for the two card-entry flows (save card,
pay past due); the **system in-app browser** for Stripe-hosted Express onboarding; plain RN forms
for callable-only actions (true-up, cash-out). Rejected: WebView-wrapping the web payment pages
(against Stripe guidance, breaks wallets, requires a deployed web origin) and deep-linking to web
(not parity).

**Parity contract (binding, same as SP5's web/mobile rule):** row-state mapping, labels, and money
previews come from `@gatekeep/shared` (`paymentRowKind`, `paymentDisplay.ts`, `messages.ts`, and
the fee helpers §5 moves there). A state must never read differently on the two platforms; the two
SP5-era "pay on the web" divergences in `PaymentStatus.tsx` are **reverted** (real buttons exist
now).

## 2. Native module & build plumbing

- `@stripe/stripe-react-native` added to `apps/mobile` with its Expo config plugin in `app.json`:
  `merchantIdentifier: "merchant.app.gatekeep.mobile"`, `enableGooglePay: true`.
- Root layout wraps the app in `<StripeProvider publishableKey={...} urlScheme="gatekeep"
  merchantIdentifier="merchant.app.gatekeep.mobile">`. Publishable key from
  `process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ""` — empty ⇒ keyless mode (§6). The key is
  public by design; the secret key must never appear in `apps/mobile` (SP5 invariant).
- A single `apps/mobile/src/payments/stripe.ts` gate module exports `stripeEnabled` (key
  non-empty) and thin wrappers over `initPaymentSheet`/`presentPaymentSheet` — the ONLY file that
  imports `@stripe/stripe-react-native`, so keyless mode and tests have one seam to mock.
- **This changes the native binary**: a new EAS dev-client build (iOS + Android) is required
  before any of this runs on a device; `expo export` alone still gates CI.

## 3. Curator surfaces

### 3a. Save card — `SaveCardSheet`

`apps/mobile/src/payments/SaveCardSheet.tsx`, the RN counterpart of web's `SaveCardModal`:

1. `createSetupIntent({ profileId })` → `{ clientSecret, customerId }`.
2. `initPaymentSheet({ setupIntentClientSecret, merchantDisplayName: "GateKeep",
   applePay: { merchantCountryCode: "US" }, googlePay: { merchantCountryCode: "US",
   testEnv: !prod } })` → `presentPaymentSheet()`.
3. On success: `refreshPaymentMethod({ profileId, setupIntentId })` — setupIntentId parsed from
   the client secret (`secret.split("_secret")[0]`, same id Stripe.js returns on web) — then the
   `onSaved` callback fires. On user-cancel: silent close, no error. On failure: the sheet's own
   error copy, plus a retry.

### 3b. Gates — `GatePrompt` (RN port)

`apps/mobile/src/payments/GatePrompt.tsx`, a faithful port of web's `GatePrompt.tsx` including
its viewer-side guards (L11): recognizes the four shared message constants verbatim —
`CURATOR_CARD_REQUIRED_MESSAGE` (curator viewer: inline `SaveCardSheet` + one retry of the
original action; other viewers: neutral notice), `CURATOR_DELINQUENT_MESSAGE` (curator viewer:
links to the delinquent booking(s) via the ported `delinquentBookings.ts` query; others: neutral
notice), `MUSICIAN_PAYOUTS_REQUIRED_MESSAGE` (musician viewer: link to the Earnings surface;
curator viewer: neutral notice), `DEPOSIT_PROCESSING_MESSAGE` (info-styled, not a failure).
Everything else falls through to the existing plain error treatment. Mounted at mobile's three
action sites: `GigBrowse.tsx` (applyToGig — always musician-viewer), `MusicianBrowse.tsx`
(offerGig — curator-viewer), `BookingThread.tsx` (acceptBooking — viewer side from `useRole`).
Navigation targets are in-app screens (§4), not web URLs.

### 3c. Pay past due + true-up — `PaymentStatus.tsx` grows actions

- The two past-due row kinds gain a **Pay now** button (curator side only): `payPastDue({
  bookingId, gigId })`; if the result carries `clientSecret` (`done: false`), run
  `initPaymentSheet({ paymentIntentClientSecret })` → present (3DS in-sheet), then re-render from
  the payment-doc snapshot (the webhook/`finalizeSettlementSuccess` writes the terminal state —
  mirror web `PayPastDueButton`'s "processing…" interim treatment and its handling of the
  `PAY_PAST_DUE_*` refusal messages). `{ done: true }` needs no sheet at all.
- A **Report actuals** action (curator side, settlement not started) opens `TrueUpSheet` — the RN
  port of web's `TrueUpForm`: bounded `extraMinutes`/`extraSongs` inputs, delta preview via the
  shared fee helpers (§5), submit `confirmOccurrenceActuals({ bookingId, gigId, extraMinutes,
  extraSongs })`, surface the `TRUE_UP_*` refusal messages verbatim.
- `DelinquencyBanner` RN port on the curator dashboard: same `getStripeStatus().delinquent` +
  `delinquentBookings` query pair web uses, linking to the affected booking screens.
- The curator-side footer line ("Cards, past-due payments and receipts are managed on the web.")
  is replaced by the card-on-file row (brand + last4 from `getStripeStatus`) with a "Replace
  card" action opening `SaveCardSheet`.

## 4. Musician surfaces

`EarningsCard` on the musician dashboard is promoted to the full `EarningsPanel` experience
(new file `apps/mobile/src/payments/EarningsPanel.tsx`; the dashboard mounts it where the card
was):

- **Onboarding** (no account / `!payoutsEnabled`): "Set up payouts" → `createOnboardingLink({
  profileId })` → open `url` with `expo-web-browser` `openBrowserAsync`. Return/refresh URLs stay
  the server-built `APP_ORIGIN` web pages — the fail-closed no-client-URLs posture is untouched;
  the return page already tells the user they can go back. On browser dismiss AND on AppState
  re-foreground, re-call `getStripeStatus` (it re-syncs gate flags from Stripe live) and
  re-render. No backend change.
- **Balances + cash-out** (`payoutsEnabled`): available + instant-available balances, amount
  input, standard/instant choice with the instant-fee preview (shared `instantFeePreviewCents`,
  §5) and the $10 instant minimum surfaced client-side; submit `requestPayout({ profileId,
  amountCents, method, requestId })` with a client-minted UUID `requestId` (same idempotency
  contract web uses); render `PAYOUT_*` refusal messages verbatim.
- **Admin gating (H2)**: `createOnboardingLink` and `requestPayout` are profile-ADMIN-only,
  enforced server-side. Mobile matches web's as-built posture exactly: no client-side role
  check (mobile's ProfileContext carries no member role, same as web's panel), the buttons
  render for any member, and a non-admin's press surfaces the server's permission refusal
  verbatim — the same friendly-wrapper idiom every callable error in this app uses.
- Musician-side `PaymentStatus` footer ("Payout setup and cash-outs are managed on the web.")
  now links to the Earnings surface in-app.

## 5. Shared-code move

Web's `apps/web/src/payments/fees.ts` (deposit-charge preview, instant-fee preview, true-up
delta preview — pure math over shared constants) moves to
`packages/shared/src/feePreviews.ts`; web imports flip, mobile imports it fresh. Same
single-sourcing rule SP5 applied to `paymentDisplay.ts`/`messages.ts` — preview math must never
fork per platform. `StripeStatusResult` (currently `apps/web/src/payments/types.ts`) moves to
`packages/shared` too, replacing mobile's hand-rolled `StripeStatusSummary` subset.

## 6. Keyless / emulator mode

`stripeEnabled === false` (no `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` — emulator dev) mirrors web's
`stripeLoader.ts` posture exactly:

- Save card: call `createSetupIntent`, **skip the sheet** — FakeStripe already marks the card
  saved server-side before the callable returns — and, as-built (mirroring web's SaveCardModal
  precedent), also skip the now-redundant `refreshPaymentMethod` round trip: call `onSaved`
  directly.
- Pay past due: call `payPastDue`; a `{ done: false, clientSecret }` result renders the same
  "finish this payment where Stripe is configured" notice web shows keyless (unreachable under
  FakeStripe, which confirms synchronously — defensive only).
- Onboarding/cash-out/true-up are callable-only and work keyless unchanged.

The full emulator loop (gates open, deposits charge, settlements pay) therefore still runs with
zero Stripe keys — the 578-test suite and rules suite are untouched.

## 7. Error handling

- Every callable error surfaces its server `message` verbatim (the shared-constants contract);
  `GatePrompt` is the interpreter at the three gate sites, plain error boxes elsewhere.
- PaymentSheet cancel ≠ error (silent). PaymentSheet failure: sheet-native message + retry.
- `getStripeStatus`'s `availableBalanceCents: null` renders "Balance unavailable", never $0.00
  (SP5 as-built rule, already respected in `EarningsCard`).
- Wallet unavailability (no Apple Pay capability / Google Pay declined init) is not an error:
  the sheet simply presents card-only.

## 8. Testing

- **CI gates unchanged**: `pnpm typecheck` (5), shared suite (+ feePreviews tests moved/extended),
  `pnpm emu:test` 578, `pnpm emu:rules` 77, web build (import-flip regression), mobile lint,
  `npx expo export --platform ios`.
- Mobile has NO unit-test runner (`"test": "echo no unit tests in mobile yet"` — repo
  convention since SP1); 5b does not add one. Logic that warrants tests lives in
  `packages/shared` (the §5 fee-preview move ships with shared tests); mobile components stay
  wiring, verified by typecheck/lint/export like every prior SP's mobile work. `stripe.ts`
  stays the single native-import seam regardless — it is what makes keyless mode one branch.
- **Device smoke (manual, real test-mode keys)** — extend README's SP5 walkthrough with a mobile
  section: save 4242, 3DS challenge 4000 0027 6000 3184 in-sheet, decline-after-save
  4000 0000 0000 0341 → dunning → Pay now, Apple Pay + Google Pay test cards, onboarding
  round-trip returning to the app, standard + instant payout, true-up preview matches the charge.

## 9. Out of scope (5b)

Sub-5c payout splits; disputes/chargebacks; statements/exports; multi-currency; live-mode
activation; any non-payments mobile UI (owner: separate follow-up); web changes beyond the §5
import flips.

## 10. Operator checklist additions (README launch checklist)

1. Apple: create merchant id `merchant.app.gatekeep.mobile` in the Apple Developer portal; add
   the Apple Pay payment-processing certificate via the Stripe dashboard (test mode first).
2. Google: enable Google Pay in the Stripe dashboard; `testEnv` stays true until live.
3. Set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS environment variable (dashboard or
   `eas env:create`; `apps/mobile/.env` for local dev-client runs) — baked at build time like
   web's publishable key. `eas.json` itself stays key-free.
4. Cut a **new EAS dev build** (both platforms) before device testing; production builds inherit
   the plugin config.
5. `APP_ORIGIN` must be set on deployed functions before device onboarding tests (the return
   pages live on web).

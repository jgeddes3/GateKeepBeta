# GateKeep Sub-project 5b (Mobile Native Payments) — Rulings & Handoff

Durable record from sub-project 5b, executed subagent-driven with per-task reviews + a final
whole-branch review on `worktree-sp5b-mobile-payments`, merged to `main` on 2026-08-28. Travels
with the repo. Mirrors `sp2-`–`sp5-rulings.md`.

Spec: `docs/superpowers/specs/2026-08-28-mobile-payments-design.md` (amended in-flight; see rulings)
Plan: `docs/superpowers/plans/2026-08-28-mobile-payments.md`
Backend: UNTOUCHED — every flow wires an SP5 callable (`sp5-rulings.md` stays the money authority).

## What shipped

Full payment parity on mobile: native PaymentSheet (cards + Apple Pay + Google Pay) for
save-card (`SaveCardSheet`) and pay-past-due (`PayPastDueButton`, 3DS in-sheet); `GatePrompt`
interpreting the shared gate-message constants at apply/offer/accept; `TrueUpForm`;
`DelinquencyBanner` (curator dashboard); full `EarningsPanel` (in-app-browser Stripe Express
onboarding + standard/instant cash-out) replacing the read-only EarningsCard; curator
card-on-file row + Pay now + Report actuals in `PaymentStatus`. All under
`apps/mobile/src/payments/`. Client fee-preview math + `StripeStatusResult` moved to
`@gatekeep/shared` (`feePreviews.ts`; web imports flipped, no forked copies remain).

## Rulings made during execution

1. **`@stripe/stripe-react-native@0.64.0` behind one seam** (`src/payments/stripe.ts`): the ONLY
   runtime import of the native module, and it is LAZY (`require` inside a function; the
   `_layout.tsx` `MaybeStripeProvider` is the one sanctioned second lazy-require site) — a dev
   client built before the module existed must not crash at JS load (expo-audio precedent).
2. **Keyless mode**: empty `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` ⇒ no provider, no sheet, no
   native call — FakeStripe already saves the card server-side in `createSetupIntent`, so the
   full emulator loop runs with zero Stripe keys (spec §6, corrected in-flight: the keyless
   save path calls `onSaved` directly; no redundant `refreshPaymentMethod`).
3. **Google Pay `testEnv` keys off the publishable key** (`!startsWith("pk_live_")`), never
   `__DEV__` — a preview build on a test key is still a test environment.
4. **Android `openBrowserAsync` asymmetry (final-review Critical, fixed)**: on Android the
   promise resolves `{type:'opened'}` at OPEN, not dismiss (iOS resolves at dismiss).
   `EarningsPanel.setupPayouts` clears its `onboardingInFlight` flag + reloads only when
   `result.type !== "opened"`; the armed flag lets the AppState `active` listener do the Android
   re-poll. **Any future in-app-browser flow (e.g. ticketing checkout) must handle this.**
5. **Accept/apply/offer money copy upgraded to SP5 reality** (final-review Important — a plan
   omission the spec's §1 parity contract overruled): mobile's accept-confirm now renders web's
   fee-inclusive "Due now" preview via shared `depositChargePreviewCents`; `depositLine` and
   `DEPOSIT_HONESTY_LINE` mirror web's post-SP5 copy byte-identically ("charged … at accept",
   not "when payments launch").
6. **No client-side admin gating on payout actions** (spec §4 amendment): mobile matches web —
   buttons render for any member; `requireProfileAdmin` refusals surface verbatim. Mobile's
   ProfileContext carries no member role; adding one for dead-button polish wasn't worth it.
7. **Payout `requestId` nonce**: RN has no `crypto.randomUUID`; the repo's timestamp+random
   base36 idiom (PortfolioForms precedent) satisfies `REQUEST_ID_RE` and reproduces web's
   one-id-per-press replay semantics exactly.
8. **No mobile test runner added** (spec §8 amendment): repo convention holds — tested logic
   lives in `packages/shared` (fee previews got 4 tests incl. the spec's $1,000 worked
   example); mobile stays wiring under typecheck/lint/export.
9. **Onboarding return URLs stay the server-built `APP_ORIGIN` web pages** — the fail-closed
   no-client-URLs posture is untouched; mobile re-syncs by re-polling `getStripeStatus`
   (which re-reads Stripe live) on browser dismiss and app re-foreground.
10. **Navigation mappings**: web `/dashboard` fallback → `/(curator)/bookings`; "Finish payout
    setup" → `/(musician)/dashboard` (the Earnings surface); booking links →
    `/booking/[bookingId]`. Inline link lists use the Text-`onPress` idiom (never
    Pressable-in-Text — RN inline-children rules; Android hit-target risk).
11. **hermesc.exe is blocked by this machine's Application Control policy** — local
    `expo export` gate = `--no-bytecode` bundling success; EAS cloud runs its own Hermes step.
    (Environment fact, not a code decision.)

## Deferred / follow-ups (sub-5b's own)

- **Mobile grace-period flash warning**: web's accept-confirm `startsSoonFlash` notice (booking
  accepted already inside the 72h/24h windows) was NOT ported — separate feature, never in 5b's
  findings. A mobile user accepting near gig start misses the forfeiture-window warning web
  shows. Small port; do it with the next mobile booking-UI touch.
- TrueUpForm accepts "3.5" by silently rounding (inherited verbatim from web) — fix in both
  platforms via shared validation someday.
- `runSheet` compares the literal `"Canceled"` (matches 0.64.0's enum) — re-verify on any SDK
  bump (which forces a new EAS build anyway).
- feePreviews test uses evenly-dividing numbers; the rounding law is covered one layer down in
  `money.test.ts`. A fractional-cents composition case would be nice.
- README walkthrough steps 10/12 describe Stripe SDK-default sheet behaviors (wallet row
  placement, in-sheet 3DS) — the device walkthrough is what verifies them.
- "Opening Stripe…" busy label et al.: cosmetic polish only.

## Gates at merge (all green)

`pnpm typecheck` 5/5 · shared **153** (149+4) · `pnpm emu:test` **578** · `pnpm emu:rules` **77**
· web lint 0 errors + build · mobile lint 0 errors · `npx expo export --platform ios
--no-bytecode` (see ruling 11). Final whole-branch review (most capable model): READY TO MERGE
after a 1-commit fix wave (Critical Android re-sync + copy parity + idiom minors), scoped
re-review clean. No separate security audit this SP: rules/backend untouched; the final review
verified the client-side payments invariants (no client-supplied amounts, exact message-constant
branching, null-balance-never-$0, publishable-key-only, seam discipline, no secrets in diff).

## Device-testing prerequisites (operator — also in README launch checklist, sub-5b section)

New EAS dev build BOTH platforms (native module changed the binary); Apple merchant id
`merchant.app.gatekeep.mobile` + Apple Pay cert via Stripe dashboard; Google Pay enabled in
Stripe; `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS env var (+ `apps/mobile/.env` locally);
`APP_ORIGIN` set on deployed functions before onboarding tests; then README's mobile smoke
walkthrough (4242, 3DS 4000 0027 6000 3184, decline 4000 0000 0000 0341 → dunning → Pay now,
wallets, onboarding round-trip, payouts, true-up).

## Environment

Same as sp2-5 rulings, plus: hermesc.exe App-Control-blocked on this dev box (ruling 11);
`next typegen` needed in fresh worktrees before web typecheck.

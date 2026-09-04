> **Historical execution record.** This plan was executed and reviewed task by task; its snippets may predate the review fixes that shipped.
> Where the plan and the code disagree, the code and this sub-project's rulings doc win (`docs/superpowers/HANDOFF.md` lists them).

# Sub-project 5b, Mobile Native Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full payment parity on mobile, native Stripe PaymentSheet (cards + Apple Pay +
Google Pay) for save-card and pay-past-due, in-app-browser Express onboarding, and RN ports of
cash-out, true-up, gates, and the delinquency banner, wiring SP5's finished backend with zero
backend changes.

**Architecture:** `@stripe/stripe-react-native` behind a single seam module
(`src/payments/stripe.ts`); every action calls an existing SP5 callable; display/preview logic
single-sourced in `@gatekeep/shared`. Keyless (emulator) mode skips the native sheet entirely.

**Tech Stack:** Expo SDK 57 / expo-router, `@stripe/stripe-react-native` (new),
`expo-web-browser` (already a dep), Firebase JS SDK callables, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-08-28-mobile-payments-design.md`
**Backend authority:** `docs/superpowers/sp5-rulings.md` (callable contracts; do not modify
`functions/`)

## Global Constraints

- **No client-supplied amounts** ever reach a money callable, clients send ids (+ bounded
  true-up quantities, + a payout `amountCents` the server independently checks against the live
  balance). Never compute a charge client-side except as a labeled preview.
- **Verbatim server-error surfacing**: clients branch only on exact message constants from
  `@gatekeep/shared/messages.ts`; unrecognized messages render in the plain warning style.
- **Publishable key only** in `apps/mobile` (`EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`); the secret
  key must never appear in any client app.
- **`src/payments/stripe.ts` is the ONLY file that imports `@stripe/stripe-react-native`**, and
  it loads the module lazily (a dev client built before this native module exists must not crash
  at JS load, see the expo-audio precedent in `app/_layout.tsx`).
- **Keyless mode** (no publishable key): skip the sheet; `createSetupIntent` already saved the
  fake card server-side (see `SaveCardModal`'s header comment, apps/web).
- **Parity**: row-state mapping (`paymentRowKind`), `PAID_DEPOSIT_STATUSES`, and fee previews
  come from `@gatekeep/shared`, never re-implement them per platform.
- `availableBalanceCents: null` renders "unavailable", never $0.00.
- **House idioms**: `httpsCallable(getFirebase().functions, ...)`, inline styles, busy/error
  local state pairs, `key={profileId}` remount on context switch, no `Intl.ListFormat` (Hermes).
- Mobile has **no unit-test runner**, do not add one. Mobile tasks verify with
  `pnpm --filter @gatekeep/mobile typecheck` and `pnpm --filter @gatekeep/mobile lint`.
  Shared-package logic gets real tests.
- Windows: PS 5.1 corrupts UTF-8 on `Get-Content`/`Set-Content` pipelines, edit files with
  byte-safe tools only. Run the emulator suite as a single blocking foreground call.
- Commit after every task; message prefix `feat(sp5b):` (or `docs(sp5b):`/`chore(sp5b):`).

## File Structure

```
packages/shared/src/feePreviews.ts        (new, moved from apps/web/src/payments/fees.ts)
packages/shared/test/feePreviews.test.ts  (new)
packages/shared/src/paymentDisplay.ts     (modified, gains StripeStatusResult)
apps/mobile/src/payments/stripe.ts        (new, the one native-import seam)
apps/mobile/src/payments/SaveCardSheet.tsx    (new)
apps/mobile/src/payments/GatePrompt.tsx       (new)
apps/mobile/src/payments/delinquentBookings.ts (new)
apps/mobile/src/payments/PayPastDueButton.tsx (new)
apps/mobile/src/payments/TrueUpForm.tsx       (new)
apps/mobile/src/payments/DelinquencyBanner.tsx (new)
apps/mobile/src/payments/EarningsPanel.tsx    (new)
apps/mobile/src/bookings/PaymentStatus.tsx    (modified heavily; EarningsCard removed)
apps/mobile/src/bookings/{GigBrowse,MusicianBrowse,BookingThread}.tsx (GatePrompt mounts)
apps/mobile/app/_layout.tsx, app.json, app/(curator)/dashboard.tsx,
apps/mobile/app/(musician)/dashboard.tsx      (modified)
apps/web/src/payments/{fees.ts,types.ts}      (deleted; imports flip to shared)
README.md                                     (smoke walkthrough + launch checklist)
```

---

### Task 1: Move fee previews + StripeStatusResult into @gatekeep/shared

**Files:**
- Create: `packages/shared/src/feePreviews.ts`, `packages/shared/test/feePreviews.test.ts`
- Modify: `packages/shared/src/paymentDisplay.ts` (append `StripeStatusResult`),
  `packages/shared/src/index.ts` (add `export * from "./feePreviews.js";`)
- Delete: `apps/web/src/payments/fees.ts`, `apps/web/src/payments/types.ts`
- Modify (import flips only, no behavior change): `apps/web/src/payments/EarningsPanel.tsx`,
  `apps/web/src/payments/TrueUpForm.tsx`, `apps/web/src/payments/PaymentsPanel.tsx`,
  `apps/web/src/payments/DelinquencyBanner.tsx`, `apps/web/src/bookings/BookingThread.tsx`

**Interfaces:**
- Produces (all later mobile tasks consume these from `@gatekeep/shared`):
  `depositChargePreviewCents(expectedTotalCents: number): { sliceCents; feeCents; totalCents }`,
  `instantFeePreviewCents(amountCents: number): number`,
  `trueUpDeltaPreviewCents(structure, amountCents, feePolicy, durationMinutes, songCount, from, to): { deltaBaseCents; musicianDeltaCents; curatorFeeDeltaCents } | null`,
  `interface StripeStatusResult { hasCard; cardBrand; cardLast4; hasAccount; transfersEnabled; payoutsEnabled; instantEligible; delinquent; availableBalanceCents: number | null; instantAvailableBalanceCents: number | null }`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/feePreviews.test.ts` (follow `money.test.ts`'s runner idiom, node:test +
assert, same as the existing shared tests):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depositChargePreviewCents, instantFeePreviewCents, trueUpDeltaPreviewCents,
  DEFAULT_FEE_POLICY,
} from "../src/index.js";

// Spec worked example ($1,000 gig): deposit $350, curator fee share 11% of the
// slice = $38.50, due-now total $388.50.
test("depositChargePreviewCents matches the spec worked example", () => {
  assert.deepEqual(depositChargePreviewCents(100_000),
    { sliceCents: 35_000, feeCents: 3_850, totalCents: 38_850 });
});

test("instantFeePreviewCents: 4% with the $1 floor", () => {
  assert.equal(instantFeePreviewCents(25_000), 1_000); // 4% of $250
  assert.equal(instantFeePreviewCents(1_000), 100);    // 4% would be 40c -> $1 floor
});

test("trueUpDeltaPreviewCents: perHour delta is the new base minus the old", () => {
  // $100/hr, 60-minute gig, no prior report -> +30 extra minutes.
  const d = trueUpDeltaPreviewCents("perHour", 10_000, DEFAULT_FEE_POLICY, 60, null,
    { extraMinutes: 0, extraSongs: 0 }, { extraMinutes: 30, extraSongs: 0 });
  assert.ok(d);
  assert.equal(d.deltaBaseCents, 5_000);
  assert.equal(d.musicianDeltaCents, 4_900);  // 98%, floor
  assert.equal(d.curatorFeeDeltaCents, 550);  // 11%, ceil
});

test("trueUpDeltaPreviewCents returns null on malformed input instead of throwing", () => {
  assert.equal(trueUpDeltaPreviewCents("perHour", -1, DEFAULT_FEE_POLICY, 60, null,
    { extraMinutes: 0, extraSongs: 0 }, { extraMinutes: 30, extraSongs: 0 }), null);
});
```

If `DEFAULT_FEE_POLICY` does not exist in shared, construct the policy inline from the exported
fee constants instead (`{ curatorFeePct: CURATOR_FEE_PCT, musicianFeePct: MUSICIAN_FEE_PCT, ... }`:
read `packages/shared/src/types.ts`'s `FeePolicy` for the exact field names and
`resolveFeePolicy` for the defaults; adjust the import line accordingly). Do NOT invent new
constants.

- [ ] **Step 2: Run it to make sure it fails**

Run (repo root): `pnpm --filter @gatekeep/shared test`
Expected: FAIL, `feePreviews` module not found.

- [ ] **Step 3: Create the module (verbatim move)**

Create `packages/shared/src/feePreviews.ts` with the ENTIRE current content of
`apps/web/src/payments/fees.ts`, changing only the import line to relative in-package form:

```ts
import {
  CURATOR_FEE_PCT, INSTANT_FEE_PCT, INSTANT_FEE_MIN_CENTS,
  computeFeeShareCents, computeInstantFeeCents, computeDepositCents,
  computeSettlementBaseCents, computeEarningsCents,
  type BudgetStructure, type FeePolicy,
} from "./index.js";
```

(If `./index.js` self-import trips the build, import from the concrete modules,
`./money.js` / `./types.js`, matching where each symbol actually lives; check with grep.)
Keep every comment: they carry the "preview, never authoritative" contract. Update the header's
file references ("apps/web/src/payments/fees.ts" → "packages/shared/src/feePreviews.ts, shared
by web and mobile").

Append to `packages/shared/src/paymentDisplay.ts` (verbatim from
`apps/web/src/payments/types.ts`, comments included):

```ts
// Response shape of the getStripeStatus callable, client-shared so web and
// mobile render the SAME contract (moved from apps/web/src/payments/types.ts
// in SP5b; the null-balance rule in the comment below is binding on both).
export interface StripeStatusResult {
  hasCard: boolean; cardBrand: string | null; cardLast4: string | null;
  hasAccount: boolean; transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  delinquent: boolean;
  // 0 means "asked, nothing there"; null means "Stripe couldn't be read just
  // now", MUST render as "balance unavailable", never $0.00.
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
}
```

Add `export * from "./feePreviews.js";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @gatekeep/shared build && pnpm --filter @gatekeep/shared test`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Flip web imports and delete the old files**

- Delete `apps/web/src/payments/fees.ts` and `apps/web/src/payments/types.ts`.
- `EarningsPanel.tsx`: `import { instantFeePreviewCents } from "./fees";` → merge
  `instantFeePreviewCents` into its existing `@gatekeep/shared` import; replace
  `import type { StripeStatusResult } from "./types";` with `type StripeStatusResult` in the
  same shared import.
- `TrueUpForm.tsx`: `trueUpDeltaPreviewCents` moves into the shared import.
- `PaymentsPanel.tsx` and `DelinquencyBanner.tsx`: `StripeStatusResult` from shared.
- `apps/web/src/bookings/BookingThread.tsx`: `depositChargePreviewCents` from shared (drop the
  `"../payments/fees"` import).

- [ ] **Step 6: Verify web still builds**

Run: `pnpm --filter @gatekeep/web typecheck && pnpm --filter @gatekeep/web build`
Expected: clean. (Run `pnpm --filter @gatekeep/web exec next typegen` first if typecheck
complains about missing route types on a fresh clone.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared apps/web
git commit -m "feat(sp5b): move fee previews + StripeStatusResult to @gatekeep/shared"
```

---

### Task 2: Native Stripe module, provider, and the stripe.ts seam

**Files:**
- Modify: `apps/mobile/package.json` (+ lockfile via install), `apps/mobile/app.json`,
  `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/src/payments/stripe.ts`

**Interfaces:**
- Produces: `stripeEnabled: boolean`, `publishableKey: string`,
  `runSetupSheet(clientSecret: string): Promise<SheetOutcome>`,
  `runPaymentSheet(clientSecret: string): Promise<SheetOutcome>`,
  `type SheetOutcome = { ok: true } | { ok: false; cancelled: boolean; message: string | null }`
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Install the module**

Run (in `apps/mobile/`): `npx expo install @stripe/stripe-react-native`
(`expo install` picks the SDK-57-compatible version and writes via pnpm.) If the repo's
`minimumReleaseAgeExclude` supply-chain gate rejects the resolved version, add the exact
`@stripe/stripe-react-native@<version>` to that list in `pnpm-workspace.yaml`, same mechanism
the expo@57 packages already use.

- [ ] **Step 2: Plugin config**

In `apps/mobile/app.json`, append to the `plugins` array (after `"expo-audio"`):

```json
[
  "@stripe/stripe-react-native",
  {
    "merchantIdentifier": "merchant.app.gatekeep.mobile",
    "enableGooglePay": true
  }
]
```

- [ ] **Step 3: The seam module**

Create `apps/mobile/src/payments/stripe.ts`:

```ts
// SP5b, the ONLY file in this app that touches @stripe/stripe-react-native.
// Two reasons it exists:
//  1. Keyless mode is one branch: no EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
//     (emulator dev) means stripeEnabled === false and NOTHING in this file
//     past the two consts ever runs, callers skip the sheet entirely
//     (FakeStripe already did the server-side work; see SaveCardSheet).
//  2. The native import is LAZY (require inside the function, never a
//     top-level import): a dev client built before this native module was
//     linked in must not crash at JS-bundle load. Same failure mode the
//     expo-audio note in app/_layout.tsx documents.
export const publishableKey = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const stripeEnabled = publishableKey !== "";
export const MERCHANT_IDENTIFIER = "merchant.app.gatekeep.mobile";

export type SheetOutcome =
  | { ok: true }
  | { ok: false; cancelled: boolean; message: string | null };

type StripeNative = typeof import("@stripe/stripe-react-native");
function native(): StripeNative {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@stripe/stripe-react-native");
}

// testEnv keys Google Pay off the KEY, not __DEV__, a preview/internal build
// running a pk_test_ key is still a test environment.
const SHEET_BASE = {
  merchantDisplayName: "GateKeep",
  applePay: { merchantCountryCode: "US" },
  googlePay: { merchantCountryCode: "US", testEnv: !publishableKey.startsWith("pk_live_") },
  // 3DS/redirect-based methods bounce back through the app scheme.
  returnURL: "gatekeep://stripe-redirect",
} as const;

async function runSheet(
  secret: { setupIntentClientSecret: string } | { paymentIntentClientSecret: string },
): Promise<SheetOutcome> {
  const { initPaymentSheet, presentPaymentSheet } = native();
  const { error: initError } = await initPaymentSheet({ ...SHEET_BASE, ...secret });
  if (initError) return { ok: false, cancelled: false, message: initError.message ?? null };
  const { error } = await presentPaymentSheet();
  if (!error) return { ok: true };
  // The sheet's own dismissal is a USER CANCEL, not a failure, callers stay
  // silent on it (parity with web, where closing the modal shows no error).
  return { ok: false, cancelled: error.code === "Canceled", message: error.message ?? null };
}

export function runSetupSheet(clientSecret: string): Promise<SheetOutcome> {
  return runSheet({ setupIntentClientSecret: clientSecret });
}
export function runPaymentSheet(clientSecret: string): Promise<SheetOutcome> {
  return runSheet({ paymentIntentClientSecret: clientSecret });
}

// "seti_xxx_secret_yyy" -> "seti_xxx", the id refreshPaymentMethod expects;
// same id Stripe.js hands web's confirmSetup result.
export function setupIntentIdFromClientSecret(clientSecret: string): string {
  return clientSecret.split("_secret")[0];
}
```

If the installed version's `PaymentSheetError` cancel code differs from the literal `"Canceled"`,
import the enum from the lazy `native()` result and compare against it, check
`node_modules/@stripe/stripe-react-native/lib/typescript` for the exact member before guessing.

- [ ] **Step 4: Provider in the root layout**

In `apps/mobile/app/_layout.tsx`, add below the imports:

```tsx
import { stripeEnabled, publishableKey, MERCHANT_IDENTIFIER } from "../src/payments/stripe";

// Renders children bare when keyless, the provider (and the native module
// behind it) never loads in emulator dev or on a dev client from before this
// module existed. Lazy require for the same reason stripe.ts documents.
function MaybeStripeProvider({ children }: { children: React.ReactNode }) {
  if (!stripeEnabled) return <>{children}</>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeProvider } = require("@stripe/stripe-react-native") as
    typeof import("@stripe/stripe-react-native");
  return (
    <StripeProvider publishableKey={publishableKey} urlScheme="gatekeep"
      merchantIdentifier={MERCHANT_IDENTIFIER}>
      {children}
    </StripeProvider>
  );
}
```

and wrap the tree in `RootLayout`'s return:

```tsx
return (
  <AuthProvider><ProfileProvider><MaybeStripeProvider><Gate /></MaybeStripeProvider></ProfileProvider></AuthProvider>
);
```

(Import `React` types as needed; `ReactNode` from "react".)

- [ ] **Step 5: Verify**

Run (repo root): `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`
Then: `cd apps/mobile && npx expo export --platform ios`, Expected: bundle succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(sp5b): add @stripe/stripe-react-native + provider + seam module"
```

---

### Task 3: SaveCardSheet, GatePrompt, and the three gate mounts

**Files:**
- Create: `apps/mobile/src/payments/SaveCardSheet.tsx`,
  `apps/mobile/src/payments/GatePrompt.tsx`, `apps/mobile/src/payments/delinquentBookings.ts`
- Modify: `apps/mobile/src/bookings/GigBrowse.tsx`, `apps/mobile/src/bookings/MusicianBrowse.tsx`,
  `apps/mobile/src/bookings/BookingThread.tsx`

**Interfaces:**
- Consumes: Task 2's `stripeEnabled`, `runSetupSheet`, `setupIntentIdFromClientSecret`.
- Produces: `SaveCardSheet({ profileId, onSaved, onClose })`,
  `GatePrompt({ message, curatorProfileId?, viewerIsMusician?, onRetry })`,
  `fetchDelinquentBookingIds(curatorProfileId): Promise<string[]>`, Tasks 4 and 6 reuse
  `SaveCardSheet` and `fetchDelinquentBookingIds`.

- [ ] **Step 1: delinquentBookings.ts (verbatim port)**

Create `apps/mobile/src/payments/delinquentBookings.ts` with the exact content of
`apps/web/src/payments/delinquentBookings.ts`, changing only the `getFirebase` import path to
`"../lib/firebase"`. Keep the provability comment.

- [ ] **Step 2: SaveCardSheet**

Create `apps/mobile/src/payments/SaveCardSheet.tsx`:

```tsx
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { stripeEnabled, runSetupSheet, setupIntentIdFromClientSecret } from "./stripe";

// SP5b, the native counterpart of apps/web/src/payments/SaveCardModal.tsx.
// Same flow, with the PaymentSheet replacing Elements:
//  1. createSetupIntent({profileId}) -> clientSecret.
//  2a. REAL mode: initPaymentSheet(setupIntentClientSecret)+present (cards +
//      Apple Pay + Google Pay), then refreshPaymentMethod({profileId,
//      setupIntentId}), the id parsed off the client secret is the same one
//      web reads from confirmSetup's result, and passing it is what pins THIS
//      card as the customer default (see refreshPaymentMethod's as-built note
//      in functions/src/payments.ts).
//  2b. FAKE mode (!stripeEnabled): createSetupIntent already marked the card
//      saved server-side before returning (SaveCardModal's header documents
//      why), show the confirmation, no sheet, no refresh call.
// A user-cancelled sheet is silent (no error, stays open), parity with web's
// modal close.
export function SaveCardSheet({ profileId, onSaved, onClose }: {
  profileId: string; onSaved: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fakeSaved, setFakeSaved] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable<{ profileId: string }, { clientSecret: string; customerId: string }>(
        getFirebase().functions, "createSetupIntent")({ profileId });
      if (!stripeEnabled) {
        setFakeSaved(true);
        return;
      }
      const outcome = await runSetupSheet(res.data.clientSecret);
      if (!outcome.ok) {
        if (!outcome.cancelled) setError(outcome.message ?? "Could not save the card.");
        return;
      }
      // The card and SetupIntent both succeeded with Stripe; only our own
      // follow-up can fail past here, same honest distinction web draws.
      try {
        await httpsCallable(getFirebase().functions, "refreshPaymentMethod")({
          profileId, setupIntentId: setupIntentIdFromClientSecret(res.data.clientSecret),
        });
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message
          : "The card was saved with Stripe, but we couldn't confirm it here, try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start card setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 10 }}>
      <Text style={{ fontWeight: "600" }}>Save a payment card</Text>
      {error && (
        <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
          borderRadius: 8, padding: 12, color: "#92400e" }}>{error}</Text>
      )}
      {fakeSaved ? (
        <>
          <Text style={{ color: "#166534" }}>
            Test card saved (visa •••• 4242), no real payment sheet runs in the emulator.
          </Text>
          <Pressable onPress={onSaved} style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 10 }}>
            <Text>Done</Text>
          </Pressable>
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable onPress={() => void start()} disabled={busy}
            style={{ backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
            <Text style={{ color: "#fff" }}>{busy ? "Starting…" : "Add a card"}</Text>
          </Pressable>
          <Pressable onPress={onClose} disabled={busy}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
```

- [ ] **Step 3: GatePrompt (faithful RN port)**

Create `apps/mobile/src/payments/GatePrompt.tsx`, port `apps/web/src/payments/GatePrompt.tsx`
branch-for-branch (READ IT FIRST; keep its L11 viewer-side guard comments). Differences from web,
and ONLY these:
- `Link href` → `expo-router` navigation: delinquent-booking links use
  `router.push({ pathname: "/booking/[bookingId]", params: { bookingId: id } })`; the musician
  "Finish payout setup →" link uses `router.push("/(musician)/dashboard")` (the Earnings surface
  after Task 7).
- `SaveCardModal` → `SaveCardSheet` (same inline open + `onSaved: () => { setShowSaveCard(false); onRetry(); }`).
- HTML → RN primitives; `WarnBox` becomes a `View` with the same amber palette
  (`#fef3c7`/`#fde68a`/`#92400e`); the info branch keeps web's blue
  (`#eff6ff`/`#bfdbfe`/`#1e40af`).
- Props identical: `{ message, curatorProfileId?, viewerIsMusician?, onRetry }`. All four message
  constants come from `@gatekeep/shared` exactly as web imports them.

- [ ] **Step 4: Mount at the three action sites**

Mirror web's SP5 integration exactly (web references in parentheses):

1. `GigBrowse.tsx` (web `BookingForms.tsx` apply flow): replace the apply-submit error render
   `{error && <ErrorBox message={error} />}` with
   `{error && <GatePrompt message={error} viewerIsMusician onRetry={() => void submit()} />}`.
   Leave the `already-exists` special case untouched.
2. `MusicianBrowse.tsx` (web `OfferComposer.tsx:109`): in the offer form, replace
   `{error && <ErrorBox message={error} />}` with
   `{error && <GatePrompt message={error} curatorProfileId={curatorProfileId} onRetry={() => void submit()} />}`.
   NOTE: the open-gigs subscription's load error also writes `error`, GatePrompt's fall-through
   branch renders it identically to ErrorBox, so this is safe (web has the same property).
3. `BookingThread.tsx` (web `BookingThread.tsx:452-455`): ONLY the negotiation action-bar error
   (currently line ~398, the one under the Accept/Counter/Decline row) becomes
   `{actionError && <GatePrompt message={actionError} curatorProfileId={booking.curatorProfileId} viewerIsMusician={mySide === "musician"} onRetry={() => void accept()} />}`.
   The report-form and awaiting-side `actionError` renders stay `ErrorBox` (web's do too).

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`

```bash
git add apps/mobile/src
git commit -m "feat(sp5b): SaveCardSheet + GatePrompt with gate mounts at apply/offer/accept"
```

---

### Task 4: Pay-past-due + card-on-file row in PaymentStatus

**Files:**
- Create: `apps/mobile/src/payments/PayPastDueButton.tsx`
- Modify: `apps/mobile/src/bookings/PaymentStatus.tsx`

**Interfaces:**
- Consumes: Task 2 seam (`stripeEnabled`, `runPaymentSheet`), Task 3 `SaveCardSheet`,
  Task 1 `StripeStatusResult` (from `@gatekeep/shared`).
- Produces: `PayPastDueButton({ bookingId, gigId, onDone? })` (Task 5 renders beside it).

- [ ] **Step 1: PayPastDueButton (RN port)**

Create `apps/mobile/src/payments/PayPastDueButton.tsx`, port
`apps/web/src/payments/PayPastDueButton.tsx` (READ IT FIRST; keep its webhook-finalizes and
delinquency-lift-lag comments). The Elements `ConfirmForm` is replaced by the sheet:

```tsx
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { stripeEnabled, runPaymentSheet } from "./stripe";

interface PayPastDueResult { done: boolean; amountCents: number; clientSecret?: string; }

export function PayPastDueButton({ bookingId, gigId, onDone }: {
  bookingId: string; gigId: string; onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable<{ bookingId: string; gigId: string }, PayPastDueResult>(
        getFirebase().functions, "payPastDue")({ bookingId, gigId });
      if (res.data.done) {
        setDone(true);
        onDone?.();
        return;
      }
      if (!res.data.clientSecret) {
        setError("Could not start this payment, try again.");
        return;
      }
      if (!stripeEnabled) {
        // Defensive only: FakeStripe confirms synchronously (done:true), so a
        // clientSecret without a key means a config mismatch, not a user path.
        setError("This payment needs the payment sheet, which isn't configured in this build.");
        return;
      }
      const outcome = await runPaymentSheet(res.data.clientSecret);
      if (outcome.ok) {
        // payment_intent.succeeded finalizes the doc out-of-band; the row's
        // onSnapshot picks the terminal write up on its own (web's comment).
        setDone(true);
        onDone?.();
      } else if (!outcome.cancelled) {
        setError(outcome.message ?? "Could not complete the payment.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not pay this now.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <Text style={{ color: "#166534" }}>Payment sent, clearing any overdue status may take a moment.</Text>;
  }
  return (
    <View style={{ gap: 6 }}>
      {error && (
        <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
          borderRadius: 8, padding: 12, color: "#92400e" }}>{error}</Text>
      )}
      <Pressable onPress={() => void start()} disabled={busy} style={{ alignSelf: "flex-start" }}>
        <Text style={{ color: "#dc2626", textDecorationLine: "underline" }}>
          {busy ? "Starting…" : "Pay now"}
        </Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: PaymentStatus grows the curator actions**

In `apps/mobile/src/bookings/PaymentStatus.tsx`:

1. **Labels**, revert SP5's two read-only divergences (divergence 1 in the file header; update
   that header comment to say SP5b removed it): `settlementPastDue` curator label →
   `"Past due, pay now"`, `depositPastDue` curator label → `"Deposit past due, pay now"`.
   Musician labels unchanged.
2. **Card-on-file row** (mirror web `PaymentsPanel.tsx:181-205`): curator-side only, above the
   rows. Add state `stripeStatus: StripeStatusResult | "loading" | "error"`,
   `stripeReloadKey`, `showSaveCard`; the same `getStripeStatus({ profileId: curatorProfileId })`
   effect web's panel runs (gated on `isCuratorSide && curatorProfileId`, no synchronous
   set-to-loading on reload, copy web's idiom comment). Render: `showSaveCard` →
   `<SaveCardSheet profileId={curatorProfileId} onSaved={() => { setShowSaveCard(false); setStripeReloadKey(k => k + 1); }} onClose={() => setShowSaveCard(false)} />`;
   else loading/error/card line `Card on file: {brand} •••• {last4}` / `No card on file` with an
   Update/Add pressable. Import `StripeStatusResult` from `@gatekeep/shared` (Task 1), do NOT
   reuse the local `StripeStatusSummary` (that's EarningsCard's, removed in Task 7).
3. **Pay now mount** (mirror web `PaymentsPanel.tsx:216-218`): inside the row map, after the
   Badge: `{isCuratorSide && (kind === "settlementPastDue" || kind === "depositPastDue") && (
   <PayPastDueButton bookingId={bookingId} gigId={row.id} onDone={() => setStripeReloadKey(k => k + 1)} />)}`.
4. **Footer**: replace the curator line "Cards, past-due payments and receipts are managed on
   the web." with nothing (the card row above replaces it). Leave the musician footer line for
   Task 7.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`

```bash
git add apps/mobile/src
git commit -m "feat(sp5b): native pay-past-due + card-on-file management in PaymentStatus"
```

---

### Task 5: True-up (report actuals) on mobile

**Files:**
- Create: `apps/mobile/src/payments/TrueUpForm.tsx`
- Modify: `apps/mobile/src/bookings/PaymentStatus.tsx`,
  `apps/mobile/src/bookings/BookingThread.tsx` (one-line: export `useOccurrences`)

**Interfaces:**
- Consumes: Task 1's `trueUpDeltaPreviewCents` (shared); mobile `BookingThread.tsx`'s
  `useOccurrences(bookingId): Occurrence[]` (currently un-exported at line ~108, add `export`,
  exactly as web's BookingThread already exports it for its PaymentsPanel).
- Produces: `TrueUpForm({ bookingId, gigId, structure, amountCents, feePolicy, durationMinutes,
  songCount, current, onDone, onCancel })`, same prop contract as web.

- [ ] **Step 1: Export useOccurrences**

In `apps/mobile/src/bookings/BookingThread.tsx`, change `function useOccurrences(` to
`export function useOccurrences(` (mirror web's export comment at its `useRole`).

- [ ] **Step 2: TrueUpForm (faithful RN port)**

Create `apps/mobile/src/payments/TrueUpForm.tsx`, port `apps/web/src/payments/TrueUpForm.tsx`
line-for-line (READ IT FIRST): identical validation ladder (shape → cap → increase-only, each
mirroring the server's own ordering, comments preserved), identical preview sentence, the
`perSet` early return, the empty-not-"0" default note. RN specifics: `TextInput` with
`keyboardType="number-pad"` and `value={rawInput}` / `onChangeText={setRawInput}`;
`trueUpDeltaPreviewCents` + message constants from `@gatekeep/shared`; `formatCents` from
`../gigs/GigForms`; buttons as `Pressable`s in the house style.

- [ ] **Step 3: Mount in PaymentStatus**

Mirror web `PaymentsPanel.tsx:219-233` inside the row map (after the PayPastDueButton mount):

```tsx
{isCuratorSide && kind === "settlementPending" && booking.structure !== "perSet" && (
  openTrueUpFor === row.id ? (
    <TrueUpForm
      bookingId={bookingId} gigId={row.id} structure={booking.structure}
      amountCents={booking.acceptedTerms?.amountCents ?? 0} feePolicy={resolveFeePolicy(booking.feePolicy)}
      durationMinutes={durationByGigId.get(row.id) ?? 0} songCount={booking.acceptedTerms?.expectedQuantity ?? null}
      current={row.settlement.trueUp}
      onDone={() => setOpenTrueUpFor(null)} onCancel={() => setOpenTrueUpFor(null)}
    />
  ) : (
    <Pressable onPress={() => setOpenTrueUpFor(row.id)} style={{ alignSelf: "flex-start" }}>
      <Text style={{ fontSize: 13, textDecorationLine: "underline" }}>Report actuals</Text>
    </Pressable>
  )
)}
```

with supporting additions copied from web's panel: `openTrueUpFor` state,
`const occurrences = useOccurrences(bookingId);` (unconditional, before the early returns,
hooks-order comment applies), `const durationByGigId = new Map(occurrences.map((o) => [o.id, o.durationMinutes]));`,
and `resolveFeePolicy` in the `@gatekeep/shared` import.

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`

```bash
git add apps/mobile/src
git commit -m "feat(sp5b): report-actuals true-up on mobile"
```

---

### Task 6: DelinquencyBanner on the curator dashboard

**Files:**
- Create: `apps/mobile/src/payments/DelinquencyBanner.tsx`
- Modify: `apps/mobile/app/(curator)/dashboard.tsx`

**Interfaces:**
- Consumes: Task 1 `StripeStatusResult`, Task 3 `fetchDelinquentBookingIds`.
- Produces: `DelinquencyBanner({ profileId })`.

- [ ] **Step 1: Port the banner**

Create `apps/mobile/src/payments/DelinquencyBanner.tsx`, port
`apps/web/src/payments/DelinquencyBanner.tsx` exactly (READ IT FIRST; both effects, the
`status?.delinquent !== true` early return, the loading/links/fallback copy). RN specifics:
`Link href` → `router.push({ pathname: "/booking/[bookingId]", params: { bookingId: id } })`
via underlined `Text` in a `Pressable`; red palette identical (`#fee2e2`/`#fca5a5`/`#991b1b`);
`StripeStatusResult` from `@gatekeep/shared`; the fallback line reads "Check your bookings tab
to find and settle the overdue date." (mobile's bookings live in a tab, not "below").

- [ ] **Step 2: Mount**

In `apps/mobile/app/(curator)/dashboard.tsx`, render
`<DelinquencyBanner key={`delinquency-${profileId}`} profileId={profileId} />` directly under
the `Status:` line (inside the approved-and-otherwise ScrollView, before the rejected block),
one mount, all statuses; the banner self-hides when not delinquent.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`

```bash
git add apps/mobile
git commit -m "feat(sp5b): delinquency banner on the curator dashboard"
```

---

### Task 7: Full EarningsPanel (onboarding + cash-out) replaces EarningsCard

**Files:**
- Create: `apps/mobile/src/payments/EarningsPanel.tsx`
- Modify: `apps/mobile/app/(musician)/dashboard.tsx`,
  `apps/mobile/src/bookings/PaymentStatus.tsx` (remove `EarningsCard` + its
  `StripeStatusSummary`; musician footer line)

**Interfaces:**
- Consumes: Task 1 (`instantFeePreviewCents`, `StripeStatusResult`), shared
  `PAYOUT_INSTANT_INELIGIBLE_MESSAGE`, `PAYOUT_INSTANT_MIN_MESSAGE`, `INSTANT_PAYOUT_MIN_CENTS`,
  `PaymentDoc`; `expo-web-browser` (already a dependency).
- Produces: `EarningsPanel({ profileId })`.

- [ ] **Step 1: Port the panel**

Create `apps/mobile/src/payments/EarningsPanel.tsx`, port
`apps/web/src/payments/EarningsPanel.tsx` (READ IT FIRST, every helper travels):
`parseDollarsToCents` (+ `MAX_PREVIEW_CENTS`), `usePaymentRows` (the musician-pinned bookings
onSnapshot + generation-guarded n+1 payments fan-out, comments preserved; the
`(musicianProfileId, updatedAt)` index already exists), `PendingSettlementsList`, `HistoryList`
(+ `HISTORY_LIMIT`), the status effect with its amount-field default, `submitPayout` with the
one-requestId-per-press `requestRef` semantics, the instant-button gating
(`instantEligible`/`belowInstantMin`/fee≥amount) with the two tooltip messages rendered as a
small `Text` hint under the buttons (RN has no `title` attr). Differences, and ONLY these:

1. **requestId mint**, RN has no `crypto.randomUUID` (see the recorded precedent at
   `src/portfolio/PortfolioForms.tsx:196`). Use the same nonce idiom, which satisfies
   requestPayout's `8-64 chars of [A-Za-z0-9_-]` check:

```ts
// RN has no crypto.randomUUID, timestamp+random nonce is fine (uniqueness,
// not secrecy; requestPayout's REQUEST_ID_RE accepts 8-64 [A-Za-z0-9_-]).
const mintRequestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
```

   Because this can't throw, the web comment about minting inside the try no longer applies,
   drop that comment, keep the mint inside `submitPayout` all the same.

2. **Onboarding**, replace `window.location.assign` + sessionStorage bridge with the in-app
   browser + foreground re-sync (`rememberOnboardingProfileId` is NOT ported, the return page
   runs on web; mobile re-syncs by re-calling getStripeStatus itself):

```tsx
import * as WebBrowser from "expo-web-browser";
import { AppState } from "react-native";

// Inside EarningsPanel:
const onboardingInFlight = useRef(false);

// Stripe-hosted Express onboarding opens in the in-app browser. The return/
// refresh URLs are the server-built APP_ORIGIN web pages (fail-closed, never
// client-supplied, createOnboardingLink's contract); mobile doesn't need to
// land on them: getStripeStatus re-syncs the gate flags live (it re-reads the
// account from Stripe), so re-polling on browser dismiss AND on app
// re-foreground covers both the in-app-browser path and a user who bounced
// out to Safari/Chrome mid-flow.
const setupPayouts = async () => {
  setOnboardBusy(true);
  setOnboardError(null);
  try {
    const res = await httpsCallable<{ profileId: string }, { url: string }>(
      getFirebase().functions, "createOnboardingLink")({ profileId });
    onboardingInFlight.current = true;
    await WebBrowser.openBrowserAsync(res.data.url);
    // Browser dismissed, whatever happened in there, re-read the truth.
    onboardingInFlight.current = false;
    setReloadKey((k) => k + 1);
  } catch (e) {
    setOnboardError(e instanceof Error ? e.message : "Could not start payout setup.");
  } finally {
    setOnboardBusy(false);
  }
};

useEffect(() => {
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "active" && onboardingInFlight.current) {
      onboardingInFlight.current = false;
      setReloadKey((k) => k + 1);
    }
  });
  return () => sub.remove();
}, []);
```

3. HTML → RN primitives throughout; `formatCents`/`formatGigDateTime` from `../gigs/GigForms`;
   the "first payout may be held ~7 days" line and the delinquent notice travel verbatim.
4. **No admin gating client-side** (spec §4): buttons render for any member; a non-admin's press
   surfaces the server's permission refusal verbatim, exactly web's posture.

- [ ] **Step 2: Swap the dashboard mount**

In `apps/mobile/app/(musician)/dashboard.tsx`: import `EarningsPanel` from
`"../../src/payments/EarningsPanel"` instead of `EarningsCard`, render
`<EarningsPanel key={profileId} profileId={profileId} />` (keep the key-remount comment, updating
the component name).

- [ ] **Step 3: Retire EarningsCard**

In `apps/mobile/src/bookings/PaymentStatus.tsx`: delete the `EarningsCard` component, its
`StripeStatusSummary` interface, and the now-unused imports; update the file-header comment (the
file is now PaymentStatus only). Replace the musician footer line
"Payout setup and cash-outs are managed on the web." with a
`router.push("/(musician)/dashboard")` pressable reading "Manage payouts →" (import `useRouter`
from expo-router). Grep the repo for other `EarningsCard` imports before deleting (only the
musician dashboard should match, already fixed in Step 2).

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck && pnpm --filter @gatekeep/mobile lint`

```bash
git add apps/mobile
git commit -m "feat(sp5b): full earnings panel, Stripe onboarding + cash-out on mobile"
```

---

### Task 8: README, surfaces rewrite, launch checklist, device smoke walkthrough

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Surfaces paragraph**

In README's SP5 "**Surfaces.**" paragraph (~line 352): replace the "Mobile is read-only this
sub-project … sub-5b" sentences with a statement of the new reality: mobile now carries the full
action set natively (PaymentSheet save-card + pay-past-due with Apple Pay/Google Pay, in-app
Stripe Express onboarding, cash-out, true-ups, gates, delinquency banner), sharing row-state
mapping AND fee previews with web via `@gatekeep/shared` (`paymentDisplay.ts`,
`feePreviews.ts`); Stripe-hosted onboarding still returns to the web pages by design
(server-built `APP_ORIGIN` URLs, mobile re-syncs status on re-foreground instead).

- [ ] **Step 2: Launch checklist additions**

Add to the launch checklist (new "Sub-project 5b" grouping, wording from spec §10):

1. Apple Developer portal: create merchant id `merchant.app.gatekeep.mobile`; add the Apple Pay
   payment-processing certificate via the Stripe dashboard (test mode first, again at go-live).
2. Stripe dashboard: enable Google Pay. (`testEnv` follows the key: any non-`pk_live_` key runs
   Google Pay in test mode.)
3. Set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS environment variable (dashboard or
   `eas env:create`), plus `apps/mobile/.env` for local dev-client runs. `eas.json` stays
   key-free. No key = keyless mode (sheets skipped, emulator dev posture).
4. Cut a NEW EAS dev-client build for both platforms before device testing
   (`npx eas-cli build --profile development --platform all` from `apps/mobile/`), the Stripe
   native module changed the binary.
5. `APP_ORIGIN` must be set on deployed functions before testing onboarding from a device (the
   Stripe return/refresh pages live on web).

- [ ] **Step 3: Mobile section of the real-test-mode smoke walkthrough**

Extend README's SP5 manual walkthrough with a mobile subsection (device + test keys + dev
build): save 4242 through the sheet (card row shows visa •••• 4242); save-then-3DS card
4000 0027 6000 3184 challenges inside the sheet; decline-after-save 4000 0000 0000 0341 → let
dunning exhaust → Pay now clears it (both debt shapes); Apple Pay and Google Pay rows appear in
the sheet on capable devices; onboarding round-trip (in-app browser → finish Express → back →
gates open on re-foreground); standard then instant payout (fee preview matches `requestPayout`'s
returned fee); a perHour true-up whose preview delta matches the settled charge.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(sp5b): README, mobile payments surfaces, launch checklist, smoke walkthrough"
```

---

### Task 9: Whole-repo gates

**Files:** none (verification only; fix anything red, folding fixes into the responsible area).

- [ ] **Step 1:** `pnpm typecheck`, Expected: 5/5 green.
- [ ] **Step 2:** `pnpm --filter @gatekeep/shared test`, Expected: all pass (149 + new).
- [ ] **Step 3:** `pnpm emu:test` (single blocking foreground call; `FUNCTIONS_DISCOVERY_TIMEOUT=60`),
  Expected: 578 pass (backend untouched, any failure is environmental or a shared-package
  regression; investigate, don't rerun blindly).
- [ ] **Step 4:** `pnpm emu:rules`, Expected: 77 pass.
- [ ] **Step 5:** `pnpm --filter @gatekeep/web lint && pnpm --filter @gatekeep/web build`, clean.
- [ ] **Step 6:** `pnpm --filter @gatekeep/mobile lint`, 0 errors.
- [ ] **Step 7:** `cd apps/mobile && npx expo export --platform ios`, bundles.
- [ ] **Step 8:** Commit anything the gates forced, then hand off: device verification requires
  the operator steps (README, Task 8), a new EAS dev build with the publishable key, merchant
  ID, and the smoke walkthrough. Those are the owner's manual steps, not this plan's.

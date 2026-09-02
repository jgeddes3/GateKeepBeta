import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Publishable key only (public by design, the secret key must NEVER appear
// in apps/web, per the plan's binding rulings). When unset (emulator dev),
// the app runs in "fake payments" mode: SaveCardModal skips Elements
// entirely, createSetupIntent's as-built implementation (functions/src/
// payments.ts) already marks the card saved server-side when it detects
// FakeStripe, before the callable even returns.
const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const stripeEnabled = pk !== "";

let promise: Promise<Stripe | null> | null = null;
// Memoized so every caller (SaveCardModal, and Task 15's PayPastDueButton)
// shares the SAME Stripe.js instance/promise rather than re-loading the
// script, loadStripe() is itself idempotent per publishable key, but
// caching here also gives <Elements stripe={...}> a stable prop across
// re-renders instead of a fresh promise each time.
export function getStripeJs(): Promise<Stripe | null> {
  if (!promise) promise = stripeEnabled ? loadStripe(pk) : Promise.resolve(null);
  return promise;
}

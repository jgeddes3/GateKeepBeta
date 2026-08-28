// SP5b — the ONLY file in this app that touches @stripe/stripe-react-native.
// Two reasons it exists:
//  1. Keyless mode is one branch: no EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
//     (emulator dev) means stripeEnabled === false and NOTHING in this file
//     past the two consts ever runs — callers skip the sheet entirely
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

// testEnv keys Google Pay off the KEY, not __DEV__ — a preview/internal build
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
  // The sheet's own dismissal is a USER CANCEL, not a failure — callers stay
  // silent on it (parity with web, where closing the modal shows no error).
  return { ok: false, cancelled: error.code === "Canceled", message: error.message ?? null };
}

export function runSetupSheet(clientSecret: string): Promise<SheetOutcome> {
  return runSheet({ setupIntentClientSecret: clientSecret });
}
export function runPaymentSheet(clientSecret: string): Promise<SheetOutcome> {
  return runSheet({ paymentIntentClientSecret: clientSecret });
}

// "seti_xxx_secret_yyy" -> "seti_xxx" — the id refreshPaymentMethod expects;
// same id Stripe.js hands web's confirmSetup result.
export function setupIntentIdFromClientSecret(clientSecret: string): string {
  return clientSecret.split("_secret")[0];
}

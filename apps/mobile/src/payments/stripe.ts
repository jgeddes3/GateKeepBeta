// SP5b: the ONLY file in this app that touches @stripe/stripe-react-native.
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

// The native PaymentSheet's own appearance config (type-only reference, no
// runtime import, same lazy posture as StripeNative above). This themes
// COLORS only: the sheet cannot be handed the Sora font family, since custom
// fonts are not guaranteed to load across the native sheet, so callers pass
// token-based colors and leave typography at the sheet's own default.
type SheetAppearance = import("@stripe/stripe-react-native").PaymentSheet.AppearanceParams;

// testEnv keys Google Pay off the KEY, not __DEV__: a preview/internal build
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
  // Additive, optional: when undefined the init call below is byte-for-byte
  // the prior behavior (Stripe treats an undefined appearance as a no-op).
  appearance?: SheetAppearance,
): Promise<SheetOutcome> {
  const { initPaymentSheet, presentPaymentSheet } = native();
  const { error: initError } = await initPaymentSheet({ ...SHEET_BASE, ...secret, appearance });
  if (initError) return { ok: false, cancelled: false, message: initError.message ?? null };
  const { error } = await presentPaymentSheet();
  if (!error) return { ok: true };
  // The sheet's own dismissal is a USER CANCEL, not a failure, callers stay
  // silent on it (parity with web, where closing the modal shows no error).
  return { ok: false, cancelled: error.code === "Canceled", message: error.message ?? null };
}

export function runSetupSheet(clientSecret: string, appearance?: SheetAppearance): Promise<SheetOutcome> {
  return runSheet({ setupIntentClientSecret: clientSecret }, appearance);
}
export function runPaymentSheet(clientSecret: string, appearance?: SheetAppearance): Promise<SheetOutcome> {
  return runSheet({ paymentIntentClientSecret: clientSecret }, appearance);
}

// "seti_xxx_secret_yyy" -> "seti_xxx", the id refreshPaymentMethod expects;
// same id Stripe.js hands web's confirmSetup result.
export function setupIntentIdFromClientSecret(clientSecret: string): string {
  return clientSecret.split("_secret")[0];
}

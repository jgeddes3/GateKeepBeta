import type { Appearance } from "@stripe/stripe-js";

// Sub-project 9A task 11 (spec 6.7-6.8): Stripe Elements' own documented
// `appearance` config object (https://stripe.com/docs/elements/appearance-api),
// themed to the gk design tokens. Additive config only, no change to any
// Elements call, callable, or the confirm/submit logic in SaveCardModal.tsx
// / PayPastDueButton.tsx; both mounts just pass `options={{ clientSecret,
// appearance: gkStripeAppearance() }}` instead of `{ clientSecret }` alone.
//
// Stripe's appearance API takes literal color strings, not CSS custom
// properties, and `--gk-*` values differ between the light/dark themes (see
// DESIGN.md's two token tables), so this reads the ALREADY-RESOLVED
// computed value straight off the document at call time (both mount sites
// are inside "use client" components, called from render) rather than
// hardcoding either theme's hex values, which would silently drift from
// globals.css and stop matching whichever theme the page is actually in.
// `typeof window === "undefined"` never true at either call site in
// practice (both are client components that only render post-mount), but
// the guard keeps this callable safely during SSR/a test environment
// without crashing on a missing `document`.
function resolveToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function gkStripeAppearance(): Appearance {
  // Fallbacks are the dark-theme values from DESIGN.md's token table (this
  // app's default), only ever used if a token somehow fails to resolve.
  return {
    theme: "flat",
    variables: {
      colorPrimary: resolveToken("--gk-accent", "#FF6B4A"),
      colorBackground: resolveToken("--gk-surface", "#1A1424"),
      colorText: resolveToken("--gk-text", "#F5F1F8"),
      colorTextSecondary: resolveToken("--gk-muted", "rgba(245,241,248,.62)"),
      colorTextPlaceholder: resolveToken("--gk-muted", "rgba(245,241,248,.62)"),
      colorDanger: resolveToken("--gk-destructive", "#E5484D"),
      fontFamily: "var(--font-sora), sans-serif",
      // DESIGN.md's card/input radius tier (rounded-gk), the same one
      // src/ui/input.tsx and src/ui/select.tsx use.
      borderRadius: "10px",
      spacingUnit: "4px",
    },
    rules: {
      ".Input": { border: `1px solid ${resolveToken("--gk-border", "#2C2438")}` },
      // --gk-focus, not --gk-accent directly: DESIGN.md's own accessibility
      // note (bare ember fails the 3:1 WCAG non-text contrast minimum
      // against light-theme surfaces) is exactly why every other focusable
      // src/ui control reaches for --gk-focus instead; Elements' own inputs
      // get the same fix.
      ".Input:focus": { border: `1px solid ${resolveToken("--gk-focus", "#FF6B4A")}`, boxShadow: "none" },
      ".Label": { color: resolveToken("--gk-text", "#F5F1F8"), fontWeight: "500" },
    },
  };
}

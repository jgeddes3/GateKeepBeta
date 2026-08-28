// Bridges profileId across the Stripe-hosted onboarding redirect.
//
// createOnboardingLink's as-built implementation (functions/src/payments.ts)
// hardcodes the return_url/refresh_url as `${origin}/dashboard/earnings/
// onboarding/return` and `.../refresh` with NO query params, and Stripe
// redirects back to exactly that URL — there is no way for the onboarding
// pages to read a profileId out of the URL itself. sessionStorage survives a
// same-tab redirect out to connect.stripe.com and back (it's scoped to the
// browsing context + origin, not to any one page), so the Earnings page
// stashes the profileId here immediately before navigating away, and the
// onboarding pages read it back. If it's missing (a different tab, storage
// disabled, a stale bookmark) both pages degrade to a generic message with a
// link back to Earnings rather than guessing a profile.
const KEY = "gk:earnings:onboardingProfileId";

export function rememberOnboardingProfileId(profileId: string): void {
  try { window.sessionStorage.setItem(KEY, profileId); } catch { /* degrade to the no-profileId path on read */ }
}
export function readOnboardingProfileId(): string | null {
  try { return window.sessionStorage.getItem(KEY); } catch { return null; }
}
export function clearOnboardingProfileId(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

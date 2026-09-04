// NEXT_PUBLIC_SITE_URL is the explicit override (set it once a production
// domain exists); VERCEL_PROJECT_PRODUCTION_URL is Vercel's own env var,
// available automatically on Vercel deployments without any config. Shared
// by layout.tsx's metadataBase, app/sitemap.ts, app/robots.ts, and the
// public pages' JSON-LD script tags, so all four ways this app needs an
// absolute site URL agree. A missing canonical/og:url/sitemap entry is
// invisible, but one pointing at http://localhost:3000 would ship broken
// SEO/share metadata into production, so an unset or empty value on both
// resolves to null rather than a localhost fallback.
export function getSiteUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit && explicit.length > 0) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel && vercel.length > 0) return `https://${vercel}`;
  return null;
}

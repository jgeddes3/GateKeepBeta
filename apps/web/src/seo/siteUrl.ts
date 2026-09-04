// NEXT_PUBLIC_SITE_URL is the one source of truth for the site's public
// origin (set once a production domain exists). Shared by layout.tsx's
// metadataBase, app/sitemap.ts, app/robots.ts, and the public pages' JSON-LD
// script tags, so all four ways this app needs an absolute site URL agree.
// A missing canonical/og:url/sitemap entry is invisible, but one pointing at
// http://localhost:3000 would ship broken SEO/share metadata into
// production, so an unset or empty value resolves to null rather than a
// fallback guess.
export function getSiteUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SITE_URL;
  return url && url.length > 0 ? url : null;
}

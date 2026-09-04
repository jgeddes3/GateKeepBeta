// Pure, framework-agnostic sitemap-entry builder: no Next.js import (the
// MetadataRoute.Sitemap shape is assembled by app/sitemap.ts, the one place
// that actually needs it), so this stays trivially unit-testable and has no
// dependency on the App Router runtime.

export type SitemapEntry = {
  url: string;
  lastModified?: Date;
  changeFrequency?: "weekly";
};

export function buildSitemapEntries({ siteUrl, profiles, events, now }: {
  siteUrl: string | null;
  profiles: { handle: string; updatedAt: number }[];
  events: { id: string; updatedAt: number; endsAt: number }[];
  now: number;
}): SitemapEntry[] {
  if (!siteUrl) return [];
  const staticEntries: SitemapEntry[] = [
    { url: `${siteUrl}/`, changeFrequency: "weekly" },
    { url: `${siteUrl}/join`, changeFrequency: "weekly" },
  ];
  const profileEntries: SitemapEntry[] = profiles.map((p) => ({
    url: `${siteUrl}/@${p.handle}`,
    lastModified: new Date(p.updatedAt),
  }));
  const eventEntries: SitemapEntry[] = events
    .filter((e) => e.endsAt >= now)
    .map((e) => ({ url: `${siteUrl}/e/${e.id}`, lastModified: new Date(e.updatedAt) }));
  return [...staticEntries, ...profileEntries, ...eventEntries];
}

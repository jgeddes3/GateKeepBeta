import type { MetadataRoute } from "next";
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { getServerFirebase } from "../src/lib/firebase-server";
import { getSiteUrl } from "../src/seo/siteUrl";
import { buildSitemapEntries } from "../src/seo/sitemapEntries";
import type { ProfileDoc, EventDoc } from "@gatekeep/shared";

// Bounds repeat Firestore reads to once an hour instead of once per crawl
// hit, same ISR rationale as the public pages themselves (see
// app/u/[handle]/page.tsx's own comment on `revalidate`).
export const revalidate = 3600;

const SITEMAP_QUERY_LIMIT = 5000;

async function fetchProfiles(): Promise<{ handle: string; updatedAt: number }[]> {
  const { db } = getServerFirebase();
  // Two queries, one per profile type: served by the existing
  // (type, status, updatedAt desc) composite index (firestore.indexes.json).
  // A combined `type in [...]` query would need its own index and would
  // still cost the same number of reads, so this stays as two plain
  // equality queries rather than one `in` query.
  const [musicians, curators] = await Promise.all(
    (["musician", "curator"] as const).map((type) => getDocs(query(
      collection(db, "profiles"),
      where("type", "==", type),
      where("status", "==", "approved"),
      orderBy("updatedAt", "desc"),
      limit(SITEMAP_QUERY_LIMIT),
    ))),
  );
  return [...musicians.docs, ...curators.docs].map((d) => {
    const p = d.data() as ProfileDoc;
    return { handle: p.handle, updatedAt: p.updatedAt };
  });
}

async function fetchEvents(now: number): Promise<{ id: string; updatedAt: number; endsAt: number }[]> {
  const { db } = getServerFirebase();
  // Served by the existing (status, endsAt) composite index.
  const snap = await getDocs(query(
    collection(db, "events"),
    where("status", "==", "published"),
    where("endsAt", ">=", now),
    orderBy("endsAt"),
    limit(SITEMAP_QUERY_LIMIT),
  ));
  return snap.docs.map((d) => {
    const e = d.data() as EventDoc;
    return { id: d.id, updatedAt: e.updatedAt, endsAt: e.endsAt };
  });
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();
  if (!siteUrl) return [];
  const now = Date.now();
  const [profiles, events] = await Promise.all([fetchProfiles(), fetchEvents(now)]);
  return buildSitemapEntries({ siteUrl, profiles, events, now });
}

import type { MetadataRoute } from "next";
import { getSiteUrl } from "../src/seo/siteUrl";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();
  return {
    rules: [{
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/admin", "/tickets", "/discover", "/search", "/sign-in", "/design", "/booking"],
    }],
    ...(siteUrl ? { sitemap: `${siteUrl}/sitemap.xml` } : {}),
  };
}

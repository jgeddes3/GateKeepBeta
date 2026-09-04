import { describe, it, expect } from "vitest";
import { buildSitemapEntries } from "./sitemapEntries";

describe("buildSitemapEntries", () => {
  it("returns nothing without a site url and the static plus dynamic entries with one", () => {
    expect(buildSitemapEntries({ siteUrl: null, profiles: [], events: [], now: 10 })).toEqual([]);
    const out = buildSitemapEntries({
      siteUrl: "https://x.test", now: 10,
      profiles: [{ handle: "owls", updatedAt: 5 }],
      events: [{ id: "e1", updatedAt: 6, endsAt: 20 }, { id: "old", updatedAt: 1, endsAt: 5 }],
    });
    expect(out.map((e) => e.url)).toEqual(["https://x.test/", "https://x.test/join", "https://x.test/@owls", "https://x.test/e/e1"]);
    expect(out[2].lastModified).toEqual(new Date(5));
  });
});

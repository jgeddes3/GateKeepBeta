import { describe, it, expect, afterEach, vi } from "vitest";
import { getSiteUrl } from "./siteUrl";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSiteUrl", () => {
  it("returns null when neither env var is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(getSiteUrl()).toBeNull();
  });

  it("prefers the explicit override when both are set", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gatekeep.example");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "gatekeep.vercel.app");
    expect(getSiteUrl()).toBe("https://gatekeep.example");
  });

  it("falls back to the Vercel production URL when only that is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "gatekeep.vercel.app");
    expect(getSiteUrl()).toBe("https://gatekeep.vercel.app");
  });
});

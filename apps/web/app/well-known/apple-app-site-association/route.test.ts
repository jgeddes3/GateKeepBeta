import { describe, it, expect, afterEach, vi } from "vitest";
import { GET } from "./route";

// SP11 (spec 3.1): the binding rule this test exists to prove is "nothing
// fake ships" -- a half-filled AASA claim (one of the two env values unset)
// must 404, never a 200 with a bogus/placeholder appID.
describe("GET /.well-known/apple-app-site-association", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s when both env values are unset", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "");
    vi.stubEnv("IOS_BUNDLE_ID", "");
    const res = GET();
    expect(res.status).toBe(404);
  });

  it("404s when only one env value is set", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "ABCDE12345");
    vi.stubEnv("IOS_BUNDLE_ID", "");
    expect(GET().status).toBe(404);
  });

  it("returns the applinks JSON with Content-Type application/json when both are set", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "ABCDE12345");
    vi.stubEnv("IOS_BUNDLE_ID", "com.gatekeep.app");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({
      applinks: {
        details: [{
          appIDs: ["ABCDE12345.com.gatekeep.app"],
          components: [{ "/": "/e/*" }, { "/": "/u/*" }],
        }],
      },
    });
  });
});

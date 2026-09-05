import { describe, it, expect, afterEach, vi } from "vitest";
import { GET } from "./route";

// SP11 (spec 3.1): the binding rule this test exists to prove is "nothing
// fake ships" -- a half-filled assetlinks claim (one of the two env values
// unset) must 404, never a 200 with a bogus/placeholder fingerprint.
describe("GET /.well-known/assetlinks.json", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s when both env values are unset", async () => {
    vi.stubEnv("ANDROID_PACKAGE", "");
    vi.stubEnv("ANDROID_CERT_SHA256", "");
    expect(GET().status).toBe(404);
  });

  it("404s when only one env value is set", async () => {
    vi.stubEnv("ANDROID_PACKAGE", "com.gatekeep.app");
    vi.stubEnv("ANDROID_CERT_SHA256", "");
    expect(GET().status).toBe(404);
  });

  it("returns the assetlinks JSON with Content-Type application/json when both are set", async () => {
    vi.stubEnv("ANDROID_PACKAGE", "com.gatekeep.app");
    vi.stubEnv("ANDROID_CERT_SHA256", "AA:BB:CC");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "com.gatekeep.app", sha256_cert_fingerprints: ["AA:BB:CC"] },
    }]);
  });
});

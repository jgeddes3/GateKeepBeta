import { describe, it, expect, vi } from "vitest";
import { HttpsError } from "firebase-functions/v2/https";
import {
  StubGeocoder,
  GoogleGeocoder,
  getGeocoder,
  coarsen,
  parseGoogleResponse,
  GOOGLE_GEOCODE_TIMEOUT_MS,
  type GeocodeResult,
} from "../src/geocode.js";

describe("StubGeocoder", () => {
  const geocoder = new StubGeocoder();

  it("is deterministic, same address twice produces identical result", async () => {
    const addr = "1600 Pennsylvania Avenue NW, Washington, DC";
    const result1 = await geocoder.geocode(addr);
    const result2 = await geocoder.geocode(addr);
    expect(result1).toEqual(result2);
  });

  it("distinct addresses produce different coordinates", async () => {
    const result1 = await geocoder.geocode("1600 Pennsylvania Avenue NW, Washington, DC");
    const result2 = await geocoder.geocode("1 Apple Park Way, Cupertino, CA");
    expect(result1?.lat).not.toBe(result2?.lat);
    expect(result1?.lng).not.toBe(result2?.lng);
  });

  it("parses city from last comma segment (trimmed)", async () => {
    const result = await geocoder.geocode("123 Main St, Springfield, IL");
    expect(result?.city).toBe("IL");
  });

  it("parses neighborhood from second-to-last comma segment", async () => {
    const result = await geocoder.geocode("123 Main St, Springfield, IL");
    expect(result?.neighborhood).toBe("Springfield");
  });

  it("sets neighborhood to null for single-segment addresses", async () => {
    const result = await geocoder.geocode("NewYork");
    expect(result?.neighborhood).toBeNull();
  });
});

describe("coarsen", () => {
  it("rounds lat/lng to exactly 2 decimal places", () => {
    const input: GeocodeResult = {
      lat: 40.71382,
      lng: -74.00713,
      neighborhood: "Manhattan",
      city: "NY",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(40.71);
    expect(result.lng).toBe(-74.01);
  });

  it("rounds positive coordinates correctly", () => {
    const input: GeocodeResult = {
      lat: 37.7749,
      lng: 122.4194,
      neighborhood: "San Francisco",
      city: "CA",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(37.77);
    expect(result.lng).toBe(122.42);
  });

  it("rounds negative coordinates correctly", () => {
    const input: GeocodeResult = {
      lat: -33.8688,
      lng: 151.2093,
      neighborhood: "Sydney",
      city: "NSW",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(-33.87);
    expect(result.lng).toBe(151.21);
  });

  it("uses symmetric rounding for positive boundary case (73.985)", () => {
    const input: GeocodeResult = {
      lat: 73.985,
      lng: 0,
      neighborhood: null,
      city: "Test",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(73.99);
  });

  it("uses symmetric rounding for negative boundary case (-73.985)", () => {
    const input: GeocodeResult = {
      lat: -73.985,
      lng: 0,
      neighborhood: null,
      city: "Test",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(-73.99);
  });

  it("rounds non-boundary negative coordinates symmetrically", () => {
    const input: GeocodeResult = {
      lat: -40.71382,
      lng: -74.00713,
      neighborhood: "Test",
      city: "Test",
    };
    const result = coarsen(input);
    expect(result.lat).toBe(-40.71);
    expect(result.lng).toBe(-74.01);
  });
});

describe("getGeocoder", () => {
  it("returns StubGeocoder inside the emulator when GEOCODER_PROVIDER is unset", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "true");
    vi.stubEnv("GEOCODER_PROVIDER", undefined);
    try {
      expect(getGeocoder()).toBeInstanceOf(StubGeocoder);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed outside the emulator when GEOCODER_PROVIDER is unset", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", undefined);
    vi.stubEnv("GEOCODER_PROVIDER", undefined);
    try {
      expect(() => getGeocoder()).toThrow("Geocoder is not configured.");
      let code: string | undefined;
      try { getGeocoder(); } catch (e) { code = (e as HttpsError).code; }
      expect(code).toBe("failed-precondition");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed outside the emulator when GEOCODER_PROVIDER names anything other than google", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "false");
    vi.stubEnv("GEOCODER_PROVIDER", "stub");
    try {
      expect(() => getGeocoder()).toThrow("Geocoder is not configured.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns GoogleGeocoder when GEOCODER_PROVIDER=google, in or out of the emulator", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", undefined);
    vi.stubEnv("GEOCODER_PROVIDER", "google");
    vi.stubEnv("GEOCODER_API_KEY", "test-key");
    try {
      expect(getGeocoder()).toBeInstanceOf(GoogleGeocoder);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws when GEOCODER_PROVIDER=google without GEOCODER_API_KEY", () => {
    vi.stubEnv("GEOCODER_PROVIDER", "google");
    vi.stubEnv("GEOCODER_API_KEY", undefined);
    try {
      expect(() => getGeocoder()).toThrow("GEOCODER_PROVIDER=google requires GEOCODER_API_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("GoogleGeocoder", () => {
  const okBody = {
    status: "OK",
    results: [{
      geometry: { location: { lat: 30.2672, lng: -97.7431 } },
      address_components: [
        { long_name: "Downtown", types: ["neighborhood"] },
        { long_name: "Austin", types: ["locality"] },
      ],
    }],
  };

  it("passes a timeout AbortSignal to fetch and parses the body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(okBody), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new GoogleGeocoder("test-key").geocode("1 Main St, Austin, TX");
      expect(result?.city).toBe("Austin");
      expect(result?.neighborhood).toBe("Downtown");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns a hung upstream into a timeout Error after timeoutMs", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new GoogleGeocoder("test-key", 20).geocode("1 Main St, Austin, TX"))
        .rejects.toThrow("Google Geocoding API timed out after 20ms");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes the production timeout as 10 seconds", () => {
    expect(GOOGLE_GEOCODE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("parseGoogleResponse", () => {
  it("parses a successful Google Geocoding API response", () => {
    const response = {
      results: [
        {
          geometry: { location: { lat: 40.7128, lng: -74.006 } },
          address_components: [
            { long_name: "Manhattan", types: ["neighborhood"] },
            { long_name: "New York", types: ["locality"] },
            { long_name: "New York", types: ["administrative_area_level_1"] },
          ],
        },
      ],
      status: "OK",
    };
    const result = parseGoogleResponse(response);
    expect(result).not.toBeNull();
    expect(result?.lat).toBe(40.7128);
    expect(result?.lng).toBe(-74.006);
    expect(result?.neighborhood).toBe("Manhattan");
    expect(result?.city).toBe("New York");
  });

  it("returns null for ZERO_RESULTS status", () => {
    const response = {
      results: [],
      status: "ZERO_RESULTS",
    };
    const result = parseGoogleResponse(response);
    expect(result).toBeNull();
  });

  it("returns null neighborhood when address_components lacks neighborhood", () => {
    const response = {
      results: [
        {
          geometry: { location: { lat: 40.7128, lng: -74.006 } },
          address_components: [
            { long_name: "New York", types: ["locality"] },
            { long_name: "New York", types: ["administrative_area_level_1"] },
          ],
        },
      ],
      status: "OK",
    };
    const result = parseGoogleResponse(response);
    expect(result).not.toBeNull();
    expect(result?.neighborhood).toBeNull();
  });

  it("throws an error for non-OK status", () => {
    const response = {
      results: [],
      status: "REQUEST_DENIED",
    };
    expect(() => parseGoogleResponse(response)).toThrow();
  });

  it("returns null (not a throw) when no locality or administrative_area_level_1 is present, e.g. a plus code", () => {
    const response = {
      status: "OK",
      results: [{
        geometry: { location: { lat: 30.2672, lng: -97.7431 } },
        address_components: [{ long_name: "8FW4V75V+8Q", types: ["plus_code"] }],
      }],
    };
    expect(parseGoogleResponse(response)).toBeNull();
  });
});

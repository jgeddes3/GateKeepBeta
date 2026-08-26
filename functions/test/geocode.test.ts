import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  StubGeocoder,
  GoogleGeocoder,
  getGeocoder,
  coarsen,
  parseGoogleResponse,
  type GeocodeResult,
} from "../src/geocode.js";

describe("StubGeocoder", () => {
  const geocoder = new StubGeocoder();

  it("is deterministic — same address twice produces identical result", async () => {
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
});

describe("getGeocoder", () => {
  let originalProvider: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalProvider = process.env.GEOCODER_PROVIDER;
    originalApiKey = process.env.GEOCODER_API_KEY;
  });

  afterEach(() => {
    process.env.GEOCODER_PROVIDER = originalProvider;
    process.env.GEOCODER_API_KEY = originalApiKey;
  });

  it("returns StubGeocoder when GEOCODER_PROVIDER is unset", () => {
    delete process.env.GEOCODER_PROVIDER;
    const geocoder = getGeocoder();
    expect(geocoder).toBeInstanceOf(StubGeocoder);
  });

  it("returns GoogleGeocoder when GEOCODER_PROVIDER=google", () => {
    process.env.GEOCODER_PROVIDER = "google";
    process.env.GEOCODER_API_KEY = "test-key";
    const geocoder = getGeocoder();
    expect(geocoder).toBeInstanceOf(GoogleGeocoder);
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
});

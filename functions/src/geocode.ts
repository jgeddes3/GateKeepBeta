/**
 * Geocoding module — stub for tests/emulator, Google Geocoding API for production.
 * The coarsen function provides neighborhood-level (~1.1 km cell) pins without
 * needing polygon data; a real centroid source can replace it later without
 * schema change.
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  neighborhood: string | null;
  city: string;
}

export interface Geocoder {
  geocode(address: string): Promise<GeocodeResult | null>;
}

/**
 * Deterministic stub geocoder for development/testing.
 * Hashes the address into stable lat/lng within a city bounding box.
 * City is parsed from the last comma segment; neighborhood from the second-to-last.
 */
export class StubGeocoder implements Geocoder {
  async geocode(address: string): Promise<GeocodeResult | null> {
    // Parse city (last comma segment, trimmed) and neighborhood (second-to-last, trimmed if exists)
    const segments = address.split(",").map((s) => s.trim());
    const city = segments.length > 0 ? segments[segments.length - 1] : "";
    const neighborhood = segments.length > 1 ? segments[segments.length - 2] : null;

    // Deterministic hash: use a simple polynomial rolling hash to generate lat/lng.
    // Bounds: roughly US-centric (25–50°N, 66–125°W) — a reasonable default.
    let hash = 5381;
    for (let i = 0; i < address.length; i++) {
      hash = ((hash << 5) + hash) ^ address.charCodeAt(i);
    }
    hash = Math.abs(hash);

    // Scale hash to lat/lng range
    const lat = 25 + ((hash % 100000) / 100000) * 25; // 25–50°N
    const lng = -125 + ((Math.floor(hash / 100000) % 100000) / 100000) * 59; // 66–125°W

    return { lat, lng, neighborhood, city };
  }
}

/**
 * Google Geocoding API adapter (skeleton).
 * Requires GEOCODER_API_KEY environment variable.
 */
export class GoogleGeocoder implements Geocoder {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Google Geocoding API returned ${response.status}: ${response.statusText}`);
    }

    const json = await response.json() as unknown;
    return parseGoogleResponse(json);
  }
}

/**
 * Parses a Google Geocoding API response JSON.
 * Returns null for ZERO_RESULTS; throws Error for non-OK statuses.
 * Extracts lat/lng from geometry, neighborhood from address_components (or null),
 * and city from address_components (locality or administrative_area_level_1).
 */
export function parseGoogleResponse(json: unknown): GeocodeResult | null {
  if (typeof json !== "object" || json === null) {
    throw new Error("parseGoogleResponse: invalid JSON object");
  }

  const data = json as Record<string, unknown>;
  const status = data.status as string | undefined;

  if (status === "ZERO_RESULTS") {
    return null;
  }

  if (status !== "OK") {
    throw new Error(`Google Geocoding API error: ${status || "unknown status"}`);
  }

  const results = data.results as unknown[] | undefined;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const firstResult = results[0] as Record<string, unknown> | undefined;
  if (!firstResult) {
    return null;
  }

  // Extract lat/lng
  const geometry = firstResult.geometry as Record<string, unknown> | undefined;
  const location = geometry?.location as Record<string, unknown> | undefined;
  const lat = location?.lat as number | undefined;
  const lng = location?.lng as number | undefined;

  if (lat === undefined || lng === undefined) {
    throw new Error("parseGoogleResponse: missing lat/lng in geometry.location");
  }

  // Extract city and neighborhood from address_components
  const addressComponents = firstResult.address_components as unknown[] | undefined;
  if (!Array.isArray(addressComponents)) {
    throw new Error("parseGoogleResponse: missing address_components");
  }

  let neighborhood: string | null = null;
  let city: string | null = null;

  for (const component of addressComponents) {
    const comp = component as Record<string, unknown> | undefined;
    const types = comp?.types as string[] | undefined;
    const longName = comp?.long_name as string | undefined;

    if (!Array.isArray(types) || !longName) continue;

    if (types.includes("neighborhood")) {
      neighborhood = longName;
    }
    if (types.includes("locality")) {
      city = longName;
    }
    // Fallback: administrative_area_level_1 if locality not found
    if (!city && types.includes("administrative_area_level_1")) {
      city = longName;
    }
  }

  if (!city) {
    throw new Error("parseGoogleResponse: could not extract city from address_components");
  }

  return { lat, lng, neighborhood, city };
}

/**
 * Returns a Geocoder instance based on environment configuration.
 * Uses StubGeocoder by default (dev/test); GoogleGeocoder when
 * GEOCODER_PROVIDER=google + GEOCODER_API_KEY is set.
 */
export function getGeocoder(): Geocoder {
  if (process.env.GEOCODER_PROVIDER === "google") {
    const apiKey = process.env.GEOCODER_API_KEY;
    if (!apiKey) {
      throw new Error("GEOCODER_PROVIDER=google requires GEOCODER_API_KEY");
    }
    return new GoogleGeocoder(apiKey);
  }
  return new StubGeocoder();
}

/**
 * Coarsen a geocode result to 2 decimal places (~1.1 km cell).
 * Uses symmetric round-half-away-from-zero to ensure hemisphere-independent
 * neighborhood-cell bucketing: both +73.985 and -73.985 round to ±73.99.
 * Floating-point precision (e.g., Math.abs(-73.985)*100 ≈ 7398.4999...) is
 * handled with a small epsilon nudge.
 */
export function coarsen(result: GeocodeResult): { lat: number; lng: number } {
  const roundSymmetric = (v: number): number => Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-9) / 100;
  return {
    lat: roundSymmetric(result.lat),
    lng: roundSymmetric(result.lng),
  };
}

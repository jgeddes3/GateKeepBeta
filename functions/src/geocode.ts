/**
 * Geocoding module, stub for tests/emulator, Google Geocoding API for production.
 * The coarsen function provides neighborhood-level (~1.1 km cell) pins without
 * needing polygon data; a real centroid source can replace it later without
 * schema change.
 */

import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

// P5: GEOCODER_API_KEY as a Secret Manager-backed param, the modern (v2)
// replacement for reading a bare, unmanaged process.env value in
// production. Declaring it here (not inline in getGeocoder()) lets every
// onCall handler that can reach geocode() import the SAME SecretParam and
// list it in its own `secrets: [geocoderApiKey]` option, which is what
// actually makes Cloud Functions fetch the secret from Secret Manager and
// inject it as an env var at invocation time, a defineSecret() that no
// handler ever declares in `secrets` never gets populated in production.
export const geocoderApiKey = defineSecret("GEOCODER_API_KEY");

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
    // Bounds: roughly US-centric (25–50°N, 66–125°W), a reasonable default.
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

// SP10 Task 17: a hung upstream must not hold a callable open to its own 60 s
// limit. AbortSignal.timeout is native on Node 22 (branch A's runtime).
export const GOOGLE_GEOCODE_TIMEOUT_MS = 10_000;

/**
 * Google Geocoding API adapter.
 * Requires GEOCODER_API_KEY (Secret Manager in production, env locally).
 */
export class GoogleGeocoder implements Geocoder {
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = GOOGLE_GEOCODE_TIMEOUT_MS) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Google Geocoding API timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    }
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

  // SP10 Task 17 (sp3 #3): plus codes, rural and some non-US results carry
  // neither a locality nor a level-1 area. Every caller already handles null
  // as "could not locate" (GEOCODE_FAILURE_MESSAGE); a throw here surfaced as
  // an opaque internal error instead.
  if (!city) {
    return null;
  }

  return { lat, lng, neighborhood, city };
}

/**
 * Returns a Geocoder instance based on environment configuration.
 * GEOCODER_PROVIDER=google + GEOCODER_API_KEY selects GoogleGeocoder.
 * Anything else selects the deterministic stub, but ONLY inside the
 * Functions emulator (SP10 Task 17, sp3 #2): a production deploy that
 * forgets the provider must fail loudly rather than write hash-derived
 * coordinates onto world-readable profile and gig docs.
 */
export function getGeocoder(): Geocoder {
  if (process.env.GEOCODER_PROVIDER === "google") {
    // P5: geocoderApiKey.value() reads the Secret Manager-backed value that
    // Cloud Functions injects as an env var in production once a handler
    // declares `secrets: [geocoderApiKey]` (see curator.ts/gigs.ts/
    // gigSeries.ts's onCall options). The Functions emulator does not
    // provision Secret Manager secrets by default, so .value() legitimately
    // resolves to "" there; the `|| process.env.GEOCODER_API_KEY` fallback
    // keeps GEOCODER_PROVIDER=google testable locally against a real key
    // (set via a functions/.env file or the shell) without requiring a
    // `.secret.local` file or a deploy. Both reads ultimately look at the
    // same underlying env var name, so this is deliberately redundant, not
    // two different sources of truth; see README's geocoder setup section.
    const apiKey = geocoderApiKey.value() || process.env.GEOCODER_API_KEY;
    if (!apiKey) {
      throw new Error("GEOCODER_PROVIDER=google requires GEOCODER_API_KEY");
    }
    return new GoogleGeocoder(apiKey);
  }
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw new HttpsError("failed-precondition", "Geocoder is not configured.");
  }
  return new StubGeocoder();
}

// Logged once per cold start so a misconfigured deploy is visible in Cloud
// Logging before the first geocode call fails.
console.info(
  `geocode: provider=${process.env.GEOCODER_PROVIDER === "google" ? "google" : "stub"} emulator=${process.env.FUNCTIONS_EMULATOR === "true"}`);

// ---------- S2: per-uid daily geocode budget ----------

const GEOCODE_DAILY_BUDGET = 50;

// Per-uid ceiling on actual geocode() calls (S2), reachable from every
// address-resolving onCall (updateCuratorProfile, createGig/updateGig,
// createSeries/updateSeries), so a runaway or abusive client hammering any
// of them with distinct addresses could otherwise burn through the
// production geocoding provider's quota/cost on one uid's behalf. Keyed by
// UTC calendar date (not a rolling 24h window): geocodeBudgets/{uid} simply
// gets overwritten with a fresh {date, count: 1} the moment today's date key
// no longer matches what's stored, so the counter resets cleanly at day
// boundaries with no separate cleanup job. Transactional (not a bare
// read-then-write) so two concurrent geocode-triggering calls from the same
// uid can't both read count=49 and both squeak under the ceiling.
export async function consumeGeocodeBudget(uid: string): Promise<void> {
  const db = getFirestore();
  const dateKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const ref = db.doc(`geocodeBudgets/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const count = data?.date === dateKey ? ((data.count as number | undefined) ?? 0) : 0;
    if (count >= GEOCODE_DAILY_BUDGET) {
      throw new HttpsError("resource-exhausted", "Too many location updates today.");
    }
    tx.set(ref, { date: dateKey, count: count + 1 });
  });
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

import { describe, it, expect, vi } from "vitest";
import { CachedGeocoder } from "../geocoding";
import type { LegalDescription, GeocodeResult, LegalDescriptionGeocoder } from "../types";

function makeResult(matchMethod: GeocodeResult["matchMethod"]): GeocodeResult {
  return {
    canonicalIdentifier: "A-1", centroidLatitude: 31.5, centroidLongitude: -97.5,
    geometry: null, geometryType: null, sourceProvider: "TEST", sourceRecordId: null,
    sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt: new Date().toISOString(),
    matchMethod, confidence: matchMethod === "EXACT_SURVEY" ? 0.9 : 0, warnings: [],
  };
}

const testDescription: LegalDescription = {
  jurisdiction: "TX_LAND_GRID", county: "McLennan", abstractNumber: "693", canonicalAbstractNumber: "A-693",
  surveyName: null, originalGrantee: null, block: null, section: null, subdivision: null, tractNumber: null,
  grossAcres: null, metesAndBounds: null, sourceDocumentId: null, sourcePage: null, extractionConfidence: 0.8, humanVerified: false,
};

describe("CachedGeocoder", () => {
  it("calls the inner geocoder only once for repeated identical requests within the TTL", async () => {
    const inner: LegalDescriptionGeocoder = { geocode: vi.fn().mockResolvedValue(makeResult("EXACT_SURVEY")) };
    const cached = new CachedGeocoder(inner);

    await cached.geocode(testDescription);
    await cached.geocode(testDescription);
    await cached.geocode(testDescription);

    expect(inner.geocode).toHaveBeenCalledTimes(1);
    expect(cached.cacheSize()).toBe(1);
  });

  it("calls the inner geocoder again for a genuinely different legal description", async () => {
    const inner: LegalDescriptionGeocoder = { geocode: vi.fn().mockResolvedValue(makeResult("EXACT_SURVEY")) };
    const cached = new CachedGeocoder(inner);

    await cached.geocode(testDescription);
    await cached.geocode({ ...testDescription, county: "Midland" });

    expect(inner.geocode).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after a successful result's TTL expires", async () => {
    const inner: LegalDescriptionGeocoder = { geocode: vi.fn().mockResolvedValue(makeResult("EXACT_SURVEY")) };
    const cached = new CachedGeocoder(inner, { providerTimeoutMs: 1, maxCandidatesToEnrich: 1, maxRadiusMiles: 1, defaultRadiusMiles: 1, geocodeCacheTtlMs: 10, geocodeFailureCacheTtlMs: 5 });

    await cached.geocode(testDescription);
    await new Promise(r => setTimeout(r, 20));
    await cached.geocode(testDescription);

    expect(inner.geocode).toHaveBeenCalledTimes(2);
  });

  it("caches a failed geocode (UNMAPPABLE) for a much shorter TTL than a successful one — never cached indefinitely", async () => {
    const inner: LegalDescriptionGeocoder = { geocode: vi.fn().mockResolvedValue(makeResult("UNMAPPABLE")) };
    const cached = new CachedGeocoder(inner, { providerTimeoutMs: 1, maxCandidatesToEnrich: 1, maxRadiusMiles: 1, defaultRadiusMiles: 1, geocodeCacheTtlMs: 10_000, geocodeFailureCacheTtlMs: 10 });

    await cached.geocode(testDescription);
    await new Promise(r => setTimeout(r, 20)); // past the short failure TTL, well within the long success TTL
    await cached.geocode(testDescription);

    expect(inner.geocode).toHaveBeenCalledTimes(2); // re-fetched, proving the failure wasn't cached for the long success TTL
  });

  it("also caches MANUAL_REVIEW_REQUIRED under the short failure TTL, not the long success TTL", async () => {
    const inner: LegalDescriptionGeocoder = { geocode: vi.fn().mockResolvedValue(makeResult("MANUAL_REVIEW_REQUIRED")) };
    const cached = new CachedGeocoder(inner, { providerTimeoutMs: 1, maxCandidatesToEnrich: 1, maxRadiusMiles: 1, defaultRadiusMiles: 1, geocodeCacheTtlMs: 10_000, geocodeFailureCacheTtlMs: 10 });

    await cached.geocode(testDescription);
    await new Promise(r => setTimeout(r, 20));
    await cached.geocode(testDescription);

    expect(inner.geocode).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { geocodeTexasLegalDescription, getAbstractPrefixByCounty, normalizeSurveyName, TX_COUNTY_ABSTRACT_PREFIX } from "../providers/texas-land-grid";
import { geocodePlssLegalDescription } from "../providers/plss";
import { OffsetAnalyticsGeocoder } from "../geocoding";
import type { TexasLegalDescription, PlssLegalDescription } from "../types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const otlsAbstract309693 = fs.readFileSync(path.join(__dirname, "fixtures/otls-abstract-309693.json"), "utf8");

function mockFetchOnce(body: string, ok = true) {
  globalThis.fetch = (async () => ({ ok, json: async () => JSON.parse(body) })) as unknown as typeof fetch;
}

const baseTxDesc: TexasLegalDescription = {
  jurisdiction: "TX_LAND_GRID", county: "McLennan", abstractNumber: "693", canonicalAbstractNumber: "A-693",
  surveyName: null, originalGrantee: null, block: null, section: null, subdivision: null, tractNumber: null,
  grossAcres: null, metesAndBounds: null, sourceDocumentId: null, sourcePage: null, extractionConfidence: 0.8, humanVerified: false,
};

describe("TX_COUNTY_ABSTRACT_PREFIX — the real gap found in Phase 0 is fixed", () => {
  it("includes McLennan County at prefix 309, confirmed live against OTLS", () => {
    expect(TX_COUNTY_ABSTRACT_PREFIX["mclennan"]).toBe("309");
  });

  it("covers all 254 Texas counties", () => {
    // Aliases (mcculloch/mc culloch, mcmullen/mc mullen) map to the same code —
    // count unique codes, not unique keys.
    const uniqueCodes = new Set(Object.values(TX_COUNTY_ABSTRACT_PREFIX));
    expect(uniqueCodes.size).toBe(254);
  });
});

describe("normalizeSurveyName", () => {
  it("normalizes real railroad-grant survey name variants to the same canonical form", () => {
    expect(normalizeSurveyName("H&TC")).toBe("H&TC RR CO");
    expect(normalizeSurveyName("H.T.C.")).toBe("H&TC RR CO");
    expect(normalizeSurveyName("Houston and Texas Central")).toBe("H&TC RR CO");
  });
});

describe("geocodeTexasLegalDescription", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns UNMAPPABLE (not a guess) for an unrecognized county", async () => {
    const result = await geocodeTexasLegalDescription({ ...baseTxDesc, county: "NotARealCounty" });
    expect(result.matchMethod).toBe("UNMAPPABLE");
    expect(result.centroidLatitude).toBeNull();
  });

  it("returns real WGS84 polygon geometry on an exact abstract match (real captured OTLS fixture)", async () => {
    mockFetchOnce(otlsAbstract309693);
    const result = await geocodeTexasLegalDescription(baseTxDesc); // no survey name supplied — abstract number alone is the identifying anchor here
    expect(result.matchMethod).toBe("ABSTRACT_MATCH");
    expect(result.geometryType).toBe("Polygon");
    expect(result.spatialReferenceSystem).toBe("EPSG:4326");
    // Real McLennan/Waco-area coordinates, not fabricated — from the live-captured fixture.
    const coords = result.geometry!.coordinates as number[][][];
    const [lng, lat] = coords[0][0];
    expect(lng).toBeCloseTo(-97.34, 0);
    expect(lat).toBeCloseTo(31.4, 0);
  });

  it("upgrades to EXACT_SURVEY when the survey name genuinely matches the record's grantee, quirky real-world formatting included", async () => {
    mockFetchOnce(otlsAbstract309693);
    // The real OTLS record's LEVEL1_SUR is "O`ROUKE, L" (backtick, trailing
    // initial — a genuine government-data quirk, not a fabrication). The
    // generic fallback normalizer strips noise words/whitespace and
    // uppercases both sides, so an exact-text match still resolves.
    const result = await geocodeTexasLegalDescription({ ...baseTxDesc, surveyName: "O`ROUKE, L" });
    expect(result.matchMethod).toBe("EXACT_SURVEY");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("returns ABSTRACT_MATCH with a warning when the abstract matches but the survey name doesn't", async () => {
    mockFetchOnce(otlsAbstract309693);
    const result = await geocodeTexasLegalDescription({ ...baseTxDesc, surveyName: "Completely Different Name" });
    expect(result.matchMethod).toBe("ABSTRACT_MATCH");
    expect(result.warnings.some(w => w.code === "SURVEY_NAME_MISMATCH")).toBe(true);
  });

  it("returns MANUAL_REVIEW_REQUIRED (not a fabricated pick) when multiple polygons match", async () => {
    const twoFeatures = JSON.stringify({
      ...JSON.parse(otlsAbstract309693),
      features: [...JSON.parse(otlsAbstract309693).features, ...JSON.parse(otlsAbstract309693).features],
    });
    mockFetchOnce(twoFeatures);
    const result = await geocodeTexasLegalDescription(baseTxDesc);
    expect(result.matchMethod).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("returns MANUAL_REVIEW_REQUIRED, not UNMAPPABLE, when the county is valid but nothing matches (still worth a human look)", async () => {
    mockFetchOnce(JSON.stringify({ features: [] }));
    const result = await geocodeTexasLegalDescription({ ...baseTxDesc, abstractNumber: null, canonicalAbstractNumber: null, surveyName: null });
    expect(result.matchMethod).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("never throws when the network call fails", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    await expect(geocodeTexasLegalDescription(baseTxDesc)).resolves.toBeDefined();
  });
});

describe("geocodePlssLegalDescription", () => {
  const basePlss: PlssLegalDescription = {
    jurisdiction: "PLSS", state: "CO", principalMeridian: "6th PM", townshipNumber: 5, townshipDirection: "N",
    rangeNumber: 65, rangeDirection: "W", section: 20, aliquot: null, county: null,
    sourceDocumentId: null, sourcePage: null, extractionConfidence: 0.6, humanVerified: false,
  };
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns UNMAPPABLE for Texas — Texas is not federal PLSS, this must never silently produce a wrong coordinate", async () => {
    const result = await geocodePlssLegalDescription({ ...basePlss, state: "TX" });
    expect(result.matchMethod).toBe("UNMAPPABLE");
    expect(result.warnings.some(w => w.code === "TEXAS_NOT_PLSS")).toBe(true);
    expect(result.centroidLatitude).toBeNull();
  });

  it("uses the BLM centroid when the live API returns one, labeled CENTROID_ONLY (not a polygon claim)", async () => {
    mockFetchOnce(JSON.stringify({ features: [{ centroid: { x: -104.8, y: 39.5 } }] }));
    const result = await geocodePlssLegalDescription(basePlss);
    expect(result.sourceProvider).toBe("BLM_PLSS_CADNSDI");
    expect(result.matchMethod).toBe("CENTROID_ONLY");
    expect(result.centroidLatitude).not.toBeNull();
  });

  it("falls back to meridian math with a real, present origin coordinate and a warning, when BLM returns nothing", async () => {
    mockFetchOnce(JSON.stringify({ features: [] }));
    const result = await geocodePlssLegalDescription(basePlss);
    expect(result.sourceProvider).toBe("PLSS_MERIDIAN_MATH");
    expect(result.centroidLatitude).not.toBeNull();
    expect(result.centroidLongitude).not.toBeNull();
    expect(result.confidence).toBeLessThan(0.5); // math estimate is honestly lower confidence than a real BLM centroid
    expect(result.warnings.some(w => w.code === "MATH_ESTIMATE_ONLY")).toBe(true);
  });

  it("returns UNMAPPABLE when even the math fallback has no meridian for the state", async () => {
    mockFetchOnce(JSON.stringify({ features: [] }));
    const result = await geocodePlssLegalDescription({ ...basePlss, state: "ZZ" });
    expect(result.matchMethod).toBe("UNMAPPABLE");
  });
});

describe("OffsetAnalyticsGeocoder — top-level dispatcher", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("routes UNPARSED input to MANUAL_REVIEW_REQUIRED without attempting any provider call, and retains parser warnings", async () => {
    const geocoder = new OffsetAnalyticsGeocoder();
    const result = await geocoder.geocode({
      jurisdiction: "UNPARSED", rawText: "garbage input", normalizedText: "garbage input",
      parserWarnings: ["no abstract found"], unresolvedComponents: ["county"], parserConfidence: 0,
    });
    expect(result.matchMethod).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.warnings.some(w => w.message.includes("no abstract found"))).toBe(true);
  });

  it("routes TX_LAND_GRID to the Texas provider", async () => {
    mockFetchOnce(otlsAbstract309693);
    const geocoder = new OffsetAnalyticsGeocoder();
    const result = await geocoder.geocode(baseTxDesc);
    expect(result.sourceProvider).toBe("TEXAS_OTLS");
  });
});

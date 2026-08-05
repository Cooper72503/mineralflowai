import { describe, it, expect, vi } from "vitest";
import { runOffsetAnalytics } from "../service";
import { ConsoleLogger, NoopLogger, logEvent, computeMetricsSummary } from "../observability";
import type { OffsetAnalyticsPayload } from "../types";
import type { PriceDeck } from "../../eia-pricing";

const flatPriceDeck: PriceDeck = {
  source: "static_fallback", asOf: "test", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3,
  scenarios: { stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 70, gasUsdMcf: 3 }, strip: { oilUsdBbl: 70, gasUsdMcf: 3 }, upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 } },
};

describe("logEvent / ConsoleLogger", () => {
  it("emits a single JSON-stringified log line with event, analysisId, and timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    logEvent(logger, "analysis-1", "test_event", { foo: "bar" });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("test_event");
    expect(parsed.analysisId).toBe("analysis-1");
    expect(parsed.foo).toBe("bar");
    expect(typeof parsed.timestamp).toBe("string");
    spy.mockRestore();
  });
});

describe("NoopLogger", () => {
  it("never touches console — the default so importing this module produces no surprise output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent(new NoopLogger(), "id", "event");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("runOffsetAnalytics — carries a real durationMs and logs through an injected logger", () => {
  it("populates durationMs as a real, non-negative number", async () => {
    const result = await runOffsetAnalytics({ legalDescriptionText: "vague text", priceDeck: flatPriceDeck });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });

  it("calls the injected logger at multiple pipeline checkpoints, not just once", async () => {
    const logger = { log: vi.fn() };
    await runOffsetAnalytics(
      { legalDescriptionText: "vague text", priceDeck: flatPriceDeck },
      { geocoder: { geocode: async () => ({ canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null, geometry: null, geometryType: null, sourceProvider: "NONE", sourceRecordId: null, sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326" as const, retrievedAt: new Date().toISOString(), matchMethod: "UNMAPPABLE" as const, confidence: 0, warnings: [] }) }, wellSearchProvider: { search: async () => ({ candidates: [], distanceMode: "CENTROID_TO_WELL" as const, radiusMiles: 5, warnings: [], sourceUrlOrQueryId: "" }) }, logger },
    );
    expect(logger.log).toHaveBeenCalled();
    const events = logger.log.mock.calls.map(c => (c[0] as { event: string }).event);
    expect(events).toContain("analysis_start");
    expect(events).toContain("geocode_complete");
    expect(events).toContain("analysis_failed"); // this input is unmappable, so it should log the failure checkpoint
  });
});

function payload(overrides: Partial<OffsetAnalyticsPayload & { durationMs: number }>): OffsetAnalyticsPayload {
  return {
    schemaVersion: "1.0.0", analysisId: "x",
    subjectAsset: { legalDescription: { jurisdiction: "UNPARSED", rawText: "", normalizedText: "", parserWarnings: [], unresolvedComponents: [], parserConfidence: 0 }, grossAcres: null, netMineralAcres: null, ownershipType: "UNKNOWN" },
    geocode: { canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null, geometry: null, geometryType: null, sourceProvider: "NONE", sourceRecordId: null, sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt: "", matchMethod: "EXACT_SURVEY", confidence: 0.9, warnings: [] },
    search: { radiusMiles: 5, distanceMode: "CENTROID_TO_WELL", candidatesFound: 5, qualifiedAnalogs: 3, removedForStatus: 0, removedForInsufficientHistory: 0, removedForFormationMismatch: 1, removedForDuplicate: 0 },
    analogWells: [], compositeProfile: null,
    developmentCase: { caseType: "SINGLE_WELL_PROXY", wellCount: 1, probabilityOfDevelopment: 1 },
    economics: null, confidence: { dimensions: { legalDescription: 1, geometry: 1, wellLocation: 1, geologicalMatch: 1, productionData: 1, declineFit: 1, ownership: 1, economics: 1 }, overall: "HIGH" },
    provenance: [], warnings: [], validationStatus: "VALID", durationMs: 1000,
    ...overrides,
  };
}

describe("computeMetricsSummary", () => {
  it("returns all-zero for an empty batch, not NaN or a crash", () => {
    const summary = computeMetricsSummary([]);
    expect(summary.runCount).toBe(0);
    expect(summary.geocodeSuccessRate).toBe(0);
  });

  it("computes geocodeSuccessRate correctly from a mix of match methods", () => {
    const summary = computeMetricsSummary([
      payload({ geocode: { ...payload({}).geocode, matchMethod: "EXACT_SURVEY" } }),
      payload({ geocode: { ...payload({}).geocode, matchMethod: "UNMAPPABLE" } }),
    ]);
    expect(summary.geocodeSuccessRate).toBe(0.5);
  });

  it("computes noAnalogFrequency from runs with zero analogWells", () => {
    const summary = computeMetricsSummary([
      payload({ analogWells: [] }),
      payload({ analogWells: [{ api: "1", operator: null, distanceMiles: 1, canonicalFormation: "X", landingZone: null, analogScore: 90, declineFit: null }] }),
    ]);
    expect(summary.noAnalogFrequency).toBe(0.5);
  });

  it("computes providerErrorRate from runs with at least one critical warning", () => {
    const summary = computeMetricsSummary([
      payload({ warnings: [{ code: "X", message: "y", severity: "critical" }] }),
      payload({ warnings: [{ code: "X", message: "y", severity: "warning" }] }),
    ]);
    expect(summary.providerErrorRate).toBe(0.5);
  });

  it("computes avgAnalysisLatencyMs as the mean of durationMs across the batch", () => {
    const summary = computeMetricsSummary([payload({ durationMs: 1000 }), payload({ durationMs: 3000 })]);
    expect(summary.avgAnalysisLatencyMs).toBe(2000);
  });
});

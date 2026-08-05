import { describe, it, expect } from "vitest";
import { classifyWellStatus, filterCandidates, DEFAULT_CANDIDATE_FILTER_OPTIONS, type EnrichableCandidate } from "../candidate-filtering";

describe("classifyWellStatus — real TRRC GIS_SYMBOL_DESCRIPTION values", () => {
  it("classifies real producing-well symbols confirmed live this session", () => {
    expect(classifyWellStatus("Oil Well")).toBe("PRODUCING");
    expect(classifyWellStatus("Gas Well")).toBe("PRODUCING");
  });
  it("classifies plugged wells distinctly from producing", () => {
    expect(classifyWellStatus("Plugged Oil Well")).toBe("PLUGGED");
    expect(classifyWellStatus("Plugged Gas Well")).toBe("PLUGGED");
  });
  it("classifies permitted-but-undrilled locations", () => {
    expect(classifyWellStatus("Permitted Location")).toBe("PERMITTED_NOT_DRILLED");
  });
  it("classifies canceled/abandoned locations as dry hole", () => {
    expect(classifyWellStatus("Canceled / Abandoned Location")).toBe("DRY_HOLE");
  });
  it("falls back to UNKNOWN for an unrecognized symbol rather than guessing", () => {
    expect(classifyWellStatus("Some New Symbol TRRC Never Documented")).toBe("UNKNOWN");
  });
});

function makeCandidate(overrides: Partial<EnrichableCandidate>): EnrichableCandidate {
  return {
    api: "4212345678", wellNumber: "1", gisStatusSymbol: "Oil Well", latitude: 31.5, longitude: -97.5,
    distanceMiles: 1.0, distanceMode: "CENTROID_TO_WELL", status: "PRODUCING",
    monthsOfProductionHistory: null, formationKnown: null, commodity: "OIL",
    ...overrides,
  };
}

describe("filterCandidates — never silently discards, always counted", () => {
  it("accepts a producing well with no history/formation data yet (those checks deferred while null)", () => {
    const result = filterCandidates([makeCandidate({})]);
    expect(result.counts.accepted).toBe(1);
    expect(result.results[0].accepted).toBe(true);
  });

  it("rejects a plugged well for status and counts it", () => {
    const result = filterCandidates([makeCandidate({ status: "PLUGGED" })]);
    expect(result.counts.removedForStatus).toBe(1);
    expect(result.counts.accepted).toBe(0);
    expect(result.results[0].rejectionReason).toBe("STATUS_NOT_ACCEPTABLE");
  });

  it("rejects a well with populated but insufficient production history", () => {
    const result = filterCandidates([makeCandidate({ monthsOfProductionHistory: 2 })]);
    expect(result.counts.removedForInsufficientHistory).toBe(1);
    expect(result.results[0].rejectionReason).toBe("INSUFFICIENT_PRODUCTION_HISTORY");
  });

  it("accepts a well whose production history meets the configured minimum", () => {
    const result = filterCandidates([makeCandidate({ monthsOfProductionHistory: 12 })]);
    expect(result.counts.accepted).toBe(1);
  });

  it("rejects a well with a confirmed formation mismatch when requireKnownFormation is set", () => {
    const result = filterCandidates([makeCandidate({ formationKnown: false })]);
    expect(result.counts.removedForFormationMismatch).toBe(1);
  });

  it("does not reject on formation when the check is disabled via options", () => {
    const result = filterCandidates(
      [makeCandidate({ formationKnown: false })],
      { ...DEFAULT_CANDIDATE_FILTER_OPTIONS, requireKnownFormation: false },
    );
    expect(result.counts.accepted).toBe(1);
  });

  it("deduplicates by API and counts the duplicate distinctly from other rejection reasons", () => {
    const result = filterCandidates([makeCandidate({ api: "4212345678" }), makeCandidate({ api: "4212345678" })]);
    expect(result.counts.spatiallyFound).toBe(2);
    expect(result.counts.removedForDuplicate).toBe(1);
    expect(result.counts.accepted).toBe(1);
  });

  it("every input candidate appears exactly once in results — nothing vanishes silently", () => {
    const candidates = [
      makeCandidate({ api: "1", status: "PLUGGED" }),
      makeCandidate({ api: "2", monthsOfProductionHistory: 1 }),
      makeCandidate({ api: "3" }),
    ];
    const result = filterCandidates(candidates);
    expect(result.results).toHaveLength(3);
    const total = result.counts.removedForDuplicate + result.counts.removedForStatus +
      result.counts.removedForInsufficientHistory + result.counts.removedForFormationMismatch +
      result.counts.removedForUnsupportedCommodity + result.counts.accepted;
    expect(total).toBe(result.counts.spatiallyFound);
  });

  it("rejects an unsupported commodity when the commodity is known", () => {
    const result = filterCandidates(
      [makeCandidate({ commodity: "GAS" })],
      { ...DEFAULT_CANDIDATE_FILTER_OPTIONS, supportedCommodities: ["OIL"] },
    );
    expect(result.counts.removedForUnsupportedCommodity).toBe(1);
  });
});

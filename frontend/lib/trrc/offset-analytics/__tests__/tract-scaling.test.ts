import { describe, it, expect } from "vitest";
import { buildSingleWellProxyCase, buildConfiguredDevelopmentCase, type DevelopmentAssumptions } from "../tract-scaling";

describe("buildSingleWellProxyCase", () => {
  it("defaults to 1 well, clearly labeled, when no assumptions are supplied", () => {
    const result = buildSingleWellProxyCase();
    expect(result.caseType).toBe("SINGLE_WELL_PROXY");
    expect(result.wellCount).toBe(1);
    expect(result.warnings.some(w => w.code === "SINGLE_WELL_PROXY_DEFAULT")).toBe(true);
  });

  it("does not invent a probability-of-development discount by default (defaults to 1.0, unrisked)", () => {
    const result = buildSingleWellProxyCase();
    expect(result.probabilityOfDevelopment).toBe(1.0);
  });

  it("respects an explicitly supplied probability override", () => {
    const result = buildSingleWellProxyCase({ probabilityOfDevelopment: 0.3 });
    expect(result.probabilityOfDevelopment).toBe(0.3);
  });
});

const baseAssumptions: DevelopmentAssumptions = {
  spacingAcresPerWell: 80,
  lateralLengthFt: 10000,
  developmentTimingMonths: [0, 6, 12, 18],
  netDevelopableAcres: 320,
  grossTractAcres: 400,
  netMineralAcres: 40,
  riskFactor: 1.0,
  probabilityOfDevelopment: 0.6,
  infrastructureDeductionUsd: 250000,
};

describe("buildConfiguredDevelopmentCase — well count is derived from a real spacing calculation, never guessed", () => {
  it("derives well count from netDevelopableAcres / spacingAcresPerWell", () => {
    const result = buildConfiguredDevelopmentCase(baseAssumptions); // 320/80 = 4
    expect(result.wellCount).toBe(4);
    expect(result.caseType).toBe("MULTI_WELL_CONFIGURED");
  });

  it("floors a fractional well count rather than rounding up to a well that doesn't fit", () => {
    const result = buildConfiguredDevelopmentCase({ ...baseAssumptions, netDevelopableAcres: 199, spacingAcresPerWell: 80 }); // 199/80 = 2.4875
    expect(result.wellCount).toBe(2);
  });

  it("falls back to a single-well proxy, with a critical warning, for invalid (non-positive) spacing rather than dividing by zero", () => {
    const result = buildConfiguredDevelopmentCase({ ...baseAssumptions, spacingAcresPerWell: 0 });
    expect(result.caseType).toBe("SINGLE_WELL_PROXY");
    expect(result.warnings.some(w => w.code === "INVALID_SPACING" && w.severity === "critical")).toBe(true);
  });

  it("extends a too-short timing array rather than throwing, with a warning", () => {
    const result = buildConfiguredDevelopmentCase({ ...baseAssumptions, developmentTimingMonths: [0] }); // 4 wells, only 1 timing entry
    expect(result.developmentTimingMonths).toHaveLength(4);
    expect(result.warnings.some(w => w.code === "TIMING_ARRAY_LENGTH_MISMATCH")).toBe(true);
  });

  it("allows probabilityOfDevelopment of 0 and flags it as a real, non-error outcome", () => {
    const result = buildConfiguredDevelopmentCase({ ...baseAssumptions, probabilityOfDevelopment: 0 });
    expect(result.probabilityOfDevelopment).toBe(0);
    expect(result.warnings.some(w => w.code === "ZERO_DEVELOPMENT_PROBABILITY")).toBe(true);
  });

  it("preserves gross/net/NMA acreage and infrastructure deduction through unchanged", () => {
    const result = buildConfiguredDevelopmentCase(baseAssumptions);
    expect(result.grossTractAcres).toBe(400);
    expect(result.netMineralAcres).toBe(40);
    expect(result.infrastructureDeductionUsd).toBe(250000);
  });
});

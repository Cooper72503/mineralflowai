import { describe, it, expect } from "vitest";
import { computeProxyValuation } from "../proxy-valuation";
import { buildSingleWellProxyCase, buildConfiguredDevelopmentCase, type DevelopmentAssumptions } from "../tract-scaling";
import { resolveOwnership } from "../ownership-economics";
import type { TypeCurveMonth } from "../composite-profile";
import type { PriceDeck } from "../../eia-pricing";

const flatPriceDeck: PriceDeck = {
  source: "static_fallback", asOf: "test", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3,
  scenarios: {
    stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 70, gasUsdMcf: 3 },
    strip: { oilUsdBbl: 70, gasUsdMcf: 3 }, upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 },
  },
};

function typeCurve(months: number, p50PerMonth: number): TypeCurveMonth[] {
  return Array.from({ length: months }, (_, i) => ({ monthIndex: i, p25: p50PerMonth * 0.8, p50: p50PerMonth, p75: p50PerMonth * 1.2, mean: p50PerMonth, wellCount: 3 }));
}

const realRoyaltyOwnership = resolveOwnership({
  ownershipType: "ROYALTY_INTEREST", netMineralAcres: 40, grossTractAcres: 320,
  mineralFraction: 0.125, leaseRoyaltyFraction: 0.1875, netRevenueInterest: null, workingInterest: null,
});

describe("computeProxyValuation — the final integration", () => {
  it("computes a positive PV-10 for a real royalty owner with a positive type curve", () => {
    const result = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    expect(result.unriskedPv10).toBeGreaterThan(0);
    expect(result.ownershipResultType).toBe("ROYALTY_OWNER_PV10");
  });

  it("always keeps risked and unrisked separate — risked is never silently substituted for unrisked", () => {
    const devCase = buildSingleWellProxyCase({ probabilityOfDevelopment: 0.4 });
    const result = computeProxyValuation(typeCurve(36, 500), devCase, realRoyaltyOwnership, flatPriceDeck);
    expect(result.riskedPv10).toBeCloseTo(result.unriskedPv10 * 0.4, 4);
    expect(result.riskedPv10).not.toBe(result.unriskedPv10);
  });

  it("PV-10 is always >= PV-15 for a positive cash flow stream (higher discount rate discounts more), matching economics.ts's own convention", () => {
    const result = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    expect(result.unriskedPv10).toBeGreaterThanOrEqual(result.unriskedPv15);
  });

  it("sums contributions across multiple wells with different timing offsets — a 4-well case is worth more than a 1-well case, all else equal", () => {
    const singleWell = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    const fourWellAssumptions: DevelopmentAssumptions = {
      spacingAcresPerWell: 80, lateralLengthFt: 10000, developmentTimingMonths: [0, 6, 12, 18],
      netDevelopableAcres: 320, grossTractAcres: 320, netMineralAcres: 40, riskFactor: 1, probabilityOfDevelopment: 1, infrastructureDeductionUsd: 0,
    };
    const fourWell = computeProxyValuation(typeCurve(36, 500), buildConfiguredDevelopmentCase(fourWellAssumptions), realRoyaltyOwnership, flatPriceDeck);
    expect(fourWell.unriskedPv10).toBeGreaterThan(singleWell.unriskedPv10);
  });

  it("a well starting later (higher timing offset) contributes less PV than an identical well starting now, due to discounting", () => {
    const now = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    const delayedAssumptions: DevelopmentAssumptions = {
      spacingAcresPerWell: 320, lateralLengthFt: 10000, developmentTimingMonths: [24],
      netDevelopableAcres: 320, grossTractAcres: 320, netMineralAcres: 40, riskFactor: 1, probabilityOfDevelopment: 1, infrastructureDeductionUsd: 0,
    };
    const delayed = computeProxyValuation(typeCurve(36, 500), buildConfiguredDevelopmentCase(delayedAssumptions), realRoyaltyOwnership, flatPriceDeck);
    expect(delayed.unriskedPv10).toBeLessThan(now.unriskedPv10);
  });

  it("subtracts the infrastructure deduction from PV-10", () => {
    const withDeduction = computeProxyValuation(typeCurve(36, 500), buildConfiguredDevelopmentCase({
      spacingAcresPerWell: 320, lateralLengthFt: 10000, developmentTimingMonths: [0],
      netDevelopableAcres: 320, grossTractAcres: 320, netMineralAcres: 40, riskFactor: 1, probabilityOfDevelopment: 1, infrastructureDeductionUsd: 100000,
    }), realRoyaltyOwnership, flatPriceDeck);
    const without = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    expect(withDeduction.unriskedPv10).toBeCloseTo(without.unriskedPv10 - 100000, 2);
  });

  it("flags the result as a gross-tract proxy, not an owner entitlement, when ownership couldn't be resolved to a real interest", () => {
    const noOwnership = resolveOwnership({ ownershipType: "UNKNOWN", netMineralAcres: null, grossTractAcres: null, mineralFraction: null, leaseRoyaltyFraction: null, netRevenueInterest: null, workingInterest: null });
    const result = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), noOwnership, flatPriceDeck);
    expect(result.warnings.some(w => w.code === "PROXY_VALUATION_NOT_OWNER_LEVEL")).toBe(true);
  });

  it("does NOT copy ownership's own warnings into its result — service.ts already includes those directly, so duplicating them here would render every ownership-fallback warning twice in the final report", () => {
    const fallbackOwnership = resolveOwnership({ ownershipType: "UNKNOWN", netMineralAcres: null, grossTractAcres: 320, mineralFraction: null, leaseRoyaltyFraction: null, netRevenueInterest: null, workingInterest: null });
    expect(fallbackOwnership.warnings.some(w => w.code === "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_GROSS_TRACT")).toBe(true);
    const result = computeProxyValuation(typeCurve(36, 500), buildSingleWellProxyCase(), fallbackOwnership, flatPriceDeck);
    expect(result.warnings.filter(w => w.code === "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_GROSS_TRACT")).toHaveLength(0);
  });

  it("returns zero PV with a critical warning, not a crash, when the type curve is empty", () => {
    const result = computeProxyValuation([], buildSingleWellProxyCase(), realRoyaltyOwnership, flatPriceDeck);
    expect(result.unriskedPv10).toBe(0);
    expect(result.warnings.some(w => w.code === "NO_TYPE_CURVE_FOR_VALUATION" && w.severity === "critical")).toBe(true);
  });

  it("a zero probability of development produces a zero risked PV-10 but a nonzero unrisked PV-10", () => {
    const devCase = buildSingleWellProxyCase({ probabilityOfDevelopment: 0 });
    const result = computeProxyValuation(typeCurve(36, 500), devCase, realRoyaltyOwnership, flatPriceDeck);
    expect(result.riskedPv10).toBe(0);
    expect(result.unriskedPv10).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import { interpretGeologicalEvidence } from "../interpretation";
import type { OffsetSearchResult, OffsetWellRecord, ProductionDistributionStats, DevelopmentActivitySummary, FormationDepthContext } from "../types";

function makeWell(overrides: Partial<OffsetWellRecord>): OffsetWellRecord {
  return {
    apiNumber: "42-165-00001", wellNumber: "1", latitude: 32.87, longitude: -102.74,
    distanceMiles: 1.5, bearing: "N", radiusBandMiles: 3, gisStatusSymbol: "Oil Well",
    classifiedStatus: "PRODUCING", operatorName: "ACME OIL LLC", fieldName: "WOLFCAMP (A)",
    canonicalFormation: "WOLFCAMP A", formationMatch: true, lateralLengthFt: 6500, completionYear: 2021,
    firstProductionMonth: "2021-03", sixMonthOilBbl: 20000, twelveMonthOilBbl: 110000,
    cumulativeOilBbl: 200000, cumulativeGasMcf: 500000, cumulativeWaterBbl: 50000,
    monthsOfHistory: 36, comparableGroupId: "g1",
    ...overrides,
  };
}

function makeOffsets(wells: OffsetWellRecord[]): OffsetSearchResult {
  const countByRadius = { 1: 0, 3: 0, 5: 0 } as Record<1 | 3 | 5, number>;
  const horizontalCountByRadius = { 1: 0, 3: 0, 5: 0 } as Record<1 | 3 | 5, number>;
  for (const w of wells) for (const b of [1, 3, 5] as const) if (w.distanceMiles <= b) countByRadius[b]++;
  return { wells, countByRadius, horizontalCountByRadius, warnings: [], sourceUrlOrQueryId: "test-query", retrievedAt: new Date().toISOString() };
}

const emptyActivity: DevelopmentActivitySummary = {
  permits: [], permitCountByRadius: { 1: 0, 3: 0, 5: 0 }, permitCountByRecency: { LAST_6_MONTHS: 0, LAST_12_MONTHS: 0, LAST_24_MONTHS: 0, OLDER: 0, UNKNOWN: 0 },
  operatorConcentration: [], activeOperatorCount: 0, recentlyCompletedWellCount: 0, developmentDensityPerSqMile: null,
  developmentRecencyNote: "", warnings: [],
};

const gapFormationContext: FormationDepthContext = {
  subjectFormation: "WOLFCAMP A", producingFormation: "WOLFCAMP A", permittedFormation: null,
  subjectTvdFt: null, subjectTvdSource: null, subjectTvdssFt: null, tvdssElevationSource: null, tvdssMethodology: null,
  formationTopsAvailable: false, dataGapNote: "no public source",
};

describe("interpretGeologicalEvidence — finding generation and classification", () => {
  it("produces a supporting/observed finding for established offset development, citing real evidence", () => {
    const wells = Array.from({ length: 6 }, (_, i) => makeWell({ apiNumber: `A${i}`, distanceMiles: 1 + i * 0.3 }));
    const result = interpretGeologicalEvidence({ offsets: makeOffsets(wells), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    const finding = result.supportingFactors.find(f => f.title.includes("Established offset development"));
    expect(finding).toBeTruthy();
    expect(finding!.classification).toBe("observed");
    expect(finding!.evidenceIds.length).toBeGreaterThan(0);
    expect(result.evidence.some(e => e.id === finding!.evidenceIds[0])).toBe(true);
  });

  it("flags a gap, not a supporting finding, when zero offset wells are found", () => {
    const result = interpretGeologicalEvidence({ offsets: makeOffsets([]), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    expect(result.dataGaps.some(f => f.title.includes("No offset wells found"))).toBe(true);
    expect(result.supportingFactors.length).toBe(0);
  });

  it("classifies plugged/dry-hole-dominated wells as a risk (calculated/observed), and a lesser count as merely contradicting", () => {
    const dominant = [
      makeWell({ apiNumber: "P1", classifiedStatus: "PLUGGED", distanceMiles: 0.5 }),
      makeWell({ apiNumber: "P2", classifiedStatus: "DRY_HOLE", distanceMiles: 1 }),
    ];
    const resultDominant = interpretGeologicalEvidence({ offsets: makeOffsets(dominant), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    expect(resultDominant.risks.some(f => f.title.includes("Plugged or dry-hole"))).toBe(true);

    const minor = [
      ...Array.from({ length: 5 }, (_, i) => makeWell({ apiNumber: `G${i}`, distanceMiles: 1 + i * 0.2 })),
      makeWell({ apiNumber: "P1", classifiedStatus: "PLUGGED", distanceMiles: 0.5 }),
    ];
    const resultMinor = interpretGeologicalEvidence({ offsets: makeOffsets(minor), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    expect(resultMinor.contradictingFactors.some(f => f.title.includes("Plugged or dry-hole"))).toBe(true);
    expect(resultMinor.risks.some(f => f.title.includes("Plugged or dry-hole"))).toBe(false);
  });

  it("tags a valid comparable-group production stat as calculated with a preserved transformation formula in its evidence", () => {
    const stats: ProductionDistributionStats[] = [{
      groupId: "g1", wellCount: 5, medianTwelveMonthOilBbl: 100000, averageTwelveMonthOilBbl: 98000,
      bestPerformerApi: "A0", bestPerformerTwelveMonthOilBbl: 140000, lowestPerformerApi: "A4", lowestPerformerTwelveMonthOilBbl: 60000,
      distanceWeightedTwelveMonthOilBbl: 101000, validComparison: true, invalidComparisonReason: null,
    }];
    const result = interpretGeologicalEvidence({ offsets: makeOffsets([]), productionStats: stats, activity: emptyActivity, formationContext: gapFormationContext });
    const finding = result.supportingFactors.find(f => f.title.includes("Consistent offset production"));
    expect(finding!.classification).toBe("calculated");
    const evId = finding!.evidenceIds[0];
    const ev = result.evidence.find(e => e.id === evId)!;
    expect(ev.classification).toBe("calculated");
    expect(ev.transformationMethod).toBeTruthy();
  });

  it("flags an invalid (too-small) comparable group as a gap, not a supporting finding", () => {
    const stats: ProductionDistributionStats[] = [{
      groupId: "g1", wellCount: 2, medianTwelveMonthOilBbl: 90000, averageTwelveMonthOilBbl: 90000,
      bestPerformerApi: "A0", bestPerformerTwelveMonthOilBbl: 100000, lowestPerformerApi: "A1", lowestPerformerTwelveMonthOilBbl: 80000,
      distanceWeightedTwelveMonthOilBbl: 90000, validComparison: false, invalidComparisonReason: "Only 2 comparable well(s).",
    }];
    const result = interpretGeologicalEvidence({ offsets: makeOffsets([]), productionStats: stats, activity: emptyActivity, formationContext: gapFormationContext });
    expect(result.dataGaps.some(f => f.title.includes("Insufficient comparable wells"))).toBe(true);
    expect(result.supportingFactors.some(f => f.title.includes("Consistent offset production"))).toBe(false);
  });

  it("always discloses the formation-tops data gap, regardless of other evidence", () => {
    const wells = Array.from({ length: 6 }, (_, i) => makeWell({ apiNumber: `A${i}`, distanceMiles: 1 + i * 0.3 }));
    const result = interpretGeologicalEvidence({ offsets: makeOffsets(wells), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    expect(result.dataGaps.some(f => f.title.includes("Formation tops"))).toBe(true);
  });

  it("never confuses a permit with proof of a future well — the supporting text explicitly says so", () => {
    const activityWithPermits: DevelopmentActivitySummary = {
      ...emptyActivity, permitCountByRadius: { 1: 1, 3: 3, 5: 4 },
    };
    const result = interpretGeologicalEvidence({ offsets: makeOffsets([]), productionStats: [], activity: activityWithPermits, formationContext: gapFormationContext });
    const finding = result.supportingFactors.find(f => f.title.includes("Active permitting"));
    expect(finding!.description).toContain("not a commitment");
  });

  it("produces the sparse-data (insufficient-evidence) diligence implication rather than a forced conclusion", () => {
    const result = interpretGeologicalEvidence({ offsets: makeOffsets([makeWell({ apiNumber: "A1" })]), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    expect(result.diligenceImplication).toContain("genuine data gap");
  });

  it("produces the established-development + valid-comparable-production diligence implication when both hold and there is no material risk", () => {
    const wells = Array.from({ length: 6 }, (_, i) => makeWell({ apiNumber: `A${i}`, distanceMiles: 1 + i * 0.3 }));
    const stats: ProductionDistributionStats[] = [{
      groupId: "g1", wellCount: 5, medianTwelveMonthOilBbl: 100000, averageTwelveMonthOilBbl: 98000,
      bestPerformerApi: "A0", bestPerformerTwelveMonthOilBbl: 140000, lowestPerformerApi: "A4", lowestPerformerTwelveMonthOilBbl: 60000,
      distanceWeightedTwelveMonthOilBbl: 101000, validComparison: true, invalidComparisonReason: null,
    }];
    const result = interpretGeologicalEvidence({ offsets: makeOffsets(wells), productionStats: stats, activity: emptyActivity, formationContext: gapFormationContext });
    expect(result.diligenceImplication).toContain("does not confirm the subject acreage");
  });

  it("every finding across all categories carries at least an empty evidenceIds array, never undefined", () => {
    const wells = Array.from({ length: 6 }, (_, i) => makeWell({ apiNumber: `A${i}`, distanceMiles: 1 + i * 0.3 }));
    const result = interpretGeologicalEvidence({ offsets: makeOffsets(wells), productionStats: [], activity: emptyActivity, formationContext: gapFormationContext });
    for (const f of [...result.supportingFactors, ...result.contradictingFactors, ...result.risks, ...result.dataGaps]) {
      expect(Array.isArray(f.evidenceIds)).toBe(true);
    }
  });
});

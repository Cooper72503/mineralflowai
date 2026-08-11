import { describe, it, expect } from "vitest";
import { runGeologicalAssessment } from "../assessment";
import type { OffsetSearchResult, OffsetWellRecord, ComparableGroup, ProductionDistributionStats, DevelopmentActivitySummary, FormationDepthContext } from "../types";

function makeWell(overrides: Partial<OffsetWellRecord>): OffsetWellRecord {
  return {
    apiNumber: "42-165-00001", wellNumber: "1", latitude: 32.87, longitude: -102.74,
    distanceMiles: 1.5, bearing: "N", radiusBandMiles: 3, gisStatusSymbol: "Oil Well",
    classifiedStatus: "PRODUCING", operatorName: "ACME OIL LLC", fieldName: "WOLFCAMP (A)",
    canonicalFormation: "WOLFCAMP A", formationMatch: true, lateralLengthFt: 6500, completionYear: 2021,
    firstProductionMonth: "2021-03", sixMonthOilBbl: 20000, twelveMonthOilBbl: 110000,
    cumulativeOilBbl: 200000, cumulativeGasMcf: 500000, cumulativeWaterBbl: 50000,
    monthsOfHistory: 36, comparableGroupId: "WOLFCAMP A|5000-7500ft|2021-2023",
    ...overrides,
  };
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

function makeOffsets(wells: OffsetWellRecord[]): OffsetSearchResult {
  const countByRadius = { 1: 0, 3: 0, 5: 0 } as Record<1 | 3 | 5, number>;
  for (const w of wells) for (const b of [1, 3, 5] as const) if (w.distanceMiles <= b) countByRadius[b]++;
  return { wells, countByRadius, horizontalCountByRadius: { 1: 0, 3: 0, 5: 0 }, warnings: [], sourceUrlOrQueryId: "test", retrievedAt: new Date().toISOString() };
}

describe("runGeologicalAssessment — classification", () => {
  it("returns INSUFFICIENT_DATA when the subject location could not be resolved", () => {
    const result = runGeologicalAssessment({
      offsets: makeOffsets([]), comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: false,
    });
    expect(result.classification).toBe("INSUFFICIENT_DATA");
  });

  it("returns INSUFFICIENT_DATA when zero offset wells were found, even with a resolved location", () => {
    const result = runGeologicalAssessment({
      offsets: makeOffsets([]), comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    expect(result.classification).toBe("INSUFFICIENT_DATA");
    expect(result.dataGaps.length).toBeGreaterThan(0);
  });

  it("returns FAVORABLE for a heavily-developed area with a valid comparable production group and no material risk", () => {
    const wells = Array.from({ length: 8 }, (_, i) => makeWell({ apiNumber: `42-165-0000${i}`, distanceMiles: 1 + i * 0.2 }));
    const groups: ComparableGroup[] = [{ groupId: "WOLFCAMP A|5000-7500ft|2021-2023", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2021-2023", memberApis: wells.map(w => w.apiNumber) }];
    const stats: ProductionDistributionStats[] = [{
      groupId: groups[0].groupId, wellCount: 8, medianTwelveMonthOilBbl: 110000, averageTwelveMonthOilBbl: 108000,
      bestPerformerApi: wells[0].apiNumber, bestPerformerTwelveMonthOilBbl: 140000,
      lowestPerformerApi: wells[7].apiNumber, lowestPerformerTwelveMonthOilBbl: 80000,
      distanceWeightedTwelveMonthOilBbl: 112000, validComparison: true, invalidComparisonReason: null,
    }];
    const result = runGeologicalAssessment({
      offsets: makeOffsets(wells), comparableGroups: groups, productionStats: stats, activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    expect(result.classification).toBe("FAVORABLE");
    expect(result.supportingFactors.length).toBeGreaterThan(0);
    expect(result.confidence).not.toBe("INSUFFICIENT_DATA");
  });

  it("returns MIXED when offsets exist but the comparable group is too small to be statistically valid", () => {
    const wells = [makeWell({ apiNumber: "42-165-00001" }), makeWell({ apiNumber: "42-165-00002", distanceMiles: 2 })];
    const groups: ComparableGroup[] = [{ groupId: "g1", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2021-2023", memberApis: wells.map(w => w.apiNumber) }];
    const stats: ProductionDistributionStats[] = [{
      groupId: "g1", wellCount: 2, medianTwelveMonthOilBbl: 100000, averageTwelveMonthOilBbl: 100000,
      bestPerformerApi: "42-165-00001", bestPerformerTwelveMonthOilBbl: 110000,
      lowestPerformerApi: "42-165-00002", lowestPerformerTwelveMonthOilBbl: 90000,
      distanceWeightedTwelveMonthOilBbl: 100000, validComparison: false,
      invalidComparisonReason: "Only 2 comparable well(s) with complete data in this group — fewer than the 3 needed.",
    }];
    const result = runGeologicalAssessment({
      offsets: makeOffsets(wells), comparableGroups: groups, productionStats: stats, activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    expect(result.classification).toBe("MIXED");
  });

  it("returns UNFAVORABLE when plugged/dry-hole wells dominate and nothing is currently producing", () => {
    const wells = [
      makeWell({ apiNumber: "42-165-00001", classifiedStatus: "PLUGGED", distanceMiles: 0.5 }),
      makeWell({ apiNumber: "42-165-00002", classifiedStatus: "DRY_HOLE", distanceMiles: 1.0 }),
      makeWell({ apiNumber: "42-165-00003", classifiedStatus: "PLUGGED", distanceMiles: 1.5 }),
    ];
    const result = runGeologicalAssessment({
      offsets: makeOffsets(wells), comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    expect(result.classification).toBe("UNFAVORABLE");
    expect(result.risks.length).toBeGreaterThan(0);
  });

  it("every finding carries evidenceIds or an explicit empty array — never undefined", () => {
    const wells = Array.from({ length: 6 }, (_, i) => makeWell({ apiNumber: `42-165-0000${i}`, distanceMiles: 1 + i * 0.3 }));
    const result = runGeologicalAssessment({
      offsets: makeOffsets(wells), comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    for (const f of [...result.supportingFactors, ...result.contradictingFactors, ...result.risks, ...result.dataGaps]) {
      expect(Array.isArray(f.evidenceIds)).toBe(true);
      expect(["observed", "calculated", "inferred"]).toContain(f.classification);
    }
  });

  it("never produces a numeric score anywhere in the result shape", () => {
    const result = runGeologicalAssessment({
      offsets: makeOffsets([]), comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext: gapFormationContext, subjectLocationResolved: true,
    });
    expect(typeof (result as unknown as { score?: unknown }).score).toBe("undefined");
    expect(["FAVORABLE", "MIXED", "UNFAVORABLE", "INSUFFICIENT_DATA"]).toContain(result.classification);
    expect(["HIGH", "MODERATE", "LOW", "INSUFFICIENT_DATA"]).toContain(result.confidence);
  });
});

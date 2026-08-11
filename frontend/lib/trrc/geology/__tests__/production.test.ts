import { describe, it, expect } from "vitest";
import { buildComparableGroups, computeProductionDistribution } from "../production";
import type { OffsetWellRecord } from "../types";

function makeWell(overrides: Partial<OffsetWellRecord>): OffsetWellRecord {
  return {
    apiNumber: "42-165-00001", wellNumber: "1", latitude: 32.87, longitude: -102.74,
    distanceMiles: 1.5, bearing: "N", radiusBandMiles: 3, gisStatusSymbol: "Oil Well",
    classifiedStatus: "PRODUCING", operatorName: null, fieldName: null,
    canonicalFormation: null, formationMatch: null, lateralLengthFt: null, completionYear: null,
    firstProductionMonth: null, sixMonthOilBbl: null, twelveMonthOilBbl: null,
    cumulativeOilBbl: null, cumulativeGasMcf: null, cumulativeWaterBbl: null,
    monthsOfHistory: null, comparableGroupId: null,
    ...overrides,
  };
}

describe("buildComparableGroups", () => {
  it("groups wells by formation + lateral-length band + vintage band", () => {
    const wells = [
      makeWell({ apiNumber: "A1", canonicalFormation: "WOLFCAMP A", formationMatch: true, lateralLengthFt: 6000, completionYear: 2021 }),
      makeWell({ apiNumber: "A2", canonicalFormation: "WOLFCAMP A", formationMatch: true, lateralLengthFt: 6500, completionYear: 2020 }), // same vintage band as A1 (floor(year/3)*3 = 2019 for both)
      makeWell({ apiNumber: "A3", canonicalFormation: "WOLFCAMP A", formationMatch: true, lateralLengthFt: 11000, completionYear: 2021 }), // different lateral band
    ];
    const groups = buildComparableGroups(wells);
    expect(groups.length).toBe(2);
    const group1 = groups.find(g => g.memberApis.includes("A1"))!;
    expect(group1.memberApis).toContain("A2");
    expect(group1.memberApis).not.toContain("A3");
  });

  it("never groups a well whose formation didn't match the subject", () => {
    const wells = [
      makeWell({ apiNumber: "A1", canonicalFormation: "WOLFCAMP A", formationMatch: true }),
      makeWell({ apiNumber: "B1", canonicalFormation: "SPRABERRY", formationMatch: false }),
    ];
    const groups = buildComparableGroups(wells);
    const allMembers = groups.flatMap(g => g.memberApis);
    expect(allMembers).not.toContain("B1");
  });

  it("never groups a well with unknown formation", () => {
    const wells = [makeWell({ apiNumber: "A1", canonicalFormation: null, formationMatch: null })];
    const groups = buildComparableGroups(wells);
    expect(groups.length).toBe(0);
    expect(wells[0].comparableGroupId).toBeNull();
  });
});

describe("computeProductionDistribution", () => {
  it("computes median/average/best/worst/distance-weighted correctly for a valid group", () => {
    const wells = [
      makeWell({ apiNumber: "A1", distanceMiles: 1, twelveMonthOilBbl: 100000, comparableGroupId: "g1" }),
      makeWell({ apiNumber: "A2", distanceMiles: 2, twelveMonthOilBbl: 150000, comparableGroupId: "g1" }),
      makeWell({ apiNumber: "A3", distanceMiles: 3, twelveMonthOilBbl: 50000, comparableGroupId: "g1" }),
    ];
    const groups = [{ groupId: "g1", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2021-2023", memberApis: ["A1", "A2", "A3"] }];
    const [stats] = computeProductionDistribution(wells, groups);
    expect(stats.wellCount).toBe(3);
    expect(stats.medianTwelveMonthOilBbl).toBe(100000);
    expect(stats.bestPerformerApi).toBe("A2");
    expect(stats.bestPerformerTwelveMonthOilBbl).toBe(150000);
    expect(stats.lowestPerformerApi).toBe("A3");
    expect(stats.lowestPerformerTwelveMonthOilBbl).toBe(50000);
    expect(stats.validComparison).toBe(true);
    // Distance-weighted should favor the closer well (A1, 100k) over simple average (100k) since A1 is closest
    expect(stats.distanceWeightedTwelveMonthOilBbl).not.toBeNull();
  });

  it("flags validComparison=false and states why when the group is too small", () => {
    const wells = [
      makeWell({ apiNumber: "A1", twelveMonthOilBbl: 100000, comparableGroupId: "g1" }),
      makeWell({ apiNumber: "A2", twelveMonthOilBbl: 120000, comparableGroupId: "g1" }),
    ];
    const groups = [{ groupId: "g1", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2021-2023", memberApis: ["A1", "A2"] }];
    const [stats] = computeProductionDistribution(wells, groups);
    expect(stats.validComparison).toBe(false);
    expect(stats.invalidComparisonReason).toBeTruthy();
    // Still reports real numbers even though flagged invalid — never hides the data, just the false confidence
    expect(stats.medianTwelveMonthOilBbl).toBe(110000);
  });

  it("reports a group with zero members with complete data as invalid, not a fabricated zero median", () => {
    const wells = [makeWell({ apiNumber: "A1", twelveMonthOilBbl: null, comparableGroupId: "g1" })];
    const groups = [{ groupId: "g1", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2021-2023", memberApis: ["A1"] }];
    const [stats] = computeProductionDistribution(wells, groups);
    expect(stats.wellCount).toBe(0);
    expect(stats.medianTwelveMonthOilBbl).toBeNull();
    expect(stats.validComparison).toBe(false);
  });
});

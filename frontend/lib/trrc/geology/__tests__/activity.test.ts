import { describe, it, expect } from "vitest";
import { analyzeDevelopmentActivity } from "../activity";
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

describe("analyzeDevelopmentActivity", () => {
  it("derives permit counts/locations from PERMITTED_NOT_DRILLED wells and marks recency UNKNOWN, never guessed", () => {
    const wells = [
      makeWell({ apiNumber: "P1", classifiedStatus: "PERMITTED_NOT_DRILLED", distanceMiles: 0.8, radiusBandMiles: 1 }),
      makeWell({ apiNumber: "P2", classifiedStatus: "PERMITTED_NOT_DRILLED", distanceMiles: 2.5, radiusBandMiles: 3 }),
    ];
    const result = analyzeDevelopmentActivity(wells);
    expect(result.permits.length).toBe(2);
    expect(result.permitCountByRadius[1]).toBe(1);
    expect(result.permitCountByRadius[3]).toBe(2);
    for (const p of result.permits) {
      expect(p.recencyBucket).toBe("UNKNOWN");
      expect(p.filedDate).toBeNull();
    }
    expect(result.permitCountByRecency.UNKNOWN).toBe(2);
    expect(result.warnings.some(w => w.code === "PERMIT_FILING_DATE_UNAVAILABLE")).toBe(true);
  });

  it("computes operator concentration only from wells with a resolved operator name", () => {
    const wells = [
      makeWell({ apiNumber: "A1", operatorName: "ACME OIL LLC" }),
      makeWell({ apiNumber: "A2", operatorName: "ACME OIL LLC" }),
      makeWell({ apiNumber: "A3", operatorName: "BETA ENERGY" }),
      makeWell({ apiNumber: "A4", operatorName: null }),
    ];
    const result = analyzeDevelopmentActivity(wells);
    expect(result.activeOperatorCount).toBe(2);
    const acme = result.operatorConcentration.find(o => o.operatorName === "ACME OIL LLC")!;
    expect(acme.wellCount).toBe(2);
    expect(acme.sharePct).toBeCloseTo(66.7, 0);
  });

  it("derives recentlyCompletedWellCount from real firstProductionMonth, not permits", () => {
    const recent = new Date();
    recent.setMonth(recent.getMonth() - 6);
    const recentMonth = `${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, "0")}`;
    const wells = [
      makeWell({ apiNumber: "A1", firstProductionMonth: recentMonth }),
      makeWell({ apiNumber: "A2", firstProductionMonth: "2010-01" }), // too old
      makeWell({ apiNumber: "A3", firstProductionMonth: null }),
    ];
    const result = analyzeDevelopmentActivity(wells);
    expect(result.recentlyCompletedWellCount).toBe(1);
  });

  it("never fabricates a permit filed date or recency bucket when none exist", () => {
    const wells: OffsetWellRecord[] = [];
    const result = analyzeDevelopmentActivity(wells);
    expect(result.permits).toEqual([]);
    expect(result.developmentRecencyNote).toContain("No offset wells");
  });
});

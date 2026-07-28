/**
 * Tests for buildAcquisitionScorecard — a transparent, disclosed
 * rule-based rubric, not a black-box model. Key behaviors under test:
 * missing data always scores low/honest rather than neutral-good; any
 * critical flag hard-gates the recommendation to BLOCKED regardless of
 * how good the other scores look; and dimension weights sum to exactly
 * 1.0 so opportunity/risk/confidence aggregates are well-defined.
 */

import { describe, it, expect } from "vitest";
import { buildAcquisitionScorecard, type ScorecardInputs } from "../scorecard-builder";
import type { LiteSourceAttempt } from "../coverage";
import type { SourceCoverageStatus } from "../types";

function attempt(overrides: Partial<LiteSourceAttempt>): LiteSourceAttempt {
  return {
    source_id: "x_0", source_name: "x", status: "success", result_count: 0,
    error_message: null, attempted_at: "2026-07-27T19:33:41.000Z", result_data_json: null,
    ...overrides,
  };
}

function coverageRow(overrides: Partial<SourceCoverageStatus>): SourceCoverageStatus {
  return { category: "x", label: "X", status: "complete", records_found: 1, data_current_through: null, sources_checked: [], notes: null, ...overrides };
}

const baseInputs: ScorecardInputs = {
  attempts: [],
  production: [],
  coverage: [],
  criticalFlags: [],
  importantFlags: [],
  monthsOfHistory: 0,
  recentAvgOil: null,
  yoyDeclineOilPct: null,
  zeroProductionMonths: 0,
  worTrend: "N/A",
  offsetWellCount: 0,
  hasLateralPath: false,
  resolvedLeaseNumber: null,
  resolvedDistrict: null,
};

describe("buildAcquisitionScorecard", () => {
  it("dimension weights sum to exactly 1.0", () => {
    const card = buildAcquisitionScorecard(baseInputs);
    const totalWeight = Object.values(card.dimensions).reduce((s, d) => s + d.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 10);
  });

  it("scores production_quality as 0 (not neutral) when there is no production history", () => {
    const card = buildAcquisitionScorecard(baseInputs);
    expect(card.dimensions.production_quality.score).toBe(0);
    expect(card.dimensions.production_quality.rationale).toMatch(/no production history/i);
  });

  it("scores identity_confidence as 0 when no source confirms the asset", () => {
    const card = buildAcquisitionScorecard(baseInputs);
    expect(card.dimensions.identity_confidence.score).toBe(0);
  });

  it("hard-gates recommendation to BLOCKED whenever a critical flag exists, regardless of other scores", () => {
    const strongInputs: ScorecardInputs = {
      ...baseInputs,
      criticalFlags: ["ORPHAN WELL — operator has forfeited bond."],
      attempts: [
        attempt({ source_name: "search_by_api", result_data_json: { found: true } }),
        attempt({ source_name: "search_by_operator", result_data_json: { records: [{ p5_status: "Active", bond_amount: "50000" }] } }),
      ],
      coverage: [coverageRow({ category: "wellbore_identity" })],
      monthsOfHistory: 24,
      recentAvgOil: 500,
      zeroProductionMonths: 0,
      worTrend: "Stable",
    };
    const card = buildAcquisitionScorecard(strongInputs);
    expect(card.recommendation).toBe("BLOCKED");
    expect(card.gating_conditions).toContain("ORPHAN WELL — operator has forfeited bond.");
  });

  it("recommends PURSUE only when opportunity is high, risk is low, and confidence is high, with no critical flags", () => {
    const strongInputs: ScorecardInputs = {
      ...baseInputs,
      attempts: [
        attempt({ source_name: "search_by_api", result_data_json: { found: true } }),
        attempt({ source_name: "fetch_gis_plat", result_data_json: { found: true } }),
        attempt({ source_name: "fetch_well_status", result_data_json: { status: "Active" } }),
        attempt({ source_name: "search_by_operator", result_data_json: { records: [{ p5_status: "Active", bond_amount: "50000" }] } }),
        attempt({ source_name: "fetch_compliance_violations", result_data_json: { found: true, open_count: 0 } }),
        attempt({ source_name: "fetch_orphan_well", result_data_json: { is_orphan: false } }),
        attempt({ source_name: "fetch_drilling_permits", result_data_json: { permits: [{ amend: "N" }] } }),
      ],
      coverage: [
        coverageRow({ category: "wellbore_identity" }),
        coverageRow({ category: "operator_p5" }),
        coverageRow({ category: "compliance" }),
        coverageRow({ category: "production" }),
      ],
      monthsOfHistory: 24,
      recentAvgOil: 800,
      zeroProductionMonths: 0,
      worTrend: "Stable",
      yoyDeclineOilPct: 5,
      offsetWellCount: 10,
      hasLateralPath: true,
    };
    const card = buildAcquisitionScorecard(strongInputs);
    expect(card.recommendation).toBe("PURSUE");
    expect(card.opportunity_score).toBeGreaterThanOrEqual(60);
    expect(card.risk_score).toBeLessThan(40);
  });

  it("does not double-penalize with fabricated risk when data is simply absent (recommends REVIEW, not PASS)", () => {
    const card = buildAcquisitionScorecard(baseInputs);
    // No critical flags and no data at all — this should read as "we don't
    // know enough," not "this is confirmed risky," so it must not silently
    // become an equally-confident PASS as a well with real bad signals.
    expect(card.recommendation).toBe("REVIEW");
  });

  it("scores mechanical_integrity low for a plugged well and high for an active one", () => {
    const pluggedCard = buildAcquisitionScorecard({
      ...baseInputs,
      attempts: [attempt({ source_name: "fetch_well_status", result_data_json: { status: "Plugged" } })],
    });
    const activeCard = buildAcquisitionScorecard({
      ...baseInputs,
      attempts: [attempt({ source_name: "fetch_well_status", result_data_json: { status: "Active" } })],
    });
    expect(pluggedCard.dimensions.mechanical_integrity.score).toBeLessThan(30);
    expect(activeCard.dimensions.mechanical_integrity.score).toBe(100);
  });
});

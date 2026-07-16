/**
 * TRRC Scoring Engine — unit tests.
 *
 * Tests computeAcquisitionScorecard's pure scoring logic.
 * No network calls — all data is stub-constructed inline.
 *
 * Run with: npx vitest run lib/trrc/__tests__/scoring-engine.test.ts
 */

import { describe, it, expect } from "vitest";
import { computeAcquisitionScorecard } from "../scoring-engine";
import type {
  ResolvedSearchContext,
  TrrcFinding,
  SourceCoverageStatus,
} from "../types";
import type { OrchestratorResult } from "../retrieval-orchestrator";

// ─── Shared stubs ─────────────────────────────────────────────────────────────

const minimalCtx: ResolvedSearchContext = {
  run_id: "test-run-1",
  input_type: "api_number",
  raw_input: "42-151-01734",
  normalized_input: "4215101734",
  api_numbers: [
    {
      raw: "42-151-01734",
      api10: "4215101734",
      api14: "42151017340000",
      formatted: "42-151-01734-00-00",
      state_code: "42",
      county_code: "151",
      well_code: "01734",
      is_texas: true,
    },
  ],
  district: "04",
  lease_number: "12345",
  gas_id: null,
  operator_name: "Test Operator LLC",
  operator_number: "123456",
  county: "Fisher",
  lease_name: "Test Lease",
  legal_description: null,
  search_historical: false,
  include_offset_wells: false,
  production_months: 36,
};

const emptyOrchestratorResult: OrchestratorResult = {
  run_id: "test-run-1",
  source_attempts: [],
  production: [],
  findings_raw: [],
  coverage: [],
  total_records_found: 0,
  manual_required_count: 0,
  error: null,
};

const emptyCoverage: SourceCoverageStatus[] = [];

/** Helper: create a minimal TrrcFinding */
function makeFinding(
  finding_type: string,
  severity: TrrcFinding["severity"],
  overrides: Partial<TrrcFinding> = {},
): TrrcFinding {
  return {
    id: `test_finding_${finding_type}`,
    category: "identity",
    severity,
    finding_type,
    title: `Test finding: ${finding_type}`,
    description: "Test finding description",
    evidence: {},
    source_record_ids: [],
    analytical_method: "test",
    confidence: 0.9,
    recommended_action: "Test action",
    is_directly_reported: true,
    ...overrides,
  };
}

// ─── Test 1: BLOCKED when no production and API unverified ────────────────────

describe("computeAcquisitionScorecard — BLOCKED gating", () => {
  it("returns BLOCKED recommendation when api_not_verified finding is present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("api_not_verified", "high", { category: "identity" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.recommendation).toBe("BLOCKED");
    expect(scorecard.gating_conditions.length).toBeGreaterThan(0);
  });

  it("returns BLOCKED when both api_not_verified and no_production_records present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("api_not_verified", "high", { category: "identity" }),
      makeFinding("no_production_records", "critical", { category: "production" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.recommendation).toBe("BLOCKED");
    expect(scorecard.missing_critical_evidence.length).toBeGreaterThan(0);
  });

  it("gating_conditions are non-empty strings when blocked", () => {
    const findings: TrrcFinding[] = [
      makeFinding("api_not_verified", "high", { category: "identity" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    for (const cond of scorecard.gating_conditions) {
      expect(typeof cond).toBe("string");
      expect(cond.length).toBeGreaterThan(0);
    }
  });
});

// ─── Test 2: All 10 dimensions present ───────────────────────────────────────

describe("computeAcquisitionScorecard — dimension completeness", () => {
  it("scorecard.dimensions contains all 10 required keys", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    const expectedDimensions = [
      "record_completeness",
      "identity_confidence",
      "production_quality",
      "production_consistency",
      "mechanical_integrity",
      "plugging_exposure",
      "regulatory_compliance",
      "operator_profile",
      "development_activity",
      "data_confidence",
    ] as const;

    for (const key of expectedDimensions) {
      expect(scorecard.dimensions).toHaveProperty(key);
      expect(scorecard.dimensions[key].score).toBeGreaterThanOrEqual(0);
      expect(scorecard.dimensions[key].score).toBeLessThanOrEqual(100);
    }
  });

  it("opportunity_score is in [0, 100]", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.opportunity_score).toBeGreaterThanOrEqual(0);
    expect(scorecard.opportunity_score).toBeLessThanOrEqual(100);
  });

  it("risk_score is in [0, 100]", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.risk_score).toBeGreaterThanOrEqual(0);
    expect(scorecard.risk_score).toBeLessThanOrEqual(100);
  });

  it("each dimension has label, score, weight, rationale, data_points", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    for (const dim of Object.values(scorecard.dimensions)) {
      expect(typeof dim.label).toBe("string");
      expect(typeof dim.score).toBe("number");
      expect(typeof dim.weight).toBe("number");
      expect(typeof dim.rationale).toBe("string");
      expect(Array.isArray(dim.data_points)).toBe(true);
    }
  });

  it("all dimension weights sum to approximately 1.0", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    const weightSum = Object.values(scorecard.dimensions).reduce(
      (sum, d) => sum + d.weight,
      0,
    );
    expect(Math.abs(weightSum - 1.0)).toBeLessThan(0.01);
  });
});

// ─── Test 3: Clean compliance raises compliance score ─────────────────────────

describe("computeAcquisitionScorecard — clean compliance", () => {
  it("regulatory_compliance.score >= 80 when no_violations_on_record finding present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("no_violations_on_record", "info", { category: "compliance" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.regulatory_compliance.score).toBeGreaterThanOrEqual(80);
  });

  it("regulatory_compliance.score is 100 when there are no violation findings at all", () => {
    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    // No violation findings → score starts at 100 with 0 penalty
    expect(scorecard.dimensions.regulatory_compliance.score).toBe(100);
  });
});

// ─── Test 4: Multiple open violations tanks compliance score ──────────────────

describe("computeAcquisitionScorecard — critical compliance violations", () => {
  it("regulatory_compliance.score < 50 with a critical open_violations finding", () => {
    const findings: TrrcFinding[] = [
      makeFinding("open_violations_critical", "critical", {
        category: "compliance",
        evidence: { open_violations_count: 8, total_violations_count: 10, violations_last_12m: 3 },
      }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.regulatory_compliance.score).toBeLessThan(50);
  });

  it("risk_score increases substantially with open violations", () => {
    // Baseline: no findings
    const baseScorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      [],
      emptyCoverage,
      emptyOrchestratorResult,
    );

    // With critical violations
    const findings: TrrcFinding[] = [
      makeFinding("open_violations_critical", "critical", {
        category: "compliance",
        evidence: { open_violations_count: 8, total_violations_count: 8, violations_last_12m: 0 },
      }),
    ];
    const riskScorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(riskScorecard.risk_score).toBeGreaterThan(baseScorecard.risk_score);
  });

  it("reasons_against mentions open violations when compliance score is low", () => {
    const findings: TrrcFinding[] = [
      makeFinding("open_violations_critical", "critical", {
        category: "compliance",
        evidence: { open_violations_count: 8, total_violations_count: 8, violations_last_12m: 2 },
      }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    const mentionsCompliance = scorecard.reasons_against.some((r) =>
      r.toLowerCase().includes("violation") ||
      r.toLowerCase().includes("compliance") ||
      r.toLowerCase().includes("critical"),
    );
    expect(mentionsCompliance).toBe(true);
  });
});

// ─── Test 5: Identity confidence from API verified ────────────────────────────

describe("computeAcquisitionScorecard — identity confidence dimension", () => {
  it("identity_confidence.score >= 90 when api_verified finding present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("api_verified", "info", { category: "identity" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.identity_confidence.score).toBeGreaterThanOrEqual(90);
  });

  it("identity_confidence.score <= 20 when api_not_verified finding present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("api_not_verified", "high", { category: "identity" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.identity_confidence.score).toBeLessThanOrEqual(20);
  });
});

// ─── Test 6: Production quality dimension ────────────────────────────────────

describe("computeAcquisitionScorecard — production quality dimension", () => {
  it("production_quality.score is 0 when no_production_records finding present", () => {
    const findings: TrrcFinding[] = [
      makeFinding("no_production_records", "critical", { category: "production" }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.production_quality.score).toBe(0);
  });

  it("production_quality.score >= 80 when production_records_found with 24+ months", () => {
    const findings: TrrcFinding[] = [
      makeFinding("production_records_found", "info", {
        category: "production",
        evidence: {
          months_count: 36,
          date_range: "2022-01 to 2024-12",
          can_claim_single_well_production: false,
        },
      }),
    ];

    const scorecard = computeAcquisitionScorecard(
      "test-run-1",
      minimalCtx,
      findings,
      emptyCoverage,
      emptyOrchestratorResult,
    );

    expect(scorecard.dimensions.production_quality.score).toBeGreaterThanOrEqual(80);
  });
});

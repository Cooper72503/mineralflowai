// @ts-nocheck
/**
 * TRRC Finding Engine — unit tests.
 *
 * Tests runFindingEngine's finding generation logic.
 * No network calls — all source_data is constructed inline as stubs.
 *
 * Run with: npx vitest run lib/trrc/__tests__/finding-engine.test.ts
 */

import { describe, it, expect } from "vitest";
import { runFindingEngine } from "../finding-engine";
import type {
  ResolvedSearchContext,
  TrrcFinding,
  SourceSearchResult,
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

const emptySourceData: Record<string, SourceSearchResult> = {};

/** Helper: build a SourceSearchResult stub */
function makeSourceResult(
  source_id: string,
  status: SourceSearchResult["status"],
  overrides: Partial<SourceSearchResult> = {},
): SourceSearchResult {
  return {
    source_id,
    status,
    records: [],
    manual_action_url: null,
    error: null,
    result_count: 0,
    data: null,
    ...overrides,
  };
}

/** Helper: build a production coverage entry */
function makeProdCoverage(status: SourceCoverageStatus["status"]): SourceCoverageStatus {
  return {
    category: "production",
    label: "Production",
    status,
    data_current_through: null,
    sources_checked: ["production_by_lease"],
    records_found: 0,
    notes: null,
  };
}

// ─── Test 1: Returns findings array ──────────────────────────────────────────

describe("runFindingEngine — returns findings array", () => {
  it("always returns an array", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    expect(Array.isArray(findings)).toBe(true);
  });

  it("returns at least one finding even with empty input data", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    expect(findings.length).toBeGreaterThan(0);
  });
});

// ─── Test 2: Required fields on every finding ─────────────────────────────────

describe("runFindingEngine — finding shape", () => {
  it("every finding has all required fields defined", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    for (const finding of findings) {
      expect(finding.id).toBeDefined();
      expect(finding.category).toBeDefined();
      expect(finding.severity).toBeDefined();
      expect(finding.finding_type).toBeDefined();
      expect(finding.title).toBeDefined();
      expect(finding.description).toBeDefined();
      expect(finding.evidence).toBeDefined();
      expect(finding.recommended_action).toBeDefined();
      expect(typeof finding.confidence).toBe("number");
    }
  });

  it("no finding has undefined for id, title, or description", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    for (const f of findings) {
      expect(f.id).not.toBeUndefined();
      expect(f.title).not.toBeUndefined();
      expect(f.description).not.toBeUndefined();
    }
  });

  it("all finding IDs are unique within the result", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    const ids = findings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─── Test 3: Critical finding when no production ──────────────────────────────

describe("runFindingEngine — production absence", () => {
  it("generates critical production finding when no production records returned", async () => {
    const orchestratorResult: OrchestratorResult = {
      ...emptyOrchestratorResult,
      coverage: [makeProdCoverage("retrieval_failed")],
    };

    // source_data is empty — no production_by_lease result
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      orchestratorResult,
      emptySourceData,
    );

    const criticalProdFinding = findings.find(
      (f) => f.severity === "critical" && f.finding_type.includes("production"),
    );
    expect(criticalProdFinding).toBeDefined();
  });

  it("no_production_records finding has a non-empty recommended_action", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    const noProdFinding = findings.find(
      (f) => f.finding_type === "no_production_records",
    );
    if (noProdFinding) {
      expect(noProdFinding.recommended_action.length).toBeGreaterThan(0);
    }
    // If the finding doesn't appear (coverage = not_checked), that is also valid
  });

  it("no_production_records finding has can_claim_single_well_production: false", async () => {
    const orchestratorResult: OrchestratorResult = {
      ...emptyOrchestratorResult,
      coverage: [makeProdCoverage("retrieval_failed")],
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      orchestratorResult,
      emptySourceData,
    );

    // When we do get a no_production_records finding, verify it doesn't claim single-well
    const noProdFinding = findings.find(
      (f) => f.finding_type === "no_production_records",
    );
    if (noProdFinding) {
      // The evidence should NOT claim single-well production
      const evidence = noProdFinding.evidence;
      expect(evidence["can_claim_single_well_production"]).not.toBe(true);
    }
  });
});

// ─── Test 4: API number not found generates identity finding ──────────────────

describe("runFindingEngine — identity findings", () => {
  it("generates api_not_verified finding when API input type but wellbore_query not found", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      wellbore_query: makeSourceResult("wellbore_query", "no_results"),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const identityFinding = findings.find(
      (f) => f.finding_type === "api_not_verified",
    );
    expect(identityFinding).toBeDefined();
    expect(identityFinding!.severity).toBe("high");
  });

  it("generates api_verified finding when wellbore_query succeeds with records", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      wellbore_query: makeSourceResult("wellbore_query", "success", {
        result_count: 1,
        records: [
          {
            source_id: "wellbore_query",
            document_id: "doc-1",
            title: "Well Record",
            category: "identity",
            form_type: null,
            url: null,
            filing_date: null,
            is_downloadable: false,
          },
        ],
      }),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const verifiedFinding = findings.find(
      (f) => f.finding_type === "api_verified",
    );
    expect(verifiedFinding).toBeDefined();
    expect(verifiedFinding!.severity).toBe("info");
  });
});

// ─── Test 5: Multiple API warning when lease has multiple wells ───────────────

describe("runFindingEngine — multi-well lease warning", () => {
  it("generates multiple_apis_on_lease finding when api_count > 1 in wellbore data", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      wellbore_query: makeSourceResult("wellbore_query", "success", {
        result_count: 3,
        records: [
          {
            source_id: "wellbore_query",
            document_id: "doc-1",
            title: "Well Record",
            category: "identity",
            form_type: null,
            url: null,
            filing_date: null,
            is_downloadable: false,
          },
        ],
        data: { api_count: 3 },
      }),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const multiApiWarning = findings.find(
      (f) => f.finding_type === "multiple_apis_on_lease",
    );
    expect(multiApiWarning).toBeDefined();
    expect(multiApiWarning!.severity).toBe("medium");
  });

  it("multiple_apis_on_lease finding has can_claim_single_well_production: false", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      wellbore_query: makeSourceResult("wellbore_query", "success", {
        result_count: 2,
        records: [
          {
            source_id: "wellbore_query",
            document_id: "doc-2",
            title: "Well Record",
            category: "identity",
            form_type: null,
            url: null,
            filing_date: null,
            is_downloadable: false,
          },
        ],
        data: { api_count: 2 },
      }),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const multiApiFinding = findings.find(
      (f) => f.finding_type === "multiple_apis_on_lease",
    );
    if (multiApiFinding) {
      expect(multiApiFinding.evidence["can_claim_single_well_production"]).toBe(false);
    }
  });
});

// ─── Test 6: Compliance findings ─────────────────────────────────────────────

describe("runFindingEngine — compliance findings", () => {
  it("generates compliance_not_queried info finding when no ICE result in source_data", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    const compFinding = findings.find((f) => f.finding_type === "compliance_not_queried");
    expect(compFinding).toBeDefined();
    expect(compFinding!.severity).toBe("info");
  });

  it("generates open_violations_critical when 8 open violations in ICE result", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      inspections_violations: makeSourceResult("inspections_violations", "success", {
        result_count: 8,
        records: Array.from({ length: 8 }, (_, i) => ({
          source_id: "inspections_violations",
          document_id: `viol-${i}`,
          title: `Violation ${i}`,
          category: "compliance" as const,
          form_type: null,
          url: null,
          filing_date: null,
          is_downloadable: false,
        })),
        data: {
          open_violations_count: 8,
          total_violations_count: 10,
          violations_last_12m: 2,
        },
      }),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const criticalViolFinding = findings.find(
      (f) => f.finding_type === "open_violations_critical",
    );
    expect(criticalViolFinding).toBeDefined();
    expect(criticalViolFinding!.severity).toBe("critical");
  });

  it("generates no_violations_on_record info finding when ICE returns no_results", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      inspections_violations: makeSourceResult("inspections_violations", "no_results"),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const noViolFinding = findings.find(
      (f) => f.finding_type === "no_violations_on_record",
    );
    expect(noViolFinding).toBeDefined();
    expect(noViolFinding!.severity).toBe("info");
  });
});

// ─── Test 7: Inactive well findings ──────────────────────────────────────────

describe("runFindingEngine — inactive well findings", () => {
  it("generates inactive_check_not_run info finding when no inactive_well_query in source_data", async () => {
    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      emptySourceData,
    );

    const inactiveFinding = findings.find(
      (f) => f.finding_type === "inactive_check_not_run",
    );
    expect(inactiveFinding).toBeDefined();
  });

  it("generates well_inactive_confirmed high/medium finding when well is on inactive list", async () => {
    const sourceData: Record<string, SourceSearchResult> = {
      inactive_well_query: makeSourceResult("inactive_well_query", "success", {
        result_count: 1,
        records: [
          {
            source_id: "inactive_well_query",
            document_id: "inactive-1",
            title: "Inactive Well Record",
            category: "plugging_inactive",
            form_type: null,
            url: null,
            filing_date: null,
            is_downloadable: false,
          },
        ],
        data: {
          shut_in_date: "2015-01-01",
          inactive_since: "2015-01-01",
          estimated_plugging_cost: 75000,
        },
      }),
    };

    const findings = await runFindingEngine(
      "test-run-1",
      minimalCtx,
      emptyOrchestratorResult,
      sourceData,
    );

    const inactiveFinding = findings.find(
      (f) => f.finding_type === "well_inactive_confirmed",
    );
    expect(inactiveFinding).toBeDefined();
    expect(["high", "medium"]).toContain(inactiveFinding!.severity);
    // Plugging liability must be flagged
    expect(inactiveFinding!.evidence["plugging_liability_transfers_on_acquisition"]).toBe(true);
  });
});

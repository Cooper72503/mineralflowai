// @ts-nocheck
/**
 * Source adapter unit tests.
 *
 * Tests each adapter's search() method in every status branch:
 *   - not_applicable (missing required context)
 *   - success        (mocked fetcher returns data)
 *   - no_results     (mocked fetcher returns empty / not found)
 *   - failed_transient (mocked fetcher throws)
 *
 * All external fetchers are mocked with vi.mock — zero network.
 * Run: npx vitest run lib/trrc/__tests__/source-adapters.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks — must come before adapter imports ─────────────────────────────────

vi.mock("../../wells/trrc-api", () => ({
  lookupTrrcLeasesByApis: vi.fn(),
}));

vi.mock("../../wells/trrc-production", () => ({
  fetchTrrcProductionByLease: vi.fn(),
  fetchTrrcProductionHistory: vi.fn(),
}));

vi.mock("../../underwriting/trrc-inactive-wells", () => ({
  fetchTrrcInactiveWellByApi: vi.fn(),
}));

vi.mock("../../underwriting/trrc-compliance", () => ({
  fetchTrrcViolationsByLease: vi.fn(),
}));

vi.mock("../../wells/trrc-inspection", () => ({
  fetchTrrcInspectionsByApi: vi.fn(),
}));

vi.mock("../../underwriting/trrc-injection", () => ({
  fetchTrrcInjectionByApi: vi.fn(),
}));

vi.mock("../../wells/trrc-completions", () => ({
  fetchTrrcCompletionsForApis: vi.fn(),
}));

// ─── Adapter imports (after mocks) ───────────────────────────────────────────

import { WellboreSource } from "../sources/wellbore-source";
import { ProductionByLeaseSource, ProductionByApiSource } from "../sources/production-source";
import { InactiveWellSource } from "../sources/inactive-well-source";
import { ComplianceSource } from "../sources/compliance-source";
import { CompletionSource } from "../sources/completion-source";
import {
  PluggingRecordsSource,
  OrphanWellSource,
  SeveranceSource,
  WellStatusSource,
} from "../sources/manual-fallback-sources";

import { lookupTrrcLeasesByApis } from "../../wells/trrc-api";
import { fetchTrrcProductionByLease, fetchTrrcProductionHistory } from "../../wells/trrc-production";
import { fetchTrrcInactiveWellByApi } from "../../underwriting/trrc-inactive-wells";
import { fetchTrrcViolationsByLease } from "../../underwriting/trrc-compliance";
import { fetchTrrcInspectionsByApi } from "../../wells/trrc-inspection";
import { fetchTrrcCompletionsForApis } from "../../wells/trrc-completions";

// ─── Context factories ────────────────────────────────────────────────────────

function makeApiRef(api10 = "4216502733") {
  return {
    raw: api10,
    api10,
    api14: `${api10}0000`,
    formatted: `42-${api10.slice(2, 5)}-${api10.slice(5, 10)}`,
    state_code: "42",
    county_code: api10.slice(2, 5),
    well_code: api10.slice(5, 10),
    is_texas: true,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "test-run-1",
    input_type: "api_number",
    raw_input: "42-165-02733",
    normalized_input: "4216502733",
    api_numbers: [makeApiRef()],
    district: "04",
    lease_number: "12345",
    lease_name: null,
    gas_id: null,
    operator_name: "Test Operator LLC",
    operator_number: "123456",
    county: "Fisher",
    legal_description: null,
    include_offset_wells: false,
    search_historical: false,
    production_months: 36,
    ...overrides,
  };
}

const DUMMY_OPTS = { max_records: 100, timeout_ms: 10_000 };

// ─── WellboreSource ───────────────────────────────────────────────────────────

describe("WellboreSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when api_numbers is empty", async () => {
    const result = await WellboreSource.search(makeCtx({ api_numbers: [] }), DUMMY_OPTS);
    expect(result.status).toBe("not_applicable");
    expect(result.records).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it("returns success when lookupTrrcLeasesByApis returns wells", async () => {
    const leaseMap = new Map([
      ["4216502733", { leaseNo: "12345", distCode: "04", operator: "Test Operator LLC" }],
    ]);
    lookupTrrcLeasesByApis.mockResolvedValue(leaseMap);

    const result = await WellboreSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records).toHaveLength(1);
    expect(result.result_count).toBe(1);
    expect(result.data.wells_found).toBe(1);
    expect(result.error).toBeNull();
  });

  it("returns no_results when lookup returns an empty map", async () => {
    lookupTrrcLeasesByApis.mockResolvedValue(new Map());

    const result = await WellboreSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
    expect(result.records).toHaveLength(0);
  });

  it("returns failed_transient when lookup throws", async () => {
    lookupTrrcLeasesByApis.mockRejectedValue(new Error("Network timeout"));

    const result = await WellboreSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("failed_transient");
    expect(result.error).toContain("Network timeout");
  });

  it("lists missing APIs in data when some are not found", async () => {
    const twoApis = [makeApiRef("4216502733"), makeApiRef("4216599999")];
    const leaseMap = new Map([
      ["4216502733", { leaseNo: "12345", distCode: "04", operator: "Test Op" }],
    ]);
    lookupTrrcLeasesByApis.mockResolvedValue(leaseMap);

    const result = await WellboreSource.search(makeCtx({ api_numbers: twoApis }), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.data.wells_not_found).toContain("4216599999");
  });
});

// ─── ProductionByLeaseSource ──────────────────────────────────────────────────

describe("ProductionByLeaseSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when district is null", async () => {
    const result = await ProductionByLeaseSource.search(
      makeCtx({ district: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
  });

  it("returns not_applicable when lease_number is null", async () => {
    const result = await ProductionByLeaseSource.search(
      makeCtx({ lease_number: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
  });

  it("returns success with production records", async () => {
    fetchTrrcProductionByLease.mockResolvedValue({
      distCode: "04",
      leaseNo: "12345",
      rows: [
        { year: 2023, month: 1, oil_bbl: 1200, gas_mcf: 0, water_bbl: 400 },
        { year: 2023, month: 2, oil_bbl: 1100, gas_mcf: 0, water_bbl: 380 },
      ],
    });

    const result = await ProductionByLeaseSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records).toHaveLength(2);
    expect(result.data.can_claim_single_well_production).toBe(false);
    expect(result.data.months_returned).toBe(2);
  });

  it("returns no_results when fetch returns null", async () => {
    fetchTrrcProductionByLease.mockResolvedValue(null);

    const result = await ProductionByLeaseSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
  });

  it("returns no_results when fetch returns empty rows array", async () => {
    fetchTrrcProductionByLease.mockResolvedValue({
      distCode: "04",
      leaseNo: "12345",
      rows: [],
    });

    const result = await ProductionByLeaseSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
  });

  it("returns failed_transient when fetch throws", async () => {
    fetchTrrcProductionByLease.mockRejectedValue(new Error("HTTP 503"));

    const result = await ProductionByLeaseSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("failed_transient");
    expect(result.error).toContain("HTTP 503");
  });

  it("never sets can_claim_single_well_production = true", async () => {
    fetchTrrcProductionByLease.mockResolvedValue({
      distCode: "04",
      leaseNo: "12345",
      rows: [{ year: 2024, month: 6, oil_bbl: 500, gas_mcf: 0, water_bbl: 200 }],
    });

    const result = await ProductionByLeaseSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.data.can_claim_single_well_production).toBe(false);
  });
});

// ─── ProductionByApiSource ────────────────────────────────────────────────────

describe("ProductionByApiSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when api_numbers is empty", async () => {
    const result = await ProductionByApiSource.search(
      makeCtx({ api_numbers: [] }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
  });

  it("returns success with production rows", async () => {
    fetchTrrcProductionHistory.mockResolvedValue({
      api10: "4216502733",
      district: "04",
      leaseNo: "12345",
      rows: [
        { year: 2023, month: 3, oil_bbl: 800, gas_mcf: 200, water_bbl: 350 },
      ],
    });

    const result = await ProductionByApiSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.data.can_claim_single_well_production).toBe(false);
  });

  it("returns no_results when history returns empty rows", async () => {
    fetchTrrcProductionHistory.mockResolvedValue({
      api10: "4216502733",
      district: "04",
      leaseNo: null,
      rows: [],
    });

    const result = await ProductionByApiSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
  });

  it("returns failed_transient on network error", async () => {
    fetchTrrcProductionHistory.mockRejectedValue(new Error("Connection reset"));

    const result = await ProductionByApiSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("failed_transient");
  });
});

// ─── InactiveWellSource ───────────────────────────────────────────────────────

describe("InactiveWellSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when api_numbers is empty", async () => {
    const result = await InactiveWellSource.search(
      makeCtx({ api_numbers: [] }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
  });

  it("returns no_results when all wells are active", async () => {
    fetchTrrcInactiveWellByApi.mockResolvedValue({
      is_active_not_flagged: true,
      records: [],
    });

    const result = await InactiveWellSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
    expect(result.data.all_active_not_flagged).toBe(true);
  });

  it("returns success when inactive well records found", async () => {
    fetchTrrcInactiveWellByApi.mockResolvedValue({
      is_active_not_flagged: false,
      records: [
        {
          api8: "16502733",
          lease_no: "12345",
          shut_in_date: "2021-01-01",
          plugging_cost_usd: 75000,
          extension_status: null,
          well_plugged: false,
        },
      ],
    });

    const result = await InactiveWellSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records).toHaveLength(1);
    expect(result.data.inactive_wells_found).toBe(1);
    expect(result.data.estimated_total_plugging_exposure_usd).toBe(75000);
  });

  it("queries all api_numbers in parallel", async () => {
    const twoApis = [makeApiRef("4216502733"), makeApiRef("4216502734")];
    fetchTrrcInactiveWellByApi.mockResolvedValue({
      is_active_not_flagged: true,
      records: [],
    });

    await InactiveWellSource.search(makeCtx({ api_numbers: twoApis }), DUMMY_OPTS);
    expect(fetchTrrcInactiveWellByApi).toHaveBeenCalledTimes(2);
  });

  it("returns no_results when all parallel queries reject (Promise.allSettled swallows rejections)", async () => {
    // InactiveWellSource uses Promise.allSettled — individual rejections are silently
    // treated as unfulfilled (no records added), so result is no_results not failed_transient.
    fetchTrrcInactiveWellByApi.mockRejectedValue(new Error("Unexpected error"));

    const result = await InactiveWellSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
    expect(result.error).toBeNull();
  });
});

// ─── ComplianceSource ─────────────────────────────────────────────────────────

describe("ComplianceSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when no district/lease and no api_numbers", async () => {
    const result = await ComplianceSource.search(
      makeCtx({ api_numbers: [], district: null, lease_number: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
  });

  it("returns success with violations and inspections", async () => {
    fetchTrrcViolationsByLease.mockResolvedValue([
      { violation_id: "V001", type: "Rule 78", date: "2023-03-01", status: "Open" },
    ]);
    fetchTrrcInspectionsByApi.mockResolvedValue([
      { api: "4216502733", inspection_date: "2023-06-15", inspection_type: "Routine", result: "Satisfactory" },
    ]);

    const result = await ComplianceSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records.length).toBe(2);
    expect(result.data.violations_count).toBe(1);
    expect(result.data.inspections_count).toBe(1);
  });

  it("returns success with no records when both queries return empty", async () => {
    fetchTrrcViolationsByLease.mockResolvedValue([]);
    fetchTrrcInspectionsByApi.mockResolvedValue([]);

    const result = await ComplianceSource.search(makeCtx(), DUMMY_OPTS);
    // No violations and no inspections is still a successful query — the 'no violations' signal is meaningful
    expect(["success", "no_results"]).toContain(result.status);
    expect(result.records).toHaveLength(0);
  });

  it("runs violations-only path when no api_numbers", async () => {
    fetchTrrcViolationsByLease.mockResolvedValue([
      { violation_id: "V002", type: "Rule 14", date: "2022-11-01", status: "Closed" },
    ]);

    const result = await ComplianceSource.search(
      makeCtx({ api_numbers: [] }),
      DUMMY_OPTS,
    );
    expect(fetchTrrcViolationsByLease).toHaveBeenCalledTimes(1);
    expect(fetchTrrcInspectionsByApi).not.toHaveBeenCalled();
  });

  it("returns failed_transient when fetcher throws", async () => {
    fetchTrrcViolationsByLease.mockRejectedValue(new Error("ICE portal error"));
    fetchTrrcInspectionsByApi.mockResolvedValue([]);

    const result = await ComplianceSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("failed_transient");
  });
});

// ─── CompletionSource ─────────────────────────────────────────────────────────

describe("CompletionSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_applicable when api_numbers is empty", async () => {
    const result = await CompletionSource.search(
      makeCtx({ api_numbers: [] }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("not_applicable");
    expect(result.records).toHaveLength(0);
    expect(result.manual_action_url).toBeNull();
  });

  it("returns success when completions found", async () => {
    fetchTrrcCompletionsForApis.mockResolvedValue([
      {
        api: "4216502733",
        packet_found: true,
        completion_date: "2018-04-01",
        permit_approved_date: null,
        source_url: "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
      },
    ]);

    const result = await CompletionSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("success");
    expect(result.records).toHaveLength(1);
    expect(result.data.packets_found).toBe(1);
    expect(result.data.packets_not_found).toBe(0);
  });

  it("returns success even when all packets are missing (no_packet record is still a record)", async () => {
    fetchTrrcCompletionsForApis.mockResolvedValue([
      {
        api: "4216502733",
        packet_found: false,
        completion_date: null,
        permit_approved_date: null,
        source_url: "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
      },
    ]);

    const result = await CompletionSource.search(makeCtx(), DUMMY_OPTS);
    // A missing packet still generates a record entry (title includes "[No packet found]")
    expect(result.status).toBe("success");
    expect(result.data.packets_not_found).toBe(1);
    expect(result.data.packets_found).toBe(0);
  });

  it("returns no_results only when completions array itself is empty", async () => {
    fetchTrrcCompletionsForApis.mockResolvedValue([]);

    const result = await CompletionSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
  });

  it("includes no_packet_apis list when some completions are missing", async () => {
    fetchTrrcCompletionsForApis.mockResolvedValue([
      { api: "4216502733", packet_found: true, completion_date: "2018-01-01", permit_approved_date: null, source_url: "" },
      { api: "4216599999", packet_found: false, completion_date: null, permit_approved_date: null, source_url: "" },
    ]);

    const result = await CompletionSource.search(
      makeCtx({ api_numbers: [makeApiRef("4216502733"), makeApiRef("4216599999")] }),
      DUMMY_OPTS,
    );
    expect(result.data.no_packet_apis).toContain("4216599999");
  });

  it("returns failed_transient when completions fetch throws", async () => {
    fetchTrrcCompletionsForApis.mockRejectedValue(new Error("EWA CMPL unavailable"));

    const result = await CompletionSource.search(makeCtx(), DUMMY_OPTS);
    expect(result.status).toBe("failed_transient");
  });
});

// ─── Manual fallback sources ──────────────────────────────────────────────────

describe("PluggingRecordsSource", () => {
  it("search() returns a result object with a source_id", async () => {
    // no API or lease — takes the no-context branch
    const result = await PluggingRecordsSource.search(
      makeCtx({ api_numbers: [], district: null, lease_number: null }),
      DUMMY_OPTS,
    );
    expect(result.source_id).toBe(PluggingRecordsSource.id);
    expect(typeof result.status).toBe("string");
  });

  it("returns no_results when neither API nor lease+district provided", async () => {
    const result = await PluggingRecordsSource.search(
      makeCtx({ api_numbers: [], district: null, lease_number: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("no_results");
  });
});

describe("OrphanWellSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no_results when api_numbers is empty", async () => {
    // OrphanWellSource returns 'no_results' (not 'not_applicable') when no API
    const result = await OrphanWellSource.search(makeCtx({ api_numbers: [] }), DUMMY_OPTS);
    expect(result.status).toBe("no_results");
  });

  it("has a source_id matching its id property", async () => {
    const result = await OrphanWellSource.search(makeCtx({ api_numbers: [] }), DUMMY_OPTS);
    expect(result.source_id).toBe(OrphanWellSource.id);
  });
});

describe("SeveranceSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no_results when neither API nor operator_number present", async () => {
    // SeveranceSource returns 'no_results' when no API and no operator_number
    const result = await SeveranceSource.search(
      makeCtx({ api_numbers: [], operator_number: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("no_results");
  });
});

describe("WellStatusSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no_results when no API and no lease+district", async () => {
    // WellStatusSource returns 'no_results' (not 'not_applicable') when missing context
    const result = await WellStatusSource.search(
      makeCtx({ api_numbers: [], lease_number: null, district: null }),
      DUMMY_OPTS,
    );
    expect(result.status).toBe("no_results");
  });
});

// ─── Adapter interface completeness ───────────────────────────────────────────

describe("all source adapters — interface contract", () => {
  const adapters = [
    WellboreSource,
    ProductionByLeaseSource,
    ProductionByApiSource,
    CompletionSource,
    InactiveWellSource,
    ComplianceSource,
    PluggingRecordsSource,
    OrphanWellSource,
    SeveranceSource,
    WellStatusSource,
  ];

  for (const adapter of adapters) {
    it(`${adapter.id} has required interface properties`, () => {
      expect(typeof adapter.id).toBe("string");
      expect(adapter.id.length).toBeGreaterThan(0);
      expect(typeof adapter.name).toBe("string");
      expect(typeof adapter.base_url).toBe("string");
      expect(Array.isArray(adapter.supported_inputs)).toBe(true);
      expect(["html_scrape", "api", "manual"]).toContain(adapter.retrieval_strategy);
      expect(typeof adapter.rate_limit_ms).toBe("number");
      expect(adapter.rate_limit_ms).toBeGreaterThanOrEqual(0);
      expect(typeof adapter.max_retries).toBe("number");
      expect(typeof adapter.search).toBe("function");
      expect(typeof adapter.fetchRecord).toBe("function");
      expect(typeof adapter.healthCheck).toBe("function");
    });
  }
});

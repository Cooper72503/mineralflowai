// @ts-nocheck
/**
 * Retrieval Orchestrator unit tests.
 *
 * Tests the orchestrator's core coordination logic:
 *   - dry_run mode (no network, exercises batch/coverage path)
 *   - manual adapter detection (retrieval_strategy === "manual" → manual_required)
 *   - coverage output shape
 *   - result structure invariants
 *
 * The Supabase client is mocked to a no-op. Adapters come from a mocked
 * getAllAdapters() that returns in-memory stub adapters.
 *
 * Run: npx vitest run lib/trrc/__tests__/retrieval-orchestrator.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRetrievalOrchestrator } from "../retrieval-orchestrator";

// ─── Mock getAllAdapters ───────────────────────────────────────────────────────

vi.mock("../sources/index", () => ({
  getAllAdapters: vi.fn(),
}));

// Mock the source registry so buildCoverage can resolve category mappings.
vi.mock("../source-registry", () => ({
  SOURCE_REGISTRY: {
    test_adapter_api: {
      expected_record_types: ["identity"],
    },
    test_adapter_production: {
      expected_record_types: ["production"],
    },
    test_adapter_manual: {
      expected_record_types: ["compliance"],
    },
    test_adapter_failing: {
      expected_record_types: ["well_status"],
    },
  },
}));

import { getAllAdapters } from "../sources/index";

// ─── Supabase mock factory ────────────────────────────────────────────────────

function makeSupabaseMock() {
  const noOp = () => Promise.resolve({ data: null, error: null });
  const chain = {
    upsert: vi.fn().mockReturnValue({ then: (cb) => cb({ error: null }) }),
    update: vi.fn().mockReturnValue(noOp()),
    select: vi.fn().mockReturnValue(Promise.resolve({ data: [], error: null })),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnValue(Promise.resolve({ data: null, error: null })),
  };
  // Each call to .from() returns a fresh chainable object
  const from = vi.fn().mockReturnValue(chain);
  return { from };
}

// ─── Adapter stub factory ────────────────────────────────────────────────────

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "test_adapter_api",
    name: "Test API Adapter",
    description: "Test",
    base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 0,
    max_retries: 0,
    parser_version: "1.0.0",
    is_enabled: true,
    requires_browser: false,
    search: vi.fn().mockResolvedValue({
      source_id: "test_adapter_api",
      status: "success",
      records: [{ source_id: "test_adapter_api", document_id: "doc1", title: "Test Doc", category: "identity", form_type: "test", url: "", filing_date: null, is_downloadable: false }],
      result_count: 1,
      data: {},
      error: null,
      manual_action_url: null,
    }),
    fetchRecord: vi.fn().mockResolvedValue(null),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, latency_ms: 50, error: null, last_checked: new Date().toISOString() }),
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "orch-test-run",
    input_type: "api_number",
    raw_input: "42-165-02733",
    normalized_input: "4216502733",
    api_numbers: [{
      raw: "4216502733",
      api10: "4216502733",
      api14: "42165027330000",
      formatted: "42-165-02733",
      state_code: "42",
      county_code: "165",
      well_code: "02733",
      is_texas: true,
    }],
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

// ─── Dry-run mode ─────────────────────────────────────────────────────────────

describe("runRetrievalOrchestrator — dry_run mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns run_id in result", async () => {
    getAllAdapters.mockReturnValue([makeAdapter()]);
    const supabase = makeSupabaseMock();
    const result = await runRetrievalOrchestrator(
      "orch-test-run",
      makeCtx(),
      supabase,
      { dry_run: true },
    );
    expect(result.run_id).toBe("orch-test-run");
  });

  it("never calls adapter.search() in dry_run mode", async () => {
    const adapter = makeAdapter();
    getAllAdapters.mockReturnValue([adapter]);
    const supabase = makeSupabaseMock();

    await runRetrievalOrchestrator("run1", makeCtx(), supabase, { dry_run: true });
    expect(adapter.search).not.toHaveBeenCalled();
  });

  it("produces one source_attempt per eligible adapter in dry_run", async () => {
    const a1 = makeAdapter({ id: "test_adapter_api" });
    const a2 = makeAdapter({ id: "test_adapter_production", supported_inputs: ["api_number"] });
    getAllAdapters.mockReturnValue([a1, a2]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run2", makeCtx(), supabase, { dry_run: true });
    expect(result.source_attempts).toHaveLength(2);
  });

  it("dry_run attempts have status not_applicable", async () => {
    getAllAdapters.mockReturnValue([makeAdapter()]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run3", makeCtx(), supabase, { dry_run: true });
    for (const attempt of result.source_attempts) {
      expect(attempt.status).toBe("not_applicable");
    }
  });

  it("returns error when no adapters support the input type", async () => {
    const adapter = makeAdapter({ supported_inputs: ["rrc_lease_number"] });
    getAllAdapters.mockReturnValue([adapter]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator(
      "run4",
      makeCtx({ input_type: "api_number" }),
      supabase,
      { dry_run: true },
    );
    // adapter supports "rrc_lease_number" but ctx is "api_number" → no eligible adapters
    expect(result.source_attempts).toHaveLength(0);
    expect(result.error).not.toBeNull();
    expect(typeof result.error).toBe("string");
  });

  it("disabled adapters are excluded", async () => {
    const enabled = makeAdapter({ id: "test_adapter_api", is_enabled: true });
    const disabled = makeAdapter({ id: "test_adapter_production", is_enabled: false });
    getAllAdapters.mockReturnValue([enabled, disabled]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run5", makeCtx(), supabase, { dry_run: true });
    expect(result.source_attempts).toHaveLength(1);
    expect(result.source_attempts[0].source_id).toBe("test_adapter_api");
  });
});

// ─── Manual adapter detection ─────────────────────────────────────────────────

describe("runRetrievalOrchestrator — manual adapter detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("manual adapters get manual_required status without calling search()", async () => {
    const manualAdapter = makeAdapter({
      id: "test_adapter_manual",
      retrieval_strategy: "manual",
    });
    getAllAdapters.mockReturnValue([manualAdapter]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run6", makeCtx(), supabase, {});
    expect(manualAdapter.search).not.toHaveBeenCalled();
    const attempt = result.source_attempts.find(a => a.source_id === "test_adapter_manual");
    expect(attempt?.status).toBe("manual_required");
  });

  it("manual_required_count increases for each manual adapter", async () => {
    const m1 = makeAdapter({ id: "test_adapter_manual", retrieval_strategy: "manual" });
    const m2 = makeAdapter({
      id: "test_adapter_production",
      retrieval_strategy: "manual",
    });
    getAllAdapters.mockReturnValue([m1, m2]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run7", makeCtx(), supabase, {});
    expect(result.manual_required_count).toBe(2);
  });
});

// ─── Automated adapter results ────────────────────────────────────────────────

describe("runRetrievalOrchestrator — automated adapter results", () => {
  beforeEach(() => vi.clearAllMocks());

  it("success results increment total_records_found", async () => {
    const adapter = makeAdapter({
      search: vi.fn().mockResolvedValue({
        source_id: "test_adapter_api",
        status: "success",
        records: Array(5).fill({
          source_id: "test_adapter_api",
          document_id: "d",
          title: "t",
          category: "identity",
          form_type: "f",
          url: "",
          filing_date: null,
          is_downloadable: false,
        }),
        result_count: 5,
        data: {},
        error: null,
        manual_action_url: null,
      }),
    });
    getAllAdapters.mockReturnValue([adapter]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run8", makeCtx(), supabase, {});
    expect(result.total_records_found).toBe(5);
  });

  it("failed_transient on all retries → attempt status is failed_transient", async () => {
    const adapter = makeAdapter({
      max_retries: 1,
      search: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    getAllAdapters.mockReturnValue([adapter]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run9", makeCtx(), supabase, {});
    const attempt = result.source_attempts[0];
    expect(attempt.status).toBe("failed_transient");
    expect(attempt.error_message).not.toBeNull();
  });

  it("result error is null when run succeeds", async () => {
    const adapter = makeAdapter();
    getAllAdapters.mockReturnValue([adapter]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run10", makeCtx(), supabase, {});
    expect(result.error).toBeNull();
  });
});

// ─── Result structure invariants ─────────────────────────────────────────────

describe("runRetrievalOrchestrator — result structure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("coverage array contains only objects with required fields", async () => {
    getAllAdapters.mockReturnValue([makeAdapter()]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run11", makeCtx(), supabase, { dry_run: true });
    for (const entry of result.coverage) {
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(["complete", "partial", "retrieval_failed", "manual_required", "no_applicable_record", "not_checked"]).toContain(entry.status);
      expect(typeof entry.records_found).toBe("number");
      expect(Array.isArray(entry.sources_checked)).toBe(true);
    }
  });

  it("source_attempts array is always present (even when empty)", async () => {
    getAllAdapters.mockReturnValue([]);
    const supabase = makeSupabaseMock();

    // No adapters at all — getEligible returns [] → early return path
    const result = await runRetrievalOrchestrator("run12", makeCtx(), supabase, {});
    expect(Array.isArray(result.source_attempts)).toBe(true);
  });

  it("production array is always present", async () => {
    getAllAdapters.mockReturnValue([makeAdapter()]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run13", makeCtx(), supabase, { dry_run: true });
    expect(Array.isArray(result.production)).toBe(true);
  });

  it("each attempt has required fields", async () => {
    getAllAdapters.mockReturnValue([makeAdapter()]);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator("run14", makeCtx(), supabase, { dry_run: true });
    for (const a of result.source_attempts) {
      expect(typeof a.source_id).toBe("string");
      expect(typeof a.source_name).toBe("string");
      expect(typeof a.started_at).toBe("string");
      expect(typeof a.completed_at).toBe("string");
      expect(typeof a.status).toBe("string");
      expect(typeof a.result_count).toBe("number");
    }
  });
});

// ─── Batching logic ───────────────────────────────────────────────────────────

describe("runRetrievalOrchestrator — batching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes more adapters than max_concurrent without error", async () => {
    const adapters = Array.from({ length: 7 }, (_, i) =>
      makeAdapter({
        id: `test_adapter_${i}`,
        search: vi.fn().mockResolvedValue({
          source_id: `test_adapter_${i}`,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {},
          error: null,
          manual_action_url: null,
        }),
      }),
    );
    getAllAdapters.mockReturnValue(adapters);
    const supabase = makeSupabaseMock();

    const result = await runRetrievalOrchestrator(
      "run15",
      makeCtx(),
      supabase,
      { max_concurrent_sources: 3 },
    );
    expect(result.source_attempts).toHaveLength(7);
    expect(result.error).toBeNull();
  });
});

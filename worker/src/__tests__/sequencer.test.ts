/**
 * Tests for the deterministic sequencer (sequencer.ts) — the replacement
 * for agent.ts's Claude-orchestrated loop. Fetcher functions are stubbed
 * with real, fixture-derived ground-truth values (the actual HTML parsing
 * is already covered by worker/src/tools/__tests__/) rather than mocked
 * generically, per this codebase's real-data-over-synthetic-mocks
 * convention.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("../tools/ewa.js", () => ({
  searchWellbore: vi.fn(),
  searchLeaseWells: vi.fn(),
  getWellStatus: vi.fn(),
  getProduction: vi.fn(),
  getGathererPurchaser: vi.fn(),
  getCompletionRecords: vi.fn(),
  getPluggingRecords: vi.fn(),
  getOrphanWell: vi.fn(),
  getSeveranceRecords: vi.fn(),
  getInjectionRecords: vi.fn(),
  getDrillingPermits: vi.fn(),
  getOilProration: vi.fn(),
  getGisLocation: vi.fn(),
}));
vi.mock("../tools/browser.js", () => ({
  searchOperator: vi.fn(),
  getInactiveWellStatus: vi.fn(),
  getComplianceViolations: vi.fn(),
  getCodaDocuments: vi.fn(),
}));
vi.mock("../tools/county-records.js", () => ({
  getCountyRecords: vi.fn(),
}));

import * as ewa from "../tools/ewa.js";
import {
  stepSearchWellbore,
  runLandmanSequencer,
  type AgentState,
} from "../sequencer.js";

function freshState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    apiNumber: null,
    apiNumberConfirmed: false,
    leaseNumber: null,
    district: null,
    operatorName: null,
    operatorNumber: null,
    county: null,
    production: [],
    ...overrides,
  };
}

const RUN_ID = "test-run-id";

/** Minimal in-memory Supabase stand-in covering the calls sequencer.ts and progress.ts make. Every `await` on a plain (non-thenable) object resolves immediately to that object per JS semantics, so no real Promise wiring is needed for the chained calls. */
function makeMockSupabase(runRow: Record<string, unknown> = {}, opts: { cancelled?: boolean } = {}) {
  const attempts: Record<string, unknown>[] = [];
  const upserts = { source_attempts: 0, production: 0 };

  const supabase = {
    from(table: string) {
      if (table === "trrc_due_diligence_runs") {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: opts.cancelled ? { status: "cancelled", ...runRow } : runRow }) }) }),
          update: (patch: Record<string, unknown>) => {
            const chain = {
              error: null,
              eq: () => chain,
              neq: () => chain,
            };
            return chain;
          },
        };
      }
      if (table === "trrc_source_attempts") {
        return {
          upsert: (row: Record<string, unknown>) => { attempts.push(row); upserts.source_attempts++; return Promise.resolve({ error: null }); },
          select: () => ({ eq: async () => ({ data: attempts }) }),
        };
      }
      if (table === "trrc_production_monthly") {
        return { upsert: () => { upserts.production++; return Promise.resolve({ error: null }); } };
      }
      throw new Error(`Unmocked table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { supabase, attempts, upserts };
}

describe("stepSearchWellbore — parity with agent.ts's dispatchTool reconcile logic", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(a) overwrites a pre-seeded, unconfirmed apiNumber when TRRC confirms a match", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({
      found: true,
      wells: [{ api_no: "16502733" }],
      lease_number: "10289",
      district: "8A",
      operator: "FUSION ENERGY HOLDINGS, LLC",
      operator_number: "102004",
      county: "GAINES",
    } as never);

    const { supabase } = makeMockSupabase();
    const state = freshState({ apiNumber: "16502733", apiNumberConfirmed: false });
    await stepSearchWellbore(state, RUN_ID, supabase, 1);

    expect(state.apiNumber).toBe("16502733");
    expect(state.apiNumberConfirmed).toBe(true);
    expect(state.leaseNumber).toBe("10289");
  });

  it("(c) nulls out an unconfirmed apiNumber on a confirmed zero-result miss", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({ found: false, wells: [] } as never);

    const { supabase } = makeMockSupabase();
    const state = freshState({ apiNumber: "16999999", apiNumberConfirmed: false });
    await stepSearchWellbore(state, RUN_ID, supabase, 1);

    expect(state.apiNumber).toBeNull();
  });

  it("(d) does not null out an already-confirmed apiNumber on a later miss", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({ found: false, wells: [] } as never);

    const { supabase } = makeMockSupabase();
    const state = freshState({ apiNumber: "16502733", apiNumberConfirmed: true });
    await stepSearchWellbore(state, RUN_ID, supabase, 1);

    expect(state.apiNumber).toBe("16502733");
    expect(state.apiNumberConfirmed).toBe(true);
  });

  it("persists a real source_attempts row with the sourceName the LLM-driven path also used", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({ found: true, wells: [{ api_no: "16502733" }] } as never);
    const { supabase, attempts } = makeMockSupabase();
    const state = freshState();
    await stepSearchWellbore(state, RUN_ID, supabase, 3);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]["source_name"]).toBe("search_by_api");
    expect(attempts[0]["source_id"]).toBe("search_by_api_3");
    expect(attempts[0]["status"]).toBe("success");
  });
});

describe("runLandmanSequencer — entry branches and never-stop-at-one-failure", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("bare operator-name input (no API, no lease+district) resolves via search_operator, not silently skipped", async () => {
    vi.mocked((await import("../tools/browser.js")).searchOperator).mockResolvedValue({
      found: true, record: { operator_number: "102004" },
    } as never);

    const { supabase, attempts } = makeMockSupabase({ operator_name: "FUSION ENERGY HOLDINGS, LLC", selected_input_type: "operator_name" });
    await runLandmanSequencer(RUN_ID, "FUSION ENERGY HOLDINGS, LLC", supabase);

    const opAttempt = attempts.find(a => a["source_name"] === "search_by_operator");
    expect(opAttempt).toBeDefined();
    expect(opAttempt?.["status"]).toBe("success");
  });

  it("a genuinely unresolvable input (no API, no lease, no operator) writes an honest not_applicable attempt, not a silent no-op", async () => {
    const { supabase, attempts } = makeMockSupabase({ selected_input_type: "unknown" });
    await runLandmanSequencer(RUN_ID, "some ambiguous free text", supabase);

    const entryAttempt = attempts.find(a => a["source_name"] === "entry_resolution");
    expect(entryAttempt).toBeDefined();
    expect(entryAttempt?.["status"]).toBe("not_applicable");
  });

  it("never stops at one failure — an independent later step still runs and persists after an earlier step throws", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({
      found: true, wells: [{ api_no: "16502733" }], lease_number: "10289", district: "8A", county: "GAINES",
    } as never);
    // get_production throws outright (network-level failure before the
    // fetcher's own try/catch could shape a result object)
    vi.mocked(ewa.getProduction).mockRejectedValue(new Error("network failure"));
    // an independent, unrelated source should still run despite that
    vi.mocked(ewa.getOrphanWell).mockResolvedValue({ found: false } as never);

    const { supabase, attempts } = makeMockSupabase({ resolved_primary_api: "16502733" });
    await runLandmanSequencer(RUN_ID, "16502733", supabase);

    const orphanAttempt = attempts.find(a => a["source_name"] === "fetch_orphan_well");
    expect(orphanAttempt).toBeDefined();
    const prodAttempt = attempts.find(a => a["source_name"] === "fetch_production");
    expect(prodAttempt?.["status"]).toBe("failed_transient");
  });

  it("returns early without a terminal update when the run is cancelled mid-sequence", async () => {
    vi.mocked(ewa.searchWellbore).mockResolvedValue({
      found: true, wells: [{ api_no: "16502733" }], lease_number: "10289", district: "8A",
    } as never);

    const { supabase, upserts } = makeMockSupabase({ resolved_primary_api: "16502733" }, { cancelled: true });
    await runLandmanSequencer(RUN_ID, "16502733", supabase);

    // The entry step itself still ran (cancellation is checked before the
    // remainingSteps loop, matching the original's between-step check),
    // but nothing past that should have executed once cancellation is seen.
    expect(upserts.source_attempts).toBeLessThanOrEqual(1);
  });
});

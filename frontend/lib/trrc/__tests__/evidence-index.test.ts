/**
 * Tests for buildEvidenceIndex — the per-source ledger of what was queried,
 * where, and what came back.
 *
 * Key behaviors under test: every supported source appears even if never
 * attempted this run (a complete accounting, not just "what happened to
 * run"); retrieval failures are distinguished from confirmed-absent results
 * (the same "failed download != clean compliance" principle applied
 * throughout this pipeline); and query criteria are derived from the run's
 * actually-resolved identifiers, never fabricated.
 */

import { describe, it, expect } from "vitest";
import { buildEvidenceIndex } from "../evidence-index";
import type { LiteSourceAttempt } from "../coverage";
import type { TrrcDueDiligenceRun } from "../types";

const baseRun = {
  original_input: "42-329-46771",
  resolved_primary_api: "4232946771",
  resolved_lease_number: "59990",
  resolved_district: "08",
  resolved_operator_number: "148113",
} as unknown as TrrcDueDiligenceRun;

function attempt(overrides: Partial<LiteSourceAttempt>): LiteSourceAttempt {
  return {
    source_id: "x_0",
    source_name: "x",
    status: "success",
    result_count: 0,
    error_message: null,
    attempted_at: "2026-07-27T19:33:41.000Z",
    result_data_json: null,
    ...overrides,
  };
}

describe("buildEvidenceIndex", () => {
  it("includes every supported source, even ones never attempted this run", () => {
    const index = buildEvidenceIndex([], baseRun);
    const names = index.map((e) => e.source_name);
    expect(names).toContain("fetch_drilling_permits");
    expect(names).toContain("fetch_coda_records");
    expect(index.find((e) => e.source_name === "fetch_drilling_permits")!.status).toBe("not_attempted");
  });

  it("marks a real retrieval failure distinctly from a confirmed absence", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_well_status", status: "failed_transient", error_message: "HTTP 500" }),
      attempt({ source_name: "fetch_injection_records", status: "success", result_count: 0, result_data_json: { found: false } }),
    ];
    const index = buildEvidenceIndex(attempts, baseRun);

    const failed = index.find((e) => e.source_name === "fetch_well_status")!;
    expect(failed.status).toBe("retrieval_failed");
    expect(failed.status_note).toMatch(/HTTP 500/);

    const absent = index.find((e) => e.source_name === "fetch_injection_records")!;
    expect(absent.status).toBe("confirmed_absent");
  });

  it("reports real retrieved data with its actual record count", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_drilling_permits", result_count: 2, result_data_json: { found: true, permits: [{}, {}] } }),
    ];
    const index = buildEvidenceIndex(attempts, baseRun);
    const entry = index.find((e) => e.source_name === "fetch_drilling_permits")!;
    expect(entry.status).toBe("retrieved");
    expect(entry.record_count).toBe(2);
  });

  it("derives query criteria from the run's resolved identifiers, not fabricated values", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_production", result_count: 0, result_data_json: { found: false } }),
      attempt({ source_name: "search_by_operator", result_count: 9, result_data_json: { found: true } }),
    ];
    const index = buildEvidenceIndex(attempts, baseRun);
    expect(index.find((e) => e.source_name === "fetch_production")!.query_criteria).toBe("Lease 59990, District 08");
    expect(index.find((e) => e.source_name === "search_by_operator")!.query_criteria).toBe("Operator No. 148113");
  });

  it("flags manual-required sources distinctly", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_coda_records", status: "success", result_data_json: { data_gap: true } }),
    ];
    const index = buildEvidenceIndex(attempts, baseRun);
    expect(index.find((e) => e.source_name === "fetch_coda_records")!.status).toBe("manual_required");
  });
});

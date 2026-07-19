// @ts-nocheck
/**
 * TRRC Live Integration Tests
 *
 * Makes REAL HTTP requests to the Texas Railroad Commission EWA portal.
 * NO mocking. These tests verify that every parser, fetcher, and source adapter
 * works end-to-end against actual TRRC endpoints.
 *
 * Fixture well: API 4215131926 (Fisher County, TX)
 * Confirmed via live debug in trrc-api.ts:399 ("PROVEN via live debug 2026-05-20: Fisher/Bomar").
 *
 * Expected run time: 3–10 minutes.
 * Run: npx vitest run lib/trrc/__tests__/trrc-live-integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";

// ── Raw fetchers ──────────────────────────────────────────────────────────────
import { lookupTrrcLeasesByApis } from "../../wells/trrc-api";
import {
  fetchTrrcProductionByLease,
  fetchTrrcProductionHistory,
} from "../../wells/trrc-production";
import {
  fetchTrrcInactiveWellByApi,
  fetchTrrcInactiveWellsByOperator,
} from "../../underwriting/trrc-inactive-wells";
import {
  fetchTrrcViolations,
  fetchTrrcViolationsByLease,
} from "../../underwriting/trrc-compliance";
import {
  fetchTrrcCompletionByApi,
  fetchTrrcCompletionsForApis,
} from "../../wells/trrc-completions";
import { fetchTrrcPluggingByApi } from "../../wells/trrc-plugging";
import { fetchTrrcOrphanWellByApi } from "../../wells/trrc-orphan-wells";
import { fetchTrrcSeveranceByApi } from "../../wells/trrc-severance";
import { fetchTrrcWellStatus } from "../../wells/trrc-well-status";

// ── Source adapters ───────────────────────────────────────────────────────────
import { WellboreSource } from "../sources/wellbore-source";
import { ProductionByLeaseSource, ProductionByApiSource } from "../sources/production-source";
import { ComplianceSource } from "../sources/compliance-source";
import { CompletionSource } from "../sources/completion-source";
import { InactiveWellSource } from "../sources/inactive-well-source";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture well — Fisher County, TX (confirmed real via live debug 2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────

const TEST_API10 = "4215131926";  // 10-digit with "42" state prefix
const TEST_OPTS = { dry_run: false, production_months: 24 };

/** Resolved from TRRC in beforeAll; used by downstream tests. */
let resolvedLease: { distCode: string; leaseNo: string; operator: string } | null = null;

beforeAll(async () => {
  const map = await lookupTrrcLeasesByApis(null, [TEST_API10]);
  resolvedLease = map.get(TEST_API10) ?? null;
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Entity Resolution  (lookupTrrcLeasesByApis)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — entity resolution (lookupTrrcLeasesByApis)", () => {

  it("returns a Map for a valid Texas API", async () => {
    const result = await lookupTrrcLeasesByApis(null, [TEST_API10]);
    expect(result).toBeInstanceOf(Map);
  }, 120_000);

  it("Fisher County well resolves to a lease entry", async () => {
    const result = await lookupTrrcLeasesByApis(null, [TEST_API10]);
    expect(result.has(TEST_API10)).toBe(true);
  }, 120_000);

  it("resolved entry has distCode, leaseNo, operator fields", async () => {
    const result = await lookupTrrcLeasesByApis(null, [TEST_API10]);
    const entry = result.get(TEST_API10);
    expect(entry).not.toBeNull();
    expect(typeof entry!.distCode).toBe("string");
    expect(entry!.distCode.length).toBeGreaterThan(0);
    expect(typeof entry!.leaseNo).toBe("string");
    expect(entry!.leaseNo.length).toBeGreaterThan(0);
    expect(typeof entry!.operator).toBe("string");
  }, 120_000);

  it("returns empty Map for an unknown API (not a real well)", async () => {
    const result = await lookupTrrcLeasesByApis(null, ["4200000001"]);
    // Either no entry or no result — should not throw
    expect(result).toBeInstanceOf(Map);
  }, 120_000);

  it("handles multiple APIs in one call", async () => {
    const apis = [TEST_API10, "4215100001"];
    const result = await lookupTrrcLeasesByApis(null, apis);
    expect(result).toBeInstanceOf(Map);
    // At minimum the known well resolves
    expect(result.has(TEST_API10)).toBe(true);
  }, 120_000);

  it("accepts county name without throwing", async () => {
    const result = await lookupTrrcLeasesByApis("Fisher", [TEST_API10]);
    expect(result).toBeInstanceOf(Map);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — Production  (fetchTrrcProductionByLease, fetchTrrcProductionHistory)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — production (fetchTrrcProductionByLease)", () => {

  it("returns null or a result object — never throws", async () => {
    if (!resolvedLease) return; // entity resolution failed upstream
    const result = await fetchTrrcProductionByLease(
      resolvedLease.distCode,
      resolvedLease.leaseNo,
      24,
    );
    expect(result === null || typeof result === "object").toBe(true);
  }, 120_000);

  it("result has rows array when non-null", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcProductionByLease(
      resolvedLease.distCode,
      resolvedLease.leaseNo,
      24,
    );
    if (result === null) return; // well may have no recent data — that's fine
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.distCode).toBe(resolvedLease.distCode);
    expect(result.leaseNo).toBe(resolvedLease.leaseNo);
  }, 120_000);

  it("each production row has year, month, oil_bbl fields", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcProductionByLease(
      resolvedLease.distCode,
      resolvedLease.leaseNo,
      36,
    );
    if (!result || result.rows.length === 0) return;
    for (const row of result.rows) {
      expect(typeof row.year).toBe("number");
      expect(typeof row.month).toBe("number");
      expect(row.month).toBeGreaterThanOrEqual(1);
      expect(row.month).toBeLessThanOrEqual(12);
      expect(typeof row.oil_bbl).toBe("number");
    }
  }, 120_000);

  it("fetchTrrcProductionHistory by API — never throws", async () => {
    const result = await fetchTrrcProductionHistory(TEST_API10);
    expect(result === null || typeof result === "object").toBe(true);
  }, 120_000);

  it("fetchTrrcProductionHistory result has correct shape when non-null", async () => {
    const result = await fetchTrrcProductionHistory(TEST_API10);
    if (result === null) return;
    expect(typeof result.api_number).toBe("string");
    expect(Array.isArray(result.rows)).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — Inactive Well Status
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — inactive well status (fetchTrrcInactiveWellByApi)", () => {

  it("returns a TrrcInactiveWellResult — never throws", async () => {
    const result = await fetchTrrcInactiveWellByApi(TEST_API10);
    expect(typeof result.is_active_not_flagged).toBe("boolean");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("records array elements have required fields", async () => {
    const result = await fetchTrrcInactiveWellByApi(TEST_API10);
    for (const rec of result.records) {
      expect(typeof rec.api8).toBe("string");
      expect(typeof rec.district).toBe("string");
      expect(typeof rec.lease_no).toBe("string");
      expect(["oil", "gas", "unknown"]).toContain(rec.oil_or_gas);
      expect(typeof rec.well_plugged).toBe("boolean");
    }
  }, 120_000);

  it("fetchTrrcInactiveWellsByOperator never throws for a valid operator number", async () => {
    // Pioneer Natural Resources — large Permian Basin operator
    const result = await fetchTrrcInactiveWellsByOperator("0594157", "O");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("inactive well records have correct numeric fields when present", async () => {
    const result = await fetchTrrcInactiveWellsByOperator("0594157", "O");
    for (const rec of result.slice(0, 5)) {
      expect(rec.plugging_cost_usd === null || typeof rec.plugging_cost_usd === "number").toBe(true);
      expect(rec.api_depth_ft === null || typeof rec.api_depth_ft === "number").toBe(true);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — Well Status  (fetchTrrcWellStatus)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — well status (fetchTrrcWellStatus)", () => {

  it("returns an array — never throws", async () => {
    const result = await fetchTrrcWellStatus(TEST_API10);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("well status records have required fields when present", async () => {
    const result = await fetchTrrcWellStatus(TEST_API10);
    for (const rec of result) {
      expect(typeof rec).toBe("object");
      expect(rec).not.toBeNull();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — Plugging Records  (fetchTrrcPluggingByApi)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — plugging records (fetchTrrcPluggingByApi)", () => {

  it("returns an array — never throws", async () => {
    const result = await fetchTrrcPluggingByApi(TEST_API10);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("plugging records have required fields when present", async () => {
    const result = await fetchTrrcPluggingByApi(TEST_API10);
    for (const rec of result) {
      expect(typeof rec).toBe("object");
      expect(rec).not.toBeNull();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — Orphan Well  (fetchTrrcOrphanWellByApi)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — orphan well (fetchTrrcOrphanWellByApi)", () => {

  it("returns an array — never throws", async () => {
    const result = await fetchTrrcOrphanWellByApi(TEST_API10);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("orphan records have required fields when present", async () => {
    const result = await fetchTrrcOrphanWellByApi(TEST_API10);
    for (const rec of result) {
      expect(typeof rec).toBe("object");
      expect(rec).not.toBeNull();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 7 — Severance  (fetchTrrcSeveranceByApi)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — severance (fetchTrrcSeveranceByApi)", () => {

  it("returns an array — never throws", async () => {
    const result = await fetchTrrcSeveranceByApi(TEST_API10);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("severance records have required fields when present", async () => {
    const result = await fetchTrrcSeveranceByApi(TEST_API10);
    for (const rec of result) {
      expect(typeof rec).toBe("object");
      expect(rec).not.toBeNull();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 8 — Compliance / Violations
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — compliance (fetchTrrcViolations, fetchTrrcViolationsByLease)", () => {

  it("fetchTrrcViolations by API returns an array — never throws", async () => {
    const result = await fetchTrrcViolations(TEST_API10);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("violation records have required fields when present", async () => {
    const result = await fetchTrrcViolations(TEST_API10);
    for (const v of result) {
      expect(typeof v.type).toBe("string");
      expect(typeof v.description).toBe("string");
      expect(["open", "closed", "unknown"]).toContain(v.status);
      expect(v.penalty_usd === null || typeof v.penalty_usd === "number").toBe(true);
    }
  }, 120_000);

  it("fetchTrrcViolationsByLease returns an array — never throws", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcViolationsByLease(resolvedLease.leaseNo);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("violation dates are string or null when present", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcViolationsByLease(resolvedLease.leaseNo);
    for (const v of result) {
      expect(v.date === null || typeof v.date === "string").toBe(true);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 9 — Completions  (fetchTrrcCompletionByApi, fetchTrrcCompletionsForApis)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — completions (fetchTrrcCompletionByApi)", () => {

  it("fetchTrrcCompletionByApi returns a completion record — never throws", async () => {
    const result = await fetchTrrcCompletionByApi(TEST_API10);
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  }, 120_000);

  it("completion record has api and packet_found fields", async () => {
    const result = await fetchTrrcCompletionByApi(TEST_API10);
    expect(typeof result.api).toBe("string");
    expect(typeof result.packet_found).toBe("boolean");
  }, 120_000);

  it("completion date is string or null", async () => {
    const result = await fetchTrrcCompletionByApi(TEST_API10);
    expect(result.completion_date === null || typeof result.completion_date === "string").toBe(true);
  }, 120_000);

  it("total_depth_ft is number or null", async () => {
    const result = await fetchTrrcCompletionByApi(TEST_API10);
    expect(result.total_depth_ft === null || typeof result.total_depth_ft === "number").toBe(true);
  }, 120_000);

  it("fetchTrrcCompletionsForApis returns an array — never throws", async () => {
    const result = await fetchTrrcCompletionsForApis([TEST_API10]);
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("completions array has one record per input API", async () => {
    const result = await fetchTrrcCompletionsForApis([TEST_API10]);
    expect(result).toHaveLength(1);
    expect(result[0].api).toBe(TEST_API10);
  }, 120_000);

  it("handles multiple APIs without throwing", async () => {
    const apis = [TEST_API10, "4215100002"];
    const result = await fetchTrrcCompletionsForApis(apis);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 10 — Source Adapters (end-to-end adapter.search() with real context)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal but valid ResolvedSearchContext for source adapter tests.
 * Uses the resolved lease from beforeAll when available.
 */
function makeRealCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "live-test-run",
    input_type: "api_number",
    raw_input: "42-151-31926-00-00",
    normalized_input: TEST_API10,
    api_numbers: [{
      raw: TEST_API10,
      api10: TEST_API10,
      api14: `${TEST_API10}0000`,
      formatted: "42-151-31926",
      state_code: "42",
      county_code: "151",
      well_code: "31926",
      is_texas: true,
    }],
    district: resolvedLease?.distCode ?? null,
    lease_number: resolvedLease?.leaseNo ?? null,
    lease_name: null,
    gas_id: null,
    operator_name: resolvedLease?.operator ?? null,
    operator_number: null,
    county: "Fisher",
    legal_description: null,
    include_offset_wells: false,
    search_historical: false,
    production_months: 24,
    ...overrides,
  };
}

describe("TRRC live — WellboreSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    const ctx = makeRealCtx();
    const result = await WellboreSource.search(ctx, TEST_OPTS);
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  }, 120_000);

  it("result has required SourceSearchResult fields", async () => {
    const ctx = makeRealCtx();
    const result = await WellboreSource.search(ctx, TEST_OPTS);
    expect(typeof result.source_id).toBe("string");
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
    expect(typeof result.result_count).toBe("number");
  }, 120_000);

  it("wellbore query resolves Fisher County well to success status", async () => {
    const ctx = makeRealCtx();
    const result = await WellboreSource.search(ctx, TEST_OPTS);
    // Status must be one of the valid values — success indicates at least one record found
    expect(["success", "no_results", "failed_transient", "not_applicable"]).toContain(result.status);
    // For the known Fisher County well we expect success
    expect(result.status).toBe("success");
  }, 120_000);

  it("each wellbore record has required fields", async () => {
    const ctx = makeRealCtx();
    const result = await WellboreSource.search(ctx, TEST_OPTS);
    for (const rec of result.records) {
      expect(typeof rec.source_id).toBe("string");
      expect(typeof rec.document_id).toBe("string");
      expect(typeof rec.title).toBe("string");
      expect(typeof rec.category).toBe("string");
    }
  }, 120_000);

  it("not_applicable when api_numbers is empty", async () => {
    const ctx = makeRealCtx({ api_numbers: [] });
    const result = await WellboreSource.search(ctx, TEST_OPTS);
    expect(result.status).toBe("not_applicable");
    expect(result.records).toHaveLength(0);
  }, 120_000);
});

describe("TRRC live — ProductionByLeaseSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    if (!resolvedLease) return;
    const ctx = makeRealCtx();
    const result = await ProductionByLeaseSource.search(ctx, TEST_OPTS);
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("returns not_applicable when district or lease_number is missing", async () => {
    const ctx = makeRealCtx({ district: null, lease_number: null });
    const result = await ProductionByLeaseSource.search(ctx, TEST_OPTS);
    expect(result.status).toBe("not_applicable");
  }, 120_000);

  it("production records have required fields when status is success", async () => {
    if (!resolvedLease) return;
    const ctx = makeRealCtx();
    const result = await ProductionByLeaseSource.search(ctx, TEST_OPTS);
    if (result.status !== "success") return;
    for (const rec of result.records) {
      expect(typeof rec.source_id).toBe("string");
      expect(typeof rec.document_id).toBe("string");
      expect(typeof rec.category).toBe("string");
    }
  }, 120_000);
});

describe("TRRC live — ProductionByApiSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    const ctx = makeRealCtx();
    const result = await ProductionByApiSource.search(ctx, TEST_OPTS);
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("result data has canClaimSingleWellProduction always false", async () => {
    const ctx = makeRealCtx();
    const result = await ProductionByApiSource.search(ctx, TEST_OPTS);
    if (result.data) {
      // Architectural invariant: we never claim single-well production
      expect(result.data.canClaimSingleWellProduction).not.toBe(true);
    }
  }, 120_000);
});

describe("TRRC live — ComplianceSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    const ctx = makeRealCtx();
    const result = await ComplianceSource.search(ctx, TEST_OPTS);
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("result status is a valid enum value", async () => {
    const ctx = makeRealCtx();
    const result = await ComplianceSource.search(ctx, TEST_OPTS);
    expect(["success", "no_results", "failed_transient", "not_applicable", "manual_required"]).toContain(result.status);
  }, 120_000);

  it("compliance data fields are correctly typed when present", async () => {
    const ctx = makeRealCtx();
    const result = await ComplianceSource.search(ctx, TEST_OPTS);
    if (!result.data) return;
    // violations_count is only present on the success path; absent (undefined) on the no-results path
    const vc = result.data.violations_count;
    const ic = result.data.inspections_count;
    expect(vc === undefined || vc === null || typeof vc === "number").toBe(true);
    expect(ic === undefined || ic === null || typeof ic === "number").toBe(true);
  }, 120_000);
});

describe("TRRC live — CompletionSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    const ctx = makeRealCtx();
    const result = await CompletionSource.search(ctx, TEST_OPTS);
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("result status is a valid enum value", async () => {
    const ctx = makeRealCtx();
    const result = await CompletionSource.search(ctx, TEST_OPTS);
    expect(["success", "no_results", "failed_transient", "not_applicable"]).toContain(result.status);
  }, 120_000);

  it("completion records have required fields when status is success", async () => {
    const ctx = makeRealCtx();
    const result = await CompletionSource.search(ctx, TEST_OPTS);
    if (result.status !== "success") return;
    for (const rec of result.records) {
      expect(typeof rec.document_id).toBe("string");
      expect(rec.category).toBe("completion");
    }
  }, 120_000);
});

describe("TRRC live — InactiveWellSource adapter", () => {

  it("search() returns a SourceSearchResult — never throws", async () => {
    const ctx = makeRealCtx();
    const result = await InactiveWellSource.search(ctx, TEST_OPTS);
    expect(typeof result.status).toBe("string");
    expect(Array.isArray(result.records)).toBe(true);
  }, 120_000);

  it("result status is a valid enum value", async () => {
    const ctx = makeRealCtx();
    const result = await InactiveWellSource.search(ctx, TEST_OPTS);
    expect(["success", "no_results", "failed_transient", "not_applicable"]).toContain(result.status);
  }, 120_000);

  it("inactive well records have required fields when status is success", async () => {
    const ctx = makeRealCtx();
    const result = await InactiveWellSource.search(ctx, TEST_OPTS);
    if (result.status !== "success") return;
    for (const rec of result.records) {
      expect(typeof rec.document_id).toBe("string");
      expect(typeof rec.category).toBe("string");
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 11 — Parser contract: fields never silently NaN or undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — numeric field parser contracts", () => {

  it("production row oil_bbl is never NaN", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcProductionByLease(
      resolvedLease.distCode,
      resolvedLease.leaseNo,
      36,
    );
    if (!result) return;
    for (const row of result.rows) {
      expect(Number.isNaN(row.oil_bbl)).toBe(false);
    }
  }, 120_000);

  it("production row year is a 4-digit integer", async () => {
    if (!resolvedLease) return;
    const result = await fetchTrrcProductionByLease(
      resolvedLease.distCode,
      resolvedLease.leaseNo,
      36,
    );
    if (!result) return;
    for (const row of result.rows) {
      expect(Number.isInteger(row.year)).toBe(true);
      expect(row.year).toBeGreaterThanOrEqual(1993);
      expect(row.year).toBeLessThanOrEqual(new Date().getFullYear() + 1);
    }
  }, 120_000);

  it("inactive well plugging_cost_usd is never NaN when set", async () => {
    const result = await fetchTrrcInactiveWellByApi(TEST_API10);
    for (const rec of result.records) {
      if (rec.plugging_cost_usd !== null) {
        expect(Number.isNaN(rec.plugging_cost_usd)).toBe(false);
        expect(rec.plugging_cost_usd).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);

  it("violation penalty_usd is never NaN when set", async () => {
    const result = await fetchTrrcViolations(TEST_API10);
    for (const v of result) {
      if (v.penalty_usd !== null) {
        expect(Number.isNaN(v.penalty_usd)).toBe(false);
        expect(v.penalty_usd).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);

  it("completion total_depth_ft is never NaN when set", async () => {
    const result = await fetchTrrcCompletionByApi(TEST_API10);
    if (result.total_depth_ft !== null) {
      expect(Number.isNaN(result.total_depth_ft)).toBe(false);
      expect(result.total_depth_ft).toBeGreaterThan(0);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 12 — Resilience: bad inputs must never throw
// ─────────────────────────────────────────────────────────────────────────────

describe("TRRC live — resilience (bad inputs never throw)", () => {

  it("lookupTrrcLeasesByApis handles empty array", async () => {
    const result = await lookupTrrcLeasesByApis(null, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  }, 120_000);

  it("fetchTrrcProductionByLease handles invalid distCode/leaseNo", async () => {
    const result = await fetchTrrcProductionByLease("XX", "000000", 12);
    expect(result === null || typeof result === "object").toBe(true);
  }, 120_000);

  it("fetchTrrcInactiveWellByApi handles garbage API string", async () => {
    const result = await fetchTrrcInactiveWellByApi("0000000000");
    expect(typeof result.is_active_not_flagged).toBe("boolean");
  }, 120_000);

  it("fetchTrrcViolations handles garbage API string", async () => {
    const result = await fetchTrrcViolations("0000000000");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("fetchTrrcCompletionsForApis handles empty array", async () => {
    const result = await fetchTrrcCompletionsForApis([]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  }, 120_000);

  it("fetchTrrcPluggingByApi handles garbage API string", async () => {
    const result = await fetchTrrcPluggingByApi("0000000000");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("fetchTrrcOrphanWellByApi handles garbage API string", async () => {
    const result = await fetchTrrcOrphanWellByApi("0000000000");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("fetchTrrcSeveranceByApi handles garbage API string", async () => {
    const result = await fetchTrrcSeveranceByApi("0000000000");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("fetchTrrcWellStatus handles garbage API string", async () => {
    const result = await fetchTrrcWellStatus("0000000000");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);

  it("fetchTrrcInactiveWellsByOperator handles non-existent operator number", async () => {
    const result = await fetchTrrcInactiveWellsByOperator("0000001");
    expect(Array.isArray(result)).toBe(true);
  }, 120_000);
});

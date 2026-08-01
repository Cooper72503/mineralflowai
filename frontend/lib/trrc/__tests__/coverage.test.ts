import { describe, it, expect } from "vitest";
import { deriveCoverageFromAttempts, type LiteSourceAttempt } from "../coverage";

function attempt(overrides: Partial<LiteSourceAttempt>): LiteSourceAttempt {
  return {
    source_id: "x_0",
    source_name: "x",
    status: "success",
    result_count: 0,
    error_message: null,
    attempted_at: "2026-08-01T00:00:00.000Z",
    result_data_json: null,
    ...overrides,
  };
}

describe("well_status coverage — GIS map-symbol fallback", () => {
  // wellStatusQueryAction.do has no working replacement on TRRC's current
  // EWA (confirmed live — not linked anywhere on the real menu), so
  // fetch_well_status always fails. RRC's own public GIS well-locations
  // layer encodes real status in its map-symbol field ("Oil Well", "Plugged
  // Oil Well", "Permitted Location", etc.), already retrieved successfully
  // by fetch_gis_plat on nearly every run — this should be credited as the
  // well_status category's answer instead of leaving it permanently
  // "retrieval_failed" for a source that can never succeed.

  it("credits well_status from the GIS well_type when the direct query failed", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_well_status", status: "failed_transient", error_message: "EWA wellStatusQueryAction.do session GET returned HTTP 500" }),
      attempt({ source_name: "fetch_gis_plat", status: "success", result_count: 1, result_data_json: { found: true, well_type: "Oil Well" } }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const wellStatus = coverage.find(c => c.category === "well_status");
    expect(wellStatus?.status).toBe("complete");
    expect(wellStatus?.sources_checked).toEqual(["fetch_gis_plat"]);
    expect(wellStatus?.notes).toContain("Oil Well");
  });

  it("does not override a genuinely successful direct well_status result", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_well_status", status: "success", result_count: 1, result_data_json: { found: true, status: "Active" } }),
      attempt({ source_name: "fetch_gis_plat", status: "success", result_count: 1, result_data_json: { found: true, well_type: "Oil Well" } }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const wellStatus = coverage.find(c => c.category === "well_status");
    expect(wellStatus?.sources_checked).toEqual(["fetch_well_status"]);
  });

  it("leaves well_status as retrieval_failed when GIS also has no usable well_type", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_well_status", status: "failed_transient", error_message: "boom" }),
      attempt({ source_name: "fetch_gis_plat", status: "failed_transient", error_message: "GIS error" }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const wellStatus = coverage.find(c => c.category === "well_status");
    expect(wellStatus?.status).toBe("retrieval_failed");
  });
});

describe("plugging coverage — GIS map-symbol fallback", () => {
  it("credits plugging as a confirmed absence when GIS shows the well is not plugged", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_plugging_records", status: "failed_transient", error_message: "EWA pluggingQueryAction.do session GET returned HTTP 500" }),
      attempt({ source_name: "fetch_gis_plat", status: "success", result_count: 1, result_data_json: { found: true, well_type: "Oil Well" } }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const plugging = coverage.find(c => c.category === "plugging");
    expect(plugging?.status).toBe("no_applicable_record");
    expect(plugging?.notes).toContain("not plugged");
  });

  it("keeps plugging as retrieval_failed (never fabricates filing details) when GIS shows a plugged symbol", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_plugging_records", status: "failed_transient", error_message: "EWA pluggingQueryAction.do session GET returned HTTP 500" }),
      attempt({ source_name: "fetch_gis_plat", status: "success", result_count: 1, result_data_json: { found: true, well_type: "Plugged Oil Well" } }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const plugging = coverage.find(c => c.category === "plugging");
    expect(plugging?.status).toBe("retrieval_failed");
    expect(plugging?.notes).toContain("Manual verification required");
  });

  it("does not override a genuinely successful direct plugging result", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_plugging_records", status: "success", result_count: 1, result_data_json: { found: true } }),
      attempt({ source_name: "fetch_gis_plat", status: "success", result_count: 1, result_data_json: { found: true, well_type: "Plugged Oil Well" } }),
    ];
    const coverage = deriveCoverageFromAttempts(attempts);
    const plugging = coverage.find(c => c.category === "plugging");
    expect(plugging?.sources_checked).toEqual(["fetch_plugging_records"]);
  });
});

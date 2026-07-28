/**
 * Tests for buildTimeline, using the real permit data confirmed live
 * against TRRC tonight (API 42-329-46771, Chevron, Midland — an original
 * New Drill filing plus a 2025 amendment) for the permit-date parsing
 * case, and synthetic-but-realistic data for the other event types since
 * no real fixture with non-null completion/plugging/violation dates was
 * captured this session.
 */

import { describe, it, expect } from "vitest";
import { buildTimeline } from "../timeline-builder";
import type { LiteSourceAttempt } from "../coverage";

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

describe("buildTimeline", () => {
  it("parses the Approved date (not Submitted) from real permit status_date text", () => {
    const attempts = [attempt({
      source_name: "fetch_drilling_permits",
      result_data_json: {
        found: true,
        permits: [
          { status_date: "Submitted: 01/22/2024 Approved: 01/25/2024", filing_purpose: "New Drill", amend: "N" },
          { status_date: "Submitted: 01/27/2025 Approved: 03/28/2025", filing_purpose: "New Drill", amend: "Y" },
        ],
      },
    })];
    const timeline = buildTimeline(attempts, []);
    expect(timeline).toEqual([
      { date: "2024-01-25", label: "Drilling Permit (W-1) — New Drill", category: "permit" },
      { date: "2025-03-28", label: "Drilling Permit (W-1) — New Drill (Amendment)", category: "permit" },
    ]);
  });

  it("drops events whose date could not be parsed rather than guessing", () => {
    const attempts = [attempt({
      source_name: "fetch_completion_records",
      result_data_json: { completion_date: "unknown / not on file" },
    })];
    expect(buildTimeline(attempts, [])).toEqual([]);
  });

  it("includes first and last reported production month, sorted with everything else", () => {
    const production = [
      { entity_type: "lease" as const, api_number: null, district: "08", lease_number: "1", gas_id: null, operator_number: null, production_month: "2024-03", oil_bbl: 500, casinghead_gas_mcf: null, gas_mcf: null, condensate_bbl: null, water_bbl: null },
      { entity_type: "lease" as const, api_number: null, district: "08", lease_number: "1", gas_id: null, operator_number: null, production_month: "2024-01", oil_bbl: 900, casinghead_gas_mcf: null, gas_mcf: null, condensate_bbl: null, water_bbl: null },
      { entity_type: "lease" as const, api_number: null, district: "08", lease_number: "1", gas_id: null, operator_number: null, production_month: "2024-02", oil_bbl: null, casinghead_gas_mcf: null, gas_mcf: null, condensate_bbl: null, water_bbl: null },
    ];
    const timeline = buildTimeline([], production);
    expect(timeline).toEqual([
      { date: "2024-01-01", label: "First Reported Production", category: "production" },
      { date: "2024-03-01", label: "Most Recent Reported Production", category: "production" },
    ]);
  });

  it("flags an open compliance violation distinctly from a resolved one", () => {
    const attempts = [attempt({
      source_name: "fetch_compliance_violations",
      result_data_json: {
        violations: [
          { violation_discovery_date: "06/01/2025", violated_rule_description: "Rule 8 — Waste", compliant_on_reinspection: "N" },
          { violation_discovery_date: "01/15/2025", violated_rule_description: "Rule 3 — Records", compliant_on_reinspection: "Y" },
        ],
      },
    })];
    const timeline = buildTimeline(attempts, []);
    expect(timeline[0].label).toBe("Compliance Violation — Rule 3 — Records");
    expect(timeline[1].label).toBe("Compliance Violation — Rule 8 — Waste — OPEN");
  });
});

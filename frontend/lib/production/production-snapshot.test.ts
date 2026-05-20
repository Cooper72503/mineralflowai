import { describe, expect, it } from "vitest";
import { buildProductionSnapshot } from "./index";
import type { ProductionSnapshotInput } from "./types";

function baseInput(overrides: Partial<ProductionSnapshotInput> = {}): ProductionSnapshotInput {
  return {
    county: null,
    state: null,
    legal_description: null,
    acreage: null,
    operator: null,
    document_type: null,
    bopd: null,
    bwpd: null,
    monthly_revenue: null,
    annual_revenue: null,
    nearby_activity_signal: null,
    location_context: null,
    drill_difficulty: null,
    extracted_text_sample: "",
    structured_source: {},
    ...overrides,
  };
}

describe("production snapshot V1", () => {
  it("TEST 1: producing-style — revenue, BOPD, operator", () => {
    const out = buildProductionSnapshot(
      baseInput({
        annual_revenue: 120_000,
        monthly_revenue: 10_000,
        bopd: 12,
        operator: "Example Operator LLC",
        county: "Midland",
        state: "TX",
        extracted_text_sample:
          "Royalty interest in producing wells. Average monthly check amount reflects ongoing production.",
        location_context: { nearby_activity_signal: "High" },
      })
    );
    expect(out.production_status).toBe("producing");
    expect(["medium", "high"]).toContain(out.production_confidence);
    expect(out.production_trend).not.toBe("");
    expect(["growing", "stable", "declining", "unknown"]).toContain(out.production_trend);
  });

  it("TEST 2: legacy / declining language — weak cue, mature asset", () => {
    const out = buildProductionSnapshot(
      baseInput({
        bopd: 2,
        county: "Ector",
        state: "TX",
        extracted_text_sample:
          "Stripper well in a mature field. Tail-end production with no recent workover. Legacy well language.",
        structured_source: { effective_date: "1998-06-01" },
      })
    );
    expect(["declining_or_legacy", "likely_producing"]).toContain(out.production_status);
    expect(["declining", "unknown"]).toContain(out.production_trend);
    expect(["low", "medium"]).toContain(out.production_confidence);
  });

  it("TEST 3: undeveloped legal-only", () => {
    const out = buildProductionSnapshot(
      baseInput({
        county: "Stark",
        state: "ND",
        legal_description: "Township 154 North, Range 100 West, Section 12",
        acreage: 40,
        extracted_text_sample: "All minerals in Section 12 described herein.",
      })
    );
    expect(out.production_status).toBe("undeveloped");
    expect(["low", "medium"]).toContain(out.production_confidence);
    expect(out.estimated_first_production_year).toBeNull();
  });

  it("TEST 4: sparse unknown input", () => {
    const out = buildProductionSnapshot(baseInput({ extracted_text_sample: "   " }));
    expect(out.production_status).toBe("unknown");
    expect(out.production_confidence).toBe("low");
    expect(out.summary.length).toBeGreaterThan(10);
    expect(out.risks.length).toBeGreaterThan(0);
  });
});

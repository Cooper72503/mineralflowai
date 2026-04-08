import { describe, expect, it } from "vitest";
import { runPreUnderwritingValuation } from "./index";
import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import { dealGradeFullLabelFromScore } from "@/lib/document-processing/deal-score";
import type { FinancialSummary } from "@/lib/financial/financial-summary";
import { buildLocationContext } from "@/lib/location/location-context";
import { drillSnapshotFromDealInput } from "@/lib/scoring/drillDifficultyEngine";
import { buildDevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";
import { extractionFieldsRecordForSignals } from "@/lib/development/apply-development-snapshot";

function baseDealScore(overrides: Partial<DealScoreResult> = {}): DealScoreResult {
  return {
    score: 62,
    grade: dealGradeFullLabelFromScore(62),
    type: "lead",
    reasons: [],
    ...overrides,
  };
}

describe("pre-underwriting valuation scenarios", () => {
  it("TEST 1: undeveloped / legal — Stark County, 24 acres, royalty 1/5", () => {
    const text =
      "Township 154 North, Range 100 West, Section 12, Stark County, North Dakota. 24 acres more or less.";
    const parsed = {
      county: "Stark",
      state: "ND",
      legal_description: text,
      royalty_rate: "1/5",
      acreage: 24,
      document_type: "Mineral Deed",
    };
    const dealScoreInput: Record<string, unknown> = {
      county: "Stark",
      state: "ND",
      legal_description: text,
      acreage: 24,
      royalty_rate: "1/5",
    };
    const financial: FinancialSummary | null = null;
    const dev = buildDevelopmentSignalsSnapshot(
      text,
      extractionFieldsRecordForSignals({
        legal_description: text,
        document_type: "Mineral Deed",
        county: "Stark",
        state: "ND",
        lessor: null,
        lessee: null,
        grantor: null,
        grantee: null,
      }),
      dealScoreInput
    );
    dealScoreInput.development_signals = dev;
    const loc = buildLocationContext({
      county: "Stark",
      state: "ND",
      legal_description: text,
      extracted_text: text,
      merged: dealScoreInput,
      development_signals: dev,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const out = runPreUnderwritingValuation({
      documentId: "doc-test-1",
      parsed,
      dealScoreInput,
      dealScore: baseDealScore(),
      financialSummary: financial,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(out.deal_type === "undeveloped" || out.deal_type === "lease").toBe(true);
    expect(out.activity_level).not.toBe("unknown");
    expect(out.estimated_total_value_high).not.toBeNull();
    expect(out.estimated_total_value_high).toBeGreaterThan(0);
    expect(out.nri).not.toBeNull();
    expect(out.recommendation).toMatch(/PURSUE|REVIEW|PASS/);
  });

  it("TEST 2: producing / mixed — Fisher County, BOPD + SWD language", () => {
    const text =
      "Fisher County, Texas. Salt water disposal (SWD) facility and oil production approximately 18 BOPD. Recompletion upside noted.";
    const parsed = {
      county: "Fisher",
      state: "TX",
      legal_description: "Abstract 400, Section 2",
      royalty_rate: "20%",
      acreage: 40,
      document_type: "Assignment",
    };
    const dealScoreInput: Record<string, unknown> = {
      county: "Fisher",
      state: "TX",
      acreage: 40,
      royalty_rate: "20%",
    };
    const dev = buildDevelopmentSignalsSnapshot(
      text,
      extractionFieldsRecordForSignals({
        legal_description: parsed.legal_description,
        document_type: "Assignment",
        county: "Fisher",
        state: "TX",
        lessor: null,
        lessee: null,
        grantor: null,
        grantee: null,
      }),
      dealScoreInput
    );
    dealScoreInput.development_signals = dev;
    const loc = buildLocationContext({
      county: "Fisher",
      state: "TX",
      legal_description: parsed.legal_description,
      extracted_text: text,
      merged: dealScoreInput,
      development_signals: dev,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const out = runPreUnderwritingValuation({
      parsed,
      dealScoreInput,
      dealScore: baseDealScore({ score: 58 }),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(
      out.deal_type === "mixed" ||
        out.deal_type === "infrastructure" ||
        out.deal_type === "producing"
    ).toBe(true);
    expect(out.summary.length).toBeGreaterThan(10);
    expect(out._value_method).toBeDefined();
  });

  it("TEST 3: sparse legal — low confidence, review or pass", () => {
    const text = "Being a tract of land described by metes and bounds in the records.";
    const parsed = {
      county: null,
      state: null,
      legal_description: text,
      royalty_rate: null,
      acreage: null,
    };
    const dealScoreInput: Record<string, unknown> = {
      legal_description: text,
    };
    const loc = buildLocationContext({
      county: null,
      state: null,
      legal_description: text,
      extracted_text: text,
      merged: dealScoreInput,
      development_signals: null,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const out = runPreUnderwritingValuation({
      parsed,
      dealScoreInput,
      dealScore: baseDealScore({ score: 22 }),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(out.confidence).toBe("low");
    expect(out.recommendation === "REVIEW" || out.recommendation === "PASS").toBe(true);
    expect(out.missing_data.length).toBeGreaterThan(0);
  });
});

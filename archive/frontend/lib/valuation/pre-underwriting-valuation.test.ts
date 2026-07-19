import { describe, expect, it } from "vitest";
import { buildValuationInput } from "./build-valuation-input";
import { computeValuationConfidence, runPreUnderwritingValuation } from "./index";
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

  it("TEST 4: legal description only — no acreage, no royalty, county unknown; still returns valuation (REVIEW / low)", () => {
    const text =
      "Abstract No. 4521, Block 3, Section 14, H.T.&B.R.R. Co. Survey, situated in the State of Texas.";
    const parsed = {
      county: null,
      state: null,
      legal_description: text,
      royalty_rate: null,
      acreage: null,
      document_type: null,
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
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });
    expect(vIn.state).toBe("Texas");
    expect(vIn.legal_description_parsed?.section).toBe("14");

    const out = runPreUnderwritingValuation({
      parsed,
      dealScoreInput,
      dealScore: baseDealScore({ score: 40 }),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(out).toBeTruthy();
    expect(out.recommendation).toBe("REVIEW");
    expect(out.confidence).toBe("low");
    expect(Array.isArray(out.missing_data)).toBe(true);
    expect(out.missing_data.length).toBeGreaterThan(0);
    expect(out.summary.length).toBeGreaterThan(10);
  });

  it("inferred county from legal text + structured legal can reach medium confidence (legal-description-heavy)", () => {
    const text =
      "Section 14, Block 3, Abstract No. 4521, H.T.&B.R.R. Co. Survey, Ward County, Texas.";
    const parsed = {
      county: null,
      state: null,
      legal_description: text,
      royalty_rate: null,
      acreage: null,
      document_type: null,
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
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(vIn.county_source).toBe("inferred");
    expect(vIn.county).toMatch(/Ward/i);

    const conf = computeValuationConfidence(vIn, "unknown");
    expect(conf.tier).toBe("medium");
    expect(conf.weighted_score).toBeGreaterThanOrEqual(18);
    expect(conf.reasoning.present_signals.length).toBeGreaterThan(0);
    expect(conf.reasoning.missing_signals.length).toBeGreaterThan(0);

    const out = runPreUnderwritingValuation({
      parsed,
      dealScoreInput,
      dealScore: baseDealScore({ score: 40 }),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });
    expect(out.confidence).toBe("medium");
    expect(out.confidence_reasoning?.summary?.length).toBeGreaterThan(20);
  });

  it("PLSS + ND: infers county/state and acreage from text; legal parse and valuation band", () => {
    const text = [
      "Stark County, North Dakota",
      "24 acres",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
    ].join("\n");
    const parsed = {
      legal_description: text,
      royalty_rate: "1/5",
      ownership_percent: 0.25,
      document_type: "Mineral Deed",
    };
    const dealScoreInput: Record<string, unknown> = {
      legal_description: text,
      royalty_rate: "1/5",
      ownership_percent: 0.25,
    };
    const dev = buildDevelopmentSignalsSnapshot(
      text,
      extractionFieldsRecordForSignals({
        legal_description: text,
        document_type: "Mineral Deed",
        county: null,
        state: null,
        lessor: null,
        lessee: null,
        grantor: null,
        grantee: null,
      }),
      dealScoreInput
    );
    dealScoreInput.development_signals = dev;
    const loc = buildLocationContext({
      county: null,
      state: null,
      legal_description: text,
      extracted_text: text,
      merged: dealScoreInput,
      development_signals: dev,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(vIn.county).toBe("Stark County");
    expect(vIn.state).toBe("North Dakota");
    expect(vIn.acreage).toBe(24);
    expect(vIn.legal_description_parsed?.plss_township).toBe("140 North");
    expect(vIn.legal_description_parsed?.plss_range).toBe("94 West");
    expect(vIn.legal_description_parsed?.section).toBe("4");
    expect(vIn.legal_description_parsed?.plss_aliquot).toBe("SE 1/4");

    const out = runPreUnderwritingValuation({
      documentId: "doc-plss-nd",
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      dealScore: baseDealScore(),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: text,
    });

    expect(out.deal_type).not.toBe("unknown");
    expect(out._value_method).not.toBe("error_fallback");
    expect(out.estimated_total_value_high).not.toBeNull();
    expect(out.estimated_total_value_high).toBeGreaterThan(0);
    expect(out.confidence === "medium" || out.confidence === "high").toBe(true);
  });

  it("TEST: Mineral Property Summary — structured county/state/acreage/legal null; full extracted text only", () => {
    const extractedText = [
      "Mineral Property Summary",
      "",
      "County: Stark County, North Dakota",
      "Acreage: 24 acres",
      "",
      "Legal Description:",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
      "Section 9 N 1/2",
    ].join("\n");
    const parsed = {
      county: null as string | null,
      state: null as string | null,
      legal_description: null as string | null,
      acreage: null as number | null,
      royalty_rate: "1/5" as string | null,
      ownership_percent: 0.25,
      document_type: "Mineral Deed",
    };
    const dealScoreInput: Record<string, unknown> = {
      royalty_rate: "1/5",
      ownership_percent: 0.25,
    };
    const loc = buildLocationContext({
      county: null,
      state: null,
      legal_description: null,
      extracted_text: extractedText,
      merged: dealScoreInput,
      development_signals: null,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText,
    });
    expect(vIn.county).toBe("Stark County");
    expect(vIn.state).toBe("North Dakota");
    expect(vIn.acreage).toBe(24);
    expect(vIn.legal_description_parsed?.plss_township).toBe("140 North");
    expect(vIn.legal_description_parsed?.plss_range).toBe("94 West");
    const out = runPreUnderwritingValuation({
      documentId: "doc-mineral-summary",
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      dealScore: baseDealScore(),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText,
    });
    expect(out.deal_type).not.toBe("unknown");
    expect(out._value_method).not.toBe("error_fallback");
  });

  it("raw_text only: Stark County ND, 24 acres, PLSS from full extracted text (no structured county/state/acreage)", () => {
    const body = [
      "Stark County, North Dakota",
      "24 acres",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
    ].join("\n");
    const parsed = {
      legal_description: null as string | null,
      royalty_rate: "1/5",
      ownership_percent: 0.25,
      document_type: "Mineral Deed",
    };
    const dealScoreInput: Record<string, unknown> = {
      royalty_rate: "1/5",
      ownership_percent: 0.25,
    };
    const loc = buildLocationContext({
      county: null,
      state: null,
      legal_description: null,
      extracted_text: "",
      merged: dealScoreInput,
      development_signals: null,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: "",
      raw_text: body,
    });

    expect(vIn.county).toBe("Stark County");
    expect(vIn.state).toBe("North Dakota");
    expect(vIn.acreage).toBe(24);
    expect(vIn.legal_description_parsed?.plss_township).toBe("140 North");
    expect(vIn.legal_description_parsed?.plss_range).toBe("94 West");
    expect(vIn.legal_description_parsed?.section).toBe("4");

    const conf = computeValuationConfidence(vIn, "undeveloped");
    expect(conf.tier === "medium" || conf.tier === "high").toBe(true);

    const out = runPreUnderwritingValuation({
      documentId: "doc-raw-text-only",
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      dealScore: baseDealScore(),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: "",
      raw_text: body,
    });

    expect(out).not.toBeNull();
    expect(out.estimated_total_value_high).not.toBeNull();
    expect(out.estimated_total_value_high).toBeGreaterThan(0);
    expect(out.confidence === "medium" || out.confidence === "high").toBe(true);
  });

  it("data flow: thin extractedText + full combinedExtractionText infers county/state/acreage/legal when structured is null", () => {
    const combined = [
      "Mineral Property Summary",
      "",
      "County: Stark County, North Dakota",
      "Acreage: 24 acres",
      "",
      "Legal Description:",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
    ].join("\n");
    const parsed = {
      county: null as string | null,
      state: null as string | null,
      legal_description: null as string | null,
      acreage: null as number | null,
      royalty_rate: "1/5" as string | null,
      ownership_percent: 0.25,
      document_type: "Mineral Deed",
    };
    const dealScoreInput: Record<string, unknown> = {
      royalty_rate: "1/5",
      ownership_percent: 0.25,
    };
    const loc = buildLocationContext({
      county: null,
      state: null,
      legal_description: null,
      extracted_text: "header only",
      merged: dealScoreInput,
      development_signals: null,
    });
    const drill = drillSnapshotFromDealInput(dealScoreInput);
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: "header only",
      combinedExtractionText: combined,
    });
    expect(vIn.county).toBe("Stark County");
    expect(vIn.state).toBe("North Dakota");
    expect(vIn.acreage).toBe(24);
    expect(vIn.legal_description_parsed?.plss_township).toBe("140 North");

    const out = runPreUnderwritingValuation({
      documentId: "doc-combined-only",
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      dealScore: baseDealScore(),
      financialSummary: null,
      locationContext: loc,
      drillSnapshot: drill,
      extractedText: "header only",
      combinedExtractionText: combined,
    });
    expect(out.deal_type).not.toBe("unknown");
    expect(out._value_method).not.toBe("error_fallback");
  });

  it("merge: zero acreage on deal score does not block acreage from fullText", () => {
    const body = "County: Stark County, North Dakota\nAcreage: 24 acres\n";
    const parsed = { county: null, state: null, legal_description: null, acreage: null };
    const dealScoreInput: Record<string, unknown> = { acreage: 0 };
    const drill = drillSnapshotFromDealInput({});
    const vIn = buildValuationInput({
      parsed: parsed as Record<string, unknown>,
      dealScoreInput,
      financialSummary: null,
      locationContext: null,
      drillSnapshot: drill,
      extractedText: body,
    });
    expect(vIn.acreage).toBe(24);
  });
});

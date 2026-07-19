import type { DealValuationOutput, RunPreUnderwritingValuationArgs } from "./types";
import { buildValuationInput } from "./build-valuation-input";
import { classifyDealType, inferHasProductionSignals } from "./deal-type";
import { resolveActivityLevel } from "./activity-tier";
import { estimateDirectionalNriProxy } from "./nri";
import { computeValuationConfidence } from "./confidence";
import { estimateValueRange } from "./value-estimator";
import { deriveRecommendation } from "./recommendation";
import { buildValuationNarrative } from "./summary";
import { logValuationDev } from "./normalize";

function countMissingCritical(input: ReturnType<typeof buildValuationInput>): number {
  let n = 0;
  if (!input.county?.trim()) n++;
  if (input.acreage == null || input.acreage <= 0) n++;
  if (input.royalty_rate == null || input.royalty_rate <= 0) n++;
  if (input.ownership_percent == null) n++;
  const hasRev =
    (input.annual_revenue != null && input.annual_revenue > 0) ||
    (input.monthly_revenue != null && input.monthly_revenue > 0);
  const hasProd = input.bopd != null && input.bopd > 0;
  if (!hasRev && !hasProd) n++;
  return n;
}

const FALLBACK: DealValuationOutput = {
  deal_type: "unknown",
  activity_level: "unknown",
  nri: null,
  nri_basis: null,
  value_per_acre_low: null,
  value_per_acre_high: null,
  estimated_total_value_low: null,
  estimated_total_value_high: null,
  recommendation: "REVIEW",
  confidence: "low",
  confidence_reasoning: {
    summary: "Confidence could not be computed — defaulting to low.",
    present_signals: [],
    missing_signals: ["complete extraction"],
  },
  summary:
    "Pre-underwriting valuation could not be computed safely from available signals — treat as manual review.",
  reasoning: ["Insufficient structured inputs after a safe merge — defaulting to conservative review mode."],
  risks: ["Screening engine error or missing enrichment — re-run processing if this persists."],
  missing_data: ["complete extraction", "location", "economic signals"],
  _value_method: "error_fallback",
};

/**
 * End-to-end pre-underwriting valuation — never throws; returns conservative output on failure.
 */
export function runPreUnderwritingValuation(args: RunPreUnderwritingValuationArgs): DealValuationOutput {
  try {
    const fullText =
      args.combinedExtractionText ||
      args.extractedText ||
      args.raw_text ||
      "";

    const vIn = buildValuationInput({
      documentId: args.documentId ?? undefined,
      parsed: args.parsed,
      dealScoreInput: args.dealScoreInput,
      financialSummary: args.financialSummary,
      locationContext: args.locationContext,
      drillSnapshot: args.drillSnapshot,
      extractedText: args.extractedText,
      raw_text: args.raw_text,
      combinedExtractionText: args.combinedExtractionText,
    });

    logValuationDev("valuation_input", {
      document_id: vIn.document_id,
      county: vIn.county,
      acreage: vIn.acreage,
      royalty_rate: vIn.royalty_rate,
      bopd: vIn.bopd,
    });

    const hasProduction = inferHasProductionSignals(vIn, args.financialSummary);
    const dealType = classifyDealType({
      documentType: vIn.document_type ?? null,
      legalDescription: vIn.legal_description ?? null,
      extractedText: fullText,
      developmentSignals: vIn.development_signals ?? null,
      acreage: vIn.acreage ?? null,
      county: vIn.county ?? null,
      hasProduction,
      producingStatusOverride: args.producingStatusOverride,
    });

    const activity = resolveActivityLevel({
      locationContext: args.locationContext,
      dealScoreInput: args.dealScoreInput,
      dealType,
      county: vIn.county,
      state: vIn.state,
    });

    const nriResult = estimateDirectionalNriProxy(vIn);
    const value = estimateValueRange({
      input: vIn,
      dealType,
      activity,
      nearbyWells:       args.nearbyWells ?? null,
      declineAnalysis:   args.declineAnalysis ?? null,
      mineralEconomics:  args.mineralEconomics ?? null,
      riskFlags:         args.riskFlags ?? null,
      paLiability:       args.paLiability ?? null,
    });

    const missingCritical = countMissingCritical(vIn);
    const hasNumericBand =
      value.estimated_total_value_low != null &&
      value.estimated_total_value_high != null &&
      value.estimated_total_value_high > 0;

    const confidenceComputed = computeValuationConfidence(vIn, dealType);
    let confidence = confidenceComputed.tier;
    let confidence_reasoning = confidenceComputed.reasoning;

    // Screening $ band is part of explainability: do not label "high" without a numeric range.
    if (!hasNumericBand && confidence === "high") {
      confidence = "medium";
      confidence_reasoning = {
        ...confidence_reasoning,
        summary:
          confidence_reasoning.summary +
          " Dollar band not formed from inputs, so confidence is capped at medium.",
      };
    }
    // Extremely thin inputs: align with conservative review posture.
    if (missingCritical >= 5) {
      confidence = "low";
      confidence_reasoning = {
        ...confidence_reasoning,
        summary:
          "Low confidence: multiple critical underwriting fields are missing from the merged extraction.",
        missing_signals: confidence_reasoning.missing_signals,
        present_signals: confidence_reasoning.present_signals,
      };
    }

    const recommendation = deriveRecommendation({
      dealScore: args.dealScore,
      confidence,
      activity,
      totalLow: value.estimated_total_value_low,
      totalHigh: value.estimated_total_value_high,
      missingCritical,
    });

    const narrative = buildValuationNarrative({
      input: vIn,
      dealType,
      activity,
      value,
      nriLine: nriResult.nri_basis,
    });

    // Prepend valuation-adjustment reasoning lines (decline, risk, P&A)
    // before the narrative's general reasoning bullets so they appear first.
    const allReasoning = value.reasoning_additions.length > 0
      ? [...value.reasoning_additions, ...narrative.reasoning]
      : narrative.reasoning;

    const out: DealValuationOutput = {
      deal_type: dealType,
      activity_level: activity,
      nri: nriResult.nri,
      nri_basis: nriResult.nri_basis,
      value_per_acre_low: value.value_per_acre_low,
      value_per_acre_high: value.value_per_acre_high,
      estimated_total_value_low: value.estimated_total_value_low,
      estimated_total_value_high: value.estimated_total_value_high,
      point_estimate: value.point_estimate,
      point_estimate_basis: value.point_estimate_basis,
      recommendation,
      confidence,
      confidence_reasoning,
      summary: narrative.summary,
      reasoning: allReasoning,
      risks: narrative.risks,
      missing_data: narrative.missing_data,
      _value_method: value.method,
    };

    logValuationDev("persistence_path", {
      recommendation: out.recommendation,
      confidence: out.confidence,
      deal_type: out.deal_type,
      value_method: out._value_method,
    });

    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[valuation] runPreUnderwritingValuation failed", msg);
    return {
      ...FALLBACK,
      risks: [...FALLBACK.risks, `Engine exception (non-fatal): ${msg.slice(0, 200)}`],
    };
  }
}

export type {
  DealValuationInput,
  DealValuationOutput,
  RunPreUnderwritingValuationArgs,
  ValuationConfidenceReasoning,
} from "./types";
export {
  buildValuationHaystackText,
  buildValuationInput,
  readCombinedPipelineTextFromStructured,
  readRawPdfTextFromStructured,
} from "./build-valuation-input";
export { computeValuationConfidence } from "./confidence";

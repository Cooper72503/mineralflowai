import type { DealValuationOutput, RunPreUnderwritingValuationArgs } from "./types";
import { buildValuationInput } from "./build-valuation-input";
import { classifyDealType, inferHasProductionSignals } from "./deal-type";
import { resolveActivityLevel } from "./activity-tier";
import { estimateDirectionalNriProxy } from "./nri";
import { deriveValuationConfidence } from "./confidence";
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
    const vIn = buildValuationInput({
      documentId: args.documentId ?? undefined,
      parsed: args.parsed,
      dealScoreInput: args.dealScoreInput,
      financialSummary: args.financialSummary,
      locationContext: args.locationContext,
      drillSnapshot: args.drillSnapshot,
      extractedText: args.extractedText,
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
      extractedText: args.extractedText,
      developmentSignals: vIn.development_signals ?? null,
      acreage: vIn.acreage ?? null,
      county: vIn.county ?? null,
      hasProduction,
    });

    const activity = resolveActivityLevel({
      locationContext: args.locationContext,
      dealScoreInput: args.dealScoreInput,
      dealType,
    });

    const nriResult = estimateDirectionalNriProxy(vIn);
    const confidence = deriveValuationConfidence(vIn, dealType);
    const value = estimateValueRange({ input: vIn, dealType, activity });

    const missingCritical = countMissingCritical(vIn);
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

    const out: DealValuationOutput = {
      deal_type: dealType,
      activity_level: activity,
      nri: nriResult.nri,
      nri_basis: nriResult.nri_basis,
      value_per_acre_low: value.value_per_acre_low,
      value_per_acre_high: value.value_per_acre_high,
      estimated_total_value_low: value.estimated_total_value_low,
      estimated_total_value_high: value.estimated_total_value_high,
      recommendation,
      confidence,
      summary: narrative.summary,
      reasoning: narrative.reasoning,
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
} from "./types";
export { buildValuationInput } from "./build-valuation-input";

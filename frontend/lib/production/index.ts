import type { ProductionSnapshotInput, ProductionSnapshotOutput } from "./types";
import { classifyProductionStatus, scanProductionLanguage, type ClassifyStatusSignals } from "./classify-production-status";
import { estimateProductionConfidence } from "./confidence";
import { estimateProducingAge } from "./estimate-producing-age";
import { estimateProductionTrend } from "./estimate-production-trend";
import { buildProductionNarrative } from "./summary";

export type { ProductionSnapshotInput, ProductionSnapshotOutput } from "./types";
export { buildProductionSnapshotInput, type BuildProductionSnapshotInputArgs } from "./build-production-input";
export { isProductionSnapshotOutput } from "./types";

function buildLanguageSignals(input: ProductionSnapshotInput, textSample: string): ClassifyStatusSignals {
  const scanned = scanProductionLanguage(textSample);
  const hasDirectRevenue =
    (input.annual_revenue != null && input.annual_revenue > 0) ||
    (input.monthly_revenue != null && input.monthly_revenue > 0);
  const hasDirectBopd = input.bopd != null && input.bopd > 0;
  const hasDirectBwpd = input.bwpd != null && input.bwpd > 0;
  const hasOperatorOrActivityContext =
    Boolean(input.operator?.trim()) ||
    input.nearby_activity_signal === "High" ||
    input.nearby_activity_signal === "Moderate";

  return {
    ...scanned,
    hasDirectRevenue,
    hasDirectBopd,
    hasDirectBwpd,
    hasOperatorOrActivityContext,
  };
}

/**
 * Directional production screening for pre-underwriting — always returns structured output.
 */
export function buildProductionSnapshot(input: ProductionSnapshotInput): ProductionSnapshotOutput {
  const textSample = input.extracted_text_sample ?? "";
  const lang = buildLanguageSignals(input, textSample);

  const production_status = classifyProductionStatus(input, lang);

  if (process.env.NODE_ENV !== "production") {
    console.log("[production-status]", { production_status });
  }

  const { producing_age_estimate, estimated_first_production_year } = estimateProducingAge({
    input,
    textSample,
    productionStatus: production_status,
  });

  const production_trend = estimateProductionTrend({
    input,
    textSample,
    productionStatus: production_status,
    producingAge: producing_age_estimate,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("[production-trend]", { production_trend, producing_age_estimate });
  }

  const hasStrongText = lang.hasStrongProducingLanguage || lang.hasLikelyProducingLanguage;
  const production_confidence = estimateProductionConfidence({
    input,
    productionStatus: production_status,
    hasStrongText,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("[production-confidence]", { production_confidence });
  }

  const narrative = buildProductionNarrative({
    input,
    status: production_status,
    trend: production_trend,
    age: producing_age_estimate,
    firstYear: estimated_first_production_year,
    confidence: production_confidence,
  });

  return {
    production_status,
    production_trend,
    producing_age_estimate,
    estimated_first_production_year,
    production_confidence,
    summary: narrative.summary,
    reasoning: narrative.reasoning,
    risks: narrative.risks,
    missing_data: narrative.missing_data,
  };
}

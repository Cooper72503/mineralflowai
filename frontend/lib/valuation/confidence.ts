import type { DealValuationInput } from "./types";
import type { DealValuationDealType } from "./types";
import { logValuationDev } from "./normalize";

export function scoreInputCompleteness(input: DealValuationInput): number {
  let pts = 0;
  if (input.county?.trim()) pts += 1;
  if (input.state?.trim()) pts += 0.5;
  if (input.acreage != null && input.acreage > 0) pts += 1;
  if (input.royalty_rate != null && input.royalty_rate > 0) pts += 1;
  if (input.ownership_percent != null) pts += 0.5;
  if (input.annual_revenue != null && input.annual_revenue > 0) pts += 1.5;
  else if (input.monthly_revenue != null && input.monthly_revenue > 0) pts += 1;
  if (input.bopd != null && input.bopd > 0) pts += 0.75;
  if (input.operator?.trim()) pts += 0.25;
  if (input.financial_summary?.has_financials && input.financial_summary.confidence === "High") pts += 0.5;
  if (input.location_context?.confidence === "High") pts += 0.5;
  else if (input.location_context?.confidence === "Medium") pts += 0.25;
  return pts;
}

export function deriveValuationConfidence(
  input: DealValuationInput,
  dealType: DealValuationDealType
): "low" | "medium" | "high" {
  const c = scoreInputCompleteness(input);

  let tier: "low" | "medium" | "high" = "low";
  if (c >= 5) tier = "high";
  else if (c >= 2.5) tier = "medium";

  if (dealType === "unknown" || dealType === "infrastructure") {
    tier = tier === "high" ? "medium" : tier;
  }

  logValuationDev("confidence_path", { completeness: c, tier, deal_type: dealType });
  return tier;
}

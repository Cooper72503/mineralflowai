import type { ProductionSnapshotInput } from "./types";
import type { ProductionSnapshotOutput } from "./types";

export function estimateProductionConfidence(args: {
  input: ProductionSnapshotInput;
  productionStatus: ProductionSnapshotOutput["production_status"];
  hasStrongText: boolean;
}): ProductionSnapshotOutput["production_confidence"] {
  let score = 0;
  const hasRev =
    (args.input.annual_revenue != null && args.input.annual_revenue > 0) ||
    (args.input.monthly_revenue != null && args.input.monthly_revenue > 0);
  const hasBopd = args.input.bopd != null && args.input.bopd > 0;

  if (hasRev || hasBopd) score += 45;
  if (args.input.operator?.trim()) score += 10;
  if (args.input.county?.trim() && args.input.state?.trim()) score += 12;
  if (args.input.location_context != null) score += 8;
  if (args.hasStrongText) score += 15;
  if (args.productionStatus === "likely_producing" && !hasRev && !hasBopd) score -= 8;
  if (args.productionStatus === "unknown" || args.productionStatus === "undeveloped") score -= 5;
  if (args.productionStatus === "declining_or_legacy") score -= 12;

  let tier: "low" | "medium" | "high" = "low";
  if (score >= 42) tier = "high";
  else if (score >= 22) tier = "medium";
  if (args.productionStatus === "declining_or_legacy" && tier === "high") tier = "medium";
  return tier;
}

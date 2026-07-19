import type { ProductionSnapshotInput } from "./types";
import type { ProductionSnapshotOutput } from "./types";

export function estimateProductionTrend(args: {
  input: ProductionSnapshotInput;
  textSample: string;
  productionStatus: ProductionSnapshotOutput["production_status"];
  producingAge: ProductionSnapshotOutput["producing_age_estimate"];
}): ProductionSnapshotOutput["production_trend"] {
  const t = args.textSample.slice(0, 80_000).toLowerCase();
  const decliningText =
    /\b(declin(e|ing)|deplet|stripper|tail\s*[- ]?end|mature\s+field|legacy)\b/i.test(t);

  if (args.producingAge === "legacy" || args.productionStatus === "declining_or_legacy" || decliningText) {
    return "declining";
  }

  const growingCue =
    /\b(refrac|refracs|recompletion|new\s+completion|increasing\s+production|uptick)\b/i.test(t) ||
    (/\bworkover\b/i.test(t) && !/\bno\s+recent\s+workover\b/i.test(t));

  if (growingCue && args.productionStatus !== "undeveloped") {
    return "growing";
  }

  const hasEcon =
    (args.input.annual_revenue != null && args.input.annual_revenue > 0) ||
    (args.input.monthly_revenue != null && args.input.monthly_revenue > 0) ||
    (args.input.bopd != null && args.input.bopd > 0);

  if (hasEcon && (args.productionStatus === "producing" || args.productionStatus === "likely_producing")) {
    return "stable";
  }

  return "unknown";
}

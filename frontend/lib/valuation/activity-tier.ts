import type { DealValuationActivityLevel } from "./types";
import type { LocationContext } from "@/lib/location/location-context";
import { hasRegionalDrillFromDealInput } from "@/lib/development/detect-development-signals";
import type { DealValuationDealType } from "./types";
import { logValuationDev } from "./normalize";

function mapNearbyActivity(
  nearby: LocationContext["nearby_activity_signal"] | undefined
): DealValuationActivityLevel {
  switch (nearby) {
    case "High":
      return "high";
    case "Moderate":
      return "moderate";
    case "Low":
      return "low";
    case "Unknown":
    default:
      return "unknown";
  }
}

function bump(
  a: DealValuationActivityLevel,
  b: DealValuationActivityLevel
): DealValuationActivityLevel {
  const rank: Record<DealValuationActivityLevel, number> = {
    unknown: 0,
    low: 1,
    moderate: 2,
    high: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Reuses location context activity labels and regional drill signals from the existing deal input.
 */
export function resolveActivityLevel(args: {
  locationContext: LocationContext | null;
  dealScoreInput: Record<string, unknown>;
  dealType: DealValuationDealType;
}): DealValuationActivityLevel {
  let base = mapNearbyActivity(args.locationContext?.nearby_activity_signal);

  if (hasRegionalDrillFromDealInput(args.dealScoreInput)) {
    base = bump(base, "moderate");
    logValuationDev("activity_path", { bump: "regional_drill_mapping", base });
  }

  if (args.dealType === "producing" || args.dealType === "mixed") {
    const before = base;
    base = bump(base, "moderate");
    if (before !== base) logValuationDev("activity_path", { bump: "producing_floor_moderate", base });
  }

  logValuationDev("activity_path", { final: base, deal_type: args.dealType });
  return base;
}

import type { DealValuationActivityLevel } from "./types";
import type { LocationContext } from "@/lib/location/location-context";
import { hasRegionalDrillFromDealInput } from "@/lib/development/detect-development-signals";
import type { DealValuationDealType } from "./types";
import { logValuationDev } from "./normalize";
import { lookupCountyBasinActivity } from "./county-basin-activity";

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
 * Falls back to a county+state basin lookup when document signals are absent.
 */
export function resolveActivityLevel(args: {
  locationContext: LocationContext | null;
  dealScoreInput: Record<string, unknown>;
  dealType: DealValuationDealType;
  county?: string | null;
  state?: string | null;
}): DealValuationActivityLevel {
  let base = mapNearbyActivity(args.locationContext?.nearby_activity_signal);

  if (hasRegionalDrillFromDealInput(args.dealScoreInput)) {
    base = bump(base, "moderate");
    logValuationDev("activity_path", { bump: "regional_drill_mapping", base });
  }

  // When document signals leave us with "unknown", fall back to the known-basin lookup.
  // This is the critical path for bare mineral summaries (county + acreage only).
  if (base === "unknown") {
    const county = args.county ?? (typeof args.dealScoreInput?.county === "string" ? args.dealScoreInput.county : null);
    const state = args.state ?? (typeof args.dealScoreInput?.state === "string" ? args.dealScoreInput.state : null);
    const basinTier = lookupCountyBasinActivity(county, state);
    if (basinTier) {
      base = basinTier;
      logValuationDev("activity_path", { bump: "county_basin_lookup", county, state, basinTier });
    }
  }

  if (args.dealType === "producing" || args.dealType === "mixed") {
    const before = base;
    base = bump(base, "moderate");
    if (before !== base) logValuationDev("activity_path", { bump: "producing_floor_moderate", base });
  }

  logValuationDev("activity_path", { final: base, deal_type: args.dealType });
  return base;
}

/**
 * Directional production snapshot — first-pass screening only.
 *
 * Priority of inputs (highest wins):
 *  1. Document-extracted BOPD/revenue (from uploaded document)
 *  2. Nearby well data (real production from wells within radius)
 *  3. County/basin benchmark table (static tier × NMA)
 *
 * NOT a reserve report, engineering estimate, or well-level production database.
 *
 * When nearby well data is available, BOPD is scaled as:
 *   median_nearby_bopd × (acreage / 640) — proportional share of a section.
 *
 * Source basis:
 *  - Producing comps: EIA DrillingInfo basin averages, royalty transaction comp data
 *  - Undeveloped comps: SPE type curve literature, public operator investor decks
 */

import type { DealValuationDealType, DealValuationActivityLevel } from "@/lib/valuation/types";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import { lookupCountyBasinActivity } from "@/lib/valuation/county-basin-activity";

export type ProductionStatus =
  | "producing"          // Confirmed producing (user-confirmed or document revenue signals)
  | "near_active_area"   // Active basin but no confirmed production in document
  | "undeveloped"        // Structured legal/location, low-activity area, no production
  | "unknown";

export type ProductionTrend =
  | "active"    // High-activity area, modern development ongoing
  | "declining" // Has or had production but activity is slowing
  | "legacy"    // Low current drilling activity, older production if any
  | "unknown";

export type ProductionSnapshot = {
  status: ProductionStatus;
  trend: ProductionTrend;
  bopd_low: number | null;
  bopd_high: number | null;
  monthly_royalty_low: number | null;
  monthly_royalty_high: number | null;
  oil_price_assumption: number;
  confidence: "low" | "medium" | "high";
  reasoning: string[];
  caveats: string[];
};

export type ProductionSnapshotArgs = {
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel | null;
  bopd?: number | null;
  monthly_revenue?: number | null;
  annual_revenue?: number | null;
  acreage?: number | null;
  royalty_rate?: number | null;
  county?: string | null;
  state?: string | null;
  /** Nearby well intelligence from radius lookup — used to anchor estimates. */
  nearbyWells?: NearbyWellIntelligence | null;
};

const OIL_PRICE = 63;

const BOPD_PRODUCING: Record<string, { lo: number; hi: number; midBasis: string }> = {
  high:     { lo: 0.30, hi: 0.65, midBasis: "Permian/Eagle Ford/Bakken basin avg. type curve per NMA" },
  moderate: { lo: 0.10, hi: 0.30, midBasis: "active secondary play basin avg. per NMA" },
  low:      { lo: 0.02, hi: 0.08, midBasis: "mature/conventional basin avg. per NMA" },
  unknown:  { lo: 0.05, hi: 0.20, midBasis: "basin unknown — blended midpoint" },
};

const BOPD_UNDEVELOPED: Record<string, { lo: number; hi: number; midBasis: string }> = {
  high:     { lo: 0.10, hi: 0.35, midBasis: "high-activity basin development potential per NMA" },
  moderate: { lo: 0.03, hi: 0.12, midBasis: "moderate-activity basin development potential per NMA" },
  low:      { lo: 0.005, hi: 0.03, midBasis: "low-activity basin development potential per NMA" },
  unknown:  { lo: 0.02, hi: 0.08, midBasis: "basin unknown — blended undeveloped potential" },
};

/** Standard section size (acres) used to scale per-well BOPD to per-NMA. */
const TYPICAL_SECTION_ACRES = 640;

function resolveActivityLevel(
  activityLevel: DealValuationActivityLevel | null,
  county: string | null | undefined,
  state: string | null | undefined,
  nearbyWells: NearbyWellIntelligence | null | undefined,
): DealValuationActivityLevel {
  // If nearby well intelligence has a definitive activity level, prefer it over
  // the static county tier (it's anchored to real data).
  if (nearbyWells && nearbyWells.inferred_activity_level !== "none") {
    const nwMap: Record<string, DealValuationActivityLevel> = {
      high: "high", moderate: "moderate", low: "low",
    };
    const nwLevel = nwMap[nearbyWells.inferred_activity_level];
    if (nwLevel) return nwLevel;
  }

  if (activityLevel && activityLevel !== "unknown") return activityLevel;
  const tier = lookupCountyBasinActivity(county ?? null, state ?? null);
  return tier ?? "unknown";
}

function classifyStatus(args: {
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel;
  hasDocumentProduction: boolean;
  nearbyProducingCount: number;
}): ProductionStatus {
  const { dealType, activityLevel, hasDocumentProduction, nearbyProducingCount } = args;

  if (hasDocumentProduction || dealType === "producing" || dealType === "mixed") {
    return "producing";
  }

  const effectivelyActive = activityLevel === "high" || nearbyProducingCount >= 2;
  if (effectivelyActive && (dealType === "undeveloped" || dealType === "lease" || dealType === "unknown")) {
    return "near_active_area";
  }

  if (dealType === "undeveloped" || dealType === "lease" || activityLevel === "moderate" || activityLevel === "low") {
    return "undeveloped";
  }

  return "unknown";
}

function classifyTrend(args: {
  activityLevel: DealValuationActivityLevel;
  status: ProductionStatus;
  newestProdYear: number | null;
}): ProductionTrend {
  const { activityLevel, status, newestProdYear } = args;
  const currentYear = new Date().getFullYear();

  // If we have real nearby well data, use the newest production year to calibrate trend
  if (newestProdYear != null) {
    if (newestProdYear >= currentYear - 3) return "active";
    if (newestProdYear >= currentYear - 8) return "declining";
    return "legacy";
  }

  if (activityLevel === "high") return "active";
  if (activityLevel === "moderate") return status === "producing" ? "declining" : "active";
  if (activityLevel === "low") return "legacy";
  return "unknown";
}

type BopdEstimate = { lo: number | null; hi: number | null; source: string; basis?: string };

function estimateBopdFromNearbyWells(args: {
  medianBopd: number | null;
  avgBopd: number | null;
  acreage: number | null;
  producingCount: number;
}): BopdEstimate | null {
  const { medianBopd, avgBopd, acreage, producingCount } = args;
  const baseBopd = medianBopd ?? avgBopd;
  if (baseBopd == null || baseBopd <= 0 || producingCount === 0) return null;

  // If no acreage: return the per-well range with ±35% band
  if (!acreage || acreage <= 0) {
    return {
      lo: Math.round(baseBopd * 0.65 * 10) / 10,
      hi: Math.round(baseBopd * 1.35 * 10) / 10,
      source: "nearby_wells",
      basis: `Median BOPD of ${producingCount} nearby producing well${producingCount !== 1 ? "s" : ""} ± 35%`,
    };
  }

  // Scale by acreage / section size to get proportional share
  const scale = Math.min(acreage / TYPICAL_SECTION_ACRES, 1.0);
  const scaled = baseBopd * scale;
  return {
    lo: Math.round(scaled * 0.65 * 100) / 100,
    hi: Math.round(scaled * 1.35 * 100) / 100,
    source: "nearby_wells",
    basis: `Nearby well median ${baseBopd} BOPD × ${acreage}/${TYPICAL_SECTION_ACRES} acre share ± 35%`,
  };
}

function estimateBopdFromBenchmarks(args: {
  activityLevel: DealValuationActivityLevel;
  acreage: number | null;
  status: ProductionStatus;
  existingBopd: number | null;
}): BopdEstimate {
  if (args.existingBopd != null && args.existingBopd > 0) {
    return {
      lo: Math.round(args.existingBopd * 0.85 * 10) / 10,
      hi: Math.round(args.existingBopd * 1.20 * 10) / 10,
      source: "document",
      basis: "Document-extracted BOPD ± 20% band",
    };
  }

  const acres = args.acreage;
  if (!acres || acres <= 0) return { lo: null, hi: null, source: "none" };

  const isProducing = args.status === "producing";
  const table = isProducing ? BOPD_PRODUCING : BOPD_UNDEVELOPED;
  const tier = table[args.activityLevel] ?? table.unknown;

  return {
    lo: Math.round(acres * tier.lo * 100) / 100,
    hi: Math.round(acres * tier.hi * 100) / 100,
    source: "benchmark",
    basis: tier.midBasis,
  };
}

function estimateMonthlyRoyalty(args: {
  bopd_lo: number | null;
  bopd_hi: number | null;
  royalty_rate: number | null;
  monthly_revenue: number | null;
  annual_revenue: number | null;
}): { lo: number | null; hi: number | null } {
  if (args.monthly_revenue != null && args.monthly_revenue > 0) {
    return {
      lo: Math.round(args.monthly_revenue * 0.90),
      hi: Math.round(args.monthly_revenue * 1.10),
    };
  }
  if (args.annual_revenue != null && args.annual_revenue > 0) {
    const m = args.annual_revenue / 12;
    return { lo: Math.round(m * 0.90), hi: Math.round(m * 1.10) };
  }
  if (args.bopd_lo == null || args.bopd_hi == null) return { lo: null, hi: null };

  const roy = args.royalty_rate ?? 0.1875;
  const daysPerMonth = 30;
  return {
    lo: Math.round(args.bopd_lo * daysPerMonth * OIL_PRICE * roy),
    hi: Math.round(args.bopd_hi * daysPerMonth * OIL_PRICE * roy),
  };
}

function confidenceTier(args: {
  hasDocumentProduction: boolean;
  bopdSource: string;
  activityLevel: DealValuationActivityLevel;
  hasAcreage: boolean;
  hasRoyalty: boolean;
  nearbyWellCount: number;
  nearbyBopdCount: number;
}): "low" | "medium" | "high" {
  const { hasDocumentProduction, bopdSource, activityLevel, hasAcreage, hasRoyalty, nearbyWellCount, nearbyBopdCount } = args;

  if (hasDocumentProduction && bopdSource === "document" && hasRoyalty) return "high";
  if (hasDocumentProduction && activityLevel !== "unknown" && hasAcreage) return "medium";

  // Nearby-well anchored: real data, good confidence
  if (bopdSource === "nearby_wells" && nearbyBopdCount >= 3 && hasAcreage && hasRoyalty) return "high";
  if (bopdSource === "nearby_wells" && nearbyWellCount >= 1) return "medium";

  if (
    bopdSource === "benchmark" &&
    (activityLevel === "high" || activityLevel === "moderate") &&
    hasAcreage && hasRoyalty
  ) return "medium";

  return "low";
}

export function buildProductionSnapshot(args: ProductionSnapshotArgs): ProductionSnapshot {
  try {
    const nw = args.nearbyWells ?? null;
    const activity = resolveActivityLevel(args.activityLevel, args.county, args.state, nw);
    const hasDocumentProduction =
      (args.bopd != null && args.bopd > 0) ||
      (args.monthly_revenue != null && args.monthly_revenue > 0) ||
      (args.annual_revenue != null && args.annual_revenue > 0);

    const nearbyProducingCount = nw?.producing_count ?? 0;

    const status = classifyStatus({
      dealType: args.dealType,
      activityLevel: activity,
      hasDocumentProduction,
      nearbyProducingCount,
    });

    const trend = classifyTrend({
      activityLevel: activity,
      status,
      newestProdYear: nw?.newest_prod_year ?? null,
    });

    // BOPD estimation priority: document → nearby wells → basin benchmark
    let bopdResult: BopdEstimate;
    if (args.bopd != null && args.bopd > 0) {
      bopdResult = estimateBopdFromBenchmarks({
        activityLevel: activity,
        acreage: args.acreage ?? null,
        status,
        existingBopd: args.bopd,
      });
    } else if (nw && nw.total_count > 0 && !hasDocumentProduction) {
      const fromNearby = estimateBopdFromNearbyWells({
        medianBopd: nw.median_bopd,
        avgBopd: nw.avg_bopd,
        acreage: args.acreage ?? null,
        producingCount: nw.producing_count,
      });
      bopdResult = fromNearby ?? estimateBopdFromBenchmarks({
        activityLevel: activity,
        acreage: args.acreage ?? null,
        status,
        existingBopd: null,
      });
    } else {
      bopdResult = estimateBopdFromBenchmarks({
        activityLevel: activity,
        acreage: args.acreage ?? null,
        status,
        existingBopd: null,
      });
    }

    const royalty = estimateMonthlyRoyalty({
      bopd_lo: bopdResult.lo,
      bopd_hi: bopdResult.hi,
      royalty_rate: args.royalty_rate ?? null,
      monthly_revenue: args.monthly_revenue ?? null,
      annual_revenue: args.annual_revenue ?? null,
    });

    const nearbyBopdCount = nw
      ? nw.wells.filter(w => w.latest_bopd != null && w.latest_bopd > 0).length
      : 0;

    const confidence = confidenceTier({
      hasDocumentProduction,
      bopdSource: bopdResult.source,
      activityLevel: activity,
      hasAcreage: (args.acreage ?? 0) > 0,
      hasRoyalty: (args.royalty_rate ?? 0) > 0,
      nearbyWellCount: nw?.total_count ?? 0,
      nearbyBopdCount,
    });

    const reasoning: string[] = [];
    const caveats: string[] = [
      "Production estimates are directional screening — not a reserve report or engineering estimate.",
      `Oil price assumption: $${OIL_PRICE}/bbl (conservative WTI benchmark). Actual prices vary.`,
    ];

    // Source-specific reasoning
    if (bopdResult.source === "nearby_wells" && nw) {
      reasoning.push(
        `BOPD anchored to ${nw.producing_count} nearby producing well${nw.producing_count !== 1 ? "s" : ""}` +
        (nw.geocode_source !== "none" ? ` within ${nw.radius_miles} miles` : " in county") +
        (nw.median_bopd != null ? ` (median ${nw.median_bopd} BOPD).` : ".")
      );
      if (bopdResult.basis) reasoning.push(bopdResult.basis + ".");
      caveats.push(
        "Production inferred from nearby wells — not confirmed on this specific tract. " +
        "Ownership interest (NRI/WI) is unknown; revenue estimate uses royalty rate only."
      );
    } else if (bopdResult.source === "benchmark") {
      if (activity !== "unknown") {
        reasoning.push(`Basin activity tier: ${activity} (county/basin lookup).`);
      }
      if (args.acreage && bopdResult.basis) {
        const table = status === "producing" ? BOPD_PRODUCING : BOPD_UNDEVELOPED;
        const tier = table[activity] ?? table.unknown;
        reasoning.push(
          `BOPD estimated from ${args.acreage} NMA × ${tier.lo}–${tier.hi} BOPD/NMA (${bopdResult.basis}).`
        );
      }
    } else if (bopdResult.source === "document") {
      reasoning.push("Document contains production signals — used as primary BOPD input.");
    }

    if (nw && nw.total_count > 0 && bopdResult.source !== "nearby_wells") {
      reasoning.push(
        `${nw.total_count} nearby well${nw.total_count !== 1 ? "s" : ""} found` +
        (nw.geocode_source !== "none" ? ` within ${nw.radius_miles} miles` : " in county") +
        " — basin benchmark used since no BOPD data available for those wells."
      );
    }

    if (nw && nw.data_source && activity !== "unknown") {
      reasoning.push(`Activity level ${activity} confirmed by ${nw.data_source.toUpperCase()} well database.`);
    }

    if (!args.royalty_rate && royalty.lo != null) {
      caveats.push("No royalty rate provided — defaulted to 3/16 (18.75%) for revenue estimate.");
    }
    if (!args.acreage && bopdResult.source === "none") {
      caveats.push("Provide NMA (net mineral acres) to generate BOPD and revenue estimates.");
    }

    if (status === "near_active_area") {
      reasoning.push("Property is in an active development area. No confirmed production on this tract — estimate reflects development potential.");
      caveats.push("'Near active area' means the basin is active — production on this specific acreage is not confirmed.");
    }
    if (status === "undeveloped") {
      reasoning.push("Estimate reflects development potential IF drilled — not current production.");
      caveats.push("Undeveloped acreage may never be drilled. This estimate is speculative.");
    }
    if (status === "producing") {
      reasoning.push("BOPD range uses confirmed-producing basin benchmarks (steady-state, not IP rates).");
    }

    return {
      status,
      trend,
      bopd_low: bopdResult.lo,
      bopd_high: bopdResult.hi,
      monthly_royalty_low: royalty.lo,
      monthly_royalty_high: royalty.hi,
      oil_price_assumption: OIL_PRICE,
      confidence,
      reasoning,
      caveats,
    };
  } catch {
    return {
      status: "unknown",
      trend: "unknown",
      bopd_low: null,
      bopd_high: null,
      monthly_royalty_low: null,
      monthly_royalty_high: null,
      oil_price_assumption: OIL_PRICE,
      confidence: "low",
      reasoning: [],
      caveats: ["Production snapshot could not be computed from available inputs."],
    };
  }
}

/**
 * Directional production snapshot — first-pass screening only.
 *
 * Combines document signals (extracted revenue, BOPD, royalty, deal type)
 * with county/basin benchmarks to estimate production status, trend, and
 * a conservative BOPD + monthly royalty band.
 *
 * NOT a reserve report, engineering estimate, or well-level production database.
 */

import type { DealValuationDealType, DealValuationActivityLevel } from "@/lib/valuation/types";
import { lookupCountyBasinActivity } from "@/lib/valuation/county-basin-activity";

export type ProductionStatus =
  | "producing"        // Document has clear revenue/production signals
  | "likely_producing" // Active basin area, possible production, no confirmed revenue in doc
  | "undeveloped"      // Structured legal/location but no production signals
  | "unknown";

export type ProductionTrend =
  | "active"    // High-activity area, modern development ongoing
  | "declining" // Has or had production but activity is slowing
  | "legacy"    // Low current drilling activity, older production if any
  | "unknown";

export type ProductionSnapshot = {
  status: ProductionStatus;
  trend: ProductionTrend;
  /** Directional BOPD estimate low end — assumes acreage is drilled/producing. */
  bopd_low: number | null;
  /** Directional BOPD estimate high end. */
  bopd_high: number | null;
  /** Estimated monthly royalty revenue low end (USD). */
  monthly_royalty_low: number | null;
  /** Estimated monthly royalty revenue high end (USD). */
  monthly_royalty_high: number | null;
  /** Oil price assumption used ($/bbl). */
  oil_price_assumption: number;
  confidence: "low" | "medium" | "high";
  reasoning: string[];
  caveats: string[];
};

export type ProductionSnapshotArgs = {
  /** From pre-underwriting valuation or extraction. */
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel | null;
  /** Explicit BOPD signal from document (extraction). */
  bopd?: number | null;
  /** Explicit monthly revenue signal from document (extraction). */
  monthly_revenue?: number | null;
  annual_revenue?: number | null;
  acreage?: number | null;
  royalty_rate?: number | null;
  county?: string | null;
  state?: string | null;
};

/** Conservative oil price assumption — disclosed to user. */
const OIL_PRICE = 70;

/**
 * BOPD per net mineral acre by activity tier.
 * Based on basin-level type curves normalized to NMA — intentionally wide and conservative.
 * High: Bakken/Permian core, active unconventional. Low: legacy / edge-of-play.
 */
const BOPD_PER_NMA: Record<string, { lo: number; hi: number }> = {
  high:     { lo: 0.4,  hi: 2.5 },
  moderate: { lo: 0.08, hi: 0.7 },
  low:      { lo: 0.01, hi: 0.15 },
};

function resolveActivityLevel(
  activityLevel: DealValuationActivityLevel | null,
  county: string | null | undefined,
  state: string | null | undefined
): DealValuationActivityLevel {
  if (activityLevel && activityLevel !== "unknown") return activityLevel;
  // Fall back to county/basin lookup
  const tier = lookupCountyBasinActivity(county ?? null, state ?? null);
  return tier ?? "unknown";
}

function classifyStatus(args: {
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel;
  hasDocumentProduction: boolean;
}): ProductionStatus {
  const { dealType, activityLevel, hasDocumentProduction } = args;
  if (hasDocumentProduction || dealType === "producing") return "producing";
  if (dealType === "mixed") return "producing";
  if (activityLevel === "high" && (dealType === "undeveloped" || dealType === "lease" || dealType === "unknown")) {
    return "likely_producing";
  }
  if (activityLevel === "moderate" && (dealType === "undeveloped" || dealType === "lease")) {
    return "likely_producing";
  }
  if (dealType === "undeveloped" || dealType === "lease") return "undeveloped";
  return "unknown";
}

function classifyTrend(args: {
  activityLevel: DealValuationActivityLevel;
  status: ProductionStatus;
}): ProductionTrend {
  const { activityLevel, status } = args;
  if (activityLevel === "high") return "active";
  if (activityLevel === "moderate") {
    return status === "producing" ? "declining" : "active";
  }
  if (activityLevel === "low") {
    return status === "producing" ? "legacy" : "legacy";
  }
  return "unknown";
}

function estimateBopd(args: {
  activityLevel: DealValuationActivityLevel;
  acreage: number | null;
  status: ProductionStatus;
  existingBopd: number | null;
}): { lo: number | null; hi: number | null; source: string } {
  // If the document gave us an explicit BOPD signal, use it with a confidence band around it
  if (args.existingBopd != null && args.existingBopd > 0) {
    return {
      lo: Math.max(0, args.existingBopd * 0.7),
      hi: args.existingBopd * 1.4,
      source: "document",
    };
  }

  // Need acreage + activity tier for benchmark
  const acres = args.acreage;
  if (!acres || acres <= 0) return { lo: null, hi: null, source: "none" };

  const tier = BOPD_PER_NMA[args.activityLevel];
  if (!tier) return { lo: null, hi: null, source: "none" };

  return {
    lo: Math.round(acres * tier.lo * 10) / 10,
    hi: Math.round(acres * tier.hi * 10) / 10,
    source: "benchmark",
  };
}

function estimateMonthlyRoyalty(args: {
  bopd_lo: number | null;
  bopd_hi: number | null;
  royalty_rate: number | null;
  monthly_revenue: number | null;
  annual_revenue: number | null;
}): { lo: number | null; hi: number | null } {
  // Prefer explicit revenue signals from the document
  if (args.monthly_revenue != null && args.monthly_revenue > 0) {
    return { lo: args.monthly_revenue * 0.85, hi: args.monthly_revenue * 1.15 };
  }
  if (args.annual_revenue != null && args.annual_revenue > 0) {
    const m = args.annual_revenue / 12;
    return { lo: m * 0.85, hi: m * 1.15 };
  }

  // Estimate from BOPD × oil price × royalty
  if (args.bopd_lo == null || args.bopd_hi == null) return { lo: null, hi: null };
  const roy = args.royalty_rate ?? 0.1875; // default 3/16 if not provided
  const daysPerMonth = 30;
  return {
    lo: Math.round(args.bopd_lo * daysPerMonth * OIL_PRICE * roy),
    hi: Math.round(args.bopd_hi * daysPerMonth * OIL_PRICE * roy),
  };
}

function confidenceTier(args: {
  hasDocumentProduction: boolean;
  activityLevel: DealValuationActivityLevel;
  hasAcreage: boolean;
  hasRoyalty: boolean;
  bopdSource: string;
  status: ProductionStatus;
}): "low" | "medium" | "high" {
  const { hasDocumentProduction, activityLevel, hasAcreage, hasRoyalty, bopdSource } = args;

  // High: explicit production in doc + explicit BOPD signal + royalty known — all three required.
  if (hasDocumentProduction && bopdSource === "document" && hasRoyalty) return "high";

  // Medium: document has production signals AND we have acreage to anchor the estimate.
  // Royalty not strictly required when production is document-confirmed, but activity must be known.
  if (hasDocumentProduction && activityLevel !== "unknown" && hasAcreage) return "medium";

  // Medium: pure benchmark path — requires acreage + royalty + active/moderate basin.
  // "low" activity tier or missing royalty means the math is too speculative for medium.
  if (
    bopdSource === "benchmark" &&
    (activityLevel === "high" || activityLevel === "moderate") &&
    hasAcreage &&
    hasRoyalty
  ) return "medium";

  // Everything else is low: benchmark without royalty, unknown activity, undeveloped speculation.
  return "low";
}

/**
 * Build a directional production snapshot from available document signals + county/basin benchmarks.
 * Never throws — returns conservative unknown output on failure.
 */
export function buildProductionSnapshot(args: ProductionSnapshotArgs): ProductionSnapshot {
  try {
    const activity = resolveActivityLevel(args.activityLevel, args.county, args.state);
    const hasDocumentProduction =
      (args.bopd != null && args.bopd > 0) ||
      (args.monthly_revenue != null && args.monthly_revenue > 0) ||
      (args.annual_revenue != null && args.annual_revenue > 0);

    const status = classifyStatus({
      dealType: args.dealType,
      activityLevel: activity,
      hasDocumentProduction,
    });

    const trend = classifyTrend({ activityLevel: activity, status });

    const bopdResult = estimateBopd({
      activityLevel: activity,
      acreage: args.acreage ?? null,
      status,
      existingBopd: args.bopd ?? null,
    });

    const royalty = estimateMonthlyRoyalty({
      bopd_lo: bopdResult.lo,
      bopd_hi: bopdResult.hi,
      royalty_rate: args.royalty_rate ?? null,
      monthly_revenue: args.monthly_revenue ?? null,
      annual_revenue: args.annual_revenue ?? null,
    });

    const confidence = confidenceTier({
      hasDocumentProduction,
      activityLevel: activity,
      hasAcreage: (args.acreage ?? 0) > 0,
      hasRoyalty: (args.royalty_rate ?? 0) > 0,
      bopdSource: bopdResult.source,
      status,
    });

    const reasoning: string[] = [];
    const caveats: string[] = [
      "Production estimates are directional screening only — not reserve engineering.",
      `Oil price assumption: $${OIL_PRICE}/bbl (conservative). Actual prices vary.`,
    ];

    if (activity !== "unknown") {
      reasoning.push(`Basin activity tier: ${activity} (county/basin benchmark).`);
    }
    if (hasDocumentProduction) {
      reasoning.push("Document contains revenue or production signals — used as primary input.");
    }
    if (bopdResult.source === "benchmark" && args.acreage) {
      reasoning.push(
        `BOPD estimated from ${args.acreage} NMA × ${activity}-tier basin benchmark (${BOPD_PER_NMA[activity]?.lo}–${BOPD_PER_NMA[activity]?.hi} BOPD/NMA).`
      );
    }
    if (!args.royalty_rate && royalty.lo != null) {
      caveats.push("No royalty rate in document — defaulted to 3/16 (18.75%) for revenue estimate.");
    }
    if (!args.acreage && bopdResult.source === "none") {
      caveats.push("Add acreage (NMA) to generate a BOPD and royalty estimate.");
    }
    if (status === "likely_producing") {
      reasoning.push("Asset is in an active development area — likely producing or drillable in near term.");
      caveats.push("'Likely producing' is basin-context inference only — no confirmed production in document.");
    }
    if (status === "undeveloped") {
      reasoning.push("No production signals in document. Estimate reflects potential if drilled.");
      caveats.push("Undeveloped acreage may never be drilled — production estimate is speculative.");
    }
    if (args.dealType === "infrastructure") {
      caveats.push("Infrastructure assets are not acreage — BOPD and revenue estimates do not apply.");
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

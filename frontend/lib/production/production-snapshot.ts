/**
 * Directional production snapshot — first-pass screening only.
 *
 * Combines document signals (extracted revenue, BOPD, royalty, deal type)
 * with county/basin benchmarks to estimate production status, trend, and
 * a conservative BOPD + monthly royalty band.
 *
 * NOT a reserve report, engineering estimate, or well-level production database.
 *
 * BOPD/NMA benchmarks are basin-level type curves normalized to net mineral acres,
 * split into confirmed-producing (steady-state) vs undeveloped (development potential).
 * Ranges are anchored at ±30–40% around a basin midpoint — not maximum IP rates.
 *
 * Source basis:
 *  - Producing comps: EIA DrillingInfo basin averages, royalty transaction comp data
 *  - Undeveloped comps: SPE type curve literature, public operator investor decks
 */

import type { DealValuationDealType, DealValuationActivityLevel } from "@/lib/valuation/types";
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
  /** Directional BOPD estimate low end. */
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
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel | null;
  bopd?: number | null;
  monthly_revenue?: number | null;
  annual_revenue?: number | null;
  acreage?: number | null;
  royalty_rate?: number | null;
  county?: string | null;
  state?: string | null;
};

/**
 * Current WTI benchmark for royalty math.
 * Updated to reflect recent market: ~$63/bbl (conservative for screening).
 */
const OIL_PRICE = 63;

/**
 * BOPD per net mineral acre — PRODUCING (confirmed, steady-state).
 *
 * These reflect ongoing production across a typical well spacing unit,
 * not initial production (IP) rates. A horizontal well on a 640-acre section
 * producing 400 BOPD gross = 0.625 BOPD/NMA gross. At 20% royalty:
 * ~0.125 BOPD/NMA to the royalty owner — but we estimate total gross
 * and apply royalty separately. These are gross production per NMA.
 *
 * High (Permian, Eagle Ford, Bakken, SCOOP/STACK core):  0.30–0.65 BOPD/NMA
 * Moderate (active secondary/tertiary plays):             0.10–0.30 BOPD/NMA
 * Low (mature conventional, edge-of-play):               0.02–0.08 BOPD/NMA
 */
const BOPD_PRODUCING: Record<string, { lo: number; hi: number; midBasis: string }> = {
  high:     { lo: 0.30, hi: 0.65, midBasis: "Permian/Eagle Ford/Bakken basin avg. type curve per NMA" },
  moderate: { lo: 0.10, hi: 0.30, midBasis: "active secondary play basin avg. per NMA" },
  low:      { lo: 0.02, hi: 0.08, midBasis: "mature/conventional basin avg. per NMA" },
  unknown:  { lo: 0.05, hi: 0.20, midBasis: "basin unknown — blended midpoint" },
};

/**
 * BOPD per net mineral acre — UNDEVELOPED (development potential if drilled).
 *
 * These reflect what the acreage would produce IF drilled, discounted for:
 *  - Not all NMAs fall within a spacing unit being actively drilled
 *  - Timing risk (may be 2–5+ years to development)
 *  - No guarantee of development
 *
 * These are intentionally lower than producing comps and should be labeled
 * as "development potential" rather than current production.
 *
 * High:     0.10–0.35 BOPD/NMA  (likely to be drilled, but timing uncertain)
 * Moderate: 0.03–0.12 BOPD/NMA
 * Low:      0.005–0.03 BOPD/NMA
 */
const BOPD_UNDEVELOPED: Record<string, { lo: number; hi: number; midBasis: string }> = {
  high:     { lo: 0.10, hi: 0.35, midBasis: "high-activity basin development potential per NMA" },
  moderate: { lo: 0.03, hi: 0.12, midBasis: "moderate-activity basin development potential per NMA" },
  low:      { lo: 0.005, hi: 0.03, midBasis: "low-activity basin development potential per NMA" },
  unknown:  { lo: 0.02, hi: 0.08, midBasis: "basin unknown — blended undeveloped potential" },
};

function resolveActivityLevel(
  activityLevel: DealValuationActivityLevel | null,
  county: string | null | undefined,
  state: string | null | undefined
): DealValuationActivityLevel {
  if (activityLevel && activityLevel !== "unknown") return activityLevel;
  const tier = lookupCountyBasinActivity(county ?? null, state ?? null);
  return tier ?? "unknown";
}

function classifyStatus(args: {
  dealType: DealValuationDealType | null;
  activityLevel: DealValuationActivityLevel;
  hasDocumentProduction: boolean;
}): ProductionStatus {
  const { dealType, activityLevel, hasDocumentProduction } = args;

  // Confirmed producing: document has revenue/BOPD or deal type is explicitly producing
  if (hasDocumentProduction || dealType === "producing" || dealType === "mixed") {
    return "producing";
  }

  // Near active development: in a high-activity basin but no confirmed production signals.
  // This is contextual — the area is active, not necessarily this specific acreage.
  if (activityLevel === "high" && (dealType === "undeveloped" || dealType === "lease" || dealType === "unknown")) {
    return "near_active_area";
  }

  // Undeveloped: moderate/low basin or explicitly undeveloped
  if (dealType === "undeveloped" || dealType === "lease" || activityLevel === "moderate" || activityLevel === "low") {
    return "undeveloped";
  }

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
  if (activityLevel === "low") return "legacy";
  return "unknown";
}

function estimateBopd(args: {
  activityLevel: DealValuationActivityLevel;
  acreage: number | null;
  status: ProductionStatus;
  existingBopd: number | null;
}): { lo: number | null; hi: number | null; source: string; basis?: string } {
  // Document-provided BOPD signal — use a tight ±20% confidence band around it
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
  // Prefer explicit revenue signals from the document — use ±10% band
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

  const roy = args.royalty_rate ?? 0.1875; // default 3/16
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

  // High: explicit production in doc + explicit BOPD signal + royalty known
  if (hasDocumentProduction && bopdSource === "document" && hasRoyalty) return "high";

  // Medium: document has production + acreage + known activity
  if (hasDocumentProduction && activityLevel !== "unknown" && hasAcreage) return "medium";

  // Medium: benchmark path — needs acreage + royalty + active/moderate basin
  if (
    bopdSource === "benchmark" &&
    (activityLevel === "high" || activityLevel === "moderate") &&
    hasAcreage &&
    hasRoyalty
  ) return "medium";

  return "low";
}

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
      "Production estimates are directional screening — not a reserve report or engineering estimate.",
      `Oil price assumption: $${OIL_PRICE}/bbl (conservative WTI benchmark). Actual prices vary.`,
    ];

    if (activity !== "unknown") {
      reasoning.push(`Basin activity tier: ${activity} (county/basin lookup).`);
    }
    if (hasDocumentProduction) {
      reasoning.push("Document contains revenue or production signals — used as primary input.");
    }
    if (bopdResult.source === "benchmark" && args.acreage && bopdResult.basis) {
      const table = status === "producing" ? BOPD_PRODUCING : BOPD_UNDEVELOPED;
      const tier = table[activity] ?? table.unknown;
      reasoning.push(
        `BOPD estimated from ${args.acreage} NMA × ${tier.lo}–${tier.hi} BOPD/NMA (${bopdResult.basis}).`
      );
    }
    if (!args.royalty_rate && royalty.lo != null) {
      caveats.push("No royalty rate provided — defaulted to 3/16 (18.75%) for revenue estimate.");
    }
    if (!args.acreage && bopdResult.source === "none") {
      caveats.push("Provide NMA (net mineral acres) to generate BOPD and revenue estimates.");
    }
    if (status === "near_active_area") {
      reasoning.push("Property is in a high-activity development area. No confirmed production in this document — estimate reflects development potential, not current income.");
      caveats.push("'Near active area' means the basin is active — not that this specific acreage is currently producing.");
    }
    if (status === "undeveloped") {
      reasoning.push("No production signals in document. Estimate reflects potential IF drilled — not current production.");
      caveats.push("Undeveloped acreage may never be drilled. Development potential estimate is speculative.");
    }
    if (status === "producing") {
      reasoning.push(`BOPD range uses ${status === "producing" ? "confirmed-producing" : "development-potential"} basin benchmarks (steady-state, not IP rates).`);
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

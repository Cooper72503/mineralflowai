import type { DealValuationActivityLevel } from "./types";
import type { DealValuationDealType } from "./types";
import type { DealValuationInput } from "./types";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import { textSuggestsInfrastructure } from "./deal-type";
import { logValuationDev } from "./normalize";

export type ValueEstimateResult = {
  value_per_acre_low: number | null;
  value_per_acre_high: number | null;
  estimated_total_value_low: number | null;
  estimated_total_value_high: number | null;
  /** Single-point midpoint value (always the midpoint of low/high when present). */
  point_estimate: number | null;
  /** Whether this used real BOPD data or fell back to basin comps. */
  point_estimate_basis: "bopd_anchored" | "basin_tier" | null;
  method: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Baseline oil price $/bbl for income capitalization. */
const OIL_PRICE_PER_BBL = 70;

/**
 * Standard well spacing: 1 producing well per 160 NMA (quarter section).
 * Used to estimate how many well-equivalents a property of a given size has.
 * Adjust: Permian uses tighter spacing (~120 ac), Bakken/Eagle Ford ~160-320.
 * 160 is the industry-standard conservative midpoint.
 */
const WELL_SPACING_ACRES = 160;

/** BOPD-anchored income multiple by activity tier. */
const ACTIVITY_MULTIPLES: Record<DealValuationActivityLevel, number> = {
  high:     5.0,   // Permian/Bakken core — ~20% cap rate
  moderate: 4.0,   // Active secondary plays — ~25% cap rate
  low:      3.0,   // Mature/conventional — ~33% cap rate
  unknown:  3.5,   // Conservative midpoint
};

/**
 * Tightened static fallback per-acre comps (no BOPD data).
 * Midpoint of prior wide ranges; band is ±12% applied downstream.
 * High:     $6,000/acre  (was $4,500–$7,500)
 * Moderate: $2,100/acre  (was $1,500–$2,750)
 * Low:      $500/acre    (was $300–$700)
 * Unknown:  $400/acre    (was $200–$600)
 */
const UNDEV_MID: Record<DealValuationActivityLevel, number> = {
  high:     6_000,
  moderate: 2_100,
  low:        500,
  unknown:    400,
};

/**
 * Tightened producing comps (no income/BOPD data).
 * High:     $12,500/acre  (was $10,000–$15,000)
 * Moderate: $6,250/acre   (was $4,500–$8,000)
 * Low:      $2,500/acre   (was $1,500–$3,500)
 * Unknown:  $4,500/acre   (was $3,000–$6,000)
 */
const PROD_MID: Record<DealValuationActivityLevel, number> = {
  high:     12_500,
  moderate:  6_250,
  low:       2_500,
  unknown:   4_500,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nullResult(method: string): ValueEstimateResult {
  return {
    value_per_acre_low: null,
    value_per_acre_high: null,
    estimated_total_value_low: null,
    estimated_total_value_high: null,
    point_estimate: null,
    point_estimate_basis: null,
    method,
  };
}

/** Build a tight ±pct band around a midpoint value. */
function bandFromMid(mid: number, pct = 0.10): { lo: number; hi: number } {
  return {
    lo: Math.round(mid * (1 - pct)),
    hi: Math.round(mid * (1 + pct)),
  };
}

function annualFromFinancial(input: DealValuationInput): { low: number; high: number } | null {
  const fs = input.financial_summary;
  if (!fs) return null;
  if (fs.annual_revenue_estimate_min != null && fs.annual_revenue_estimate_max != null) {
    const lo = Math.min(fs.annual_revenue_estimate_min, fs.annual_revenue_estimate_max);
    const hi = Math.max(fs.annual_revenue_estimate_min, fs.annual_revenue_estimate_max);
    if (lo > 0 && hi > 0) return { low: lo, high: hi };
  }
  if (fs.monthly_revenue_estimate_min != null && fs.monthly_revenue_estimate_max != null) {
    const lo = Math.min(fs.monthly_revenue_estimate_min, fs.monthly_revenue_estimate_max) * 12;
    const hi = Math.max(fs.monthly_revenue_estimate_min, fs.monthly_revenue_estimate_max) * 12;
    if (lo > 0 && hi > 0) return { low: lo, high: hi };
  }
  return null;
}

function infraHeavy(input: DealValuationInput, dealType: DealValuationDealType): boolean {
  const text = `${input.document_type ?? ""}\n${input.legal_description ?? ""}\n${input.extracted_text_sample ?? ""}`;
  const textInfra = textSuggestsInfrastructure(text);
  const devInfra = input.development_signals?.has_infrastructure_language === true;
  if (dealType === "infrastructure") return true;
  if (dealType === "mixed") return textInfra || devInfra;
  return false;
}

// ── BOPD-anchored income capitalization ───────────────────────────────────────

/**
 * Compute a precise point estimate from real nearby BOPD data.
 *
 * Formula:
 *   well_equivalents = acreage / WELL_SPACING_ACRES   (min 0.25)
 *   annual_royalty   = well_eq × median_bopd × royalty_rate × 365 × OIL_PRICE
 *   point_value      = annual_royalty × activity_multiple
 *
 * For undeveloped/lease: multiply by 0.55 to reflect development-risk discount
 * (undeveloped mineral rights trade at ~50-65% of producing equivalent in the
 * same basin — 55% is the industry-conservative midpoint).
 *
 * Returns null when any required input is missing or yields implausible output.
 */
function bopdAnchoredEstimate(args: {
  acreage: number;
  royaltyRate: number;
  medianBopd: number;
  activity: DealValuationActivityLevel;
  dealType: DealValuationDealType;
}): { point: number; method: string } | null {
  const { acreage, royaltyRate, medianBopd, activity, dealType } = args;
  if (acreage <= 0 || royaltyRate <= 0 || medianBopd <= 0) return null;

  const wellEquivalents = Math.max(0.25, acreage / WELL_SPACING_ACRES);
  const annualGrossProduction = wellEquivalents * medianBopd * 365 * OIL_PRICE_PER_BBL;
  const annualRoyaltyIncome = annualGrossProduction * royaltyRate;

  const baseMultiple = ACTIVITY_MULTIPLES[activity] ?? 3.5;

  // Development-risk discount for non-producing interests
  const isUndeveloped = dealType === "undeveloped" || dealType === "lease";
  const multiple = isUndeveloped ? baseMultiple * 0.55 : baseMultiple;

  const point = Math.round(annualRoyaltyIncome * multiple);

  // Sanity floor — anything below $500 for any acreage is likely a data quality issue
  if (point < 500) return null;

  const method = [
    `BOPD-anchored income cap`,
    `${wellEquivalents.toFixed(2)} well-eq (${acreage} ac ÷ ${WELL_SPACING_ACRES} ac/well)`,
    `× ${medianBopd} BOPD median`,
    `× ${(royaltyRate * 100).toFixed(1)}% royalty`,
    `× $${OIL_PRICE_PER_BBL}/bbl`,
    `× ${multiple.toFixed(2)}x multiple`,
    isUndeveloped ? `(${baseMultiple}x × 0.55 dev-risk discount)` : `(${activity} basin activity)`,
  ].join(" ");

  return { point, method };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Estimate property value.
 *
 * Priority order:
 * 1. BOPD-anchored: real nearby well production → income capitalization → ±10% band
 * 2. Document income/revenue signals → income multiple → ±12% band
 * 3. BOPD extracted from document → income cap → ±12% band
 * 4. Static basin-tier per-acre comps → ±12% band (no wide ranges)
 */
export function estimateValueRange(args: {
  input: DealValuationInput;
  dealType: DealValuationDealType;
  activity: DealValuationActivityLevel;
  /** Real nearby well data from state APIs — primary anchor when present. */
  nearbyWells?: NearbyWellIntelligence | null;
}): ValueEstimateResult {
  const { input, dealType, activity } = args;
  const acres = input.acreage != null && input.acreage > 0 ? input.acreage : null;
  const annual = annualFromFinancial(input);

  // ── Infrastructure / mixed ─────────────────────────────────────────────────
  if (infraHeavy(input, dealType)) {
    if (annual) {
      // Income multiple — tighten to ±12% around 2.5x midpoint
      const annMid = (annual.low + annual.high) / 2;
      const point = Math.round(annMid * 2.5);
      const band = bandFromMid(point, 0.12);
      const method = "infrastructure: 2.5x annual revenue midpoint ± 12%";
      logValuationDev("value_method", { method, dealType });
      return {
        value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
        value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
        estimated_total_value_low:  band.lo,
        estimated_total_value_high: band.hi,
        point_estimate: point,
        point_estimate_basis: "basin_tier",
        method,
      };
    }
    const baseMid = acres != null ? acres * 2_750 : 100_000;
    const band = bandFromMid(baseMid, 0.12);
    const method = "infrastructure: $2,750/acre strategic comp ± 12%";
    logValuationDev("value_method", { method });
    return {
      value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
      value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: Math.round(baseMid),
      point_estimate_basis: "basin_tier",
      method,
    };
  }

  // ── Producing / mixed ──────────────────────────────────────────────────────
  if (dealType === "producing" || dealType === "mixed") {

    // ── Path 1: BOPD-anchored from real nearby well data (most precise) ──
    const nearbyBopd = args.nearbyWells?.median_bopd ?? args.nearbyWells?.avg_bopd;
    const royalty = input.royalty_rate ?? 0.125;

    if (nearbyBopd != null && nearbyBopd > 0 && acres != null) {
      const est = bopdAnchoredEstimate({
        acreage: acres,
        royaltyRate: royalty,
        medianBopd: nearbyBopd,
        activity,
        dealType,
      });
      if (est) {
        const band = bandFromMid(est.point, 0.10);
        logValuationDev("value_method", { method: est.method, basis: "bopd_anchored" });
        return {
          value_per_acre_low:  Math.round(band.lo / acres),
          value_per_acre_high: Math.round(band.hi / acres),
          estimated_total_value_low:  band.lo,
          estimated_total_value_high: band.hi,
          point_estimate: est.point,
          point_estimate_basis: "bopd_anchored",
          method: est.method,
        };
      }
    }

    // ── Path 2: Document income signals ──
    if (annual) {
      const annMid = (annual.low + annual.high) / 2;
      const multiple = ACTIVITY_MULTIPLES[activity] ?? 3.5;
      const point = Math.round(annMid * multiple);
      const band = bandFromMid(point, 0.12);
      const method = `producing: document income × ${multiple}x multiple (${activity} activity) ± 12%`;
      logValuationDev("value_method", { method, multiple, activity });
      return {
        value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
        value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
        estimated_total_value_low:  band.lo,
        estimated_total_value_high: band.hi,
        point_estimate: point,
        point_estimate_basis: "basin_tier",
        method,
      };
    }

    // ── Path 3: BOPD from document ──
    const bopd = input.bopd;
    if (bopd != null && bopd > 0 && acres != null) {
      const est = bopdAnchoredEstimate({
        acreage: acres,
        royaltyRate: royalty,
        medianBopd: bopd,
        activity,
        dealType,
      });
      if (est) {
        const band = bandFromMid(est.point, 0.12);
        const method = `producing: document BOPD income cap ± 12%`;
        logValuationDev("value_method", { method, bopd, royalty });
        return {
          value_per_acre_low:  Math.round(band.lo / acres),
          value_per_acre_high: Math.round(band.hi / acres),
          estimated_total_value_low:  band.lo,
          estimated_total_value_high: band.hi,
          point_estimate: est.point,
          point_estimate_basis: "basin_tier",
          method,
        };
      }
    }

    // ── Path 4: Static producing comp (no income/BOPD data) ──
    if (acres == null) {
      return nullResult("producing (no income): acreage required for comp estimate");
    }
    const midPerAcre = PROD_MID[activity] ?? PROD_MID.unknown;
    const point = Math.round(midPerAcre * acres);
    const band = bandFromMid(point, 0.12);
    const method = `producing (no income): $${midPerAcre.toLocaleString()}/acre ${activity}-basin comp ± 12%`;
    logValuationDev("value_method", { method, activity, acres });
    return {
      value_per_acre_low:  Math.round(band.lo / acres),
      value_per_acre_high: Math.round(band.hi / acres),
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: point,
      point_estimate_basis: "basin_tier",
      method,
    };
  }

  // ── Undeveloped / lease / unknown ─────────────────────────────────────────
  if (dealType === "undeveloped" || dealType === "lease" || dealType === "unknown") {
    if (acres == null) {
      return nullResult("undeveloped: acreage required for estimate");
    }

    const royalty = input.royalty_rate ?? 0.125;

    // ── Path 1: BOPD-anchored (nearby well data available) ──
    const nearbyBopd = args.nearbyWells?.median_bopd ?? args.nearbyWells?.avg_bopd;
    if (nearbyBopd != null && nearbyBopd > 0) {
      const est = bopdAnchoredEstimate({
        acreage: acres,
        royaltyRate: royalty,
        medianBopd: nearbyBopd,
        activity,
        dealType: "undeveloped",  // always apply development discount
      });
      if (est) {
        const band = bandFromMid(est.point, 0.10);
        logValuationDev("value_method", { method: est.method, basis: "bopd_anchored" });
        return {
          value_per_acre_low:  Math.round(band.lo / acres),
          value_per_acre_high: Math.round(band.hi / acres),
          estimated_total_value_low:  band.lo,
          estimated_total_value_high: band.hi,
          point_estimate: est.point,
          point_estimate_basis: "bopd_anchored",
          method: est.method,
        };
      }
    }

    // ── Path 2: Static undeveloped comp ──
    let midPerAcre = UNDEV_MID[activity] ?? UNDEV_MID.unknown;

    // Royalty-rate bump: higher royalty = more valuable per acre
    if (input.royalty_rate != null && input.royalty_rate > 0 && input.royalty_rate <= 1) {
      // Standard 1/8 royalty is baseline; scale linearly ±15% for ±4 pts from 12.5%
      const royaltyFactor = 0.9 + (input.royalty_rate / 0.125) * 0.1;
      midPerAcre = Math.round(midPerAcre * Math.min(royaltyFactor, 1.2));
    }

    const point = Math.round(midPerAcre * acres);
    const band = bandFromMid(point, 0.12);
    const method = `undeveloped: $${midPerAcre.toLocaleString()}/acre ${activity}-basin comp ± 12%`;
    logValuationDev("value_method", { method, activity, acres });
    return {
      value_per_acre_low:  Math.round(band.lo / acres),
      value_per_acre_high: Math.round(band.hi / acres),
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: point,
      point_estimate_basis: "basin_tier",
      method,
    };
  }

  return nullResult("fallback: limited signals");
}

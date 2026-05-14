import type { DealValuationActivityLevel, DealValuationDealType, DealValuationInput } from "./types";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { MineralEconomicsResult } from "@/lib/economics/mineral-economics";
import type { RiskFlagsResult } from "@/lib/risk/risk-flags";
import type { PaLiabilityResult } from "@/lib/risk/pa-liability";
import { textSuggestsInfrastructure } from "./deal-type";
import { logValuationDev } from "./normalize";

// ── Result type ───────────────────────────────────────────────────────────────

export type ValueEstimateResult = {
  value_per_acre_low: number | null;
  value_per_acre_high: number | null;
  estimated_total_value_low: number | null;
  estimated_total_value_high: number | null;
  /** Single-point estimate — the headline number shown to users. */
  point_estimate: number | null;
  /**
   * "full_underwriting" — income cap + decline + risk + P&A all applied;
   * "bopd_anchored"     — real BOPD data, partial adjustments;
   * "basin_tier"        — static per-acre comps only.
   */
  point_estimate_basis: "full_underwriting" | "bopd_anchored" | "basin_tier" | null;
  /** Technical description of how the estimate was derived (for debug / PDF). */
  method: string;
  /**
   * Human-readable lines explaining each adjustment applied
   * (decline factor, risk discount, P&A deduction).
   * Appended to valuation.reasoning by the calling engine.
   */
  reasoning_additions: string[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Baseline oil price $/bbl for income capitalization. */
const OIL_PRICE_PER_BBL = 70;

/**
 * Standard well spacing: 1 producing well per 160 NMA (quarter section).
 * Conservative industry midpoint (Permian tighter ~120, Bakken/EF ~160-320).
 */
const WELL_SPACING_ACRES = 160;

/**
 * Activity multiples (income capitalization) by basin tier.
 * Approximate inverse cap rates used by mineral buyers.
 *   high:     5.0x ≈ 20% cap rate   (Permian/Bakken core)
 *   moderate: 4.0x ≈ 25% cap rate   (active secondary plays)
 *   low:      3.0x ≈ 33% cap rate   (mature/conventional)
 *   unknown:  3.5x ≈ 29% cap rate   (conservative midpoint)
 */
const ACTIVITY_MULTIPLES: Record<DealValuationActivityLevel, number> = {
  high:     5.0,
  moderate: 4.0,
  low:      3.0,
  unknown:  3.5,
};

/**
 * Static undeveloped per-acre comps — fallback when no production data.
 * Tight midpoints, ±15% band applied downstream.
 */
const UNDEV_MID: Record<DealValuationActivityLevel, number> = {
  high:     6_000,
  moderate: 2_100,
  low:        500,
  unknown:    400,
};

/**
 * Static producing per-acre comps — fallback when no income/BOPD data.
 * Tight midpoints, ±15% band applied downstream.
 */
const PROD_MID: Record<DealValuationActivityLevel, number> = {
  high:     12_500,
  moderate:  6_250,
  low:       2_500,
  unknown:   4_500,
};

// ── Adjustment helpers ────────────────────────────────────────────────────────

/**
 * Economic-life / decline-health discount factor.
 *
 * Buyers pay less for properties with short remaining production life.
 * Derived from income-capitalization theory: a perpetuity is worth more
 * than a 5-year annuity at the same annual income.
 */
function declineFactor(dec: DeclineCurveResult | null | undefined): number {
  if (!dec || dec.basis === "insufficient_data") return 1.0;

  // Economic life (years) is the primary signal when available
  if (dec.economic_life_months != null) {
    const yrs = dec.economic_life_months / 12;
    if (yrs >= 30) return 1.00;
    if (yrs >= 20) return 0.96;
    if (yrs >= 12) return 0.88;
    if (yrs >= 6)  return 0.76;
    if (yrs >= 2)  return 0.58;
    return 0.38; // < 2 yr remaining — near-end-of-life
  }

  // Fall back to categorical decline health
  switch (dec.decline_health) {
    case "strong":    return 1.00;
    case "moderate":  return 0.88;
    case "steep":     return 0.72;
    case "exhausted": return 0.42;
    default:          return 0.95;
  }
}

function declineReasoningLine(dec: DeclineCurveResult | null | undefined, factor: number): string | null {
  if (!dec || dec.basis === "insufficient_data" || factor >= 0.999) return null;
  const pct = Math.round((1 - factor) * 100);
  const life = dec.economic_life_months != null
    ? `${(dec.economic_life_months / 12).toFixed(1)}-yr economic life`
    : `${dec.decline_health} decline`;
  const rate = dec.annual_decline_pct ? ` (${dec.annual_decline_pct}/yr)` : "";
  return `Decline adjustment: −${pct}% for ${life}${rate}`;
}

/**
 * Risk flag discount factor.
 *
 * Critical flags (environmental, legal, title) significantly reduce the
 * price a prudent buyer will pay. High flags carry moderate discount.
 */
function riskFactor(flags: RiskFlagsResult | null | undefined): number {
  if (!flags) return 1.0;
  switch (flags.overall_risk) {
    case "low":      return 1.00;
    case "moderate": return 0.93;
    case "high":     return 0.83;
    case "critical": return 0.70;
    default:         return 1.00;
  }
}

function riskReasoningLine(flags: RiskFlagsResult | null | undefined, factor: number): string | null {
  if (!flags || factor >= 0.999) return null;
  const pct = Math.round((1 - factor) * 100);
  const detail: string[] = [];
  if (flags.critical_count > 0) detail.push(`${flags.critical_count} critical flag${flags.critical_count > 1 ? "s" : ""}`);
  if (flags.high_count > 0)     detail.push(`${flags.high_count} high flag${flags.high_count > 1 ? "s" : ""}`);
  const flagDesc = detail.length ? detail.join(", ") : `${flags.flags.length} flags`;
  return `Risk discount: −${pct}% for ${flags.overall_risk} risk profile (${flagDesc})`;
}

/**
 * P&A liability deduction.
 *
 * Only applied for high/critical severity — a prudent buyer discounts
 * the purchase price by a fraction of the expected plugging cost.
 * Low/moderate P&A is already embedded in the risk factor above.
 *
 * Present-value haircut:
 *   Critical: 30% of midpoint liability (near-term obligation likely)
 *   High:     15% of midpoint liability (possible obligation, discounted)
 */
function paDeduction(pa: PaLiabilityResult | null | undefined): number {
  if (!pa || pa.total_liability_low == null || pa.total_liability_high == null) return 0;
  const mid = (pa.total_liability_low + pa.total_liability_high) / 2;
  if (pa.severity === "critical") return Math.round(mid * 0.30);
  if (pa.severity === "high")     return Math.round(mid * 0.15);
  return 0;
}

function paReasoningLine(pa: PaLiabilityResult | null | undefined, deduction: number): string | null {
  if (!pa || deduction === 0) return null;
  const fmtD = deduction >= 1_000 ? `$${Math.round(deduction / 1_000)}k` : `$${deduction}`;
  return `P&A deduction: ${fmtD} for ${pa.severity} plugging liability (${pa.at_risk_count} at-risk well${pa.at_risk_count !== 1 ? "s" : ""})`;
}

/**
 * Band width shrinks the more engines have contributed real data.
 * More data → tighter uncertainty → narrower range.
 */
function bandWidth(hasEconomics: boolean, hasDecline: boolean): number {
  if (hasEconomics && hasDecline) return 0.07;  // ±7%  — all engines
  if (hasEconomics || hasDecline) return 0.09;  // ±9%  — partial
  return 0.10;                                  // ±10% — BOPD/comps only
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function nullResult(method: string): ValueEstimateResult {
  return {
    value_per_acre_low:  null,
    value_per_acre_high: null,
    estimated_total_value_low:  null,
    estimated_total_value_high: null,
    point_estimate: null,
    point_estimate_basis: null,
    method,
    reasoning_additions: [],
  };
}

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
  if (dealType === "infrastructure") return true;
  if (dealType === "mixed") return textSuggestsInfrastructure(text) || input.development_signals?.has_infrastructure_language === true;
  return false;
}

/**
 * Apply decline factor + risk factor + P&A deduction to a raw base value.
 * Returns the adjusted point and the reasoning lines describing each step.
 */
function applyAdjustments(
  baseValue: number,
  dec: DeclineCurveResult | null | undefined,
  flags: RiskFlagsResult | null | undefined,
  pa: PaLiabilityResult | null | undefined,
): { point: number; reasoning: string[] } {
  const df  = declineFactor(dec);
  const rf  = riskFactor(flags);
  const pad = paDeduction(pa);

  const afterDecline = Math.round(baseValue * df);
  const afterRisk    = Math.round(afterDecline * rf);
  const point        = Math.max(afterRisk - pad, 500);

  const reasoning: string[] = [];
  const dl = declineReasoningLine(dec, df);
  const rl = riskReasoningLine(flags, rf);
  const pl = paReasoningLine(pa, pad);
  if (dl) reasoning.push(dl);
  if (rl) reasoning.push(rl);
  if (pl) reasoning.push(pl);
  return { point, reasoning };
}

// ── BOPD income cap helper ────────────────────────────────────────────────────

function bopdAnchoredEstimate(args: {
  acreage: number;
  royaltyRate: number;
  medianBopd: number;
  activity: DealValuationActivityLevel;
  dealType: DealValuationDealType;
}): { base: number; method: string } | null {
  const { acreage, royaltyRate, medianBopd, activity, dealType } = args;
  if (acreage <= 0 || royaltyRate <= 0 || medianBopd <= 0) return null;

  const wellEq       = Math.max(0.25, acreage / WELL_SPACING_ACRES);
  const annualIncome = wellEq * medianBopd * royaltyRate * 365 * OIL_PRICE_PER_BBL;
  const baseMult     = ACTIVITY_MULTIPLES[activity] ?? 3.5;
  const isUndev      = dealType === "undeveloped" || dealType === "lease";
  const multiple     = isUndev ? baseMult * 0.55 : baseMult;
  const base         = Math.round(annualIncome * multiple);

  if (base < 500) return null;

  const method = [
    `BOPD income cap`,
    `${wellEq.toFixed(2)} well-eq (${acreage} ac ÷ ${WELL_SPACING_ACRES})`,
    `× ${medianBopd} BOPD`,
    `× ${(royaltyRate * 100).toFixed(1)}% royalty`,
    `× $${OIL_PRICE_PER_BBL}/bbl`,
    `× ${multiple.toFixed(2)}x`,
    isUndev ? `(${baseMult}x × 0.55 dev-risk)` : `(${activity} activity)`,
  ].join(" ");

  return { base, method };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Holistic value estimate synthesizing all available analysis engines.
 *
 * Priority order:
 * 1. ECONOMICS-ANCHORED: actual net royalty income × activity multiple,
 *    adjusted for decline curve, risk flags, and P&A liability.  [full_underwriting]
 * 2. BOPD-ANCHORED: real nearby BOPD → income cap, same adjustments.  [bopd_anchored]
 * 3. DOCUMENT INCOME: extracted revenue signals → income cap.  [basin_tier]
 * 4. STATIC COMPS: per-acre basin comps, risk-adjusted.  [basin_tier]
 */
export function estimateValueRange(args: {
  input: DealValuationInput;
  dealType: DealValuationDealType;
  activity: DealValuationActivityLevel;
  nearbyWells?: NearbyWellIntelligence | null;
  declineAnalysis?: DeclineCurveResult | null;
  mineralEconomics?: MineralEconomicsResult | null;
  riskFlags?: RiskFlagsResult | null;
  paLiability?: PaLiabilityResult | null;
}): ValueEstimateResult {
  const { input, dealType, activity } = args;
  const econ   = args.mineralEconomics;
  const dec    = args.declineAnalysis;
  const flags  = args.riskFlags;
  const pa     = args.paLiability;
  const acres  = input.acreage != null && input.acreage > 0 ? input.acreage : null;
  const annual = annualFromFinancial(input);

  // ── Infrastructure ────────────────────────────────────────────────────────
  if (infraHeavy(input, dealType)) {
    const mid   = annual ? Math.round(((annual.low + annual.high) / 2) * 2.5) : (acres != null ? acres * 2_750 : 100_000);
    const bw    = bandWidth(false, false);
    const adj   = applyAdjustments(mid, dec, flags, pa);
    const band  = bandFromMid(adj.point, bw);
    const meth  = annual ? "infrastructure: 2.5x annual revenue midpoint" : "infrastructure: $2,750/acre comp";
    logValuationDev("value_method", { method: meth, dealType });
    return {
      value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
      value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: adj.point,
      point_estimate_basis: "basin_tier",
      method: meth,
      reasoning_additions: adj.reasoning,
    };
  }

  const royalty = input.royalty_rate ?? 0.125;

  // ════════════════════════════════════════════════════════════════════
  // PATH 1 — ECONOMICS-ANCHORED (highest precision)
  //
  // Uses the actual computed net royalty income from the economics
  // engine, not a proxy. This IS the cash flow the mineral owner
  // receives, capitalized at the market-implied multiple.
  // Adjustments account for production decline life, risk exposure,
  // and plugging liability that a buyer would price in.
  // ════════════════════════════════════════════════════════════════════
  if (econ?.annual_net_royalty != null && econ.annual_net_royalty > 0) {
    const baseMult  = ACTIVITY_MULTIPLES[activity] ?? 3.5;
    const isUndev   = dealType === "undeveloped" || dealType === "lease";
    const multiple  = isUndev ? baseMult * 0.55 : baseMult;
    const baseValue = Math.round(econ.annual_net_royalty * multiple);

    const adj = applyAdjustments(baseValue, dec, flags, pa);

    const hasDeclineData = dec?.basis !== "insufficient_data" && dec != null;
    const bw   = bandWidth(true, hasDeclineData);
    const band = bandFromMid(adj.point, bw);

    const incomeCapLine = `Income cap: $${Math.round(econ.annual_net_royalty).toLocaleString("en-US")}/yr net royalty × ${multiple.toFixed(2)}x = $${baseValue.toLocaleString("en-US")}`;
    const meth = `Full underwriting: ${[incomeCapLine, ...adj.reasoning].join("; ")}`;

    logValuationDev("value_method", { method: meth, basis: "full_underwriting", activity, dealType });

    return {
      value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
      value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: adj.point,
      point_estimate_basis: "full_underwriting",
      method: meth,
      reasoning_additions: [incomeCapLine, ...adj.reasoning],
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // PATH 2 — BOPD-ANCHORED (real nearby well data, economics unavailable)
  // ════════════════════════════════════════════════════════════════════
  const nearbyBopd = args.nearbyWells?.median_bopd ?? args.nearbyWells?.avg_bopd;
  if (nearbyBopd != null && nearbyBopd > 0 && acres != null) {
    const est = bopdAnchoredEstimate({ acreage: acres, royaltyRate: royalty, medianBopd: nearbyBopd, activity, dealType });
    if (est) {
      const adj  = applyAdjustments(est.base, dec, flags, pa);
      const hasDeclineData = dec?.basis !== "insufficient_data" && dec != null;
      const bw   = bandWidth(false, hasDeclineData);
      const band = bandFromMid(adj.point, bw);
      const meth = `${est.method}${adj.reasoning.length ? "; " + adj.reasoning.join("; ") : ""}`;
      logValuationDev("value_method", { method: meth, basis: "bopd_anchored" });
      return {
        value_per_acre_low:  Math.round(band.lo / acres),
        value_per_acre_high: Math.round(band.hi / acres),
        estimated_total_value_low:  band.lo,
        estimated_total_value_high: band.hi,
        point_estimate: adj.point,
        point_estimate_basis: "bopd_anchored",
        method: meth,
        reasoning_additions: adj.reasoning,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // PATH 3 — DOCUMENT INCOME SIGNALS
  // ════════════════════════════════════════════════════════════════════
  if (annual) {
    const multiple  = ACTIVITY_MULTIPLES[activity] ?? 3.5;
    const baseValue = Math.round(((annual.low + annual.high) / 2) * multiple);
    const adj  = applyAdjustments(baseValue, dec, flags, pa);
    const bw   = bandWidth(false, false);
    const band = bandFromMid(adj.point, bw);
    const meth = `document income × ${multiple}x (${activity}) ± ${Math.round(bw * 100)}%${adj.reasoning.length ? "; " + adj.reasoning.join("; ") : ""}`;
    logValuationDev("value_method", { method: meth });
    return {
      value_per_acre_low:  acres != null ? Math.round(band.lo / acres) : null,
      value_per_acre_high: acres != null ? Math.round(band.hi / acres) : null,
      estimated_total_value_low:  band.lo,
      estimated_total_value_high: band.hi,
      point_estimate: adj.point,
      point_estimate_basis: "basin_tier",
      method: meth,
      reasoning_additions: adj.reasoning,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // PATH 4 — DOCUMENT BOPD (from lease/division order text)
  // ════════════════════════════════════════════════════════════════════
  if (input.bopd != null && input.bopd > 0 && acres != null) {
    const est = bopdAnchoredEstimate({ acreage: acres, royaltyRate: royalty, medianBopd: input.bopd, activity, dealType });
    if (est) {
      const adj  = applyAdjustments(est.base, dec, flags, pa);
      const bw   = bandWidth(false, false);
      const band = bandFromMid(adj.point, bw);
      const meth = `document BOPD income cap${adj.reasoning.length ? "; " + adj.reasoning.join("; ") : ""}`;
      logValuationDev("value_method", { method: meth });
      return {
        value_per_acre_low:  Math.round(band.lo / acres),
        value_per_acre_high: Math.round(band.hi / acres),
        estimated_total_value_low:  band.lo,
        estimated_total_value_high: band.hi,
        point_estimate: adj.point,
        point_estimate_basis: "basin_tier",
        method: meth,
        reasoning_additions: adj.reasoning,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // PATH 5 — STATIC BASIN COMPS (last resort, risk-adjusted)
  // ════════════════════════════════════════════════════════════════════
  if (acres == null) return nullResult("acreage required — no estimate possible");

  const isUndev  = dealType === "undeveloped" || dealType === "lease" || dealType === "unknown";
  let midPerAcre = isUndev ? (UNDEV_MID[activity] ?? UNDEV_MID.unknown) : (PROD_MID[activity] ?? PROD_MID.unknown);

  // Royalty-rate scaling for undeveloped (higher royalty → more valuable per acre)
  if (isUndev && royalty > 0 && royalty <= 1) {
    midPerAcre = Math.round(midPerAcre * Math.min(0.9 + (royalty / 0.125) * 0.1, 1.2));
  }

  const baseValue = Math.round(midPerAcre * acres);
  const adj  = applyAdjustments(baseValue, dec, flags, pa);
  const bw   = bandWidth(false, false);
  const band = bandFromMid(adj.point, 0.15); // wider band for static comps
  const label = isUndev ? "undeveloped" : "producing";
  const meth = `${label}: $${midPerAcre.toLocaleString()}/acre ${activity}-basin comp${adj.reasoning.length ? "; " + adj.reasoning.join("; ") : ""}`;
  logValuationDev("value_method", { method: meth, activity, acres });

  return {
    value_per_acre_low:  Math.round(band.lo / acres),
    value_per_acre_high: Math.round(band.hi / acres),
    estimated_total_value_low:  band.lo,
    estimated_total_value_high: band.hi,
    point_estimate: adj.point,
    point_estimate_basis: "basin_tier",
    method: meth,
    reasoning_additions: adj.reasoning,
  };
}

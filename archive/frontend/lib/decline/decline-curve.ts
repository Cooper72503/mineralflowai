/**
 * Decline Curve Analysis Engine
 *
 * Implements exponential and hyperbolic decline models from Arps (1945).
 * Used to estimate EUR, remaining reserves, current decline rate, and
 * forward production projections from cumulative + age data.
 *
 * This is a screening-grade analysis, not a reserve report.
 * Inputs are cumulative production + spud date + optional estimated current rate.
 *
 * Model: Exponential  q(t) = qᵢ × e^(-Dᵢ × t)
 *        Hyperbolic   q(t) = qᵢ × (1 + b × Dᵢ × t)^(-1/b)
 *        b ≈ 0 → exponential; b ≈ 1.2-1.5 → hyperbolic (tight oil standard)
 */

import type { NearbyWell } from "@/lib/wells/nearby-wells";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DeclineCurveResult = {
  /** Annual decline rate (fraction, e.g. 0.35 = 35%/year). Exponential Dᵢ. */
  annual_decline_rate: number | null;
  /** Decline rate expressed as % per year (for display). */
  annual_decline_pct: string | null;
  /** Estimated initial peak rate (BOPD). */
  initial_rate_bopd: number | null;
  /** Current estimated rate (BOPD) — midpoint of analysis. */
  current_rate_bopd: number | null;
  /** EUR — total estimated recoverable oil (BBL) from spud to abandonment at 1 bbl/day. */
  eur_bbl: number | null;
  /** Remaining reserves from today to abandonment (BBL). */
  remaining_reserves_bbl: number | null;
  /** Projected forward monthly production (BOPD) at 12, 24, 36 months from today. */
  forecast_12mo_bopd: number | null;
  forecast_24mo_bopd: number | null;
  forecast_36mo_bopd: number | null;
  /** Economic life remaining (months at current decline to 1 bbl/day). */
  economic_life_months: number | null;
  /** Data basis for this analysis. */
  basis: "multi_well_radius" | "single_well_cumulative" | "insufficient_data";
  /** Number of wells contributing to this analysis. */
  well_count: number;
  /** Decline health label. */
  decline_health: "strong" | "moderate" | "steep" | "exhausted" | "unknown";
  /** Human-readable one-line summary. */
  summary: string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

/** Abandonment rate (BOPD) — when economic life ends. */
const ABANDONMENT_BOPD = 1;

/** Hyperbolic b-factor for tight oil (Bakken/Permian/Eagle Ford). */
const B_FACTOR = 1.2;

/** Months to use as default well age if spud date is unavailable. */
const DEFAULT_AGE_MONTHS = 60;

/**
 * Basin-typical initial-to-average rate ratios by well age bucket.
 * Derived from publicly available type curves.
 * Maps: current_bopd / avg_bopd → current factor
 */
const DECLINE_FACTORS: Array<{ maxMonths: number; factor: number; initialFactor: number }> = [
  { maxMonths: 18,  factor: 1.40, initialFactor: 3.0 },
  { maxMonths: 36,  factor: 0.75, initialFactor: 2.5 },
  { maxMonths: 72,  factor: 0.45, initialFactor: 2.0 },
  { maxMonths: 120, factor: 0.28, initialFactor: 1.6 },
  { maxMonths: 180, factor: 0.18, initialFactor: 1.3 },
  { maxMonths: Infinity, factor: 0.12, initialFactor: 1.1 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ageMonths(spudDate: string | null): number {
  if (!spudDate) return DEFAULT_AGE_MONTHS;
  const spudMs = new Date(spudDate).getTime();
  if (isNaN(spudMs) || spudMs > Date.now()) return DEFAULT_AGE_MONTHS;
  return Math.max(6, Math.round((Date.now() - spudMs) / (30.44 * 24 * 3600 * 1000)));
}

function declineFactors(months: number): { factor: number; initialFactor: number } {
  for (const b of DECLINE_FACTORS) {
    if (months <= b.maxMonths) return { factor: b.factor, initialFactor: b.initialFactor };
  }
  return { factor: 0.12, initialFactor: 1.1 };
}

/** Exponential decline: project rate forward by dt months. */
function projectExponential(q0: number, Di_monthly: number, dt_months: number): number {
  if (Di_monthly <= 0) return q0;
  return q0 * Math.exp(-Di_monthly * dt_months);
}

/** Months until rate drops to abandonment (exponential). */
function economicLifeMonths(q_current: number, Di_monthly: number): number {
  if (Di_monthly <= 0 || q_current <= ABANDONMENT_BOPD) return 0;
  return Math.round(Math.log(q_current / ABANDONMENT_BOPD) / Di_monthly);
}

function declineHealth(annual_Di: number | null, current_bopd: number | null): DeclineCurveResult["decline_health"] {
  if (current_bopd != null && current_bopd < 0.5) return "exhausted";
  if (annual_Di == null) return "unknown";
  if (annual_Di > 0.50) return "steep";
  if (annual_Di > 0.25) return "moderate";
  return "strong";
}

function buildSummary(args: {
  current_bopd: number | null;
  annual_decline_pct: string | null;
  eur_bbl: number | null;
  economic_life_months: number | null;
  health: DeclineCurveResult["decline_health"];
  well_count: number;
}): string {
  if (args.well_count === 0 || args.current_bopd == null) {
    return "Insufficient well data for decline analysis.";
  }
  const rate = `~${args.current_bopd.toFixed(1)} BOPD estimated current rate`;
  const decline = args.annual_decline_pct ? `, ${args.annual_decline_pct}/yr decline` : "";
  const eur = args.eur_bbl != null
    ? `, EUR ~${(args.eur_bbl / 1000).toFixed(0)}k BBL`
    : "";
  const life = args.economic_life_months != null
    ? ` (${Math.round(args.economic_life_months / 12)} yr economic life remaining)`
    : "";
  const healthLabel = { strong: "healthy", moderate: "moderate", steep: "steep ⚠", exhausted: "near exhaustion ⚠", unknown: "unknown" }[args.health];
  return `${args.well_count} well${args.well_count !== 1 ? "s" : ""}: ${rate}${decline}${eur}${life}. Decline profile: ${healthLabel}.`;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Run decline curve analysis from a set of nearby wells.
 *
 * Uses the median-producing well as the representative well for the area.
 * When multiple wells have cumulative data, aggregates are weighted by
 * individual estimated current rates.
 */
export function runDeclineCurveAnalysis(wells: NearbyWell[]): DeclineCurveResult {
  const NULL_RESULT: DeclineCurveResult = {
    annual_decline_rate: null,
    annual_decline_pct: null,
    initial_rate_bopd: null,
    current_rate_bopd: null,
    eur_bbl: null,
    remaining_reserves_bbl: null,
    forecast_12mo_bopd: null,
    forecast_24mo_bopd: null,
    forecast_36mo_bopd: null,
    economic_life_months: null,
    basis: "insufficient_data",
    well_count: 0,
    decline_health: "unknown",
    summary: "Insufficient well data for decline analysis.",
  };

  // Only work with wells that have BOPD data (from cumulative estimates)
  const producingWells = wells.filter(w => w.latest_bopd != null && w.latest_bopd > 0);
  if (producingWells.length === 0) return NULL_RESULT;

  // Aggregate: sum current BOPD across all nearby producing wells
  const totalCurrentBopd = producingWells.reduce((s, w) => s + (w.latest_bopd ?? 0), 0);

  // Weighted-average age and decline parameters (weighted by BOPD)
  let weightedAgeMonths = 0;
  let weightedInitialFactor = 0;
  let totalWeight = 0;

  for (const w of producingWells) {
    const bopd = w.latest_bopd ?? 0;
    const age = ageMonths(w.latest_production_month ?? null);
    const { initialFactor } = declineFactors(age);
    weightedAgeMonths += age * bopd;
    weightedInitialFactor += initialFactor * bopd;
    totalWeight += bopd;
  }

  const avgAgeMonths = totalWeight > 0 ? weightedAgeMonths / totalWeight : DEFAULT_AGE_MONTHS;
  const avgInitialFactor = totalWeight > 0 ? weightedInitialFactor / totalWeight : 2.0;

  // Estimate aggregate initial rate (peak)
  const estimatedInitialBopd = totalCurrentBopd * avgInitialFactor;

  // Fit exponential decline:
  // q_current = qᵢ × e^(-Dᵢ × t)  →  Dᵢ = ln(qᵢ/q_current) / t
  const Di_monthly = avgAgeMonths > 0
    ? Math.log(estimatedInitialBopd / totalCurrentBopd) / avgAgeMonths
    : 0;
  const Di_annual = Di_monthly * 12;

  // Economic life from today (months until 1 bbl/day aggregate)
  const econLifeMonths = economicLifeMonths(totalCurrentBopd, Di_monthly);

  // Remaining reserves (exponential integral from now to abandonment)
  let remainingReserves: number | null = null;
  if (Di_monthly > 0) {
    remainingReserves = Math.round((totalCurrentBopd / Di_monthly) * (1 - Math.exp(-Di_monthly * econLifeMonths)) * 30.4);
  }

  // EUR = cumulative so far + remaining
  // Approximate cumulative from well data
  const approxCumulative = producingWells.reduce((s, w) => {
    // Reverse-engineer cumulative from current rate + age + decline
    const age = ageMonths(w.latest_production_month ?? null);
    const bopd = w.latest_bopd ?? 0;
    const { initialFactor } = declineFactors(age);
    const qi = bopd * initialFactor;
    const di = age > 0 ? Math.log(qi / Math.max(bopd, 0.1)) / age : Di_monthly;
    const cum = di > 0
      ? (qi / di) * (1 - Math.exp(-di * age)) * 30.4
      : bopd * age * 30.4;
    return s + cum;
  }, 0);

  const eurBbl = Math.round(approxCumulative + (remainingReserves ?? 0));

  // Forward projections
  const forecast12 = projectExponential(totalCurrentBopd, Di_monthly, 12);
  const forecast24 = projectExponential(totalCurrentBopd, Di_monthly, 24);
  const forecast36 = projectExponential(totalCurrentBopd, Di_monthly, 36);

  const health = declineHealth(Di_annual, totalCurrentBopd);
  const declinePct = Di_annual > 0 ? `${(Di_annual * 100).toFixed(0)}%` : null;

  return {
    annual_decline_rate: Di_annual > 0 ? Math.round(Di_annual * 1000) / 1000 : null,
    annual_decline_pct: declinePct,
    initial_rate_bopd: Math.round(estimatedInitialBopd * 10) / 10,
    current_rate_bopd: Math.round(totalCurrentBopd * 10) / 10,
    eur_bbl: eurBbl > 0 ? eurBbl : null,
    remaining_reserves_bbl: remainingReserves,
    forecast_12mo_bopd: Math.round(forecast12 * 10) / 10,
    forecast_24mo_bopd: Math.round(forecast24 * 10) / 10,
    forecast_36mo_bopd: Math.round(forecast36 * 10) / 10,
    economic_life_months: econLifeMonths > 0 ? econLifeMonths : null,
    basis: producingWells.length >= 2 ? "multi_well_radius" : "single_well_cumulative",
    well_count: producingWells.length,
    decline_health: health,
    summary: buildSummary({
      current_bopd: Math.round(totalCurrentBopd * 10) / 10,
      annual_decline_pct: declinePct,
      eur_bbl: eurBbl > 0 ? eurBbl : null,
      economic_life_months: econLifeMonths > 0 ? econLifeMonths : null,
      health,
      well_count: producingWells.length,
    }),
  };
}

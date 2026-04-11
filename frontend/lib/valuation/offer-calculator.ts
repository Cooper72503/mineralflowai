/**
 * Offer Calculator — directional acquisition offer scenarios.
 *
 * Takes NMA, royalty rate, deal type, and activity level; produces a
 * sensitivity table of implied offer prices at multiple oil price and
 * royalty multiple combinations.
 *
 * NOT a reserve report or appraisal. All output is directional and
 * based on basin-level benchmarks. Validate with actual production data.
 */

import type { DealValuationActivityLevel } from "./types";
import { lookupCountyBasinActivity } from "./county-basin-activity";

/** BOPD per NMA benchmarks — kept in sync with production-snapshot.ts */
const BOPD_PER_NMA: Record<string, { lo: number; hi: number; mid: number }> = {
  high:     { lo: 0.4,  hi: 2.5,  mid: 0.9  },
  moderate: { lo: 0.08, hi: 0.7,  mid: 0.25 },
  low:      { lo: 0.01, hi: 0.15, mid: 0.05 },
  unknown:  { lo: 0.04, hi: 0.5,  mid: 0.12 }, // conservative fallback
};

export type OfferCalculatorInput = {
  nma: number;
  royalty_rate: number;           // decimal (0.1875 = 3/16)
  activity_level?: DealValuationActivityLevel | null;
  deal_type?: string | null;
  county?: string | null;
  state?: string | null;
  oil_prices?: number[];          // default: [55, 65, 70, 75, 85, 95]
  multiples?: number[];           // default: [3, 5, 8, 12, 15]
};

export type OfferScenario = {
  oil_price: number;
  multiple: number;
  annual_royalty: number;
  implied_offer: number;
};

export type OfferCalculatorResult = {
  nma: number;
  royalty_rate: number;
  activity_level: string;
  bopd_mid: number;
  bopd_lo: number;
  bopd_hi: number;
  /** Annual royalty at $70/bbl (used for quick reference). */
  annual_royalty_at_70: number;
  /** Monthly royalty at $70/bbl. */
  monthly_royalty_at_70: number;
  /** Suggested offer low (5x annual royalty at $70 for producing; 3x for undeveloped). */
  suggested_offer_low: number;
  /** Suggested offer high (10x annual royalty at $70 for producing; 6x for undeveloped). */
  suggested_offer_high: number;
  /** $/NMA at the suggested offer midpoint. */
  dollar_per_nma_low: number;
  dollar_per_nma_high: number;
  /** Oil price axis (rows). */
  oil_prices: number[];
  /** Multiple axis (columns). */
  multiples: number[];
  /** matrix[oil_price_index][multiple_index] = implied offer in USD. */
  matrix: number[][];
  caveats: string[];
};

/**
 * Parse a royalty string like "3/16", "18.75%", "0.1875" → decimal.
 * Returns null if unparseable.
 */
export function parseRoyaltyRate(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw > 1 ? raw / 100 : raw;
  const s = String(raw).trim();
  // Fraction: "3/16"
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const n = parseFloat(frac[1]);
    const d = parseFloat(frac[2]);
    if (d === 0) return null;
    return n / d;
  }
  // Percentage: "18.75%" or "18.75 %"
  const pct = s.match(/^([\d.]+)\s*%$/);
  if (pct) return parseFloat(pct[1]) / 100;
  // Decimal: "0.1875"
  const dec = parseFloat(s);
  if (!isNaN(dec)) return dec > 1 ? dec / 100 : dec;
  return null;
}

export function buildOfferScenarios(input: OfferCalculatorInput): OfferCalculatorResult {
  const {
    nma,
    royalty_rate,
    county,
    state,
    oil_prices = [55, 65, 70, 75, 85, 95],
    multiples = [3, 5, 8, 12, 15],
  } = input;

  // Resolve activity level — county lookup beats passed-in "unknown"
  let activity: string = input.activity_level ?? "unknown";
  if (activity === "unknown" || !activity) {
    const looked = lookupCountyBasinActivity(county ?? null, state ?? null);
    if (looked) activity = looked;
  }

  const bench = BOPD_PER_NMA[activity] ?? BOPD_PER_NMA.unknown;
  const bopd_mid = bench.mid * nma;
  const bopd_lo  = bench.lo  * nma;
  const bopd_hi  = bench.hi  * nma;

  // Annual royalty = BOPD_mid × 365 days × oil_price × royalty_rate
  const annualAt = (price: number) => bopd_mid * 365 * price * royalty_rate;
  const annual_royalty_at_70 = annualAt(70);
  const monthly_royalty_at_70 = annual_royalty_at_70 / 12;

  const isUndeveloped =
    !input.deal_type ||
    input.deal_type === "undeveloped" ||
    input.deal_type === "lease" ||
    input.deal_type === "unknown";

  const low_mult  = isUndeveloped ? 3  : 5;
  const high_mult = isUndeveloped ? 6  : 10;

  const suggested_offer_low  = annual_royalty_at_70 * low_mult;
  const suggested_offer_high = annual_royalty_at_70 * high_mult;

  // Sensitivity matrix
  const matrix: number[][] = oil_prices.map((price) =>
    multiples.map((mult) => annualAt(price) * mult)
  );

  const caveats: string[] = [
    `BOPD estimate based on ${activity} activity tier benchmark (${bench.lo}–${bench.hi} BOPD/NMA). Confirm with actual well data.`,
    "Does not account for existing production decline, royalty deductions, or operating expenses.",
    "Treat as directional first-pass only — not a reserve report or appraisal.",
  ];

  if (activity === "unknown") {
    caveats.unshift("Activity level unknown — using conservative fallback benchmark. Provide county/state for a tighter range.");
  }

  return {
    nma,
    royalty_rate,
    activity_level: activity,
    bopd_mid,
    bopd_lo,
    bopd_hi,
    annual_royalty_at_70,
    monthly_royalty_at_70,
    suggested_offer_low,
    suggested_offer_high,
    dollar_per_nma_low:  nma > 0 ? suggested_offer_low  / nma : 0,
    dollar_per_nma_high: nma > 0 ? suggested_offer_high / nma : 0,
    oil_prices,
    multiples,
    matrix,
    caveats,
  };
}

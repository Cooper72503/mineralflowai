/**
 * SEC Reserve Classification Engine
 *
 * Implements SEC Rule 4-10(a) of Regulation S-X for oil & gas reserve
 * classification on producing properties.
 *
 * Categories covered:
 *   PDP  — Proved Developed Producing (highest certainty, currently producing)
 *   PDNP — Proved Developed Non-Producing (established but currently shut-in)
 *   PUD  — Proved Undeveloped (not currently supported — requires offset drilling data)
 *
 * Probabilistic reserves (P10/P50/P90) are sourced from the DCA engine's
 * parameter-variation output and mapped here to SEC reserve categories.
 *
 * Important limitations:
 *   - Uses strip pricing for economic tests, not the SEC-mandated 12-month
 *     average first-day price. Buyer should re-run with official SEC prices
 *     for regulatory filings.
 *   - Not a substitute for a reserve engineer (PE) certification.
 *   - PUD locations are not estimated (requires offset type-curve data).
 */

import type { DcaResult } from "./decline-curve";
import type { EconomicsOutput } from "./economics-engine";

export type ReserveCategory = "PDP" | "PDNP" | "subeconomic" | "insufficient_data";

export type ReserveClassification = {
  // ── Deterministic (SEC Rule 4-10) ─────────────────────────────────────────
  category: ReserveCategory;

  /** P1 PDP remaining reserves (BBL) — base-case DCA remaining */
  p1_pdp_remaining_bbl: number;

  /** NPV10 of P1 PDP at strip pricing (pre-tax, base-case economics) */
  p1_pdp_npv10_usd: number;

  /** SEC standardized measure note — pricing caveat */
  sec_methodology_note: string;

  // ── Probabilistic (P10 / P50 / P90) ──────────────────────────────────────
  /** Optimistic (10th percentile of decline uncertainty — 90% probability of exceeding) */
  p10_remaining_bbl: number;
  /** Base case (50th percentile) */
  p50_remaining_bbl: number;
  /** Conservative (90th percentile — 10% probability of exceeding) */
  p90_remaining_bbl: number;

  // ── Reserve Life Index ────────────────────────────────────────────────────
  /** P50 remaining ÷ current annual rate (years). Liquidity proxy. */
  reserve_life_index_years: number;

  /** NPV10 per BOE of P50 remaining (value density — $/BOE) */
  pv10_per_boe: number;

  // ── Classification Evidence ───────────────────────────────────────────────
  qualifying_criteria: string[];
  disqualifying_flags: string[];
  confidence: "high" | "moderate" | "low";
  months_of_production_data: number;
  r_squared: number;
  currently_producing: boolean;
  positive_economics_at_strip: boolean;

  // ── Contextual metrics ────────────────────────────────────────────────────
  /** Ratio of P10 to P90 remaining — spread indicates data uncertainty */
  p10_p90_ratio: number;
  /** 3P total (P1 + risked P2 at 50%) — for portfolio-level sizing only */
  total_3p_bbl: number;
};

export type ClassifyReservesArgs = {
  dcaResult: DcaResult;
  econResult: EconomicsOutput;
  complianceHasShutInOrder: boolean;
  complianceHasCriticalViolations: boolean;
  economicLimitBbl?: number;
};

export function classifyReserves(args: ClassifyReservesArgs): ReserveClassification {
  const { dcaResult, econResult, complianceHasShutInOrder, complianceHasCriticalViolations } = args;
  const econLimit = args.economicLimitBbl ?? 5;

  const qualifying:     string[] = [];
  const disqualifying:  string[] = [];

  // ── Criterion 1: Currently producing ──────────────────────────────────────
  const currentlyProducing = dcaResult.current_bbl > econLimit;
  if (currentlyProducing) {
    qualifying.push(`Currently producing at ${dcaResult.current_bbl.toFixed(0)} BBL/month (above economic limit of ${econLimit} BBL/month)`);
  } else {
    disqualifying.push(`Current production (${dcaResult.current_bbl.toFixed(0)} BBL/month) is at or below economic limit — possible shut-in or stripper`);
  }

  // ── Criterion 2: Sufficient production history ─────────────────────────────
  const hasMinData = dcaResult.months_of_data >= 6;
  const hasPrefData = dcaResult.months_of_data >= 12;
  if (hasPrefData) {
    qualifying.push(`${dcaResult.months_of_data} months of production history (≥12 months preferred by SEC)`);
  } else if (hasMinData) {
    qualifying.push(`${dcaResult.months_of_data} months of production history (meets 6-month minimum; 12+ preferred)`);
  } else {
    disqualifying.push(`Only ${dcaResult.months_of_data} months of production data — insufficient for proved reserve classification (minimum 6 months)`);
  }

  // ── Criterion 3: DCA fit quality ──────────────────────────────────────────
  const r2 = dcaResult.model.r_squared;
  const hasFitQuality = r2 >= 0.65;
  if (r2 >= 0.85) {
    qualifying.push(`DCA R²=${r2.toFixed(2)} — high-confidence decline curve fit`);
  } else if (r2 >= 0.65) {
    qualifying.push(`DCA R²=${r2.toFixed(2)} — acceptable fit (≥0.65 threshold met)`);
  } else {
    disqualifying.push(`DCA R²=${r2.toFixed(2)} — insufficient curve fit quality for proved classification (need ≥0.65)`);
  }

  // ── Criterion 4: Positive economics at current strip pricing ──────────────
  // We use Strip deck ($72/BBL) as a proxy for "current economic conditions"
  // per SEC Rule 4-10. Formal SEC filings use the 12-month average first-day price.
  const stripScenario = econResult.scenarios.find(s => s.deck.label === "Strip")
    ?? econResult.scenarios.find(s => s.deck.label === "Base");
  const positiveEcon = (stripScenario?.monthly_net_income_usd ?? 0) > 0;
  if (positiveEcon) {
    const strip = stripScenario!;
    qualifying.push(`Positive economics at strip pricing ($${strip.deck.oil_usd_bbl}/BBL): net income $${strip.monthly_net_income_usd.toLocaleString()}/month`);
  } else {
    disqualifying.push(`Negative or zero economics at strip pricing — well may be subeconomic under current conditions`);
  }

  // ── Criterion 5: No regulatory shut-in orders ─────────────────────────────
  if (complianceHasShutInOrder) {
    disqualifying.push("Active regulatory shut-in order detected — production continuity not assured");
  } else {
    qualifying.push("No regulatory shut-in orders identified");
  }

  // ── Criterion 6: No critical compliance violations affecting operation ──────
  if (complianceHasCriticalViolations) {
    disqualifying.push("Critical compliance violations on record — review before relying on proved classification");
  }

  // ── Determine category ────────────────────────────────────────────────────
  const meetsAllProved = currentlyProducing && hasMinData && hasFitQuality && positiveEcon && !complianceHasShutInOrder;

  let category: ReserveCategory;
  if (meetsAllProved) {
    category = "PDP";
  } else if (!currentlyProducing && hasMinData && hasFitQuality && positiveEcon) {
    // Historical evidence of production but currently not producing
    category = "PDNP";
  } else if (!positiveEcon) {
    category = "subeconomic";
  } else {
    category = "insufficient_data";
  }

  // ── Confidence level ──────────────────────────────────────────────────────
  let confidence: "high" | "moderate" | "low";
  if (category === "PDP" && hasPrefData && r2 >= 0.85 && !complianceHasCriticalViolations) {
    confidence = "high";
  } else if (category === "PDP") {
    confidence = "moderate";
  } else {
    confidence = "low";
  }

  // ── Reserve volumes ───────────────────────────────────────────────────────
  const p1Remaining = category === "PDP" ? dcaResult.remaining_reserves_bbl : 0;
  const p10         = dcaResult.p10_remaining_bbl;
  const p50         = dcaResult.p50_remaining_bbl;
  const p90         = dcaResult.p90_remaining_bbl;

  // Reserve Life Index: P50 remaining ÷ annualized current rate
  const annualRate = dcaResult.current_bbl * 12;
  const rli = annualRate > 0 ? (p50 / annualRate) : 0;

  // PV10 per BOE (strip scenario NPV10 ÷ P1 remaining)
  const npv10 = stripScenario?.npv10_usd ?? econResult.npv10_base_usd;
  const pv10PerBoe = p1Remaining > 0 ? npv10 / p1Remaining : 0;

  // 3P total: P1 (proved) + 50% of (P10 - P50) as risked P2
  const riskedP2 = Math.max(0, (p10 - p50) * 0.5);
  const total3p  = p1Remaining + riskedP2;

  const p10p90Ratio = p90 > 0 ? Math.round((p10 / p90) * 10) / 10 : 0;

  const secNote = [
    "Reserve volumes are unaudited estimates based on Arps decline curve analysis.",
    "Economic testing uses strip pricing, not the SEC-mandated 12-month average first-day price.",
    "PUD locations are not included — require offset type-curve data and spacing analysis.",
    "Not a substitute for a reserve engineer certification (PE stamp) required for banking or regulatory filings.",
  ].join(" ");

  return {
    category,
    p1_pdp_remaining_bbl:   Math.round(p1Remaining),
    p1_pdp_npv10_usd:       Math.round(npv10),
    sec_methodology_note:   secNote,
    p10_remaining_bbl:      Math.round(p10),
    p50_remaining_bbl:      Math.round(p50),
    p90_remaining_bbl:      Math.round(p90),
    reserve_life_index_years: Math.round(rli * 10) / 10,
    pv10_per_boe:           Math.round(pv10PerBoe * 100) / 100,
    qualifying_criteria:    qualifying,
    disqualifying_flags:    disqualifying,
    confidence,
    months_of_production_data: dcaResult.months_of_data,
    r_squared:              r2,
    currently_producing:    currentlyProducing,
    positive_economics_at_strip: positiveEcon,
    p10_p90_ratio:          p10p90Ratio,
    total_3p_bbl:           Math.round(total3p),
  };
}

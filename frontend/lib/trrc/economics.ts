/**
 * Economic evaluation — NPV/PV-10/PV-15 and offer range, built on top of the
 * existing Arps decline-curve engine (decline-curve.ts). This is screening-
 * grade analysis, not a certified reserves report: same caveat that already
 * governs decline-curve.ts (lease-level TRRC production, not certified
 * single-well data) applies here too, plus the cost assumptions below are
 * generic defaults, not basin- or lease-specific.
 *
 * IRR and payout months are deliberately NOT computed in v1 — both require
 * a proposed purchase price, and no such input exists anywhere in this
 * report's data model. Rather than inventing a number against nothing,
 * `irr`/`payoutMonths` are always null with a clear disclosure string; the
 * offer range stands on its own as a direct function of PV-10, which needs
 * no purchase price.
 */

import { fitArpsDecline, forecastToTerminalRate, type DeclineCurveFit } from "./decline-curve";
import type { PriceDeck, ScenarioPrice } from "./eia-pricing";

// Real Texas statutory severance tax rates — Texas Tax Code §201 (natural
// gas, 7.5% of market value) and §202 (oil, 4.6% of market value).
export const TX_SEVERANCE_TAX_OIL = 0.046;
export const TX_SEVERANCE_TAX_GAS = 0.075;

// A single transparent LOE (lease operating expense) default, deliberately
// generic — this codebase has no real per-basin cost data to back a more
// specific figure (the "EIA basin benchmarks" referenced in marketing copy
// don't actually exist as sourced data anywhere in this repo). Always
// disclosed alongside the numbers it produces, never presented as
// lease-specific.
export const DEFAULT_LOE_USD_PER_BOE = 12;

// Generic gas stripper-well economic limit, analogous to decline-curve.ts's
// 150 BBL/month oil terminal rate — not a sourced per-basin figure.
const GAS_TERMINAL_RATE_MCF_PER_MONTH = 500;

const MCF_PER_BOE = 6; // standard oil-equivalent conversion, 6 Mcf gas = 1 BOE

export type Scenario = "stress" | "base" | "strip" | "upside";

export interface ScenarioResult {
  scenario: Scenario;
  pv10: number;
  pv15: number;
  grossRevenue: number;
  severanceTax: number;
  loe: number;
  netCashFlow: number;
}

export interface EconomicEvaluation {
  sufficientData: boolean; // false when neither oil nor gas had enough history for any Arps fit
  oilFit: DeclineCurveFit | null;
  gasFit: DeclineCurveFit | null;
  priceDeck: PriceDeck;
  scenarios: ScenarioResult[];
  offerRangeLow: number;   // = stress scenario PV-10
  offerRangeMid: number;   // = base scenario PV-10
  offerRangeHigh: number;  // = upside scenario PV-10
  irr: null;
  payoutMonths: null;
  irrPayoutNote: string;
  costAssumptionNote: string;
}

function monthlyDiscountRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

function evaluateScenario(
  scenario: Scenario,
  price: ScenarioPrice,
  oilForecast: { rate: number }[],
  gasForecast: { rate: number }[],
): ScenarioResult {
  const horizon = Math.max(oilForecast.length, gasForecast.length);
  const monthlyRate10 = monthlyDiscountRate(0.10);
  const monthlyRate15 = monthlyDiscountRate(0.15);

  let grossRevenue = 0, severanceTax = 0, loe = 0, netCashFlow = 0, pv10 = 0, pv15 = 0;

  // Both forecasts are indexed by "months ahead of the last real production
  // month," not aligned calendar months — oil and gas decline curves are
  // fit independently and can have different history lengths after
  // fitArpsDecline drops leading/trailing zero months. Treating "months
  // ahead" as a shared go-forward timeline is a documented simplification,
  // not an attempt at exact calendar alignment between two independent fits.
  for (let i = 0; i < horizon; i++) {
    const monthsAhead = i + 1;
    const oilRate = oilForecast[i]?.rate ?? 0;
    const gasRate = gasForecast[i]?.rate ?? 0;

    const oilRevenue = oilRate * price.oilUsdBbl;
    const gasRevenue = gasRate * price.gasUsdMcf;
    const monthGrossRevenue = oilRevenue + gasRevenue;
    const monthSeveranceTax = oilRevenue * TX_SEVERANCE_TAX_OIL + gasRevenue * TX_SEVERANCE_TAX_GAS;
    const monthBoe = oilRate + gasRate / MCF_PER_BOE;
    const monthLoe = monthBoe * DEFAULT_LOE_USD_PER_BOE;
    const monthNetCashFlow = monthGrossRevenue - monthSeveranceTax - monthLoe;

    grossRevenue += monthGrossRevenue;
    severanceTax += monthSeveranceTax;
    loe += monthLoe;
    netCashFlow += monthNetCashFlow;
    pv10 += monthNetCashFlow / Math.pow(1 + monthlyRate10, monthsAhead);
    pv15 += monthNetCashFlow / Math.pow(1 + monthlyRate15, monthsAhead);
  }

  return { scenario, pv10, pv15, grossRevenue, severanceTax, loe, netCashFlow };
}

export function computeEconomics(
  monthlyOilBbl: number[],
  monthlyGasMcf: number[],
  priceDeck: PriceDeck,
): EconomicEvaluation {
  const oilFit = fitArpsDecline(monthlyOilBbl);
  const gasFit = fitArpsDecline(monthlyGasMcf);
  const sufficientData = oilFit !== null || gasFit !== null;

  const costAssumptionNote =
    `Costs modeled: Texas statutory severance tax (${(TX_SEVERANCE_TAX_OIL * 100).toFixed(1)}% oil / ${(TX_SEVERANCE_TAX_GAS * 100).toFixed(1)}% gas, ` +
    `market value) and a generic LOE assumption of $${DEFAULT_LOE_USD_PER_BOE}/BOE — not basin- or lease-specific, since no real per-basin cost ` +
    `data exists in this report. Ad valorem tax is NOT included — verify actual rates with the relevant county appraisal district before relying on these figures.`;

  const irrPayoutNote = "Not computed — IRR and payout months both require a proposed purchase price, which this report does not currently collect.";

  if (!sufficientData) {
    return {
      sufficientData, oilFit, gasFit, priceDeck,
      scenarios: [], offerRangeLow: 0, offerRangeMid: 0, offerRangeHigh: 0,
      irr: null, payoutMonths: null, irrPayoutNote, costAssumptionNote,
    };
  }

  const oilForecast = oilFit ? forecastToTerminalRate(oilFit) : [];
  const gasForecast = gasFit ? forecastToTerminalRate(gasFit, GAS_TERMINAL_RATE_MCF_PER_MONTH) : [];

  const scenarios: ScenarioResult[] = (["stress", "base", "strip", "upside"] as Scenario[])
    .map(s => evaluateScenario(s, priceDeck.scenarios[s], oilForecast, gasForecast));

  const byScenario = Object.fromEntries(scenarios.map(s => [s.scenario, s])) as Record<Scenario, ScenarioResult>;

  return {
    sufficientData, oilFit, gasFit, priceDeck, scenarios,
    offerRangeLow: byScenario.stress.pv10,
    offerRangeMid: byScenario.base.pv10,
    offerRangeHigh: byScenario.upside.pv10,
    irr: null, payoutMonths: null, irrPayoutNote, costAssumptionNote,
  };
}

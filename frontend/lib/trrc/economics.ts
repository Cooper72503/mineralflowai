/**
 * Economic evaluation — NPV/PV-10/PV-15, offer range, and breakeven price,
 * built on top of the existing Arps decline-curve engine (decline-curve.ts).
 * This is screening-grade analysis, not a certified reserves report: same
 * caveat that already governs decline-curve.ts (lease-level TRRC
 * production, not certified single-well data) applies here too, plus the
 * cost assumptions below are generic or basin-typical defaults, not
 * lease-specific.
 *
 * IRR and payout months are deliberately NOT computed in v1 — both require
 * a proposed purchase price, and no such input exists anywhere in this
 * report's data model. Rather than inventing a number against nothing,
 * `irr`/`payoutMonths` are always null with a clear disclosure string; the
 * offer range stands on its own as a direct function of PV-10, which needs
 * no purchase price.
 */

import { fitArpsDecline, forecastToTerminalRate, stabilizedRate, type DeclineCurveFit } from "./decline-curve";
import type { PriceDeck, ScenarioPrice } from "./eia-pricing";
import { classifyBasin, loeMidpoint, checkDeclineAgainstBasin, type BasinBenchmark } from "./basin-benchmarks";

// Real Texas statutory severance tax rates — Texas Tax Code §201 (natural
// gas, 7.5% of market value) and §202 (oil, 4.6% of market value).
export const TX_SEVERANCE_TAX_OIL = 0.046;
export const TX_SEVERANCE_TAX_GAS = 0.075;

// A single transparent LOE (lease operating expense) default, used only
// when the well's basin can't be classified (see basin-benchmarks.ts) —
// when it can, the basin's own typical-range midpoint is used instead of
// this flat figure.
export const DEFAULT_LOE_USD_PER_BOE = 12;

// Generic ad valorem burden, expressed as a fraction of gross revenue —
// Texas ad valorem tax on mineral interests is assessed per-county on
// appraised production value, not a single statewide rate; this is a
// rough, commonly-cited representative figure, not a real per-county
// rate. Always disclosed as such, never presented as county-specific.
export const AD_VALOREM_PCT_OF_REVENUE = 0.02;

// Generic workover reserve — a per-BOE set-aside for periodic remedial
// work (pump/rod replacement, etc.) to sustain production, not a
// lease-specific AFE estimate.
export const WORKOVER_RESERVE_USD_PER_BOE = 2;

// Generic saltwater disposal cost, only applied when water production is
// actually known (see computeEconomics) — most TRRC production queries do
// not report water volume at all, so this commonly evaluates to "not
// modeled" rather than a number, which is the correct, honest behavior,
// not a bug.
export const SWD_DISPOSAL_USD_PER_BBL_WATER = 1.0;

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
  adValorem: number;
  loe: number;
  workoverReserve: number;
  swdDisposal: number;
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
  // Flat oil price (holding the base scenario's gas price and all cost
  // assumptions fixed) at which cumulative undiscounted net cash flow over
  // the forecast horizon is exactly zero. null when there's no oil
  // production to solve against (e.g. a pure, already-depleted gas well).
  breakevenOilPriceUsdBbl: number | null;
  basin: BasinBenchmark | null;
  loeUsdPerBoe: number; // the LOE figure actually used — basin midpoint if classified, else DEFAULT_LOE_USD_PER_BOE
  declineSanityCheck: { inRange: boolean; typicalAnnualRangePct: [number, number] } | null;
  stabilizedOilRateBblPerMonth: number | null;
  swdModeled: boolean; // false when no water production data was available to model disposal cost against
}

function monthlyDiscountRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

function evaluateScenario(
  scenario: Scenario,
  price: ScenarioPrice,
  oilForecast: { rate: number }[],
  gasForecast: { rate: number }[],
  loeUsdPerBoe: number,
  avgMonthlyWaterBbl: number | null,
): ScenarioResult {
  const horizon = Math.max(oilForecast.length, gasForecast.length);
  const monthlyRate10 = monthlyDiscountRate(0.10);
  const monthlyRate15 = monthlyDiscountRate(0.15);

  let grossRevenue = 0, severanceTax = 0, adValorem = 0, loe = 0, workoverReserve = 0, swdDisposal = 0, netCashFlow = 0, pv10 = 0, pv15 = 0;

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
    const monthAdValorem = monthGrossRevenue * AD_VALOREM_PCT_OF_REVENUE;
    const monthBoe = oilRate + gasRate / MCF_PER_BOE;
    const monthLoe = monthBoe * loeUsdPerBoe;
    const monthWorkover = monthBoe * WORKOVER_RESERVE_USD_PER_BOE;
    // Held constant at the historical average water rate for the whole
    // forecast — water cut isn't decline-curve-forecastable the way
    // oil/gas volumes are, and this is a minor line item; only applied at
    // all when real water production data exists (see computeEconomics).
    const monthSwd = avgMonthlyWaterBbl !== null ? avgMonthlyWaterBbl * SWD_DISPOSAL_USD_PER_BBL_WATER : 0;
    const monthNetCashFlow = monthGrossRevenue - monthSeveranceTax - monthAdValorem - monthLoe - monthWorkover - monthSwd;

    grossRevenue += monthGrossRevenue;
    severanceTax += monthSeveranceTax;
    adValorem += monthAdValorem;
    loe += monthLoe;
    workoverReserve += monthWorkover;
    swdDisposal += monthSwd;
    netCashFlow += monthNetCashFlow;
    pv10 += monthNetCashFlow / Math.pow(1 + monthlyRate10, monthsAhead);
    pv15 += monthNetCashFlow / Math.pow(1 + monthlyRate15, monthsAhead);
  }

  return { scenario, pv10, pv15, grossRevenue, severanceTax, adValorem, loe, workoverReserve, swdDisposal, netCashFlow };
}

/**
 * Solves for the flat oil price at which cumulative undiscounted net cash
 * flow over the forecast horizon is exactly zero, holding the base
 * scenario's gas price and all cost assumptions fixed. The relationship is
 * linear in oil price, so this has a closed form derived directly from
 * evaluateScenario's own per-month formula (must stay algebraically
 * consistent with it, not a separately-derived approximation):
 *
 *   netCashFlow = oilBbl*P*(1 - severanceOil - adValoremPct)
 *               + gasRevenue*(1 - severanceGas - adValoremPct)
 *               - loe - workover - swd
 *
 * (ad valorem is applied additively alongside severance tax on gross
 * revenue in evaluateScenario, not multiplicatively — this mirrors that
 * exactly.) Summed over the horizon and set to zero, solved for P.
 */
function solveBreakevenOilPrice(
  oilForecast: { rate: number }[],
  gasForecast: { rate: number }[],
  baseGasPriceUsdMcf: number,
  loeUsdPerBoe: number,
  avgMonthlyWaterBbl: number | null,
): number | null {
  const totalOilBbl = oilForecast.reduce((s, p) => s + p.rate, 0);
  if (totalOilBbl <= 0) return null;

  let gasRevenueNetOfTaxes = 0;
  let totalCosts = 0;
  const horizon = Math.max(oilForecast.length, gasForecast.length);
  const gasKeepFraction = 1 - TX_SEVERANCE_TAX_GAS - AD_VALOREM_PCT_OF_REVENUE;
  for (let i = 0; i < horizon; i++) {
    const oilRate = oilForecast[i]?.rate ?? 0;
    const gasRate = gasForecast[i]?.rate ?? 0;
    gasRevenueNetOfTaxes += gasRate * baseGasPriceUsdMcf * gasKeepFraction;
    const boe = oilRate + gasRate / MCF_PER_BOE;
    const swd = avgMonthlyWaterBbl !== null ? avgMonthlyWaterBbl * SWD_DISPOSAL_USD_PER_BBL_WATER : 0;
    totalCosts += boe * (loeUsdPerBoe + WORKOVER_RESERVE_USD_PER_BOE) + swd;
  }

  const oilKeepFraction = 1 - TX_SEVERANCE_TAX_OIL - AD_VALOREM_PCT_OF_REVENUE;
  const oilCoefficient = totalOilBbl * oilKeepFraction;
  if (oilCoefficient <= 0) return null;
  return (totalCosts - gasRevenueNetOfTaxes) / oilCoefficient;
}

export function computeEconomics(
  monthlyOilBbl: number[],
  monthlyGasMcf: number[],
  priceDeck: PriceDeck,
  // Optional — when omitted, basin classification falls back to the
  // generic LOE default and no decline sanity check is run, rather than
  // failing. monthlyWaterBbl is nearly always all-null in practice (TRRC's
  // production query doesn't report water for either lease type — see
  // ewa.ts), so swdModeled:false is the expected common case, not a bug.
  fieldName: string | null = null,
  county: string | null = null,
  monthlyWaterBbl: (number | null)[] = [],
): EconomicEvaluation {
  const oilFit = fitArpsDecline(monthlyOilBbl);
  const gasFit = fitArpsDecline(monthlyGasMcf);
  const sufficientData = oilFit !== null || gasFit !== null;

  const basin = classifyBasin(fieldName, county);
  const loeUsdPerBoe = basin ? loeMidpoint(basin) : DEFAULT_LOE_USD_PER_BOE;
  const loeSourceNote = basin
    ? `an internal reference LOE for ${basin.name} ($${basin.loeUsdPerBoeRange[0]}-$${basin.loeUsdPerBoeRange[1]}/BOE range, midpoint used) — an industry-typical range for this play, not a live-sourced or lease-specific figure`
    : `a generic LOE assumption of $${DEFAULT_LOE_USD_PER_BOE}/BOE, since this well's field/county could not be matched to a known basin`;

  const knownWater = monthlyWaterBbl.filter((v): v is number => v !== null && v > 0);
  const swdModeled = knownWater.length > 0;
  const avgMonthlyWaterBbl = swdModeled ? knownWater.reduce((a, b) => a + b, 0) / knownWater.length : null;

  const costAssumptionNote =
    `Costs modeled: Texas statutory severance tax (${(TX_SEVERANCE_TAX_OIL * 100).toFixed(1)}% oil / ${(TX_SEVERANCE_TAX_GAS * 100).toFixed(1)}% gas, market value), ` +
    `a generic ad valorem estimate of ${(AD_VALOREM_PCT_OF_REVENUE * 100).toFixed(1)}% of gross revenue (real rates are set per-county — verify with the relevant ` +
    `county appraisal district), a generic workover reserve of $${WORKOVER_RESERVE_USD_PER_BOE}/BOE, and ${loeSourceNote}. ` +
    `Saltwater disposal cost is ${swdModeled ? `modeled at $${SWD_DISPOSAL_USD_PER_BBL_WATER}/BBL against this well's known average water production` : "NOT modeled — no water production volume was available for this well/lease"}.`;

  const irrPayoutNote = "Not computed — IRR and payout months both require a proposed purchase price, which this report does not currently collect.";

  const stabilizedOilRateBblPerMonth = stabilizedRate(monthlyOilBbl);

  if (!sufficientData) {
    return {
      sufficientData, oilFit, gasFit, priceDeck,
      scenarios: [], offerRangeLow: 0, offerRangeMid: 0, offerRangeHigh: 0,
      irr: null, payoutMonths: null, irrPayoutNote, costAssumptionNote,
      breakevenOilPriceUsdBbl: null, basin, loeUsdPerBoe, declineSanityCheck: null,
      stabilizedOilRateBblPerMonth, swdModeled,
    };
  }

  const oilForecast = oilFit ? forecastToTerminalRate(oilFit) : [];
  const gasForecast = gasFit ? forecastToTerminalRate(gasFit, GAS_TERMINAL_RATE_MCF_PER_MONTH) : [];

  const scenarios: ScenarioResult[] = (["stress", "base", "strip", "upside"] as Scenario[])
    .map(s => evaluateScenario(s, priceDeck.scenarios[s], oilForecast, gasForecast, loeUsdPerBoe, avgMonthlyWaterBbl));

  const byScenario = Object.fromEntries(scenarios.map(s => [s.scenario, s])) as Record<Scenario, ScenarioResult>;

  const breakevenOilPriceUsdBbl = solveBreakevenOilPrice(oilForecast, gasForecast, priceDeck.scenarios.base.gasUsdMcf, loeUsdPerBoe, avgMonthlyWaterBbl);

  const declineSanityCheck = basin && oilFit ? checkDeclineAgainstBasin(basin, oilFit.currentAnnualDeclinePct) : null;

  return {
    sufficientData, oilFit, gasFit, priceDeck, scenarios,
    offerRangeLow: byScenario.stress.pv10,
    offerRangeMid: byScenario.base.pv10,
    offerRangeHigh: byScenario.upside.pv10,
    irr: null, payoutMonths: null, irrPayoutNote, costAssumptionNote,
    breakevenOilPriceUsdBbl, basin, loeUsdPerBoe, declineSanityCheck,
    stabilizedOilRateBblPerMonth, swdModeled,
  };
}

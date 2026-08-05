/**
 * Economic evaluation — NPV/PV-10/PV-15, offer range, and breakeven price,
 * built on top of the existing Arps decline-curve engine (decline-curve.ts).
 * This is screening-grade analysis, not a certified reserves report: same
 * caveat that already governs decline-curve.ts (lease-level TRRC
 * production, not certified single-well data) applies here too, plus the
 * cost assumptions below are generic or basin-typical defaults, not
 * lease-specific.
 *
 * IRR and payout months are computed only when the caller supplies a real
 * proposed purchase price (an optional input, threaded from the run's
 * `purchase_price` field — see the due-diligence intake form). Both are
 * derived from the BASE price scenario's forecasted monthly net cash flow
 * with the purchase price as the month-0 outflow — not from PV-10, which
 * needs no purchase price at all. When no purchase price is supplied,
 * `irr`/`payoutMonths` are null with a clear disclosure string, same as
 * before — never a fabricated number against a price nobody entered.
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
  irr: number | null; // annualized %, from monthly IRR compounded — null when no purchase price was supplied or the cash flow never recoups it
  payoutMonths: number | null; // null when no purchase price was supplied, or cumulative undiscounted net cash flow never reaches it within the forecast horizon
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

export function monthlyDiscountRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

interface MonthlyEconomics {
  grossRevenue: number; severanceTax: number; adValorem: number;
  loe: number; workoverReserve: number; swdDisposal: number; netCashFlow: number;
}

// Both forecasts are indexed by "months ahead of the last real production
// month," not aligned calendar months — oil and gas decline curves are
// fit independently and can have different history lengths after
// fitArpsDecline drops leading/trailing zero months. Treating "months
// ahead" as a shared go-forward timeline is a documented simplification,
// not an attempt at exact calendar alignment between two independent fits.
//
// Shared by evaluateScenario (PV-10/15, offer range) and the IRR/payout
// solvers below — both need the same per-month cash flow, just used
// differently (discounted-and-summed vs. cumulative-undiscounted / root-
// solved), so this is computed once rather than re-derived per consumer.
function computeMonthlyEconomics(
  price: ScenarioPrice,
  oilForecast: { rate: number }[],
  gasForecast: { rate: number }[],
  loeUsdPerBoe: number,
  avgMonthlyWaterBbl: number | null,
): MonthlyEconomics[] {
  const horizon = Math.max(oilForecast.length, gasForecast.length);
  const months: MonthlyEconomics[] = [];
  for (let i = 0; i < horizon; i++) {
    const oilRate = oilForecast[i]?.rate ?? 0;
    const gasRate = gasForecast[i]?.rate ?? 0;

    const oilRevenue = oilRate * price.oilUsdBbl;
    const gasRevenue = gasRate * price.gasUsdMcf;
    const grossRevenue = oilRevenue + gasRevenue;
    const severanceTax = oilRevenue * TX_SEVERANCE_TAX_OIL + gasRevenue * TX_SEVERANCE_TAX_GAS;
    const adValorem = grossRevenue * AD_VALOREM_PCT_OF_REVENUE;
    const boe = oilRate + gasRate / MCF_PER_BOE;
    const loe = boe * loeUsdPerBoe;
    const workoverReserve = boe * WORKOVER_RESERVE_USD_PER_BOE;
    // Held constant at the historical average water rate for the whole
    // forecast — water cut isn't decline-curve-forecastable the way
    // oil/gas volumes are, and this is a minor line item; only applied at
    // all when real water production data exists (see computeEconomics).
    const swdDisposal = avgMonthlyWaterBbl !== null ? avgMonthlyWaterBbl * SWD_DISPOSAL_USD_PER_BBL_WATER : 0;
    const netCashFlow = grossRevenue - severanceTax - adValorem - loe - workoverReserve - swdDisposal;

    months.push({ grossRevenue, severanceTax, adValorem, loe, workoverReserve, swdDisposal, netCashFlow });
  }
  return months;
}

function evaluateScenario(
  scenario: Scenario,
  price: ScenarioPrice,
  oilForecast: { rate: number }[],
  gasForecast: { rate: number }[],
  loeUsdPerBoe: number,
  avgMonthlyWaterBbl: number | null,
): ScenarioResult {
  const months = computeMonthlyEconomics(price, oilForecast, gasForecast, loeUsdPerBoe, avgMonthlyWaterBbl);
  const monthlyRate10 = monthlyDiscountRate(0.10);
  const monthlyRate15 = monthlyDiscountRate(0.15);

  let grossRevenue = 0, severanceTax = 0, adValorem = 0, loe = 0, workoverReserve = 0, swdDisposal = 0, netCashFlow = 0, pv10 = 0, pv15 = 0;
  months.forEach((m, i) => {
    const monthsAhead = i + 1;
    grossRevenue += m.grossRevenue;
    severanceTax += m.severanceTax;
    adValorem += m.adValorem;
    loe += m.loe;
    workoverReserve += m.workoverReserve;
    swdDisposal += m.swdDisposal;
    netCashFlow += m.netCashFlow;
    pv10 += m.netCashFlow / Math.pow(1 + monthlyRate10, monthsAhead);
    pv15 += m.netCashFlow / Math.pow(1 + monthlyRate15, monthsAhead);
  });

  return { scenario, pv10, pv15, grossRevenue, severanceTax, adValorem, loe, workoverReserve, swdDisposal, netCashFlow };
}

/**
 * First month (1-indexed) at which cumulative UNDISCOUNTED net cash flow
 * (base scenario) reaches the purchase price. null when the forecast
 * horizon ends before that happens — a well that never pays back within
 * its own forecast doesn't get a fabricated "eventually" answer.
 */
function computePayoutMonths(purchasePriceUsd: number, monthlyNetCashFlow: number[]): number | null {
  let cumulative = 0;
  for (let i = 0; i < monthlyNetCashFlow.length; i++) {
    cumulative += monthlyNetCashFlow[i];
    if (cumulative >= purchasePriceUsd) return i + 1;
  }
  return null;
}

// NPV of {month 0: -purchasePrice, months 1..N: monthlyNetCashFlow} at a
// given MONTHLY discount rate — the function solveIrrAnnualPct finds the
// root of.
function npvAtMonthlyRate(purchasePriceUsd: number, monthlyNetCashFlow: number[], monthlyRate: number): number {
  let npv = -purchasePriceUsd;
  for (let i = 0; i < monthlyNetCashFlow.length; i++) {
    npv += monthlyNetCashFlow[i] / Math.pow(1 + monthlyRate, i + 1);
  }
  return npv;
}

/**
 * Solves for IRR via bisection rather than Newton-Raphson — robust against
 * the flat/near-zero derivatives a declining-then-flattening production
 * cash flow can produce, at the cost of a few more iterations (cheap here,
 * this isn't a hot path). NPV(rate) is monotonically decreasing in rate
 * whenever the cash flow series is predominantly positive after month 0
 * (true for a producing well's forecast), so a single bracketing root is
 * guaranteed once npv(0) > 0 > npv(hi) — which is why the total-undiscounted
 * check below runs first.
 *
 * Returns null, not a fabricated rate, when the forecast cash flow never
 * exceeds the purchase price even undiscounted — there is no real
 * (positive, finite) IRR for an investment that never recoups.
 */
function solveIrrAnnualPct(purchasePriceUsd: number, monthlyNetCashFlow: number[]): number | null {
  if (purchasePriceUsd <= 0 || monthlyNetCashFlow.length === 0) return null;
  const totalUndiscounted = monthlyNetCashFlow.reduce((a, b) => a + b, 0);
  if (totalUndiscounted <= purchasePriceUsd) return null;

  let hi = 1;
  while (npvAtMonthlyRate(purchasePriceUsd, monthlyNetCashFlow, hi) > 0 && hi < 1e6) hi *= 2;
  if (npvAtMonthlyRate(purchasePriceUsd, monthlyNetCashFlow, hi) > 0) return null; // could not bracket a root — extremely unlikely given the check above

  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const npvMid = npvAtMonthlyRate(purchasePriceUsd, monthlyNetCashFlow, mid);
    if (npvMid > 0) lo = mid; else hi = mid;
  }
  const monthlyIrr = (lo + hi) / 2;
  return (Math.pow(1 + monthlyIrr, 12) - 1) * 100;
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
  // Optional proposed purchase price — the ONLY input IRR/payout months
  // are computed against. null/omitted (the common case today, since no
  // UI collects this yet for most runs) keeps both null with a disclosure
  // note, exactly as before this parameter existed.
  purchasePriceUsd: number | null = null,
): EconomicEvaluation {
  const oilFit = fitArpsDecline(monthlyOilBbl);
  const gasFit = fitArpsDecline(monthlyGasMcf);
  const sufficientData = oilFit !== null || gasFit !== null;
  const hasPurchasePrice = purchasePriceUsd !== null && purchasePriceUsd > 0;

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

  const irrPayoutNote = !sufficientData
    ? "Not computed — no production history was available to forecast cash flows."
    : hasPurchasePrice
      ? `Computed against the BASE price scenario's forecasted monthly net cash flow, using the proposed purchase price of $${Math.round(purchasePriceUsd!).toLocaleString("en-US")} as the month-0 outflow — not the PV-10 offer range above. Actual returns depend heavily on which price scenario materializes; this is a screening-grade estimate, not a certified return calculation.`
      : "Not computed — IRR and payout months both require a proposed purchase price, which was not provided for this run.";

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

  const baseMonthlyNetCashFlow = hasPurchasePrice
    ? computeMonthlyEconomics(priceDeck.scenarios.base, oilForecast, gasForecast, loeUsdPerBoe, avgMonthlyWaterBbl).map(m => m.netCashFlow)
    : [];
  const irr = hasPurchasePrice ? solveIrrAnnualPct(purchasePriceUsd!, baseMonthlyNetCashFlow) : null;
  const payoutMonths = hasPurchasePrice ? computePayoutMonths(purchasePriceUsd!, baseMonthlyNetCashFlow) : null;

  return {
    sufficientData, oilFit, gasFit, priceDeck, scenarios,
    offerRangeLow: byScenario.stress.pv10,
    offerRangeMid: byScenario.base.pv10,
    offerRangeHigh: byScenario.upside.pv10,
    irr, payoutMonths, irrPayoutNote, costAssumptionNote,
    breakevenOilPriceUsdBbl, basin, loeUsdPerBoe, declineSanityCheck,
    stabilizedOilRateBblPerMonth, swdModeled,
  };
}

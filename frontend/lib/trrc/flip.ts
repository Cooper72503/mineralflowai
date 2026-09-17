/**
 * Buy → optimize → sell ("flip") analysis.
 *
 * Asked for by a client directly: buy an asset, improve production or
 * cost, sell for more. The whole module is a difference between two runs
 * of the cash-flow model already used for PV-10 (economics.ts):
 *
 *   ΔPV10          = PV10(optimized) − PV10(as-is)
 *   Entry          = proposed purchase price, or PV10_as-is(base) × M_entry
 *   Hold cash flow = Σ optimized net cash flow, months 1..H
 *   Exit           = remaining PV10 of the optimized stream at month H
 *                    (discounted to the exit date) × M_exit × (1 − txn cost)
 *   Profit         = Exit + Hold cash flow − Entry − Capex
 *   MOIC           = (Exit + Hold cash flow) / (Entry + Capex)
 *   IRR            = rate r solving  0 = −(Entry+Capex) + Σ CF_t/(1+r)^t + Exit/(1+r)^H
 *   Payout         = first month where cumulative hold cash flow (+ Exit at H)
 *                    ≥ Entry + Capex
 *
 * Every lever (rate uplift, decline reduction, LOE reduction, differential
 * improvement) and both multiples are EXPLICIT INPUTS the user supplies
 * and the report prints. Defaults model no optimization at all
 * (levers at zero) and symmetric multiples (no multiple arbitrage), so with
 * defaults the only return is the hold cash flow — nothing is asserted
 * about what an operator could achieve. The lever-sensitivity table shows
 * the PV-10 effect of each lever at a disclosed unit step so a buyer can
 * see what a given improvement would be worth before assuming it.
 *
 * Ownership nuance (stated on the report): a working-interest owner can
 * pull operational levers; a mineral or royalty owner cannot — their flip
 * is the gap between what was paid and what the records support, which
 * is what the rest of the diligence report surfaces.
 *
 * Pure and deterministic. No model, no retrieval.
 */
import { forecastNetCashFlowSeries, monthlyDiscountRate, type CashFlowSeriesInput, type ForecastAdjustment, type Scenario } from "./economics";
import type { PriceDeck } from "./eia-pricing";

export const FLIP_SCHEMA_VERSION = "flip_v1";

export interface FlipLevers {
  rateUpliftPct: number;             // e.g. 10 → forecast rates ×1.10
  declineReductionPct: number;       // e.g. 10 → nominal decline ×0.90
  loeReductionPct: number;           // e.g. 10 → LOE $/BOE ×0.90
  oilDifferentialImprovementUsdBbl: number; // e.g. 1 → +$1/BBL realized oil price
}

export interface FlipAssumptions {
  entryMultipleOfPv10: number;       // used only when no purchase price is supplied
  exitMultipleOfPv10: number;
  holdMonths: number;
  optimizationCapexUsd: number;
  transactionCostPct: number;        // of exit proceeds
  levers: FlipLevers;
}

export const DEFAULT_FLIP_ASSUMPTIONS: FlipAssumptions = {
  entryMultipleOfPv10: 1.0,
  exitMultipleOfPv10: 1.0,
  holdMonths: 24,
  optimizationCapexUsd: 0,
  transactionCostPct: 0,
  levers: { rateUpliftPct: 0, declineReductionPct: 0, loeReductionPct: 0, oilDifferentialImprovementUsdBbl: 0 },
};

export interface FlipScenarioResult {
  scenario: Scenario;
  pv10AsIsUsd: number;
  pv10OptimizedUsd: number;
  upliftPv10Usd: number;
  entryUsd: number;
  holdNetCashFlowUsd: number;
  exitRemainingPv10Usd: number;      // PV-10 of months H+1..N, discounted to month H
  exitProceedsUsd: number;           // × exit multiple × (1 − txn cost)
  capexUsd: number;
  profitUsd: number;
  moic: number | null;               // null when Entry + Capex ≤ 0
  irrAnnualPct: number | null;       // null when the position never recoups
  payoutMonths: number | null;       // null when not reached within the hold
  forecastMonths: number;
  holdCoversFullForecast: boolean;   // true when the well depletes before month H (exit value is then 0)
}

export interface LeverSensitivity {
  lever: keyof FlipLevers;
  label: string;
  step: string;                      // human-readable unit step, e.g. "−10% LOE"
  deltaPv10Usd: number;              // base scenario, full horizon, this lever alone
}

export interface FlipAnalysis {
  schemaVersion: typeof FLIP_SCHEMA_VERSION;
  sufficientData: boolean;
  unavailableReason?: string;
  entryBasis: "purchase_price" | "multiple_of_base_pv10";
  assumptions: FlipAssumptions;
  scenarios: FlipScenarioResult[];
  leverSensitivity: LeverSensitivity[];
  notes: { assumptions: string; ownership: string; disclaimer: string };
}

function leversToAdjustment(l: FlipLevers): ForecastAdjustment {
  return {
    rateMultiplier: 1 + l.rateUpliftPct / 100,
    declineMultiplier: 1 - l.declineReductionPct / 100,
    loeMultiplier: 1 - l.loeReductionPct / 100,
    oilPriceAdderUsdBbl: l.oilDifferentialImprovementUsdBbl,
  };
}

const MONTHLY_R10 = monthlyDiscountRate(0.10);

/** PV-10 of months [from, to) discounted to month `from` (0-based index; discount exponent = t − from + 1). */
function pv10Slice(cf: number[], from: number, to: number): number {
  let pv = 0;
  for (let t = from; t < Math.min(to, cf.length); t++) pv += cf[t] / Math.pow(1 + MONTHLY_R10, t - from + 1);
  return pv;
}

function sum(cf: number[], from: number, to: number): number {
  let s = 0;
  for (let t = from; t < Math.min(to, cf.length); t++) s += cf[t];
  return s;
}

/** IRR by bisection on a monthly series where index 0 is the month-0 outflow. Returns annualized %. */
export function solveIrrAnnualPct(series: number[]): number | null {
  if (series.length < 2 || series[0] >= 0) return null;
  const total = series.reduce((a, b) => a + b, 0);
  if (total <= 0) return null; // never recoups even undiscounted → no positive IRR
  const npv = (r: number) => series.reduce((acc, v, t) => acc + v / Math.pow(1 + r, t), 0);
  let lo = 0, hi = 1;
  while (npv(hi) > 0 && hi < 1e6) hi *= 2;
  if (npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  return (Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100;
}

export function computeFlipAnalysis(
  input: CashFlowSeriesInput,
  priceDeck: PriceDeck,
  purchasePriceUsd: number | null,
  assumptions: FlipAssumptions = DEFAULT_FLIP_ASSUMPTIONS,
): FlipAnalysis {
  const a: FlipAssumptions = { ...DEFAULT_FLIP_ASSUMPTIONS, ...assumptions, levers: { ...DEFAULT_FLIP_ASSUMPTIONS.levers, ...(assumptions.levers ?? {}) } };
  const H = Math.max(1, Math.round(a.holdMonths));
  const hasPurchasePrice = purchasePriceUsd !== null && Number.isFinite(purchasePriceUsd) && purchasePriceUsd > 0;
  const entryBasis: FlipAnalysis["entryBasis"] = hasPurchasePrice ? "purchase_price" : "multiple_of_base_pv10";

  const notes = {
    assumptions:
      `Entry ${hasPurchasePrice ? `= proposed purchase price $${Math.round(purchasePriceUsd!).toLocaleString("en-US")}` : `= base-scenario as-is PV-10 × ${a.entryMultipleOfPv10.toFixed(2)} (no purchase price supplied)`}; ` +
      `exit = remaining PV-10 at month ${H} × ${a.exitMultipleOfPv10.toFixed(2)} less ${(a.transactionCostPct * 100).toFixed(1)}% transaction cost; ` +
      `optimization capex $${Math.round(a.optimizationCapexUsd).toLocaleString("en-US")}; ` +
      `levers: rate +${a.levers.rateUpliftPct}%, decline -${a.levers.declineReductionPct}%, LOE -${a.levers.loeReductionPct}%, oil differential +$${a.levers.oilDifferentialImprovementUsdBbl}/BBL. ` +
      `Multiples and levers are user-supplied assumptions, not market data or an engineering estimate; defaults model no optimization and no multiple arbitrage.`,
    ownership:
      "Operational levers apply to a working-interest owner with operating control. A mineral or royalty owner cannot change production or cost; that owner's return comes only from the hold cash flow and any gap between the price paid and what the records support.",
    disclaimer:
      "Screening-grade analysis on lease-level public production and generic cost assumptions. Not a reserves report, valuation, or investment advice.",
  };

  const validPrices = priceDeck.source !== "static_fallback" && Object.values(priceDeck.scenarios).every(p => Number.isFinite(p.oilUsdBbl) && p.oilUsdBbl >= 0 && Number.isFinite(p.gasUsdMcf) && p.gasUsdMcf >= 0);
  if (!validPrices) {
    return { schemaVersion: FLIP_SCHEMA_VERSION, sufficientData: false, unavailableReason: "Unavailable: a sourced or explicitly supplied price deck is required; placeholder fallback prices are not valued.", entryBasis, assumptions: a, scenarios: [], leverSensitivity: [], notes };
  }

  const baseAsIs = forecastNetCashFlowSeries(input, priceDeck.scenarios.base);
  if (!baseAsIs.sufficientData) {
    return { schemaVersion: FLIP_SCHEMA_VERSION, sufficientData: false, unavailableReason: baseAsIs.unavailableReason, entryBasis, assumptions: a, scenarios: [], leverSensitivity: [], notes };
  }
  const basePv10AsIs = pv10Slice(baseAsIs.netCashFlowByMonth, 0, Infinity);
  const entryUsd = hasPurchasePrice ? purchasePriceUsd! : basePv10AsIs * a.entryMultipleOfPv10;
  const adjustment = leversToAdjustment(a.levers);

  const scenarios: FlipScenarioResult[] = (["stress", "base", "strip", "upside"] as Scenario[]).map(scenario => {
    const price = priceDeck.scenarios[scenario];
    const asIs = forecastNetCashFlowSeries(input, price).netCashFlowByMonth;
    const opt = forecastNetCashFlowSeries(input, price, adjustment).netCashFlowByMonth;
    return evaluateFlipCashFlows(asIs, opt, scenario, entryUsd, a);
  });

  // Each lever alone, at a disclosed unit step, base scenario, full horizon.
  const steps: Array<{ lever: keyof FlipLevers; label: string; step: string; adj: ForecastAdjustment }> = [
    { lever: "loeReductionPct", label: "LOE reduction", step: "-10% LOE/BOE", adj: { loeMultiplier: 0.9 } },
    { lever: "declineReductionPct", label: "Decline reduction", step: "-10% nominal decline", adj: { declineMultiplier: 0.9 } },
    { lever: "rateUpliftPct", label: "Rate uplift", step: "+10% forecast rate", adj: { rateMultiplier: 1.1 } },
    { lever: "oilDifferentialImprovementUsdBbl", label: "Differential improvement", step: "+$1/BBL realized oil", adj: { oilPriceAdderUsdBbl: 1 } },
  ];
  const leverSensitivity: LeverSensitivity[] = steps.map(s => ({
    lever: s.lever, label: s.label, step: s.step,
    deltaPv10Usd: pv10Slice(forecastNetCashFlowSeries(input, priceDeck.scenarios.base, s.adj).netCashFlowByMonth, 0, Infinity) - basePv10AsIs,
  }));

  return { schemaVersion: FLIP_SCHEMA_VERSION, sufficientData: true, entryBasis, assumptions: a, scenarios, leverSensitivity, notes };
}

/** Shared package/single-asset arithmetic. Inputs are already aligned net cash flows. */
export function evaluateFlipCashFlows(asIs:number[],opt:number[],scenario:Scenario,entryUsd:number,a:FlipAssumptions):FlipScenarioResult {
 const H=Math.max(1,Math.round(a.holdMonths));
    const pv10AsIsUsd = pv10Slice(asIs, 0, Infinity);
    const pv10OptimizedUsd = pv10Slice(opt, 0, Infinity);
    const holdNetCashFlowUsd = sum(opt, 0, H);
    const exitRemainingPv10Usd = pv10Slice(opt, H, Infinity);
    const grossExitUsd = exitRemainingPv10Usd * a.exitMultipleOfPv10;
    const exitProceedsUsd = grossExitUsd - Math.max(0,grossExitUsd) * a.transactionCostPct;
    const outlay = entryUsd + a.optimizationCapexUsd;
    const profitUsd = exitProceedsUsd + holdNetCashFlowUsd - outlay;
    const moic = outlay > 0 ? (exitProceedsUsd + holdNetCashFlowUsd) / outlay : null;
    const holdSeries = opt.slice(0, H);
    while (holdSeries.length < H) holdSeries.push(0);
    holdSeries[H - 1] += exitProceedsUsd;
    const irrSeries=[-outlay,...holdSeries];
    const signs=irrSeries.filter(v=>v!==0).map(v=>Math.sign(v));
    const signChanges=signs.slice(1).filter((sign,i)=>sign!==signs[i]).length;
    // Multiple sign changes can imply multiple IRRs; the existing bisection
    // solver does not establish uniqueness, so do not publish an arbitrary root.
    const irrAnnualPct = signChanges===1 ? solveIrrAnnualPct(irrSeries) : null;
    let payoutMonths: number | null = null;
    let cum = 0;
    for (let t = 0; t < H; t++) { cum += holdSeries[t]; if (cum >= outlay) { payoutMonths = t + 1; break; } }
    return {
      scenario, pv10AsIsUsd, pv10OptimizedUsd, upliftPv10Usd: pv10OptimizedUsd - pv10AsIsUsd,
      entryUsd, holdNetCashFlowUsd, exitRemainingPv10Usd, exitProceedsUsd, capexUsd: a.optimizationCapexUsd,
      profitUsd, moic, irrAnnualPct, payoutMonths, forecastMonths: opt.length, holdCoversFullForecast: opt.length <= H,
    };
}

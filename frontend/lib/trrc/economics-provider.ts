/**
 * EconomicsProvider: the seam between the diligence workflow and whoever
 * forecasts and values the asset.
 *
 * For the prototype, MineralFlow's own decline-curve and cash-flow engine is
 * the provider. A partner's forecast and economics (Novi) plug in behind the
 * same interface: the decision layer and the Decision Record consume an
 * EconomicsResult and never call an engine directly.
 *
 * The prototype provider is pure: the page runs it in the browser so an
 * edited assumption recalculates immediately, and the server runs the same
 * code for the PDF, so the two always agree.
 */
import { forecastNetCashFlowSeries, monthlyDiscountRate, FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH, TX_SEVERANCE_TAX_OIL, TX_SEVERANCE_TAX_GAS, AD_VALOREM_PCT_OF_REVENUE, WORKOVER_RESERVE_USD_PER_BOE, type MonthlyEconomics } from "./economics";
import { fitArpsDeclineWindowed, type DeclineCurveFit } from "./decline-curve";
import { classifyBasin, loeMidpoint } from "./basin-benchmarks";

export type ScenarioName = "downside" | "base" | "upside";
export const SCENARIO_NAMES: ScenarioName[] = ["downside", "base", "upside"];

/** Every input a user can change. Prices are realized at the wellhead before the gas differential. */
export interface EconomicsAssumptions {
  oilPriceUsdBbl: number;
  gasPriceUsdMcf: number;
  /** Subtracted from the gas price (e.g. Waha basis). */
  gasDifferentialUsdMcf: number;
  /** NGL barrels recovered per million cubic feet of gas; 0 for none. */
  nglYieldBblPerMmcf: number;
  nglPriceUsdBbl: number;
  discountRatePct: number;
  oilSeverancePct: number;
  gasSeverancePct: number;
  adValoremPct: number;
  loeUsdPerBoe: number;
  fixedOpexUsdPerWellMonth: number;
  workoverUsdPerBoe: number;
  /** The interest being evaluated. A royalty bears taxes only; a working interest bears costs. */
  interestType: "royalty" | "working";
  netRevenueInterest: number;
  workingInterest: number;
  /** The operator's revenue share, used only to find the lease's economic limit. */
  operatorNri: number;
  downsidePricePct: number;
  upsidePricePct: number;
  holdYears: number;
  /** Optional asking price for the interest, for IRR and payout. */
  askingPriceUsd: number | null;
}

export type AssumptionKey = keyof EconomicsAssumptions;
/** Where each assumption came from, printed beside it. */
export type AssumptionBasis = Record<AssumptionKey, string>;

export interface EconomicsAsset {
  key: string;
  name: string;
  monthlyOilBbl: number[];
  monthlyGasMcf: number[];
  lastReportedMonth: string | null;
  producingWells: number;
  fieldName: string | null;
  county: string | null;
}

export interface AnnualLine { year: number; grossOilBbl: number; grossGasMcf: number; revenue: number; taxes: number; costs: number; net: number }

export interface ScenarioEconomics {
  scenario: ScenarioName;
  oilPriceUsdBbl: number;
  gasPriceUsdMcf: number;
  presentValue: number;
  undiscountedNet: number;
  lifeMonths: number;
  atHorizonCap: boolean;
  netOilBbl: number;
  netGasMcf: number;
  annual: AnnualLine[];
  monthlyNet: number[];
}

export interface EconomicsResult {
  provider: { id: string; name: string; version: string };
  status: "calculated" | "unavailable";
  reason: string | null;
  asset: EconomicsAsset;
  assumptions: EconomicsAssumptions;
  forecast: { phase: "oil" | "gas" | null; fit: DeclineCurveFit | null; windowNote: string | null; remainingGrossOilBbl: number; remainingGrossGasMcf: number };
  scenarios: Record<ScenarioName, ScenarioEconomics> | null;
  disclosures: string[];
}

export interface EconomicsProvider {
  readonly id: string;
  readonly name: string;
  evaluate(asset: EconomicsAsset, assumptions: EconomicsAssumptions): Promise<EconomicsResult>;
}

/** Checks a user's inputs; returns the problems, empty when usable. */
export function validateAssumptions(a: EconomicsAssumptions): string[] {
  const bad: string[] = [];
  const pos = (k: AssumptionKey, label: string) => { if (!(Number(a[k]) > 0)) bad.push(`${label} must be greater than zero.`); };
  const nonneg = (k: AssumptionKey, label: string) => { if (!(Number(a[k]) >= 0) || !Number.isFinite(Number(a[k]))) bad.push(`${label} cannot be negative.`); };
  const frac = (k: AssumptionKey, label: string) => { const v = Number(a[k]); if (!(v >= 0 && v <= 1)) bad.push(`${label} must be a decimal between 0 and 1.`); };
  pos("oilPriceUsdBbl", "Oil price"); pos("gasPriceUsdMcf", "Gas price");
  nonneg("gasDifferentialUsdMcf", "Gas differential"); nonneg("nglYieldBblPerMmcf", "NGL yield"); nonneg("nglPriceUsdBbl", "NGL price");
  if (!(a.discountRatePct >= 0 && a.discountRatePct <= 50)) bad.push("Discount rate must be between 0% and 50%.");
  for (const [k, l] of [["oilSeverancePct", "Oil severance"], ["gasSeverancePct", "Gas severance"], ["adValoremPct", "Ad valorem"]] as const) if (!(a[k] >= 0 && a[k] <= 50)) bad.push(`${l} must be between 0% and 50%.`);
  nonneg("loeUsdPerBoe", "Operating cost"); nonneg("fixedOpexUsdPerWellMonth", "Fixed cost per well"); nonneg("workoverUsdPerBoe", "Workover reserve");
  frac("netRevenueInterest", "Net revenue interest"); frac("operatorNri", "Operator revenue share");
  if (!(a.netRevenueInterest > 0)) bad.push("Net revenue interest must be greater than zero.");
  if (a.interestType === "working") { frac("workingInterest", "Working interest"); if (a.netRevenueInterest > a.workingInterest) bad.push("Net revenue interest cannot exceed the working interest."); }
  if (!(a.downsidePricePct <= 0 && a.downsidePricePct > -100)) bad.push("Downside price change must be between -100% and 0%.");
  if (!(a.upsidePricePct >= 0 && a.upsidePricePct <= 200)) bad.push("Upside price change must be between 0% and 200%.");
  if (!(a.holdYears > 0 && a.holdYears <= 30)) bad.push("Hold period must be between 0 and 30 years.");
  if (a.askingPriceUsd !== null && !(a.askingPriceUsd > 0)) bad.push("Asking price must be greater than zero, or left blank.");
  if (!(a.operatorNri > 0)) bad.push("Operator revenue share must be greater than zero.");
  return bad;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export const mineralFlowPrototypeProvider: EconomicsProvider = {
  id: "mineralflow-prototype",
  name: "MineralFlow prototype engine (Arps decline, monthly cash flow)",
  async evaluate(asset, assumptions) {
    return evaluatePrototype(asset, assumptions);
  },
};

/** Synchronous core, so the browser can recalculate on every keystroke. */
export function evaluatePrototype(asset: EconomicsAsset, a: EconomicsAssumptions): EconomicsResult {
  const provider = { id: mineralFlowPrototypeProvider.id, name: mineralFlowPrototypeProvider.name, version: "1" };
  const phase = asset.monthlyOilBbl.length >= 6 ? "oil" : asset.monthlyGasMcf.length >= 6 ? "gas" : null;
  const window = phase ? fitArpsDeclineWindowed(phase === "oil" ? asset.monthlyOilBbl : asset.monthlyGasMcf) : null;
  const base = { provider, asset, assumptions: a, disclosures: [] as string[] };
  const problems = validateAssumptions(a);
  if (problems.length) return { ...base, status: "unavailable", reason: problems.join(" "), forecast: { phase, fit: window?.fit ?? null, windowNote: window?.reason ?? null, remainingGrossOilBbl: 0, remainingGrossGasMcf: 0 }, scenarios: null };

  const royalty = a.interestType === "royalty";
  const operating = {
    workingInterest: royalty ? 1 : a.workingInterest,
    netRevenueInterest: a.netRevenueInterest,
    variableLoeUsdPerBoe: royalty ? 0 : a.loeUsdPerBoe,
    workoverReserveUsdPerBoe: royalty ? 0 : a.workoverUsdPerBoe,
    adValoremFraction: a.adValoremPct / 100,
    oilSeveranceFraction: a.oilSeverancePct / 100,
    gasSeveranceFraction: a.gasSeverancePct / 100,
  };
  const input = {
    monthlyOilBbl: asset.monthlyOilBbl, monthlyGasMcf: asset.monthlyGasMcf, fieldName: asset.fieldName, county: asset.county,
    nglAndBasis: { nglYieldBblPerMcf: a.nglYieldBblPerMmcf / 1000, nglPriceUsdBbl: a.nglPriceUsdBbl, wahaDifferentialUsdMcf: a.gasDifferentialUsdMcf },
    operating,
    economicLimit: { producingWells: Math.max(1, asset.producingWells), leaseNri: a.operatorNri, fixedFloorUsdPerWellMonth: a.fixedOpexUsdPerWellMonth },
    operatorLoeUsdPerBoe: a.loeUsdPerBoe,
  };
  const r = 1 + monthlyDiscountRate(a.discountRatePct / 100);
  const scenarios = {} as Record<ScenarioName, ScenarioEconomics>;
  let remainingOil = 0, remainingGas = 0;
  for (const s of SCENARIO_NAMES) {
    const factor = 1 + (s === "downside" ? a.downsidePricePct : s === "upside" ? a.upsidePricePct : 0) / 100;
    const price = { oilUsdBbl: a.oilPriceUsdBbl * factor, gasUsdMcf: a.gasPriceUsdMcf * factor };
    const run = forecastNetCashFlowSeries({ ...input, nglAndBasis: { ...input.nglAndBasis, nglPriceUsdBbl: a.nglPriceUsdBbl * factor } }, price);
    if (!run.sufficientData) return { ...base, status: "unavailable", reason: run.unavailableReason ?? "No supported decline forecast.", forecast: { phase, fit: window?.fit ?? null, windowNote: window?.reason ?? null, remainingGrossOilBbl: 0, remainingGrossGasMcf: 0 }, scenarios: null };
    const comps: MonthlyEconomics[] = run.components ?? [];
    const annual: AnnualLine[] = [];
    for (let y = 0; y * 12 < run.netCashFlowByMonth.length; y++) {
      const span = (xs: number[]) => sum(xs.slice(y * 12, y * 12 + 12));
      const c = comps.slice(y * 12, y * 12 + 12);
      annual.push({ year: y + 1, grossOilBbl: span(run.forecastOilByMonth), grossGasMcf: span(run.forecastGasByMonth),
        revenue: sum(c.map(m => m.grossRevenue)), taxes: sum(c.map(m => m.severanceTax + m.adValorem)), costs: sum(c.map(m => m.loe + m.workoverReserve + m.swdDisposal)), net: sum(c.map(m => m.netCashFlow)) });
    }
    if (s === "base") { remainingOil = sum(run.forecastOilByMonth); remainingGas = sum(run.forecastGasByMonth); }
    scenarios[s] = {
      scenario: s, oilPriceUsdBbl: price.oilUsdBbl, gasPriceUsdMcf: price.gasUsdMcf,
      presentValue: run.netCashFlowByMonth.reduce((t, c, i) => t + c / Math.pow(r, i + 1), 0),
      undiscountedNet: sum(run.netCashFlowByMonth), lifeMonths: run.economicLimitMonths ?? run.netCashFlowByMonth.length, atHorizonCap: !!run.economicLimitAtHorizonCap,
      netOilBbl: sum(run.forecastOilByMonth) * a.netRevenueInterest, netGasMcf: sum(run.forecastGasByMonth) * a.netRevenueInterest,
      annual, monthlyNet: run.netCashFlowByMonth,
    };
  }
  const disclosures = [
    "Forecast: Arps decline fitted to reported lease production, switching to 8% a year exponential decline, run to the month the operator's cash flow stops being positive (40-year cap). The interest's income ends there too.",
    royalty ? "The interest is a royalty: it receives its share of revenue less production taxes and bears no operating cost." : "The interest is a working interest: it receives its revenue share and bears its share of operating cost, workover reserve and the fixed cost per producing well.",
    `Downside and upside move oil, gas and NGL prices ${a.downsidePricePct}% and +${a.upsidePricePct}%; costs are held.`,
    "Screening values from lease-level production, not certified reserves or an appraisal.",
  ];
  if (window?.reason) disclosures.push(window.reason);
  return { ...base, status: "calculated", reason: null, disclosures,
    forecast: { phase, fit: window?.fit ?? null, windowNote: window?.reason ?? null, remainingGrossOilBbl: remainingOil, remainingGrossGasMcf: remainingGas }, scenarios };
}

/**
 * Starting assumptions for an asset: live prices, Texas statutory taxes,
 * basin operating cost and MineralFlow standards, each labeled with its
 * basis. The interest defaults to a 0.01 royalty decimal until the user
 * enters the interest being bought.
 */
export function defaultAssumptions(p: {
  oilPriceUsdBbl: number; gasPriceUsdMcf: number; priceBasis: string;
  fieldName: string | null; county: string | null;
  operatorNri: number | null; operatorNriBasis: string | null;
}): { assumptions: EconomicsAssumptions; basis: AssumptionBasis } {
  const basin = classifyBasin(p.fieldName, p.county);
  const loe = basin ? loeMidpoint(basin) : 12;
  const assumptions: EconomicsAssumptions = {
    oilPriceUsdBbl: round2(p.oilPriceUsdBbl), gasPriceUsdMcf: round2(p.gasPriceUsdMcf), gasDifferentialUsdMcf: 0, nglYieldBblPerMmcf: 0, nglPriceUsdBbl: 0,
    discountRatePct: 10, oilSeverancePct: TX_SEVERANCE_TAX_OIL * 100, gasSeverancePct: TX_SEVERANCE_TAX_GAS * 100, adValoremPct: AD_VALOREM_PCT_OF_REVENUE * 100,
    loeUsdPerBoe: loe, fixedOpexUsdPerWellMonth: FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH, workoverUsdPerBoe: WORKOVER_RESERVE_USD_PER_BOE,
    interestType: "royalty", netRevenueInterest: 0.01, workingInterest: 1, operatorNri: p.operatorNri ?? 0.75,
    downsidePricePct: -25, upsidePricePct: 25, holdYears: 3, askingPriceUsd: null,
  };
  const std = "MineralFlow standard";
  const basis: AssumptionBasis = {
    oilPriceUsdBbl: p.priceBasis, gasPriceUsdMcf: p.priceBasis,
    gasDifferentialUsdMcf: "None assumed; enter a basis differential (e.g. Waha)", nglYieldBblPerMmcf: "None assumed; enter a plant yield", nglPriceUsdBbl: "None assumed",
    discountRatePct: `${std} (PV-10)`, oilSeverancePct: "Texas statute, Tax Code §202.052", gasSeverancePct: "Texas statute, Tax Code §201.052", adValoremPct: `${std} estimate`,
    loeUsdPerBoe: basin ? `${basin.name} basin midpoint ($${basin.loeUsdPerBoeRange[0]}–$${basin.loeUsdPerBoeRange[1]}/BOE)` : `${std} generic`,
    fixedOpexUsdPerWellMonth: std, workoverUsdPerBoe: std,
    interestType: "Example; set the interest being bought", netRevenueInterest: "Example 0.01 decimal; set the interest being bought", workingInterest: "Applies to a working interest only",
    operatorNri: p.operatorNriBasis ?? `${std} (0.75)`, downsidePricePct: std, upsidePricePct: std, holdYears: std, askingPriceUsd: "Not supplied",
  };
  return { assumptions, basis };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

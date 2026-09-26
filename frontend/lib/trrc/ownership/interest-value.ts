/**
 * What each owner's interest in a lease is worth, from the lease forecast,
 * the price deck and the owner's decimal on the roll.
 *
 * Royalty and overriding royalty bear production taxes only: one full
 * decimal of a tract is worth the tract's share of lease revenue less taxes.
 * The working interest of a tract bears all operating cost and receives that
 * tract's working-interest decimal; each holder's value is their share of it.
 *
 * The forecast runs to the lease's economic limit — the month the operator's
 * cash flow, with a fixed floor per producing well, stops being positive —
 * which ends royalty income as well. Every figure is PV-10 / PV-15 of a
 * screening forecast: not certified reserves, not an appraisal.
 */
import { forecastNetCashFlowSeries, monthlyDiscountRate, FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH } from "../economics";
import type { PriceDeck } from "../eia-pricing";
import type { LeaseOwnership, InterestType } from "./mineral-roll";

export const TX_OIL_SEVERANCE = 0.046;
export const TX_GAS_SEVERANCE = 0.075;
export const AD_VALOREM = 0.02;
export const WORKOVER_USD_PER_BOE = 2;
/** Used for the economic limit only when the roll carries no working-interest decimal. */
export const DEFAULT_LEASE_NRI = 0.75;
export const SCENARIOS = ["stress", "base", "upside"] as const;
export type Scenario = typeof SCENARIOS[number];
export type ByScenario = Record<Scenario, number>;

export interface OwnerValue {
  ownerName: string; interestType: InterestType; decimal: number; cadLeaseNumber: string | null;
  pv10: ByScenario | null; pv15: ByScenario | null;
}

export interface InterestValuation {
  status: "valued" | "unavailable";
  reason: string | null;
  priceBasis: string;
  loeUsdPerBoe: number | null;
  producingWells: number;
  leaseNri: number | null;
  leaseNriBasis: string | null;
  economicLimitMonths: ByScenario | null;
  /** True when base-case production was still economic at the 40-year forecast cap. */
  economicLimitAtHorizonCap: boolean;
  /** PV of one full (1.0) cost-free decimal of the WHOLE lease. */
  royaltyUnitPv10: ByScenario | null;
  royaltyUnitPv15: ByScenario | null;
  /** PV of the whole lease's working interest at leaseNri. */
  workingInterestPv10: ByScenario | null;
  workingInterestPv15: ByScenario | null;
  /** Base-case monthly lease volumes to the economic limit. */
  baseForecast: { oilBbl: number[]; gasMcf: number[] } | null;
  remainingOilBbl: number | null;
  remainingGasMcf: number | null;
  owners: OwnerValue[];
  totalsPv10: ByScenario | null;
}

const pv = (cf: number[], rate: number) => { const r = monthlyDiscountRate(rate); return cf.reduce((s, c, i) => s + c / Math.pow(1 + r, i + 1), 0); };
const each = (f: (s: Scenario) => number): ByScenario => ({ stress: f("stress"), base: f("base"), upside: f("upside") });

export function valueLeaseInterests(
  ownership: LeaseOwnership,
  series: { monthlyOilBbl: number[]; monthlyGasMcf: number[]; fieldName?: string | null; county?: string | null },
  deck: PriceDeck,
  producingWells = 1,
  /** A supplied operating cost per BOE; the basin midpoint otherwise. */
  loeOverrideUsdPerBoe: number | null = null,
): InterestValuation {
  const priceBasis = `${deck.source === "eia_live" ? (deck.fromSnapshot ? `EIA (retrieved ${String(deck.retrievedAt).slice(0, 10)})` : "Live EIA") : deck.source === "user_input" ? "Supplied" : "Placeholder"} price deck as of ${deck.asOf}`;
  const wells = Math.max(1, Math.round(producingWells));
  const none = (reason: string): InterestValuation => ({ status: "unavailable", reason, priceBasis, loeUsdPerBoe: null, producingWells: wells, leaseNri: null, leaseNriBasis: null,
    economicLimitMonths: null, economicLimitAtHorizonCap: false, royaltyUnitPv10: null, royaltyUnitPv15: null, workingInterestPv10: null, workingInterestPv15: null, baseForecast: null, remainingOilBbl: null, remainingGasMcf: null,
    owners: ownership.owners.map(o => ({ ownerName: o.ownerName, interestType: o.interestType, decimal: o.decimal, cadLeaseNumber: o.cadLeaseNumber, pv10: null, pv15: null })), totalsPv10: null });
  if (ownership.status !== "matched") return none(ownership.reason ?? "No owners were matched on the mineral roll.");
  if (deck.source === "static_fallback") return none("A sourced or explicitly supplied price deck is required; placeholder prices are not valued.");

  // The operator's revenue share, for the economic limit: the production-
  // weighted working-interest decimal across tracts.
  const wiTracts = ownership.tracts.filter(t => t.totals.working_interest > 0 && t.totals.working_interest <= 1);
  const wiShare = wiTracts.reduce((s, t) => s + t.productionShare, 0);
  const leaseNri = wiShare > 0 ? wiTracts.reduce((s, t) => s + t.totals.working_interest * t.productionShare, 0) / wiShare : DEFAULT_LEASE_NRI;
  const leaseNriBasis = wiShare > 0 ? "Combined working-interest decimal on the roll, weighted by tract." : `No working-interest decimal on the roll; a standard ${DEFAULT_LEASE_NRI} is used for the economic limit.`;

  const taxes = { adValoremFraction: AD_VALOREM, oilSeveranceFraction: TX_OIL_SEVERANCE, gasSeveranceFraction: TX_GAS_SEVERANCE };
  const base = { monthlyOilBbl: series.monthlyOilBbl, monthlyGasMcf: series.monthlyGasMcf, fieldName: series.fieldName ?? null, county: series.county ?? null,
    economicLimit: { producingWells: wells, leaseNri, fixedFloorUsdPerWellMonth: FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH } };

  const royalty = each(() => 0), royalty15 = each(() => 0), wiLease = each(() => 0), wiLease15 = each(() => 0), limitMonths = each(() => 0);
  let baseForecast: InterestValuation["baseForecast"] = null;
  // A royalty call carries no cost of its own; the operator's cost still sets the economic limit.
  const royaltyLoe = { variableLoeUsdPerBoe: 0 };
  let loe: number | null = null, remainingOil = 0, remainingGas = 0, atCap = false;
  const wiByNri = new Map<number, ByScenario>();
  for (const s of SCENARIOS) {
    const r = forecastNetCashFlowSeries({ ...base, operatorLoeUsdPerBoe: loeOverrideUsdPerBoe, operating: { workingInterest: 1, netRevenueInterest: 1, ...royaltyLoe, workoverReserveUsdPerBoe: 0, ...taxes } }, deck.scenarios[s]);
    if (!r.sufficientData) return none(r.unavailableReason ?? "No supported lease forecast.");
    royalty[s] = pv(r.netCashFlowByMonth, 0.10); royalty15[s] = pv(r.netCashFlowByMonth, 0.15);
    limitMonths[s] = r.economicLimitMonths ?? r.netCashFlowByMonth.length;
    if (s === "base") { loe = r.operatorLoeUsdPerBoe ?? null; atCap = !!r.economicLimitAtHorizonCap; baseForecast = { oilBbl: r.forecastOilByMonth, gasMcf: r.forecastGasByMonth }; remainingOil = r.forecastOilByMonth.reduce((a, b) => a + b, 0); remainingGas = r.forecastGasByMonth.reduce((a, b) => a + b, 0); }
    if (!(r.operatorLoeUsdPerBoe! > 0)) return none("No operating cost basis was available for the working interest.");
    const wi = forecastNetCashFlowSeries({ ...base, operating: { workingInterest: 1, netRevenueInterest: leaseNri, variableLoeUsdPerBoe: r.operatorLoeUsdPerBoe!, workoverReserveUsdPerBoe: WORKOVER_USD_PER_BOE, ...taxes } }, deck.scenarios[s]);
    wiLease[s] = pv(wi.netCashFlowByMonth, 0.10); wiLease15[s] = pv(wi.netCashFlowByMonth, 0.15);
  }
  if (!(remainingOil + remainingGas > 0)) return none("The lease is at its economic limit: at current rates and the stated costs no forecast volume remains to value.");

  // A tract's working interest is valued at that tract's own decimal.
  const wiAt = (nri: number): ByScenario => {
    const k = Math.round(nri * 1e6) / 1e6;
    if (!wiByNri.has(k)) wiByNri.set(k, each(s => pv(forecastNetCashFlowSeries({ ...base, operating: { workingInterest: 1, netRevenueInterest: Math.min(1, Math.max(0.0001, k)), variableLoeUsdPerBoe: loe!, workoverReserveUsdPerBoe: WORKOVER_USD_PER_BOE, ...taxes } }, deck.scenarios[s]).netCashFlowByMonth, 0.10)));
    return wiByNri.get(k)!;
  };
  const shareOf = new Map(ownership.tracts.map(t => [t.cadLeaseNumber, t]));
  const owners: OwnerValue[] = ownership.owners.map(o => {
    const t = shareOf.get(o.cadLeaseNumber);
    const share = t?.productionShare ?? 0;
    let v10: ByScenario | null = null, v15: ByScenario | null = null;
    if (o.interestType === "royalty" || o.interestType === "overriding_royalty") {
      v10 = each(s => royalty[s] * share * o.decimal); v15 = each(s => royalty15[s] * share * o.decimal);
    } else if (o.interestType === "working_interest" && t && t.totals.working_interest > 0) {
      const w = wiAt(t.totals.working_interest), frac = o.decimal / t.totals.working_interest;
      v10 = each(s => w[s] * share * frac); v15 = null;
    }
    return { ownerName: o.ownerName, interestType: o.interestType, decimal: o.decimal, cadLeaseNumber: o.cadLeaseNumber, pv10: v10, pv15: v15 };
  });
  return { status: "valued", reason: null, priceBasis, loeUsdPerBoe: loe, producingWells: wells, leaseNri, leaseNriBasis, economicLimitMonths: limitMonths, economicLimitAtHorizonCap: atCap,
    royaltyUnitPv10: royalty, royaltyUnitPv15: royalty15, workingInterestPv10: wiLease, workingInterestPv15: wiLease15, baseForecast, remainingOilBbl: remainingOil, remainingGasMcf: remainingGas,
    owners, totalsPv10: each(s => owners.reduce((a, o) => a + (o.pv10?.[s] ?? 0), 0)) };
}

/**
 * Producing wells for the economic limit, from TRRC's oil proration schedule:
 * wells carried as producing. Shut-in and temporarily abandoned wells carry
 * no operating cost floor. At least one: the lease is reporting production.
 */
export function producingWellCount(prorationWells: unknown[]): { count: number; basis: string } {
  const wells = prorationWells.filter((w): w is Record<string, unknown> => !!w && typeof w === "object");
  if (!wells.length) return { count: 1, basis: "TRRC's oil proration schedule was not retrieved for this lease; one producing well is assumed." };
  const withStatus = wells.filter(w => typeof w.status === "string" && w.status.trim());
  if (!withStatus.length) return { count: Math.max(1, wells.length), basis: `${wells.length} well(s) on TRRC's oil proration schedule; producing status not carried.` };
  const producing = withStatus.filter(w => /PRODUC/i.test(String(w.status))).length;
  return { count: Math.max(1, producing), basis: `${producing} of ${wells.length} well(s) on TRRC's oil proration schedule are carried as producing${producing ? "" : "; one is assumed because the lease reports production"}.` };
}

/**
 * Decision step: what each owner's interest in the lease is worth, from the
 * lease forecast, the sourced price deck and the owner's decimal on the roll.
 *
 * Royalty and overriding royalty bear no operating cost: one full decimal is
 * worth the lease's revenue less production taxes, so an owner's value is
 * that unit value times their decimal. The working interest as a whole bears
 * 100% of costs and receives the roll's combined working-interest decimal;
 * each holder's value is their share of that. Every figure is PV-10 of the
 * screening forecast — not certified reserves, not an appraisal.
 */
import { forecastNetCashFlowSeries, monthlyDiscountRate } from "../economics";
import type { PriceDeck } from "../eia-pricing";
import type { LeaseOwnership, InterestType } from "./mineral-roll";

export const TX_OIL_SEVERANCE = 0.046;
export const TX_GAS_SEVERANCE = 0.075;
export const AD_VALOREM = 0.02;
const WORKOVER_USD_PER_BOE = 2;
const SCENARIOS = ["stress", "base", "upside"] as const;
type Scenario = typeof SCENARIOS[number];

export interface InterestValuation {
  status: "valued" | "unavailable";
  reason: string | null;
  priceBasis: string;
  loeUsdPerBoe: number | null;
  /** PV-10 of one full (1.0) cost-free decimal, per scenario. */
  royaltyUnitPv10: Record<Scenario, number> | null;
  /** PV-10 of the whole working interest (bears all costs, receives the roll's WI decimal), per scenario. */
  workingInterestPv10: Record<Scenario, number> | null;
  owners: Array<{ ownerName: string; interestType: InterestType; decimal: number; pv10: Record<Scenario, number> | null }>;
  totalsPv10: Record<Scenario, number> | null;
}

const pv10 = (cf: number[]) => { const r = monthlyDiscountRate(0.10); return cf.reduce((s, c, i) => s + c / Math.pow(1 + r, i + 1), 0); };

export function valueLeaseInterests(ownership: LeaseOwnership, series: { monthlyOilBbl: number[]; monthlyGasMcf: number[]; fieldName?: string | null; county?: string | null }, deck: PriceDeck): InterestValuation {
  const priceBasis = `${deck.source === "eia_live" ? "Live EIA" : deck.source === "user_input" ? "Supplied" : "Placeholder"} price deck as of ${deck.asOf}`;
  const none = (reason: string): InterestValuation => ({ status: "unavailable", reason, priceBasis, loeUsdPerBoe: null, royaltyUnitPv10: null, workingInterestPv10: null,
    owners: ownership.owners.map(o => ({ ownerName: o.ownerName, interestType: o.interestType, decimal: o.decimal, pv10: null })), totalsPv10: null });
  if (ownership.status !== "matched") return none(ownership.reason ?? "No owners were matched on the mineral roll.");
  if (deck.source === "static_fallback") return none("A sourced or explicitly supplied price deck is required; placeholder prices are not valued.");

  const taxes = { adValoremFraction: AD_VALOREM, oilSeveranceFraction: TX_OIL_SEVERANCE, gasSeveranceFraction: TX_GAS_SEVERANCE };
  const base = { monthlyOilBbl: series.monthlyOilBbl, monthlyGasMcf: series.monthlyGasMcf, fieldName: series.fieldName ?? null, county: series.county ?? null };
  const probe = forecastNetCashFlowSeries(base, deck.scenarios.base);
  if (!probe.sufficientData) return none(probe.unavailableReason ?? "No supported lease forecast.");
  // The forecast stops at the model's fixed 150 bbl/month terminal rate. A
  // lease already producing below it (Shockley "3", Martin: 40-110 bbl/month
  // and still covering its costs) gets no forecast months, which would print
  // every interest at $0. Say why instead of reporting a false zero.
  const remaining = probe.forecastOilByMonth.reduce((a, b) => a + b, 0) + probe.forecastGasByMonth.reduce((a, b) => a + b, 0);
  if (!(remaining > 0)) return none("The lease is producing below the forecast model's 150 bbl/month terminal rate, so no forecast volume remains to value. This is a model limit for low-rate leases, not evidence that the interests are worthless.");
  const loe = probe.loeUsdPerBoe;
  const wiDecimal = ownership.totals.working_interest;

  const royaltyUnitPv10 = {} as Record<Scenario, number>, workingInterestPv10 = {} as Record<Scenario, number>;
  for (const s of SCENARIOS) {
    const price = deck.scenarios[s];
    royaltyUnitPv10[s] = pv10(forecastNetCashFlowSeries({ ...base, operating: { workingInterest: 1, netRevenueInterest: 1, variableLoeUsdPerBoe: 0, workoverReserveUsdPerBoe: 0, ...taxes } }, price).netCashFlowByMonth);
    workingInterestPv10[s] = wiDecimal > 0 && wiDecimal <= 1
      ? pv10(forecastNetCashFlowSeries({ ...base, operating: { workingInterest: 1, netRevenueInterest: wiDecimal, variableLoeUsdPerBoe: loe, workoverReserveUsdPerBoe: WORKOVER_USD_PER_BOE, ...taxes } }, price).netCashFlowByMonth)
      : NaN;
  }
  const owners = ownership.owners.map(o => {
    const pv = {} as Record<Scenario, number>;
    for (const s of SCENARIOS) {
      pv[s] = o.interestType === "working_interest"
        ? (Number.isFinite(workingInterestPv10[s]) && wiDecimal > 0 ? workingInterestPv10[s] * (o.decimal / wiDecimal) : NaN)
        : o.interestType === "unknown" ? NaN : royaltyUnitPv10[s] * o.decimal;
    }
    return { ownerName: o.ownerName, interestType: o.interestType, decimal: o.decimal, pv10: SCENARIOS.every(s => Number.isFinite(pv[s])) ? pv : null };
  });
  const totalsPv10 = {} as Record<Scenario, number>;
  for (const s of SCENARIOS) totalsPv10[s] = owners.reduce((t, o) => t + (o.pv10?.[s] ?? 0), 0);
  return { status: "valued", reason: null, priceBasis, loeUsdPerBoe: loe,
    royaltyUnitPv10, workingInterestPv10: SCENARIOS.every(s => Number.isFinite(workingInterestPv10[s])) ? workingInterestPv10 : null, owners, totalsPv10 };
}

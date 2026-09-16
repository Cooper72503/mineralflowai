import { describe, it, expect } from "vitest";
import { computeFlipAnalysis, DEFAULT_FLIP_ASSUMPTIONS, solveIrrAnnualPct } from "../flip";
import { computeEconomics, forecastNetCashFlowSeries } from "../economics";
import type { PriceDeck } from "../eia-pricing";

// Same known-exact Arps generator the economics/decline tests use, so the
// fit is a verifiable curve and the flip arithmetic can be checked against
// closed-form identities rather than "did it run."
function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  return out;
}
const OIL = generateCurve(3000, 0.08, 0.9, 36).map(v => Math.round(v));
const NO_GAS = OIL.map(() => 0);

// Real lease-level TRRC production for lease 10289 / district 8A (TAYLOR,
// W. J. "A", Gaines County), retrieved in production run ba9aaacb on
// 2026-09-14. Its last twelve months RISE (710 → 1,389 BBL/mo), so no
// decline fit exists — kept here as the real "cannot be valued" case.
const TAYLOR_OIL = [443, 600, 661, 0, 195, 599, 33, 328, 908, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 581, 0, 0, 0, 0, 0, 0, 0, 0, 0, 710, 850, 950, 1055, 950, 1050, 1145, 1220, 1220, 1310, 1389];

const deck = (oil: number, gas = 3): PriceDeck => ({
  source: "user_input", asOf: "test", wtiSpotUsdBbl: oil, henryHubUsdMcf: gas,
  scenarios: { stress: { oilUsdBbl: oil * 0.8, gasUsdMcf: gas }, base: { oilUsdBbl: oil, gasUsdMcf: gas }, strip: { oilUsdBbl: oil, gasUsdMcf: gas }, upside: { oilUsdBbl: oil * 1.2, gasUsdMcf: gas } },
});
const input = { monthlyOilBbl: OIL, monthlyGasMcf: NO_GAS, fieldName: "O D C (DEVONIAN)", county: "GAINES" };

describe("forecastNetCashFlowSeries — consistency with computeEconomics", () => {
  it("with no adjustment, PV-10 of the series equals computeEconomics' base PV-10 exactly", () => {
    const econ = computeEconomics(OIL, NO_GAS, deck(70), "O D C (DEVONIAN)", "GAINES");
    const series = forecastNetCashFlowSeries(input, deck(70).scenarios.base);
    const r = Math.pow(1.10, 1 / 12) - 1;
    const pv10 = series.netCashFlowByMonth.reduce((acc, v, i) => acc + v / Math.pow(1 + r, i + 1), 0);
    expect(econ.sufficientData).toBe(true);
    expect(pv10).toBeCloseTo(econ.offerRangeMid!, 6);
  });

  it("adjustments move the series in the expected direction", () => {
    const base = forecastNetCashFlowSeries(input, deck(70).scenarios.base).netCashFlowByMonth;
    const total = (cf: number[]) => cf.reduce((a, b) => a + b, 0);
    expect(total(forecastNetCashFlowSeries(input, deck(70).scenarios.base, { rateMultiplier: 1.1 }).netCashFlowByMonth)).toBeGreaterThan(total(base));
    expect(total(forecastNetCashFlowSeries(input, deck(70).scenarios.base, { loeMultiplier: 0.9 }).netCashFlowByMonth)).toBeGreaterThan(total(base));
    expect(total(forecastNetCashFlowSeries(input, deck(70).scenarios.base, { oilPriceAdderUsdBbl: 1 }).netCashFlowByMonth)).toBeGreaterThan(total(base));
    expect(total(forecastNetCashFlowSeries(input, deck(70).scenarios.base, { declineMultiplier: 0.9 }).netCashFlowByMonth)).toBeGreaterThan(total(base));
  });
});

describe("computeFlipAnalysis", () => {
  it("with default assumptions models NO optimization: uplift is zero and entry = as-is PV-10 × 1.0", () => {
    const f = computeFlipAnalysis(input, deck(70), null);
    expect(f.sufficientData).toBe(true);
    expect(f.entryBasis).toBe("multiple_of_base_pv10");
    const base = f.scenarios.find(s => s.scenario === "base")!;
    expect(base.upliftPv10Usd).toBeCloseTo(0, 6);
    expect(base.entryUsd).toBeCloseTo(base.pv10AsIsUsd, 6);
  });

  it("identity: hold cash flow + remaining PV-10 at exit, re-discounted, reproduces full-horizon PV-10", () => {
    // PV10(all) = PV10(months 1..H) + PV10(months H+1..N discounted to H) / (1+r)^H
    const f = computeFlipAnalysis(input, deck(70), null, { ...DEFAULT_FLIP_ASSUMPTIONS, holdMonths: 24 });
    const base = f.scenarios.find(s => s.scenario === "base")!;
    const cf = forecastNetCashFlowSeries(input, deck(70).scenarios.base).netCashFlowByMonth;
    const r = Math.pow(1.10, 1 / 12) - 1;
    const pvHold = cf.slice(0, 24).reduce((acc, v, i) => acc + v / Math.pow(1 + r, i + 1), 0);
    expect(pvHold + base.exitRemainingPv10Usd / Math.pow(1 + r, 24)).toBeCloseTo(base.pv10AsIsUsd, 4);
  });

  it("uses the proposed purchase price as entry when supplied, and the multiple otherwise", () => {
    const withPrice = computeFlipAnalysis(input, deck(70), 250_000);
    expect(withPrice.entryBasis).toBe("purchase_price");
    expect(withPrice.scenarios[0].entryUsd).toBe(250_000);
    const withMult = computeFlipAnalysis(input, deck(70), null, { ...DEFAULT_FLIP_ASSUMPTIONS, entryMultipleOfPv10: 0.8 });
    const base = withMult.scenarios.find(s => s.scenario === "base")!;
    expect(base.entryUsd).toBeCloseTo(base.pv10AsIsUsd * 0.8, 6);
  });

  it("levers raise optimized PV-10 above as-is; capex and transaction cost reduce profit; exit multiple scales proceeds", () => {
    const levers = { rateUpliftPct: 10, declineReductionPct: 10, loeReductionPct: 10, oilDifferentialImprovementUsdBbl: 1 };
    const f = computeFlipAnalysis(input, deck(70), 250_000, { ...DEFAULT_FLIP_ASSUMPTIONS, levers, optimizationCapexUsd: 50_000, transactionCostPct: 0.03, exitMultipleOfPv10: 0.9 });
    const base = f.scenarios.find(s => s.scenario === "base")!;
    expect(base.upliftPv10Usd).toBeGreaterThan(0);
    expect(base.exitProceedsUsd).toBeCloseTo(base.exitRemainingPv10Usd * 0.9 * 0.97, 6);
    expect(base.profitUsd).toBeCloseTo(base.exitProceedsUsd + base.holdNetCashFlowUsd - 250_000 - 50_000, 6);
    expect(base.moic).toBeCloseTo((base.exitProceedsUsd + base.holdNetCashFlowUsd) / 300_000, 6);
  });

  it("returns null IRR/payout rather than a number when the position never recoups", () => {
    const f = computeFlipAnalysis(input, deck(70), 50_000_000); // absurd entry price
    const base = f.scenarios.find(s => s.scenario === "base")!;
    expect(base.irrAnnualPct).toBeNull();
    expect(base.payoutMonths).toBeNull();
    expect(base.profitUsd).toBeLessThan(0);
  });

  it("lever sensitivity: each unit step alone yields a positive ΔPV-10 on the base scenario", () => {
    const f = computeFlipAnalysis(input, deck(70), null);
    expect(f.leverSensitivity).toHaveLength(4);
    for (const l of f.leverSensitivity) expect(l.deltaPv10Usd).toBeGreaterThan(0);
  });

  it("refuses to value against the static fallback price deck", () => {
    const f = computeFlipAnalysis(input, { ...deck(70), source: "static_fallback" }, null);
    expect(f.sufficientData).toBe(false);
    expect(f.unavailableReason).toContain("placeholder");
    expect(f.scenarios).toEqual([]);
  });

  it("reports insufficient data — not a number — for the real Taylor lease, whose production is rising and cannot be decline-fit", () => {
    const f = computeFlipAnalysis({ monthlyOilBbl: TAYLOR_OIL, monthlyGasMcf: TAYLOR_OIL.map(() => 0), fieldName: "O D C (DEVONIAN)", county: "GAINES" }, deck(70), 250_000);
    expect(f.sufficientData).toBe(false);
    expect(f.unavailableReason).toContain("Insufficient data");
    expect(f.scenarios).toEqual([]);
    expect(f.leverSensitivity).toEqual([]);
  });

  it("the ownership note states that a non-operating owner cannot pull operational levers", () => {
    const f = computeFlipAnalysis(input, deck(70), null);
    expect(f.notes.ownership).toMatch(/mineral or royalty owner cannot/i);
  });
});

describe("solveIrrAnnualPct", () => {
  it("recovers a known monthly rate: −100 then 12 × 10 → annualized IRR of a 1.6%/mo series", () => {
    const irr = solveIrrAnnualPct([-100, ...Array(12).fill(10)]);
    expect(irr).not.toBeNull();
    // 12 payments of 10 on 100: monthly IRR ≈ 2.92%, annualized ≈ 41.3%
    expect(irr!).toBeGreaterThan(40);
    expect(irr!).toBeLessThan(43);
  });
  it("returns null when total inflows never exceed the outlay", () => {
    expect(solveIrrAnnualPct([-100, 10, 10])).toBeNull();
  });
});

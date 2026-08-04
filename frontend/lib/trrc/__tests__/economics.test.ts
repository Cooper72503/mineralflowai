import { describe, it, expect } from "vitest";
import { computeEconomics, TX_SEVERANCE_TAX_OIL, TX_SEVERANCE_TAX_GAS, DEFAULT_LOE_USD_PER_BOE } from "../economics";
import type { PriceDeck } from "../eia-pricing";

// Same synthetic-curve generator as decline-curve.test.ts, so the fit these
// tests exercise is a known, verifiable Arps curve, not noisy real data.
function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) {
    out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  }
  return out;
}

const flatPriceDeck: PriceDeck = {
  source: "static_fallback",
  asOf: "test-fixture",
  wtiSpotUsdBbl: 70,
  henryHubUsdMcf: 3,
  scenarios: {
    stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 },
    base: { oilUsdBbl: 70, gasUsdMcf: 3 },
    strip: { oilUsdBbl: 70, gasUsdMcf: 3 },
    upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 },
  },
};

describe("computeEconomics — insufficient data", () => {
  it("reports sufficientData:false and zeroed offer range when neither oil nor gas can be fit", () => {
    const result = computeEconomics([100, 90, 80], [], flatPriceDeck);
    expect(result.sufficientData).toBe(false);
    expect(result.scenarios).toEqual([]);
    expect(result.offerRangeLow).toBe(0);
    expect(result.offerRangeMid).toBe(0);
    expect(result.offerRangeHigh).toBe(0);
  });
});

describe("computeEconomics — a real oil-only decline", () => {
  const oilSeries = generateCurve(3000, 0.05, 0.9, 36);
  const result = computeEconomics(oilSeries, [], flatPriceDeck);

  it("computes sufficient data and four scenarios", () => {
    expect(result.sufficientData).toBe(true);
    expect(result.scenarios).toHaveLength(4);
    expect(result.scenarios.map(s => s.scenario).sort()).toEqual(["base", "stress", "strip", "upside"]);
  });

  it("orders the offer range low <= mid <= high, matching stress <= base <= upside pricing", () => {
    expect(result.offerRangeLow).toBeLessThanOrEqual(result.offerRangeMid);
    expect(result.offerRangeMid).toBeLessThanOrEqual(result.offerRangeHigh);
  });

  it("PV-10 is always >= PV-15 for a positive cash flow stream (a higher discount rate discounts more)", () => {
    for (const s of result.scenarios) {
      if (s.netCashFlow > 0) {
        expect(s.pv10).toBeGreaterThanOrEqual(s.pv15);
      }
    }
  });

  it("gross revenue minus severance tax minus LOE equals net cash flow, for every scenario", () => {
    for (const s of result.scenarios) {
      expect(s.netCashFlow).toBeCloseTo(s.grossRevenue - s.severanceTax - s.loe, 4);
    }
  });

  it("severance tax on the base scenario is a plausible fraction of gross revenue, bounded by the statutory oil rate", () => {
    const base = result.scenarios.find(s => s.scenario === "base")!;
    // Oil-only series, so effective rate should sit at (or very near) the statutory oil rate.
    expect(base.severanceTax / base.grossRevenue).toBeCloseTo(TX_SEVERANCE_TAX_OIL, 2);
  });

  it("always leaves IRR and payout null with a disclosure explaining why", () => {
    expect(result.irr).toBeNull();
    expect(result.payoutMonths).toBeNull();
    expect(result.irrPayoutNote).toMatch(/purchase price/i);
  });

  it("discloses both the severance tax rates and the ad-valorem exclusion in the cost note", () => {
    expect(result.costAssumptionNote).toContain(`${(TX_SEVERANCE_TAX_OIL * 100).toFixed(1)}%`);
    expect(result.costAssumptionNote).toContain(`${(TX_SEVERANCE_TAX_GAS * 100).toFixed(1)}%`);
    expect(result.costAssumptionNote).toContain(`$${DEFAULT_LOE_USD_PER_BOE}`);
    expect(result.costAssumptionNote).toMatch(/ad valorem.*not included/i);
  });
});

describe("computeEconomics — an oil+gas well blends both severance tax rates", () => {
  it("effective severance rate sits between the pure-oil and pure-gas statutory rates when both streams contribute revenue", () => {
    const oilSeries = generateCurve(2000, 0.04, 0.8, 36);
    const gasSeries = generateCurve(8000, 0.04, 0.8, 36); // meaningful associated/non-associated gas stream
    const result = computeEconomics(oilSeries, gasSeries, flatPriceDeck);
    const base = result.scenarios.find(s => s.scenario === "base")!;
    const effectiveRate = base.severanceTax / base.grossRevenue;
    expect(effectiveRate).toBeGreaterThanOrEqual(TX_SEVERANCE_TAX_OIL - 0.001);
    expect(effectiveRate).toBeLessThanOrEqual(TX_SEVERANCE_TAX_GAS + 0.001);
  });
});

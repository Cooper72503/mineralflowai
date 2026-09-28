import { describe, it, expect } from "vitest";
import { evaluatePrototype, defaultAssumptions, validateAssumptions, mineralFlowPrototypeProvider, type EconomicsAsset } from "../economics-provider";
import { valueLeaseInterests } from "../ownership/interest-value";
import type { LeaseOwnership } from "../ownership/mineral-roll";
import type { PriceDeck } from "../eia-pricing";

const oil = Array.from({ length: 30 }, (_, i) => 12000 * Math.pow(1 + 0.7 * 0.08 * i, -1 / 0.7));
const gas = oil.map(o => o * 4);
const asset: EconomicsAsset = { key: "TX:8:O:1", name: "TEST", monthlyOilBbl: oil, monthlyGasMcf: gas, lastReportedMonth: "2026-07", producingWells: 4, fieldName: "SPRABERRY (TREND AREA)", county: "MIDLAND" };
const start = defaultAssumptions({ oilPriceUsdBbl: 80, gasPriceUsdMcf: 3, priceBasis: "test deck", fieldName: asset.fieldName, county: asset.county, operatorNri: 0.75, operatorNriBasis: null });

describe("MineralFlow prototype provider", () => {
  it("values the interest under three price cases, ordered", () => {
    const r = evaluatePrototype(asset, start.assumptions);
    expect(r.status).toBe("calculated");
    const s = r.scenarios!;
    expect(s.downside.presentValue).toBeLessThan(s.base.presentValue);
    expect(s.base.presentValue).toBeLessThan(s.upside.presentValue);
    expect(s.base.annual[0].net).toBeCloseTo(s.base.annual[0].revenue - s.base.annual[0].taxes - s.base.annual[0].costs, 6);
  });

  it("scales a royalty linearly with its decimal and recalculates on a price change", () => {
    const a = evaluatePrototype(asset, { ...start.assumptions, netRevenueInterest: 0.01 }).scenarios!.base.presentValue;
    const b = evaluatePrototype(asset, { ...start.assumptions, netRevenueInterest: 0.02 }).scenarios!.base.presentValue;
    expect(b).toBeCloseTo(a * 2, 6);
    const higher = evaluatePrototype(asset, { ...start.assumptions, oilPriceUsdBbl: 90 }).scenarios!.base.presentValue;
    expect(higher).toBeGreaterThan(a);
  });

  it("charges a working interest its costs and a royalty none", () => {
    const royalty = evaluatePrototype(asset, { ...start.assumptions, netRevenueInterest: 0.75 }).scenarios!.base;
    const working = evaluatePrototype(asset, { ...start.assumptions, interestType: "working", workingInterest: 1, netRevenueInterest: 0.75 }).scenarios!.base;
    expect(royalty.annual[0].costs).toBe(0);
    expect(working.annual[0].costs).toBeGreaterThan(0);
    expect(working.presentValue).toBeLessThan(royalty.presentValue);
  });

  it("adds NGL revenue and subtracts a gas differential", () => {
    const plain = evaluatePrototype(asset, start.assumptions).scenarios!.base.presentValue;
    expect(evaluatePrototype(asset, { ...start.assumptions, nglYieldBblPerMmcf: 100, nglPriceUsdBbl: 25 }).scenarios!.base.presentValue).toBeGreaterThan(plain);
    expect(evaluatePrototype(asset, { ...start.assumptions, gasDifferentialUsdMcf: 1 }).scenarios!.base.presentValue).toBeLessThan(plain);
  });

  it("uses the discount rate", () => {
    const at10 = evaluatePrototype(asset, start.assumptions).scenarios!.base.presentValue;
    expect(evaluatePrototype(asset, { ...start.assumptions, discountRatePct: 15 }).scenarios!.base.presentValue).toBeLessThan(at10);
  });

  it("agrees with the existing lease valuation engine under the same assumptions", () => {
    const deck = { source: "eia_live", asOf: "t", wtiSpotUsdBbl: 80, henryHubUsdMcf: 3, scenarios: { stress: { oilUsdBbl: 60, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 80, gasUsdMcf: 3 }, strip: { oilUsdBbl: 80, gasUsdMcf: 3 }, upside: { oilUsdBbl: 100, gasUsdMcf: 3.75 } } } as PriceDeck;
    const tract = { cadLeaseNumber: "T", leaseName: "TEST", operatorName: null, legalDescription: null, irregular: false, marketValue: 0, productionShare: 1,
      owners: [{ ownerName: "R", interestType: "royalty" as const, decimal: 0.25, cadLeaseNumber: "T", inCareOf: null, interestTypeCode: null, acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 1 },
               { ownerName: "W", interestType: "working_interest" as const, decimal: 0.75, cadLeaseNumber: "T", inCareOf: null, interestTypeCode: null, acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 2 }],
      totals: { royalty: 0.25, overriding_royalty: 0, working_interest: 0.75, unknown: 0, all: 1 } };
    const own: LeaseOwnership = { status: "matched", rrcLeaseNumber: "1", sources: [], tracts: [tract], rejectedTracts: [], nameVerified: true, productionShareBasis: null, owners: tract.owners, reason: null };
    const old = valueLeaseInterests(own, { monthlyOilBbl: oil, monthlyGasMcf: gas, fieldName: asset.fieldName, county: asset.county }, deck, 4);
    const now = evaluatePrototype(asset, { ...start.assumptions, netRevenueInterest: 1 }).scenarios!;
    expect(now.base.presentValue).toBeCloseTo(old.royaltyUnitPv10!.base, 0);
    expect(now.downside.presentValue).toBeCloseTo(old.royaltyUnitPv10!.stress, 0);
  });

  it("refuses invalid inputs with the reason, and runs behind the async provider interface", async () => {
    expect(validateAssumptions({ ...start.assumptions, netRevenueInterest: 1.5 })).toContain("Net revenue interest must be a decimal between 0 and 1.");
    const bad = evaluatePrototype(asset, { ...start.assumptions, oilPriceUsdBbl: 0 });
    expect(bad.status).toBe("unavailable");
    expect(bad.reason).toContain("Oil price");
    const viaInterface = await mineralFlowPrototypeProvider.evaluate(asset, start.assumptions);
    expect(viaInterface.provider.id).toBe("mineralflow-prototype");
  });

  it("labels where every default came from", () => {
    expect(start.basis.oilSeverancePct).toContain("Tax Code");
    expect(start.basis.loeUsdPerBoe).toContain("Permian");
    expect(Object.values(start.basis).every(v => v.length > 0)).toBe(true);
  });
});

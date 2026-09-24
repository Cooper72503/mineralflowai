import { describe, it, expect } from "vitest";
import { loadLeaseOwnership, leaseNamesAgree, type LeaseOwnership, type RollOwner, type RollTract } from "../mineral-roll";
import { valueLeaseInterests } from "../interest-value";
import type { PriceDeck } from "../../eia-pricing";

type Rows = Record<string, Record<string, unknown>[]>;
function db(tables: Rows) {
  return {
    from(table: string) {
      const eq: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q, order: () => q, range: () => q, in: () => q,
        eq: (k: string, v: unknown) => { eq[k] = v; return q; },
        then: (res: (x: unknown) => unknown) => Promise.resolve(res({
          data: (tables[table] ?? []).filter(r => Object.entries(eq).every(([k, v]) => r[k] === v)),
          error: null,
        })),
      };
      return q;
    },
  };
}

const IMPORT = { id: "imp", county: "MARTIN", tax_year: 2025, source_file_name: "4. MINERAL DATA CSV FILE 23.xlsx", source_sha256: "a".repeat(64), interest_type_basis: "inferred", status: "complete" };
const row = (name: string, type: string, dec: number, o: { lease?: string; cad?: string; leaseName?: string; value?: number } = {}) => ({
  import_id: "imp", owner_name: name, in_care_of: null, interest_type: type, interest_type_code: null, decimal_interest: String(dec), acres: null,
  market_value: o.value ?? null, lease_name: o.leaseName ?? 'SHOCKLEY "3" #', operator_name: "OPERATOR LLC", legal_description: "T2N BLK 34 SEC",
  mineral_account_number: null, source_row: 2, rrc_lease_number: o.lease ?? "38991", cad_lease_number: o.cad ?? "C1" });

describe("leaseNamesAgree", () => {
  it("compares distinctive words, ignoring generic ones", () => {
    expect(leaseNamesAgree("JO MILL UNIT", "JO MILL UNIT TR 12")).toBe(true);
    expect(leaseNamesAgree("ANGEL-FRAZIER 9G", "JO MILL UNIT TR 12")).toBe(false);
    expect(leaseNamesAgree(null, "JO MILL UNIT")).toBeNull();
    expect(leaseNamesAgree("UNIT", "LEASE")).toBeNull();
  });
});

describe("loadLeaseOwnership", () => {
  it("matches on the RRC lease number, cites the roll and verifies the lease name", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [row("A", "royalty", 0.2), row("B", "working_interest", 0.8), row("C", "royalty", 0.5, { lease: "99999" })] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "038991", leaseName: 'SHOCKLEY "3"' });
    expect(r.status).toBe("matched");
    expect(r.rrcLeaseNumber).toBe("38991");
    expect(r.owners.map(o => o.ownerName)).toEqual(["B", "A"]);
    expect(r.tracts).toHaveLength(1);
    expect(r.tracts[0].totals.all).toBeCloseTo(1, 10);
    expect(r.tracts[0].productionShare).toBe(1);
    expect(r.tracts[0].irregular).toBe(false);
    expect(r.nameVerified).toBe(true);
    expect(r.sources[0]).toMatchObject({ county: "MARTIN", taxYear: 2025 });
  });

  it("rejects a tract carried under the same RRC number for another district's lease", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [
      row("A", "royalty", 0.125, { lease: "60465", cad: "J1", leaseName: "JO MILL UNIT TR 1" }), row("B", "working_interest", 0.875, { lease: "60465", cad: "J1", leaseName: "JO MILL UNIT TR 1" }),
      row("X", "royalty", 0.25, { lease: "60465", cad: "AF", leaseName: "ANGEL-FRAZIER 9G" }), row("Y", "working_interest", 0.75, { lease: "60465", cad: "AF", leaseName: "ANGEL-FRAZIER 9G" }),
    ] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "60465", leaseName: "JO MILL UNIT" });
    expect(r.status).toBe("matched");
    expect(r.tracts.map(t => t.cadLeaseNumber)).toEqual(["J1"]);
    expect(r.owners.map(o => o.ownerName).sort()).toEqual(["A", "B"]);
    expect(r.rejectedTracts).toEqual([expect.objectContaining({ cadLeaseNumber: "AF", owners: 2 })]);
    expect(r.rejectedTracts[0].reason).toContain("another district");
  });

  it("reports no match when every tract under the number belongs to another lease", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [row("X", "royalty", 1, { lease: "60465", cad: "AF", leaseName: "ANGEL-FRAZIER 9G" })] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "60465", leaseName: "JO MILL UNIT" });
    expect(r.status).toBe("no_match");
    expect(r.rejectedTracts).toHaveLength(1);
  });

  it("reconciles decimals per tract and shares production by appraised value, never summing tracts", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [
      row("R1", "royalty", 0.25, { cad: "T1", value: 300 }), row("W1", "working_interest", 0.75, { cad: "T1", value: 900 }),
      row("R2", "royalty", 0.25, { cad: "T2", value: 100 }), row("W2", "working_interest", 0.75, { cad: "T2", value: 300 }),
    ] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "38991", leaseName: 'SHOCKLEY "3"' });
    expect(r.tracts).toHaveLength(2);
    expect(r.tracts.every(t => !t.irregular && Math.abs(t.totals.all - 1) < 1e-9)).toBe(true);
    expect(r.tracts[0]).toMatchObject({ cadLeaseNumber: "T1", productionShare: 0.75 });
    expect(r.tracts[1]).toMatchObject({ cadLeaseNumber: "T2", productionShare: 0.25 });
    expect(r.productionShareBasis).toContain("market value");
  });

  it("flags a tract whose decimals do not reconcile instead of hiding it", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [row("A", "royalty", 0.6), row("B", "working_interest", 1.0)] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "38991", leaseName: null });
    expect(r.tracts[0].irregular).toBe(true);
    expect(r.owners).toHaveLength(2);
    expect(r.nameVerified).toBe(false);
  });

  it("states why when there is no roll, no match, or no lease number", async () => {
    expect((await loadLeaseOwnership(db({}) as never, { leaseNumber: "38991", leaseName: null })).status).toBe("no_roll");
    expect((await loadLeaseOwnership(db({ mineral_roll_imports: [IMPORT] }) as never, { leaseNumber: "38991", leaseName: null })).status).toBe("no_match");
    expect((await loadLeaseOwnership(db({}) as never, { leaseNumber: null, leaseName: null })).status).toBe("unavailable");
  });
});

const deck = (source: PriceDeck["source"]): PriceDeck => ({ source, asOf: "2026-08", wtiSpotUsdBbl: 80, henryHubUsdMcf: 3,
  scenarios: { stress: { oilUsdBbl: 60, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 80, gasUsdMcf: 3 }, strip: { oilUsdBbl: 80, gasUsdMcf: 3 }, upside: { oilUsdBbl: 100, gasUsdMcf: 3.75 } } } as PriceDeck);
const person = (ownerName: string, interestType: RollOwner["interestType"], decimal: number, cadLeaseNumber = "T1"): RollOwner => ({ ownerName, interestType, decimal, cadLeaseNumber,
  inCareOf: null, interestTypeCode: null, acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 1 });
function tract(cad: string, owners: RollOwner[], productionShare: number): RollTract {
  const totals = { royalty: 0, overriding_royalty: 0, working_interest: 0, unknown: 0, all: 0 };
  for (const o of owners) { totals[o.interestType] += o.decimal; totals.all += o.decimal; }
  return { cadLeaseNumber: cad, leaseName: "L", operatorName: null, legalDescription: null, owners, totals, irregular: false, marketValue: 0, productionShare };
}
const lease = (tracts: RollTract[]): LeaseOwnership => ({ status: "matched", rrcLeaseNumber: "38991", sources: [], tracts, rejectedTracts: [], nameVerified: true,
  productionShareBasis: null, owners: tracts.flatMap(t => t.owners), reason: null });

describe("valueLeaseInterests", () => {
  const oil = Array.from({ length: 24 }, (_, i) => 10000 * Math.exp(-0.04 * i));
  const one = lease([tract("T1", [person("R", "royalty", 0.2), person("W1", "working_interest", 0.6), person("W2", "working_interest", 0.2)], 1)]);

  it("values a royalty as its decimal times the cost-free unit value", () => {
    const v = valueLeaseInterests(one, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"));
    expect(v.status).toBe("valued");
    expect(v.owners[0].pv10!.base).toBeCloseTo(v.royaltyUnitPv10!.base * 0.2, 6);
    expect(v.royaltyUnitPv10!.upside).toBeGreaterThan(v.royaltyUnitPv10!.base);
    expect(v.royaltyUnitPv10!.base).toBeGreaterThan(v.royaltyUnitPv10!.stress);
    expect(v.royaltyUnitPv15!.base).toBeLessThan(v.royaltyUnitPv10!.base);
  });

  it("splits a tract's working interest by each holder's share of that tract's WI decimal", () => {
    const v = valueLeaseInterests(one, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"));
    expect(v.leaseNri).toBeCloseTo(0.8, 10);
    expect(v.owners[1].pv10!.base).toBeCloseTo(v.workingInterestPv10!.base * 0.75, 6);
    expect(v.owners[2].pv10!.base).toBeCloseTo(v.workingInterestPv10!.base * 0.25, 6);
    expect(v.workingInterestPv10!.base / 0.8).toBeLessThan(v.royaltyUnitPv10!.base);
  });

  it("applies a tract's decimals to that tract's share of lease production only", () => {
    const two = lease([tract("T1", [person("R1", "royalty", 0.25, "T1")], 0.75), tract("T2", [person("R2", "royalty", 0.25, "T2")], 0.25)]);
    const v = valueLeaseInterests(two, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"));
    expect(v.owners[0].pv10!.base).toBeCloseTo(v.royaltyUnitPv10!.base * 0.75 * 0.25, 6);
    expect(v.owners[1].pv10!.base).toBeCloseTo(v.royaltyUnitPv10!.base * 0.25 * 0.25, 6);
    // Two tracts of 0.25 royalty each are one quarter of the lease's royalty, not one half.
    expect(v.totalsPv10!.base).toBeCloseTo(v.royaltyUnitPv10!.base * 0.25, 6);
  });

  it("refuses to value on placeholder prices", () => {
    const v = valueLeaseInterests(one, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("static_fallback"));
    expect(v.status).toBe("unavailable");
    expect(v.owners.every(o => o.pv10 === null)).toBe(true);
  });
});

describe("valueLeaseInterests on a low-rate lease", () => {
  // Shockley "3", Martin: 40-150 bbl/month, one producing well.
  const oil = [152, 108, 111, 58, 111, 51, 76, 74, 86, 75, 39, 62];
  const shockley = lease([tract("T1", [person("R", "royalty", 0.1875), person("W", "working_interest", 0.8125)], 1)]);

  it("values a stripper lease to its economic limit instead of printing $0", () => {
    const v = valueLeaseInterests(shockley, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"), 1);
    expect(v.status).toBe("valued");
    expect(v.royaltyUnitPv10!.base).toBeGreaterThan(0);
    expect(v.economicLimitMonths!.base).toBeGreaterThan(0);
    expect(v.economicLimitMonths!.upside).toBeGreaterThanOrEqual(v.economicLimitMonths!.base);
    expect(v.economicLimitMonths!.base).toBeGreaterThanOrEqual(v.economicLimitMonths!.stress);
    expect(v.owners[0].pv10!.base).toBeGreaterThan(0);
  });

  it("ends the lease sooner when more wells carry the fixed operating floor", () => {
    const a = valueLeaseInterests(shockley, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"), 1);
    const b = valueLeaseInterests(shockley, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"), 2);
    expect(b.producingWells).toBe(2);
    if (b.status === "valued") expect(b.economicLimitMonths!.base).toBeLessThan(a.economicLimitMonths!.base);
    else expect(b.reason).toContain("economic limit");
  });
});

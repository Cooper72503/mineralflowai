import { describe, it, expect } from "vitest";
import { loadLeaseOwnership } from "../mineral-roll";
import { valueLeaseInterests } from "../interest-value";
import type { PriceDeck } from "../../eia-pricing";

type Rows = Record<string, Record<string, unknown>[]>;
function db(tables: Rows) {
  const filters: unknown[][] = [];
  return {
    filters,
    from(table: string) {
      const eq: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q, order: () => q, range: () => q,
        eq: (k: string, v: unknown) => { eq[k] = v; filters.push([table, k, v]); return q; },
        in: () => q,
        then: (res: (x: unknown) => unknown) => Promise.resolve(res({
          data: (tables[table] ?? []).filter(r => Object.entries(eq).every(([k, v]) => k === "status" ? r[k] === v : k === "rrc_lease_number" ? r[k] === v : true)),
          error: null,
        })),
      };
      return q;
    },
  };
}

const IMPORT = { id: "imp", county: "MARTIN", tax_year: 2025, source_file_name: "4. MINERAL DATA CSV FILE 23.xlsx", source_sha256: "a".repeat(64), interest_type_basis: "inferred", status: "complete" };
const owner = (name: string, type: string, dec: number, lease = "38991") => ({ import_id: "imp", owner_name: name, in_care_of: null, interest_type: type, interest_type_code: null,
  decimal_interest: String(dec), acres: null, market_value: null, lease_name: 'SHOCKLEY "3" #', operator_name: "DIAMONDBACK E&P LLC", legal_description: "T2N BLK 34 SEC", mineral_account_number: null, source_row: 2, rrc_lease_number: lease });

describe("loadLeaseOwnership", () => {
  it("matches on the RRC lease number, cites the roll and checks the lease name", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [owner("A", "royalty", 0.2), owner("B", "working_interest", 0.8), owner("C", "royalty", 0.5, "99999")] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "038991", leaseName: 'SHOCKLEY "3"' });
    expect(r.status).toBe("matched");
    expect(r.rrcLeaseNumber).toBe("38991");
    expect(r.owners.map(o => o.ownerName)).toEqual(["B", "A"]); // largest decimal first; other leases excluded
    expect(r.totals.all).toBeCloseTo(1, 10);
    expect(r.totalsIrregular).toBe(false);
    expect(r.nameAgreement).toBe("agrees");
    expect(r.sources[0]).toMatchObject({ county: "MARTIN", taxYear: 2025 });
  });
  it("flags a lease whose decimals do not reconcile instead of hiding it", async () => {
    const d = db({ mineral_roll_imports: [IMPORT], mineral_roll_interests: [owner("A", "royalty", 0.6), owner("B", "working_interest", 1.0)] });
    const r = await loadLeaseOwnership(d as never, { leaseNumber: "38991", leaseName: null });
    expect(r.totalsIrregular).toBe(true);
    expect(r.owners).toHaveLength(2);
  });
  it("states why when there is no roll, no match, or no lease number", async () => {
    expect((await loadLeaseOwnership(db({}) as never, { leaseNumber: "38991", leaseName: null })).status).toBe("no_roll");
    expect((await loadLeaseOwnership(db({ mineral_roll_imports: [IMPORT] }) as never, { leaseNumber: "38991", leaseName: null })).status).toBe("no_match");
    expect((await loadLeaseOwnership(db({}) as never, { leaseNumber: null, leaseName: null })).status).toBe("unavailable");
  });
});

describe("valueLeaseInterests", () => {
  const deck = (source: PriceDeck["source"]): PriceDeck => ({ source, asOf: "2026-08", wtiSpotUsdBbl: 80, henryHubUsdMcf: 3,
    scenarios: { stress: { oilUsdBbl: 60, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 80, gasUsdMcf: 3 }, strip: { oilUsdBbl: 80, gasUsdMcf: 3 }, upside: { oilUsdBbl: 100, gasUsdMcf: 3.75 } } } as PriceDeck);
  const oil = Array.from({ length: 24 }, (_, i) => 10000 * Math.exp(-0.04 * i));
  const ownership = { status: "matched" as const, rrcLeaseNumber: "38991", sources: [], rollLeaseNames: [], nameAgreement: "agrees" as const, totalsIrregular: false, reason: null,
    owners: [
      { ownerName: "R", interestType: "royalty" as const, decimal: 0.2, inCareOf: null, interestTypeCode: "1", acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 1 },
      { ownerName: "W1", interestType: "working_interest" as const, decimal: 0.6, inCareOf: null, interestTypeCode: "4", acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 2 },
      { ownerName: "W2", interestType: "working_interest" as const, decimal: 0.2, inCareOf: null, interestTypeCode: "4", acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 3 },
    ],
    totals: { royalty: 0.2, overriding_royalty: 0, working_interest: 0.8, unknown: 0, all: 1 } };

  it("values a royalty as its decimal times the cost-free unit value", () => {
    const v = valueLeaseInterests(ownership, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"));
    expect(v.status).toBe("valued");
    expect(v.owners[0].pv10!.base).toBeCloseTo(v.royaltyUnitPv10!.base * 0.2, 6);
    expect(v.royaltyUnitPv10!.upside).toBeGreaterThan(v.royaltyUnitPv10!.base);
    expect(v.royaltyUnitPv10!.base).toBeGreaterThan(v.royaltyUnitPv10!.stress);
  });
  it("splits the whole working interest by each holder's share of the roll's WI decimal", () => {
    const v = valueLeaseInterests(ownership, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("eia_live"));
    expect(v.owners[1].pv10!.base).toBeCloseTo(v.workingInterestPv10!.base * 0.75, 6);
    expect(v.owners[2].pv10!.base).toBeCloseTo(v.workingInterestPv10!.base * 0.25, 6);
    // Working interest bears costs, so a full WI decimal is worth less than a full royalty decimal.
    expect(v.workingInterestPv10!.base / 0.8).toBeLessThan(v.royaltyUnitPv10!.base);
  });
  it("refuses to value on placeholder prices", () => {
    const v = valueLeaseInterests(ownership, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck("static_fallback"));
    expect(v.status).toBe("unavailable");
    expect(v.owners.every(o => o.pv10 === null)).toBe(true);
  });
});

describe("valueLeaseInterests on a low-rate lease", () => {
  it("reports why it cannot value a lease below the terminal rate instead of printing $0", () => {
    const deck = { source: "eia_live", asOf: "2026-08", wtiSpotUsdBbl: 80, henryHubUsdMcf: 3,
      scenarios: { stress: { oilUsdBbl: 60, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 80, gasUsdMcf: 3 }, strip: { oilUsdBbl: 80, gasUsdMcf: 3 }, upside: { oilUsdBbl: 100, gasUsdMcf: 3.75 } } } as never;
    // Shockley "3", Martin: 40-110 bbl/month.
    const oil = [152, 108, 111, 58, 111, 51, 76, 74, 86, 75, 39];
    const ownership = { status: "matched" as const, rrcLeaseNumber: "38991", sources: [], rollLeaseNames: [], nameAgreement: "agrees" as const, totalsIrregular: false, reason: null,
      owners: [{ ownerName: "R", interestType: "royalty" as const, decimal: 0.0375, inCareOf: null, interestTypeCode: "1", acres: null, marketValue: null, rollLeaseName: null, operatorName: null, legalDescription: null, mineralAccountNumber: null, sourceRow: 1 }],
      totals: { royalty: 0.0375, overriding_royalty: 0, working_interest: 0, unknown: 0, all: 0.0375 } };
    const v = valueLeaseInterests(ownership, { monthlyOilBbl: oil, monthlyGasMcf: [] }, deck);
    expect(v.status).toBe("unavailable");
    expect(v.reason).toContain("terminal rate");
    expect(v.owners[0].pv10).toBeNull();
  });
});

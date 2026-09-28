import { describe, it, expect } from "vitest";
import { decideLeaseRecord, economicsAssetFromLease, entryAnalysis, exitAnalysis, reconcile, irrAnnualPct } from "../decision-layer";
import { evaluatePrototype, defaultAssumptions } from "../../economics-provider";
import type { DealLease } from "../build";

const months = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2024, 1 + i, 1));
  const oil = 12000 * Math.pow(1 + 0.7 * 0.08 * i, -1 / 0.7);
  return { entity_type: "lease", api_number: null, district: "08", lease_number: "1", gas_id: null, operator_number: null, production_month: d.toISOString().slice(0, 7), oil_bbl: oil, casinghead_gas_mcf: oil * 3, gas_mcf: null, condensate_bbl: null, water_bbl: null };
});
const finding = (title: string, type: string) => ({ findingId: title + Math.random(), type, severity: "medium", title, explanation: "e", affectedTractId: null, affectedTractLabel: null, affectedInterestType: null, instrumentIds: [], citations: [], nextAction: "confirm" });
function lease(over: Partial<DealLease> = {}): DealLease {
  return {
    key: "TX:8:O:1", district: "8", leaseNumber: "1", leaseType: "O", leaseName: "TEST UNIT", field: "SPRABERRY (TREND AREA)", county: "MIDLAND", operator: "CHEVRON U. S. A. INC.", operatorNo: "148113",
    apis: ["4232900001", "4232900002"], runIds: ["r1", "r2"], members: [], producingWells: 2, producingWellsBasis: "",
    wells: [{ api10: "4232900001", wellNo: "1", status: "PRODUCING", formsLacking: false, inPackage: true, onProration: true }, { api10: "4232900002", wellNo: "2", status: null, formsLacking: false, inPackage: true, onProration: false }],
    production: months as never, lastReportedMonth: months[months.length - 1].production_month, trailingUnreportedMonths: 1,
    fit: { qi: 12000, di: 0.08, b: 0.7, diAnnualPct: 60, currentAnnualDeclinePct: 25, rSquared: 0.97, monthsOfHistory: 30, classification: "Moderate" },
    fitPhase: "oil", fitWindowNote: null, basin: null,
    ownership: { status: "no_match", rrcLeaseNumber: "1", sources: [], tracts: [], rejectedTracts: [], nameVerified: false, productionShareBasis: null, owners: [], reason: "No roll for Midland." },
    valuation: { leaseNri: null, leaseNriBasis: null } as never, offers: {} as never, regulatory: { critical: [], important: [] }, coverage: [],
    title: { status: "published", reason: null, readInstruments: 1, indexedInstruments: 4, analysis: {
      findings: [finding("Similar party names", "IDENTITY_MISMATCH"), finding("Similar party names", "IDENTITY_MISMATCH"), finding("Over-conveyance", "OVER_CONVEYANCE")],
      limitations: ["The unit name refers to Section 25, which no confirmed tract covers. Other unit tracts have not been researched."],
      chronology: [{ fromParties: [{ displayName: "SMITH" }], toParties: [{ displayName: "CHEVRON USA INC" }] }],
    } as never },
    decision: {} as never, sources: { production: ["3"], wells: ["4"], roll: [], title: ["7"] }, ...over,
  };
}
const defaults = defaultAssumptions({ oilPriceUsdBbl: 80, gasPriceUsdMcf: 3, priceBasis: "t", fieldName: "SPRABERRY (TREND AREA)", county: "MIDLAND", operatorNri: 0.75, operatorNriBasis: null }).assumptions;

describe("decision layer", () => {
  it("sets the offer range and ceiling from the provider at the user's hurdle", () => {
    const e = evaluatePrototype(economicsAssetFromLease(lease()), defaults);
    const entry = entryAnalysis(e)!;
    expect(entry.ceiling).toBeCloseTo(e.scenarios!.base.presentValue, 6);
    expect(entry.rangeLow).toBeLessThanOrEqual(entry.rangeHigh);
    expect(entry.rangeHigh).toBeLessThan(entry.ceiling);
    expect(entry.position).toBe("no asking price");
  });

  it("prices an asking price: IRR, payout, and PASS above the ceiling", () => {
    const e = evaluatePrototype(economicsAssetFromLease(lease()), defaults);
    const ceiling = e.scenarios!.base.presentValue;
    const cheap = decideLeaseRecord(lease(), evaluatePrototype(economicsAssetFromLease(lease()), { ...defaults, askingPriceUsd: ceiling * 0.5 }));
    expect(cheap.entry!.askingIrrPct).toBeGreaterThan(10);
    expect(cheap.entry!.askingPayoutMonths).toBeGreaterThan(0);
    const dear = decideLeaseRecord(lease(), evaluatePrototype(economicsAssetFromLease(lease()), { ...defaults, askingPriceUsd: ceiling * 1.5 }));
    expect(dear.verdict).toBe("PASS");
    expect(dear.reasons[0]).toContain("above the walk-away ceiling");
  });

  it("recomputes the exit: cash in the hold plus the remaining value at the same hurdle", () => {
    const e = evaluatePrototype(economicsAssetFromLease(lease()), { ...defaults, holdYears: 2 });
    const x = exitAnalysis(e, entryAnalysis(e))!;
    const hold = e.scenarios!.base.monthlyNet.slice(0, 24).reduce((a, b) => a + b, 0);
    expect(x.byScenario.base.holdCash).toBeCloseTo(hold, 6);
    expect(x.byScenario.base.total).toBeCloseTo(x.byScenario.base.holdCash + x.byScenario.base.exitValue, 6);
    expect(x.byScenario.downside.total).toBeLessThan(x.byScenario.upside.total);
  });

  it("finds contradictions and missing diligence, grouping repeated title findings", () => {
    const e = evaluatePrototype(economicsAssetFromLease(lease()), defaults);
    const { contradictions, missing } = reconcile(lease(), e);
    expect(contradictions.some(c => c.text.includes("not carried on its oil proration schedule"))).toBe(true);
    expect(contradictions.some(c => c.text.startsWith("Title: Over-conveyance"))).toBe(true);
    expect(missing.filter(m => m.text.startsWith("Title: Similar party names"))).toHaveLength(1);
    expect(missing.some(m => m.text.includes("(2 instances)"))).toBe(true);
    expect(missing.some(m => m.text.includes("Section 25"))).toBe(true);
    expect(missing.some(m => m.text.includes("3 of 4 recordings"))).toBe(true);
    expect(missing.some(m => m.text.includes("Owners of record not established"))).toBe(true);
  });

  it("flags an entered royalty larger than the roll carries, and sends it to review", () => {
    const tract = { cadLeaseNumber: "T", leaseName: "TEST UNIT", operatorName: "CHEVRON USA INC", legalDescription: null, irregular: false, marketValue: 1, productionShare: 1, owners: [],
      totals: { royalty: 0.2, overriding_royalty: 0.02, working_interest: 0.78, unknown: 0, all: 1 } };
    const l = lease({ ownership: { status: "matched", rrcLeaseNumber: "1", sources: [{ county: "MIDLAND", taxYear: 2025, fileName: "f", sha256: "x", interestTypeBasis: null }], tracts: [tract], rejectedTracts: [], nameVerified: true, productionShareBasis: null, owners: [], reason: null } });
    const r = decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), { ...defaults, netRevenueInterest: 0.5 }));
    expect(r.contradictions.some(c => c.text.includes("exceeds all royalty"))).toBe(true);
    expect(r.verdict).toBe("REVIEW");
  });

  it("reports a losing hold as a negative IRR, not a blank", () => {
    expect(irrAnnualPct([-100, ...new Array(11).fill(0), 110])).toBeCloseTo(10, 6);
    expect(irrAnnualPct([-100, ...new Array(11).fill(0), 70])).toBeCloseTo(-30, 6);
    expect(irrAnnualPct([-100, 0, 0])).toBeNull();
  });

  it("passes on an interest with no positive value rather than quoting a negative range", () => {
    const l = lease();
    const r = decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), { ...defaults, interestType: "working", workingInterest: 1, netRevenueInterest: 0.02 }));
    expect(r.economics.scenarios!.base.presentValue).toBeLessThan(0);
    expect(r.verdict).toBe("PASS");
    expect(r.reasons[0]).toContain("no positive value");
  });

  it("changes the decision when an assumption changes", () => {
    const l = lease();
    const e = evaluatePrototype(economicsAssetFromLease(l), defaults);
    const asking = e.scenarios!.base.presentValue * 0.95;
    const atBase = decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), { ...defaults, askingPriceUsd: asking }));
    const lowerOil = decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), { ...defaults, askingPriceUsd: asking, oilPriceUsdBbl: 50 }));
    expect(atBase.verdict).not.toBe("PASS");
    expect(lowerOil.verdict).toBe("PASS");
  });
});

// Each missing input independently gates BUY from a supported baseline.
function supportedLease(): DealLease {
  const l = lease();
  l.title = { ...l.title, readInstruments: 4, analysis: { ...l.title.analysis!, status: "NO_SURFACE_DISCONTINUITIES_DETECTED", findings: [], limitations: [], reviewQueueOpenCount: 0 } };
  l.ownership = { ...l.ownership, status: "matched", nameVerified: true, reason: null, tracts: [{ cadLeaseNumber: "T", productionShare: 1, irregular: false, owners: [], totals: { royalty: 0.25, overriding_royalty: 0, working_interest: 0.75, unknown: 0, all: 1 } }] as never };
  l.regulatory = { critical: [], important: [], coverage: l.apis.flatMap(api => ["fetch_compliance_violations", "fetch_plugging_records", "fetch_orphan_well", "fetch_inactive_well_status", "fetch_injection_records"].map(source => ({ api, source, status: "verified" as const, reason: "Query completed", attemptedAt: "2026-09-28", url: null, sourceId: "4" }))) };
  return l;
}
describe("evidence gates", () => {
  it("retains BUY for a supported, affordable scenario", () => {
    const l = supportedLease();
    expect(decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), defaults)).verdict).toBe("BUY");
  });
  it.each(["unread instruments", "unresearched tract", "unknown ownership", "stale production", "failed compliance"])("independently gates %s while retaining conditional calculations", (kind) => {
    const l = supportedLease();
    if (kind === "unread instruments") l.title.readInstruments = 1;
    if (kind === "unresearched tract") l.title.analysis!.limitations = ["Section 25 has not been researched."];
    if (kind === "unknown ownership") l.ownership = lease().ownership;
    if (kind === "stale production") l.trailingUnreportedMonths = 24;
    if (kind === "failed compliance") l.regulatory.coverage![0] = { ...l.regulatory.coverage![0], status: "unavailable", reason: "Compliance request failed" };
    const r = decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), defaults));
    expect(r.verdict).toBe("REVIEW"); expect(r.economics.status).toBe("calculated");
    const terms: Record<string, string> = { "unread instruments": "3 of 4", "unresearched tract": "Section 25", "unknown ownership": "Owners of record", "stale production": "24 completed months", "failed compliance": "Compliance request failed" };
    expect(r.reasons.join(" ")).toContain(terms[kind]);
  });
});

import { describe, it, expect } from "vitest";
import { assessDistress, distressPassReasons, distressReviewReasons, pluggingExposure } from "../distress";
import { decideLeaseRecord, economicsAssetFromLease, entryAnalysis, reconcile } from "../decision-layer";
import { decideLease } from "../underwriting";
import { evaluatePrototype, defaultAssumptions } from "../../economics-provider";
import type { DealLease, DealWell } from "../build";
import type { TrrcDDProductionRow } from "../../types";

// ODC /SAN ANDRES/ UNIT (Gaines, 8A-60509) as TRRC reported it on 2026-10-15:
// 480 and 435 bbl in Apr-May 2025, zero through Jan 2026, no report after.
const row = (month: string, oil: number | null): TrrcDDProductionRow => ({ entity_type: "lease", api_number: null, district: "8A", lease_number: "60509", gas_id: null, operator_number: null,
  production_month: month, oil_bbl: oil, casinghead_gas_mcf: oil === null ? null : 0, gas_mcf: null, condensate_bbl: null, water_bbl: null });
const monthsFrom = (y: number, m: number, n: number) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 + i, 1)); return d.toISOString().slice(0, 7); });
const gaines = [
  ...monthsFrom(2024, 6, 10).map(m => row(m, 0)), row("2025-04", 480), row("2025-05", 435),
  ...monthsFrom(2025, 6, 8).map(m => row(m, 0)), ...monthsFrom(2026, 2, 8).map(m => row(m, null)),
];
const inactiveWell = (api10: string, nov = true): DealWell => ({ api10, wellNo: api10.slice(-2), status: null, formsLacking: false, inPackage: true, onProration: false,
  inactive: { shutIn: "06/2023", extension: "Denied", pluggingDeadline: null },
  violations: nov ? [{ rule: "16 TAC § 3.14(b)(2) [SWR 3.14(b)(2)]", description: "Inactive Unplugged Well", discovered: "05/19/2025", action: "Notice of Violation" }] : [] });
const activeWell = (api10: string): DealWell => ({ api10, wellNo: api10.slice(-2), status: "INJECTION", formsLacking: false, inPackage: true, onProration: true, inactive: null, violations: [] });
const wells = [inactiveWell("4216537711"), inactiveWell("4216533187"), inactiveWell("4216533201", false), activeWell("4216502084")];
const std = defaultAssumptions({ oilPriceUsdBbl: 80, gasPriceUsdMcf: 2.95, priceBasis: "t", fieldName: "O D C (SAN ANDRES)", county: "GAINES", operatorNri: null, operatorNriBasis: null }).assumptions;

describe("lease distress", () => {
  it("finds the stopped production, the unfiled months and the inactive wells", () => {
    const d = assessDistress(gaines, wells, 8);
    expect(d).toMatchObject({ lastProducingMonth: "2025-05", lastReportedMonth: "2026-01", zeroMonthsAtEnd: 8, stopped: true, unreportedMonths: 8, stoppedOnCurrentFilings: false,
      priorOilBbl: 915, inactive: { wells: 3, denied: 3, earliestShutIn: "2023-06" }, inactiveViolationWells: 2, violationWells: 2 });
  });

  it("does not PASS a lease whose operator stopped filing: the seller's run statements decide it", () => {
    const d = assessDistress(gaines, wells, 8);
    expect(distressPassReasons(d, 4, std)).toEqual([]);
    const review = distressReviewReasons(d, 4, std);
    expect(review[0]).toMatch(/no oil or gas since May 2025.*last 8 reported months, through Jan 2026.*No production report has been filed for the 8 completed months since/);
    expect(review[1]).toMatch(/run statements/);
    expect(review.join(" ")).toMatch(/3 of 4 submitted wells are on TRRC's inactive-well report.*denied the plugging extension for every one.*2 carry a Notice of Violation/);
  });

  it("PASSes when the operator's current filings are zero", () => {
    const current = [...gaines.filter(r => r.oil_bbl !== null), ...monthsFrom(2026, 2, 6).map(m => row(m, 0))];
    const d = assessDistress(current, wells, 2);
    expect(d.stoppedOnCurrentFilings).toBe(true);
    const pass = distressPassReasons(d, 4, { ...std, askingPriceUsd: 2_000_000 });
    expect(pass[1]).toBe("There is no production value to support the $2,000,000 asking price; a decline curve cannot value a lease that has stopped producing.");
    expect(distressReviewReasons(d, 4, std)).toEqual([]);
  });

  it("does not call a short shut-in a stopped lease", () => {
    const d = assessDistress([...monthsFrom(2025, 1, 12).map(m => row(m, 900)), ...monthsFrom(2026, 1, 3).map(m => row(m, 0))], [], 1);
    expect(d.stopped).toBe(false);
    expect(distressPassReasons(d, 1, std)).toEqual([]);
    expect(distressReviewReasons(d, 1, std)).toEqual([]);
  });

  it("charges plugging to a working interest by its share, never to a royalty", () => {
    const d = assessDistress(gaines, wells, 8);
    expect(pluggingExposure(d, std)).toEqual({ wells: 3, costPerWellUsd: 40000, grossUsd: 120000, toInterestUsd: 0 });
    expect(pluggingExposure(d, { ...std, interestType: "working", workingInterest: 0.5, netRevenueInterest: 0.375 }).toInterestUsd).toBe(60000);
  });
});

function lease(over: Partial<DealLease> = {}): DealLease {
  return {
    key: "TX:8A:O:60509", district: "8A", leaseNumber: "60509", leaseType: "O", leaseName: "ODC /SAN ANDRES/ UNIT", field: "O D C (SAN ANDRES)", county: "GAINES", operator: "FUSION ENERGY HOLDINGS, LLC", operatorNo: "102004",
    apis: wells.map(w => w.api10), runIds: [], members: [], producingWells: 1, producingWellsBasis: "", wells,
    production: gaines as never, lastReportedMonth: "2026-01", trailingUnreportedMonths: 8, fit: null, fitPhase: null, fitWindowNote: null, basin: null,
    ownership: { status: "no_match", rrcLeaseNumber: "60509", sources: [], tracts: [], rejectedTracts: [], nameVerified: false, productionShareBasis: null, owners: [], reason: "No roll for Gaines." },
    valuation: { leaseNri: null, leaseNriBasis: null } as never, offers: {} as never, regulatory: { critical: [], important: [] }, coverage: [],
    title: { status: "not_found", reason: "Gaines County clerk records are not online for automated search", readInstruments: 0, indexedInstruments: 0, analysis: null },
    decision: {} as never, sources: { production: ["1"], wells: ["2"], roll: [], title: [] }, ...over,
  };
}

describe("decision record for a distressed lease", () => {
  it("leads the REVIEW with what TRRC shows, not 'economics not calculated'", () => {
    const a = { ...std, netRevenueInterest: 0.73, askingPriceUsd: 2_000_000 };
    const r = decideLeaseRecord(lease(), evaluatePrototype(economicsAssetFromLease(lease()), a));
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasons[0]).toMatch(/^TRRC's record shows no oil or gas since May 2025/);
    expect(r.reasons.some(x => /Economics not calculated|No decline curve/.test(x))).toBe(false);
    expect(r.risks[0].severity).toBe(3);
  });

  it("flags a royalty entered at a working interest's decimal, with the plugging it leaves out", () => {
    const e = evaluatePrototype(economicsAssetFromLease(lease()), { ...std, netRevenueInterest: 0.73 });
    const { contradictions } = reconcile(lease(), e, pluggingExposure(assessDistress(gaines, wells, 8), std));
    expect(contradictions.find(c => /royalty at NRI 0.73/.test(c.text))).toMatchObject({ severity: 3 });
    expect(contradictions.find(c => /royalty at NRI 0.73/.test(c.text))!.text).toMatch(/leaves out \$120,000 of plugging exposure/);
    expect(reconcile(lease(), evaluatePrototype(economicsAssetFromLease(lease()), { ...std, netRevenueInterest: 0.1875 })).contradictions.some(c => /royalty at NRI/.test(c.text))).toBe(false);
  });

  it("collapses one limitation on many wells into one finding", () => {
    const coverage = wells.map((w, i) => ({ source: "fetch_plugging_records", status: "limited" as const, reason: "Not plugged: TRRC's GIS well layer shows this well as \"Oil Well\". W-3 certificate content was not checked.", url: null, attemptedAt: null, api: w.api10, sourceId: String(10 + i) }));
    const l = lease({ regulatory: { critical: [], important: [], coverage: coverage as never } });
    const gaps = reconcile(l, evaluatePrototype(economicsAssetFromLease(l), std)).missing.filter(m => /W-3/.test(m.text));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].text).toMatch(/\(4 wells\)\.$/);
    expect(gaps[0].sources).toEqual(["10", "11", "12", "13"]);
  });

  it("takes a working interest's plugging share off its entry ceiling", () => {
    const months = Array.from({ length: 30 }, (_, i) => row(new Date(Date.UTC(2024, 1 + i, 1)).toISOString().slice(0, 7), 12000 * Math.pow(1 + 0.7 * 0.08 * i, -1 / 0.7)));
    const l = lease({ production: months as never, lastReportedMonth: months[29].production_month, trailingUnreportedMonths: 1 });
    const wi = { ...std, interestType: "working" as const, workingInterest: 0.5, netRevenueInterest: 0.375 };
    const e = evaluatePrototype(economicsAssetFromLease(l), wi);
    const plain = entryAnalysis(e)!, charged = entryAnalysis(e, 60000)!;
    expect(plain.ceiling - charged.ceiling).toBeCloseTo(60000, 6);
    expect(decideLeaseRecord(l, e).entry!.liabilityUsd).toBe(60000);
  });
});

describe("underwriting with distress", () => {
  it("lets a stopped lease on current filings PASS despite open evidence gaps", () => {
    const base = { valuation: { status: "unavailable", reason: "Insufficient data" } as never, ownership: { status: "no_match", tracts: [], rejectedTracts: [], owners: [], reason: "No roll." } as never,
      fitRSquared: null, monthsOfHistory: 20, trailingUnreportedMonths: 1, currentAnnualDeclinePct: null, producingWells: 0, prorationWells: 9, shutInWells: 0, formsLackingWells: 0,
      regulatoryCritical: [], regulatoryImportant: [], title: { status: "not_found" as const, readInstruments: 0, indexedInstruments: 0, reason: "not online" }, excludedMembers: 0 };
    expect(decideLease({ ...base, distressReasons: ["stopped"] }).verdict).toBe("PASS");
    const held = decideLease({ ...base, distressReviewReasons: ["stopped, unfiled"] });
    expect(held.verdict).toBe("REVIEW");
    expect(held.reasons[0]).toBe("stopped, unfiled");
  });
});

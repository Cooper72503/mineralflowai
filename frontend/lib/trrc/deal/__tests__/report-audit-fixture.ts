// Synthetic render fixture only. No live title or production assertion.
import type { Deal, DealLease } from "../build";
import type { TitleChainAnalysis } from "../../title/chain-types";
import { buildGraphInput, TRACT_A, TRACT_B } from "../../title/__tests__/fixtures/instruments";
import { buildOwnershipGraph } from "../../title/ownership-graph";
import { chronologyFromBranches } from "../../title/analysis";
import { applyAssumptionEdits, assembleDecision } from "../decision-layer";
import { titleRecordingCounts } from "../report-scope";
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

export function auditFixture() {
  const graphInput = buildGraphInput([
    { number: "1990-0001", executed: "1990-01-01", recorded: "1990-01-05", from: ["ALICE EXAMPLE"], to: ["BOB EXAMPLE"], claims: [{ interest: "mineral", tract: TRACT_A.id, fraction: "1/2" }, { interest: "mineral", tract: TRACT_B.id, fraction: "1/2" }] },
    { number: "2020-0002", executed: "2020-01-01", recorded: "2020-01-05", from: ["UNSUPPORTED EXAMPLE"], to: ["CAROL EXAMPLE"], claims: [{ interest: "mineral", tract: TRACT_A.id }] },
    { number: "2021-0003", verified: false, recorded: "2021-01-05", from: ["BOB EXAMPLE"], to: ["DAVE EXAMPLE"], claims: [{ interest: "mineral", tract: TRACT_B.id }] },
  ], [TRACT_A, TRACT_B]);
  const graph = buildOwnershipGraph({ ...graphInput, interestScope: ["minerals"] });
  const chronology = chronologyFromBranches(graph.branches.flatMap(b => b.events.map(event => ({ event, tractLabel: b.tractLabel, interestType: b.interestType }))));
  const analysis: TitleChainAnalysis = { schemaVersion: "1", analysisId: "fixture", jobId: "fixture", version: 1, generatedAt: "2026-10-01T12:00:00Z", interestScope: ["minerals"], researchStartDate: null, asOfDate: "2026-10-01", status: "POTENTIAL_GAPS_DETECTED", statusDisplay: "Potential gaps detected", statusRule: "Fixture only", wells: [], tracts: [TRACT_A, TRACT_B], branches: graph.branches, chronology, findings: graph.findings, sourceInventory: [], searchCoverage: [], limitations: ["Synthetic fixture; not live evidence."], reviewQueueOpenCount: 2, statement: "Synthetic fixture" };
  const l = lease({ leaseName: "SYNTHETIC REPORT AUDIT — NOT LIVE DATA", title: { status: "published", reason: null, analysis, ...titleRecordingCounts(chronology) } });
  l.members = l.apis.map((api, i) => ({ api, input: api, runId: `r${i}` }));
  const deal: Deal = { packageId: "fixture-only", generatedAt: "2026-10-01T12:00:00Z", submitted: 2, distinctApis: 2, leases: [l], excluded: [],
    deck: { source: "eia_live", asOf: "fixture", wtiSpotUsdBbl: 83.9, henryHubUsdMcf: 2.78, scenarios: Object.fromEntries(["stress", "base", "strip", "upside"].map(k => [k, { oilUsdBbl: 83.9, gasUsdMcf: 2.78 }])) } as never,
    deckLabel: "Synthetic EIA-shaped fixture: gas $2.78/MMBtu, not a live price",
    overrides: { oilUsdBbl: null, gasUsdMcf: null, loeUsdPerBoe: null }, totals: { royaltyAndOverridePv10: null, workingInterestPv10: null }, decision: { verdict: "REVIEW", reasons: [] },
    completeness: { status: "partial", blockers: ["SYNTHETIC REPORT AUDIT: Not valued: No effective appraisal roll"], valuedLeases: 0, totalLeases: 1 },
    sources: [{ id: "1", label: "Price deck", detail: "Synthetic fixture", retrievedAt: null, url: null }, { id: "2", label: "MineralFlow standard assumptions", detail: "Synthetic fixture", retrievedAt: null, url: null }, ...["3","4","7"].map(id => ({ id, label: "Synthetic test evidence", detail: "Not live records", retrievedAt: null, url: null }))] };
  const start = applyAssumptionEdits(deal, {});
  return { deal, record: assembleDecision(deal, Object.fromEntries(Object.entries(start.byLease).map(([k,v]) => [k,v.assumptions]))), basisByLease: Object.fromEntries(Object.entries(start.byLease).map(([k,v]) => [k,v.basis])), editedByLease: {} };
}

import { describe, it, expect } from "vitest";
import { buildOwnershipGraph } from "../ownership-graph";
import { buildCrossCuttingFindings, aggregateStatus, sortFindings } from "../chain-findings";
import { chronologyFromBranches } from "../analysis";
import { buildTitleChainReport, renderChronologyText } from "../report";
import { proposeTracts, tractKey } from "../tract-candidates";
import { STATUS_AGGREGATION_RULE, STATUS_DISPLAY, TITLE_CHAIN_REPORT_STATEMENT, TITLE_CHAIN_SCHEMA_VERSION, type JobWell, type TitleChainAnalysis } from "../chain-types";
import { buildGraphInput, TRACT_A } from "./fixtures/instruments";

function makeAnalysis(): TitleChainAnalysis {
  const input = buildGraphInput([
    { executed: "1990-01-05", recorded: "1990-01-10", number: "1001", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
    { executed: "2000-02-05", recorded: "2000-02-10", number: "2002", from: ["Bob Brown"], to: ["Carol Clark", "Cathy Clark"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
  ]);
  const graph = buildOwnershipGraph({ ...input, interestScope: ["minerals"] });
  const cross = buildCrossCuttingFindings({ tracts: [TRACT_A], instruments: input.instruments, parties: input.parties, claims: input.claims, limitations: [], providerUnavailableCounties: [], ocrFailedDocumentIds: [] });
  const findings = sortFindings([...graph.findings, ...cross]);
  const status = aggregateStatus({ findings, confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 2 });
  return {
    schemaVersion: TITLE_CHAIN_SCHEMA_VERSION, analysisId: "a-1", jobId: "job-1", version: 1, generatedAt: "2026-09-06T00:00:00.000Z", interestScope: ["minerals"],
    researchStartDate: null, asOfDate: "2026-09-06", status, statusDisplay: STATUS_DISPLAY[status], statusRule: STATUS_AGGREGATION_RULE,
    wells: [{ wellId: "w1", originalInput: "42-317-00001", api14: "42317000010000", formatted: "42-317-00001-00-00", wellName: "DOE 1", operatorName: "ACME", countyName: "Martin", resolutionStatus: "resolved", validationError: null, resolutionError: null, associations: [] }],
    tracts: [TRACT_A], branches: graph.branches,
    chronology: chronologyFromBranches(graph.branches.flatMap(b => b.events.map(event => ({ event, tractLabel: b.tractLabel, interestType: b.interestType })))),
    findings, sourceInventory: [], searchCoverage: [], limitations: [], reviewQueueOpenCount: 0, statement: TITLE_CHAIN_REPORT_STATEMENT,
  };
}

describe("report — one validated object, every surface", () => {
  it("renders the table and the JSON from the same analysis so they cannot diverge, and never uses forbidden words", () => {
    const analysis = makeAnalysis();
    const report = buildTitleChainReport(analysis);
    expect(report.chronology).toBe(analysis.chronology);
    expect(report.analysis).toBe(analysis);
    const text = renderChronologyText(report.chronology);
    expect(text.split("\n")).toHaveLength(report.chronology.length + 1);
    expect(text).toMatch(/1990-01-10 \(recorded\)/);
    expect(text).toMatch(/Bob Brown → Carol Clark, Cathy Clark/);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/clear title|certified|flawless|unbroken/i);
    expect(report.statement).toMatch(/not a title opinion/);
    expect(report.executiveSummary.status).toBe("Potential gaps detected");   // multi-grantee allocation unresolved
    expect(report.executiveSummary.apparentCurrentHolders[0].holders.length).toBeGreaterThan(1); // multiple holders, never forced to one
    expect(report.schemaVersion).toBe("1.0.0");
  });

  it("uses the user-facing wording for the no-discontinuity status", () => {
    expect(STATUS_DISPLAY.NO_SURFACE_DISCONTINUITIES_DETECTED).toBe("No discontinuities detected in reviewed records");
  });
});

describe("tract candidates — ambiguous identification stays a proposal", () => {
  const well = (over: Partial<JobWell>): JobWell => ({
    id: "w1", originalInput: "42-317-00001", api10: "4231700001", api14: "42317000010000", sidetrackSuffix: null, completionSuffix: null, countyCode: "317", countyName: "Martin",
    validationError: null, resolutionStatus: "resolved", resolutionError: null, wellName: "DOE 1", wellNumber: "1", operatorName: "ACME", operatorNumber: "1", district: "08", leaseNumber: "12345",
    leaseName: "DOE UNIT", fieldName: null, latitude: 32.1, longitude: -102.1, wellPath: null, surveyName: "T&P RR CO", abstractNumber: "A-1234", blockNumber: "35", sectionName: "12",
    permitRefs: [], completionRefs: [], sourceUrls: [{ source: "trrc_gis", url: "https://gis", retrievedAt: "2026-09-06T00:00:00Z", status: "success" }], retrievedAt: "2026-09-06T00:00:00Z", ...over,
  });

  it("proposes separate candidates for the surface survey, the lease name, and a document legal description, all needing user selection", () => {
    const out = proposeTracts({ wells: [well({})], documentLegals: [{ wellId: "w1", documentId: "d1", sourceUrl: null, category: "w1_application", tract: { legalDescriptionVerbatim: "Section 13, Block 35, T&P RR Co. Survey, A-1235", county: "Martin", abstractNumber: "A-1235", surveyName: "T&P RR Co.", blockNumber: "35", sectionName: "13", tractLabel: null, grossAcres: 640, interestType: "unknown", effect: "other", fraction: null, reservationText: null, exceptionsText: null, depthOrFormationLimit: null, page: 1, excerpt: null } }], existingTracts: [] });
    expect(out.tracts.length).toBe(3);
    expect(out.tracts.every(t => t.matchStatus === "proposed" && t.needsUserSelection)).toBe(true);
    expect(out.associations.map(a => a.associationType).sort()).toEqual(["lease_unit_boundary", "permit_acreage", "surface_location"]);
    expect(out.associations.every(a => a.reviewStatus === "proposed" && a.evidence.length > 0)).toBe(true);
    expect(out.associations.find(a => a.associationType === "lease_unit_boundary")!.confidence).toBeLessThan(0.3);
    expect(out.reviewNeeded).toBe(true);
  });

  it("is idempotent — re-proposing against existing tracts adds no duplicates", () => {
    const first = proposeTracts({ wells: [well({})], documentLegals: [], existingTracts: [] });
    const second = proposeTracts({ wells: [well({})], documentLegals: [], existingTracts: first.tracts });
    expect(second.tracts.length).toBe(first.tracts.length);
    expect(tractKey({ county: "Martin", abstractNumber: "A-1234", surveyName: "T&P RR CO", blockNumber: "35", sectionName: "12", legalDescription: null }))
      .toBe(tractKey({ county: "martin", abstractNumber: "1234", surveyName: "T&P RR CO Survey", blockNumber: "35", sectionName: "12", legalDescription: "anything" }));
  });
});

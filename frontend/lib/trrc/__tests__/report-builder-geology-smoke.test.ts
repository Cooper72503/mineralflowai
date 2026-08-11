/**
 * End-to-end PDF render smoke test for the new Geological Due Diligence
 * page (Section 10). Not a snapshot test — react-pdf's renderToBuffer will
 * throw on a real render-time error (bad prop shape, undefined.access,
 * etc.) that a plain `tsc --noEmit` pass over loosely-typed
 * React.createElement style arrays would not catch.
 *
 * Two branches, each getting its own `vi.resetModules()` + dynamic import
 * so one test's module mock doesn't leak into the other:
 *  1. The honest "not calculated" fallback — real live path, no mock. TRRC's
 *     GIS query service is down as of this run (see task #92), so this
 *     naturally exercises the unresolved-location branch without a mock.
 *  2. A fully populated FAVORABLE assessment with real supporting/risk/gap
 *     findings, a comparable-well production table, and TVDSS — the branch
 *     the live TRRC outage prevents exercising for real right now.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrrcDueDiligenceRun } from "../types";
import type { TrrcManifest as _TrrcManifestUnused } from "../manifest-builder";
import type { GeologicalAssessmentResult } from "../geology/types";

const run = {
  id: "00000000-0000-0000-0000-000000000000",
  user_id: "00000000-0000-0000-0000-000000000001",
  original_input: "42-999-99999",
  detected_input_type: "api_number",
  selected_input_type: "api_number",
  normalized_input: "42-999-99999",
  status: "complete",
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  progress_percent: 100,
  result_summary: null,
  error_summary: null,
  resolved_primary_api: "4299999999",
  resolved_district: null,
  resolved_lease_number: null,
  resolved_gas_id: null,
  resolved_operator_number: null,
  purchase_price: null,
  report_storage_path: null,
  archive_storage_path: null,
  manifest_storage_path: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as unknown as TrrcDueDiligenceRun;

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../geology");
});

describe("buildTrrcPdfReport — Geological Due Diligence page render smoke test", () => {
  it("renders a non-empty PDF buffer without throwing, including the geology fallback state", { timeout: 30000 }, async () => {
    const { buildTrrcPdfReport } = await import("../report-builder");
    const buffer = await buildTrrcPdfReport(run, {} as _TrrcManifestUnused, [], {} as never, [], [], []);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000); // a real multi-page PDF, not an empty stub
  });

  it("renders a non-empty PDF buffer for a fully populated FAVORABLE geology result", { timeout: 30000 }, async () => {
    const fakeGeology: GeologicalAssessmentResult = {
      classification: "FAVORABLE",
      confidence: "HIGH",
      confidenceDimensions: { subjectLocation: 1, offsetWellCount: 1, offsetDataEnrichment: 0.9, formationDataQuality: 0.6, comparableGroupQuality: 1 },
      diligenceImplication: "Established same-zone offset development supports commercial viability of the target interval in this area.",
      supportingFactors: [
        { category: "supporting", classification: "observed", title: "Established offset development within 3 miles", description: "8 offset wells found within 3 miles.", evidenceIds: ["ev1"] },
        { category: "supporting", classification: "calculated", title: "Consistent offset production in a comparable well group", description: "Median 12-month oil production is 110,000 BBL.", evidenceIds: ["ev2"] },
      ],
      contradictingFactors: [],
      risks: [
        { category: "risk", classification: "observed", title: "Plugged or dry-hole wells present nearby", description: "1 plugged well within 3 miles.", evidenceIds: ["ev3"] },
      ],
      dataGaps: [
        { category: "gap", classification: "observed", title: "Formation tops and structural depth not available", description: "No public source.", evidenceIds: [] },
      ],
      formationDepthContext: {
        subjectFormation: "WOLFCAMP A", producingFormation: "WOLFCAMP A", permittedFormation: null,
        subjectTvdFt: 10500, subjectTvdSource: "completion report", subjectTvdssFt: 7700,
        tvdssElevationSource: "USGS", tvdssMethodology: "TVDSS = TVD (10500 ft) - reference elevation (2800 ft)",
        formationTopsAvailable: false, dataGapNote: "Formation tops not available from any free public source.",
      },
      offsetSummary: {
        wells: [{
          apiNumber: "42-165-00001", wellNumber: "1", latitude: 32.87, longitude: -102.74,
          distanceMiles: 1.2, bearing: "N", radiusBandMiles: 3, gisStatusSymbol: "Oil Well", classifiedStatus: "PRODUCING",
          operatorName: "ACME OIL LLC", fieldName: "WOLFCAMP (A)", canonicalFormation: "WOLFCAMP A", formationMatch: true,
          lateralLengthFt: 6500, completionYear: 2021, firstProductionMonth: "2021-03", sixMonthOilBbl: 20000,
          twelveMonthOilBbl: 110000, cumulativeOilBbl: 200000, cumulativeGasMcf: 500000, cumulativeWaterBbl: 50000,
          monthsOfHistory: 36, comparableGroupId: "g1",
        }],
        countByRadius: { 1: 2, 3: 8, 5: 12 }, horizontalCountByRadius: { 1: 1, 3: 5, 5: 8 },
        warnings: [], sourceUrlOrQueryId: "test", retrievedAt: new Date().toISOString(),
      },
      developmentActivity: {
        permits: [], permitCountByRadius: { 1: 0, 3: 2, 5: 3 },
        permitCountByRecency: { LAST_6_MONTHS: 0, LAST_12_MONTHS: 0, LAST_24_MONTHS: 0, OLDER: 0, UNKNOWN: 2 },
        operatorConcentration: [{ operatorName: "ACME OIL LLC", wellCount: 8, sharePct: 100 }],
        activeOperatorCount: 1, recentlyCompletedWellCount: 2, developmentDensityPerSqMile: 0.1,
        developmentRecencyNote: "2 offset well(s) began production within the last 24 months.", warnings: [],
      },
      comparableGroups: [{ groupId: "g1", canonicalFormation: "WOLFCAMP A", lateralLengthBand: "5000-7500ft", completionVintageBand: "2019-2021", memberApis: ["42-165-00001"] }],
      productionStats: [{
        groupId: "g1", wellCount: 5, medianTwelveMonthOilBbl: 110000, averageTwelveMonthOilBbl: 108000,
        bestPerformerApi: "42-165-00001", bestPerformerTwelveMonthOilBbl: 140000,
        lowestPerformerApi: "42-165-00002", lowestPerformerTwelveMonthOilBbl: 80000,
        distanceWeightedTwelveMonthOilBbl: 112000, validComparison: true, invalidComparisonReason: null,
      }],
      evidence: [{ id: "ev1", fieldName: "offset_well_count_3mi", classification: "observed", source: "TRRC GIS", sourceUrlOrDocId: null, retrievedAt: new Date().toISOString(), rawValue: "8", normalizedValue: "8", confidence: null, transformationMethod: null }],
      generatedAt: new Date().toISOString(),
      durationMs: 42,
    };

    vi.doMock("../geology", () => ({
      runGeologicalDueDiligence: vi.fn().mockResolvedValue(fakeGeology),
      persistGeologicalAssessment: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { buildTrrcPdfReport } = await import("../report-builder");
    const buffer = await buildTrrcPdfReport(run, {} as _TrrcManifestUnused, [], {} as never, [], [], []);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

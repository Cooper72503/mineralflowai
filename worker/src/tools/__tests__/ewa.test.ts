/**
 * Fixture-based tests against real, captured TRRC HTML responses.
 *
 * wellbore-populated.html: a real wellboreQueryAction.do response for API
 * 42-151-01734, captured live. TRRC renders this well's row with each
 * "column" wrapped in its own nested <table> (per-cell action-link layout),
 * which breaks the regex-based extractTables()/findDataTable() — this file
 * exists to prove that concretely against real data, not synthetic HTML.
 *
 * wellbore-empty.html: a real "no results found" response for a
 * confirmed-nonexistent API (42-165-50208).
 *
 * Ground truth for the populated fixture, read directly from the page's
 * own <a href="leaseDetailAction.do?...apiNo=15101734&distCode=7B&leaseNo=01973">
 * link — not guessed: API 15101734, district 7B, lease 01973.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractTables, findDataTable, searchWellbore, getProduction, searchLeaseWells, getWellStatus, getDrillingPermits, getGisLocation, getGathererPurchaser, normalizeDistrictForQuery } from "../ewa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const populatedHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-populated.html"), "utf8");
const emptyHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-empty.html"), "utf8");
const applicationErrorHtml = fs.readFileSync(path.join(__dirname, "fixtures/trrc-application-error.html"), "utf8");
const permitPopulatedHtml = fs.readFileSync(path.join(__dirname, "fixtures/drilling-permit-populated.html"), "utf8");
const permitEmptyHtml = fs.readFileSync(path.join(__dirname, "fixtures/drilling-permit-empty.html"), "utf8");
const gisWellFoundJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-well-found.json"), "utf8");
const gisWellEmptyJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-well-empty.json"), "utf8");
const gisAlertAreasJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-alert-areas.json"), "utf8");
const gisSurveyJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-survey.json"), "utf8");
const gathererPurchaserEmptyHtml = fs.readFileSync(path.join(__dirname, "fixtures/gatherer-purchaser-empty.html"), "utf8");
const gathererPurchaserPopulatedHtml = fs.readFileSync(path.join(__dirname, "fixtures/gatherer-purchaser-populated.html"), "utf8");

// ─── Direct unit tests of the extraction primitives ────────────────────────

describe("extractTables — nested-table handling", () => {
  it("does not silently truncate results on a page with nested tables (populated fixture)", () => {
    // This is the core regression guard: on the ORIGINAL regex implementation,
    // this fixture produces 9 disconnected fragments and the 10-column header
    // row never survives into any of them. After the Cheerio-based rewrite,
    // extractTables must return the real results table intact, with its full
    // header row present in a single table entry.
    const tables = extractTables(populatedHtml);
    const withFullHeader = tables.find(t =>
      t.some(row => row.some(cell => /api no\.?/i.test(cell)) && row.length >= 10),
    );
    expect(withFullHeader, "expected one extracted table to contain the full 10-column header row").toBeDefined();
  });

  it("strips embedded <select> 'related links' pickers instead of leaking their option text into cell values", () => {
    // Real pattern confirmed live 2026-07-29 on gathererPurchaserQueryAction.do:
    // a lease-number cell contains both the real value (as a link) and a
    // Links/Images <select> dropdown in a nested table. Before the fix,
    // cheerio's .text() walked the <option> text too, producing
    // "52210 Links Images" instead of "52210".
    const html = `<html><body><table>
      <tr><th>Lease No.</th><th>Lease Name</th></tr>
      <tr>
        <td>
          <table><tr>
            <td><a href="#">52210</a></td>
            <td><select name="propertyValue"><option value="" selected="selected">Links</option><option value="...">Images</option></select></td>
          </tr></table>
        </td>
        <td>BRADFORD TRUST A UNIT 2</td>
      </tr>
    </table></body></html>`;
    const table = findDataTable(html, 2);
    expect(table).not.toBeNull();
    expect(table!.rows[0]).toEqual(["52210", "BRADFORD TRUST A UNIT 2"]);
  });
});

describe("findDataTable — populated wellbore fixture", () => {
  it("finds a valid header+rows table instead of returning null", () => {
    const table = findDataTable(populatedHtml, 3);
    expect(table).not.toBeNull();
    expect(table!.rows.length).toBeGreaterThan(0);
  });
});

// ─── Public API tests (searchWellbore) via mocked network ─────────────────

function mockFetchSequence(responses: string[]): void {
  let call = 0;
  globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
    const body = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

describe("searchWellbore — end to end against real fixtures", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves the known real well's identity fields from the populated fixture", async () => {
    // ewaFetch does a session GET then a POST; both calls get the same
    // fixture body here since only the POST response is actually parsed.
    mockFetchSequence(["<html></html>", populatedHtml]);
    const result = await searchWellbore("4215101734");

    expect(result.found, `expected found:true, got message: "${result.message}"`).toBe(true);
    expect(result.district).toBe("7B");
    expect(result.lease_number).toBe("01973");
  });

  it("returns found:false with no fabricated fields on a genuine empty result", async () => {
    mockFetchSequence(["<html></html>", emptyHtml]);
    const result = await searchWellbore("4216550208");

    expect(result.found).toBe(false);
    expect(result.district).toBeNull();
    expect(result.lease_number).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("extracts the full identity record — every column TRRC's wellbore PDQ actually provides", async () => {
    mockFetchSequence(["<html></html>", populatedHtml]);
    const result = await searchWellbore("4215101734");

    expect(result.operator).toBe("AMERICAN ENERGY TEXAS INC");
    expect(result.county).toBe("FISHER");
    expect(result.wells[0]).toMatchObject({
      api_no: "15101734",
      district: "7B",
      lease_no: "01973",
      lease_name: "TEAGARDEN, M. -B-",
      well_no: "2",
      field_name: "ROYSTON",
      operator_name: "AMERICAN ENERGY TEXAS INC",
      county: "FISHER",
      on_schedule: "Y",
      api_depth: "5219",
    });
  });
});

// ─── TRRC internal "Application Error" page detection ──────────────────────
//
// Confirmed live: productionQueryAction.do returned HTTP 200 with TRRC's own
// <title>Expanded Web Access(EWA) - General Exception</title> error page
// instead of real results. Since it's a 200 status and doesn't contain "no
// results found", this previously fell through silently to "no production
// found" / "not found" — a genuine TRRC server error reported identically to
// a confirmed-empty result. This is the exact "failed download != clean
// compliance" violation this whole session has been about, in a new shape.

describe("Application Error page detection", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("searchWellbore reports a real error instead of silently returning not-found", async () => {
    mockFetchSequence(["<html></html>", applicationErrorHtml]);
    const result = await searchWellbore("4215101734");

    expect(result.found).toBe(false);
    expect(result.error, "expected .error to be set so this surfaces as a failure, not confirmed-clean").toBeDefined();
    expect(result.error).toMatch(/Application Error/i);
  });

  it("getProduction reports a real error instead of silently returning 'no production found'", async () => {
    mockFetchSequence([applicationErrorHtml]);
    const result = await getProduction("01973", "7B");

    expect(result.found).toBe(false);
    expect(result.error, "expected .error to be set — a TRRC server error is not the same as confirmed no production").toBeDefined();
    expect(result.error).toMatch(/Application Error/i);
  });

  it("does not false-positive on real populated or empty-result fixtures", () => {
    // Regression guard: the detection string must never appear in genuine
    // TRRC content, only in TRRC's own error page.
    expect(populatedHtml).not.toMatch(/General Exception|Application Error/i);
    expect(emptyHtml).not.toMatch(/General Exception|Application Error/i);
  });
});

// ─── Ambiguous "no results" vs "couldn't parse" disambiguation ─────────────
//
// searchLeaseWells, getWellStatus's lease-type fallback, and getProduction's
// lease-type loop each try multiple lease types (O/G/C) and used to collapse
// "TRRC explicitly said no results" and "we got a 200 response we couldn't
// recognize as a data table" into the same `null`, so a genuine parse
// failure looked identical to a confirmed absence. This is synthetic HTML
// (no real captured fixture reproduces this specific ambiguity), representing
// the general case of an unrecognized 200-status response — not a specific
// TRRC quirk like the nested-table or Application-Error cases, which do have
// real fixtures.

const unparsableHtml = `<html><body><p>An unexpected TRRC page shape that is neither a data table nor the standard empty-result message.</p></body></html>`;

describe("no-results vs parse-failure disambiguation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("searchLeaseWells: genuine 'no results found' still reports found:false with no error", async () => {
    mockFetchSequence(["<html></html>", "no results found"]);
    const result = await searchLeaseWells("01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("searchLeaseWells: an unparsable response now surfaces as a real error, not a confirmed absence", async () => {
    mockFetchSequence(["<html></html>", unparsableHtml]);
    const result = await searchLeaseWells("01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error, "an unrecognized response must not look like confirmed-clean").toBeDefined();
  });

  it("getWellStatus: genuine 'no results found' still reports found:false with no error", async () => {
    mockFetchSequence(["<html></html>", "no results found"]);
    const result = await getWellStatus("4215101734", "01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("getWellStatus: an unparsable response now surfaces as a real error", async () => {
    mockFetchSequence(["<html></html>", unparsableHtml]);
    const result = await getWellStatus("4215101734", "01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("getProduction: genuine 'no results found' still reports found:false with no error", async () => {
    mockFetchSequence(["no results found"]);
    const result = await getProduction("01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("getProduction: an unparsable response now surfaces as a real error, not '0 production months'", async () => {
    mockFetchSequence([unparsableHtml]);
    const result = await getProduction("01973", "7B");
    expect(result.found).toBe(false);
    expect(result.error, "an unrecognized response must not look like confirmed-zero-production").toBeDefined();
  });
});

// ─── getDrillingPermits (S17, W-1) — end to end against real fixtures ─────
//
// drilling-permit-populated.html: real drillingPermitsQueryAction.do response
// for API 42-329-46771 (Chevron, Midland County), captured live. Ground
// truth read directly from the page: 2 permit rows for this API — an
// original "New Drill" filing (Amend: N) and a 2025 amendment (Amend: Y),
// both under the same permit/status number 896719.
//
// drilling-permit-empty.html: real "No results found" response for API
// 42-151-01734 (the wellbore fixture's well) — this well predates the W-1
// system's online records (permits are only online from ~2000 onward),
// so a genuine empty result here is expected, not a retrieval failure.

describe("getDrillingPermits — end to end against real fixtures", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts both permit rows for the known real well, with clean API numbers", async () => {
    mockFetchSequence(["<html></html>", permitPopulatedHtml]);
    const result = await getDrillingPermits("4232946771");

    expect(result.found, `expected found:true, got message: "${result.message}"`).toBe(true);
    expect(result.permits).toHaveLength(2);
    expect(result.permits[0]).toMatchObject({
      api_no: "32946771",
      district: "08",
      lease: "CMC BUTTERCUP 25-37 UNIT",
      well_number: "0371WA",
      permitted_operator: "CHEVRON U. S. A. INC.(148113)",
      county: "MIDLAND",
      status_number: "896719",
      filing_purpose: "New Drill",
      amend: "N",
      status: "APPROVED",
    });
    expect(result.permits[1]).toMatchObject({
      amend: "Y",
      status_number: "896719",
    });
  });

  it("returns found:false with no fabricated permits on a genuine empty result", async () => {
    mockFetchSequence(["<html></html>", permitEmptyHtml]);
    const result = await getDrillingPermits("4215101734");

    expect(result.found).toBe(false);
    expect(result.permits).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

// ─── getGathererPurchaser — real endpoint, real empty-result fixture ──────
//
// gatherer-purchaser-empty.html: a real gathererPurchaserQueryAction.do
// response (district 7C, lease 016582), captured live 2026-07-29. Confirms
// this codebase's prior "P-4 potential test" fetcher was pointed at a
// nonexistent p4QueryAction.do URL — the real, live TRRC endpoint for Form
// P-4 (gatherer/purchaser designation) is gathererPurchaserQueryAction.do,
// a plain server-rendered page, no browser session needed.
//
// gatherer-purchaser-populated.html: a real response for district 08,
// lease 52210 (API 42-329-43003), captured live via an actual completed
// due-diligence run 2026-07-29. This fixture is also what caught a real,
// general bug in extractTables(): TRRC embeds a "related links" <select>
// (Images/Links dropdown) directly inside the lease-number cell, and
// cheerio's .text() walked into its <option> text, turning "52210" into
// "52210 Links Images" — silently corrupting every findDataTable caller
// whenever a cell happens to contain one of these pickers, not just this
// one. Fixed by stripping select/option before extracting cell text.

describe("getGathererPurchaser — real fixtures, empty and populated", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns found:false with no fabricated records on a genuine empty result", async () => {
    mockFetchSequence(["<html></html>", gathererPurchaserEmptyHtml]);
    const result = await getGathererPurchaser("016582", "7C");

    expect(result.found).toBe(false);
    expect(result.records).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/no gatherer\/purchaser/i);
  });

  it("parses real gatherer/purchaser records with clean values, no related-links contamination", async () => {
    mockFetchSequence(["<html></html>", gathererPurchaserPopulatedHtml]);
    const result = await getGathererPurchaser("52210", "08");

    expect(result.found, `expected found:true, got message: "${result.message}"`).toBe(true);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toEqual({
      district: "08",
      lease_no: "52210",
      lease_name: "BRADFORD TRUST A UNIT 2",
      field_no: "85280300",
      field_name: "SPRABERRY (TREND AREA)",
      operator_name: "XTO ENERGY INC.",
      gatherer_purchaser_name: "ETP CRUDE LLC",
      type: "Gatherer",
      oil_gas: "Oil",
      product: "Oil",
    });
  });

  it("requires lease number and district, same as severance/production", async () => {
    const result = await getGathererPurchaser(null, "08");
    expect(result.found).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─── normalizeDistrictForQuery — leading-zero regression guard ────────────
//
// Confirmed live 2026-07-30: searchArgs.districtCodeArg's <select> on both
// severanceQueryAction.do and gathererPurchaserQueryAction.do uses "7C"/"7B"/
// "8A" (no leading zero), not the "07C"/"07B"/"08A" convention used
// elsewhere in this codebase (the frontend's own district dropdown,
// extractDistrictFromApi). Submitting the leading-zero form matched no real
// <option>, so the select silently reset to "None Selected" and the search
// never executed — TRRC returned HTTP 200 with the same blank criteria form
// (no "No Results Found" text either), which findDataTable() then mistook
// for a real, populated results table full of the form's own field labels.
// Real lease 016582/district 7C has 3 genuine P-4 records; before this fix,
// every caller passing "07C" (the normal, correctly-formatted value from
// state.district) got back 7 fabricated "records" like {"choose_one":
// "District:", ...} and a false "success" status instead.
describe("normalizeDistrictForQuery — leading-zero districts", () => {
  it("strips a leading zero when a letter suffix is present", () => {
    expect(normalizeDistrictForQuery("07C")).toBe("7C");
    expect(normalizeDistrictForQuery("07B")).toBe("7B");
    expect(normalizeDistrictForQuery("08A")).toBe("8A");
    expect(normalizeDistrictForQuery("06E")).toBe("6E");
  });

  it("leaves purely-numeric districts unchanged", () => {
    expect(normalizeDistrictForQuery("08")).toBe("08");
    expect(normalizeDistrictForQuery("01")).toBe("01");
    expect(normalizeDistrictForQuery("10")).toBe("10");
  });

  it("leaves already-correct district codes unchanged", () => {
    expect(normalizeDistrictForQuery("7C")).toBe("7C");
    expect(normalizeDistrictForQuery("C1")).toBe("C1");
  });
});

// ─── getProduction — real specificLeaseQueryAction.do structure ───────────
//
// productionQueryAction.do (the old target) was never the right endpoint —
// confirmed live 2026-07-31: it's a broad/statewide multi-lease search form
// with no single-lease field at all, so submitting a lease number to it
// always produced TRRC's "General Exception" page. That had been
// misdiagnosed all along as a TRRC-side outage; it was our own code hitting
// a URL that was never valid for this query shape.
//
// The real per-lease production history lives on specificLeaseQueryAction.do
// (linked directly off productionQueryAction.do: "For information about a
// specific lease, use the Specific Lease Query"), and its real results table
// (class="DataGrid") uses a two-row colspan header confirmed live against
// API 42-151-01734 / lease 01973 / district 7B: "OIL (BBL)" spans
// [Production, Disposition], "Casinghead (MCF)" spans [Production,
// Disposition]. This fixture reproduces that exact structure — not a guess.

const specificLeaseProductionHtml = `<html><body>
<table class="DataGrid">
  <tr><td colspan="9">2 results Page: 1 of 1</td></tr>
  <tr>
    <th rowspan="2">Date</th>
    <th colspan="2">OIL (BBL)</th>
    <th colspan="2">Casinghead (MCF)</th>
    <th rowspan="2">Operator Name</th>
    <th rowspan="2">Operator No.</th>
    <th rowspan="2">Field Name</th>
    <th rowspan="2">Field No.</th>
  </tr>
  <tr><th>Production</th><th>Disposition</th><th>Production</th><th>Disposition</th></tr>
  <tr><td>Apr 2024</td><td>1,200</td><td>1,150</td><td>300</td><td>0</td><td>AMERICAN ENERGY TEXAS INC</td><td>102055</td><td>ROYSTON</td><td>78819001</td></tr>
  <tr><td>May 2024</td><td>871</td><td>800</td><td>256</td><td>0</td><td></td><td></td><td></td><td></td></tr>
  <tr><td>Jun 2024</td><td>NO RPT</td><td>NO RPT</td><td>NO RPT</td><td>NO RPT</td><td></td><td></td><td></td><td></td></tr>
  <tr><td>Total</td><td>2,071</td><td>1,950</td><td>556</td><td>0</td><td></td><td></td><td></td><td></td></tr>
</table>
</body></html>`;

describe("getProduction — real specificLeaseQueryAction.do table structure", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses the real colspan-nested DataGrid table, using the Production sub-column not Disposition", async () => {
    mockFetchSequence(["<html></html>", specificLeaseProductionHtml]);
    const result = await getProduction("01973", "7B");

    expect(result.found, `expected found:true, got message: "${result.message}"`).toBe(true);
    expect(result.rows).toEqual([
      { production_month: "2024-04", oil_bbl: 1200, gas_mcf: null, casinghead_gas_mcf: 300, condensate_bbl: null, water_bbl: null },
      { production_month: "2024-05", oil_bbl: 871,  gas_mcf: null, casinghead_gas_mcf: 256, condensate_bbl: null, water_bbl: null },
      { production_month: "2024-06", oil_bbl: null, gas_mcf: null, casinghead_gas_mcf: null, condensate_bbl: null, water_bbl: null },
    ]);
  });

  it("skips the Total row and any non-date rows", async () => {
    mockFetchSequence(["<html></html>", specificLeaseProductionHtml]);
    const result = await getProduction("01973", "7B");
    expect(result.rows.some(r => r.production_month === undefined)).toBe(false);
    expect(result.rows).toHaveLength(3);
  });
});

// ─── Backward-compatibility regression guard ───────────────────────────────
//
// No real captured fixture is available for the other eight findDataTable
// callers (searchOperator, getWellStatus, getInactiveWellStatus,
// getSeveranceRecords, getP4Tests, getCompletionRecords, getPluggingRecords,
// getInjectionRecords) with actual matching rows — every real page captured
// tonight was either this wellbore page or a confirmed-empty result. This
// test does NOT stand in for that missing coverage; it only proves the
// header-selection change (nonEmpty[0] -> first row >= minCols) is a strict
// generalization: on a simple table where the header genuinely is row 0
// (the structure findDataTable was originally written against, and the
// most likely shape for pages without wellbore's per-cell action-link
// layout), headerIdx must still resolve to 0 and behavior must be identical
// to before.

describe("findDataTable — backward compatibility on a simple (non-nested) table", () => {
  it("still finds the header at row 0 when no preamble row precedes it", () => {
    const simple = `
      <table>
        <tr><th>Operator Name</th><th>Operator No</th><th>P5 Status</th></tr>
        <tr><td>EXAMPLE OPERATING CO</td><td>123456</td><td>ACTIVE</td></tr>
      </table>
    `;
    const table = findDataTable(simple, 3);
    expect(table).not.toBeNull();
    expect(table!.header).toEqual(["Operator Name", "Operator No", "P5 Status"]);
    expect(table!.rows).toEqual([["EXAMPLE OPERATING CO", "123456", "ACTIVE"]]);
  });
});

// ─── getGisLocation — real ArcGIS schema regression guard ──────────────────
//
// Live-tested directly against TRRC's ArcGIS server on 2026-07-27: the
// well-location query filtered on a field named "API8" that doesn't
// exist (the real field is "API"), so it 400'd on every call — and the
// response-handling code treated any response without a `features` array,
// including an ArcGIS error body, as a confirmed empty result. The
// survey/alert-area queries had the same problem plus a structural one:
// those are polygon layers with no API field at all, so they need a
// spatial point-in-polygon query using the well's own coordinates, not an
// attribute filter. These fixtures are real captured responses for API
// 42-329-46771 (the Chevron/Midland well used throughout tonight's W-1
// work) — ground truth confirmed live, not guessed.

function mockFetchJsonSequence(bodies: string[]): void {
  let call = 0;
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => JSON.parse(body),
      text: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

describe("getGisLocation — real ArcGIS schema regression guard", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves real coordinates and well type for a well genuinely in the GIS database", async () => {
    mockFetchJsonSequence([gisWellFoundJson, gisAlertAreasJson, gisSurveyJson]);
    const result = await getGisLocation("4232946771");

    expect(result.found, `expected found:true, got message: "${result.message}"`).toBe(true);
    expect(result.latitude).toBeCloseTo(31.6687, 3);
    expect(result.longitude).toBeCloseTo(-101.9487, 3);
    expect(result.well_type).toBe("Oil Well");
  });

  it("resolves survey polygons via a spatial query, not a nonexistent API attribute filter", async () => {
    mockFetchJsonSequence([gisWellFoundJson, gisAlertAreasJson, gisSurveyJson]);
    const result = await getGisLocation("4232946771");

    expect(result.survey).not.toBeNull();
    expect(result.survey!.abstract_number).toBe("329236");
    expect(result.survey!.survey_name).toBe("T&P RR CO");
    expect(result.survey!.block_number).toBe("39 T4S");
  });

  it("returns found:false with no fabricated coordinates on a genuine empty result", async () => {
    mockFetchJsonSequence([gisWellEmptyJson]);
    const result = await getGisLocation("4299999999");

    expect(result.found).toBe(false);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.error).toBeUndefined();
  });
});

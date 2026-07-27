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
import { extractTables, findDataTable, searchWellbore, getProduction, searchLeaseWells, getWellStatus } from "../ewa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const populatedHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-populated.html"), "utf8");
const emptyHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-empty.html"), "utf8");
const applicationErrorHtml = fs.readFileSync(path.join(__dirname, "fixtures/trrc-application-error.html"), "utf8");

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

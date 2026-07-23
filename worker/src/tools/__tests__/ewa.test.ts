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
import { extractTables, findDataTable, searchWellbore } from "../ewa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const populatedHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-populated.html"), "utf8");
const emptyHtml = fs.readFileSync(path.join(__dirname, "fixtures/wellbore-empty.html"), "utf8");

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

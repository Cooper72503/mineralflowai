/**
 * Tests for the pure helper functions inside supabase/functions/trrc-dd-execute/index.ts.
 *
 * Those functions are module-private Deno code — they cannot be imported here.
 * We copy their implementations verbatim and test them in a Node/Vitest context.
 * If the edge function's helpers change, these tests must be kept in sync.
 *
 * Functions covered:
 *   splitApi, extractText, extractTableRows, isNoiseRow, isHeaderRow,
 *   formBody, buildCoverageFromAttempts
 *
 * Run: npx vitest run lib/trrc/__tests__/edge-function-helpers.test.ts
 */

import { describe, it, expect } from "vitest";

// ─── Copied helpers (verbatim from edge function) ─────────────────────────────

function splitApi(apiRaw: string): { prefix: string; suffix: string } | null {
  const digits = apiRaw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return { prefix: digits.slice(2, 5), suffix: digits.slice(5, 10) };
}

function extractText(html: string, maxLen = 4000): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function extractTableRows(html: string, maxRows = 50): string[][] {
  const rows: string[][] = [];
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rowMatches) {
    const cells: string[] = [];
    const cellMatches = row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
    for (const cell of cellMatches) {
      cells.push(cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    }
    if (cells.length > 0) rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

const NOISE_PATTERNS: RegExp[] = [
  /function\s+\w+\s*\(/,
  /doSearch/,
  /Please\s+[Cc]orrect/,
  /Oil\s+&\s+Gas\s+Data\s+Query/i,
  /Search\s+Criteria/i,
  /Inactivity:\s*None/i,
  /Or\s+Search\s+by/i,
  /Links\s+Images\s+GIS/i,
  /Page:\s*\d+\s+of\s+\d+/i,
];

function isNoiseRow(row: string[]): boolean {
  if (row.every(c => !c.trim() || c === "&nbsp;")) return true;
  const joined = row.join(" ");
  return NOISE_PATTERNS.some(p => p.test(joined));
}

function isHeaderRow(
  row: string[],
  minCols = 3,
  kw: RegExp = /API|District|Lease|Operator|Aging|Inactive|Field|Depth|Potential|Allowable|Orphan|Severance|Formation|County/i,
): boolean {
  if (row.length < minCols) return false;
  const matches = row.filter(c => c.length > 0 && c.length <= 50 && kw.test(c));
  return matches.length >= 2;
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

interface CoverageEntry {
  category: string;
  label: string;
  status: "complete" | "partial" | "retrieval_failed" | "manual_required" | "no_applicable_record" | "not_checked";
  records_found: number;
  data_current_through: string | null;
  sources_checked: string[];
  notes: string | null;
}

const TOOL_COVERAGE_MAP: Record<string, { category: string; label: string }> = {
  search_by_api:             { category: "wellbore_identity",  label: "Well Identity (API Lookup)" },
  search_by_lease:           { category: "lease_inventory",    label: "Lease Inventory" },
  search_by_operator:        { category: "operator_p5",        label: "Operator / P5 Organization" },
  search_by_legal_description:{ category: "legal_description", label: "Legal Description (GIS)" },
  fetch_production:          { category: "production",         label: "Production History (Proration Proxy)" },
  fetch_completion_records:  { category: "completion",         label: "Completion Records (W-2)" },
  fetch_well_status:         { category: "well_status",        label: "Well Status (Active/Inactive/Plugged)" },
  fetch_inactive_well_status:{ category: "inactive_well",      label: "Inactive Well Aging Report (IWAR)" },
  fetch_orphan_well:         { category: "orphan_well",        label: "Orphan Well / P5 Insolvent Operator" },
  fetch_plugging_records:    { category: "plugging",           label: "Plugging Records (W-3C)" },
  fetch_compliance_violations:{ category: "compliance",        label: "Compliance Violations" },
  fetch_p4_records:          { category: "p4_records",         label: "P-4 Production Test Records" },
  fetch_proration:           { category: "proration",          label: "Proration Schedule / Daily Allowable" },
  fetch_injection_records:   { category: "injection",          label: "UIC / Injection Well Records" },
  fetch_severance_records:   { category: "severance",          label: "Wellbore Severance Records" },
  fetch_imaged_records:      { category: "imaged_records",     label: "Imaged Document Packets (CMPL)" },
};

function buildCoverageFromAttempts(
  attempts: Array<{ source_name: string; status: string; result_count: number; result_data_json?: unknown }>,
): CoverageEntry[] {
  // Mirrors the edge function exactly: uses the LAST attempt per tool so that
  // Phase 3 rescue runs (search_by_lease, search_by_operator) override Phase 1.
  return Object.entries(TOOL_COVERAGE_MAP).map(([toolName, { category, label }]) => {
    const attempt = [...attempts].reverse().find(a => a.source_name === toolName);
    if (!attempt) return { category, label, status: "not_checked" as const, records_found: 0, data_current_through: null, sources_checked: [], notes: null };

    const data      = (attempt.result_data_json ?? {}) as Record<string, unknown>;
    const found     = data["found"] === true;
    const dataGap   = data["data_gap"] === true;
    const isSuccess = attempt.status === "success";
    const count     = attempt.result_count ?? 0;

    let status: CoverageEntry["status"];
    if (dataGap)                    status = "manual_required";
    else if (!isSuccess)            status = "retrieval_failed";
    else if (!found && count === 0) status = "no_applicable_record";
    else if (count > 0 || found)    status = "complete";
    else                            status = "partial";

    return {
      category,
      label,
      status,
      records_found:        count,
      data_current_through: new Date().toISOString().slice(0, 10),
      sources_checked:      [toolName],
      notes: typeof data["note"]  === "string" ? data["note"]
           : typeof data["error"] === "string" ? data["error"]
           : null,
    };
  });
}

// ─── splitApi ─────────────────────────────────────────────────────────────────

describe("splitApi", () => {
  it("splits a plain 10-digit Texas API number", () => {
    const result = splitApi("4216502733");
    expect(result).toEqual({ prefix: "165", suffix: "02733" });
  });

  it("splits a dashed API: 42-165-02733", () => {
    const result = splitApi("42-165-02733");
    expect(result).toEqual({ prefix: "165", suffix: "02733" });
  });

  it("handles 14-digit UWI by using first 10 digits", () => {
    const result = splitApi("42165027330000");
    expect(result).toEqual({ prefix: "165", suffix: "02733" });
  });

  it("returns null for fewer than 10 digits", () => {
    expect(splitApi("42165")).toBeNull();
    expect(splitApi("")).toBeNull();
    expect(splitApi("123456789")).toBeNull();
  });

  it("strips all non-digit characters before splitting", () => {
    const result = splitApi("42.165.02733");
    expect(result).toEqual({ prefix: "165", suffix: "02733" });
  });

  it("handles leading state code 42 correctly for different counties", () => {
    // County 003 = Andrews
    expect(splitApi("4200301234")).toEqual({ prefix: "003", suffix: "01234" });
    // County 501 = hypothetical
    expect(splitApi("4250100001")).toEqual({ prefix: "501", suffix: "00001" });
  });
});

// ─── extractText ──────────────────────────────────────────────────────────────

describe("extractText", () => {
  it("strips HTML tags and returns visible text", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    expect(extractText(html)).toContain("Hello");
    expect(extractText(html)).toContain("world");
    expect(extractText(html)).not.toContain("<");
  });

  it("removes script contents", () => {
    const html = "<div>Data</div><script>alert('xss')</script>";
    expect(extractText(html)).not.toContain("alert");
    expect(extractText(html)).toContain("Data");
  });

  it("removes style contents", () => {
    const html = "<div>Text</div><style>body { color: red; }</style>";
    expect(extractText(html)).not.toContain("color: red");
    expect(extractText(html)).toContain("Text");
  });

  it("respects the maxLen parameter", () => {
    const html = "<p>" + "A".repeat(10000) + "</p>";
    const result = extractText(html, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("collapses multiple whitespace into single space", () => {
    const html = "<td>  foo   </td>  <td>  bar  </td>";
    const result = extractText(html);
    expect(result).not.toMatch(/  /); // no double spaces
  });
});

// ─── extractTableRows ────────────────────────────────────────────────────────

describe("extractTableRows", () => {
  it("extracts simple table rows with td cells", () => {
    const html = "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
    const rows = extractTableRows(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["A", "B"]);
    expect(rows[1]).toEqual(["C", "D"]);
  });

  it("extracts th header cells", () => {
    const html = "<tr><th>Name</th><th>Value</th></tr>";
    const rows = extractTableRows(html);
    expect(rows[0]).toEqual(["Name", "Value"]);
  });

  it("respects maxRows limit", () => {
    const rowHtml = Array.from({ length: 10 }, (_, i) => `<tr><td>${i}</td></tr>`).join("");
    const rows = extractTableRows(`<table>${rowHtml}</table>`, 5);
    expect(rows).toHaveLength(5);
  });

  it("strips inner HTML from cell content", () => {
    const html = "<tr><td><a href='#'>Link Text</a></td></tr>";
    const rows = extractTableRows(html);
    expect(rows[0][0]).toContain("Link Text");
    expect(rows[0][0]).not.toContain("<a");
  });

  it("returns empty array for HTML with no tables", () => {
    const rows = extractTableRows("<div>No tables here</div>");
    expect(rows).toHaveLength(0);
  });
});

// ─── isNoiseRow ───────────────────────────────────────────────────────────────

describe("isNoiseRow", () => {
  it("marks a row of blank/nbsp cells as noise", () => {
    expect(isNoiseRow(["", "&nbsp;", ""])).toBe(true);
  });

  it("marks a row containing JS function syntax as noise", () => {
    expect(isNoiseRow(["function doSearch(x) {", "foo"])).toBe(true);
  });

  it("marks a row with 'Please Correct' error message as noise", () => {
    expect(isNoiseRow(["Please Correct the following", "API number"])).toBe(true);
  });

  it("marks EWA navigation rows as noise", () => {
    expect(isNoiseRow(["Links Images GIS Data"])).toBe(true);
  });

  it("marks pagination rows as noise", () => {
    expect(isNoiseRow(["Page: 1 of 5", "Next"])).toBe(true);
  });

  it("does NOT mark a normal data row as noise", () => {
    expect(isNoiseRow(["42-165-02733", "04", "12345", "Test Operator"])).toBe(false);
  });

  it("does NOT mark a header row as noise", () => {
    expect(isNoiseRow(["API No.", "District", "Lease No.", "Operator"])).toBe(false);
  });
});

// ─── isHeaderRow ─────────────────────────────────────────────────────────────

describe("isHeaderRow", () => {
  it("identifies a row with API and District as a header", () => {
    expect(isHeaderRow(["API No.", "District", "Lease", "Operator"])).toBe(true);
  });

  it("identifies a row with Lease and Operator as a header", () => {
    expect(isHeaderRow(["Lease No.", "Operator", "County"])).toBe(true);
  });

  it("rejects a row with fewer than minCols columns", () => {
    expect(isHeaderRow(["API", "District"], 3)).toBe(false);
  });

  it("rejects a row with no matching keywords", () => {
    expect(isHeaderRow(["X", "Y", "Z"])).toBe(false);
  });

  it("rejects a row where header cells are too long (> 50 chars)", () => {
    const longHeader = "A".repeat(60);
    expect(isHeaderRow([longHeader, "API", "District"], 3)).toBe(true); // still has 2 short keywords
    expect(isHeaderRow([longHeader, "B".repeat(55), "C".repeat(55)], 3)).toBe(false);
  });

  it("uses custom keyword regex when provided", () => {
    const result = isHeaderRow(["UIC No.", "Well No.", "Permit"], 3, /UIC|Well\s+No|Permit/i);
    expect(result).toBe(true);
  });
});

// ─── formBody ────────────────────────────────────────────────────────────────

describe("formBody", () => {
  it("encodes a simple key-value pair", () => {
    expect(formBody({ foo: "bar" })).toBe("foo=bar");
  });

  it("encodes multiple params with & separator", () => {
    const body = formBody({ a: "1", b: "2" });
    expect(body.split("&")).toHaveLength(2);
    expect(body).toContain("a=1");
    expect(body).toContain("b=2");
  });

  it("URL-encodes special characters in keys and values", () => {
    const body = formBody({ "search arg": "value with space&special" });
    expect(body).toContain("search%20arg");
    expect(body).toContain("value%20with%20space%26special");
  });

  it("encodes EWA search parameter names correctly", () => {
    const body = formBody({
      "searchArgs.apiNoPrefixArg": "165",
      "searchArgs.apiNoSuffixArg": "02733",
      "methodToCall": "search",
    });
    expect(body).toContain("methodToCall=search");
    expect(body).toContain("02733");
    expect(body).toContain("165");
  });

  it("handles empty params object", () => {
    expect(formBody({})).toBe("");
  });
});

// ─── buildCoverageFromAttempts ────────────────────────────────────────────────

describe("buildCoverageFromAttempts", () => {
  it("returns not_checked for every tool that was not attempted", () => {
    const coverage = buildCoverageFromAttempts([]);
    const notChecked = coverage.filter(c => c.status === "not_checked");
    expect(notChecked.length).toBe(Object.keys(TOOL_COVERAGE_MAP).length);
  });

  it("marks a successful attempt with records as complete", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "search_by_api", status: "success", result_count: 1, result_data_json: { found: true } },
    ]);
    const entry = coverage.find(c => c.category === "wellbore_identity");
    expect(entry?.status).toBe("complete");
    expect(entry?.records_found).toBe(1);
  });

  it("marks a failed attempt as retrieval_failed", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "fetch_production", status: "failed_transient", result_count: 0, result_data_json: { error: "timeout" } },
    ]);
    const entry = coverage.find(c => c.category === "production");
    expect(entry?.status).toBe("retrieval_failed");
    expect(entry?.notes).toContain("timeout");
  });

  it("marks a data-gap attempt as manual_required", () => {
    // compliance violations always returns data_gap: true (ICE portal not accessible via proxy)
    const coverage = buildCoverageFromAttempts([
      { source_name: "fetch_compliance_violations", status: "success", result_count: 0, result_data_json: { data_gap: true } },
    ]);
    const entry = coverage.find(c => c.category === "compliance");
    expect(entry?.status).toBe("manual_required");
  });

  it("marks found=false as no_applicable_record", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "fetch_orphan_well", status: "success", result_count: 0, result_data_json: { found: false, note: "Not an orphan well." } },
    ]);
    const entry = coverage.find(c => c.category === "orphan_well");
    expect(entry?.status).toBe("no_applicable_record");
    expect(entry?.notes).toContain("Not an orphan well.");
  });

  it("uses the last attempt per category — Phase 3 rescue result wins over Phase 1", () => {
    // Phase 1 fails, Phase 3 rescue succeeds — last result should win
    const coverage = buildCoverageFromAttempts([
      { source_name: "search_by_api", status: "failed_transient", result_count: 0, result_data_json: { error: "timeout" } },
      { source_name: "search_by_api", status: "success",          result_count: 3, result_data_json: { found: true } },
    ]);
    const entries = coverage.filter(c => c.category === "wellbore_identity");
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("complete"); // last attempt (success) wins
  });

  it("submit_report is ignored in coverage", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "submit_report", status: "success", result_count: 0, result_data_json: {} },
    ]);
    const entry = coverage.find(c => c.category === "submit_report");
    expect(entry).toBeUndefined();
  });

  it("unknown tool names are silently ignored", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "nonexistent_tool", status: "success", result_count: 5, result_data_json: {} },
    ]);
    // Coverage should still contain all 'not_checked' entries for real tools
    const notChecked = coverage.filter(c => c.status === "not_checked");
    expect(notChecked.length).toBe(Object.keys(TOOL_COVERAGE_MAP).length);
  });

  it("all coverage entries have a data_current_through date or null", () => {
    const coverage = buildCoverageFromAttempts([
      { source_name: "search_by_api", status: "success", result_count: 1, result_data_json: { found: true } },
    ]);
    for (const entry of coverage) {
      expect(entry.data_current_through === null || typeof entry.data_current_through === "string").toBe(true);
    }
  });
});

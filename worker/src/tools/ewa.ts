/**
 * EWA Tools — direct fetch to webapps2.rrc.texas.gov
 * No proxy needed on the droplet — Node.js OpenSSL handles RSA TLS fine.
 */

import * as cheerio from "cheerio";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
const PDA_BASE = "https://webapps2.rrc.texas.gov/PDA";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// The district codes surfaced elsewhere in this codebase (the frontend's own
// dropdown, extractDistrictFromApi, etc.) use a leading zero for single-digit
// districts even when they carry a letter suffix — "07B", "07C", "08A". The
// searchArgs.districtCodeArg <select> on these plain server-rendered EWA
// query pages does not: confirmed live against both severanceQueryAction.do
// and gathererPurchaserQueryAction.do, their district <option> values are
// "7B"/"7C"/"8A", not "07B"/"07C"/"08A". Submitting "07C" matches no real
// option, so the select silently resets to "None Selected" and the search
// never actually executes — TRRC re-renders the same blank criteria form
// (HTTP 200, no "No Results Found" text either) instead of erroring, which
// looked exactly like a successful, populated result until inspected: this
// codebase's generic findDataTable() picked up the form's own layout table
// and fabricated "records" out of field labels like "District:"/"Choose
// One:". Purely-numeric districts ("08") do keep the leading zero on both
// sides, so only strip it when a letter suffix is present.
export function normalizeDistrictForQuery(district: string): string {
  return district.replace(/^0([1-9][A-Za-z])$/, "$1");
}

// TRRC's EWA app sometimes fails with its own internal error page instead of
// a raw HTTP error status — confirmed live: productionQueryAction.do returned
// HTTP 200 with <title>Expanded Web Access(EWA) - General Exception</title>
// and body text "Application Error... Error Report Number: ...". Since it's
// a 200 and doesn't match "no results found", this silently fell through to
// findDataTable (which correctly found no table and returned null), making a
// genuine TRRC server error indistinguishable from a confirmed-empty result.
// Treat it as a real failure, the same as a non-2xx HTTP status.
function isTrrcApplicationError(html: string): boolean {
  return /General Exception|Application Error/i.test(html);
}

function assertNotTrrcApplicationError(html: string, path: string): void {
  if (isTrrcApplicationError(html)) {
    throw new Error(`EWA ${path} returned a TRRC internal Application Error page`);
  }
}

async function ewaFetch(path: string, params?: Record<string, string>, cookies?: string): Promise<string> {
  const url = `${EWA_BASE}/${path}`;

  // GET-only path — no session needed
  if (!params) {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`EWA ${path} returned HTTP ${res.status}`);
    const html = await res.text();
    assertNotTrrcApplicationError(html, path);
    return html;
  }

  // POST path — establish a JSESSIONID session first if no caller-supplied cookie
  let sessionCookie = cookies ?? null;
  let viewState = "";

  if (!sessionCookie) {
    const sessionRes = await fetch(url, {
      headers: { ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(20_000),
    });
    if (!sessionRes.ok) throw new Error(`EWA ${path} session GET returned HTTP ${sessionRes.status}`);
    const sessionHtml = await sessionRes.text();
    const jSessionMatch = sessionRes.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
    sessionCookie = jSessionMatch ? `JSESSIONID=${jSessionMatch[1]}` : null;
    const viewStateMatch = sessionHtml.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    viewState = viewStateMatch?.[1] ?? "";
  }

  const postUrl = sessionCookie
    ? `${url};jsessionid=${sessionCookie.replace("JSESSIONID=", "")}`
    : url;

  const res = await fetch(postUrl, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: formBody({
      ...params,
      ...(viewState ? { "javax.faces.ViewState": viewState } : {}),
      methodToCall: "search",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`EWA ${path} returned HTTP ${res.status}`);
  const html = await res.text();
  assertNotTrrcApplicationError(html, path);
  return html;
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────
//
// Cheerio-based (real DOM tree), not regex. TRRC's EWA pages are built with
// deeply nested layout tables, and per-cell nested tables for columns that
// carry an action-link dropdown (e.g. wellbore PDQ's API No. and Lease No.
// columns). A regex like /<table>([\s\S]*?)<\/table>/ has no concept of
// nesting — its non-greedy match stops at the FIRST </table> regardless of
// whether that's the real closing tag for the one it opened on, silently
// truncating or fragmenting every nested table on the page. `.children()`
// in Cheerio always means direct children only, so a table's own rows are
// never confused with a nested table's rows, no matter how deep the nesting.

// Exported for direct unit testing against real captured fixtures — not
// used by any other module.
export function extractTables(html: string): string[][][] {
  const $ = cheerio.load(html);
  const tables: string[][][] = [];

  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    // A table's own rows are its direct <tr> children, or <tr> children of
    // a direct-child <tbody>/<thead>/<tfoot> — never rows belonging to a
    // table nested inside one of this table's own cells.
    const directRows = $table.children("tr").toArray();
    const containerRows = $table.children("tbody, thead, tfoot").toArray()
      .flatMap(container => $(container).children("tr").toArray());
    const rowEls = [...directRows, ...containerRows];

    const rows: string[][] = [];
    for (const rowEl of rowEls) {
      const $row = $(rowEl);
      const cellEls = $row.children("td, th").toArray();
      const cells = cellEls.map(cellEl => {
        // TRRC embeds "related links" <select> pickers (e.g. a lease's
        // Images/Links dropdown) directly inside data cells alongside the
        // real value. cheerio's .text() walks all descendants including
        // <option> text, so a lease-number cell like
        // "<a>52210</a> <select><option>Links</option><option>Images</option></select>"
        // silently became "52210 Links Images" -- confirmed live 2026-07-29
        // on gathererPurchaserQueryAction.do. Strip select/option before
        // extracting text; this is a shared parser, so the fix applies to
        // every findDataTable caller, not just gatherer/purchaser.
        const $cell = $(cellEl).clone();
        $cell.find("select, option").remove();
        return $cell.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
      });
      if (cells.some(c => c.length > 0)) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  });

  return tables;
}

export function findDataTable(html: string, minCols: number): { header: string[]; rows: string[][] } | null {
  const tables = extractTables(html);
  for (const table of tables) {
    const nonEmpty = table.filter(r => r.some(c => c.length > 0));
    if (nonEmpty.length < 2) continue;
    // The header isn't always row 0 — some TRRC results tables prefix the
    // real header with a one-cell pagination/toolbar row (e.g. "1 results /
    // Page 1 of 1 / Page Size"). Use the first row wide enough to plausibly
    // BE a header rather than assuming it's always the first row; this is a
    // strict generalization of the old "row 0 is the header" behavior — for
    // pages where row 0 already meets minCols, headerIdx is still 0.
    const headerIdx = nonEmpty.findIndex(r => r.length >= minCols);
    if (headerIdx === -1) continue;
    const header = nonEmpty[headerIdx];
    const rows = nonEmpty.slice(headerIdx + 1).filter(r =>
      r.some(c => c.length > 0) &&
      !r.every(c => /^[A-Z\s]+:?$/.test(c) || c.length === 0)
    );
    if (rows.length > 0) return { header, rows };
  }
  return null;
}

function rowsToObjects(header: string[], rows: string[][]): Record<string, string>[] {
  const keys = header.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/g, ""));
  return rows.map(row => {
    const obj: Record<string, string> = {};
    keys.forEach((k, i) => { obj[k] = row[i] ?? ""; });
    return obj;
  });
}

function splitApi(api: string): { prefix: string; suffix: string } | null {
  const d = api.replace(/\D/g, "");
  if (d.length < 10) return null;
  return { prefix: d.slice(2, 5), suffix: d.slice(5, 10) };
}

// Some wellbore PDQ columns (API No., Lease No.) wrap their value in a
// nested per-cell <table> alongside an action-link dropdown ("Links /
// Images / GIS Viewer / Completion"), so cell text for those two columns
// comes back noisy (e.g. "01973 Links Images"). The real, clean values are
// present as query parameters on the row's own leaseDetailAction.do link —
// pull them from there instead of trusting cell-text position for these
// specific identifiers.
function extractLeaseDetailIdentifiers(html: string): { apiNo: string | null; distCode: string | null; leaseNo: string | null } | null {
  const $ = cheerio.load(html);
  const link = $('a[href*="leaseDetailAction.do"]').first();
  const href = link.attr("href");
  if (!href) return null;
  const qs = new URLSearchParams(href.split("?")[1] ?? "");
  return {
    apiNo: qs.get("apiNo"),
    distCode: qs.get("distCode"),
    leaseNo: qs.get("leaseNo"),
  };
}

// ─── S1 — Wellbore Identity ───────────────────────────────────────────────────

export async function searchWellbore(apiNumber: string): Promise<{
  found: boolean;
  wells: Record<string, string>[];
  lease_number: string | null;
  district: string | null;
  operator: string | null;
  operator_number: string | null;
  county: string | null;
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, wells: [], lease_number: null, district: null, operator: null, operator_number: null, county: null, message: "Invalid API number format", error: "Invalid API number format" };

  try {
    const html = await ewaFetch("wellboreQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
      "searchArgs.scheduleTypeArg": "Both",
    });

    if (/no results found/i.test(html)) {
      return { found: false, wells: [], lease_number: null, district: null, operator: null, operator_number: null, county: null, message: `42-${split.prefix}-${split.suffix} not found in wellbore PDQ` };
    }

    const table = findDataTable(html, 3);
    if (!table) return { found: false, wells: [], lease_number: null, district: null, operator: null, operator_number: null, county: null, message: "Could not parse wellbore response", error: "Could not parse wellbore response" };

    const wells = rowsToObjects(table.header, table.rows.slice(0, 20));

    // Prefer the clean, href-derived identifiers for the first well over
    // its possibly action-link-noisy cell text.
    const ids = extractLeaseDetailIdentifiers(html);
    if (ids && wells[0]) {
      if (ids.apiNo)    wells[0]["api_no"]   = ids.apiNo;
      if (ids.leaseNo)  wells[0]["lease_no"] = ids.leaseNo;
      if (ids.distCode) wells[0]["district"] = ids.distCode;
    }

    const first = wells[0] ?? {};
    return {
      found: true,
      wells,
      lease_number:    ids?.leaseNo || first["lease_no"]      || first["oil_lease_no"]  || null,
      district:        ids?.distCode || first["dist_code"]     || first["district"]       || null,
      operator:        first["operator_name"] || first["operator"]       || null,
      operator_number: first["operator_no"]   || first["operator_number"]|| null,
      county:          first["county"]        || null,
      message:         `Found ${wells.length} wellbore(s) for 42-${split.prefix}-${split.suffix}`,
    };
  } catch (e) {
    return { found: false, wells: [], lease_number: null, district: null, operator: null, operator_number: null, county: null, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S2 — Lease Well Inventory ────────────────────────────────────────────────

// A "not found" tryLeaseType result and a "found a response we couldn't
// parse" result used to both collapse to `null`, so a genuine parse
// failure on one lease type silently looked identical to a confirmed
// absence, same as this function's overall result once all three lease
// types had been tried. Distinguishing them means a real failure surfaces
// as .error instead of "no wells found," even if some of the other lease
// types genuinely came back empty.
type LeaseTypeResult =
  | { status: "found"; table: { header: string[]; rows: string[][] } }
  | { status: "not_found" }
  | { status: "parse_failed" };

export async function searchLeaseWells(leaseNumber: string, district: string): Promise<{
  found: boolean;
  wells: Record<string, string>[];
  message: string;
  error?: string;
}> {
  const tryLeaseType = async (lt: string): Promise<LeaseTypeResult> => {
    const html = await ewaFetch("leaseWellQueryAction.do", {
      "searchArgs.leaseNumberArg":  leaseNumber,
      "searchArgs.districtCodeArg": normalizeDistrictForQuery(district),
      "searchArgs.leaseTypeArg":    lt,
    });
    if (/no results found/i.test(html)) return { status: "not_found" };
    const table = findDataTable(html, 2);
    if (!table) return { status: "parse_failed" };
    return { status: "found", table };
  };

  try {
    let anyParseFailed = false;
    for (const lt of ["O", "G", "C"]) {
      const result = await tryLeaseType(lt);
      if (result.status === "found") {
        const wells = rowsToObjects(result.table.header, result.table.rows.slice(0, 50));
        return { found: true, wells, message: `${wells.length} wells on lease ${leaseNumber} district ${district} (${lt})` };
      }
      if (result.status === "parse_failed") anyParseFailed = true;
    }
    if (anyParseFailed) {
      const msg = `Could not parse lease well response for lease ${leaseNumber} district ${district} on at least one lease type`;
      return { found: false, wells: [], message: msg, error: msg };
    }
    return { found: false, wells: [], message: `No wells found for lease ${leaseNumber} district ${district}` };
  } catch (e) {
    return { found: false, wells: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S3 — Operator / P-5 ─────────────────────────────────────────────────────
//
// Moved to browser.ts's searchOperator() — the real TRRC search requires a
// dojo/JSF AJAX-driven picker flow (organizationQueryAction.do has no
// operatorNameArg/operatorNoArg fields at all) that a plain fetch cannot
// replicate. See the doc comment there for the full investigation.

// ─── S4 — Well Status ─────────────────────────────────────────────────────────

export async function getWellStatus(apiNumber: string, leaseNumber?: string | null, district?: string | null): Promise<{
  found: boolean;
  status: string | null;
  records: Record<string, string>[];
  lease_number: string | null;
  district: string | null;
  message: string;
  error?: string;
}> {
  const tryQuery = async (params: Record<string, string>): Promise<LeaseTypeResult> => {
    const html = await ewaFetch("wellStatusQueryAction.do", params);
    if (/no results found/i.test(html)) return { status: "not_found" };
    const table = findDataTable(html, 2);
    if (!table) return { status: "parse_failed" };
    return { status: "found", table };
  };

  try {
    let anyParseFailed = false;

    // Try by API first
    const split = splitApi(apiNumber);
    if (split) {
      const result = await tryQuery({
        "searchArgs.apiNoPrefixArg": split.prefix,
        "searchArgs.apiNoSuffixArg": split.suffix,
      });
      if (result.status === "found") {
        const records = rowsToObjects(result.table.header, result.table.rows.slice(0, 20));
        const first = records[0] ?? {};
        const statusVal = first["well_status"] || first["status"] || null;
        const leaseVal  = first["lease_no"]    || first["oil_lease_no"] || leaseNumber || null;
        const distVal   = first["dist_code"]   || first["district"]     || district    || null;
        return { found: true, status: statusVal, records, lease_number: leaseVal, district: distVal, message: `Well status: ${statusVal ?? "unknown"}` };
      }
      if (result.status === "parse_failed") anyParseFailed = true;
    }

    // Fall back to lease + district
    if (leaseNumber && district) {
      for (const lt of ["O", "G"]) {
        const result = await tryQuery({
          "searchArgs.leaseNumberArg":  leaseNumber,
          "searchArgs.districtCodeArg": normalizeDistrictForQuery(district),
          "searchArgs.leaseTypeArg":    lt,
        });
        if (result.status === "found") {
          const records = rowsToObjects(result.table.header, result.table.rows.slice(0, 20));
          const first = records[0] ?? {};
          return { found: true, status: first["well_status"] || null, records, lease_number: leaseNumber, district, message: `Well status via lease: ${first["well_status"] ?? "unknown"}` };
        }
        if (result.status === "parse_failed") anyParseFailed = true;
      }
    }

    if (anyParseFailed) {
      const msg = `Could not parse well status response for API ${apiNumber}${leaseNumber ? ` / lease ${leaseNumber}` : ""}`;
      return { found: false, status: null, records: [], lease_number: null, district: null, message: msg, error: msg };
    }
    return { found: false, status: null, records: [], lease_number: null, district: null, message: "Well status not found" };
  } catch (e) {
    return { found: false, status: null, records: [], lease_number: null, district: null, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S5 — Inactive Well (IWAR) ────────────────────────────────────────────────

export async function getInactiveWellStatus(apiNumber: string, operatorNumber?: string | null): Promise<{
  is_inactive: boolean;
  records: Record<string, string>[];
  plugging_deadline: string | null;
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { is_inactive: false, records: [], plugging_deadline: null, message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("inactiveWellQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    if (/no results found/i.test(html)) {
      return { is_inactive: false, records: [], plugging_deadline: null, message: "Not in inactive well report" };
    }
    const table = findDataTable(html, 2);
    if (!table) return { is_inactive: false, records: [], plugging_deadline: null, message: "No inactive well data", error: "No inactive well data — response received but table could not be parsed" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 10));
    const deadline = records[0]?.["plugging_deadline_date"] || records[0]?.["deadline"] || null;
    return { is_inactive: true, records, plugging_deadline: deadline, message: `INACTIVE — ${records.length} record(s)${deadline ? `, deadline ${deadline}` : ""}` };
  } catch (e) {
    return { is_inactive: false, records: [], plugging_deadline: null, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S6 — Orphan Well ────────────────────────────────────────────────────────

export async function getOrphanWell(apiNumber: string): Promise<{
  is_orphan: boolean;
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { is_orphan: false, message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("orphanWellQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    const isOrphan = !/no results found/i.test(html) && /orphan/i.test(html);
    return { is_orphan: isOrphan, message: isOrphan ? "ORPHAN WELL — operator forfeited bond" : "Not in orphan well program" };
  } catch (e) {
    return { is_orphan: false, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S7 — Severance Records ───────────────────────────────────────────────────

export async function getSeveranceRecords(leaseNumber: string | null, district: string | null): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  if (!leaseNumber || !district) return { found: false, records: [], message: "Need lease number and district for severance lookup", error: "Need lease number and district for severance lookup" };

  try {
    const html = await ewaFetch("severanceQueryAction.do", {
      "searchArgs.leaseNumberArg":  leaseNumber,
      "searchArgs.districtCodeArg": normalizeDistrictForQuery(district),
    });
    if (/no results found/i.test(html)) return { found: false, records: [], message: "No severance records" };
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], message: "Could not parse severance response", error: "Could not parse severance response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 10));
    return { found: true, records, message: `${records.length} severance record(s)` };
  } catch (e) {
    return { found: false, records: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S8 — Monthly Production ─────────────────────────────────────────────────

export interface ProductionRow {
  production_month: string;
  oil_bbl:          number | null;
  gas_mcf:          number | null;
  casinghead_gas_mcf: number | null;
  condensate_bbl:   number | null;
  water_bbl:        number | null;
}

export async function getProduction(leaseNumber: string | null, district: string | null, leaseType?: string): Promise<{
  found: boolean;
  rows: ProductionRow[];
  lease_number: string | null;
  district: string | null;
  message: string;
  error?: string;
}> {
  if (!leaseNumber || !district) {
    // Production is the single most important data point for a buyer — a
    // missing lease number must never be recorded as a confirmed "no
    // production," it's a blocked lookup and has to surface as MISSING.
    return {
      found: false, rows: [], lease_number: leaseNumber, district,
      message: "Production requires lease number + district — not resolved yet",
      error: "Production requires lease number + district — not resolved yet",
    };
  }

  const parseNum = (v: string): number | null => {
    if (!v || v === "NO RPT" || v === "-") return null;
    const n = parseFloat(v.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  };

  type ProductionTypeResult =
    | { status: "found"; rows: ProductionRow[] }
    | { status: "not_found" }
    | { status: "parse_failed" };

  const MONTH_NUM: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };

  // Confirmed live 2026-07-31: productionQueryAction.do is a broad/statewide
  // multi-lease search (date range + district/county/field/operator, no
  // single-lease field at all) — submitting a lease number against it has
  // never been valid, which is why it always came back as a TRRC "General
  // Exception" page. The real per-lease production history lives on a
  // completely different action, specificLeaseQueryAction.do (linked from
  // productionQueryAction.do itself: "For information about a specific
  // lease, use the Specific Lease Query"), which takes searchArgs.leaseNumberArg
  // + searchArgs.districtCodeArg + an explicit date range, plus the full set
  // of hidden actionManager.* bean fields the JSF backend requires to bind
  // without throwing. pager.pageSize=-1 requests all months in one response
  // instead of paginating 10 at a time.
  const tryType = async (lt: string): Promise<ProductionTypeResult> => {
    const url = `${EWA_BASE}/specificLeaseQueryAction.do`;
    const sessionRes = await fetch(url, {
      headers: { ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(20_000),
    });
    if (!sessionRes.ok) throw new Error(`EWA specificLeaseQueryAction.do session GET returned HTTP ${sessionRes.status}`);
    const jSessionMatch = sessionRes.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
    const jSession = jSessionMatch?.[1] ?? null;
    const postUrl = jSession ? `${url};jsessionid=${jSession}` : url;

    const now = new Date();
    const endYear = String(now.getUTCFullYear());
    const endMonth = String(now.getUTCMonth() + 1).padStart(2, "0");
    const startDate = new Date(Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), 1));
    const startYear = String(startDate.getUTCFullYear());
    const startMonth = String(startDate.getUTCMonth() + 1).padStart(2, "0");

    const html = await fetch(postUrl, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jSession ? { Cookie: `JSESSIONID=${jSession}` } : {}),
      },
      body: formBody({
        viewType: "init",
        searchType: "specificLease",
        "searchArgs.searchType": "specificLease",
        "searchArgs.activeTabsFlagwordHndlr.inputValue": "0",
        "searchArgs.orderByHndlr.inputValue": "",
        methodToCall: "search",
        "actionManager.recordCountHndlr.inputValue": "1",
        "actionManager.currentIndexHndlr.inputValue": "0",
        "actionManager.actionRcrd[0].actionDisplayNmHndlr.inputValue": "Search Criteria",
        "actionManager.actionRcrd[0].hostHndlr.inputValue": "webapps2.rrc.texas.gov:443",
        "actionManager.actionRcrd[0].contextPathHndlr.inputValue": "/EWA",
        "actionManager.actionRcrd[0].actionHndlr.inputValue": "/specificLeaseQueryAction.do",
        "actionManager.actionRcrd[0].actionParameterHndlr.inputValue": "methodToCall",
        "actionManager.actionRcrd[0].actionMethodHndlr.inputValue": "unspecified",
        "actionManager.actionRcrd[0].pagerParameterKeyHndlr.inputValue": "",
        "actionManager.actionRcrd[0].actionParametersHndlr.inputValue": "",
        "actionManager.actionRcrd[0].returnIndexHndlr.inputValue": "0",
        "actionManager.actionRcrd[0].argRcrdParameters(searchArgs.paramValue)": `|3=${endYear}|5=${endYear}|10=0`,
        "searchArgs.oilOrGasArg":     lt,
        "searchArgs.leaseNumberArg":  leaseNumber!,
        "searchArgs.districtCodeArg": normalizeDistrictForQuery(district!),
        "searchArgs.startMonthArg":   startMonth,
        "searchArgs.startYearArg":    startYear,
        "searchArgs.endMonthArg":     endMonth,
        "searchArgs.endYearArg":      endYear,
        "pager.pageSize":             "-1",
      }),
      signal: AbortSignal.timeout(30_000),
    }).then(r => r.text());

    assertNotTrrcApplicationError(html, "specificLeaseQueryAction.do");

    if (/no results found/i.test(html)) return { status: "not_found" };

    // Real table (class="DataGrid") has a two-row header via colspan: "OIL
    // (BBL)" spans [Production, Disposition], "Casinghead (MCF)" spans
    // [Production, Disposition] — confirmed live against the real DOM, not
    // the generic findDataTable/rowsToObjects helper, which assumes a flat
    // single-row header and would misalign every column here.
    const $ = cheerio.load(html);
    const table = $("table.DataGrid").first();
    if (!table.length) return { status: "parse_failed" };

    const rows: ProductionRow[] = [];
    table.find("tr").each((_, tr) => {
      const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
      if (cells.length < 5) return;
      const dateMatch = cells[0].match(/^([A-Za-z]{3})\s+(\d{4})$/);
      if (!dateMatch) return; // skips header/total/pagination rows
      const monthNum = MONTH_NUM[dateMatch[1]];
      if (!monthNum) return;
      rows.push({
        production_month:   `${dateMatch[2]}-${monthNum}`,
        oil_bbl:            parseNum(cells[1]),
        gas_mcf:            null,
        casinghead_gas_mcf: parseNum(cells[3]),
        condensate_bbl:     null,
        water_bbl:          null,
      });
    });

    if (rows.length === 0) return { status: "parse_failed" };
    return { status: "found", rows };
  };

  try {
    const types = leaseType ? [leaseType] : ["O", "G"];
    let anyParseFailed = false;
    for (const lt of types) {
      const result = await tryType(lt);
      if (result.status === "found" && result.rows.length > 0) {
        return { found: true, rows: result.rows, lease_number: leaseNumber, district, message: `${result.rows.length} months of production history (${lt} lease)` };
      }
      if (result.status === "parse_failed") anyParseFailed = true;
    }
    if (anyParseFailed) {
      const msg = `Could not parse production response for lease ${leaseNumber} district ${district} on at least one lease type`;
      return { found: false, rows: [], lease_number: leaseNumber, district, message: msg, error: msg };
    }
    return { found: false, rows: [], lease_number: leaseNumber, district, message: `No production found for lease ${leaseNumber} district ${district}` };
  } catch (e) {
    return { found: false, rows: [], lease_number: leaseNumber, district, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S9 — P-4 Gatherer/Purchaser Query ───────────────────────────────────────
//
// Form P-4 is TRRC's "Certificate of Compliance and Transportation
// Authority" — it designates which gatherer/purchaser is authorized to take
// production from a lease. It is NOT a productivity/potential test (that
// was this codebase's prior, unverified assumption, and it pointed at a
// nonexistent "p4QueryAction.do" URL that 500s). The real, live endpoint is
// gathererPurchaserQueryAction.do (confirmed live 2026-07-29 — plain
// server-rendered HTML, no browser/JS needed, unlike the manual-fallback
// note in source-registry.ts's p4_gatherer_query entry which was written
// without live-testing this specific per-lease search mode). Searched by
// lease number + district, same shape as severance/production.

export async function getGathererPurchaser(leaseNumber: string | null, district: string | null): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  if (!leaseNumber || !district) return { found: false, records: [], message: "Need lease number and district for gatherer/purchaser lookup", error: "Need lease number and district for gatherer/purchaser lookup" };

  try {
    const html = await ewaFetch("gathererPurchaserQueryAction.do", {
      methodToCall: "search",
      "searchArgs.fieldNumbersArg": "",
      "searchArgs.operatorNumbersArg": "",
      "searchArgs.leaseTypeArg": "",
      "searchArgs.districtCodeArg": normalizeDistrictForQuery(district),
      "searchArgs.leaseNumberArg": leaseNumber,
      "searchArgs.gathererPurchaserTypeArg": "",
      "searchArgs.gathererPurchaserNumberArg": "",
      "searchArgs.gathererProductArg": "",
    });
    if (/no results found/i.test(html)) return { found: false, records: [], message: "No gatherer/purchaser (P-4) record on file for this lease" };
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], message: "Could not parse gatherer/purchaser response", error: "Could not parse gatherer/purchaser response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 30));
    return { found: true, records, message: `${records.length} gatherer/purchaser (P-4) record(s) on file` };
  } catch (e) {
    return { found: false, records: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S10 — Completion Records (W-2) ──────────────────────────────────────────

// Completion records are NOT on the EWA app at all — confirmed live
// 2026-07-31: completionQueryAction.do under /EWA/ returns a raw servlet
// 500 (never existed / long retired), which had been misdiagnosed all
// session as a TRRC outage. The real Completions app lives on a completely
// different host and path, webapps.rrc.texas.gov/CMPL/ewaSearchAction.do,
// and is only reachable via a signed rrcActionMan session-continuation
// token minted fresh per search — hitting it cold (no token) also produces
// a "General Exception" page, which is why a naive guess at the URL alone
// still wouldn't have worked. The token is embedded in wellboreQueryAction.do's
// own results row (the "Completion" entry in its Links/Images/GIS
// Viewer/Completion action dropdown), so getting there means searching
// wellbore PDQ first and following that exact link. Confirmed live against
// API 42-151-01734: real "0 results" (a genuine confirmed-absence page,
// not an error) came back through this exact path.
async function findCompletionLinkFromWellbore(apiNumber: string): Promise<string | null> {
  const split = splitApi(apiNumber);
  if (!split) return null;
  const html = await ewaFetch("wellboreQueryAction.do", {
    "searchArgs.apiNoPrefixArg": split.prefix,
    "searchArgs.apiNoSuffixArg": split.suffix,
    "searchArgs.scheduleTypeArg": "Both",
  });
  const idx = html.indexOf(">Completion<");
  if (idx === -1) return null;
  const chunk = html.slice(Math.max(0, idx - 700), idx);
  const urlMatch = chunk.match(/value="\{&quot;url&quot;: &quot;([^&]+(?:&amp;[^&]+)*)&quot;/);
  if (!urlMatch) return null;
  return urlMatch[1].replace(/&amp;/g, "&");
}

export async function getCompletionRecords(apiNumber: string): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  try {
    const completionUrl = await findCompletionLinkFromWellbore(apiNumber);
    if (!completionUrl) {
      return { found: false, records: [], message: "Could not locate completion record link for this API — wellbore not found or no Completion action available", error: "No completion link found" };
    }

    const res = await fetch(completionUrl, {
      headers: { ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`CMPL completion search returned HTTP ${res.status}`);
    const html = await res.text();
    assertNotTrrcApplicationError(html, "CMPL ewaSearchAction.do");

    if (/no .{0,20}records found|0 results/i.test(html)) {
      return { found: false, records: [], message: "No completion (W-2) records on file for this API" };
    }
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], message: "Could not parse completion response", error: "Could not parse completion response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 20));
    return { found: true, records, message: `${records.length} completion record(s)` };
  } catch (e) {
    return { found: false, records: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S11 — Plugging Records ───────────────────────────────────────────────────

export async function getPluggingRecords(apiNumber: string): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, records: [], message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("pluggingQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    if (/no results found/i.test(html)) return { found: false, records: [], message: "No plugging records" };
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], message: "Could not parse plugging response", error: "Could not parse plugging response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 10));
    return { found: true, records, message: `${records.length} plugging record(s)` };
  } catch (e) {
    return { found: false, records: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S14 — UIC / Injection Records ───────────────────────────────────────────

export async function getInjectionRecords(apiNumber: string, operatorNumber?: string | null): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, records: [], message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("uicQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    if (/no results found/i.test(html)) return { found: false, records: [], message: "No UIC/injection records" };
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], message: "Could not parse UIC response", error: "Could not parse UIC response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 10));
    return { found: true, records, message: `${records.length} UIC/injection record(s)` };
  } catch (e) {
    return { found: false, records: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S16 — RRC GIS (ArcGIS REST) ─────────────────────────────────────────────
//
// Confirmed live against the real ArcGIS service schema (2026-07-27) that
// this function had two independent bugs, both silently turning "the well
// IS in the GIS database" into a false "not found":
//   1. The well-location query (layer 1, "Well Locations") filtered on
//      `API8`, but the field is actually named `API` — every query 400'd,
//      and the response-handling code treated any response without a
//      `features` array (including an ArcGIS error body) as zero results.
//   2. The survey (layer 24) and alert-area (layer 26) queries filtered by
//      `where=API=...`, but those layers are polygons with no API field at
//      all — they need a spatial point-in-polygon query using the well's
//      own coordinates, not an attribute filter. Also read field names
//      (SURVEY_NAME, BLOCK_NUMBER, SECTION_NAME, AlertAreaName) that don't
//      exist in the real schema (LEVEL1_SURVEY_NAME, LEVEL2_BLOCK_NUMBER,
//      LEVEL3_SURVEY_NUMBER, AREA_NAME).
// Verified directly: API 32946771 (the real Chevron/Midland well used
// throughout tonight's W-1 work) returns a real point, two intersecting
// survey polygons, and geometry from these corrected queries where the
// original code always returned "not found."

export async function getGisLocation(apiNumber: string): Promise<{
  found: boolean;
  latitude: number | null;
  longitude: number | null;
  well_type: string | null;
  survey: Record<string, string> | null;
  alert_areas: string[];
  message: string;
  error?: string;
}> {
  const digits = apiNumber.replace(/\D/g, "");
  const api8 = digits.slice(2, 10);
  const GIS_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

  try {
    const wellQs = `f=json&where=API%3D%27${api8}%27&outFields=*&returnGeometry=true&outSR=4326`;
    const res = await fetch(`${GIS_BASE}/1/query?${wellQs}`, { signal: AbortSignal.timeout(20_000) });
    const json = await res.json() as { features?: Array<{ geometry?: { x?: number; y?: number }; attributes?: Record<string, unknown> }> };

    if (!json.features || json.features.length === 0) {
      return { found: false, latitude: null, longitude: null, well_type: null, survey: null, alert_areas: [], message: "Well not found in RRC GIS database" };
    }

    const feat = json.features[0];
    const lat = feat.geometry?.y ?? null;
    const lng = feat.geometry?.x ?? null;
    const attrs = feat.attributes ?? {};

    let alertAreas: string[] = [];
    let surveyAttrs: Record<string, unknown> | null = null;

    if (lat !== null && lng !== null) {
      const spatialQs = `f=json&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false`;

      // Alert areas and surveys are polygon layers — find the one(s) this
      // point falls inside, not a nonexistent per-record API field.
      const alertRes = await fetch(`${GIS_BASE}/26/query?${spatialQs}&outFields=AREA_NAME`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const alertJson = alertRes ? await alertRes.json() as { features?: Array<{ attributes?: { AREA_NAME?: string } }> } : null;
      alertAreas = (alertJson?.features ?? []).map(f => f.attributes?.AREA_NAME ?? "").filter(Boolean);

      const surveyRes = await fetch(`${GIS_BASE}/24/query?${spatialQs}&outFields=ABSTRACT_NUMBER,LEVEL1_SURVEY_NAME,LEVEL2_BLOCK_NUMBER,LEVEL3_SURVEY_NUMBER`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const surveyJson = surveyRes ? await surveyRes.json() as { features?: Array<{ attributes?: Record<string, unknown> }> } : null;
      surveyAttrs = surveyJson?.features?.[0]?.attributes ?? null;
    }

    return {
      found: true,
      latitude: lat,
      longitude: lng,
      well_type: String(attrs["GIS_SYMBOL_DESCRIPTION"] ?? ""),
      survey: surveyAttrs ? {
        abstract_number: String(surveyAttrs["ABSTRACT_NUMBER"] ?? ""),
        survey_name:     String(surveyAttrs["LEVEL1_SURVEY_NAME"] ?? ""),
        block_number:    String(surveyAttrs["LEVEL2_BLOCK_NUMBER"] ?? ""),
        // The real schema has no literal "section" field; LEVEL3_SURVEY_NUMBER
        // is the closest equivalent TRRC actually publishes at this level.
        section_name:    String(surveyAttrs["LEVEL3_SURVEY_NUMBER"] ?? ""),
      } : null,
      alert_areas: alertAreas,
      message: `GIS location: ${lat?.toFixed(4)}°N, ${lng?.toFixed(4)}°W${alertAreas.length ? ` | Alerts: ${alertAreas.join(", ")}` : ""}`,
    };
  } catch (e) {
    return { found: false, latitude: null, longitude: null, well_type: null, survey: null, alert_areas: [], message: `GIS error: ${String(e)}`, error: String(e) };
  }
}

// ─── S17 — Drilling Permit (W-1) Query ───────────────────────────────────────
//
// Live TRRC endpoint confirmed via the EWA query menu (ewaMain.do lists it as
// "Drilling Permit (W-1) Query") — not previously wired into this pipeline.
// Same nested per-cell table on the API No. column as wellbore PDQ (a dropdown
// of Links/Images/GIS Viewer/Completion action links sits beside the value),
// so cell text comes back as e.g. "32946771 Links Images GIS Viewer
// Completion". Unlike wellbore PDQ, the clean numeric value is trivially
// recoverable with a leading-digit-run match — no href/query-param parsing
// needed here since the API number is always purely numeric.

export async function getDrillingPermits(apiNumber: string): Promise<{
  found: boolean;
  permits: Record<string, string>[];
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, permits: [], message: "Invalid API number format", error: "Invalid API number format" };

  try {
    const html = await ewaFetch("drillingPermitsQueryAction.do", {
      "searchArgs.apiNoHndlr.inputValue": `${split.prefix}${split.suffix}`,
    });

    if (/no results found/i.test(html)) {
      return { found: false, permits: [], message: `No drilling permit (W-1) on record for 42-${split.prefix}-${split.suffix}` };
    }

    const table = findDataTable(html, 5);
    if (!table) return { found: false, permits: [], message: "Could not parse drilling permit response", error: "Could not parse drilling permit response" };

    const permits = rowsToObjects(table.header, table.rows).map(p => ({
      ...p,
      api_no: p["api_no"]?.match(/^\d+/)?.[0] ?? p["api_no"] ?? "",
    }));

    return {
      found: true,
      permits,
      message: `Found ${permits.length} drilling permit record(s) for 42-${split.prefix}-${split.suffix}`,
    };
  } catch (e) {
    return { found: false, permits: [], message: `Error: ${String(e)}`, error: String(e) };
  }
}

export { PDA_BASE };

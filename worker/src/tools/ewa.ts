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
      const cells = cellEls.map(cellEl =>
        $(cellEl).text().replace(/ /g, " ").replace(/\s+/g, " ").trim(),
      );
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
      "searchArgs.districtCodeArg": district,
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

export async function searchOperator(operatorName: string | null, operatorNumber: string | null): Promise<{
  found: boolean;
  records: Record<string, string>[];
  p5_status: string | null;
  bond_amount: string | null;
  message: string;
  error?: string;
}> {
  const params: Record<string, string> = {};
  if (operatorNumber) params["searchArgs.operatorNoArg"] = operatorNumber;
  else if (operatorName) params["searchArgs.operatorNameArg"] = operatorName;
  else return { found: false, records: [], p5_status: null, bond_amount: null, message: "No operator name or number provided", error: "No operator name or number provided" };

  try {
    const html = await ewaFetch("organizationQueryAction.do", params);
    if (/no results found/i.test(html)) {
      return { found: false, records: [], p5_status: null, bond_amount: null, message: "Operator not found in P-5 registry" };
    }
    const table = findDataTable(html, 2);
    if (!table) return { found: false, records: [], p5_status: null, bond_amount: null, message: "Could not parse P-5 response", error: "Could not parse P-5 response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 10));
    const first = records[0] ?? {};
    return {
      found: true,
      records,
      p5_status:   first["p5_status"]   || first["status"]      || null,
      bond_amount: first["bond_amount"]  || first["bond"]        || null,
      message:     `Found ${records.length} P-5 record(s)`,
    };
  } catch (e) {
    return { found: false, records: [], p5_status: null, bond_amount: null, message: `Error: ${String(e)}`, error: String(e) };
  }
}

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
          "searchArgs.districtCodeArg": district,
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
      "searchArgs.districtCodeArg": district,
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

  const tryType = async (lt: string): Promise<ProductionTypeResult> => {
    // Step 1: get session
    const sessionRes = await fetch(`${EWA_BASE}/productionQueryAction.do`, {
      headers: { ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(20_000),
    });
    const sessionHtml = await sessionRes.text();
    const jSessionMatch = sessionRes.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
    const jSession = jSessionMatch?.[1] ?? null;
    const viewStateMatch = sessionHtml.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    const viewState = viewStateMatch?.[1] ?? "";

    const sessionUrl = jSession
      ? `${EWA_BASE}/productionQueryAction.do;jsessionid=${jSession}`
      : `${EWA_BASE}/productionQueryAction.do`;

    const html = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jSession ? { Cookie: `JSESSIONID=${jSession}` } : {}),
      },
      body: formBody({
        "searchArgs.leaseNumberArg":  leaseNumber!,
        "searchArgs.districtCodeArg": district!,
        "searchArgs.leaseTypeArg":    lt,
        "searchArgs.reportRange":     "ALL",
        "javax.faces.ViewState":      viewState,
        "methodToCall":               "search",
      }),
      signal: AbortSignal.timeout(30_000),
    }).then(r => r.text());

    // getProduction has its own inline fetch (not routed through ewaFetch),
    // so it needs its own Application Error check — see isTrrcApplicationError.
    assertNotTrrcApplicationError(html, "productionQueryAction.do");

    if (/no results found|no production/i.test(html)) return { status: "not_found" };

    const table = findDataTable(html, 4);
    if (!table) return { status: "parse_failed" };

    const rows = table.rows.slice(0, 120).map(row => {
      const obj: Record<string, string> = {};
      // Must match rowsToObjects's key transform exactly (including the
      // trailing-underscore strip) — a unit-suffixed header like "Oil (BBL)"
      // otherwise becomes key "oil_bbl_" instead of "oil_bbl" and silently
      // misses every lookup below, while a plain header like "Year" has no
      // parens to strip and matches fine either way. That divergence between
      // this inline duplicate and the shared helper is consistent with what
      // production data actually shows: correct production_month values but
      // null oil_bbl/gas_mcf/etc. on every row ever stored.
      table.header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/g, "")] = row[i] ?? ""; });
      const year  = obj["year"]  || obj["prod_yr"]   || "";
      const month = obj["month"] || obj["prod_month"] || "";
      if (!year || !month) return null;
      return {
        production_month:   `${year}-${String(parseInt(month)).padStart(2, "0")}`,
        oil_bbl:            parseNum(obj["oil_bbl"]        || obj["oil"]),
        gas_mcf:            parseNum(obj["gas_mcf"]        || obj["gas"]),
        casinghead_gas_mcf: parseNum(obj["casinghead_mcf"] || obj["casinghead"]),
        condensate_bbl:     parseNum(obj["condensate_bbl"] || obj["condensate"]),
        water_bbl:          parseNum(obj["water_bbl"]      || obj["water"]),
      } as ProductionRow;
    }).filter((r): r is ProductionRow => r !== null);
    return { status: "found", rows };
  };

  try {
    const types = leaseType ? [leaseType] : ["O", "G", "C"];
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

// ─── S9 — P-4 Production Tests ───────────────────────────────────────────────

export async function getP4Tests(apiNumber: string, leaseNumber?: string | null, district?: string | null): Promise<{
  found: boolean;
  records: Record<string, string>[];
  most_recent: Record<string, string> | null;
  original_completion: Record<string, string> | null;
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, records: [], most_recent: null, original_completion: null, message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("p4QueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    if (/no results found/i.test(html)) return { found: false, records: [], most_recent: null, original_completion: null, message: "No P-4 production tests on file" };
    const table = findDataTable(html, 3);
    if (!table) return { found: false, records: [], most_recent: null, original_completion: null, message: "Could not parse P-4 response", error: "Could not parse P-4 response" };
    const records = rowsToObjects(table.header, table.rows.slice(0, 30));
    return {
      found: true,
      records,
      most_recent:         records[0] ?? null,
      original_completion: records[records.length - 1] ?? null,
      message:             `${records.length} P-4 test(s) on file`,
    };
  } catch (e) {
    return { found: false, records: [], most_recent: null, original_completion: null, message: `Error: ${String(e)}`, error: String(e) };
  }
}

// ─── S10 — Completion Records (W-2) ──────────────────────────────────────────

export async function getCompletionRecords(apiNumber: string): Promise<{
  found: boolean;
  records: Record<string, string>[];
  message: string;
  error?: string;
}> {
  const split = splitApi(apiNumber);
  if (!split) return { found: false, records: [], message: "Invalid API", error: "Invalid API" };

  try {
    const html = await ewaFetch("completionQueryAction.do", {
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
    });
    if (/no results found/i.test(html)) return { found: false, records: [], message: "No completion records on file" };
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
  const qs = `f=json&where=API8%3D%27${api8}%27&outFields=*&returnGeometry=true&geometryType=esriGeometryPoint&outSR=4326`;

  try {
    const res = await fetch(`${GIS_BASE}/1/query?${qs}`, { signal: AbortSignal.timeout(20_000) });
    const json = await res.json() as { features?: Array<{ geometry?: { x?: number; y?: number }; attributes?: Record<string, unknown> }> };

    if (!json.features || json.features.length === 0) {
      return { found: false, latitude: null, longitude: null, well_type: null, survey: null, alert_areas: [], message: "Well not found in RRC GIS database" };
    }

    const feat = json.features[0];
    const lat = feat.geometry?.y ?? null;
    const lng = feat.geometry?.x ?? null;
    const attrs = feat.attributes ?? {};

    // Query alert areas (layer 26)
    const alertRes = await fetch(`${GIS_BASE}/26/query?${qs.replace("outFields=*", "outFields=AlertAreaName")}&geometryType=esriGeometryPoint`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const alertJson = alertRes ? await alertRes.json() as { features?: Array<{ attributes?: { AlertAreaName?: string } }> } : null;
    const alertAreas = (alertJson?.features ?? []).map(f => f.attributes?.AlertAreaName ?? "").filter(Boolean);

    // Query survey layer (layer 24)
    const surveyRes = await fetch(`${GIS_BASE}/24/query?${qs}&outFields=ABSTRACT_NUMBER,SURVEY_NAME,BLOCK_NUMBER,SECTION_NAME`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const surveyJson = surveyRes ? await surveyRes.json() as { features?: Array<{ attributes?: Record<string, unknown> }> } : null;
    const surveyAttrs = surveyJson?.features?.[0]?.attributes ?? null;

    return {
      found: true,
      latitude: lat,
      longitude: lng,
      well_type: String(attrs["WellType"] ?? attrs["WELL_TYPE"] ?? ""),
      survey: surveyAttrs ? {
        abstract_number: String(surveyAttrs["ABSTRACT_NUMBER"] ?? ""),
        survey_name:     String(surveyAttrs["SURVEY_NAME"] ?? ""),
        block_number:    String(surveyAttrs["BLOCK_NUMBER"] ?? ""),
        section_name:    String(surveyAttrs["SECTION_NAME"] ?? ""),
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

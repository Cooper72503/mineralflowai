/**
 * TRRC Monthly Production Fetcher
 *
 * Two-request process against the Texas Railroad Commission's public PDQ web app:
 *   1. GET/POST wellboreQueryAction.do  →  establish a TRRC EWA session (JSESSIONID)
 *   2. POST specificLeaseQueryAction.do →  HTML table with monthly production rows
 *
 * HTML parsing uses cheerio for structural <table><tr><td> traversal rather than
 * regex against flattened text — more robust to column-order changes, non-breaking
 * spaces, links inside cells, and layout differences between oil and gas reports.
 *
 * Run server-side only (no CORS issues from Next.js API routes).
 *
 * Reference: https://webapps2.rrc.texas.gov/EWA/ewaPdqMain.do
 */

import * as cheerio from "cheerio";

const BASE = "https://webapps2.rrc.texas.gov/EWA";

// ── types ──────────────────────────────────────────────────────────────────────

export type TrrcMonthlyRow = {
  year:    number;
  month:   number;  // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type TrrcProductionResult = {
  api_number:    string;
  district_code: string;
  lease_number:  string;
  rows:          TrrcMonthlyRow[];
  /** Total months returned */
  months_count:  number;
  source: "trrc_actual";
};

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalise a TRRC API number to a clean 10-digit string (42 + county(3) + well(5)).
 * Accepts dashed ("42-151-12345-00-00") or plain ("4215112345") formats.
 */
export function normalizeApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic")) return null;
  const digits = raw.replace(/[-\s]/g, "").replace(/^0+/, "");
  // Full 10-digit format: 42XXXXXXXX
  if (digits.startsWith("42") && digits.length >= 10) return digits.slice(0, 10);
  // 8-digit TRRC format (county 3 + well 5, no TX prefix): prepend "42"
  if (digits.length === 8 && !digits.startsWith("42")) return `42${digits}`;
  return null;
}

/** Parse "MM/YYYY" or "YYYY-MM" → { year, month } */
function parseMonthStr(s: string): { year: number; month: number } | null {
  const slash = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return { month: parseInt(slash[1], 10), year: parseInt(slash[2], 10) };
  const iso   = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso)   return { year:  parseInt(iso[1], 10),   month: parseInt(iso[2], 10) };
  return null;
}

const MONTH_NAME_MAP: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/** Strip commas from numeric strings and parse float. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, "").trim()) || 0;
}

// ── session bootstrap ──────────────────────────────────────────────────────────

/**
 * Initialise a TRRC EWA Java EE session using a GET-first pattern.
 *
 * Why GET first (not POST):
 *   Submitting a search POST without first loading the page can land on a
 *   maintenance page, session-expired redirect, or default form response.
 *   A GET to the search page establishes the JSESSIONID and validates that
 *   the EWA application is reachable before any query is submitted.
 *
 * Fingerprint validation:
 *   We verify the response contains "wellboreQueryAction.do" — the action URL
 *   on the actual search form.  If absent, the GET returned a redirect or
 *   maintenance page; we fall back to a POST-based init (legacy path).
 *
 * The resulting JSESSIONID must be passed to all subsequent requests.
 */
async function initTrrcSession(signal?: AbortSignal): Promise<string | null> {
  // ── Primary path: GET the search page first ─────────────────────────────
  try {
    const getRes = await fetch(`${BASE}/wellboreQueryAction.do`, {
      method:  "GET",
      headers: {
        "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
      },
      signal,
    });
    if (getRes.ok) {
      const html = await getRes.text();
      // Validate we got the actual wellbore search page, not a redirect/maintenance page
      if (html.includes("wellboreQueryAction.do")) {
        const setCookie = getRes.headers.get("set-cookie") ?? "";
        const m = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
        if (m) return `JSESSIONID=${m[1]}`;
      }
    }
  } catch {
    // Fall through to legacy POST path
  }

  // ── Fallback: POST-based init (original behavior) ────────────────────────
  // Used when the GET either fails or doesn't return a session cookie.
  // Some TRRC deployments issue JSESSIONID only on form POST.
  try {
    const res = await fetch(`${BASE}/wellboreQueryAction.do`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    "methodToCall=search",
      signal,
    });
    if (!res.ok) return null;
    // Node.js fetch exposes Set-Cookie as a single combined header value
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
    return m ? `JSESSIONID=${m[1]}` : null;
  } catch {
    return null;
  }
}

// ── HTML production table parser ───────────────────────────────────────────────

// Physical bounds — single Texas lease
const MAX_PLAUSIBLE_OIL_BBL = 10_000_000;
const MAX_PLAUSIBLE_GAS_MCF = 60_000_000;

/**
 * Normalize a raw table cell to plain text.
 * Handles non-breaking spaces ( ), multiple whitespace, and HTML entities.
 */
function cleanCell(raw: string): string {
  return raw
    .replace(/ /g, " ")   // non-breaking space → regular space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a numeric cell value — returns null for blanks, dashes, "N/A".
 * Strips commas (e.g. "1,234") before parsing.
 */
function parseNumCell(s: string): number | null {
  const c = cleanCell(s).replace(/,/g, "");
  if (!c || c === "-" || /^N\/?A$/i.test(c)) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

/**
 * Page-level fingerprint validation.
 * Returns true only when the HTML looks like a real TRRC production results page.
 * A false result means session-expiry redirect, maintenance page, or network error.
 */
function isProductionResultPage(html: string): boolean {
  const hasActionUrl    = html.includes("specificLeaseQueryAction.do");
  const hasColumnHeader = /Lease No\.|District Code|Production Month|Crude Oil|Casinghead/i.test(html);
  return hasActionUrl || hasColumnHeader;
}

/**
 * Structural cheerio-based parser for TRRC production HTML tables.
 *
 * Why cheerio instead of regex:
 *   The old approach flattened each <tr> to a single string via regex and then
 *   applied a month-name pattern against the result.  This breaks when:
 *     • Cells contain non-breaking spaces (common in TRRC tables)
 *     • A cell contains a link or <span> that places text out of order
 *     • Column order changes between oil and gas report layouts
 *     • A "dash" or blank cell causes the positional offsets to shift
 *
 *   cheerio traverses <table><tr><td> structurally, extracts cell text
 *   independently of surrounding markup, and handles entity decoding natively.
 *   Each cell's position is determined by its actual DOM index, not the order
 *   text appears in the flattened string.
 *
 * Column layout (TRRC EWA Specific Lease Query):
 *   Oil report:  [Period] [Crude Oil BBL] [Oil Disp] [Casinghead MCF] [Gas Disp] ...
 *   Gas report:  [Period] [Gas MCF]       [Gas Disp] [Condensate BBL] [Cond Disp] ...
 *
 * The "Period" cell contains "Mon YYYY" (e.g. "Jan 2024"). We scan each row for
 * a cell matching that pattern to locate the data anchor, then read numeric values
 * from the immediately following cells — this survives column insertions before
 * the period column.
 */
function parseTrrcHtmlRows(html: string, reportType: "O" | "G" = "O"): TrrcMonthlyRow[] {
  // ── Page fingerprint guard ────────────────────────────────────────────────
  if (!isProductionResultPage(html)) {
    // Session-expiry redirect, maintenance page, or network error.
    // Return empty — fetchTrrcProductionByLease retry logic handles this.
    return [];
  }

  const $ = cheerio.load(html);
  // Deduplicate by period key — keeps the highest oil_bbl for a given month/year
  const seen = new Map<string, TrrcMonthlyRow>();

  $("table tr").each((_i, tr) => {
    // Extract text of every <td> in this row, cleaned
    const cells: string[] = [];
    $(tr).find("td").each((_j, td) => {
      cells.push(cleanCell($(td).text()));
    });

    if (cells.length < 3) return; // header row or empty row

    // Find the cell containing "Mon YYYY" (e.g. "Jan 2024")
    const PERIOD_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i;
    const periodIdx = cells.findIndex(c => PERIOD_RE.test(c));
    if (periodIdx === -1) return; // not a data row

    const periodMatch = cells[periodIdx].match(PERIOD_RE)!;
    const month = MONTH_NAME_MAP[periodMatch[1].slice(0, 1).toUpperCase() + periodMatch[1].slice(1, 3).toLowerCase()];
    const year  = parseInt(periodMatch[2], 10);

    if (!month || year < 1990 || year > new Date().getFullYear() + 1) return;

    // Numeric columns follow the period cell at fixed relative offsets:
    //   +1 = primary volume  (oil BBL or gas MCF)
    //   +2 = disposition     (skip)
    //   +3 = secondary volume (casinghead MCF or condensate BBL)
    const v1 = parseNumCell(cells[periodIdx + 1] ?? ""); // primary
    const v3 = parseNumCell(cells[periodIdx + 3] ?? ""); // secondary

    // Reject negatives — parse errors
    if ((v1 ?? 0) < 0 || (v3 ?? 0) < 0) return;

    let oil_bbl: number;
    let gas_mcf: number | null;

    if (reportType === "O") {
      // Oil report: v1 = crude oil BBL, v3 = casinghead gas MCF
      oil_bbl = v1 ?? 0;
      gas_mcf = (v3 != null && v3 > 0) ? v3 : null;
      if (oil_bbl > MAX_PLAUSIBLE_OIL_BBL) return;
      if (gas_mcf != null && gas_mcf > MAX_PLAUSIBLE_GAS_MCF) gas_mcf = null;
    } else {
      // Gas report: v1 = gas MCF, v3 = condensate BBL
      // Convert gas → BOE equivalent (6 MCF ≈ 1 BOE) and add condensate
      if ((v1 ?? 0) > MAX_PLAUSIBLE_GAS_MCF) return;
      const condensate = v3 ?? 0;
      const gas_boe = (v1 != null && v1 > 0) ? Math.round(v1 / 6) : 0;
      oil_bbl = gas_boe + condensate;
      gas_mcf = (v1 != null && v1 > 0) ? v1 : null;
      if (oil_bbl > MAX_PLAUSIBLE_OIL_BBL) return;
    }

    if (oil_bbl > 0 || gas_mcf != null) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const existing = seen.get(key);
      if (!existing || oil_bbl > existing.oil_bbl) {
        seen.set(key, { year, month, oil_bbl, gas_mcf });
      }
    }
  });

  return Array.from(seen.values()).sort(
    (a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month
  );
}

// ── production search ──────────────────────────────────────────────────────────

/**
 * The fixed set of hidden actionManager fields required by the TRRC EWA Struts app.
 * These are the same on every initial form load and do not change.
 */
function buildLeaseSearchBody(
  distCode: string,
  leaseNo:  string,
  startMonth: number,
  startYear:  number,
  endMonth:   number,
  endYear:    number,
  oilOrGas:   "O" | "G",
): URLSearchParams {
  return new URLSearchParams({
    "viewType":                                                    "init",
    "searchType":                                                  "specificLease",
    "searchArgs.searchType":                                       "specificLease",
    "searchArgs.activeTabsFlagwordHndlr.inputValue":               "0",
    "searchArgs.orderByHndlr.inputValue":                          "",
    "methodToCall":                                                "search",
    "actionManager.recordCountHndlr.inputValue":                   "1",
    "actionManager.currentIndexHndlr.inputValue":                  "0",
    "actionManager.actionRcrd[0].actionDisplayNmHndlr.inputValue": "Search Criteria",
    "actionManager.actionRcrd[0].hostHndlr.inputValue":            "webapps2.rrc.texas.gov:443",
    "actionManager.actionRcrd[0].contextPathHndlr.inputValue":     "/EWA",
    "actionManager.actionRcrd[0].actionHndlr.inputValue":          "/specificLeaseQueryAction.do",
    "actionManager.actionRcrd[0].actionParameterHndlr.inputValue": "methodToCall",
    "actionManager.actionRcrd[0].actionMethodHndlr.inputValue":    "unspecified",
    "actionManager.actionRcrd[0].pagerParameterKeyHndlr.inputValue":"",
    "actionManager.actionRcrd[0].actionParametersHndlr.inputValue":"",
    "actionManager.actionRcrd[0].returnIndexHndlr.inputValue":     "0",
    "searchArgs.oilOrGasArg":                                      oilOrGas,
    "searchArgs.leaseNumberArg":                                   leaseNo,
    "searchArgs.districtCodeArg":                                  distCode,
    "searchArgs.startMonthArg":  String(startMonth).padStart(2, "0"),
    "searchArgs.startYearArg":   String(startYear),
    "searchArgs.endMonthArg":    String(endMonth).padStart(2, "0"),
    "searchArgs.endYearArg":     String(endYear),
  });
}

/**
 * POST the first page of production results.
 * Returns the parsed rows AND the "Next" page URL (if any) for pagination.
 */
async function fetchLeaseProductionPage(
  distCode:      string,
  leaseNo:       string,
  sessionCookie: string,
  startMonth:    number,
  startYear:     number,
  endMonth:      number,
  endYear:       number,
  oilOrGas:      "O" | "G",
  signal?:       AbortSignal,
): Promise<{ rows: TrrcMonthlyRow[]; nextPagePath: string | null }> {
  const body = buildLeaseSearchBody(
    distCode, leaseNo, startMonth, startYear, endMonth, endYear, oilOrGas,
  );

  const res = await fetch(`${BASE}/specificLeaseQueryAction.do`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie":        sessionCookie,
    },
    body:    body.toString(),
    signal,
  });

  if (!res.ok) return { rows: [], nextPagePath: null };
  const html = await res.text();

  const rows = parseTrrcHtmlRows(html, oilOrGas);

  // Extract "Next" page link from pager
  // URL format: /EWA/specificLeaseQueryAction.do?pager.pageSize=10&pager.offset=10&...
  const nextMatch = html.match(/href="(\/EWA\/[^"]*pager\.[^"]*pager\.offset=\d+[^"]*)"\s*>\s*\[Next/i);
  return { rows, nextPagePath: nextMatch ? nextMatch[1] : null };
}

/**
 * GET a subsequent production page using the pager link path extracted from the HTML.
 */
async function fetchLeaseProductionNextPage(
  path:          string,
  sessionCookie: string,
  oilOrGas:      "O" | "G",
  signal?:       AbortSignal,
): Promise<{ rows: TrrcMonthlyRow[]; nextPagePath: string | null }> {
  const url = `https://webapps2.rrc.texas.gov${path}`;
  const res = await fetch(url, {
    headers: { "Cookie": sessionCookie },
    signal,
  });

  if (!res.ok) return { rows: [], nextPagePath: null };
  const html = await res.text();

  const rows = parseTrrcHtmlRows(html, oilOrGas);
  // Same regex as fetchLeaseProductionPage — URL format: /EWA/...?pager.pageSize=10&pager.offset=N&...
  const nextMatch = html.match(/href="(\/EWA\/[^"]*pager\.[^"]*pager\.offset=\d+[^"]*)"\s*>\s*\[Next/i);
  return { rows, nextPagePath: nextMatch ? nextMatch[1] : null };
}

/**
 * Safety cap: maximum production pages to fetch in a single query.
 * 10 rows/page × 60 pages = 600 rows ≈ 50 years of monthly data.
 * Covers the full electronic record history in TRRC (records from ~1993 onward).
 */
const MAX_PRODUCTION_PAGES = 60;

/**
 * How far back to request from TRRC when fetching full production history.
 * 480 months = 40 years — older than any electronic record in the TRRC PDQ system.
 * Using a fixed large window guarantees we never silently truncate history.
 */
const FULL_HISTORY_MONTHS = 480;

/**
 * Merge an oil-report row set and a gas-report row set into a single timeline.
 *
 * Why both reports are needed:
 *   Oil report  → crude oil BBL + casinghead gas MCF per month
 *   Gas report  → gas MCF + condensate BOE per month
 *   Dual-completion wells report to BOTH; fetching only one silently drops half the data.
 *
 * Merge strategy:
 *   • Months present only in one report → use that report's row.
 *   • Months in both reports → keep oil report's crude oil BBL (authoritative for oil);
 *     use the higher gas_mcf from either report (gas report may have more detail).
 */
function mergeOilGasRows(
  oilRows: TrrcMonthlyRow[],
  gasRows: TrrcMonthlyRow[],
): TrrcMonthlyRow[] {
  const byKey = new Map<string, TrrcMonthlyRow>();

  for (const r of oilRows) {
    byKey.set(`${r.year}-${String(r.month).padStart(2, "0")}`, r);
  }

  for (const r of gasRows) {
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
    } else {
      // Oil report's crude oil is authoritative; use best gas from either report
      const bestGas = Math.max(existing.gas_mcf ?? 0, r.gas_mcf ?? 0) || null;
      if (bestGas !== (existing.gas_mcf ?? null)) {
        byKey.set(key, { ...existing, gas_mcf: bestGas });
      }
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month,
  );
}

/**
 * Fetch all production rows for the given date range, following pagination.
 * Stops when no new rows are returned, no next-page link exists, or MAX_PRODUCTION_PAGES
 * is reached — whichever comes first.
 */
async function fetchAllLeaseProduction(
  distCode:      string,
  leaseNo:       string,
  sessionCookie: string,
  startMonth:    number,
  startYear:     number,
  endMonth:      number,
  endYear:       number,
  oilOrGas:      "O" | "G",
  maxPages = MAX_PRODUCTION_PAGES,
  signal?:       AbortSignal,
): Promise<TrrcMonthlyRow[]> {
  // Use a Map for deduplication — month/year keys ensure we don't double-count
  // rows that appear on overlapping pages (TRRC pager can return overlapping rows).
  const seen = new Map<string, TrrcMonthlyRow>();

  const addRows = (rows: TrrcMonthlyRow[]) => {
    for (const row of rows) {
      const key = `${row.year}-${String(row.month).padStart(2, "0")}`;
      const existing = seen.get(key);
      if (!existing || row.oil_bbl > existing.oil_bbl) seen.set(key, row);
    }
  };

  let { rows: firstRows, nextPagePath } = await fetchLeaseProductionPage(
    distCode, leaseNo, sessionCookie,
    startMonth, startYear, endMonth, endYear,
    oilOrGas, signal,
  );
  addRows(firstRows);

  let page = 1;
  while (nextPagePath && page < maxPages) {
    const before = seen.size;
    const next = await fetchLeaseProductionNextPage(nextPagePath, sessionCookie, oilOrGas, signal);
    addRows(next.rows);
    nextPagePath = next.nextPagePath;
    page++;
    // Early exit: if no new unique rows were added, the pager has cycled back
    // or is returning already-seen data — stop to avoid infinite loops.
    if (seen.size === before) break;
  }

  return Array.from(seen.values()).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
}

// ── step 1 (legacy path): wellbore query → district + lease ───────────────────

async function getLeaseFromApiNumber(
  apiNumber: string,
  signal?: AbortSignal,
): Promise<{ distCode: string; leaseNo: string } | null> {
  const normalized = normalizeApiNumber(apiNumber);
  if (!normalized) return null;

  // TRRC PDQ wellbore query uses a split field format:
  //   apiNoPrefixArg = 3-digit county code (positions 2–4 of the 10-digit API)
  //   apiNoSuffixArg = 5-digit well number  (positions 5–9)
  // e.g. API 4215100001 → prefix=151, suffix=00001
  const countyCode = normalized.slice(2, 5);   // 3 digits
  const wellNo     = normalized.slice(5);       // 5 digits

  const body = new URLSearchParams({
    "searchArgs.apiNoPrefixArg": countyCode,
    "searchArgs.apiNoSuffixArg": wellNo,
    "searchArgs.wellTypeArg":    "",     // No filter — find oil, gas, condensate, and combo leases
    "methodToCall":              "search",
  });

  try {
    const res = await fetch(`${BASE}/wellboreQueryAction.do`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
      signal,
    });
    if (!res.ok) return null;
    const html = await res.text();

    const hasDistFirst = html.match(/leaseDetailAction\.do[^"']*distCode=([A-Z0-9]+)[^"']*leaseNo=(\d+)/i);
    if (hasDistFirst) {
      return { distCode: hasDistFirst[1], leaseNo: hasDistFirst[2] };
    }
    const hasLeaseFirst = html.match(/leaseDetailAction\.do[^"']*leaseNo=(\d+)[^"']*distCode=([A-Z0-9]+)/i);
    if (hasLeaseFirst) {
      return { distCode: hasLeaseFirst[2], leaseNo: hasLeaseFirst[1] };
    }
  } catch {
    return null;
  }

  return null;
}

// ── public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch the last `monthsBack` months of actual TRRC production for an API number.
 * Returns null if the API number is invalid, synthetic, or TRRC is unreachable.
 */
export async function fetchTrrcProductionHistory(
  apiNumber: string,
  monthsBack = FULL_HISTORY_MONTHS,
): Promise<TrrcProductionResult | null> {
  try {
    // Init two independent sessions so oil and gas queries don't share server-side
    // session state — TRRC's Struts app can corrupt results when two queries run
    // against the same JSESSIONID concurrently.
    const [oilSession, gasSession, lease] = await Promise.all([
      initTrrcSession(),
      initTrrcSession(),
      getLeaseFromApiNumber(apiNumber),
    ]);

    if (!lease) return null;
    if (!oilSession && !gasSession) return null;

    const now        = new Date();
    const endYear    = now.getFullYear();
    const endMonth   = now.getMonth() + 1;
    const startDate  = new Date(now);
    startDate.setMonth(startDate.getMonth() - monthsBack);
    const startYear  = startDate.getFullYear();
    const startMonth = startDate.getMonth() + 1;

    // Fetch oil and gas reports in parallel with independent sessions
    const [oilRows, gasRows] = await Promise.all([
      oilSession
        ? fetchAllLeaseProduction(
            lease.distCode, lease.leaseNo, oilSession,
            startMonth, startYear, endMonth, endYear,
            "O", MAX_PRODUCTION_PAGES,
          )
        : Promise.resolve([] as TrrcMonthlyRow[]),
      gasSession
        ? fetchAllLeaseProduction(
            lease.distCode, lease.leaseNo, gasSession,
            startMonth, startYear, endMonth, endYear,
            "G", MAX_PRODUCTION_PAGES,
          )
        : Promise.resolve([] as TrrcMonthlyRow[]),
    ]);

    const rows = mergeOilGasRows(oilRows, gasRows);
    if (rows.length === 0) return null;

    return {
      api_number:    apiNumber,
      district_code: lease.distCode,
      lease_number:  lease.leaseNo,
      rows,
      months_count:  rows.length,
      source:        "trrc_actual",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent month of production for a known lease (distCode + leaseNo).
 * Skips the wellbore-query step — use this when you already have the lease identifiers
 * (e.g. from a PDQ county wellbore search result).
 *
 * Returns null if the lease has no production data or the request fails.
 *
 * Uses a 6-month window (≤6 rows → fits on one page, no pagination needed).
 * Falls back to gas production (converted to BOE) for gas-only leases.
 */
export async function fetchTrrcLatestByLease(
  distCode: string,
  leaseNo:  string,
): Promise<{ oil_bbl: number; month: string } | null> {
  try {
    const sessionCookie = await initTrrcSession();
    if (!sessionCookie) return null;

    const now        = new Date();
    const endYear    = now.getFullYear();
    const endMonth   = now.getMonth() + 1;
    const startDate  = new Date(now);
    // 12-month window: TRRC data can lag 3–5 months; 6 months was too narrow
    startDate.setMonth(startDate.getMonth() - 12);
    const startYear  = startDate.getFullYear();
    const startMonth = startDate.getMonth() + 1;

    // Try oil first; fall back to gas
    let rows = await fetchAllLeaseProduction(
      distCode, leaseNo, sessionCookie,
      startMonth, startYear, endMonth, endYear,
      "O", 2,
    );

    if (rows.length === 0) {
      rows = await fetchAllLeaseProduction(
        distCode, leaseNo, sessionCookie,
        startMonth, startYear, endMonth, endYear,
        "G", 2,
      );
    }

    if (rows.length === 0) return null;

    const latest = rows[rows.length - 1]; // sorted ascending → last = most recent
    const month  = `${latest.year}-${String(latest.month).padStart(2, "0")}`;
    return { oil_bbl: latest.oil_bbl, month };
  } catch {
    return null;
  }
}

/**
 * Fetch recent monthly production for a lease identified by its TRRC identifiers
 * (distCode + leaseNo).  Returns up to `monthsBack` months of rows, or null on error.
 *
 * Use this when distCode + leaseNo are already known (e.g. resolved via
 * `lookupTrrcLeasesByApis`).  It skips the wellbore-query step entirely, which
 * is the step that incorrectly returns county-level results when queried by API number.
 */
export async function fetchTrrcProductionByLease(
  distCode:  string,
  leaseNo:   string,
  monthsBack = FULL_HISTORY_MONTHS,
): Promise<{ rows: TrrcMonthlyRow[]; distCode: string; leaseNo: string } | null> {
  const now        = new Date();
  const endYear    = now.getFullYear();
  const endMonth   = now.getMonth() + 1;
  const startDate  = new Date(now);
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const startYear  = startDate.getFullYear();
  const startMonth = startDate.getMonth() + 1;

  /** Single attempt — two independent sessions, both reports fetched in parallel */
  async function attempt(): Promise<TrrcMonthlyRow[]> {
    // Two sessions: one for oil report, one for gas report.
    // Using the same JSESSIONID for parallel requests can corrupt server-side state
    // in TRRC's Struts app, returning wrong or empty rows.
    const [oilSession, gasSession] = await Promise.all([
      initTrrcSession(),
      initTrrcSession(),
    ]);
    if (!oilSession && !gasSession) return [];

    const [oilRows, gasRows] = await Promise.all([
      oilSession
        ? fetchAllLeaseProduction(
            distCode, leaseNo, oilSession,
            startMonth, startYear, endMonth, endYear,
            "O", MAX_PRODUCTION_PAGES,
          )
        : Promise.resolve([] as TrrcMonthlyRow[]),
      gasSession
        ? fetchAllLeaseProduction(
            distCode, leaseNo, gasSession,
            startMonth, startYear, endMonth, endYear,
            "G", MAX_PRODUCTION_PAGES,
          )
        : Promise.resolve([] as TrrcMonthlyRow[]),
    ]);

    return mergeOilGasRows(oilRows, gasRows);
  }

  // First attempt
  try {
    const rows = await attempt();
    if (rows.length > 0) return { rows, distCode, leaseNo };
  } catch { /* TRRC session error — retry below */ }

  // Retry once — TRRC sessions occasionally expire mid-flight or return a redirect.
  try {
    const rows = await attempt();
    if (rows.length === 0) return null;
    return { rows, distCode, leaseNo };
  } catch {
    return null;
  }
}

/**
 * Try each API number in order, return the first one that yields production data.
 * Useful when we have a list of nearby wells and want the best available data.
 */
export async function fetchBestTrrcProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<TrrcProductionResult | null> {
  for (const api of apiNumbers) {
    if (!normalizeApiNumber(api)) continue;
    const result = await fetchTrrcProductionHistory(api, monthsBack);
    if (result) return result;
  }
  return null;
}

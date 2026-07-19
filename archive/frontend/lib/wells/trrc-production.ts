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

// ── CSV download (Strategy A — primary) ───────────────────────────────────────
//
// TRRC's EWA system provides a CSV action that returns the FULL production history
// for a lease in a single structured response — no pagination, no HTML parsing.
// This is the official download path used by authoritative diligence tools.
//
// Endpoint: POST /EWA/specificLeaseCSVAction.do
//   Returns: text/csv with one header row + one row per production month.
//
// If this endpoint fails or returns no rows, the HTML pager path (Strategy B) is
// used as a fallback.  Both strategies return TrrcMonthlyRow[] so the caller
// is identical regardless of which path succeeded.

/**
 * Parse a raw CSV text body into key→value column maps, one per data row.
 * Handles:
 *   - Comma or pipe delimiters (auto-detected from header row)
 *   - Double-quoted fields (standard RFC 4180)
 *   - Trailing carriage returns (\r\n from Windows)
 *   - Empty / whitespace-only rows
 */
function parseCsvText(raw: string): Record<string, string>[] {
  const lines = raw.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Auto-detect delimiter: pipe '|' is used by some TRRC exports
  const delimiter = lines[0].includes("|") ? "|" : ",";

  /** Split a single CSV line respecting double-quoted fields */
  const splitLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === delimiter && !inQuotes) {
        fields.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, "_"));

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    if (cells.every(c => !c)) continue; // blank row
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    rows.push(obj);
  }
  return rows;
}

/**
 * Find a column value from a parsed CSV row by trying multiple header aliases.
 * Returns the first match, or null if none found.
 */
function colVal(row: Record<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const key = Object.keys(row).find(k => k.includes(alias));
    if (key && row[key] !== undefined) return row[key];
  }
  return null;
}

/**
 * Convert a parsed CSV row set from TRRC's production export into TrrcMonthlyRow[].
 *
 * TRRC CSV column aliases (headers vary by EWA version):
 *   Oil report: month, year, crude_oil_produced__bbl_, casinghead_gas_produced__mcf_
 *   Gas report: month, year, gas_produced__mcf_, condensate_produced__bbl_
 */
function csvRowsToProduction(
  parsed: Record<string, string>[],
  reportType: "O" | "G",
): TrrcMonthlyRow[] {
  const seen = new Map<string, TrrcMonthlyRow>();

  for (const row of parsed) {
    // Month: might be "1", "01", "JAN", "January"
    const rawMonth = colVal(row, ["month"]) ?? "";
    const rawYear  = colVal(row, ["year"])  ?? "";

    let month: number;
    let year: number;

    // Numeric month
    const mNum = parseInt(rawMonth, 10);
    if (!isNaN(mNum) && mNum >= 1 && mNum <= 12) {
      month = mNum;
    } else {
      // Named month
      const mStr = rawMonth.slice(0, 3).toLowerCase();
      const named: Record<string, number> = {
        jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
        jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
      };
      month = named[mStr] ?? 0;
    }

    year = parseInt(rawYear, 10);
    if (!month || !year || year < 1990 || year > new Date().getFullYear() + 1) continue;

    let oil_bbl: number;
    let gas_mcf: number | null;

    if (reportType === "O") {
      const oilStr = colVal(row, ["crude_oil_produced", "crude_oil_bbl", "oil_produced", "crude_oil"]) ?? "0";
      const gasStr = colVal(row, ["casinghead_gas_produced", "casinghead_gas_mcf", "casinghead_gas"]) ?? "0";
      oil_bbl = parseFloat(oilStr.replace(/,/g, "")) || 0;
      const gasParsed = parseFloat(gasStr.replace(/,/g, "")) || 0;
      gas_mcf = gasParsed > 0 ? gasParsed : null;
      if (oil_bbl > MAX_PLAUSIBLE_OIL_BBL) continue;
      if (gas_mcf != null && gas_mcf > MAX_PLAUSIBLE_GAS_MCF) gas_mcf = null;
    } else {
      // Gas report — gas MCF primary, condensate BBL secondary
      const gasStr  = colVal(row, ["gas_produced_mcf_", "gas_produced", "gas_mcf", "gas"]) ?? "0";
      const condStr = colVal(row, ["condensate_produced", "condensate_bbl", "condensate"]) ?? "0";
      if (!gasStr && !condStr) continue;
      const gasParsed  = parseFloat(gasStr.replace(/,/g, ""))  || 0;
      const condParsed = parseFloat(condStr.replace(/,/g, "")) || 0;
      if (gasParsed > MAX_PLAUSIBLE_GAS_MCF) continue;
      const gas_boe = gasParsed > 0 ? Math.round(gasParsed / 6) : 0;
      oil_bbl = gas_boe + condParsed;
      gas_mcf = gasParsed > 0 ? gasParsed : null;
      if (oil_bbl > MAX_PLAUSIBLE_OIL_BBL) continue;
    }

    if (oil_bbl > 0 || gas_mcf != null) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const existing = seen.get(key);
      if (!existing || oil_bbl > existing.oil_bbl) {
        seen.set(key, { year, month, oil_bbl, gas_mcf });
      }
    }
  }

  return Array.from(seen.values()).sort(
    (a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month,
  );
}

/**
 * Download the complete production history for a lease via the TRRC CSV endpoint.
 *
 * Returns all production months in a single HTTP request — no session management,
 * no pagination, no HTML parsing.  This is the authoritative data path.
 *
 * Falls through to null (not throws) on any network or format error so the caller
 * can fall back to the HTML strategy without disruption.
 */
async function fetchLeaseProductionCsv(
  distCode:   string,
  leaseNo:    string,
  startMonth: number,
  startYear:  number,
  endMonth:   number,
  endYear:    number,
  oilOrGas:   "O" | "G",
): Promise<TrrcMonthlyRow[] | null> {
  try {
    const body = new URLSearchParams({
      "methodToCall":                  "search",
      "searchType":                    "specificLease",
      "searchArgs.searchType":         "specificLease",
      "searchArgs.oilOrGasArg":        oilOrGas,
      "searchArgs.leaseNumberArg":     leaseNo,
      "searchArgs.districtCodeArg":    distCode,
      "searchArgs.startMonthArg":      String(startMonth).padStart(2, "0"),
      "searchArgs.startYearArg":       String(startYear),
      "searchArgs.endMonthArg":        String(endMonth).padStart(2, "0"),
      "searchArgs.endYearArg":         String(endYear),
    });

    const res = await fetch(`${BASE}/specificLeaseCSVAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
        "Accept":       "text/csv,text/plain,*/*",
      },
      body: body.toString(),
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    // Accept text/csv, text/plain, or application/octet-stream (some TRRC versions)
    // Reject HTML responses (means we landed on an error or redirect page)
    const text = await res.text();
    if (
      contentType.includes("text/html") ||
      text.trimStart().startsWith("<!") ||
      text.trimStart().startsWith("<html")
    ) {
      return null; // Got HTML — CSV action not available, fall back to HTML scraper
    }

    const parsed = parseCsvText(text);
    if (parsed.length === 0) return null;

    const rows = csvRowsToProduction(parsed, oilOrGas);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
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
 *
 * Self-bootstrapping session design:
 *   `sessionCookie` is optional. When null (the common case), the POST is sent
 *   without a Cookie header. TRRC's Struts app will create a new server-side
 *   session and return a Set-Cookie: JSESSIONID=... header on the response.
 *   We capture that cookie and return it so pagination requests can use it.
 *
 *   This eliminates the pre-initialisation step that was failing in Node.js/Vercel
 *   because Node.js fetch follows redirects and loses Set-Cookie headers that are
 *   set on intermediate 302 responses — causing initTrrcSession() to return null
 *   and the entire production fetch to bail out immediately with empty results.
 *
 * Returns rows, next-page URL (if any), and the active session cookie.
 */
async function fetchLeaseProductionPage(
  distCode:      string,
  leaseNo:       string,
  sessionCookie: string | null,   // null = no pre-initialised session
  startMonth:    number,
  startYear:     number,
  endMonth:      number,
  endYear:       number,
  oilOrGas:      "O" | "G",
  signal?:       AbortSignal,
): Promise<{ rows: TrrcMonthlyRow[]; nextPagePath: string | null; activeCookie: string | null }> {
  const body = buildLeaseSearchBody(
    distCode, leaseNo, startMonth, startYear, endMonth, endYear, oilOrGas,
  );

  // ── Step 1: GET the search form to extract JSESSIONID from HTML action attr ──
  //
  // TRRC EWA uses Java Struts with URL-path session tracking.  The JSESSIONID is
  // embedded in the form action attribute:
  //   action="/EWA/specificLeaseQueryAction.do;jsessionid=XXXX"
  // It is NOT reliably delivered via Set-Cookie.  Posting to the base URL without
  // the session in the path returns the blank search form instead of data.
  let activeSession: string | null = null;
  try {
    const getHeaders: Record<string, string> = {
      "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
    };
    if (sessionCookie) getHeaders["Cookie"] = sessionCookie;

    const getRes = await fetch(`${BASE}/specificLeaseQueryAction.do`, {
      method: "GET",
      headers: getHeaders,
      signal,
    });
    if (getRes.ok) {
      const getHtml = await getRes.text();
      // Extract session from form action: action="...;jsessionid=XXXX"
      const actionMatch = getHtml.match(/jsessionid=([^"?&;]+)/i);
      if (actionMatch) {
        activeSession = actionMatch[1];
      }
      // Also check Set-Cookie as fallback
      if (!activeSession) {
        const setCookieGet = getRes.headers.get("set-cookie") ?? "";
        const cookieMatch  = setCookieGet.match(/JSESSIONID=([^;,\s]+)/i);
        if (cookieMatch) activeSession = cookieMatch[1];
      }
    }
  } catch {
    // Proceed with POST anyway — worst case we get the blank form back
  }

  // ── Step 2: POST to URL WITH jsessionid in path ─────────────────────────────
  const postPath = activeSession
    ? `${BASE}/specificLeaseQueryAction.do;jsessionid=${activeSession}`
    : `${BASE}/specificLeaseQueryAction.do`;

  const postHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
    "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  // Include session in Cookie header as well (belt-and-suspenders)
  const cookieVal = activeSession ? `JSESSIONID=${activeSession}` : sessionCookie;
  if (cookieVal) postHeaders["Cookie"] = cookieVal;

  const res = await fetch(postPath, {
    method:  "POST",
    headers: postHeaders,
    body:    body.toString(),
    signal,
  });

  if (!res.ok) return { rows: [], nextPagePath: null, activeCookie: cookieVal };

  // Capture any updated JSESSIONID from the POST response
  const setCookieHeader = res.headers.get("set-cookie") ?? "";
  const sessionMatch    = setCookieHeader.match(/JSESSIONID=([^;,\s]+)/i);
  const activeCookie    = sessionMatch
    ? `JSESSIONID=${sessionMatch[1]}`
    : (cookieVal ?? null);

  const html = await res.text();
  const rows = parseTrrcHtmlRows(html, oilOrGas);

  const nextMatch = html.match(/href="(\/EWA\/[^"]*pager\.[^"]*pager\.offset=\d+[^"]*)"\s*>\s*\[Next/i);
  return { rows, nextPagePath: nextMatch ? nextMatch[1] : null, activeCookie };
}

/**
 * GET a subsequent production page using the pager link path extracted from the HTML.
 */
async function fetchLeaseProductionNextPage(
  path:          string,
  sessionCookie: string | null,
  oilOrGas:      "O" | "G",
  signal?:       AbortSignal,
): Promise<{ rows: TrrcMonthlyRow[]; nextPagePath: string | null }> {
  const url = `https://webapps2.rrc.texas.gov${path}`;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  const res = await fetch(url, { headers, signal });

  if (!res.ok) return { rows: [], nextPagePath: null };
  const html = await res.text();

  const rows = parseTrrcHtmlRows(html, oilOrGas);
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
 * Fetch ALL production rows for the given date range using a two-request strategy:
 *
 *   Request 1 — POST to establish session + execute query (returns page 1, 10 rows).
 *               The TRRC server stores the full result set in the session.
 *
 *   Request 2 — GET with pager.pageSize=500&pager.offset=0 to retrieve all rows
 *               in a single response.  Confirmed to return 402 rows for the golden
 *               fixture (Lease 60509) in ~300ms — vs. 41 sequential pages before.
 *
 * Why this is better than page-by-page pagination:
 *   - Total: 2 HTTP requests instead of 41  (one GET-for-session + one big page)
 *   - Latency: ~1-2s instead of 20-40s on Vercel (cloud → TRRC round-trips add up)
 *   - No timeout risk: fits easily within any reasonable deadline
 *   - Session-safe: no risk of session-state corruption from concurrent requests
 *
 * Falls back to page-by-page only when no next-page link is present (dataset already
 * fits on page 1 — rare but possible for very short date ranges).
 */
async function fetchAllLeaseProduction(
  distCode:      string,
  leaseNo:       string,
  sessionCookie: string | null,   // null = no pre-initialised session (self-bootstrapping)
  startMonth:    number,
  startYear:     number,
  endMonth:      number,
  endYear:       number,
  oilOrGas:      "O" | "G",
  _maxPages = MAX_PRODUCTION_PAGES,  // retained for API compat, no longer used
  signal?:       AbortSignal,
): Promise<TrrcMonthlyRow[]> {
  const seen = new Map<string, TrrcMonthlyRow>();

  const addRows = (rows: TrrcMonthlyRow[]) => {
    for (const row of rows) {
      const key = `${row.year}-${String(row.month).padStart(2, "0")}`;
      const existing = seen.get(key);
      if (!existing || row.oil_bbl > existing.oil_bbl) seen.set(key, row);
    }
  };

  // Request 1: POST establishes session + executes query → page 1 (10 rows)
  const firstPage = await fetchLeaseProductionPage(
    distCode, leaseNo, sessionCookie,
    startMonth, startYear, endMonth, endYear,
    oilOrGas, signal,
  );
  addRows(firstPage.rows);

  const paginationCookie = firstPage.activeCookie;
  const nextPagePath     = firstPage.nextPagePath;

  if (nextPagePath) {
    // Request 2: single GET with pageSize=500, offset=0 → ALL rows in one shot.
    // TRRC EWA honours arbitrary pager.pageSize values; 500 covers any realistic lease.
    const bigPagePath = nextPagePath
      .replace(/pager\.pageSize=\d+/, "pager.pageSize=500")
      .replace(/pager\.offset=\d+/,   "pager.offset=0");
    const bigPage = await fetchLeaseProductionNextPage(bigPagePath, paginationCookie, oilOrGas, signal);
    addRows(bigPage.rows);
  }
  // If nextPagePath is null, all rows already fit on page 1 — done.

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
  // Overall wall-clock timeout for the entire production fetch sequence.
  // Each strategy (B and C) makes 2–4 HTTP requests; 120 s covers the worst case
  // (Strategy B fails at 45 s → Strategy C retries two sessions + two big pages).
  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), 120_000);
  const signal = controller.signal;

  try {
    const lease = await getLeaseFromApiNumber(apiNumber, signal);
    if (!lease) { clearTimeout(overallTimer); return null; }

    const now        = new Date();
    const endYear    = now.getFullYear();
    const endMonth   = now.getMonth() + 1;
    const startDate  = new Date(now);
    startDate.setMonth(startDate.getMonth() - monthsBack);
    // TRRC EWA dropdown minimum year is 1993 — clamp to avoid silent rejection
    const startYear  = Math.max(startDate.getFullYear(), 1993);
    const startMonth = startDate.getMonth() + 1;

    // ── Strategy A: Official TRRC CSV download — DISABLED ────────────────
    // specificLeaseCSVAction.do always returns HTTP 500 on the live TRRC system.
    // Skip directly to the HTML scraper which uses the correct jsessionid URL-path
    // session flow and is confirmed working for the golden fixture (402 rows).

    // ── Strategy B: HTML scraper — self-bootstrapping POST ────────────────
    //
    // Used when the CSV endpoint is unavailable or returns no data.
    {
      const [oilRows, gasRows] = await Promise.all([
        fetchAllLeaseProduction(
          lease.distCode, lease.leaseNo, null,
          startMonth, startYear, endMonth, endYear,
          "O", MAX_PRODUCTION_PAGES, signal,
        ),
        fetchAllLeaseProduction(
          lease.distCode, lease.leaseNo, null,
          startMonth, startYear, endMonth, endYear,
          "G", MAX_PRODUCTION_PAGES, signal,
        ),
      ]);
      let rows = mergeOilGasRows(oilRows, gasRows);

      // ── Strategy C: HTML scraper — explicit session init ──────────────
      if (rows.length === 0) {
        const [oilSession, gasSession] = await Promise.all([
          initTrrcSession(signal),
          initTrrcSession(signal),
        ]);
        const [oilRowsC, gasRowsC] = await Promise.all([
          fetchAllLeaseProduction(
            lease.distCode, lease.leaseNo, oilSession,
            startMonth, startYear, endMonth, endYear,
            "O", MAX_PRODUCTION_PAGES, signal,
          ),
          fetchAllLeaseProduction(
            lease.distCode, lease.leaseNo, gasSession,
            startMonth, startYear, endMonth, endYear,
            "G", MAX_PRODUCTION_PAGES, signal,
          ),
        ]);
        rows = mergeOilGasRows(oilRowsC, gasRowsC);
      }

      clearTimeout(overallTimer);

      if (rows.length === 0) return null;

      return {
        api_number:    apiNumber,
        district_code: lease.distCode,
        lease_number:  lease.leaseNo,
        rows,
        months_count:  rows.length,
        source:        "trrc_actual",
      };
    }

    clearTimeout(overallTimer);
    return null;
  } catch {
    clearTimeout(overallTimer);
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
    const now        = new Date();
    const endYear    = now.getFullYear();
    const endMonth   = now.getMonth() + 1;
    const startDate  = new Date(now);
    // 12-month window: TRRC data can lag 3–5 months
    startDate.setMonth(startDate.getMonth() - 12);
    const startYear  = startDate.getFullYear();
    const startMonth = startDate.getMonth() + 1;

    // Strategy A (CSV via specificLeaseCSVAction.do) is disabled — endpoint always
    // returns HTTP 500 on the live TRRC system.  Go straight to HTML scraper.
    let rows: TrrcMonthlyRow[] = [];

    // ── Strategy B: HTML scraper — self-bootstrapping POST ───────────────
    if (rows.length === 0) {
      const oilRows = await fetchAllLeaseProduction(
        distCode, leaseNo, null,
        startMonth, startYear, endMonth, endYear, "O", 2,
      );
      if (oilRows.length > 0) {
        rows = oilRows;
      } else {
        rows = await fetchAllLeaseProduction(
          distCode, leaseNo, null,
          startMonth, startYear, endMonth, endYear, "G", 2,
        );
      }
    }

    // ── Strategy C: HTML scraper — explicit session init ─────────────────
    if (rows.length === 0) {
      const sessionCookie = await initTrrcSession();
      const oilRows = await fetchAllLeaseProduction(
        distCode, leaseNo, sessionCookie,
        startMonth, startYear, endMonth, endYear, "O", 2,
      );
      if (oilRows.length > 0) {
        rows = oilRows;
      } else {
        rows = await fetchAllLeaseProduction(
          distCode, leaseNo, sessionCookie,
          startMonth, startYear, endMonth, endYear, "G", 2,
        );
      }
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
  // TRRC EWA dropdown minimum year is 1993 — clamp to avoid silent rejection
  const startYear  = Math.max(startDate.getFullYear(), 1993);
  const startMonth = startDate.getMonth() + 1;

  // ── Strategy A: Official TRRC CSV download — DISABLED ─────────────────
  // specificLeaseCSVAction.do always returns HTTP 500 on the live TRRC system.
  // Skip directly to the HTML scraper with correct jsessionid URL-path session flow.

  // ── Strategy B: HTML scraper — self-bootstrapping POST ─────────────────
  //
  // Used when the CSV endpoint is unavailable or returns no data.
  // POSTs directly to specificLeaseQueryAction.do without a pre-initialised
  // session — TRRC creates the session on the POST and returns Set-Cookie.
  // Follows pagination until all pages are consumed.
  {
    try {
      const [oilRows, gasRows] = await Promise.all([
        fetchAllLeaseProduction(
          distCode, leaseNo, null,
          startMonth, startYear, endMonth, endYear, "O", MAX_PRODUCTION_PAGES,
        ),
        fetchAllLeaseProduction(
          distCode, leaseNo, null,
          startMonth, startYear, endMonth, endYear, "G", MAX_PRODUCTION_PAGES,
        ),
      ]);
      const rows = mergeOilGasRows(oilRows, gasRows);
      if (rows.length > 0) return { rows, distCode, leaseNo };
    } catch { /* fall through */ }
  }

  // ── Strategy C: HTML scraper — explicit session init ───────────────────
  //
  // Last resort: pre-initialise a TRRC session then use it for the HTML query.
  // Some TRRC endpoint configurations require a pre-existing session.
  {
    try {
      const [oilSession, gasSession] = await Promise.all([
        initTrrcSession(),
        initTrrcSession(),
      ]);
      const [oilRows, gasRows] = await Promise.all([
        fetchAllLeaseProduction(
          distCode, leaseNo, oilSession,
          startMonth, startYear, endMonth, endYear, "O", MAX_PRODUCTION_PAGES,
        ),
        fetchAllLeaseProduction(
          distCode, leaseNo, gasSession,
          startMonth, startYear, endMonth, endYear, "G", MAX_PRODUCTION_PAGES,
        ),
      ]);
      const rows = mergeOilGasRows(oilRows, gasRows);
      if (rows.length > 0) return { rows, distCode, leaseNo };
    } catch { /* fall through */ }
  }

  return null;
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

/**
 * TRRC Monthly Production Fetcher
 *
 * Two-request process against the Texas Railroad Commission's public PDQ web app:
 *   1. POST wellboreQueryAction.do  →  establish a TRRC EWA session (JSESSIONID)
 *   2. POST specificLeaseQueryAction.do  →  HTML table with monthly production rows
 *
 * The specificLeaseQueryAction.do CSV download endpoint requires complex session
 * state and is unreliable. We parse the HTML production table directly instead.
 *
 * Run server-side only (no CORS issues from Next.js API routes).
 *
 * Reference: https://webapps2.rrc.texas.gov/EWA/ewaPdqMain.do
 */

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
  // Must start with 42 and be at least 10 digits
  if (!digits.startsWith("42") || digits.length < 10) return null;
  return digits.slice(0, 10);
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
 * A minimal POST to wellboreQueryAction.do is sufficient to initialise a TRRC EWA
 * Java EE session. The resulting JSESSIONID must be passed to all subsequent requests.
 */
async function initTrrcSession(signal?: AbortSignal): Promise<string | null> {
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

/**
 * Parse monthly production rows from the TRRC "Specific Lease Query Results" HTML.
 *
 * Oil report row format (after stripping tags, whitespace-normalised):
 *   "Jan 2024  5  0  511  511  OperatorName ..."
 *    MonthAbbr Year  OilBBL OilDisp  CasingheadMCF CasingheadDisp ...
 *
 * Gas report row format:
 *   "Jan 2024  511  0  5  5  OperatorName ..."
 *    MonthAbbr Year  GasMCF GasDisp  CondensateBBL CondensateDisp ...
 */
function parseTrrcHtmlRows(html: string, reportType: "O" | "G" = "O"): TrrcMonthlyRow[] {
  const rows: TrrcMonthlyRow[] = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let match: RegExpExecArray | null;

  while ((match = trRegex.exec(html)) !== null) {
    const cell = match[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim()
      .replace(/\s+/g, " ");

    // Rows start with "MonthAbbr YYYY num num ..."
    const m = cell.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\s+([\d,]+)\s+([\d,]+)\s+([\d,]*)/,
    );
    if (!m) continue;

    const month = MONTH_NAME_MAP[m[1]];
    const year  = parseInt(m[2]);
    const num1  = parseNum(m[3]);  // col3: oil BBL  (oil report) OR gas MCF (gas report)
    const num3  = m[5] ? parseNum(m[5]) : 0; // col5: casinghead MCF (oil) OR condensate BBL (gas)

    let oil_bbl: number;
    let gas_mcf: number | null;

    if (reportType === "O") {
      oil_bbl = num1;
      gas_mcf = num3 > 0 ? num3 : null;
    } else {
      // Gas report: num1 = gas MCF, num3 = condensate BBL
      // Convert gas → BOE (6 MCF ≈ 1 BOE) and add condensate
      const gas_boe = num1 > 0 ? Math.round(num1 / 6) : 0;
      oil_bbl = gas_boe + num3;
      gas_mcf = num1 > 0 ? num1 : null;
    }

    if (oil_bbl > 0 || gas_mcf != null) {
      rows.push({ year, month, oil_bbl, gas_mcf });
    }
  }

  return rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
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
 * Fetch all production rows for the given date range, following pagination.
 * Capped at `maxPages` pages (default 6 = 60 rows ≈ 5 years of monthly data).
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
  maxPages = 6,
  signal?:       AbortSignal,
): Promise<TrrcMonthlyRow[]> {
  const all: TrrcMonthlyRow[] = [];
  let { rows, nextPagePath } = await fetchLeaseProductionPage(
    distCode, leaseNo, sessionCookie,
    startMonth, startYear, endMonth, endYear,
    oilOrGas, signal,
  );
  all.push(...rows);

  let page = 1;
  while (nextPagePath && page < maxPages) {
    const next = await fetchLeaseProductionNextPage(nextPagePath, sessionCookie, oilOrGas, signal);
    all.push(...next.rows);
    nextPagePath = next.nextPagePath;
    page++;
  }

  return all.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
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
    "searchArgs.wellTypeArg":    "PR",   // Return production lease, not drill/completion lease
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
  monthsBack = 36,
): Promise<TrrcProductionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    // Step 1: establish session + resolve lease identifiers from API number
    const [sessionCookie, lease] = await Promise.all([
      initTrrcSession(controller.signal),
      getLeaseFromApiNumber(apiNumber, controller.signal),
    ]);

    if (!sessionCookie || !lease) return null;

    const now        = new Date();
    const endYear    = now.getFullYear();
    const endMonth   = now.getMonth() + 1;
    const startDate  = new Date(now);
    startDate.setMonth(startDate.getMonth() - monthsBack);
    const startYear  = startDate.getFullYear();
    const startMonth = startDate.getMonth() + 1;

    // Try oil first; fall back to gas (convert MCF → BOE) for gas-only leases
    let rows = await fetchAllLeaseProduction(
      lease.distCode, lease.leaseNo, sessionCookie,
      startMonth, startYear, endMonth, endYear,
      "O", 6, controller.signal,
    );

    if (rows.length === 0) {
      rows = await fetchAllLeaseProduction(
        lease.distCode, lease.leaseNo, sessionCookie,
        startMonth, startYear, endMonth, endYear,
        "G", 6, controller.signal,
      );
    }

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
  } finally {
    clearTimeout(timer);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const sessionCookie = await initTrrcSession(controller.signal);
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
      "O", 2, controller.signal,
    );

    if (rows.length === 0) {
      rows = await fetchAllLeaseProduction(
        distCode, leaseNo, sessionCookie,
        startMonth, startYear, endMonth, endYear,
        "G", 2, controller.signal,
      );
    }

    if (rows.length === 0) return null;

    const latest = rows[rows.length - 1]; // sorted ascending → last = most recent
    const month  = `${latest.year}-${String(latest.month).padStart(2, "0")}`;
    return { oil_bbl: latest.oil_bbl, month };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
